// YouTube-specific content script for MP3 Grabber
console.log('MP3 Grabber: YouTube content script loaded');
console.log('MP3 Grabber: Current URL:', window.location.href);
console.log('MP3 Grabber: Document ready state:', document.readyState);
console.log('MP3 Grabber: Script loaded at:', new Date().toISOString());
console.log('MP3 Grabber: Chrome runtime available:', !!chrome.runtime);
console.log('MP3 Grabber: Chrome runtime ID:', chrome.runtime?.id);

// Immediate execution - no waiting
console.log('MP3 Grabber: Content script executing immediately');

// Function to convert blob URL to downloadable data
async function convertBlobToData(blobUrl) {
  try {
    console.log('MP3 Grabber: Converting blob URL to data:', blobUrl);
    
    // Fetch the blob data
    const response = await fetch(blobUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch blob: ${response.status}`);
    }
    
    // Get the blob data
    const blob = await response.blob();
    console.log('MP3 Grabber: Blob data retrieved:', {
      size: blob.size,
      type: blob.type
    });
    
    // Convert blob to base64
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
    
    return {
      data: base64,
      mimeType: blob.type,
      size: blob.size,
      originalUrl: blobUrl
    };
  } catch (error) {
    console.error('MP3 Grabber: Error converting blob:', error);
    return null;
  }
}

function getMediaSourceUrl(mediaElement) {
  if (!mediaElement) return '';

  if (mediaElement.currentSrc) {
    return mediaElement.currentSrc;
  }
  if (mediaElement.src) {
    return mediaElement.src;
  }

  const sourceElement = mediaElement.querySelector('source[src]');
  if (sourceElement && sourceElement.src) {
    return sourceElement.src;
  }

  return '';
}

// Synchronous function for immediate execution
async function findYouTubeAudioElementsSync() {
  console.log('MP3 Grabber: findYouTubeAudioElementsSync() executing');
  
  const audioData = [];
  
  try {
    // Method 1: Look for video elements (YouTube uses video elements for audio/video)
    const videoElements = document.querySelectorAll('video');
    console.log(`MP3 Grabber: Found ${videoElements.length} video elements`);
    
    for (const [index, video] of videoElements.entries()) {
      const mediaUrl = getMediaSourceUrl(video);
      if (mediaUrl) {
        console.log(`MP3 Grabber: Video element ${index + 1} src:`, mediaUrl);
        
        if (mediaUrl.startsWith('blob:')) {
          // Convert blob URL to data immediately in content script
          const blobData = await convertBlobToData(mediaUrl);
          if (blobData) {
            audioData.push({
              type: 'blob',
              ...blobData,
              element: 'video',
              index: index + 1
            });
          }
        } else {
          audioData.push({
            type: 'url',
            url: mediaUrl,
            element: 'video',
            index: index + 1
          });
        }
      }
    }
    
    // Method 2: Look for YouTube's internal video player data
    const videoPlayer = document.querySelector('#movie_player, .html5-video-player');
    if (videoPlayer) {
      console.log('MP3 Grabber: Found YouTube video player');
      
      // Try to access YouTube's internal video data
      try {
        let videoData = null;
        
        if (window.ytInitialPlayerResponse) {
          videoData = window.ytInitialPlayerResponse;
          console.log('MP3 Grabber: Found ytInitialPlayerResponse');
        } else if (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
          videoData = window.ytplayer.config.args;
          console.log('MP3 Grabber: Found ytplayer.config.args');
        }
        
        if (videoData && videoData.streamingData) {
          console.log('MP3 Grabber: Found streaming data');
          
          // Extract video URLs from YouTube's data structure
          if (videoData.streamingData.formats) {
            videoData.streamingData.formats.forEach((format, index) => {
              if (format.url) {
                console.log(`MP3 Grabber: YouTube format ${index + 1}:`, format.url);
                audioData.push({
                  type: 'url',
                  url: format.url,
                  element: 'youtube-format',
                  index: index + 1,
                  quality: format.qualityLabel || format.quality || 'unknown'
                });
              }
            });
          }
          
          if (videoData.streamingData.adaptiveFormats) {
            videoData.streamingData.adaptiveFormats.forEach((format, index) => {
              if (format.url) {
                console.log(`MP3 Grabber: YouTube adaptive format ${index + 1}:`, format.url);
                audioData.push({
                  type: 'url',
                  url: format.url,
                  element: 'youtube-adaptive',
                  index: index + 1,
                  quality: format.qualityLabel || format.quality || 'unknown'
                });
              }
            });
          }
        }
      } catch (error) {
        console.log('MP3 Grabber: Could not access YouTube internal data:', error.message);
      }
    }
    
  } catch (error) {
    console.error('MP3 Grabber: Error in findYouTubeAudioElementsSync:', error);
  }
  
  console.log(`MP3 Grabber: findYouTubeAudioElementsSync found ${audioData.length} elements:`, audioData);
  return audioData;
}

function getVideoElementLabel(video, index) {
  const idPart = video.id ? `#${video.id}` : '';
  const classPart = video.className && typeof video.className === 'string'
    ? `.${video.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')}`
    : '';
  const mediaUrl = getMediaSourceUrl(video);
  const srcPart = mediaUrl ? mediaUrl.slice(0, 70) : '(no src)';
  return `${index + 1}) ${video.tagName.toLowerCase()}${idPart}${classPart} - ${srcPart}`;
}

async function selectSingleVideoElement() {
  const videos = Array.from(document.querySelectorAll('video')).filter(v => !!getMediaSourceUrl(v));
  console.log(`MP3 Grabber: selectSingleVideoElement found ${videos.length} candidate videos`);

  if (videos.length === 0) {
    return { success: false, error: 'No video elements with a source were found on this page.' };
  }

  if (videos.length === 1) {
    const selected = videos[0];
    const selectedUrl = getMediaSourceUrl(selected);
    if (selectedUrl.startsWith('blob:')) {
      const blobData = await convertBlobToData(selectedUrl);
      if (!blobData) {
        return { success: false, error: 'Failed to read selected blob video.' };
      }
      return {
        success: true,
        selected: {
          type: 'blob',
          ...blobData,
          element: 'video',
          index: 1
        }
      };
    }

    return {
      success: true,
      selected: {
        type: 'url',
        url: selectedUrl,
        element: 'video',
        index: 1
      }
    };
  }

  const promptText = [
    'MP3 Grabber: Select one video to transcribe by number:',
    ...videos.map((video, index) => getVideoElementLabel(video, index))
  ].join('\n');

  const rawChoice = window.prompt(promptText, '1');
  if (rawChoice === null) {
    return { success: false, cancelled: true, error: 'Selection cancelled.' };
  }

  const choice = Number.parseInt(rawChoice, 10);
  if (!Number.isFinite(choice) || choice < 1 || choice > videos.length) {
    return { success: false, error: `Invalid selection "${rawChoice}". Pick a number from 1 to ${videos.length}.` };
  }

  const selected = videos[choice - 1];
  const selectedUrl = getMediaSourceUrl(selected);
  if (selectedUrl.startsWith('blob:')) {
    const blobData = await convertBlobToData(selectedUrl);
    if (!blobData) {
      return { success: false, error: 'Failed to read selected blob video.' };
    }
    return {
      success: true,
      selected: {
        type: 'blob',
        ...blobData,
        element: 'video',
        index: choice
      }
    };
  }

  return {
    success: true,
    selected: {
      type: 'url',
      url: selectedUrl,
      element: 'video',
      index: choice
    }
  };
}

// Function to detect YouTube video/audio elements
async function findYouTubeAudioElements() {
  console.log('MP3 Grabber: Searching for YouTube audio elements...');
  
  const audioData = [];
  
  try {
    // Method 1: Look for video elements (YouTube uses video elements for audio/video)
    const videoElements = document.querySelectorAll('video');
    console.log(`MP3 Grabber: Found ${videoElements.length} video elements`);
    
    for (const [index, video] of videoElements.entries()) {
      if (video.src) {
        console.log(`MP3 Grabber: Video element ${index + 1} src:`, video.src);
        
        if (video.src.startsWith('blob:')) {
          const blobData = await convertBlobToData(video.src);
          if (blobData) {
            audioData.push({
              type: 'blob',
              ...blobData,
              element: 'video',
              index: index + 1
            });
          }
        } else {
          audioData.push({
            type: 'url',
            url: video.src,
            element: 'video',
            index: index + 1
          });
        }
      }
      
      // Check for source elements within video
      const sources = video.querySelectorAll('source');
      for (const [sourceIndex, source] of sources.entries()) {
        if (source.src) {
          console.log(`MP3 Grabber: Source element ${sourceIndex + 1} src:`, source.src);
          
          if (source.src.startsWith('blob:')) {
            const blobData = await convertBlobToData(source.src);
            if (blobData) {
              audioData.push({
                type: 'blob',
                ...blobData,
                element: 'source',
                index: sourceIndex + 1
              });
            }
          } else {
            audioData.push({
              type: 'url',
              url: source.src,
              element: 'source',
              index: sourceIndex + 1
            });
          }
        }
      }
    }
    
    // Method 2: Look for audio elements (less common on YouTube but possible)
    const audioElements = document.querySelectorAll('audio');
    console.log(`MP3 Grabber: Found ${audioElements.length} audio elements`);
    
    for (const [index, audio] of audioElements.entries()) {
      if (audio.src) {
        console.log(`MP3 Grabber: Audio element ${index + 1} src:`, audio.src);
        
        if (audio.src.startsWith('blob:')) {
          const blobData = await convertBlobToData(audio.src);
          if (blobData) {
            audioData.push({
              type: 'blob',
              ...blobData,
              element: 'audio',
              index: index + 1
            });
          }
        } else {
          audioData.push({
            type: 'url',
            url: audio.src,
            element: 'audio',
            index: index + 1
          });
        }
      }
      
      const sources = audio.querySelectorAll('source');
      for (const [sourceIndex, source] of sources.entries()) {
        if (source.src) {
          console.log(`MP3 Grabber: Audio source element ${sourceIndex + 1} src:`, source.src);
          
          if (source.src.startsWith('blob:')) {
            const blobData = await convertBlobToData(source.src);
            if (blobData) {
              audioData.push({
                type: 'blob',
                ...blobData,
                element: 'audio-source',
                index: sourceIndex + 1
              });
            }
          } else {
            audioData.push({
              type: 'url',
              url: source.src,
              element: 'audio-source',
              index: sourceIndex + 1
            });
          }
        }
      }
    }
    
    // Method 3: Look for YouTube's internal video player data
    const videoPlayer = document.querySelector('#movie_player, .html5-video-player');
    if (videoPlayer) {
      console.log('MP3 Grabber: Found YouTube video player');
      
      // Try to access YouTube's internal video data
      try {
        // Look for YouTube's video data in various possible locations
        let videoData = null;
        
        // Try different ways to access YouTube's player data
        if (window.ytInitialPlayerResponse) {
          videoData = window.ytInitialPlayerResponse;
          console.log('MP3 Grabber: Found ytInitialPlayerResponse');
        } else if (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
          videoData = window.ytplayer.config.args;
          console.log('MP3 Grabber: Found ytplayer.config.args');
        } else if (window.ytInitialData) {
          videoData = window.ytInitialData;
          console.log('MP3 Grabber: Found ytInitialData');
        }
        
        if (videoData) {
          console.log('MP3 Grabber: YouTube video data structure:', videoData);
          
          // Extract video URLs from YouTube's data structure
          if (videoData.streamingData && videoData.streamingData.formats) {
            console.log(`MP3 Grabber: Found ${videoData.streamingData.formats.length} formats`);
            videoData.streamingData.formats.forEach((format, index) => {
              if (format.url) {
                console.log(`MP3 Grabber: YouTube format ${index + 1}:`, {
                  url: format.url,
                  quality: format.qualityLabel || format.quality || 'unknown',
                  mimeType: format.mimeType || 'unknown',
                  bitrate: format.bitrate || 'unknown'
                });
                audioData.push({
                  type: 'url',
                  url: format.url,
                  element: 'youtube-format',
                  index: index + 1,
                  quality: format.qualityLabel || format.quality || 'unknown',
                  mimeType: format.mimeType || 'unknown',
                  bitrate: format.bitrate || 'unknown'
                });
              }
            });
          }
          
          if (videoData.streamingData && videoData.streamingData.adaptiveFormats) {
            console.log(`MP3 Grabber: Found ${videoData.streamingData.adaptiveFormats.length} adaptive formats`);
            videoData.streamingData.adaptiveFormats.forEach((format, index) => {
              if (format.url) {
                console.log(`MP3 Grabber: YouTube adaptive format ${index + 1}:`, {
                  url: format.url,
                  quality: format.qualityLabel || format.quality || 'unknown',
                  mimeType: format.mimeType || 'unknown',
                  bitrate: format.bitrate || 'unknown'
                });
                audioData.push({
                  type: 'url',
                  url: format.url,
                  element: 'youtube-adaptive',
                  index: index + 1,
                  quality: format.qualityLabel || format.quality || 'unknown',
                  mimeType: format.mimeType || 'unknown',
                  bitrate: format.bitrate || 'unknown'
                });
              }
            });
          }
          
          // Also check for video details
          if (videoData.videoDetails) {
            console.log('MP3 Grabber: Video details:', {
              title: videoData.videoDetails.title,
              duration: videoData.videoDetails.lengthSeconds,
              author: videoData.videoDetails.author
            });
          }
        } else {
          console.log('MP3 Grabber: No YouTube video data found in any known location');
          console.log('MP3 Grabber: Available window objects:', Object.keys(window).filter(key => key.includes('yt')));
        }
      } catch (error) {
        console.log('MP3 Grabber: Could not access YouTube internal data:', error.message);
      }
    }
    
    // Method 4: Look for blob URLs in other elements
    const allElements = document.querySelectorAll('*');
    for (const element of allElements) {
      for (const attr of ['src', 'href']) {
        const url = element[attr];
        if (url && url.startsWith('blob:')) {
          console.log(`MP3 Grabber: Found blob URL in ${element.tagName}:`, url);
          
          // Only process if we haven't already processed this blob URL
          const alreadyProcessed = audioData.some(item => 
            item.type === 'blob' && item.originalUrl === url
          );
          
          if (!alreadyProcessed) {
            const blobData = await convertBlobToData(url);
            if (blobData) {
              audioData.push({
                type: 'blob',
                ...blobData,
                element: element.tagName.toLowerCase(),
                attribute: attr
              });
            }
          }
        }
      }
    }
    
  } catch (error) {
    console.error('MP3 Grabber: Error searching for audio elements:', error);
  }
  
  console.log(`MP3 Grabber: Found ${audioData.length} audio/video elements:`, audioData);
  return audioData;
}

// Function to get current video information
function getCurrentVideoInfo() {
  try {
    const videoTitle = document.querySelector('h1.title, h1.ytd-video-primary-info-renderer')?.textContent?.trim();
    const channelName = document.querySelector('#owner-name a, #channel-name a')?.textContent?.trim();
    const videoId = new URLSearchParams(window.location.search).get('v');
    
    return {
      title: videoTitle || 'Unknown Title',
      channel: channelName || 'Unknown Channel',
      videoId: videoId || 'unknown',
      url: window.location.href
    };
  } catch (error) {
    console.error('MP3 Grabber: Error getting video info:', error);
    return {
      title: 'Unknown Title',
      channel: 'Unknown Channel',
      videoId: 'unknown',
      url: window.location.href
    };
  }
}

// Simple, immediate message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('MP3 Grabber: Message received:', request);
  console.log('MP3 Grabber: Sender:', sender);
  
  if (request.action === 'findAudioLinks') {
    console.log('MP3 Grabber: Processing findAudioLinks request immediately');
    
    // Handle async function properly
    (async () => {
      try {
        // Execute immediately and return result
        const audioData = await findYouTubeAudioElementsSync();
        const videoInfo = getCurrentVideoInfo();
        
        const response = {
          audioData: audioData,
          videoInfo: videoInfo,
          pageUrl: window.location.href,
          timestamp: Date.now(),
          success: true
        };
        
        console.log('MP3 Grabber: Sending immediate response:', response);
        sendResponse(response);
      } catch (error) {
        console.error('MP3 Grabber: Error in immediate processing:', error);
        sendResponse({
          error: error.message,
          pageUrl: window.location.href,
          timestamp: Date.now(),
          success: false
        });
      }
    })();
    
    return true; // Keep message channel open
  } else if (request.action === 'selectSingleVideo') {
    (async () => {
      try {
        const selection = await selectSingleVideoElement();
        sendResponse(selection);
      } catch (error) {
        sendResponse({ success: false, error: error.message || 'Failed selecting video.' });
      }
    })();
    return true;
  } else {
    console.log('MP3 Grabber: Unknown action:', request.action);
    sendResponse({ error: 'Unknown action', success: false });
  }
});

// Global function registration for testing
window.mp3GrabberTest = function() {
  console.log('MP3 Grabber: Test function called');
  const audioData = findYouTubeAudioElementsSync();
  const videoInfo = getCurrentVideoInfo();
  return {
    success: true,
    audioData: audioData,
    videoInfo: videoInfo,
    url: window.location.href,
    youtubeObjects: Object.keys(window).filter(key => key.includes('yt'))
  };
};

console.log('MP3 Grabber: YouTube content script ready');
console.log('MP3 Grabber: Test function available at window.mp3GrabberTest()');
console.log('MP3 Grabber: Message listener registered');

