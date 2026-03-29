# LocalStream – Private Lecture Transcriber

<p align="center">
  <strong>Turn Canvas, Panopto, and YouTube-style lectures into searchable notes—on your own laptop.</strong><br/>
  <sub>Open source · 100% local · No cloud transcription</sub>
</p>

<p align="center">
  <a href="https://github.com/appsdothingsiguess/LocalStream-Transcriber/releases/latest"><img src="https://img.shields.io/github/v/release/appsdothingsiguess/LocalStream-Transcriber?label=Download&logo=github" alt="Latest release"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"/></a>
  <a href="https://github.com/appsdothingsiguess/LocalStream-Transcriber"><img src="https://img.shields.io/badge/repo-LocalStream--Transcriber-24292f?logo=github" alt="Repository"/></a>
</p>

---

| | |
|:---|:---|
| **Repository** | **[LocalStream-Transcriber](https://github.com/appsdothingsiguess/LocalStream-Transcriber)** on GitHub |
| **Also known as** | **MP3 Grabber** (`mp3grabber` in `package.json`) — same app, one repo |

---

## Technical overview

The app uses **[faster-whisper](https://github.com/SYSTRAN/faster-whisper)** (OpenAI Whisper, optimized) for speech-to-text, with optional NVIDIA GPU acceleration.

- 🎯 **Local & web-based transcription** — process files from disk or capture from web pages
- 🌊 **HLS/DASH stream support** — automatically detects and downloads `.m3u8` and `.mpd` streams
- 🔐 **Authenticated content** — captures session cookies for Canvas, Kaltura, Panopto
- ⚡ **GPU acceleration** — 4× faster with NVIDIA CUDA; automatic CPU fallback
- 🌐 **Browser extension** — Chrome extension (Manifest V3) with passive network interception
- 📊 **Real-time progress** — live WebSocket updates at `http://localhost:8787`
- 🔒 **100% local** — all processing happens on your machine
- 🎬 **Multi-format** — audio (MP3, M4A, WAV, FLAC, OGG, WebM) and video (MP4, MKV, AVI)
- 📝 **Timestamped output** — `[MM:SS.mmm]` format with language and confidence metadata

---

## Table of contents

1. [Start here (students)](#start-here-students)
2. [Quick start (Windows)](#quick-start-windows)
3. [Downloads and releases](#downloads-and-releases)
4. [How it works](#how-it-works)
5. [Configuration](#configuration)
6. [Supported formats](#supported-audio--video-formats)
7. [Architecture & file structure](#architecture--file-structure)
8. [Troubleshooting](#troubleshooting)
9. [Output format](#transcription-output-format)
10. [Dependencies](#dependencies)
11. [Manual commands](#manual-commands-advanced)
12. [Security & privacy](#security--privacy)
13. [License](#license)

---

## Start here (students)

LocalStream turns lecture audio and video into **searchable text on your computer**—so you can skim, search, and study without rewatching whole recordings.

| | |
|:---|:---|
| **Platforms** | Canvas · Panopto · Kaltura · YouTube-style pages |
| **School login** | Works with **logged-in** streams (e.g. Canvas) |
| **Privacy** | **100% local** — no audio sent to external servers for transcription |
| **Speed** | **GPU** faster if available; **CPU** works too (often slower) |

**Who it's for:** college and grad students who want **private, searchable lecture notes** without being developers.

**Two ways to use it:**

- **Option 1 – Files you have:** Put audio/video in the **`media/`** folder and run the app.
- **Option 2 – Live browser streams:** Use a small **Chrome add-on** + a local helper to capture Canvas / Panopto / YouTube pages you are already signed into.

Results land in **`transcriptions/`** as plain `.txt` files with timestamps like `[00:01.234]`.

---

## Quick start (Windows)

**Install once:** [Node.js (LTS)](https://nodejs.org/) and [Python 3.10–3.12](https://www.python.org/downloads/) — during Python setup on Windows, check **"Add python.exe to PATH"**.

### Option 1 — Transcribe a file you already have

| Step | What to do |
|:---:|:---|
| 1 | **Get the app:** [Latest release ZIP](https://github.com/appsdothingsiguess/LocalStream-Transcriber/releases/latest) or **Code → Download ZIP** on GitHub, then unzip (e.g. `Documents\LocalStream-Transcriber`). |
| 2 | **Run it:** Double-click **`START.bat`**. *(Fallback: open Command Prompt in the folder and type `npm run setup`.)* The first run installs speech tools — this can take a few minutes. |
| 3 | **Set your model** (before transcribing — see [Choosing your Whisper model](#choosing-your-whisper-model) below). |
| 4 | **Drop your file:** Put your audio/video (`.mp3`, `.mp4`, `.m4a`, etc.) in the **`media/`** folder. |
| 5 | **Pick option 1** in the menu, then select your file from the list. |
| 6 | **Get your transcript:** Find the `.txt` file in **`transcriptions/`** when it finishes. |

> **No dedicated GPU?** CPU works fine; it will just take longer.

---

### Option 2 — Capture a live Canvas / Panopto / YouTube lecture

This mode runs a local server that your browser sends streams to. Two parts: **one-time extension setup**, then **per-lecture usage**.

#### Part A — One-time setup

| Step | What to do |
|:---:|:---|
| 1 | **Get the app and run it:** Same as steps 1–2 above. |
| 2 | **Pick option 2** in the menu. This starts the local relay server. Leave this window open — it must stay running while you transcribe. |
| 3 | **Load the Chrome extension:** Open a new tab and go to `chrome://extensions/`. Turn on **Developer mode** (top-right toggle). Click **Load unpacked** and select the **`extension/`** folder inside the project. |
| 4 | **Pin the extension:** Click the puzzle-piece icon in Chrome's toolbar → click the pin icon next to **MP3 Sniper** so it shows in your toolbar permanently. |

#### Part B — Transcribing a lecture (every time)

| Step | What to do |
|:---:|:---|
| 1 | Make sure **`START.bat`** is already running with option 2 (the relay server). |
| 2 | Open your lecture page in Chrome (Canvas, Panopto, YouTube, etc.) and **start playing the video** — even a second or two is enough for the extension to detect the stream. |
| 3 | Click the **MP3 Sniper extension icon** in your Chrome toolbar (the 🎵 icon). A small popup appears. |
| 4 | Click **"Queue All Videos"** (green button). The extension sends the stream to the local relay for download and transcription. |
| 5 | Open **`http://localhost:8787`** in a new tab to watch live progress. |
| 6 | When done, your transcript is saved under **`transcriptions/`** as a `.txt` file with timestamps like `[00:01.234]`. |

> **Canvas specifically:** If "Queue All Videos" doesn't pick up the lecture, try the blue **"Select 1 Video (Canvas)"** button instead — it targets the video element directly.
>
> **Keyboard shortcut:** Press **`Ctrl+Shift+M`** anywhere on the page as an alternative to clicking the popup.
>
> **Privacy:** All speech-to-text runs on your laptop — nothing is uploaded.

### Choosing your Whisper model

The app auto-selects a model based on whether a GPU is detected, but you can change it.

Open **`transcribe.py`** and find the section around **line 221**:

```python
# Use "medium" model for GPU, "base" model for CPU
if gpu_available:
    result = transcribe_audio(audio_file, model_size="medium", use_gpu=True)
    ...
else:
    result = transcribe_audio(audio_file, model_size="base", use_gpu=False)
```

| Model | Best for | Notes |
|:---|:---|:---|
| `tiny` | Very slow CPU, quick tests | Least accurate |
| `base` | **CPU default** | Good balance of speed and accuracy on CPU |
| `small` | Mid-range CPU or light GPU | Better accuracy, slower on CPU |
| `medium` | **GPU default** | High accuracy; needs ~3 GB VRAM |
| `large` | High-end GPU | Highest accuracy, very slow on CPU |

**CPU-only laptop?** Keep `base` (the default). If you want higher accuracy and have time to spare, change `"base"` to `"small"` in the `else` branch.

**NVIDIA GPU?** `medium` is the default. If you get GPU memory errors, drop to `"small"` or add `compute_type="int8"` (edit the `compute_type` line in `transcribe_audio`).

---

## Downloads and releases

There is **no Windows installer** yet — releases are **"download ZIP + first-run setup"** using **`START.bat`** and **`npm run setup`**.

### What goes in a release ZIP

| Include | Why |
|:---|:---|
| **Full project** | `start.js`, `relay.js`, `transcribe.py`, `package.json`, `requirements.txt`, **`extension/`**, **`START.bat`**, empty `media/` and `transcriptions/` |
| **No `node_modules/`** | Paths and binaries differ per machine — `npm run setup` installs them on the user's PC |
| **Optional `INSTALL.txt`** | "Install Node + Python → unzip → double-click `START.bat` → option 1 or 2" |

### For users: install from a release

1. Open **[Releases](https://github.com/appsdothingsiguess/LocalStream-Transcriber/releases)** → download the **latest** source ZIP.
2. Unzip anywhere (e.g. `Documents\LocalStream-Transcriber`).
3. Install **Node.js** and **Python** if needed (see [Quick start](#quick-start-windows)).
4. Double-click **`START.bat`** (or run `npm run setup`).
5. Choose **option 1** or **option 2** — transcripts appear in **`transcriptions/`**.

### For maintainers: how to publish a release

**GitHub UI (simplest)**

1. Push changes to `main`.
2. **Releases → Create a new release**.
3. **Choose a tag** → type e.g. `v1.0.2` → **Create new tag on publish**, target `main`.
4. Add a title and release notes, then **Publish release**. GitHub auto-attaches source ZIPs.

**Via git tag**

```bash
git tag -a v1.0.2 -m "Release v1.0.2: short description"
git push origin v1.0.2
```

Then open **Releases → Draft a new release**, select the tag, add notes, publish.

> **Tip:** Bump `version` in `package.json` to match the tag (e.g. `1.0.2` with tag `v1.0.2`).

---

## How it works

### Option 1 — File transcription

1. Place audio/video files in **`media/`**.
2. Run `npm run setup` → select **option 1**.
3. Choose a file from the list.
4. Watch real-time progress (GPU/CPU status shown).
5. Transcript saved to **`transcriptions/`** with metadata (device, language, confidence).

### Option 2 — Browser extension (Canvas / Panopto / YouTube)

1. Run `npm run setup` → select **option 2** to start the relay server.
2. Load the extension in Chrome: `chrome://extensions/` → **Developer mode** → **Load unpacked** → `extension/` folder.
3. Navigate to your lecture page (already signed in). Streams are captured automatically when the page requests them.
4. Optional: press **`Ctrl+Shift+M`** to verify the connection.
5. Watch progress at **`http://localhost:8787`**; transcripts appear in **`transcriptions/`**.

**Supported platforms:**

- ✅ Canvas LMS
- ✅ Kaltura
- ✅ Panopto
- ✅ AWS CloudFront signed URLs
- ✅ YouTube (HLS streams)
- ✅ Any platform using HLS/DASH protocols
- ✅ Direct audio/video file links

**Extension limitations:**

- ❌ **DRM-protected content** — Widevine encryption cannot be bypassed (Netflix, Disney+, etc.)
- ⚠️ **Cookie expiration** — very long downloads may expire session cookies
- ⚠️ **Network detection** — page must actively request `.m3u8` or `.mpd` files

---

## Configuration

### Whisper model size (`transcribe.py`)

See [Choosing your Whisper model](#choosing-your-whisper-model) in Quick start for the full table. In short: edit the `model_size` strings at **line ~221** of `transcribe.py`.

### Server port

Edit **`relay.js` line 15** and **`extension/bg.js` line 1** to change the port from the default `8787`.

### GPU memory errors

In `transcribe_audio()` in `transcribe.py`, change `compute_type="float16"` to `compute_type="int8"` to reduce VRAM usage.

---

## Supported audio & video formats

**Audio:** `.mp3` · `.wav` · `.m4a` · `.flac` · `.ogg` · `.webm`

**Video (audio track extracted automatically):** `.mp4` · `.mkv` · `.avi`

---

## Architecture & file structure

```
mp3grabber/
├── media/                    # Place your audio/video files here
├── transcriptions/           # All transcription results saved here
├── uploads/                  # Temporary files from browser extension
├── downloads/                # Temporary cookie files for yt-dlp
├── extension/
│   ├── manifest.json         # Extension configuration (Manifest V3)
│   ├── bg.js                 # Background service worker
│   └── README.md
├── whisper-bin/              # Whisper model cache (auto-created)
├── config.json               # Installation state tracking
├── package.json
├── requirements.txt
├── start.js                  # Interactive setup and menu
├── relay.js                  # Express + WebSocket server
├── transcribe.py             # Python transcription script (faster-whisper)
├── viewer.html               # Real-time web UI at localhost:8787
├── START.bat                 # Windows launcher
└── README.md
```

**Data flow:**

1. **File mode:** `media/` → `start.js` → `transcribe.py` → `transcriptions/`
2. **Extension mode:** `webpage` → `extension` → WebSocket → `relay.js` → `yt-dlp` → `transcribe.py` → `transcriptions/`

**Stack:** Node.js (Express + WebSocket), Python (faster-whisper), yt-dlp, Chrome Extension (Manifest V3), NVIDIA CUDA (optional).

---

## Troubleshooting

### Debug mode

If something isn't working and you need to see what the app is doing internally, run:

```bash
npm run setup:debug
```

This shows all hidden log lines prefixed with `[DBG]` — Python paths, GPU test details, queue internals, raw yt-dlp output, and more. Share this output when reporting issues.

**Normal output** (no flag) shows only what students need:
```
✅  Ready  ·  GPU (CUDA)  ·  medium model
📡  Stream detected  (1_9i988two)
⬇️   Downloading...
🎙️   Transcribing...
✅  Done → transcriptions/1_9i988two.txt
```

**`⏭️ Duplicate ignored`** means the extension sent the same stream twice — this is normal. The first copy is still downloading/transcribing.

---

### Common issues

**"Python not found"**
- Install Python 3.10–3.12 from [python.org](https://python.org/) and check **"Add Python to PATH"** during install.

**"Node.js not found"**
- Install Node.js 14+ from [nodejs.org](https://nodejs.org/). Verify with `node --version`.

**"yt-dlp not found"**
```bash
pip install yt-dlp
# or force reinstall everything:
npm run setup:install
```

**"No audio files found"**
- Place files in the **`media/`** folder. Supported: `.mp3 .wav .m4a .flac .ogg .webm .mp4 .mkv .avi`

**"GPU not working"**
- Install NVIDIA drivers from [nvidia.com](https://nvidia.com) and CUDA Toolkit 12.x from [NVIDIA CUDA Downloads](https://developer.nvidia.com/cuda-downloads).
- The app falls back to CPU automatically — CPU is 2–4× slower but equally accurate.

**"Transcription takes too long"**
- On CPU: switch to `"small"` or keep `"base"` model in `transcribe.py`. Close other heavy apps.
- On GPU: ensure CUDA is installed. Consider `compute_type="int8"` if memory is limited.

**"WebSocket connection failed"**
- Make sure the relay server is running (`npm run setup` → option 2).
- Check that port `8787` is not blocked by a firewall or used by another app.
- Reload the extension in `chrome://extensions/` and try restarting the server.

**"No streams detected"**
- Open Chrome DevTools → Network tab → filter by `.m3u8` or `.mpd`. If nothing appears, the page is not using HLS/DASH.
- Try loading a direct file URL instead.

**"Download succeeded but file not found"**
- Check `uploads/` for UUID-prefixed files; verify yt-dlp completed (check relay server logs).

**"Cannot find module './debug'" / "Module not found"**

Quick fix:
```bash
npm run fix
```

Manual fix:
```bash
# Windows PowerShell:
Remove-Item -Recurse -Force node_modules, package-lock.json
npm cache clean --force
npm install
```

> Never copy `node_modules/` between machines — always run `npm install` in the new location.

### Migrating from v0.3

See [`MIGRATION_GUIDE.md`](MIGRATION_GUIDE.md) for architecture changes, breaking changes, and rollback instructions.

### Performance tips

- **GPU:** CUDA + `medium` model = ~4× faster than CPU.
- **CPU:** Use `base` (default) or `small` for a speed/accuracy trade-off.
- **RAM:** 4 GB minimum; 8 GB+ recommended for GPU mode.
- **Files:** Files under 10 minutes process noticeably faster.

---

## Transcription output format

```
Transcription Results
Generated: 2024-10-26 15:39:48
Source: lecture.mp4
Device: GPU
Compute Type: float16
Model Size: medium
Language: en (99.8% confidence)

--- TRANSCRIPTION ---
[00:00.000] Welcome to the lecture.
[00:05.230] Today we are covering...
[00:10.450] Each segment includes precise timing.
```

---

## Dependencies

### Node.js

| Package | Version | Purpose |
|:---|:---|:---|
| `express` | ^4.19.2 | HTTP server |
| `ws` | ^8.17.0 | WebSocket |
| `node-fetch` | ^3.3.2 | HTTP client |
| `uuid` | ^9.0.1 | Unique IDs |

### Python

- `faster-whisper` — speech-to-text engine
- `yt-dlp` — HLS/DASH stream downloader
- `nvidia-cublas-cu12` *(optional)* — CUDA support
- `nvidia-cudnn-cu12==9.*` *(optional)* — CUDA support

All installed automatically via `npm run setup`, or manually: `pip install -r requirements.txt`.

---

## Manual commands (advanced)

```bash
# Install Node.js dependencies
npm install

# Install Python dependencies
pip install -r requirements.txt

# GPU libraries (NVIDIA only)
pip install nvidia-cublas-cu12 nvidia-cudnn-cu12==9.*

# Run setup menu
npm run setup

# Start relay server only (extension mode)
npm start         # or: node relay.js

# Force reinstall everything
npm run setup:install

# Transcribe a file directly (outputs JSON)
python transcribe.py path/to/audio.mp3
```

---

## Security & privacy

- ✅ **100% local processing** — no data sent to external servers for transcription
- ✅ **No telemetry** — no usage tracking or analytics
- ✅ **Temporary file cleanup** — extension downloads deleted after processing
- ✅ **Open source** — inspect all code in this repo
- ⚠️ **Network** — the browser extension communicates with a **local** WebSocket server only (`localhost:8787`)

---

## Contributing

Open for contributions. Key areas:
- Additional language support and model tuning
- Better YouTube integration (within legal/technical limits)
- UI/UX improvements for the web viewer
- Performance optimizations

## Known limitations

1. **DRM content** — Netflix, Disney+, and similar services use Widevine DRM; this tool cannot bypass it.
2. **Cookie expiration** — very long downloads on authenticated streams may fail if cookies expire.
3. **HLS/DASH only** — the browser extension only detects `.m3u8` and `.mpd` requests; plain `<video>` src tags require direct file links.
4. **Large files** — files over 2 hours require significant processing time and memory.
5. **GPU memory** — large models on consumer GPUs may need `compute_type="int8"`.

## License

This project's **code** is licensed under the [MIT License](LICENSE).

When you run transcription, you also use third-party **models and libraries** (e.g. Whisper / faster-whisper). Please comply with their licenses and with **laws in your jurisdiction** about recording and transcribing lectures or other audio.

## Acknowledgments

- **[faster-whisper](https://github.com/SYSTRAN/faster-whisper)** by SYSTRAN — high-performance Whisper implementation
- **[OpenAI Whisper](https://github.com/openai/whisper)** — original speech recognition model
- **NVIDIA CUDA** — GPU acceleration framework
