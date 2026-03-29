const WS_URL = "ws://localhost:8787";
let sock;

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
  
  // Ignore URLs containing specific keywords
  const ignoreKeywords = ['segment', 'fragment', 'caption', 'subtitle'];
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
function extractStreamId(url) {
  try {
    // Try to extract Kaltura entryId if present
    const kalturaMatch = url.match(/\/entryId\/([^\/]+)\//);
    if (kalturaMatch) {
      return `kaltura_${kalturaMatch[1]}`;
    }
    
    // Otherwise use the base URL without query params and quality indicators
    const urlObj = new URL(url);
    const pathname = urlObj.pathname
      .replace(/_(low|medium|high|[0-9]+p|[0-9]+k)/gi, '')
      .replace(/\/(low|medium|high|[0-9]+p|[0-9]+k)\//gi, '/');
    
    return `${urlObj.host}${pathname}`;
  } catch (error) {
    console.error('🚫 [FILTER] Error extracting stream ID:', error);
    return url;
  }
}

// Pending streams waiting for better quality (debounce buffer)
const pendingStreams = new Map(); // streamId -> { url, priority, timeout, cookies, details }

// Track which base URLs we've already processed (to avoid multiple quality versions)
const processedBaseUrls = new Map(); // streamId -> { url, timestamp, priority }

/**
 * Process a detected stream with intelligent debouncing
 * Waits 2 seconds to see if a better quality stream appears
 */
async function processStream(url, cookies, details) {
  const streamId = extractStreamId(url);
  const priority = getStreamPriority(url);
  
  console.log('📥 [FILTER] Stream detected:', {
    url: url.substring(0, 100) + '...',
    streamId: streamId,
    priority: priority
  });
  
  // Check if we've already processed this stream recently
  if (processedBaseUrls.has(streamId)) {
    const processed = processedBaseUrls.get(streamId);
    const timeSinceProcessed = Date.now() - processed.timestamp;
    
    if (timeSinceProcessed < 60000) { // 60 second window
      if (priority <= processed.priority) {
        console.log('⏭️  [FILTER] Skipping - already processed better or equal stream:', {
          current: priority,
          processed: processed.priority
        });
        return;
      } else {
        console.log('🔄 [FILTER] Found better quality stream, replacing:', {
          old: processed.priority,
          new: priority
        });
      }
    }
  }
  
  // Check if we have a pending stream for this ID
  if (pendingStreams.has(streamId)) {
    const pending = pendingStreams.get(streamId);
    
    if (priority > pending.priority) {
      // Found a better stream, replace it
      console.log('⬆️  [FILTER] Upgrading pending stream:', {
        oldPriority: pending.priority,
        newPriority: priority,
        oldUrl: pending.url.substring(0, 80),
        newUrl: url.substring(0, 80)
      });
      
      // Cancel old timeout
      clearTimeout(pending.timeout);
      
      // Set new pending stream with 2-second debounce
      const timeout = setTimeout(() => {
        sendStreamToRelay(streamId, url, cookies, details);
      }, 2000);
      
      pendingStreams.set(streamId, {
        url: url,
        priority: priority,
        timeout: timeout,
        cookies: cookies,
        details: details
      });
    } else {
      console.log('⏭️  [FILTER] Pending stream is better quality, ignoring:', {
        pending: pending.priority,
        new: priority
      });
    }
  } else {
    // New stream, add to pending with 2-second debounce
    console.log('⏳ [FILTER] Adding to pending queue (2s debounce):', {
      streamId: streamId,
      priority: priority
    });
    
    const timeout = setTimeout(() => {
      sendStreamToRelay(streamId, url, cookies, details);
    }, 2000);
    
    pendingStreams.set(streamId, {
      url: url,
      priority: priority,
      timeout: timeout,
      cookies: cookies,
      details: details
    });
  }
}

/**
 * Send stream to relay server after debounce period
 */
async function sendStreamToRelay(streamId, url, cookies, details) {
  console.log('🚀 [FILTER] Sending stream to relay (debounce complete):', {
    streamId: streamId,
    url: url.substring(0, 100) + '...'
  });
  
  // Remove from pending and get priority
  const pending = pendingStreams.get(streamId);
  const priority = pending ? pending.priority : getStreamPriority(url);
  pendingStreams.delete(streamId);
  processedBaseUrls.set(streamId, { url, timestamp: Date.now(), priority });
  
  try {
    // Ensure WebSocket connection is open
    let activeSocket;
    try {
      activeSocket = await connect();
    } catch (error) {
      console.error('❌ [FILTER] Failed to connect to relay server:', error);
      return;
    }
    
    // Send stream data to relay server
    if (activeSocket.readyState === WebSocket.OPEN) {
      const payload = {
        type: 'stream_found',
        url: url,
        cookies: cookies,
        source: 'sniffer',
        pageUrl: details.initiator || 'unknown',
        timestamp: Date.now()
      };
      
      const message = JSON.stringify(payload);
      activeSocket.send(message);
      console.log('✅ [FILTER] Stream sent to relay server');
    } else {
      console.warn('⚠️  [FILTER] WebSocket not open, cannot send stream data');
    }
    
  } catch (error) {
    console.error('❌ [FILTER] Error sending stream to relay:', error);
  }
}

async function queueSingleAudioItem(activeSocket, audioItem, tab) {
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
      source: 'manual-select',
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
      // Manual selection should bypass quality/dedup filters and enqueue immediately.
      const streamId = extractStreamId(url);
      await sendStreamToRelay(streamId, url, cookies, {
        tabId: tab.id,
        initiator: tab.url || 'unknown',
        source: 'manual-select'
      });
      return { queued: true };
    }

    if (activeSocket.readyState !== WebSocket.OPEN) {
      return { queued: false, reason: 'WebSocket not connected' };
    }

    activeSocket.send(JSON.stringify({
      type: 'url',
      url,
      source: 'manual-select',
      pageUrl: tab.url || 'unknown',
      timestamp: Date.now()
    }));
    return { queued: true };
  }

  return { queued: false, reason: 'Unsupported media type returned by content script.' };
}

function getMostRecentCapturedStream() {
  const pendingEntries = Array.from(pendingStreams.entries()).map(([streamId, pending]) => ({
    streamId,
    url: pending.url,
    cookies: pending.cookies || [],
    details: pending.details || {},
    timestamp: Date.now(),
    source: 'pending'
  }));

  const processedEntries = Array.from(processedBaseUrls.entries()).map(([streamId, data]) => ({
    streamId,
    url: data.url,
    cookies: [],
    details: {},
    timestamp: data.timestamp || 0,
    source: 'processed'
  }));

  const candidates = [...pendingEntries, ...processedEntries]
    .filter(item => !!item.url)
    .sort((a, b) => b.timestamp - a.timestamp);

  return candidates[0] || null;
}

// Clean up old entries periodically
setInterval(() => {
  const now = Date.now();
  
  // Clean up processed URLs older than 5 minutes
  for (const [streamId, data] of processedBaseUrls.entries()) {
    if (now - data.timestamp > 300000) {
      processedBaseUrls.delete(streamId);
    }
  }
  
  console.log('🧹 [FILTER] Cleanup complete:', {
    processed: processedBaseUrls.size,
    pending: pendingStreams.size
  });
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
        // Extract cookies for this domain
        const cookies = await chrome.cookies.getAll({ url: url });
        console.log(`🍪 [FILTER] Found ${cookies.length} cookies`);
        
        // STEP 2: Process with intelligent debouncing and prioritization
        await processStream(url, cookies, details);
        
      } catch (error) {
        console.error('❌ [FILTER] Error processing stream:', error);
      }
    }
  },
  filter
);

/**
 * Flush pending streams immediately (skip debounce)
 * Used when user manually triggers download
 */
async function flushPendingStreams() {
  console.log('🚀 [FILTER] Flushing pending streams (manual trigger)');
  
  const streamsToFlush = Array.from(pendingStreams.entries());
  
  for (const [streamId, pending] of streamsToFlush) {
    // Cancel the timeout
    clearTimeout(pending.timeout);
    
    // Send immediately
    console.log(`⚡ [FILTER] Sending pending stream immediately: ${streamId}`);
    await sendStreamToRelay(streamId, pending.url, pending.cookies, pending.details);
  }
  
  console.log(`✅ [FILTER] Flushed ${streamsToFlush.length} pending stream(s)`);
}

// Optional: Manual trigger via keyboard shortcut
chrome.commands.onCommand.addListener(async (cmd) => {
  console.log(`🎹 [COMMAND] Command received: ${cmd}`);
  
  if (cmd === "grab-mp3") {
    console.log("🎯 [COMMAND] Manual trigger - activating stream detection");
    
    try {
      // Step 1: Ensure WebSocket connection
      const activeSocket = await connect();
      console.log("🔌 [COMMAND] WebSocket connection verified, readyState:", activeSocket.readyState);
      
      if (activeSocket.readyState !== WebSocket.OPEN) {
        console.warn("⚠️  [COMMAND] WebSocket not open, cannot proceed");
        return;
      }
      
      // Step 2: Send ping to verify connection
      activeSocket.send(JSON.stringify({ 
        type: 'ping', 
        timestamp: Date.now() 
      }));
      console.log("📡 [COMMAND] Ping sent to relay server");
      
      // Step 3: Flush any pending streams immediately (skip debounce)
      await flushPendingStreams();
      
      // Step 4: Query all tabs and trigger content script search
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (tabs.length === 0) {
          console.warn("⚠️  [COMMAND] No active tabs found");
          return;
        }
        
        // Send message to active tab's content script
        for (const tab of tabs) {
          if (tab.id) {
            console.log(`📨 [COMMAND] Sending search request to tab ${tab.id}: ${tab.url}`);
            
            try {
              const response = await chrome.tabs.sendMessage(tab.id, {
                action: 'findAudioLinks',
                manualTrigger: true,
                timestamp: Date.now()
              });
              
              if (response && response.success) {
                console.log(`✅ [COMMAND] Content script found ${response.audioData?.length || 0} audio/video element(s)`);
                
                // Process any found URLs or blob data
                if (response.audioData && response.audioData.length > 0) {
                  for (const audioItem of response.audioData) {
                    // Handle blob data (already converted to base64 in content script)
                    if (audioItem.type === 'blob' && audioItem.data) {
                      console.log(`📦 [COMMAND] Found blob data from content script (${audioItem.size} bytes, ${audioItem.mimeType})`);
                      
                      try {
                        if (activeSocket.readyState === WebSocket.OPEN) {
                          const payload = {
                            type: 'blob',
                            data: audioItem.data,
                            mimeType: audioItem.mimeType,
                            size: audioItem.size,
                            originalUrl: audioItem.originalUrl || 'blob:',
                            source: 'content-script',
                            pageUrl: tab.url || 'unknown',
                            timestamp: Date.now()
                          };
                          
                          activeSocket.send(JSON.stringify(payload));
                          console.log(`✅ [COMMAND] Blob data sent to relay server`);
                        }
                      } catch (error) {
                        console.error(`❌ [COMMAND] Error sending blob data:`, error);
                      }
                    }
                    // Handle regular URLs (streams)
                    else if (audioItem.type === 'url' && audioItem.url) {
                      const url = audioItem.url;
                      const urlLower = url.toLowerCase();
                      
                      // Check if it's a stream URL
                      if (urlLower.includes('.m3u8') || urlLower.endsWith('.mpd')) {
                        console.log(`🎯 [COMMAND] Found stream URL from content script: ${url.substring(0, 100)}`);
                        
                        // Get cookies and process
                        try {
                          const cookies = await chrome.cookies.getAll({ url: url });
                          await processStream(url, cookies, {
                            initiator: tab.url || 'unknown',
                            tabId: tab.id
                          });
                        } catch (error) {
                          console.error(`❌ [COMMAND] Error processing stream from content script:`, error);
                        }
                      } else {
                        // Regular media URL (not a stream manifest)
                        console.log(`🎵 [COMMAND] Found media URL from content script: ${url.substring(0, 100)}`);
                        
                        try {
                          if (activeSocket.readyState === WebSocket.OPEN) {
                            const payload = {
                              type: 'url',
                              url: url,
                              source: 'content-script',
                              pageUrl: tab.url || 'unknown',
                              timestamp: Date.now()
                            };
                            
                            activeSocket.send(JSON.stringify(payload));
                            console.log(`✅ [COMMAND] Media URL sent to relay server`);
                          }
                        } catch (error) {
                          console.error(`❌ [COMMAND] Error sending media URL:`, error);
                        }
                      }
                    }
                  }
                }
              } else {
                console.log(`ℹ️  [COMMAND] Content script response:`, response);
              }
            } catch (error) {
              // Content script might not be loaded on this page
              console.log(`ℹ️  [COMMAND] Could not send message to tab ${tab.id}:`, error.message);
              console.log(`   (This is normal for pages without content script support)`);
            }
          }
        }
      } catch (error) {
        console.error("❌ [COMMAND] Error querying tabs:", error);
      }
      
      console.log("✅ [COMMAND] Manual trigger complete");
      
    } catch (error) {
      console.error("❌ [COMMAND] Failed to process manual trigger:", error);
    }
  }
});

// Establish connection on extension load
console.log('=' .repeat(70));
console.log('🎵 MP3 Grabber: Background script loaded');
console.log('🔍 Intelligent Stream Filtering: ACTIVE');
console.log('📊 Filters:');
console.log('   - Ignoring: .vtt, .srt, .key, .png, .jpg');
console.log('   - Ignoring: segment, fragment, caption URLs');
console.log('   - Prioritizing: master.m3u8, index.m3u8');
console.log('   - Debounce: 2-second wait for better streams');
console.log('=' .repeat(70));
console.log('🔌 Establishing WebSocket connection...');
connect().catch(err => {
  console.error('❌ Initial connection failed:', err);
  console.log('🔄 Will retry when stream is detected');
});

// Handle popup messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'queueAllVideos') {
    console.log('🎯 [POPUP] Queue All Videos triggered for tab:', request.tabId);
    
    (async () => {
      try {
        const activeSocket = await connect();
        
        if (activeSocket.readyState !== WebSocket.OPEN) {
          sendResponse({ success: false, error: 'WebSocket not connected' });
          return;
        }
        
        // Flush pending streams first
        await flushPendingStreams();
        
        // Query the tab for videos
        let response;
        try {
          response = await chrome.tabs.sendMessage(request.tabId, {
            action: 'findAudioLinks',
            manualTrigger: true,
            timestamp: Date.now()
          });
        } catch (sendError) {
          // Content script might not be loaded yet, try to inject it
          if (sendError.message.includes('Could not establish connection')) {
            console.log('🔄 [POPUP] Content script not loaded, attempting to inject...');
            try {
              await chrome.scripting.executeScript({
                target: { tabId: request.tabId },
                files: ['content.js']
              });
              // Wait a bit for script to initialize
              await new Promise(resolve => setTimeout(resolve, 500));
              // Try again
              response = await chrome.tabs.sendMessage(request.tabId, {
                action: 'findAudioLinks',
                manualTrigger: true,
                timestamp: Date.now()
              });
            } catch (injectError) {
              throw new Error(`Failed to inject content script: ${injectError.message}`);
            }
          } else {
            throw sendError;
          }
        }
        
        let count = 0;
        
        if (response && response.audioData) {
          for (const audioItem of response.audioData) {
            if (audioItem.type === 'url' && audioItem.url) {
              const url = audioItem.url;
              const urlLower = url.toLowerCase();
              
              if (urlLower.includes('.m3u8') || urlLower.endsWith('.mpd')) {
                const cookies = await chrome.cookies.getAll({ url: url });
                await processStream(url, cookies, { tabId: request.tabId });
                count++;
              }
            }
          }
        }
        
        sendResponse({ success: true, count: count });
      } catch (error) {
        console.error('❌ [POPUP] Error queuing videos:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    
    return true; // Keep message channel open
  }
  
  if (request.action === 'flushAllStreams') {
    console.log('🎯 [POPUP] Flush All Streams triggered');
    
    (async () => {
      try {
        const activeSocket = await connect();

        if (activeSocket.readyState !== WebSocket.OPEN) {
          sendResponse({ success: false, error: 'WebSocket not connected' });
          return;
        }
        
        // Streams waiting in the debounce queue
        const pendingCount = pendingStreams.size;

        // Streams the sniffer already sent (or tried to send) in the last 5 minutes.
        // We re-send these so the relay can decide: if it already transcribed them it
        // will silently reject via completedIds (no loop); if the relay is fresh or
        // never received them it will queue them normally.
        // We do NOT send clear_completed — that was the root cause of the loop.
        const recentlyDetected = Array.from(processedBaseUrls.entries())
          .filter(([_, data]) => Date.now() - data.timestamp < 300000);

        const totalCount = pendingCount + recentlyDetected.length;

        if (totalCount === 0) {
          sendResponse({ success: true, count: 0 });
          return;
        }

        // Flush debounce queue first
        await flushPendingStreams();

        // Re-offer recently detected streams to the relay (relay deduplicates)
        for (const [streamId, data] of recentlyDetected) {
          console.log(`🔄 [POPUP] Re-offering to relay: ${streamId}`);
          await sendStreamToRelay(streamId, data.url, [], { source: 'popup-requeue' });
        }
        
        sendResponse({ success: true, count: totalCount });
      } catch (error) {
        console.error('❌ [POPUP] Error flushing streams:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    
    return true;
  }
  
  if (request.action === 'manualTrigger') {
    chrome.commands.onCommand.addListener((cmd) => {
      if (cmd === 'grab-mp3') {
        // Trigger existing manual logic
      }
    });
    sendResponse({ success: true });
  }

  if (request.action === 'queueSingleVideo') {
    (async () => {
      try {
        const activeSocket = await connect();
        if (activeSocket.readyState !== WebSocket.OPEN) {
          sendResponse({ success: false, error: 'WebSocket not connected' });
          return;
        }

        let response;
        try {
          response = await chrome.tabs.sendMessage(request.tabId, {
            action: 'selectSingleVideo',
            timestamp: Date.now()
          });
        } catch (sendError) {
          if (sendError.message.includes('Could not establish connection')) {
            await chrome.scripting.executeScript({
              target: { tabId: request.tabId },
              files: ['content.js']
            });
            await new Promise(resolve => setTimeout(resolve, 500));
            response = await chrome.tabs.sendMessage(request.tabId, {
              action: 'selectSingleVideo',
              timestamp: Date.now()
            });
          } else {
            throw sendError;
          }
        }

        const tab = await chrome.tabs.get(request.tabId);
        if (response && response.success && response.selected) {
          const queueResult = await queueSingleAudioItem(activeSocket, response.selected, tab);
          if (!queueResult.queued) {
            sendResponse({ success: false, error: queueResult.reason || 'Failed to queue selected video.' });
            return;
          }

          sendResponse({ success: true, count: 1, mode: 'selected-video' });
          return;
        }

        // Fallback: if Canvas does not expose a selectable <video src/currentSrc>,
        // queue the most recent captured stream from network sniffer state.
        const fallbackStream = getMostRecentCapturedStream();
        if (!fallbackStream) {
          sendResponse({
            success: false,
            error: response?.error || 'No streams detected yet. Play the video for a few seconds and try again.'
          });
          return;
        }

        await sendStreamToRelay(
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

        sendResponse({ success: true, count: 1, mode: 'fallback-stream' });
      } catch (error) {
        console.error('❌ [POPUP] Error queueing single selected video:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();

    return true;
  }
});
