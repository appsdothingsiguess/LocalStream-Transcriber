// relay.js
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWriteStream, unlink, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, readFileSync } from 'fs';
import { get } from 'https';
import { execSync, spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import {
  sidecarPathFor,
  recoverTranscriptionAfterCrash,
  hydrateTranscriptionResult,
  parseResultJsonFromStdout,
  appendTranscriptionLog,
} from './transcription_recovery.js';

const DEBUG = process.env.LOCALSTREAM_DEBUG === '1';
function dbg(msg) { if (DEBUG) console.log(`[DBG] ${msg}`); }

// ============================================================================
// JOB QUEUE AND DEDUPLICATION SYSTEM
// ============================================================================

function normalizeStreamPath(pathname) {
  return pathname
    .replace(/_(low|medium|high|[0-9]+p|[0-9]+k)/gi, '')
    .replace(/\/(low|medium|high|[0-9]+p|[0-9]+k)\//gi, '/');
}

class JobQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.currentJob = null;
    this.completedIds = new Set(); // Track completed entry IDs to prevent re-downloading
  }

  /**
   * Extract unique identifier from URL
   * For Kaltura URLs: /entryId/[ID]/
   * For other URLs: use full URL as identifier
   */
  extractEntryId(url) {
    if (!url) return null;
    
    // Match Kaltura entryId pattern: /entryId/[ID]/
    const kalturaMatch = url.match(/\/entryId\/([^\/]+)\//);
    if (kalturaMatch) {
      return kalturaMatch[1];
    }
    
    try {
      const urlObj = new URL(url);
      const pathname = normalizeStreamPath(urlObj.pathname);
      const stableParams = new URLSearchParams();

      for (const key of ['entryId', 'id', 'videoId', 'assetId']) {
        const values = urlObj.searchParams.getAll(key);
        values.sort();
        for (const value of values) {
          stableParams.append(key, value);
        }
      }

      const stableQuery = stableParams.toString();
      return `${urlObj.host}${pathname}${stableQuery ? `?${stableQuery}` : ''}`;
    } catch {
      return url;
    }
  }

  /**
   * Check if a job with this entryId is already queued or processing
   */
  getDuplicateReason(entryId) {
    if (!entryId) return false;
    
    // Check if currently processing
    if (this.currentJob && this.currentJob.entryId === entryId) {
      return 'already downloading';
    }
    
    // Check if in queue
    const inQueue = this.queue.some(job => job.entryId === entryId);
    if (inQueue) {
      return 'already queued';
    }
    
    // Check if already completed in this session
    if (this.completedIds.has(entryId)) {
      return 'already done this session';
    }
    
    return null;
  }

  isDuplicate(entryId) {
    return !!this.getDuplicateReason(entryId);
  }

  /**
   * Add a job to the queue
   * Returns true if added, false if duplicate
   */
  enqueue(job) {
    const entryId = job.entryId || this.extractEntryId(job.url);
    job.entryId = entryId;
    
    const duplicateReason = this.getDuplicateReason(entryId);
    if (duplicateReason) {
      const id = entryId || 'unknown';
      console.log(`⏭️  Duplicate ignored (${id} — ${duplicateReason})`);
      return { added: false, entryId, reason: duplicateReason };
    }
    
    console.log(`📡  Stream detected  (${entryId || 'unknown'})`);
    this.queue.push(job);
    dbg(`Added job ${job.jobId} (entryId: ${entryId || 'N/A'}) — queue size: ${this.queue.length}`);
    
    // Start processing if not already processing
    if (!this.processing) {
      this.processNext();
    }
    
    return { added: true, entryId, reason: null };
  }

  /**
   * Process the next job in the queue
   */
  async processNext() {
    if (this.processing || this.queue.length === 0) {
      return;
    }
    
    this.processing = true;
    this.currentJob = this.queue.shift();
    
    dbg(`Processing job ${this.currentJob.jobId} — remaining: ${this.queue.length}`);
    
    try {
      await this.currentJob.handler();
      
      // Mark as completed
      if (this.currentJob.entryId) {
        this.completedIds.add(this.currentJob.entryId);
      }
      
      dbg(`Job ${this.currentJob.jobId} completed`);
    } catch (error) {
      console.error(`❌ [QUEUE] Job ${this.currentJob.jobId} failed:`, error.message);
    } finally {
      this.currentJob = null;
      this.processing = false;
      
      // Process next job if available
      if (this.queue.length > 0) {
        dbg(`${this.queue.length} job(s) remaining in queue`);
        setImmediate(() => this.processNext());
      } else {
        dbg('All jobs completed');
      }
    }
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      queueSize: this.queue.length,
      processing: this.processing,
      currentJob: this.currentJob ? this.currentJob.jobId : null,
      completedCount: this.completedIds.size
    };
  }
}

// Global job queue instance
const jobQueue = new JobQueue();

// --- Setup ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..'); // project root (parent of src/)
const app = express();
const wss = new WebSocketServer({ noServer: true });
const PORT = 8787;
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const TRANSCRIPTIONS_DIR = path.join(ROOT_DIR, 'transcriptions');
const DOWNLOADS_DIR = path.join(ROOT_DIR, 'downloads');
const PYTHON_SCRIPT = path.join(__dirname, 'transcribe.py');
const CONFIG_FILE = path.join(ROOT_DIR, 'config.json');

// Cache for Python executable path
let pythonExecutable = null;

/**
 * Load Python path from config.json (set by start.js)
 * Returns: absolute path from config, or null if not found/invalid
 */
function loadPythonPathFromConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const configData = readFileSync(CONFIG_FILE, 'utf8');
      const config = JSON.parse(configData);
      
      if (config.PYTHON_PATH && existsSync(config.PYTHON_PATH)) {
        // Validate the path works
        try {
          execSync(`"${config.PYTHON_PATH}" --version`, {
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 5000
          });
          
          dbg(`Using locked Python path from config: ${config.PYTHON_PATH}`);
          return config.PYTHON_PATH;
        } catch (error) {
          console.warn(`⚠️  Saved Python path invalid: ${config.PYTHON_PATH}`);
          dbg(`   Error: ${error.message}`);
        }
      }
    }
  } catch (error) {
    // Config file doesn't exist or invalid - that's okay, we'll detect
  }
  
  return null;
}

/**
 * Detect Python executable by trying common options and using 'where' on Windows
 * Returns: full path to Python executable or simple command, or null if none found
 */
function detectPythonExecutable() {
  if (pythonExecutable) {
    return pythonExecutable; // Return cached result
  }
  
  // HIGHEST PRIORITY: Path passed by start.js when launching relay (ensures same Python as setup)
  const envPath = process.env.MP3GRABBER_PYTHON_PATH;
  if (envPath && existsSync(envPath)) {
    try {
      execSync(`"${envPath}" --version`, { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
      pythonExecutable = envPath;
      dbg(`Using Python from start.js: ${envPath}`);
      return envPath;
    } catch (e) {
      console.warn(`⚠️  MP3GRABBER_PYTHON_PATH invalid: ${envPath}`);
    }
  }
  
  // SECOND: Try to load from config.json (set by start.js)
  const configPath = loadPythonPathFromConfig();
  if (configPath) {
    pythonExecutable = configPath;
    return configPath;
  }
  
  // FALLBACK: Try common Python executables in order of preference
  dbg('Python path not in config, detecting...');
  const candidates = ['python3', 'python', 'py'];
  
  for (const candidate of candidates) {
    try {
      // On Windows, use 'where' to find the full path to the executable
      if (process.platform === 'win32') {
        try {
          const wherePath = execSync(`where ${candidate}`, { 
            encoding: 'utf8', 
            stdio: 'pipe',
            timeout: 5000
          }).trim().split('\n')[0]; // Get first result
          
          // Verify it works
          execSync(`"${wherePath}" --version`, { 
            encoding: 'utf8', 
            stdio: 'pipe',
            timeout: 5000
          });
          
          pythonExecutable = wherePath;
          dbg(`Detected Python executable: ${wherePath}`);
          return wherePath;
        } catch (whereError) {
          // 'where' failed, try direct command
        }
      }
      
      // On Unix or if 'where' failed, try direct command
      execSync(`${candidate} --version`, { 
        encoding: 'utf8', 
        stdio: 'pipe',
        timeout: 5000
      });
      pythonExecutable = candidate;
      dbg(`Detected Python executable: ${candidate}`);
      return candidate;
    } catch (error) {
      // Try next candidate
      continue;
    }
  }
  
  // None found
  console.error('❌ Python executable not found. Tried: py, python3, python');
  console.error('   Please ensure Python is installed and in your PATH');
  console.error('   Or run start.js to lock the Python path');
  return null;
}

/**
 * Verify Python version and log it
 */
function verifyPythonVersion(pythonCmd) {
  try {
    const version = execSync(`${pythonCmd.includes(' ') ? '"' + pythonCmd + '"' : pythonCmd} --version`, {
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim();
    dbg(`Using Python: ${version}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get properly quoted Python command for use in shell commands
 */
function getQuotedPythonCmd() {
  const cmd = detectPythonExecutable();
  if (!cmd) return null;
  // Quote if path contains spaces (Windows full paths)
  return cmd.includes(' ') ? `"${cmd}"` : cmd;
}

// transcribe.py is maintained in-repo (v3+); do not embed an outdated template here.
if (!existsSync(PYTHON_SCRIPT)) {
  console.error('❌ src/transcribe.py is missing. Run start.js setup or restore the project.');
}

// --- Cookie Helper Functions for yt-dlp ---
function formatCookie(cookie) {
  // Netscape format: domain flag path secure expiration name value
  const domain = cookie.domain;
  const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
  const cookiePath = cookie.path || '/';
  const secure = cookie.secure ? 'TRUE' : 'FALSE';
  // Use expirationDate if available, otherwise default to 1 year from now
  const expiration = cookie.expirationDate || Math.floor(Date.now() / 1000) + 31536000;
  const name = cookie.name;
  const value = cookie.value;
  
  return [domain, flag, cookiePath, secure, expiration, name, value].join('\t');
}

function writeNetscapeCookieFile(cookies, filepath) {
  const header = '# Netscape HTTP Cookie File\n';
  const content = header + cookies.map(formatCookie).join('\n');
  writeFileSync(filepath, content);
  dbg(`Cookie file written: ${filepath} (${cookies.length} cookies)`);
}

// --- Transcription Function ---
function transcribe(file, forceCPU = false) {
    try {
        dbg(`Transcribing audio file...${forceCPU ? ' (CPU mode)' : ''}`);
        
        // Validate file size before attempting transcription
        const stats = statSync(file);
        if (stats.size < 1000) {
            throw new Error(`File too small to be valid audio/video (${stats.size} bytes). This may be a subtitle or caption file.`);
        }
        
        // Check for CUDA errors in stderr before parsing
        let result;
        try {
            // Set environment variables for Python subprocess
            const pythonEnv = { ...process.env, MP3GRABBER_ROOT: ROOT_DIR };
            if (forceCPU) {
                pythonEnv.FORCE_CPU = '1';
            }
            // Whisper model — use whatever the user selected in settings (passed from
            // start.js when launching the relay, or read directly from config here as
            // a fallback when relay is started standalone).
            if (!pythonEnv.WHISPER_MODEL) {
                try {
                    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
                    if (cfg.WHISPER_MODEL) pythonEnv.WHISPER_MODEL = cfg.WHISPER_MODEL;
                } catch (_) { /* config not readable — Python will auto-select */ }
            }
            // Windows: reduce ONNX/OpenMP crashes during model load (faster-whisper#1169, #967)
            if (process.platform === 'win32') {
                pythonEnv.ORT_DISABLE_CPU_AFFINITY = '1';
                pythonEnv.OMP_NUM_THREADS = pythonEnv.OMP_NUM_THREADS || '1';
            }
            
            const pythonCmd = getQuotedPythonCmd();
            if (!pythonCmd) {
                throw new Error('Python executable not found. Please install Python and ensure it is in your PATH.');
            }
            
            result = execSync(`${pythonCmd} "${PYTHON_SCRIPT}" "${file}"`, {
                encoding: "utf8",
                cwd: __dirname,
                stdio: 'pipe',
                env: pythonEnv,
                maxBuffer: 50 * 1024 * 1024
            });
        } catch (execError) {
            const stdout = (execError.stdout || '').toString();
            const stderr = (execError.stderr || '').toString();
            const status = execError.status != null ? execError.status : execError.code;
            const isAccessViolation = status === 3221225477;  // 0xC0000005
            const isShutdownCrash = status === 3221226505;    // 0xC0000409
            const hasResultSuccess = stdout.includes('RESULT:SUCCESS');
            const hasTranscriptionComplete = stdout.includes('STATUS:Transcription complete!');
            const sawSegmentProgress =
                hasTranscriptionComplete || /STATUS:Processed \d+ segments/.test(stdout);
            const isCudaError = stderr.includes('cudnn') || 
                               stderr.includes('cublas') || 
                               stderr.includes('cudnn_ops64_9.dll') ||
                               stderr.includes('cublas64_12.dll') ||
                               stderr.includes('Invalid handle') ||
                               (isShutdownCrash && !sawSegmentProgress);

            if (hasResultSuccess || isShutdownCrash || isAccessViolation || sawSegmentProgress) {
                const jsonResult = recoverTranscriptionAfterCrash(file, stdout, TRANSCRIPTIONS_DIR);
                if (jsonResult?.success && jsonResult.transcript) {
                    const resultPath = sidecarPathFor(file);
                    if (existsSync(resultPath)) unlink(resultPath, () => {});
                    appendTranscriptionLog(
                        TRANSCRIPTIONS_DIR,
                        `relay recovered status=${status} file=${path.basename(file)} output=${jsonResult.output_file || 'n/a'}`
                    );
                    const device = jsonResult.device || 'unknown';
                    const deviceIcon = (device + '').toUpperCase() === 'CUDA' ? '🎮' : '💻';
                    console.log(`✅ Transcription complete! (recovered) ${deviceIcon} Used: ${(device + '').toUpperCase()}`);
                    if (jsonResult.output_file) {
                        console.log(`📄 Transcript: ${jsonResult.output_file}`);
                    }
                    return jsonResult.transcript;
                }
                if ((isShutdownCrash || isAccessViolation) && sawSegmentProgress) {
                    console.error(`⚠️  Process crashed after transcription; no recoverable transcript on disk (${path.basename(file)})`);
                }
            }

            if (isAccessViolation && !forceCPU) {
                console.error(`⚠️  Transcription process crashed (access violation). Often caused by using a different Python than setup.`);
                console.log(`💡 Retrying with CPU mode...`);
                return transcribe(file, true);
            }
            if (isCudaError && !forceCPU) {
                console.error(`⚠️  CUDA error detected: ${(stderr || stdout).substring(0, 200)}`);
                console.log(`💡 Retrying with CPU mode...`);
                return transcribe(file, true);
            }
            if (isAccessViolation && forceCPU) {
                console.error(`❌ Transcription crashed during model load (Windows access violation).`);
                console.error(`   transcribe.py sets ORT_DISABLE_CPU_AFFINITY and OMP_NUM_THREADS to reduce this. If it still fails:`);
                console.error(`   1) Clear the model cache: %USERPROFILE%\\.cache\\huggingface\\hub (then re-run; model will re-download)`);
                console.error(`   2) Run transcribe.py directly to test: python transcribe.py "<path-to-audio>"`);
                console.error(`   3) Try: pip install faster-whisper==1.0.3 (older version sometimes avoids the crash)`);
            }
            console.error(`❌ [TRANSCRIBE] Python exited with status ${status}${stderr ? ' | stderr: ' + stderr.substring(0, 300) : ''}`);
            throw execError;
        }
        
        let jsonResult = hydrateTranscriptionResult(parseResultJsonFromStdout(result));
        if (!jsonResult) {
            const lines = result.trim().split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trim();
                if (line.startsWith('{') && line.endsWith('}')) {
                    try {
                        jsonResult = hydrateTranscriptionResult(JSON.parse(line));
                        if (jsonResult) break;
                    } catch {
                        continue;
                    }
                }
            }
        }
        if (!jsonResult) {
            jsonResult = recoverTranscriptionAfterCrash(file, result, TRANSCRIPTIONS_DIR);
        }
        
        if (!jsonResult) {
            throw new Error(`No valid transcription result found in output.`);
        }
        
        if (jsonResult.success) {
            const sidecarPath = sidecarPathFor(file);
            if (existsSync(sidecarPath)) unlink(sidecarPath, () => {});
            appendTranscriptionLog(
                TRANSCRIPTIONS_DIR,
                `relay success file=${path.basename(file)} output=${jsonResult.output_file || 'n/a'}`
            );
            const device = jsonResult.device || 'unknown';
            const deviceIcon = device.toUpperCase() === 'CUDA' ? '🎮' : '💻';
            console.log(`✅ Transcription complete! ${deviceIcon} Used: ${device.toUpperCase()}`);
            return jsonResult.transcript;
        } else {
            throw new Error(jsonResult.error || 'Transcription failed');
        }
    } catch (error) {
        console.error(`Relay: Transcription error:`, error);
        throw new Error(`Transcription failed: ${error.message}`);
    }
}

// --- Express Server ---
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'viewer.html')));

// Queue status endpoint
app.get('/queue/status', (_, res) => {
  const status = jobQueue.getStatus();
  res.json(status);
});

// Configure GPU library paths on startup (Windows)
if (process.platform === 'win32') {
  try {
    // Find actual library locations (they may be in different site-packages)
    let cublasPath = null;
    let cudnnPath = null;
    
    try {
      // On Windows, DLLs are in 'bin' directory
      // Python 3.13+: namespace packages have __file__=None, must use __path__[0]
      const pythonCmd = getQuotedPythonCmd() || 'python';
      const cublasLocation = execSync(`${pythonCmd} -c "import nvidia.cublas; print(nvidia.cublas.__path__[0])"`, { 
        encoding: 'utf8',
        stdio: 'pipe'
      }).trim();
      // Try 'bin' first (Windows standard), then 'lib' as fallback
      const binPath = path.join(cublasLocation, 'bin');
      const libPath = path.join(cublasLocation, 'lib');
      cublasPath = existsSync(binPath) ? binPath : (existsSync(libPath) ? libPath : null);
    } catch (e) {
      // Try user site-packages fallback
      try {
        const pythonCmd = getQuotedPythonCmd() || 'python';
        const userSite = execSync(`${pythonCmd} -c "import site; print(site.getusersitepackages())"`, { encoding: 'utf8', stdio: 'pipe' }).trim();
        const binPath = path.join(userSite, 'nvidia', 'cublas', 'bin');
        const libPath = path.join(userSite, 'nvidia', 'cublas', 'lib');
        cublasPath = existsSync(binPath) ? binPath : (existsSync(libPath) ? libPath : null);
      } catch (e2) {}
    }
    
    try {
      // On Windows, DLLs are in 'bin' directory
      // Python 3.13+: namespace packages have __file__=None, must use __path__[0]
      const pythonCmd = getQuotedPythonCmd() || 'python';
      const cudnnLocation = execSync(`${pythonCmd} -c "import nvidia.cudnn; print(nvidia.cudnn.__path__[0])"`, { 
        encoding: 'utf8',
        stdio: 'pipe'
      }).trim();
      // Try 'bin' first (Windows standard), then 'lib' as fallback
      const binPath = path.join(cudnnLocation, 'bin');
      const libPath = path.join(cudnnLocation, 'lib');
      cudnnPath = existsSync(binPath) ? binPath : (existsSync(libPath) ? libPath : null);
    } catch (e) {
      // Try system site-packages fallback
      try {
        const pythonCmd = getQuotedPythonCmd() || 'python';
        const sysSite = execSync(`${pythonCmd} -c "import site; print(site.getsitepackages()[0])"`, { encoding: 'utf8', stdio: 'pipe' }).trim();
        const binPath = path.join(sysSite, 'nvidia', 'cudnn', 'bin');
        const libPath = path.join(sysSite, 'nvidia', 'cudnn', 'lib');
        cudnnPath = existsSync(binPath) ? binPath : (existsSync(libPath) ? libPath : null);
      } catch (e2) {}
    }
    
    // Add to PATH if directories exist
    const pathsToAdd = [];
    if (cublasPath && existsSync(cublasPath)) {
      pathsToAdd.push(cublasPath);
    }
    if (cudnnPath && existsSync(cudnnPath)) {
      pathsToAdd.push(cudnnPath);
    }
    
    if (pathsToAdd.length > 0) {
      if (process.env.PATH) {
        process.env.PATH = `${pathsToAdd.join(';')};${process.env.PATH}`;
      } else {
        process.env.PATH = pathsToAdd.join(';');
      }
      dbg(`GPU library paths configured (${pathsToAdd.length} paths)`);
      if (cublasPath) dbg(`  cuBLAS: ${cublasPath}`);
      if (cudnnPath) dbg(`  cuDNN: ${cudnnPath}`);
    } else {
      dbg('GPU library paths NOT configured — GPU may fall back to CPU');
    }
  } catch (pathError) {
    // GPU libraries not installed or path error - will use CPU fallback
  }
}

// Detect Python executable on startup
const pythonCmd = detectPythonExecutable();
if (!pythonCmd) {
  console.error('⚠️  WARNING: Python executable not found!');
  console.error('   Transcription will fail until Python is installed and in PATH.');
} else {
  verifyPythonVersion(pythonCmd);
  dbg(`Python executable ready: ${pythonCmd}`);
}

const server = app.listen(PORT, () => {
  dbg(`Relay server listening on port ${PORT}`);
  if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR);
  if (!existsSync(TRANSCRIPTIONS_DIR)) mkdirSync(TRANSCRIPTIONS_DIR);
  if (!existsSync(DOWNLOADS_DIR)) mkdirSync(DOWNLOADS_DIR);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down relay server...');
  server.close(() => {
    console.log('✅ Relay server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM, shutting down relay server...');
  server.close(() => {
    console.log('✅ Relay server closed');
    process.exit(0);
  });
});

server.on('upgrade', (req, sock, head) => {
  wss.handleUpgrade(req, sock, head, ws => {
    wss.emit('connection', ws, req);
  });
});

// --- Helper Function to Download a File ---
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    get(url, response => {
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => {
      unlink(dest, () => {});
      reject(err.message);
    });
  });
}

function broadcast(type, payload) {
  const message = JSON.stringify({ type, payload });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

// --- WebSocket Server Logic ---
wss.on('connection', ws => {
  dbg('Extension connected');
  
  ws.on('close', (code, reason) => {
    dbg('Extension disconnected');
  });
  
  ws.on('error', error => {
    console.error('WebSocket Error:', error);
  });

  ws.on('message', async msg => {
    const messageString = msg.toString();
    dbg(`Received message: ${messageString}`);

    try {
      const parsedMessage = JSON.parse(messageString);
      const { type, url, data, mimeType, size, originalUrl, element, source, pageUrl, cookies, canonicalId } = parsedMessage;
      
      if (!type) {
        console.warn('⚠️  Received message without a type');
        return;
      }

      // Handle ping messages (connection verification)
      if (type === 'ping') {
        dbg('Ping received from extension');
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        return;
      }

      if (type === 'clear_completed') {
        // Preserve the ID of any job currently downloading/transcribing so it
        // stays protected even after the set is cleared.
        const activeId = jobQueue.currentJob?.entryId;
        jobQueue.completedIds.clear();
        if (activeId) jobQueue.completedIds.add(activeId);
        dbg(`Cleared completed IDs (active job protected: ${activeId ?? 'none'})`);
        ws.send(JSON.stringify({ 
          type: 'clear_completed_ack', 
          cleared: true,
          timestamp: Date.now() 
        }));
        return;
      }

      const jobId = uuidv4();
      const queueMetadata = {
        id: jobId,
        source: source || 'unknown',
        element: element || 'unknown',
        pageUrl: pageUrl || 'unknown'
      };

        // Handle stream_found (yt-dlp with cookies)
        if (type === 'stream_found') {
          // Filter out subtitle/caption URLs (WebVTT, SRT, etc.)
          const isSubtitleUrl = url.includes('caption') || 
                               url.includes('subtitle') || 
                               url.includes('serveWebVTT') || 
                               url.includes('.vtt') || 
                               url.includes('.srt') ||
                               url.includes('captionasset') ||
                               url.includes('caption_captionasset');
          
          if (isSubtitleUrl) {
            dbg(`Skipped subtitle/caption URL: ${url.substring(0, 100)}...`);
            broadcast('transcription_skipped', {
              id: jobId,
              reason: 'Subtitle/caption file detected',
              url
            });
            return; // Skip processing this URL
          }
          
          // Add job to queue with handler
          const queueResult = jobQueue.enqueue({
            jobId: jobId,
            url: url,
            entryId: canonicalId || undefined,
            handler: async () => {
              return new Promise((resolve, reject) => {
                dbg(`Starting download for job ${jobId}`);
                dbg(`URL: ${url.substring(0, 100)}...`);
                
                if (!cookies || cookies.length === 0) {
                  console.warn('⚠️  No cookies provided for stream, attempting download anyway');
                }
                
                // Create temporary cookie file
                const cookieFilePath = path.join(DOWNLOADS_DIR, `${jobId}_cookies.txt`);
                if (cookies && cookies.length > 0) {
                  writeNetscapeCookieFile(cookies, cookieFilePath);
                }
                
                // Force output filename to be jobId.mp4 to avoid naming conflicts
                const outputFilename = `${jobId}.mp4`;
                const outputPath = path.join(UPLOADS_DIR, outputFilename);
                
                // Build yt-dlp arguments with improved HLS handling
                const ytdlpArgs = [];
                
                // Add cookies if available
                if (cookies && cookies.length > 0) {
                  ytdlpArgs.push('--cookies', cookieFilePath);
                }
                
                // Format selection: best single file (prefer audio+video, fallback to best video)
                ytdlpArgs.push('-f', 'best');
                
                // Fix HLS stream warnings with ffmpeg downloader
                ytdlpArgs.push('--downloader', 'ffmpeg');
                ytdlpArgs.push('--hls-use-mpegts');
                
                // Use ffmpeg to fix stream issues
                ytdlpArgs.push('--postprocessor-args', 'ffmpeg:-fflags +genpts');
                
                // Force output filename
                ytdlpArgs.push('-o', outputPath);
                
                // Add URL
                ytdlpArgs.push(url);
                
                console.log('⬇️   Downloading...');
                dbg('Starting yt-dlp download...');
                
                // Spawn yt-dlp process
                const ytdlpProcess = spawn('yt-dlp', ytdlpArgs, {
                  cwd: __dirname
                });
                
                let stdoutData = '';
                let stderrData = '';
                
                ytdlpProcess.stdout.on('data', (data) => {
                  const output = data.toString();
                  stdoutData += output;
                  
                  // Only log important messages, filter out progress spam
                  const lines = output.split('\n');
                  lines.forEach(line => {
                    const trimmed = line.trim();
                    if (!trimmed) return;
                    
                    // Filter out progress lines (percentage, ETA, download speed)
                    if (trimmed.match(/\d+%|ETA|iB\/s|KiB\/s|MiB\/s/)) return;
                    
                    // Only log important messages
                    if (trimmed.match(/\[download\] Destination:|Merging formats|Deleting original file|already been downloaded|Fixing/i)) {
                      dbg(`yt-dlp: ${trimmed}`);
                    }
                  });
                });
                
                ytdlpProcess.stderr.on('data', (data) => {
                  const output = data.toString();
                  stderrData += output;
                  
                  // Only log warnings and errors, not info messages
                  const lines = output.split('\n');
                  lines.forEach(line => {
                    const trimmed = line.trim();
                    if (!trimmed) return;
                    
                    // Demote yt-dlp noise to debug
                    if (trimmed.match(/WARNING|ERROR|error/i)) {
                      dbg(`yt-dlp: ${trimmed}`);
                    }
                  });
                });
                
                ytdlpProcess.on('close', (code) => {
                  // Clean up cookie file
                  if (cookies && cookies.length > 0 && existsSync(cookieFilePath)) {
                    unlink(cookieFilePath, (err) => {
                      if (err) console.error(`⚠️  Error deleting cookie file:`, err);
                    });
                  }
                  
                  if (code === 0) {
                    dbg(`Download complete for job ${jobId}`);
                    
                    // Verify file exists
                    if (!existsSync(outputPath)) {
                      const error = new Error(`Downloaded file not found: ${outputFilename}`);
                      console.error(`❌ [DOWNLOAD] ${error.message}`);
                      
                      const errorMessage = JSON.stringify({
                        type: 'transcription_failed',
                        payload: { 
                          id: jobId, 
                          error: `Download succeeded but file not found: ${error.message}`,
                          source: source || 'sniffer',
                          element: element || 'stream',
                          pageUrl: pageUrl || 'unknown'
                        }
                      });
                      wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) client.send(errorMessage);
                      });
                      
                      reject(error);
                      return;
                    }
                    
                    dbg(`File saved: ${outputFilename}`);
                    
                    // Proceed with transcription
                    try {
                      console.log('🎙️   Transcribing...');
                      const transcript = transcribe(outputPath);
                      // Derive a friendly filename for the done message
                      const entryId = jobQueue.extractEntryId(url);
                      const baseName = entryId && entryId !== url ? entryId : outputFilename.replace(/\.[^.]+$/, '');
                      const transcriptPath = path.join(TRANSCRIPTIONS_DIR, `${baseName}.txt`);
                      const transcriptUri = `file:///${transcriptPath.replace(/\\/g, '/')}`;
                      console.log(`✅   Done`);
                      process.stdout.write(`     \x1b]8;;${transcriptUri}\x1b\\${transcriptPath}\x1b]8;;\x1b\\\n`);
                      dbg(`Transcription complete for job ${jobId}`);

                      const resultMessage = JSON.stringify({
                        type: 'transcription_done',
                        payload: { 
                          id: jobId, 
                          transcript,
                          source: source || 'sniffer',
                          element: element || 'stream',
                          pageUrl: pageUrl || 'unknown'
                        }
                      });
                      wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) client.send(resultMessage);
                      });
                      
                      resolve();
                    } catch (transcribeError) {
                      console.error(`❌ [TRANSCRIBE] Transcription failed for job ${jobId}:`, transcribeError.message);
                      
                      // Check if it's a CUDA error that should fall back to CPU
                      const isCudaError = transcribeError.message.includes('CUDA') || 
                                         transcribeError.message.includes('cudnn') ||
                                         transcribeError.message.includes('cublas');
                      
                      if (isCudaError) {
                        console.log(`💡 CUDA error detected, transcription will use CPU on next attempt`);
                        console.log(`💡 To fix: Run 'npm run setup:install' to configure GPU libraries`);
                      }
                      
                      const errorMessage = JSON.stringify({
                        type: 'transcription_failed',
                        payload: { 
                          id: jobId, 
                          error: `Transcription failed: ${transcribeError.message}`,
                          source: source || 'sniffer',
                          element: element || 'stream',
                          pageUrl: pageUrl || 'unknown'
                        }
                      });
                      wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) client.send(errorMessage);
                      });
                      
                      reject(transcribeError);
                    } finally {
                      // Clean up downloaded file
                      if (existsSync(outputPath)) {
                        unlink(outputPath, err => {
                          if (err) console.error(`⚠️  Error deleting temp file:`, err);
                        });
                      }
                    }
                    
                  } else {
                    const error = new Error(`yt-dlp failed with exit code ${code}: ${stderrData || 'Unknown error'}`);
                    console.error(`❌ [DOWNLOAD] ${error.message}`);
                    
                    const errorMessage = JSON.stringify({
                      type: 'transcription_failed',
                      payload: { 
                        id: jobId, 
                        error: error.message,
                        source: source || 'sniffer',
                        element: element || 'stream',
                        pageUrl: pageUrl || 'unknown'
                      }
                    });
                    wss.clients.forEach(client => {
                      if (client.readyState === WebSocket.OPEN) client.send(errorMessage);
                    });
                    
                    reject(error);
                  }
                });
                
                ytdlpProcess.on('error', (error) => {
                  console.error(`❌ [DOWNLOAD] Failed to spawn yt-dlp:`, error.message);
                  
                  // Clean up cookie file on error
                  if (cookies && cookies.length > 0 && existsSync(cookieFilePath)) {
                    unlink(cookieFilePath, () => {});
                  }
                  
                  const errorMessage = JSON.stringify({
                    type: 'transcription_failed',
                    payload: { 
                      id: jobId, 
                      error: `Failed to spawn yt-dlp: ${error.message}. Make sure yt-dlp is installed.`,
                      source: source || 'sniffer',
                      element: element || 'stream',
                      pageUrl: pageUrl || 'unknown'
                    }
                  });
                  wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) client.send(errorMessage);
                  });
                  
                  reject(error);
                });
              });
            }
          });
          
          if (!queueResult.added) {
            broadcast('transcription_skipped', {
              id: jobId,
              reason: `Duplicate stream detected (${queueResult.reason})`,
              url
            });
          } else {
            dbg(`New transcription request accepted: ${jobId}`);
            broadcast('new_transcription', queueMetadata);
            broadcast('transcription_queued', {
              ...queueMetadata,
              queuePosition: jobQueue.getStatus().queueSize
            });
          }
          
          return; // Exit early for stream_found, handled by queue
        }

        // Handle blob data
        if (type === 'blob') {
          dbg(`Processing blob data (${size} bytes, ${mimeType})...`);
          
          // Add job to queue
          const blobUrl = originalUrl || `blob:${jobId}`;
          const queueResult = jobQueue.enqueue({
            jobId: jobId,
            url: blobUrl,
            entryId: originalUrl ? jobQueue.extractEntryId(originalUrl) : `blob:${jobId}`,
            handler: async () => {
              return new Promise((resolve, reject) => {
                try {
                  // Determine file extension from MIME type
                  let fileExtension = '.mp3'; // default
                  if (mimeType) {
                    if (mimeType.includes('mp4')) fileExtension = '.mp4';
                    else if (mimeType.includes('webm')) fileExtension = '.webm';
                    else if (mimeType.includes('ogg')) fileExtension = '.ogg';
                    else if (mimeType.includes('wav')) fileExtension = '.wav';
                    else if (mimeType.includes('flac')) fileExtension = '.flac';
                    else if (mimeType.includes('m4a')) fileExtension = '.m4a';
                    else if (mimeType.includes('mp3')) fileExtension = '.mp3';
                  }
                  
                  const localFilePath = path.join(UPLOADS_DIR, `${jobId}${fileExtension}`);
                  
                  // Convert base64 to file
                  const buffer = Buffer.from(data, 'base64');
                  writeFileSync(localFilePath, buffer);
                  dbg(`Blob data saved to file: ${jobId}${fileExtension}`);

                  // Transcribe
                  console.log('🎙️   Transcribing...');
                  const transcript = transcribe(localFilePath);
                  const blobTranscriptPath = path.join(TRANSCRIPTIONS_DIR, `${jobId}.txt`);
                  const blobUri = `file:///${blobTranscriptPath.replace(/\\/g, '/')}`;
                  console.log(`✅   Done`);
                  process.stdout.write(`     \x1b]8;;${blobUri}\x1b\\${blobTranscriptPath}\x1b]8;;\x1b\\\n`);
                  dbg(`Transcription complete for job ${jobId}`);

                  const resultMessage = JSON.stringify({
                    type: 'transcription_done',
                    payload: { 
                      id: jobId, 
                      transcript,
                      source: source || 'unknown',
                      element: element || 'unknown',
                      pageUrl: pageUrl || 'unknown'
                    }
                  });
                  wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) client.send(resultMessage);
                  });

                  // Clean up
                  if (existsSync(localFilePath)) {
                    unlink(localFilePath, err => {
                      if (err) console.error(`⚠️  Error deleting temp file:`, err);
                    });
                  }

                  resolve();
                } catch (error) {
                  console.error(`❌ [TRANSCRIBE] Blob transcription failed for job ${jobId}:`, error.message);
                  
                  const errorMessage = JSON.stringify({
                    type: 'transcription_failed',
                    payload: { 
                      id: jobId, 
                      error: error.message,
                      source: source || 'unknown',
                      element: element || 'unknown',
                      pageUrl: pageUrl || 'unknown'
                    }
                  });
                  wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) client.send(errorMessage);
                  });

                  reject(error);
                }
              });
            }
          });
          if (!queueResult.added) {
            broadcast('transcription_skipped', {
              id: jobId,
              reason: `Duplicate upload detected (${queueResult.reason})`,
              url: blobUrl
            });
            return;
          }

          dbg(`New transcription request accepted: ${jobId}`);
          broadcast('new_transcription', queueMetadata);
          broadcast('transcription_queued', {
            ...queueMetadata,
            queuePosition: jobQueue.getStatus().queueSize
          });

        } else if (type === 'url') {
          // Handle regular URL
          if (!url) {
            throw new Error('URL is required for type "url"');
          }
          
          dbg(`Processing URL download: ${url.substring(0, 100)}...`);
          
          // Add job to queue
          const queueResult = jobQueue.enqueue({
            jobId: jobId,
            url: url,
            handler: async () => {
              return new Promise(async (resolve, reject) => {
                try {
                  dbg(`Downloading file for job ${jobId}...`);
                  const fileExtension = path.extname(new URL(url).pathname) || '.mp3';
                  const localFilePath = path.join(UPLOADS_DIR, `${jobId}${fileExtension}`);
                  console.log('⬇️   Downloading...');
                  await downloadFile(url, localFilePath);
                  dbg(`Download complete for job ${jobId}`);
                  
                  // Transcribe
                  console.log('🎙️   Transcribing...');
                  const transcript = transcribe(localFilePath);
                  const urlTranscriptPath = path.join(TRANSCRIPTIONS_DIR, `${jobId}.txt`);
                  const urlUri = `file:///${urlTranscriptPath.replace(/\\/g, '/')}`;
                  console.log(`✅   Done`);
                  process.stdout.write(`     \x1b]8;;${urlUri}\x1b\\${urlTranscriptPath}\x1b]8;;\x1b\\\n`);
                  dbg(`Transcription complete for job ${jobId}`);

                  const resultMessage = JSON.stringify({
                    type: 'transcription_done',
                    payload: { 
                      id: jobId, 
                      transcript,
                      source: source || 'unknown',
                      element: element || 'unknown',
                      pageUrl: pageUrl || 'unknown'
                    }
                  });
                  wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) client.send(resultMessage);
                  });

                  // Clean up
                  if (existsSync(localFilePath)) {
                    unlink(localFilePath, err => {
                      if (err) console.error(`⚠️  Error deleting temp file:`, err);
                    });
                  }

                  resolve();
                } catch (error) {
                  console.error(`❌ [TRANSCRIBE] URL transcription failed for job ${jobId}:`, error.message);
                  
                  const errorMessage = JSON.stringify({
                    type: 'transcription_failed',
                    payload: { 
                      id: jobId, 
                      error: error.message,
                      source: source || 'unknown',
                      element: element || 'unknown',
                      pageUrl: pageUrl || 'unknown'
                    }
                  });
                  wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) client.send(errorMessage);
                  });

                  reject(error);
                }
              });
            }
          });
          if (!queueResult.added) {
            broadcast('transcription_skipped', {
              id: jobId,
              reason: `Duplicate URL detected (${queueResult.reason})`,
              url
            });
            return;
          }

          dbg(`New transcription request accepted: ${jobId}`);
          broadcast('new_transcription', queueMetadata);
          broadcast('transcription_queued', {
            ...queueMetadata,
            queuePosition: jobQueue.getStatus().queueSize
          });
          
        } else {
          throw new Error(`Unknown message type: ${type}`);
        }
    } catch (parseError) {
      console.error('❌ Failed to parse message:', parseError.message);
    }
  });
});
