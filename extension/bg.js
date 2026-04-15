const WS_URL = "ws://localhost:8787";
let sock;

/**
 * Convert any thrown value into a user-facing string.
 * WebSocket failures throw an Event object (no .message), not a real Error.
 */
function friendlyError(err) {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  // WebSocket error / close events have a `type` but no message
  return 'LocalStream server is not running. Open START.bat and choose option 2 (Browser extension), then try again.';
}

// Establishes a WebSocket connection if one is not already open.
// Returns a promise that resolves with the open socket.
function connect() {
  console.log(`MP3 Grabber: connect() called. Current socket state: ${sock?.readyState || 'null'}`);
  
  if (sock?.readyState === WebSocket.OPEN) {
    console.log("MP3 Grabber: WebSocket connection already open.");
    return Promise.resolve(sock);
  }

  // If a connection is in progress, wait for it to complete.
  if (sock?.readyState === WebSocket.CONNECTING) {
    console.log("MP3 Grabber: WebSocket connection is in progress, waiting...");
    return new Promise((resolve, reject) => {
      sock.addEventListener('open', () => {
        console.log("MP3 Grabber: WebSocket connection completed (waited)");
        resolve(sock);
      }, { once: true });
      sock.addEventListener('error', (err) => {
        console.error("MP3 Grabber: WebSocket connection failed (waited):", err);
        reject(err);
      }, { once: true });
    });
  }

  // Create a new WebSocket connection.
  console.log("MP3 Grabber: Creating new WebSocket connection to", WS_URL);
  sock = new WebSocket(WS_URL);

  return new Promise((resolve, reject) => {
    sock.addEventListener('open', () => {
      console.log("MP3 Grabber: WebSocket connection opened successfully");
      // When the socket closes, nullify the sock variable to allow for reconnection.
      sock.addEventListener('close', (event) => {
        console.log("MP3 Grabber: WebSocket connection closed.", {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean
        });
        sock = null;
      }, { once: true });
      resolve(sock);
    }, { once: true });
    sock.addEventListener('error', (err) => {
      console.error("MP3 Grabber: WebSocket error occurred:", err);
      console.error("MP3 Grabber: WebSocket readyState:", sock?.readyState);
      sock = null;
      reject(err);
    }, { once: true });
  });
}

// ============================================================================
// INTELLIGENT STREAM FILTERING SYSTEM
// ============================================================================

/**
 * Check if URL should be ignored based on file extension or content type
 */
function shouldIgnoreUrl(url) {
  const urlLower = url.toLowerCase();
  
  // Ignore subtitle/caption files
  if (urlLower.endsWith('.vtt') || urlLower.endsWith('.srt')) {
    console.log('🚫 [FILTER] Ignoring subtitle file:', url.substring(0, 100));
    return true;
  }
  
  // Ignore encryption keys
  if (urlLower.endsWith('.key')) {
    console.log('🚫 [FILTER] Ignoring encryption key:', url.substring(0, 100));
    return true;
  }
  
  // Ignore image files
  if (urlLower.endsWith('.png') || urlLower.endsWith('.jpg') || urlLower.endsWith('.jpeg')) {
    console.log('🚫 [FILTER] Ignoring image file:', url.substring(0, 100));
    return true;
  }
  
  // Ignore manifest-like URLs that are clearly caption/subtitle assets.
  const ignoreKeywords = ['caption', 'subtitle', 'servewebvtt', 'captionasset'];
  for (const keyword of ignoreKeywords) {
    if (urlLower.includes(keyword)) {
      console.log(`🚫 [FILTER] Ignoring URL with keyword "${keyword}":`, url.substring(0, 100));
      return true;
    }
  }
  
  return false;
}

/**
 * Determine stream quality/priority
 * Higher number = higher priority
 */
function getStreamPriority(url) {
  const urlLower = url.toLowerCase();
  
  // Master manifests have highest priority
  if (urlLower.includes('master.m3u8') || urlLower.includes('master_playlist')) {
    return 100;
  }
  
  // Index manifests have high priority
  if (urlLower.includes('index.m3u8') || urlLower.includes('playlist.m3u8')) {
    return 90;
  }
  
  // MPD manifests (DASH)
  if (urlLower.endsWith('.mpd')) {
    return 80;
  }
  
  // Regular m3u8 files
  if (urlLower.includes('.m3u8')) {
    return 50;
  }
  
  // Other formats
  return 10;
}

/**
 * Extract unique identifier from URL (for deduplication)
 */
function normalizeStreamPath(pathname) {
  return pathname
    .replace(/_(low|medium|high|[0-9]+p|[0-9]+k)/gi, '')
    .replace(/\/(low|medium|high|[0-9]+p|[0-9]+k)\//gi, '/');
}

function extractStreamId(url) {
  try {
    // Try to extract Kaltura entryId if present
    const kalturaMatch = url.match(/\/entryId\/([^\/]+)\//);
    if (kalturaMatch) {
      return `kaltura_${kalturaMatch[1]}`;
    }
    
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
  } catch (error) {
    console.error('🚫 [FILTER] Error extracting stream ID:', error);
    return url;
  }
}

const CAPTURE_RETENTION_MS = 300000;

// Pending streams are captured candidates waiting for an explicit manual queue action.
const pendingStreams = new Map(); // streamId -> { url, priority, cookies, details, timestamp }

// Track which streams were already sent to the relay, preserving cookies for explicit re-use paths.
const processedBaseUrls = new Map(); // streamId -> { url, timestamp, priority, cookies, details }

/**
 * Capture a detected stream candidate without auto-queueing it.
 * Manual actions decide when captured streams are flushed to the relay.
 */
async function processStream(url, cookies, details = {}) {
  const streamId = extractStreamId(url);
  const priority = getStreamPriority(url);
  const timestamp = Date.now();
  
  console.log('📥 [FILTER] Stream detected:', {
    url: url.substring(0, 100) + '...',
    streamId: streamId,
    priority: priority
  });
  
  const processed = processedBaseUrls.get(streamId);
  if (processed && priority <= processed.priority) {
    console.log('⏭️  [FILTER] Already queued better or equal stream this session:', {
      current: priority,
      processed: processed.priority
    });
    return { captured: false, streamId, reason: 'already-processed' };
  }

  if (processed && priority > processed.priority) {
    console.log('🔄 [FILTER] Captured better-quality stream after a prior manual queue:', {
      old: processed.priority,
      new: priority
    });
  }

  const pending = pendingStreams.get(streamId);
  if (pending && priority < pending.priority) {
    console.log('⏭️  [FILTER] Pending capture is already better quality:', {
      pending: pending.priority,
      incoming: priority
    });
    return { captured: false, streamId, reason: 'lower-priority' };
  }

  if (pending) {
    console.log('⬆️  [FILTER] Updating captured stream candidate:', {
      oldPriority: pending.priority,
      newPriority: priority,
      oldUrl: pending.url.substring(0, 80),
      newUrl: url.substring(0, 80)
    });
  } else {
    console.log('📝 [FILTER] Captured stream for manual queueing:', {
      streamId: streamId,
      priority: priority
    });
  }

  pendingStreams.set(streamId, {
    url,
    priority,
    cookies: cookies || [],
    details: details || {},
    timestamp
  });

  return { captured: true, streamId, priority };
}

function captureMatchesTab(candidate, tab) {
  if (!tab) {
    return true;
  }

  const details = candidate?.details || {};
  if (details.tabId != null && details.tabId >= 0) {
    return details.tabId === tab.id;
  }

  if (details.initiator && tab.url) {
    return details.initiator === tab.url;
  }

  return true;
}

function getRecentCapturedStreams({ maxAgeMs = CAPTURE_RETENTION_MS, tab = null } = {}) {
  const cutoff = Date.now() - maxAgeMs;
  const candidates = [];

  for (const [streamId, pending] of pendingStreams.entries()) {
    if ((pending.timestamp || 0) >= cutoff && captureMatchesTab(pending, tab)) {
      candidates.push({
        streamId,
        url: pending.url,
        priority: pending.priority,
        cookies: pending.cookies || [],
        details: pending.details || {},
        timestamp: pending.timestamp || 0,
        source: 'pending'
      });
    }
  }

  for (const [streamId, data] of processedBaseUrls.entries()) {
    if ((data.timestamp || 0) >= cutoff && captureMatchesTab(data, tab)) {
      candidates.push({
        streamId,
        url: data.url,
        priority: data.priority,
        cookies: data.cookies || [],
        details: data.details || {},
        timestamp: data.timestamp || 0,
        source: 'processed'
      });
    }
  }

  candidates.sort((a, b) => b.timestamp - a.timestamp || b.priority - a.priority);
  return candidates;
}

/**
 * Send a captured stream to the relay server.
 */
async function sendStreamToRelay(streamId, url, cookies, details = {}) {
  console.log('🚀 [FILTER] Sending stream to relay:', {
    streamId: streamId,
    url: url.substring(0, 100) + '...'
  });
  
  const pending = pendingStreams.get(streamId);
  const processed = processedBaseUrls.get(streamId);
  const priority = pending ? pending.priority : getStreamPriority(url);
  const relayCookies = (pending?.cookies && pending.cookies.length > 0)
    ? pending.cookies
    : (cookies && cookies.length > 0)
      ? cookies
      : (processed?.cookies || []);
  const relayDetails = {
    ...(processed?.details || {}),
    ...(pending?.details || {}),
    ...(details || {})
  };
  
  try {
    let activeSocket;
    try {
      activeSocket = await connect();
    } catch (error) {
      console.log('ℹ️  [FILTER] Relay not reachable — captured stream kept locally until manual retry');
      return false;
    }
    
    if (activeSocket.readyState === WebSocket.OPEN) {
      const payload = {
        type: 'stream_found',
        url,
        cookies: relayCookies,
        source: relayDetails.source || 'sniffer-manual',
        pageUrl: relayDetails.initiator || relayDetails.pageUrl || 'unknown',
        timestamp: Date.now(),
        canonicalId: streamId
      };
      
      const message = JSON.stringify(payload);
      activeSocket.send(message);
      pendingStreams.delete(streamId);
      processedBaseUrls.set(streamId, {
        url,
        timestamp: Date.now(),
        priority,
        cookies: relayCookies,
        details: relayDetails
      });
      console.log('✅ [FILTER] Stream sent to relay server');
      return true;
    } else {
      console.warn('⚠️  [FILTER] WebSocket not open, cannot send stream data');
      return false;
    }
    
  } catch (error) {
    console.error('❌ [FILTER] Error sending stream to relay:', error);
    return false;
  }
}

async function queueSingleAudioItem(activeSocket, audioItem, tab, source = 'manual-select') {
  if (!audioItem) {
    return { queued: false, reason: 'No media selected.' };
  }

  if (audioItem.type === 'blob' && audioItem.data) {
    if (activeSocket.readyState !== WebSocket.OPEN) {
      return { queued: false, reason: 'WebSocket not connected' };
    }

    activeSocket.send(JSON.stringify({
      type: 'blob',
      data: audioItem.data,
      mimeType: audioItem.mimeType,
      size: audioItem.size,
      originalUrl: audioItem.originalUrl || 'blob:',
      source,
      pageUrl: tab.url || 'unknown',
      timestamp: Date.now()
    }));
    return { queued: true };
  }

  if (audioItem.type === 'url' && audioItem.url) {
    const url = audioItem.url;
    const urlLower = url.toLowerCase();

    if (urlLower.includes('.m3u8') || urlLower.endsWith('.mpd')) {
      const cookies = await chrome.cookies.getAll({ url });
      const streamId = extractStreamId(url);
      const queued = await sendStreamToRelay(streamId, url, cookies, {
        tabId: tab.id,
        initiator: tab.url || 'unknown',
        source
      });
      return queued
        ? { queued: true }
        : { queued: false, reason: 'Failed to send selected stream to relay.' };
    }

    if (activeSocket.readyState !== WebSocket.OPEN) {
      return { queued: false, reason: 'WebSocket not connected' };
    }

    activeSocket.send(JSON.stringify({
      type: 'url',
      url,
      source,
      pageUrl: tab.url || 'unknown',
      timestamp: Date.now()
    }));
    return { queued: true };
  }

  return { queued: false, reason: 'Unsupported media type returned by content script.' };
}

function getMostRecentCapturedStream(tab = null) {
  const candidates = getRecentCapturedStreams({ tab });
  return candidates[0] || null;
}

async function sendMessageToTabWithInjection(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (sendError) {
    if (!sendError.message.includes('Could not establish connection')) {
      throw sendError;
    }

    console.log('🔄 [TAB] Content script not loaded, attempting to inject...');
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    await new Promise(resolve => setTimeout(resolve, 500));
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function requireRelaySocket() {
  const activeSocket = await connect();
  if (activeSocket.readyState !== WebSocket.OPEN) {
    throw new Error('LocalStream server is not running. Open START.bat and choose option 2 (Browser extension), then try again.');
  }
  return activeSocket;
}

async function getCurrentActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !tab.id) {
    throw new Error('No active tab found.');
  }
  return tab;
}

async function queueCapturedStreamsForTab(tab, source, extraStreams = []) {
  const activeSocket = await requireRelaySocket();
  const pageUrl = tab.url || 'unknown';
  let directCount = 0;

  for (const audioItem of extraStreams) {
    if (!audioItem) {
      continue;
    }

    if (audioItem.type === 'url' && audioItem.url) {
      const url = audioItem.url;
      const urlLower = url.toLowerCase();

      if (urlLower.includes('.m3u8') || urlLower.endsWith('.mpd')) {
        const cookies = await chrome.cookies.getAll({ url });
        await processStream(url, cookies, {
          tabId: tab.id,
          initiator: pageUrl,
          source
        });
        continue;
      }
    }

    const queueResult = await queueSingleAudioItem(activeSocket, audioItem, tab, source);
    if (queueResult.queued) {
      directCount++;
    }
  }

  const flushed = await flushPendingStreams(tab);
  let totalCount = directCount + flushed.count;

  if (totalCount === 0) {
    const recentStreams = getRecentCapturedStreams({ tab });
    for (const stream of recentStreams) {
      const queued = await sendStreamToRelay(stream.streamId, stream.url, stream.cookies || [], {
        ...stream.details,
        tabId: tab.id,
        initiator: pageUrl,
        source: `${source}-fallback`,
        fallbackSource: stream.source
      });
      if (queued) {
        totalCount++;
      }
    }
  }

  return { count: totalCount };
}

async function queueAllVideosForTab(tabId, source = 'manual-trigger') {
  const tab = await chrome.tabs.get(tabId);
  const response = await sendMessageToTabWithInjection(tabId, {
    action: 'findAudioLinks',
    manualTrigger: true,
    timestamp: Date.now()
  });

  return queueCapturedStreamsForTab(tab, source, response?.audioData || []);
}

async function runManualTrigger(tabId) {
  const tab = tabId ? await chrome.tabs.get(tabId) : await getCurrentActiveTab();
  return queueAllVideosForTab(tab.id, 'manual-trigger');
}

// Clean up old entries periodically
setInterval(() => {
  const now = Date.now();
  
  for (const [streamId, data] of pendingStreams.entries()) {
    if (now - data.timestamp > CAPTURE_RETENTION_MS) {
      pendingStreams.delete(streamId);
    }
  }

  for (const [streamId, data] of processedBaseUrls.entries()) {
    if (now - data.timestamp > CAPTURE_RETENTION_MS) {
      processedBaseUrls.delete(streamId);
    }
  }
  
}, 60000); // Every minute

// Network request listener for stream detection
const filter = {
  urls: ["<all_urls>"],
  types: ["xmlhttprequest", "other", "media"]
};

chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    const url = details.url;
    const urlLower = url.toLowerCase();
    
    // Check if URL contains .m3u8 or .mpd (HLS/DASH manifests)
    if (urlLower.includes('.m3u8') || urlLower.endsWith('.mpd')) {
      
      // STEP 1: Apply ignore filters
      if (shouldIgnoreUrl(url)) {
        return; // Filtered out, don't process
      }
      
      console.log('🎯 [FILTER] Valid stream detected:', url.substring(0, 100) + '...');
      
      try {
        const cookies = await chrome.cookies.getAll({ url: url });
        console.log(`🍪 [FILTER] Found ${cookies.length} cookies`);
        
        // Capture the stream locally so manual actions can explicitly queue it later.
        await processStream(url, cookies, details);
        
      } catch (error) {
        console.error('❌ [FILTER] Error processing stream:', error);
      }
    }
  },
  filter
);

/**
 * Flush captured streams immediately when the user explicitly triggers queueing.
 */
/** @returns {{ count: number, streamIds: Set<string> }} */
async function flushPendingStreams(tab = null) {
  console.log('🚀 [FILTER] Flushing captured streams (manual trigger)');
  
  const streamsToFlush = Array.from(pendingStreams.entries())
    .filter(([, pending]) => captureMatchesTab(pending, tab))
    .sort((a, b) => b[1].priority - a[1].priority || a[1].timestamp - b[1].timestamp);
  const streamIds = new Set();
  let count = 0;
  
  for (const [streamId, pending] of streamsToFlush) {
    console.log(`⚡ [FILTER] Sending pending stream immediately: ${streamId}`);
    const sent = await sendStreamToRelay(streamId, pending.url, pending.cookies, pending.details);
    if (sent) {
      streamIds.add(streamId);
      count++;
    }
  }
  
  console.log(`✅ [FILTER] Flushed ${count} captured stream(s)`);
  return { count, streamIds };
}

// Optional: Manual trigger via keyboard shortcut
chrome.commands.onCommand.addListener(async (cmd) => {
  console.log(`🎹 [COMMAND] Command received: ${cmd}`);
  
  if (cmd === "grab-mp3") {
    console.log("🎯 [COMMAND] Manual trigger - queueing active tab");
    
    try {
      const result = await runManualTrigger();
      console.log(`✅ [COMMAND] Manual trigger complete (${result.count} item(s) queued)`);
    } catch (error) {
      console.error("❌ [COMMAND] Failed to process manual trigger:", error);
    }
  }
});

console.log('🎵 MP3 Grabber: Background script loaded — stream capture active');
// Do NOT auto-connect here. The relay server may not be running yet.
// Connection is established only when the user explicitly queues something.

// Handle popup messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'queueAllVideos') {
    console.log('🎯 [POPUP] Queue All Videos triggered for tab:', request.tabId);
    
    (async () => {
      try {
        const result = await queueAllVideosForTab(request.tabId, 'popup-queue-all');
        sendResponse({ success: true, count: result.count });
      } catch (error) {
        console.error('❌ [POPUP] Error queuing videos:', error);
        sendResponse({ success: false, error: friendlyError(error) });
      }
    })();
    
    return true; // Keep message channel open
  }
  
  if (request.action === 'flushAllStreams') {
    console.log('🎯 [POPUP] Flush pending debounce queue only');
    
    (async () => {
      try {
        const activeSocket = await connect();

        if (activeSocket.readyState !== WebSocket.OPEN) {
          sendResponse({ success: false, error: 'LocalStream server is not running. Open START.bat and choose option 2 (Browser extension), then try again.' });
          return;
        }
        
        const flushed = await flushPendingStreams();
        sendResponse({ success: true, count: flushed.count });
      } catch (error) {
        console.error('❌ [POPUP] Error flushing streams:', error);
        sendResponse({ success: false, error: friendlyError(error) });
      }
    })();
    
    return true;
  }
  
  if (request.action === 'manualTrigger') {
    (async () => {
      try {
        const result = await runManualTrigger(request.tabId);
        sendResponse({ success: true, count: result.count });
      } catch (error) {
        console.error('❌ [POPUP] Manual trigger failed:', error);
        sendResponse({ success: false, error: friendlyError(error) });
      }
    })();
    return true;
  }

  if (request.action === 'queueSingleVideo') {
    (async () => {
      try {
        const activeSocket = await connect();
        if (activeSocket.readyState !== WebSocket.OPEN) {
          sendResponse({ success: false, error: 'LocalStream server is not running. Open START.bat and choose option 2 (Browser extension), then try again.' });
          return;
        }

        let response;
        try {
          response = await sendMessageToTabWithInjection(request.tabId, {
            action: 'selectSingleVideo',
            timestamp: Date.now()
          });
        } catch (sendError) {
          throw sendError;
        }

        const tab = await chrome.tabs.get(request.tabId);
        if (response && response.success && response.selected) {
          const queueResult = await queueSingleAudioItem(activeSocket, response.selected, tab, 'manual-select');
          if (!queueResult.queued) {
            sendResponse({ success: false, error: queueResult.reason || 'Failed to queue selected video.' });
            return;
          }

          sendResponse({ success: true, count: 1, mode: 'selected-video' });
          return;
        }

        // Fallback: if Canvas does not expose a selectable <video src/currentSrc>,
        // queue the most recent captured stream from network sniffer state.
        const fallbackStream = getMostRecentCapturedStream(tab);
        if (!fallbackStream) {
          sendResponse({
            success: false,
            error: response?.error || 'No streams detected yet. Play the video for a few seconds and try again.'
          });
          return;
        }

        const queued = await sendStreamToRelay(
          fallbackStream.streamId,
          fallbackStream.url,
          fallbackStream.cookies || [],
          {
            ...fallbackStream.details,
            tabId: tab.id,
            initiator: tab.url || 'unknown',
            source: 'manual-select-fallback',
            fallbackSource: fallbackStream.source
          }
        );

        if (!queued) {
          sendResponse({ success: false, error: 'Failed to send the captured stream to the relay.' });
          return;
        }

        sendResponse({ success: true, count: 1, mode: 'fallback-stream' });
      } catch (error) {
        console.error('❌ [POPUP] Error queueing single selected video:', error);
        sendResponse({ success: false, error: friendlyError(error) });
      }
    })();

    return true;
  }
});
