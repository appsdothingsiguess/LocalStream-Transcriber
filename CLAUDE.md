# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**LocalStream** is a local lecture transcriber that converts audio/video (Canvas, Panopto, Kaltura, YouTube, HLS/DASH streams) into timestamped text transcripts using OpenAI's Whisper model via `faster-whisper`. All processing happens on the user's machine.

## Commands

```bash
npm run setup              # Main interactive setup menu (file or extension mode)
npm run setup:debug        # Setup with debug logging enabled
npm run setup:cpu          # Force CPU-only mode
npm run setup:install      # Force reinstall all Python/Node dependencies
npm run start              # Start relay server only (skips setup menu)
npm run fix                # Fix corrupted node_modules
```

`START.bat` is a Windows launcher that runs `npm run setup`.

There are no automated tests.

## Architecture

Three components work together:

**1. `src/start.js` — CLI setup menu**
- Interactive Node.js menu for first-time setup and file transcription (Option 1)
- Handles Python path detection and locking, GPU capability testing, prerequisite validation, and Whisper model selection
- Resolves Python executable via a fallback chain (`python → py → python3`), validates that `faster_whisper` is importable, then stores the resolved path in `config.json`
- Auto-generates `src/transcribe.py` on startup from an embedded template (to keep it always up-to-date)

**2. `src/relay.js` — WebSocket relay server (port 8787)**
- Express HTTP + WebSocket server; serves `src/viewer.html` at `http://localhost:8787`
- Receives stream URLs and cookies from the Chrome extension over WebSocket
- Manages a `JobQueue` with deduplication (by Kaltura `entryId` or full URL) to prevent double-processing
- Spawns `yt-dlp` as a child process to download HLS/DASH streams; passes session cookies for authenticated content
- Spawns `transcribe.py` as a child process after download; parses its JSON stdout for progress and results
- Sends real-time progress updates back to the extension via WebSocket

**3. `src/transcribe.py` — Whisper transcription engine**
- Loads a `faster-whisper` model (tiny/base/small/medium/large) with CUDA GPU acceleration if available, falling back to CPU
- Outputs newline-delimited JSON to stdout so relay.js can parse live progress
- Model files are cached in `whisper-bin/` (excluded from git)

**4. `extension/bg.js` — Chrome extension (Manifest V3 service worker)**
- Passively monitors all network requests for `.m3u8` and `.mpd` URLs
- Stream priority system: master manifests (100) > index (90) > regular m3u8 (50); filters subtitle/key/image URLs
- 5-second debounce window per page to avoid spam
- Extracts session cookies and posts `{ url, cookies, tabId }` to relay.js over WebSocket (auto-reconnects)

## Key Data Flow

**File Mode:** `media/` folder → `start.js` prompts user → spawns `transcribe.py` directly → saves to `transcriptions/`

**Extension Mode:** Browser detects stream → `bg.js` sends URL+cookies over WebSocket → `relay.js` queues job → spawns `yt-dlp` (download to `uploads/`) → spawns `transcribe.py` → saves to `transcriptions/`

## Configuration

`config.json` (gitignored, auto-created) stores:
- `pythonPath` — locked Python executable path
- `modelSize` — selected Whisper model (tiny/base/small/medium/large)
- `installComplete` — prevents re-running full install on subsequent launches

## Important Behaviors

- **`transcribe.py` is always regenerated on startup** from an embedded template in `start.js` — do not treat the file as the source of truth; edit the template inside `start.js`.
- GPU mode uses `medium` model by default; CPU mode uses `base` to keep transcription time reasonable.
- CUDA errors in `transcribe.py` trigger an automatic CPU fallback in `relay.js`.
- Debug mode (`DEBUG=true` env var) is handled in `src/logger.js` and gates verbose logging throughout the app.
