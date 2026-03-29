#!/usr/bin/env node

import { createInterface } from 'readline';
import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from 'fs';
import { execSync, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { log, debug, DEBUG, colors } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rl = createInterface({
  input: process.stdin,
  output: process.stdout
});

// Configuration
const MEDIA_DIR = path.join(__dirname, 'media');
const TRANSCRIPTIONS_DIR = path.join(__dirname, 'transcriptions');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PYTHON_SCRIPT = path.join(__dirname, 'transcribe.py');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Resolved Python path (set during prerequisite check)
let RESOLVED_PYTHON_PATH = null;

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

// ============================================================================
// CONFIG MANAGEMENT
// ============================================================================

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const configData = readFileSync(CONFIG_FILE, 'utf8');
      return JSON.parse(configData);
    }
  } catch (error) {
    log('⚠️  Could not load config file, using defaults', 'yellow');
  }
  return { installCompleted: false, lastInstallDate: null, version: "1.0.0", PYTHON_PATH: null };
}

function saveConfig(config) {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    log('⚠️  Could not save config file', 'yellow');
    return false;
  }
}

// ============================================================================
// PYTHON PATH RESOLUTION (Windows Fix)
// ============================================================================

/**
 * Resolve absolute Python executable path
 * Uses sys.executable to get the real path, not just "python" or "py"
 */
function resolvePythonPath(candidateCommand = 'python') {
  try {
    debug(`Resolving Python path from: ${candidateCommand}`);
    
    // Try to get absolute path using sys.executable
    const resolvedPath = execSync(
      `"${candidateCommand}" -c "import sys; print(sys.executable)"`,
      { 
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 10000
      }
    ).trim();
    
    // Verify the path exists
    if (!existsSync(resolvedPath)) {
      throw new Error(`Resolved path does not exist: ${resolvedPath}`);
    }
    
    debug(`Resolved Python path: ${resolvedPath}`, 'green');
    return resolvedPath;
    
  } catch (error) {
    // If candidate command fails, try alternatives
    if (candidateCommand === 'python') {
      log(`   Trying alternative: py`, 'yellow');
      return resolvePythonPath('py');
    } else if (candidateCommand === 'py') {
      log(`   Trying alternative: python3`, 'yellow');
      return resolvePythonPath('python3');
    }
    
    throw new Error(`Failed to resolve Python path: ${error.message}`);
  }
}

/**
 * Validate Python path can import required packages
 * Verifies faster_whisper is accessible
 */
function validatePythonPath(pythonPath) {
  try {
    debug(`Validating Python path can import faster_whisper...`);
    
    execSync(
      `"${pythonPath}" -c "import faster_whisper; print('OK')"`,
      { 
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 10000
      }
    );
    
    debug(`Python path validated - faster_whisper accessible`, 'green');
    return true;
    
  } catch (error) {
    log(`❌ Python path validation failed: ${error.message}`, 'red');
    log(`   The resolved Python cannot import faster_whisper`, 'yellow');
    log(`   This may indicate packages were installed to a different Python`, 'yellow');
    return false;
  }
}

/**
 * Resolve Python executable path only (no package validation).
 * Use during full install when faster_whisper may not be installed yet.
 */
function resolvePythonPathOnly() {
  try {
    try {
      return resolvePythonPath('python');
    } catch (error) {
      try {
        return resolvePythonPath('py');
      } catch (error2) {
        try {
          return resolvePythonPath('python3');
        } catch (error3) {
          throw new Error('Could not find Python executable. Tried: python, py, python3');
        }
      }
    }
  } catch (error) {
    log(`❌ Failed to resolve Python path: ${error.message}`, 'red');
    throw error;
  }
}

/**
 * Detect and lock Python executable path
 * Resolves absolute path and validates package access
 */
function detectAndLockPythonPath() {
  try {
    const pythonPath = resolvePythonPathOnly();
    
    // Validate the resolved path (requires faster_whisper already installed)
    const isValid = validatePythonPath(pythonPath);
    
    if (!isValid) {
      log(`⚠️  Warning: Resolved Python path cannot import faster_whisper`, 'yellow');
      log(`   Path: ${pythonPath}`, 'yellow');
      log(`   Packages may need to be reinstalled with this specific Python`, 'yellow');
      log(`   Run: "${pythonPath}" -m pip install -r requirements.txt`, 'cyan');
      
      throw new Error('Python path validation failed - packages not accessible');
    }
    
    // Lock the path
    debug(`Locked Python path: ${pythonPath}`, 'green');
    
    // Save to config
    const config = loadConfig();
    config.PYTHON_PATH = pythonPath;
    saveConfig(config);
    
    return pythonPath;
    
  } catch (error) {
    log(`❌ Failed to detect and lock Python path: ${error.message}`, 'red');
    throw error;
  }
}

/**
 * Get Python executable path (from config or detect)
 */
function getPythonPath() {
  const config = loadConfig();
  
  // If we have a saved path, validate it still works
  if (config.PYTHON_PATH && existsSync(config.PYTHON_PATH)) {
    try {
      // Quick validation
      execSync(`"${config.PYTHON_PATH}" --version`, { 
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000
      });
      
      debug(`Using locked Python path: ${config.PYTHON_PATH}`, 'green');
      return config.PYTHON_PATH;
    } catch (error) {
      log(`⚠️  Saved Python path invalid, re-detecting...`, 'yellow');
    }
  }
  
  // No saved path or invalid - detect and lock
  return detectAndLockPythonPath();
}

/**
 * Get Python command for execution
 * Returns resolved path if available, otherwise falls back to 'python'
 */
function getPythonCommand() {
  if (RESOLVED_PYTHON_PATH) {
    return `"${RESOLVED_PYTHON_PATH}"`;
  }
  
  // Fallback: try to get from config
  const config = loadConfig();
  if (config.PYTHON_PATH && existsSync(config.PYTHON_PATH)) {
    return `"${config.PYTHON_PATH}"`;
  }
  
  // Last resort: use generic command
  debug('Using generic Python command (path not resolved)', 'yellow');
  return 'python';
}

/**
 * Get pip command for the resolved Python
 */
function getPipCommand() {
  const pythonCmd = getPythonCommand();
  // Use -m pip to ensure we use the correct Python's pip
  return `${pythonCmd} -m pip`;
}

function shouldSkipInstall(forceReinstall = false) {
  if (forceReinstall) {
    log('🔄 Force reinstall flag detected, skipping install check', 'yellow');
    return false;
  }
  
  const config = loadConfig();
  if (config.installCompleted) {
    debug('Previous installation detected, skipping install checks', 'green');
    debug(`Last install: ${config.lastInstallDate || 'Unknown'}`);
    return true;
  }
  
  return false;
}

async function getGPUStatus() {
  try {
    // Write GPU test script to temporary file - actually test GPU processing
    const testScript = `import sys
import os
import warnings
import signal
warnings.filterwarnings("ignore")

# Set timeout handler
def timeout_handler(signum, frame):
    raise TimeoutError("GPU test timed out")

# Try to create a model with GPU - just loading is enough to test
try:
    import numpy as np
    from faster_whisper import WhisperModel
    from faster_whisper.utils import download_model
    
    # Try to load model on GPU - this will fail if CUDA libraries are missing
    print("DEBUG:Attempting to load model on CUDA...", flush=True)
    resolved_model_path = download_model("tiny")
    model = WhisperModel(resolved_model_path, device="cuda", compute_type="float16")
    print("DEBUG:Model loaded on CUDA successfully", flush=True)
    
    # Just loading the model is enough - if we get here, GPU works
    # We don't need to transcribe empty audio (which can hang)
    # The model loading itself uses CUDA and will fail if libraries are missing
    
    print("GPU_AVAILABLE:true", flush=True)
    print("GPU_TESTED:true", flush=True)
    print("GPU_METHOD:model_loading", flush=True)
    print("GPU_MODEL_SOURCE:Systran/faster-whisper-tiny", flush=True)
    print(f"GPU_MODEL_PATH:{resolved_model_path}", flush=True)
    
except ImportError as import_err:
    # Missing dependencies
    print(f"GPU_AVAILABLE:false", flush=True)
    print(f"GPU_ERROR:Missing dependency - {import_err}", flush=True)
except Exception as e:
    error_msg = str(e)
    print(f"DEBUG:Exception occurred: {error_msg}", flush=True)
    
    # Check if it's a CUDA-specific error
    cuda_errors = ["CUDA", "cudnn", "cublas", "dll", "cuda", "out of memory", "cuda error", "CUDA error", "cublas64", "cudnn64"]
    is_cuda_error = any(err.lower() in error_msg.lower() for err in cuda_errors)
    
    if is_cuda_error:
        print("GPU_AVAILABLE:false", flush=True)
        print(f"GPU_ERROR:{error_msg}", flush=True)
    else:
        # Might be a different error, but try CPU fallback test
        try:
            print("DEBUG:Attempting CPU fallback test...", flush=True)
            model_cpu = WhisperModel("tiny", device="cpu", compute_type="int8")
            print("DEBUG:CPU model loaded successfully", flush=True)
            print("GPU_AVAILABLE:false", flush=True)
            print("GPU_FALLBACK:CPU works", flush=True)
        except Exception as cpu_err:
            print("GPU_AVAILABLE:unknown", flush=True)
            print(f"GPU_ERROR:{error_msg} | CPU_TEST:{cpu_err}", flush=True)`;
    
    // Write script to temporary file
    const fs = await import('fs');
    const path = await import('path');
    const tempScriptPath = path.join(__dirname, 'temp_gpu_test.py');
    fs.writeFileSync(tempScriptPath, testScript);
    
    try {
      debug('Testing GPU (loading model on CUDA)...');
      let result;
      const pythonCmd = getPythonCommand();
      try {
        result = execSync(`${pythonCmd} "${tempScriptPath}"`, { 
          encoding: 'utf8',
          cwd: __dirname,
          timeout: 120000, // 120 second timeout (model download might take time on first run)
          stdio: 'pipe' // Capture both stdout and stderr
        });
      } catch (execError) {
        // execSync throws on non-zero exit, but we want to see the output
        result = execError.stdout || execError.stderr || execError.message;
        if (result && result.toString().length > 0) {
          log(`   Test output: ${result.toString().substring(0, 200)}`, 'yellow');
        }
      }
      
      const output = result.toString();
      const lines = output.replace(/\r/g, '').trim().split('\n');
      
      // Log all output in debug mode
      const debugLines = lines.filter(line =>
        line.includes('GPU_') || 
        line.includes('ERROR') || 
        line.includes('WARNING') ||
        line.includes('CUDA') ||
        line.includes('cuda')
      );
      if (debugLines.length > 0) {
        const compactDebug = debugLines.map(line => line.trim()).filter(Boolean).join(' | ');
        debug(`GPU test output: ${compactDebug}`);
      }
      
      const gpuAvailable = lines.find(line => line.startsWith('GPU_AVAILABLE:'))?.split(':')[1]?.trim();
      const gpuTested = lines.find(line => line.startsWith('GPU_TESTED:'))?.split(':')[1]?.trim();
      const gpuMethod = lines.find(line => line.startsWith('GPU_METHOD:'))?.split(':').slice(1).join(':')?.trim();
      const gpuModelSource = lines.find(line => line.startsWith('GPU_MODEL_SOURCE:'))?.split(':').slice(1).join(':')?.trim();
      const gpuModelPath = lines.find(line => line.startsWith('GPU_MODEL_PATH:'))?.split(':').slice(1).join(':')?.trim();
      const gpuError = lines.find(line => line.startsWith('GPU_ERROR:'))?.split(':').slice(1).join(':')?.trim();
      const gpuFallback = lines.find(line => line.startsWith('GPU_FALLBACK:'))?.split(':').slice(1).join(':')?.trim();
      
      if (gpuAvailable === 'true' && gpuTested === 'true') {
        const method = gpuMethod ? ` (${gpuMethod})` : '';
        debug(`GPU test passed - CUDA acceleration confirmed${method}`, 'green');
        if (gpuModelSource) debug(`GPU test model source: ${gpuModelSource}`);
        if (gpuModelPath) debug(`GPU test model path: ${gpuModelPath}`);
        return {
          available: true,
          type: 'GPU (CUDA) - Tested',
          color: 'green',
          modelSource: gpuModelSource || null,
          modelPath: gpuModelPath || null
        };
      } else if (gpuAvailable === 'false') {
        if (gpuError) {
          log(`⚠️  GPU test failed: ${gpuError.substring(0, 150)}`, 'yellow');
          
          // Check for CUDA library issues and offer to install
          const needsCudaLibs = gpuError.includes('cublas') || gpuError.includes('cudnn') || 
                                gpuError.includes('cublas64_12.dll') || gpuError.includes('cudnn64_12.dll');
          
          if (needsCudaLibs) {
            log('   💡 Missing CUDA libraries detected', 'yellow');
            
            // Check if libraries are already installed
            let librariesInstalled = false;
            const pythonCmd = getPythonCommand();
            try {
              execSync(`${pythonCmd} -c "import nvidia.cublas; import nvidia.cudnn"`, { 
                encoding: 'utf8', 
                stdio: 'pipe' 
              });
              librariesInstalled = true;
              log('   ⚠️  Libraries are installed but not found - PATH issue?', 'yellow');
            } catch (importError) {
              // Libraries not installed, proceed with installation
            }
            
            if (!librariesInstalled) {
              log('   📦 Attempting to install CUDA libraries automatically...', 'cyan');
              
              try {
                // Check if nvidia-smi works (GPU is present)
                try {
                  execSync('nvidia-smi', { encoding: 'utf8', stdio: 'pipe' });
                  log('   ✅ NVIDIA GPU detected, installing libraries...', 'green');
                  
                  // Install the libraries using the resolved Python's pip
                  const pipCmd = getPipCommand();
                  execSync(`${pipCmd} install nvidia-cublas-cu12 nvidia-cudnn-cu12==9.*`, { stdio: 'inherit' });
                  log('   ✅ CUDA libraries installed!', 'green');
                
                // Configure library paths after installation
                await configureGPULibraryPaths(true);
                
                log('   🔄 Re-testing GPU...', 'cyan');
                // Re-run the GPU test
                const retestResult = execSync(`${pythonCmd} "${tempScriptPath}"`, { 
                  encoding: 'utf8',
                  cwd: __dirname,
                  timeout: 60000,
                  env: process.env // Use updated environment with PATH
                });
                
                const retestLines = retestResult.toString().trim().split('\n');
                const retestGpuAvailable = retestLines.find(line => line.startsWith('GPU_AVAILABLE:'))?.split(':')[1]?.trim();
                const retestGpuTested = retestLines.find(line => line.startsWith('GPU_TESTED:'))?.split(':')[1]?.trim();
                
                if (retestGpuAvailable === 'true' && retestGpuTested === 'true') {
                  log('   ✅ GPU now working after installing libraries!', 'green');
                  return { available: true, type: 'GPU (CUDA) - Tested', color: 'green' };
                } else {
                  log('   ⚠️  Libraries installed but GPU still not working', 'yellow');
                  log('   💡 Try restarting the setup script or check NVIDIA drivers', 'yellow');
                }
              } catch (nvidiaError) {
                log('   ⚠️  nvidia-smi not found - GPU may not be properly detected', 'yellow');
                log('   💡 Make sure NVIDIA drivers are installed', 'yellow');
              }
            } catch (installError) {
              log('   ❌ Failed to install CUDA libraries automatically', 'red');
              log('   💡 Try manually: pip install nvidia-cublas-cu12 nvidia-cudnn-cu12==9.*', 'yellow');
            }
            } else {
              // Libraries installed but not working - PATH issue
              log('   💡 Libraries are installed but not accessible', 'yellow');
              log('   💡 Try: pip install --upgrade nvidia-cublas-cu12 nvidia-cudnn-cu12==9.*', 'yellow');
              log('   💡 Or restart your terminal/shell to refresh PATH', 'yellow');
            }
          } else if (gpuError.includes('out of memory')) {
            log('   💡 GPU memory issue - try smaller model or close other GPU apps', 'yellow');
          } else if (gpuError.includes('dll') || gpuError.includes('DLL')) {
            log('   💡 CUDA DLL issue - check NVIDIA drivers are installed', 'yellow');
            log('   💡 Also try: pip install nvidia-cublas-cu12 nvidia-cudnn-cu12==9.*', 'yellow');
          }
        } else if (gpuFallback) {
          log(`⚠️  GPU unavailable, CPU works: ${gpuFallback}`, 'yellow');
        } else {
          log('⚠️  GPU test failed (no error details)', 'yellow');
        }
        return {
          available: false,
          type: 'CPU (GPU unavailable)',
          color: 'yellow',
          modelSource: gpuModelSource || null,
          modelPath: gpuModelPath || null
        };
      } else {
        // No GPU_AVAILABLE line found - script might have crashed
        log('⚠️  GPU test unclear - script may have failed', 'yellow');
        log(`   Full output: ${output.substring(0, 300)}`, 'yellow');
        return {
          available: false,
          type: 'CPU (GPU test unclear)',
          color: 'yellow',
          modelSource: gpuModelSource || null,
          modelPath: gpuModelPath || null
        };
      }
    } catch (execError) {
      // If execution fails completely, show the error
      log('⚠️  GPU test execution failed', 'yellow');
      log(`   Error: ${execError.message}`, 'yellow');
      if (execError.stderr) {
        log(`   stderr: ${execError.stderr.toString().substring(0, 200)}`, 'yellow');
      }
      return { available: false, type: 'CPU (GPU test error)', color: 'yellow', modelSource: null, modelPath: null };
    } finally {
      // Clean up temporary file
      try {
        fs.unlinkSync(tempScriptPath);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    }
    
  } catch (error) {
    return { available: false, type: 'CPU (GPU test error)', color: 'yellow', modelSource: null, modelPath: null };
  }
}

// Loading animation function with configurable duration
function showLoadingAnimation(message, duration = 2000) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  
  const interval = setInterval(() => {
    process.stdout.write(`\r${colors.cyan}${frames[i]} ${message}${colors.reset}`);
    i = (i + 1) % frames.length;
  }, 100);
  
  return new Promise((resolve) => {
    setTimeout(() => {
      clearInterval(interval);
      process.stdout.write('\r' + ' '.repeat(message.length + 10) + '\r');
      resolve();
    }, duration);
  });
}

async function ensureDirectoriesAndFiles() {
  // Create media directory
  if (!existsSync(MEDIA_DIR)) {
    mkdirSync(MEDIA_DIR, { recursive: true });
    debug('Created media directory', 'green');
  } else {
    debug('Media directory exists', 'green');
  }

  // Create transcriptions directory
  if (!existsSync(TRANSCRIPTIONS_DIR)) {
    mkdirSync(TRANSCRIPTIONS_DIR, { recursive: true });
    debug('Created transcriptions directory', 'green');
  } else {
    debug('Transcriptions directory exists', 'green');
  }

  // Create uploads directory
  if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
    debug('Created uploads directory', 'green');
  } else {
    debug('Uploads directory exists', 'green');
  }

  // Create config.json if it doesn't exist
  if (!existsSync(CONFIG_FILE)) {
    const defaultConfig = {
      installCompleted: false,
      lastInstallDate: null,
      version: "1.0.0"
    };
    writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    debug('Created config.json', 'green');
  } else {
    debug('Config file exists', 'green');
  }

  // Create README files for directories if they don't exist
  const mediaReadme = path.join(MEDIA_DIR, 'README.md');
  if (!existsSync(mediaReadme)) {
    const mediaReadmeContent = `# Media Files\n
Place your audio/video files here for transcription.

## Supported Formats
- Audio: .mp3, .wav, .m4a, .flac, .ogg, .webm
- Video: .mp4, .mkv, .avi (audio automatically extracted)

## Usage
Run \`npm run setup\` and choose option 1 to transcribe files from this directory.

## Tips
- Use shorter files for faster processing
- Higher quality files produce better transcriptions
- GPU acceleration is available for faster processing
`;
    writeFileSync(mediaReadme, mediaReadmeContent);
    debug('Created media/README.md', 'green');
  }

  const transcriptionsReadme = path.join(TRANSCRIPTIONS_DIR, 'README.md');
  if (!existsSync(transcriptionsReadme)) {
    const transcriptionsReadmeContent = `# Transcriptions Directory

This directory contains all transcription results.

## File Format
Each transcription file includes:
- Metadata (device, language, confidence)
- Timestamped segments
- Formatted text with intelligent line breaks

## File Naming
- Local files: \`[filename].txt\`
- Extension downloads: \`[uuid].txt\`

## Viewing Transcriptions
Open any .txt file to view the transcription results.
`;
    writeFileSync(transcriptionsReadme, transcriptionsReadmeContent);
    debug('Created transcriptions/README.md', 'green');
  }
}

async function checkPrerequisites(forceReinstall = false) {
  // Check if we should skip installation
  if (shouldSkipInstall(forceReinstall)) {
    // Still need to ensure directories and files exist
    await ensureDirectoriesAndFiles();
    
    // Load Python path from config if available
    const config = loadConfig();
    if (config.PYTHON_PATH && existsSync(config.PYTHON_PATH)) {
      RESOLVED_PYTHON_PATH = config.PYTHON_PATH;
      debug(`Using locked Python path from config: ${RESOLVED_PYTHON_PATH}`, 'green');
      
      // Validate it can still import faster_whisper
      if (!validatePythonPath(RESOLVED_PYTHON_PATH)) {
        log('⚠️  Saved Python path cannot import faster_whisper', 'yellow');
        log('   Re-detecting Python path...', 'cyan');
        try {
          RESOLVED_PYTHON_PATH = detectAndLockPythonPath();
        } catch (error) {
          log(`❌ Failed to re-detect Python: ${error.message}`, 'red');
          return false;
        }
      }
    } else {
      // No saved path, detect and lock it
      debug('No saved Python path found, detecting...');
      try {
        RESOLVED_PYTHON_PATH = detectAndLockPythonPath();
      } catch (error) {
        log(`❌ Failed to detect Python: ${error.message}`, 'red');
        return false;
      }
    }
    
    // IMPORTANT: Always check and install GPU libraries if GPU is detected
    // This ensures GPU works even if libraries weren't installed initially
    try {
      execSync('nvidia-smi', { encoding: 'utf8', stdio: 'pipe' });
      debug('NVIDIA GPU detected - checking GPU libraries...');
      
      // Check if libraries are installed
      let librariesInstalled = false;
      const pythonCmd = getPythonCommand();
      try {
        execSync(`${pythonCmd} -c "import nvidia.cublas; import nvidia.cudnn"`, { 
          encoding: 'utf8', 
          stdio: 'pipe' 
        });
        librariesInstalled = true;
        debug('GPU libraries already installed', 'green');
      } catch (importError) {
        log('⚠️  GPU libraries missing - installing now...', 'yellow');
        await installGPUDependencies();
        // Verify installation succeeded
        try {
          execSync(`${pythonCmd} -c "import nvidia.cublas; import nvidia.cudnn"`, { 
            encoding: 'utf8', 
            stdio: 'pipe' 
          });
          librariesInstalled = true;
          log('✅ GPU libraries installed successfully', 'green');
        } catch (verifyError) {
          log('⚠️  GPU libraries installation may have failed', 'yellow');
        }
      }
      
      // Configure paths if libraries are installed
      if (librariesInstalled) {
        await configureGPULibraryPaths(true); // silent mode
      }
    } catch (nvidiaError) {
      // No NVIDIA GPU, skip GPU setup
    }
    
    // Check GPU status - this will verify everything works
    const gpuStatus = await getGPUStatus();
    
    // Return GPU status for skipped installs too
    return { success: true, gpuStatus: gpuStatus };
  }
  
  debug('Checking prerequisites...');
  
  // Check Node.js version
  try {
    const nodeVersion = execSync('node --version', { encoding: 'utf8' }).trim();
    debug(`Node.js: ${nodeVersion}`, 'green');
  } catch (error) {
    log('❌ Node.js not found. Please install Node.js 14 or higher.', 'red');
    return false;
  }

  // ===== PYTHON DETECTION AND PATH RESOLUTION (full install: resolve only, validate after pip install) =====
  let pythonPath;
  try {
    debug('Resolving Python executable path...');
    pythonPath = resolvePythonPathOnly();
    
    // Check Python version using resolved path
    const pythonVersion = execSync(`"${pythonPath}" --version`, { encoding: 'utf8' }).trim();
    debug(`Python: ${pythonVersion}`, 'green');
    
    // Check if Python version is 3.9 or higher
    const versionMatch = pythonVersion.match(/Python (\d+)\.(\d+)/);
    if (versionMatch) {
      const major = parseInt(versionMatch[1]);
      const minor = parseInt(versionMatch[2]);
      if (major < 3 || (major === 3 && minor < 9)) {
        log('❌ Python 3.9 or higher is required for faster-whisper', 'red');
        return false;
      }
    }
    
    // Store resolved path globally so pip/npm steps use it; faster_whisper is validated after pip install
    RESOLVED_PYTHON_PATH = pythonPath;
    debug(`Using Python for install: ${pythonPath}`, 'green');
    
  } catch (error) {
    log(`❌ Python detection failed: ${error.message}`, 'red');
    return false;
  }

  // Check yt-dlp
  try {
    const ytdlpVersion = execSync('yt-dlp --version', { encoding: 'utf8' }).trim();
    debug(`yt-dlp: ${ytdlpVersion}`, 'green');
  } catch (error) {
    log('❌ yt-dlp not found. Attempting to install...', 'yellow');
    try {
      log('📦 Installing yt-dlp via pip...', 'cyan');
      const pipCmd = getPipCommand();
      execSync(`${pipCmd} install yt-dlp`, { stdio: 'inherit' });
      const ytdlpVersion = execSync('yt-dlp --version', { encoding: 'utf8' }).trim();
      log(`✅ yt-dlp installed successfully: ${ytdlpVersion}`, 'green');
    } catch (installError) {
      log('❌ Failed to install yt-dlp. Please install it manually:', 'red');
      const pipCmd = getPipCommand();
      log(`   ${pipCmd} install yt-dlp`, 'yellow');
      log('   yt-dlp is required for stream downloading functionality', 'yellow');
      return false;
    }
  }

  // Quick CUDA check before full GPU test
  try {
    debug('Quick CUDA check...');
    const pythonCmd = getPythonCommand();
    const cudaCheck = execSync(`${pythonCmd} -c "import torch; print(\\"CUDA:\\", torch.cuda.is_available(), \\"Device:\\", torch.cuda.get_device_name(0) if torch.cuda.is_available() else \\"N/A\\")"`, { 
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe'
    });
    const cudaLines = cudaCheck.trim().split('\n');
    const cudaLine = cudaLines.find(line => line.includes('CUDA:'));
    if (cudaLine) debug(cudaLine);
  } catch (cudaCheckError) {
    // torch may not be installed, that's okay - faster-whisper doesn't require it
  }

  // Check ffmpeg (recommended for yt-dlp)
  try {
    const ffmpegVersion = execSync('ffmpeg -version', { encoding: 'utf8' }).split('\n')[0];
    debug(`ffmpeg: ${ffmpegVersion}`, 'green');
  } catch (error) {
    log('⚠️  ffmpeg not found. Attempting to install...', 'yellow');
    
    const platform = process.platform;
    let installSuccess = false;
    
    try {
      if (platform === 'win32') {
        // Try Chocolatey first (most common on Windows)
        log('📦 Attempting to install via Chocolatey...', 'cyan');
        try {
          execSync('choco install ffmpeg -y', { stdio: 'inherit' });
          installSuccess = true;
        } catch (chocoError) {
          log('   Chocolatey not available, trying Scoop...', 'yellow');
          try {
            execSync('scoop install ffmpeg', { stdio: 'inherit' });
            installSuccess = true;
          } catch (scoopError) {
            log('   Scoop not available either', 'yellow');
          }
        }
      } else if (platform === 'darwin') {
        // macOS - use Homebrew
        log('📦 Attempting to install via Homebrew...', 'cyan');
        try {
          execSync('brew install ffmpeg', { stdio: 'inherit' });
          installSuccess = true;
        } catch (brewError) {
          log('   Homebrew not available', 'yellow');
        }
      } else if (platform === 'linux') {
        // Linux - try apt first, then yum/dnf
        log('📦 Attempting to install via package manager...', 'cyan');
        try {
          execSync('sudo apt-get update && sudo apt-get install -y ffmpeg', { stdio: 'inherit' });
          installSuccess = true;
        } catch (aptError) {
          try {
            execSync('sudo yum install -y ffmpeg', { stdio: 'inherit' });
            installSuccess = true;
          } catch (yumError) {
            try {
              execSync('sudo dnf install -y ffmpeg', { stdio: 'inherit' });
              installSuccess = true;
            } catch (dnfError) {
              log('   No compatible package manager found', 'yellow');
            }
          }
        }
      }
      
      if (installSuccess) {
        // Verify installation
        const ffmpegVersion = execSync('ffmpeg -version', { encoding: 'utf8' }).split('\n')[0];
        log(`✅ ffmpeg installed successfully: ${ffmpegVersion}`, 'green');
      } else {
        throw new Error('Auto-install failed');
      }
    } catch (installError) {
      log('⚠️  Failed to auto-install ffmpeg. Manual installation required:', 'yellow');
      log('   ffmpeg fixes stream issues and enables format conversion', 'yellow');
      if (platform === 'win32') {
        log('   Windows options:', 'cyan');
        log('     1. Install Chocolatey: https://chocolatey.org/install', 'cyan');
        log('        Then run: choco install ffmpeg', 'cyan');
        log('     2. Or install Scoop: https://scoop.sh/', 'cyan');
        log('        Then run: scoop install ffmpeg', 'cyan');
        log('     3. Or download manually: https://ffmpeg.org/download.html', 'cyan');
      } else if (platform === 'darwin') {
        log('   Mac: Install Homebrew first: https://brew.sh/', 'cyan');
        log('   Then run: brew install ffmpeg', 'cyan');
      } else {
        log('   Linux: sudo apt install ffmpeg (Debian/Ubuntu)', 'cyan');
        log('   Or: sudo yum install ffmpeg (RHEL/CentOS)', 'cyan');
      }
      log('   The system will work without ffmpeg, but some streams may have issues', 'yellow');
    }
  }

  // Check if package.json exists
  if (!existsSync(path.join(__dirname, 'package.json'))) {
    log('❌ package.json not found in current directory.', 'red');
    return false;
  }

  // Install Node.js dependencies
  log('📦 Installing Node.js dependencies...', 'cyan');
  try {
    execSync('npm install', { stdio: 'inherit', cwd: __dirname });
    log('✅ Node.js dependencies installed successfully', 'green');
  } catch (error) {
    log('❌ Failed to install Node.js dependencies', 'red');
    return false;
  }

  // Install Python dependencies from requirements.txt
  const requirementsPath = path.join(__dirname, 'requirements.txt');
  log('📦 Installing Python dependencies from requirements.txt (this may take a few minutes)...', 'cyan');
  try {
    const pipCmd = getPipCommand();
    debug(`Using pip: ${pipCmd}`);
    if (existsSync(requirementsPath)) {
      execSync(`${pipCmd} install -r "${requirementsPath}"`, { stdio: 'inherit', cwd: __dirname });
      log('✅ Python dependencies from requirements.txt installed successfully', 'green');
    } else {
      log('   requirements.txt not found, installing faster-whisper only', 'yellow');
      execSync(`${pipCmd} install faster-whisper`, { stdio: 'inherit' });
      log('✅ faster-whisper installed successfully', 'green');
    }
    
    // Verify installation with resolved Python
    const pythonCmd = getPythonCommand();
    debug('Verifying faster-whisper installation...');
    execSync(`${pythonCmd} -c "import faster_whisper; print('OK')"`, { 
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 10000
    });
    debug('faster-whisper verified and accessible', 'green');
    
    // Check for NVIDIA GPU and install GPU dependencies
    await installGPUDependencies();
    
  } catch (error) {
    log('❌ Failed to install Python dependencies', 'red');
    log(`   Error: ${error.message}`, 'yellow');
    log('   Make sure pip is installed and accessible', 'yellow');
    const pythonCmd = getPythonCommand();
    log(`   Try manually: ${pythonCmd} -m pip install -r requirements.txt`, 'cyan');
    return false;
  }

  // Create Python transcription script
  await createPythonScript();

  // Create directories and files if they don't exist
  await ensureDirectoriesAndFiles();

  // Mark installation as complete
  markInstallationComplete();

  // Verify GPU installation (getGPUStatus does a thorough test, so we skip verifyGPUInstallation to avoid duplicates)
  return { success: true, gpuStatus: await getGPUStatus() };
}

function markInstallationComplete() {
  const config = loadConfig();
  config.installCompleted = true;
  config.lastInstallDate = new Date().toISOString();
  config.version = "1.0.0";
  
  // Ensure PYTHON_PATH is saved if we have it
  if (RESOLVED_PYTHON_PATH) {
    config.PYTHON_PATH = RESOLVED_PYTHON_PATH;
    debug(`Python path saved to config: ${RESOLVED_PYTHON_PATH}`, 'green');
  }
  
  saveConfig(config);
  debug('Installation marked as complete', 'green');
}

async function installGPUDependencies() {
  try {
    // Check if NVIDIA GPU is available
    const nvidiaCheck = execSync('nvidia-smi', { encoding: 'utf8', stdio: 'pipe' });
    debug('NVIDIA GPU detected!', 'green');
    
    // Install NVIDIA libraries for GPU support
    log('📦 Installing NVIDIA GPU libraries (this may take a few minutes)...', 'cyan');
    
    try {
      // Install cuBLAS and cuDNN for CUDA 12 using resolved Python's pip
      const pipCmd = getPipCommand();
      debug(`Using pip: ${pipCmd}`);
      execSync(`${pipCmd} install nvidia-cublas-cu12`, { stdio: 'inherit' });
      execSync(`${pipCmd} install nvidia-cudnn-cu12==9.*`, { stdio: 'inherit' });
      log('✅ NVIDIA GPU libraries installed successfully', 'green');
      
      // Configure library paths based on platform
      await configureGPULibraryPaths();
      
    } catch (gpuError) {
      log('⚠️  GPU libraries installation failed, falling back to CPU mode', 'yellow');
      log('   GPU acceleration will not be available', 'yellow');
    }
    
  } catch (error) {
    log('💻 No NVIDIA GPU detected, using CPU mode', 'yellow');
    log('   For GPU acceleration, install NVIDIA drivers and CUDA', 'yellow');
  }
}

async function configureGPULibraryPaths(silent = false) {
  try {
    const pythonCmd = getPythonCommand();
    
    // First check if libraries are installed
    try {
      execSync(`${pythonCmd} -c "import nvidia.cublas; import nvidia.cudnn"`, { 
        encoding: 'utf8', 
        stdio: 'pipe' 
      });
    } catch (importError) {
      if (!silent) {
        log('⚠️  GPU libraries not installed - cannot configure paths', 'yellow');
      }
      return; // Can't configure paths if libraries aren't installed
    }
    
    if (process.platform === 'linux') {
      // Linux configuration
      // Python 3.13+: namespace packages have __file__=None, must use __path__[0]
      const ldPath = execSync(`${pythonCmd} -c "import nvidia.cublas; import nvidia.cudnn; print(nvidia.cublas.__path__[0] + \":\" + nvidia.cudnn.__path__[0])"`, { encoding: 'utf8' }).trim();
      process.env.LD_LIBRARY_PATH = ldPath;
      if (!silent) log('✅ Linux GPU library paths configured', 'green');
    } else if (process.platform === 'win32') {
      // Windows configuration
      if (!silent) log('🔧 Configuring Windows GPU library paths...', 'yellow');
      
      try {
        // Find actual library locations (they may be in different site-packages)
        let cublasPath = null;
        let cudnnPath = null;
        
        try {
          // Get cublas location - on Windows, DLLs are in 'bin' directory
          // Python 3.13+: namespace packages have __file__=None, must use __path__[0]
          const cublasLocation = execSync(`${pythonCmd} -c "import nvidia.cublas; print(nvidia.cublas.__path__[0])"`, { 
            encoding: 'utf8',
            stdio: 'pipe'
          }).trim();
          // Try 'bin' first (Windows standard), then 'lib' as fallback
          const binPath = path.join(cublasLocation, 'bin');
          const libPath = path.join(cublasLocation, 'lib');
          cublasPath = existsSync(binPath) ? binPath : (existsSync(libPath) ? libPath : null);
        } catch (e) {
          // Try user site-packages
          try {
            const userSite = execSync(`${pythonCmd} -c "import site; print(site.getusersitepackages())"`, { encoding: 'utf8' }).trim();
            const binPath = path.join(userSite, 'nvidia', 'cublas', 'bin');
            const libPath = path.join(userSite, 'nvidia', 'cublas', 'lib');
            cublasPath = existsSync(binPath) ? binPath : (existsSync(libPath) ? libPath : null);
          } catch (e2) {}
        }
        
        try {
          // Get cudnn location - on Windows, DLLs are in 'bin' directory
          // Python 3.13+: namespace packages have __file__=None, must use __path__[0]
          const cudnnLocation = execSync(`${pythonCmd} -c "import nvidia.cudnn; print(nvidia.cudnn.__path__[0])"`, { 
            encoding: 'utf8',
            stdio: 'pipe'
          }).trim();
          // Try 'bin' first (Windows standard), then 'lib' as fallback
          const binPath = path.join(cudnnLocation, 'bin');
          const libPath = path.join(cudnnLocation, 'lib');
          cudnnPath = existsSync(binPath) ? binPath : (existsSync(libPath) ? libPath : null);
        } catch (e) {
          // Try system site-packages
          try {
            const sysSite = execSync(`${pythonCmd} -c "import site; print(site.getsitepackages()[0])"`, { encoding: 'utf8' }).trim();
            const binPath = path.join(sysSite, 'nvidia', 'cudnn', 'bin');
            const libPath = path.join(sysSite, 'nvidia', 'cudnn', 'lib');
            cudnnPath = existsSync(binPath) ? binPath : (existsSync(libPath) ? libPath : null);
          } catch (e2) {}
        }
        
        // Verify paths exist and add whichever ones are found
        const pathsToAdd = [];
        if (cublasPath && existsSync(cublasPath)) {
          pathsToAdd.push(cublasPath);
        }
        if (cudnnPath && existsSync(cudnnPath)) {
          pathsToAdd.push(cudnnPath);
        }
        
        if (pathsToAdd.length === 0) {
          if (!silent) {
            log('⚠️  GPU library directories not found', 'yellow');
            if (cublasPath) log(`   cuBLAS: ${cublasPath} ${existsSync(cublasPath) ? '✅' : '❌'}`, 'yellow');
            if (cudnnPath) log(`   cuDNN: ${cudnnPath} ${existsSync(cudnnPath) ? '✅' : '❌'}`, 'yellow');
          }
          return;
        }
        
        // Add found paths to PATH for current process (and all child processes)
        if (process.env.PATH) {
          process.env.PATH = `${pathsToAdd.join(';')};${process.env.PATH}`;
        } else {
          process.env.PATH = pathsToAdd.join(';');
        }
        
        // Set CUDA-specific environment variables
        process.env.CUDA_PATH = process.env.CUDA_PATH || 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.0';
        process.env.CUDA_HOME = process.env.CUDA_PATH;
        
        // Set additional Windows-specific environment variables for cuDNN (if found)
        if (cudnnPath && existsSync(cudnnPath)) {
          process.env.CUDNN_PATH = cudnnPath;
          process.env.CUDNN_LIB_PATH = cudnnPath;
        }
        
        if (!silent) {
          log('✅ Windows GPU library paths configured', 'green');
          if (cublasPath && existsSync(cublasPath)) {
            log(`   cuBLAS path: ${cublasPath}`, 'cyan');
          }
          if (cudnnPath && existsSync(cudnnPath)) {
            log(`   cuDNN path: ${cudnnPath}`, 'cyan');
          }
          log(`   PATH updated for this process (${pathsToAdd.length} path(s) added)`, 'cyan');
        }
        
      } catch (pathError) {
        if (!silent) {
          log('⚠️  Could not configure Windows GPU paths automatically', 'yellow');
          log(`   Error: ${pathError.message}`, 'yellow');
          log('   GPU may still work, but manual configuration might be needed', 'yellow');
        }
      }
    }
  } catch (error) {
    if (!silent) {
      log('⚠️  GPU library path configuration failed', 'yellow');
      log(`   Error: ${error.message}`, 'yellow');
      log('   GPU acceleration may not work properly', 'yellow');
    }
  }
}

async function createPythonScript() {
  const pythonScript = `#!/usr/bin/env python3
import sys
import os
import warnings
import json
import time
from datetime import datetime
from faster_whisper import WhisperModel
from faster_whisper.utils import download_model

# Suppress warnings for cleaner output
warnings.filterwarnings("ignore", category=UserWarning)

def transcribe_audio(audio_file, model_size="medium", use_gpu=True):
    """Transcribe audio file using faster-whisper"""
    try:
        # Determine device and compute type
        device = "cuda" if use_gpu else "cpu"
        # Use float32 for CPU to get better quality (int8 quantizes and reduces accuracy)
        # For GPU, use float16 for speed/quality balance
        compute_type = "float16" if use_gpu else "float32"
        
        print(f"STATUS:Initializing {device.upper()} processing...", flush=True)
        
        # Resolve model to an actual local path/repo before loading so setup can
        # display what was really loaded (not just configured size string).
        resolved_model_path = model_size
        resolved_model_id = model_size
        if not os.path.isdir(model_size):
            resolved_model_path = download_model(model_size)
            path_parts = resolved_model_path.replace("\\\\", "/").split("/")
            snapshots_idx = path_parts.index("snapshots") if "snapshots" in path_parts else -1
            if snapshots_idx > 0:
                resolved_model_id = path_parts[snapshots_idx - 1].replace("models--", "").replace("--", "/")
        
        # Load model with timing
        print(f"STATUS:Loading Whisper model ({model_size})...", flush=True)
        print(f"STATUS:Resolved model source: {resolved_model_id}", flush=True)
        print(f"STATUS:Resolved model path: {resolved_model_path}", flush=True)
        print(f"STATUS:Checking cache (downloading if needed)...", flush=True)
        
        start_time = time.time()
        model = WhisperModel(resolved_model_path, device=device, compute_type=compute_type)
        load_time = time.time() - start_time
        
        # Determine if it was cached based on load time
        # Cached models load very quickly (< 2s for GPU, < 3s for CPU)
        if use_gpu:
            is_cached = load_time < 2.0
        else:
            is_cached = load_time < 3.0
        
        if is_cached:
            print(f"STATUS:Model loaded from cache ({load_time:.1f}s)", flush=True)
        else:
            print(f"STATUS:Model downloaded and loaded ({load_time:.1f}s)", flush=True)
        
        print(f"STATUS:Starting transcription...", flush=True)
        # Transcribe
        segments, info = model.transcribe(audio_file, beam_size=5)
        
        print(f"STATUS:Processing segments...", flush=True)
        # Collect segments with timestamps
        transcript_text = ""
        segment_count = 0
        for segment in segments:
            start_time = segment.start
            end_time = segment.end
            # Format timestamps as [MM:SS.mmm]
            start_formatted = f"[{int(start_time//60):02d}:{start_time%60:06.3f}]"
            end_formatted = f"[{int(end_time//60):02d}:{end_time%60:06.3f}]"
            transcript_text += f"{start_formatted} {segment.text.strip()}\\n"
            segment_count += 1
            if segment_count % 10 == 0:  # Progress update every 10 segments
                print(f"STATUS:Processed {segment_count} segments...", flush=True)
        
        print(f"STATUS:Transcription complete!", flush=True)
        
        return {
            "success": True,
            "transcript": transcript_text.strip(),
            "language": info.language,
            "language_probability": info.language_probability,
            "device": device,
            "compute_type": compute_type,
            "model_size": model_size,
            "resolved_model_id": resolved_model_id,
            "resolved_model_path": resolved_model_path,
            "segment_count": segment_count
        }
        
    except Exception as e:
        error_msg = str(e)
        return {
            "success": False,
            "error": error_msg,
            "device": device,
            "compute_type": compute_type,
            "model_size": model_size,
            "resolved_model_id": resolved_model_id if 'resolved_model_id' in locals() else model_size,
            "resolved_model_path": resolved_model_path if 'resolved_model_path' in locals() else model_size
        }

def check_gpu_availability():
    """Check if GPU libraries are available"""
    # Debug: print what we're checking
    print("DEBUG:Checking GPU availability...", flush=True)
    
    # First try torch (most reliable)
    try:
        import torch
        print(f"DEBUG:torch imported, cuda available: {torch.cuda.is_available()}", flush=True)
        if torch.cuda.is_available():
            print("DEBUG:GPU available via torch.cuda", flush=True)
            return True
    except ImportError as e:
        print(f"DEBUG:torch not available: {e}", flush=True)
        pass
    
    # Then try CUDA libraries
    try:
        import nvidia.cublas
        import nvidia.cudnn
        print("DEBUG:CUDA libraries imported successfully", flush=True)
        # If we can import both, assume GPU is available
        # The actual transcription will fallback to CPU if GPU fails
        return True
    except ImportError as e:
        print(f"DEBUG:CUDA libraries not available: {e}", flush=True)
        return False

def save_transcription(transcript, audio_file, device, compute_type, language, confidence, model_size):
    """Save transcription to transcriptions folder"""
    try:
        # Get base filename without extension
        base_name = os.path.splitext(os.path.basename(audio_file))[0]
        
        # Create transcriptions directory if it doesn't exist
        transcriptions_dir = os.path.join(os.path.dirname(audio_file), "..", "transcriptions")
        os.makedirs(transcriptions_dir, exist_ok=True)
        
        # Create output file path
        output_file = os.path.join(transcriptions_dir, f"{base_name}.txt")
        
        # Create header with metadata
        header = f"""Transcription Results
Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
Source: {os.path.basename(audio_file)}
Device: {device.upper()}
Compute Type: {compute_type}
Model Size: {model_size}
Language: {language} ({confidence:.1%} confidence)

--- TRANSCRIPTION ---
"""
        
        # Write to file
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(header)
            f.write(transcript)
        
        return output_file
    except Exception as e:
        return None

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(json.dumps({"success": False, "error": "Usage: python transcribe.py <audio_file>"}))
        sys.exit(1)
    
    audio_file = sys.argv[1]
    if not os.path.exists(audio_file):
        print(json.dumps({"success": False, "error": f"Audio file not found: {audio_file}"}))
        sys.exit(1)
    
    # Check GPU availability first
    gpu_available = check_gpu_availability()
    
    # Try GPU first if available, otherwise use CPU
    # Use "medium" model for GPU, "base" model for CPU (better performance on CPU)
    if gpu_available:
        result = transcribe_audio(audio_file, model_size="medium", use_gpu=True)
        if not result["success"] and ("CUDA" in result["error"] or "cudnn" in result["error"].lower() or "cublas" in result["error"].lower()):
            # Fallback to CPU if GPU fails
            result = transcribe_audio(audio_file, model_size="base", use_gpu=False)
    else:
        # Use CPU directly with base model
        result = transcribe_audio(audio_file, model_size="base", use_gpu=False)
    
    # Save transcription if successful
    if result["success"]:
        output_file = save_transcription(
            result["transcript"], 
            audio_file, 
            result["device"], 
            result["compute_type"],
            result["language"],
            result["language_probability"],
            result["model_size"]
        )
        if output_file:
            result["output_file"] = output_file
    
    print(json.dumps(result))
`;

  writeFileSync(PYTHON_SCRIPT, pythonScript);
  log('✅ Python transcription script created', 'green');
}

async function verifyGPUInstallation() {
  log('🔍 Verifying GPU installation...', 'cyan');
  
  try {
    // Test GPU availability with Python
    const testScript = `
import sys
import os
try:
    # First check if CUDA libraries can be imported
    try:
        import nvidia.cublas
        import nvidia.cudnn
        print("CUDA_LIBS:available")
    except ImportError as lib_error:
        print("CUDA_LIBS:missing")
        print("CUDA_LIB_ERROR:" + str(lib_error))
    
    # Try to create a model with GPU
    from faster_whisper import WhisperModel
    import warnings
    warnings.filterwarnings("ignore")
    
    model = WhisperModel("base", device="cuda", compute_type="float16")
    print("GPU_AVAILABLE:true")
except Exception as e:
    error_msg = str(e)
    if "CUDA" in error_msg or "cudnn" in error_msg.lower() or "cublas" in error_msg.lower() or "dll" in error_msg.lower():
        print("GPU_AVAILABLE:false")
        print("GPU_ERROR:" + error_msg)
    else:
        print("GPU_AVAILABLE:unknown")
        print("GPU_ERROR:" + error_msg)
`;
    
    const pythonCmd = getPythonCommand();
    const result = execSync(`${pythonCmd} -c "${testScript}"`, { 
      encoding: 'utf8',
      cwd: __dirname,
      timeout: 30000 // 30 second timeout
    });
    
    const lines = result.trim().split('\n');
    const gpuAvailable = lines.find(line => line.startsWith('GPU_AVAILABLE:'))?.split(':')[1];
    const gpuError = lines.find(line => line.startsWith('GPU_ERROR:'))?.split(':').slice(1).join(':');
    const cudaLibs = lines.find(line => line.startsWith('CUDA_LIBS:'))?.split(':')[1];
    const cudaLibError = lines.find(line => line.startsWith('CUDA_LIB_ERROR:'))?.split(':').slice(1).join(':');
    
    if (cudaLibs === 'missing') {
      log('⚠️  CUDA libraries not properly accessible', 'yellow');
      if (cudaLibError) {
        log(`   Library Error: ${cudaLibError}`, 'yellow');
      }
    }
    
    if (gpuAvailable === 'true') {
      log('✅ GPU verification successful - CUDA acceleration available', 'green');
    } else if (gpuAvailable === 'false') {
      log('⚠️  GPU verification failed - falling back to CPU mode', 'yellow');
      if (gpuError) {
        log(`   Error: ${gpuError}`, 'yellow');
      }
      log('   This is normal if you don\'t have NVIDIA GPU or CUDA installed', 'yellow');
    } else {
      log('⚠️  GPU verification unclear - will attempt GPU with CPU fallback', 'yellow');
    }
    
  } catch (error) {
    log('⚠️  Could not verify GPU installation - will attempt GPU with CPU fallback', 'yellow');
    log('   This is normal if you don\'t have NVIDIA GPU or CUDA installed', 'yellow');
  }
}

async function transcribeFile() {
  log('\n📁 File Transcription Mode', 'cyan');
  
  // List available audio and video files
  const audioFiles = readdirSync(MEDIA_DIR).filter(file => 
    file.toLowerCase().endsWith('.mp3') || 
    file.toLowerCase().endsWith('.wav') || 
    file.toLowerCase().endsWith('.m4a') ||
    file.toLowerCase().endsWith('.flac') ||
    file.toLowerCase().endsWith('.ogg') ||
    file.toLowerCase().endsWith('.webm') ||
    file.toLowerCase().endsWith('.mp4') ||
    file.toLowerCase().endsWith('.mkv') ||
    file.toLowerCase().endsWith('.avi')
  );

  if (audioFiles.length === 0) {
    log('❌ No audio/video files found in media/ directory', 'red');
    log('   Supported formats: .mp3, .wav, .m4a, .flac, .ogg, .webm, .mp4, .mkv, .avi', 'yellow');
    return;
  }

  log('\nAvailable audio/video files:', 'bright');
  audioFiles.forEach((file, index) => {
    log(`   ${index + 1}. ${file}`, 'blue');
  });

  const choice = await question('\nEnter file number or filename: ');
  
  let selectedFile;
  if (/^\d+$/.test(choice.trim())) {
    const index = parseInt(choice) - 1;
    if (index >= 0 && index < audioFiles.length) {
      selectedFile = audioFiles[index];
    } else {
      log('❌ Invalid file number', 'red');
      return;
    }
  } else {
    if (audioFiles.includes(choice.trim())) {
      selectedFile = choice.trim();
    } else {
      log('❌ File not found', 'red');
      return;
    }
  }

  const filePath = path.join(MEDIA_DIR, selectedFile);
  log(`\n🎵 Transcribing: ${selectedFile}`, 'magenta');
  
  try {
    // Run transcription using Python script with progress tracking
    const startTime = Date.now();
    
    // Create a promise that resolves with the transcription result
    const transcriptionPromise = new Promise((resolve, reject) => {
      let output = '';
      let errorOutput = '';
      
      // Use resolved Python path
      const pythonCmd = getPythonCommand();
      const pythonExe = pythonCmd.replace(/^"|"$/g, ''); // Remove quotes for spawn
      
      const pythonProcess = spawn(pythonExe, [PYTHON_SCRIPT, filePath], {
        cwd: __dirname,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env  // CRITICAL: Pass environment variables including PATH and CUDA paths
      });
      
      let shownLoadingModel = false;
      let shownTranscribing = false;
      pythonProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            if (line.startsWith('STATUS:')) {
              const status = line.substring(7);
              if (!shownLoadingModel && (status.startsWith('Loading Whisper') || status.startsWith('Checking cache'))) {
                log('   ⏳ Loading model...', 'cyan');
                shownLoadingModel = true;
              } else if (!shownTranscribing && (status.startsWith('Starting transcription') || status.startsWith('Processing segments'))) {
                log('   🎙️  Transcribing...', 'cyan');
                shownTranscribing = true;
              } else {
                debug(`STATUS: ${status}`);
              }
            } else if (line.startsWith('DEBUG:')) {
              debug(line.substring(6), 'yellow');
            } else if (line.startsWith('{')) {
              output += line;
            }
          }
        }
      });
      
      pythonProcess.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });
      
      pythonProcess.on('close', (code) => {
        if (code === 0) {
          try {
            const result = JSON.parse(output.trim());
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse transcription result'));
          }
        } else {
          reject(new Error(`Python process exited with code ${code}: ${errorOutput}`));
        }
      });
    });
    
    const transcriptionResult = await transcriptionPromise;
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    
    if (transcriptionResult.success) {
      const deviceLabel = transcriptionResult.device === 'cuda' ? 'GPU' : 'CPU';
      const langInfo = `${transcriptionResult.language} ${(transcriptionResult.language_probability * 100).toFixed(0)}%`;
      const outFile = transcriptionResult.output_file ? path.basename(transcriptionResult.output_file) : selectedFile;
      const absPath = transcriptionResult.output_file || path.join(TRANSCRIPTIONS_DIR, outFile);
      const fileUrl = `file:///${absPath.replace(/\\/g, '/')}`;
      const clickable = `\x1b]8;;${fileUrl}\x1b\\transcriptions/${outFile}\x1b]8;;\x1b\\`;
      log(`\n✅  Done → ${clickable}  (${duration}s · ${deviceLabel} · ${langInfo})`, 'green');

      debug(`Language: ${transcriptionResult.language} (${(transcriptionResult.language_probability * 100).toFixed(1)}% confidence)`);
      debug(`Device: ${transcriptionResult.device.toUpperCase()}`, transcriptionResult.device === 'cuda' ? 'green' : 'yellow');
      debug(`Model: ${transcriptionResult.model_size} · compute: ${transcriptionResult.compute_type}`);
      if (transcriptionResult.resolved_model_id) debug(`Model source: ${transcriptionResult.resolved_model_id}`);
      if (transcriptionResult.resolved_model_path) debug(`Model path: ${transcriptionResult.resolved_model_path}`);
      debug(`Segments: ${transcriptionResult.segment_count || 'N/A'} · time: ${duration}s`);
      
    } else {
      log('❌ Transcription failed:', 'red');
      log(transcriptionResult.error, 'red');
    }
    
  } catch (error) {
    log('❌ Transcription failed:', 'red');
    log(error.message, 'red');
    log('   Make sure Python and faster-whisper are properly installed', 'yellow');
  }
}

async function startRelayServer() {
  log('\n🌐  Relay server → http://localhost:8787', 'cyan');
  log('    Play a lecture in your browser.  Ctrl+C to stop.', 'yellow');
  
  // Pass the validated Python path so relay uses the same interpreter (avoids PyManager/other PATH Pythons)
  const config = loadConfig();
  const pythonPath = RESOLVED_PYTHON_PATH || config.PYTHON_PATH;
  const relayEnv = { ...process.env };
  if (pythonPath && existsSync(pythonPath)) {
    relayEnv.MP3GRABBER_PYTHON_PATH = pythonPath;
    debug(`Python for transcription: ${pythonPath}`);
  }
  if (DEBUG) {
    relayEnv.LOCALSTREAM_DEBUG = '1';
  }
  
  let stderrOutput = '';
  let hasModuleError = false;
  const relayProcess = spawn('node', ['relay.js'], {
    stdio: ['inherit', 'inherit', 'pipe'],
    cwd: __dirname,
    env: relayEnv
  });

  // Capture stderr to detect module errors while still showing output
  relayProcess.stderr.on('data', (data) => {
    const output = data.toString();
    stderrOutput += output;
    
    // Check for the specific debug module error
    if ((output.includes("Cannot find module './debug'") || 
         (output.includes("Cannot find module") && output.includes('debug'))) && !hasModuleError) {
      hasModuleError = true;
      // Show the error first
      process.stderr.write(data);
      // Then show helpful message
      setTimeout(() => {
        log('\n❌ Module dependency error detected!', 'red');
        log('   This usually happens when node_modules is corrupted.', 'yellow');
        log('   Fix it by running:', 'cyan');
        log('   npm run fix', 'bright');
        log('   Or manually: rm -rf node_modules package-lock.json && npm install', 'cyan');
      }, 100);
    } else {
      // Forward all stderr to console
      process.stderr.write(data);
    }
  });

  relayProcess.on('error', (error) => {
    log('❌ Failed to start relay server:', 'red');
    log(error.message, 'red');
    
    // Check if it's a module error
    if (error.message.includes('Cannot find module') || stderrOutput.includes('Cannot find module')) {
      log('\n💡 This looks like a dependency issue. Try:', 'yellow');
      log('   npm run fix', 'cyan');
    }
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    log('\n\n🛑 Shutting down relay server...', 'yellow');
    relayProcess.kill();
    rl.close();
    process.exit(0);
  });

  // Wait for the relay process to exit
  return new Promise((resolve) => {
    relayProcess.on('exit', (code) => {
      log(`\n🛑 Relay server exited with code ${code}`, 'yellow');
      rl.close();
      process.exit(code);
    });
  });
}

async function main() {
  log('LocalStream – Private Lecture Transcriber', 'bright');
  log('==========================================', 'bright');

  // Check for force reinstall flag
  const forceReinstall = process.argv.includes('-i') || process.argv.includes('--install');
  
  if (forceReinstall) {
    log('🔄 Force reinstall mode enabled', 'yellow');
  }

  // Show first-run message before setup begins
  const setupConfig = loadConfig();
  if (!setupConfig.installCompleted || forceReinstall) {
    log('⚙️  First-time setup — this may take a few minutes...', 'yellow');
  }

  // Check prerequisites
  const prerequisitesResult = await checkPrerequisites(forceReinstall);
  if (!prerequisitesResult.success) {
    log('\n❌ Prerequisites check failed. Please fix the issues above.', 'red');
    rl.close();
    process.exit(1);
  }

  // Compact ready line
  const gpuStatus = prerequisitesResult.gpuStatus;
  const deviceLabel = gpuStatus.available ? 'GPU (CUDA)' : 'CPU';
  const modelLabel = gpuStatus.available ? 'medium model' : 'base model';
  log(`\n✅  Ready  ·  ${deviceLabel}  ·  ${modelLabel}`, 'green');
  debug(`Processing device: ${gpuStatus.type}`, gpuStatus.color);
  if (gpuStatus.modelSource) debug(`Model source: ${gpuStatus.modelSource}`);
  if (gpuStatus.modelPath) debug(`Model path: ${gpuStatus.modelPath}`);

  // Main menu
  while (true) {
    log('\n' + '='.repeat(50), 'bright');
    log('  1  Transcribe a file     (media/ folder)', 'blue');
    log('  2  Browser extension     (Canvas · Panopto · YouTube)', 'blue');
    log('  3  Exit', 'blue');
    
    const choice = await question('\nEnter your choice (1-3): ');
    
    switch (choice.trim()) {
      case '1':
        await transcribeFile();
        break;
      case '2':
        await startRelayServer();
        break;
      case '3':
        log('\n👋 Goodbye!', 'green');
        rl.close();
        process.exit(0);
        break;
      default:
        log('❌ Invalid choice. Please enter 1, 2, or 3.', 'red');
    }
  }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  log('❌ Uncaught Exception:', 'red');
  log(error.message, 'red');
  rl.close();
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('❌ Unhandled Rejection:', 'red');
  log(reason, 'red');
  rl.close();
  process.exit(1);
});

// Start the application
main().catch((error) => {
  log('❌ Application error:', 'red');
  log(error.message, 'red');
  rl.close();
  process.exit(1);
});
