document.getElementById('queueAll').addEventListener('click', async () => {
  const statusDiv = document.getElementById('status');
  statusDiv.className = '';
  statusDiv.textContent = 'Queueing detected streams...';
  statusDiv.style.display = 'block';
  
  try {
    // Send message to background to flush all pending streams
    chrome.runtime.sendMessage({ 
      action: 'flushAllStreams'
    }, (response) => {
      if (chrome.runtime.lastError) {
        statusDiv.className = 'error';
        statusDiv.textContent = 'Error: ' + chrome.runtime.lastError.message;
        return;
      }
      
      if (response && response.success) {
        statusDiv.className = 'success';
        const count = response.count || 0;
        if (count === 0) {
          statusDiv.textContent = '⚠️ No streams detected. Play a video first.';
        } else {
          statusDiv.textContent = `✓ Queued ${count} stream(s)`;
          setTimeout(() => window.close(), 2000);
        }
      } else {
        statusDiv.className = 'error';
        statusDiv.textContent = response?.error || 'Failed to queue streams';
      }
    });
  } catch (error) {
    statusDiv.className = 'error';
    statusDiv.textContent = 'Error: ' + error.message;
  }
});

document.getElementById('manualTrigger').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'manualTrigger' }, () => {
    window.close();
  });
});

document.getElementById('queueSingle').addEventListener('click', async () => {
  const statusDiv = document.getElementById('status');
  statusDiv.className = '';
  statusDiv.textContent = 'Select one video in the page prompt...';
  statusDiv.style.display = 'block';

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];

    if (!tab || !tab.id) {
      statusDiv.className = 'error';
      statusDiv.textContent = 'No active tab found.';
      return;
    }

    chrome.runtime.sendMessage({
      action: 'queueSingleVideo',
      tabId: tab.id
    }, (response) => {
      if (chrome.runtime.lastError) {
        statusDiv.className = 'error';
        statusDiv.textContent = 'Error: ' + chrome.runtime.lastError.message;
        return;
      }

      if (response && response.success) {
        statusDiv.className = 'success';
        if (response.mode === 'fallback-stream') {
          statusDiv.textContent = '✓ Queued latest detected stream';
        } else {
          statusDiv.textContent = '✓ Queued selected video';
        }
        setTimeout(() => window.close(), 1500);
      } else {
        statusDiv.className = 'error';
        statusDiv.textContent = response?.error || 'Failed to queue selected video';
      }
    });
  } catch (error) {
    statusDiv.className = 'error';
    statusDiv.textContent = 'Error: ' + error.message;
  }
});
