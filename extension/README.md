# MP3 Sniper - Chrome Extension

## Overview

A Chrome extension that uses **network sniffing** to detect and capture streaming media (HLS/DASH) from web pages, including authenticated content from Canvas, Kaltura, and Panopto.

## Architecture

### v0.4: Network Sniffing (Current)

**Detection Method**: Passive network interception using `chrome.webRequest` API

**How it works:**
1. Extension monitors all network requests in background
2. Detects `.m3u8` (HLS) and `.mpd` (DASH) manifest requests
3. Extracts session cookies for the domain
4. Stores the best captured stream candidate locally in the extension
5. Sends stream URL + cookies to the local relay server only when you explicitly queue it
6. Relay server uses `yt-dlp` to download and transcribe

**Key Features:**
- ✅ Automatic detection without automatic queueing
- ✅ Handles authenticated content (session cookies)
- ✅ Supports HLS and DASH streaming protocols
- ✅ Works with any domain (`<all_urls>` permission)
- ✅ Canonical deduplication prevents duplicate logical jobs
- ✅ Real-time WebSocket communication

## Installation

1. Clone or download the repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top-right)
4. Click "Load unpacked"
5. Select the `extension/` folder from this project

## Usage

### Capture Mode

1. **Start relay server**: `npm run setup` → Choose option 2
2. **Load extension** in Chrome (see Installation above)
3. **Navigate** to any page with streaming media
4. **Play the video** so the extension can capture the stream request
5. **Queue it manually** from the popup or with `Ctrl+Shift+M`

**Supported platforms:**
- Canvas LMS lectures
- Kaltura videos
- Panopto recordings
- AWS CloudFront signed URLs
- YouTube HLS streams
- Any site using `.m3u8` or `.mpd` streams

### Manual Queueing

Press `Ctrl+Shift+M` to queue captured media from the active tab.

Use the popup buttons to:
- Queue all detected/captured videos on the page
- Select a single video when Canvas exposes multiple candidates
- Trigger the same active-tab queue flow as the keyboard shortcut

## File Structure

```
extension/
├── manifest.json      # Extension configuration (Manifest V3)
├── bg.js             # Background service worker (network sniffer)
├── content.js        # Manual page scan and single-video selection helpers
└── README.md         # This file
```

## Permissions Explained

### Required Permissions

- **`webRequest`**: Monitors network requests to detect `.m3u8` and `.mpd` files
- **`cookies`**: Extracts session cookies for authenticated downloads
- **`storage`**: Stores extension settings (future use)

### Host Permissions

- **`<all_urls>`**: Allows extension to monitor requests from any domain
  - Required because streams can come from AWS, CDNs, etc.
  - **Privacy**: Extension only processes `.m3u8` and `.mpd` requests
  - All data stays local (sent to `localhost:8787` only)

## How It Works

### Network Request Flow

```
Browser Page
    │
    │ (User plays video)
    ▼
Network Request: video.m3u8
    │
    │ (Chrome intercepts)
    ▼
bg.js: webRequest listener
    │
    ├─ Check if URL contains .m3u8 or .mpd
    ├─ Extract cookies for domain
    ├─ Capture best candidate locally
    └─ Wait for explicit manual queue action
        │
        ▼
    Popup / Shortcut
        │
        ▼
    Relay Server (localhost:8787)
        │
        ├─ Write cookies to Netscape format
        ├─ Spawn yt-dlp with cookies
        └─ Download → Transcribe
```

### Capture And Deduplication

To prevent duplicate queueing:
- The extension captures manifests passively but does not auto-send them during playback
- Captured streams are canonicalized so signed/query-changing URLs map to one logical stream
- Manual queue actions flush only the best captured candidates
- The relay applies the same logical stream identity before accepting a job

### Cookie Extraction

For authenticated content:
```javascript
const cookies = await chrome.cookies.getAll({ url: streamUrl });
// Returns: [{ name, value, domain, path, secure, expirationDate, ... }]
```

Cookies are sent to relay server, which converts them to Netscape format for `yt-dlp`.

## Configuration

### Keyboard Shortcut

Default: `Ctrl+Shift+M` (Windows/Linux) or `Cmd+Shift+M` (Mac)

**To change:**
1. Go to `chrome://extensions/shortcuts`
2. Find "MP3 Sniper"
3. Click the pencil icon next to "Trigger stream detection"
4. Enter your preferred shortcut

### WebSocket URL

Default: `ws://localhost:8787`

To change the relay server URL, edit `bg.js`:
```javascript
const WS_URL = "ws://your-server:port";
```

## Troubleshooting

### Extension loads but nothing happens

**Check relay server:**
```bash
# Make sure relay server is running
npm run setup
# Choose option 2
```

**Check manual queueing:**
- Play the video for a few seconds first so the manifest is captured
- Then press `Ctrl+Shift+M` or use the popup
- Open Chrome DevTools → Console and look for capture logs followed by `"Stream sent to relay server"`

### "WebSocket connection failed"

**Causes:**
- Relay server not running
- Firewall blocking `localhost:8787`
- WebSocket URL misconfigured

**Fix:**
```bash
# Start relay server
npm run setup

# Verify it's listening
# Should see: "🚀 Relay server listening on port 8787"
```

### No streams detected

**Verify page uses HLS/DASH:**
1. Open Chrome DevTools → Network tab
2. Play the video
3. Filter by `.m3u8` or `.mpd`
4. If no results, page doesn't use these protocols

**Alternative:**
- Page may use direct file links (MP4, etc.)
- Backward compatible handlers still exist in relay server
- Check for blob URLs or direct links

### Playback does not queue automatically

**Expected:** Playback only captures the stream. It will not start a download by itself.

**Fix:** Use `Ctrl+Shift+M` or the popup after the video starts playing.

### Cookie extraction fails

**Symptom:** Download starts but fails with 403/401 error

**Cause:** Session cookies not accessible or expired

**Fix:**
1. Refresh the page
2. Log in again to get fresh cookies
3. Play video to generate new request

## Development

### Testing Changes

1. Edit files in `extension/`
2. Go to `chrome://extensions/`
3. Click reload icon on "MP3 Sniper" card
4. Test on a page with streaming media

### Debug Logging

**Extension logs:**
```javascript
// Open Chrome DevTools → Console (on any page)
// Or check extension service worker console:
// chrome://extensions/ → MP3 Sniper → "service worker" link
```

**Relay server logs:**
```bash
# Terminal running relay server shows:
# - WebSocket connections
# - Received messages
# - yt-dlp output
# - Transcription progress
```

### Message Format

**Extension → Relay:**
```json
{
  "type": "stream_found",
  "url": "https://example.com/video.m3u8",
  "cookies": [
    {
      "name": "session_id",
      "value": "abc123...",
      "domain": ".example.com",
      "path": "/",
      "secure": true,
      "expirationDate": 1234567890
    }
  ],
  "source": "sniffer",
  "pageUrl": "https://example.com/lecture",
  "timestamp": 1234567890000
}
```

**Relay → Extension:**
```json
{
  "type": "transcription_done",
  "payload": {
    "id": "uuid-here",
    "transcript": "[00:00.000] Text here...",
    "source": "sniffer"
  }
}
```

## Security & Privacy

### Data Collection

**What the extension collects:**
- Stream URLs (`.m3u8`, `.mpd` only)
- Session cookies for those domains
- Page URL (for context)

**What it does NOT collect:**
- Browsing history
- Personal information
- Cookies from unrelated sites
- Form data or passwords

### Data Storage

- **No cloud storage**: Everything processed locally
- **WebSocket only**: Data sent to `localhost:8787` only
- **Temporary files**: Cookies and downloads deleted after transcription
- **No telemetry**: No analytics or tracking

### Permissions Justification

| Permission | Why We Need It | What We Do |
|------------|---------------|------------|
| `webRequest` | Detect streaming manifests | Monitor `.m3u8`/`.mpd` requests only |
| `cookies` | Download authenticated streams | Extract cookies for captured stream domains only |
| `<all_urls>` | Support any streaming platform | Process only stream-related requests |

## Known Limitations

### DRM Protection
- **Widevine-encrypted content cannot be downloaded**
- Affects: Netflix, Disney+, some textbook platforms
- Technical limitation, not a bug

### Cookie Expiration
- Long downloads may expire session cookies
- Mitigation: yt-dlp establishes connection quickly
- Workaround: Refresh page for new cookies

### Network Timing
- Extension only detects active requests
- Must capture stream during page load or playback
- Missed requests won't be retroactively detected

### Chrome Web Store
- `<all_urls>` permission triggers manual review
- Acceptable for developer/personal use
- May face scrutiny if publishing publicly

## Migration from v0.3

If upgrading from DOM scraping version:

**Key Changes:**
- Passive network sniffing captures manifests during playback
- Manual queue actions can still use `content.js` and `chrome.scripting` as a fallback for page scanning
- Keyboard shortcut now queues the active tab instead of only testing connectivity

**Backward Compatibility:**
- Old blob/URL handlers still work in relay server
- Extension can coexist with old version (different mechanisms)

See [`MIGRATION_GUIDE.md`](../MIGRATION_GUIDE.md) in project root for details.

## License

Part of the MP3 Grabber project. See main README for license information.
