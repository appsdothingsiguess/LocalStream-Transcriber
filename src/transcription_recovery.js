import { existsSync, readFileSync, readdirSync, statSync, appendFileSync, mkdirSync } from 'fs';
import path from 'path';

export const WIN_SHUTDOWN_CRASH = 3221226505; // 0xC0000409
export const WIN_ACCESS_VIOLATION = 3221225477; // 0xC0000005

export function sidecarPathFor(audioFile) {
  const base = path.basename(audioFile, path.extname(audioFile));
  return path.join(path.dirname(audioFile), `${base}.transcribe_result.json`);
}

export function progressSidecarPathFor(audioFile) {
  const base = path.basename(audioFile, path.extname(audioFile));
  return path.join(path.dirname(audioFile), `${base}.transcribe_progress.json`);
}

export function parseResultJsonFromStdout(stdoutBuffer) {
  const prefix = 'RESULT_JSON:';
  const idx = stdoutBuffer.indexOf(prefix);
  if (idx === -1) return null;
  const jsonStart = idx + prefix.length;
  let lineEnd = stdoutBuffer.indexOf('\n', jsonStart);
  if (lineEnd === -1) lineEnd = stdoutBuffer.length;
  try {
    return JSON.parse(stdoutBuffer.substring(jsonStart, lineEnd).replace(/\r$/, ''));
  } catch {
    return null;
  }
}

export function readTranscriptBodyFromFile(outputFile) {
  if (!outputFile || !existsSync(outputFile)) return null;
  const content = readFileSync(outputFile, 'utf8');
  const marker = '--- TRANSCRIPTION ---';
  const markerIdx = content.indexOf(marker);
  if (markerIdx === -1) return content.trim();
  const body = content.slice(markerIdx + marker.length).trim();
  if (!body || body === '(in progress — segments stream below as they complete)') return null;
  return body;
}

export function hydrateTranscriptionResult(parsed) {
  if (!parsed?.success) return null;
  if (parsed.transcript) return parsed;
  if (parsed.output_file) {
    const transcript = readTranscriptBodyFromFile(parsed.output_file);
    if (transcript) return { ...parsed, transcript };
  }
  return null;
}

export function findTranscriptFileForMedia(filePath, transcriptionsDir) {
  if (!transcriptionsDir || !existsSync(transcriptionsDir)) return null;

  const baseName = path.basename(filePath, path.extname(filePath));
  const exact = path.join(transcriptionsDir, `${baseName}.txt`);
  if (existsSync(exact)) return exact;

  let candidates = [];
  try {
    candidates = readdirSync(transcriptionsDir)
      .filter((name) => name.startsWith(baseName) && name.endsWith('.txt'))
      .map((name) => {
        const full = path.join(transcriptionsDir, name);
        return { full, mtime: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return null;
  }

  return candidates[0]?.full ?? null;
}

export function recoverTranscriptionAfterCrash(filePath, stdoutBuffer, transcriptionsDir) {
  const fromStdout = hydrateTranscriptionResult(parseResultJsonFromStdout(stdoutBuffer));
  if (fromStdout) return { ...fromStdout, recovered: true };

  // Collect metadata from any sidecar that has device/language, even if the
  // transcript body can't be read through hydrateTranscriptionResult yet.
  let sidecarMeta = null;
  for (const sidecarPath of [
    sidecarPathFor(filePath),
    progressSidecarPathFor(filePath),
  ]) {
    if (!existsSync(sidecarPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(sidecarPath, 'utf8'));
      if (!raw?.success) continue;
      const hydrated = hydrateTranscriptionResult(raw);
      if (hydrated) return { ...hydrated, recovered: true };
      // hydrateTranscriptionResult returned null (transcript body was empty/missing
      // at read time), but the sidecar still has device/language metadata — keep it.
      if (raw.device || raw.language) sidecarMeta = raw;
    } catch {
      // try next artifact
    }
  }

  const transcriptFile =
    findTranscriptFileForMedia(filePath, transcriptionsDir) ??
    (() => {
      const baseName = path.basename(filePath, path.extname(filePath));
      return path.join(transcriptionsDir, `${baseName}.txt`);
    })();

  const transcript = readTranscriptBodyFromFile(transcriptFile);
  if (transcript) {
    return {
      success: true,
      // Merge sidecar metadata (device, language, etc.) so the success line
      // shows the correct device and detected language even after a crash recovery.
      ...sidecarMeta,
      transcript,
      output_file: transcriptFile,
      recovered: true,
    };
  }

  return null;
}

export function appendTranscriptionLog(transcriptionsDir, message) {
  if (!transcriptionsDir) return;
  try {
    mkdirSync(transcriptionsDir, { recursive: true });
    const logPath = path.join(transcriptionsDir, 'transcriptions.log');
    const stamp = new Date().toISOString();
    appendFileSync(logPath, `[${stamp}] ${message}\n`, 'utf8');
  } catch {
    // non-fatal
  }
}
