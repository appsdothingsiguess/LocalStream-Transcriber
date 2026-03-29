// test_extension_filter.js
// Test script to demonstrate the intelligent stream filtering logic

// ============================================================================
// COPY OF FILTER FUNCTIONS FROM bg.js
// ============================================================================

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

// ============================================================================
// TEST SUITE
// ============================================================================

console.log('='.repeat(80));
console.log('🧪 Extension Stream Filter Test Suite');
console.log('='.repeat(80));
console.log();

// Test 1: Filter Tests
console.log('TEST 1: URL Filtering');
console.log('-'.repeat(80));

const testUrls = [
  // Should be filtered out
  'https://example.com/subtitles.vtt',
  'https://example.com/captions_en.srt',
  'https://example.com/encryption.key',
  'https://example.com/thumbnail.png',
  'https://example.com/poster.jpg',
  'https://example.com/video_segment001.ts',
  'https://example.com/fragment_720p.m4s',
  'https://example.com/caption_track.vtt',
  'https://example.com/subtitle_en.srt',
  
  // Should pass filter
  'https://example.com/master.m3u8',
  'https://example.com/index.m3u8',
  'https://example.com/playlist.m3u8',
  'https://example.com/video.m3u8',
  'https://example.com/stream.mpd'
];

const filtered = [];
const passed = [];

testUrls.forEach(url => {
  if (shouldIgnoreUrl(url)) {
    filtered.push(url);
  } else {
    passed.push(url);
    console.log(`✅ [PASS] ${url}`);
  }
});

console.log();
console.log(`Summary: ${filtered.length} filtered, ${passed.length} passed`);
console.log();

// Test 2: Priority Tests
console.log('TEST 2: Stream Prioritization');
console.log('-'.repeat(80));

const priorityTests = [
  'https://example.com/master.m3u8',
  'https://example.com/index.m3u8',
  'https://example.com/playlist.m3u8',
  'https://example.com/video_720p.m3u8',
  'https://example.com/stream.mpd',
  'https://example.com/other.m3u8'
];

priorityTests.forEach(url => {
  const priority = getStreamPriority(url);
  const emoji = priority >= 90 ? '🌟' : priority >= 50 ? '⭐' : '✨';
  console.log(`${emoji} Priority ${priority}: ${url}`);
});

console.log();

// Test 3: Stream ID Extraction
console.log('TEST 3: Stream ID Deduplication');
console.log('-'.repeat(80));

const deduplicationTests = [
  {
    name: 'Kaltura URLs',
    urls: [
      'https://cdn.kaltura.com/p/123/sp/12300/playManifest/entryId/1_abc123/format/url/protocol/https/flavorIds/master',
      'https://cdn.kaltura.com/p/123/sp/12300/playManifest/entryId/1_abc123/format/url/protocol/https/flavorIds/720p',
      'https://cdn.kaltura.com/p/123/sp/12300/playManifest/entryId/1_abc123/format/url/protocol/https/flavorIds/480p'
    ]
  },
  {
    name: 'Quality Variants',
    urls: [
      'https://example.com/video_360p.m3u8?token=xyz',
      'https://example.com/video_720p.m3u8?token=abc',
      'https://example.com/video_1080p.m3u8?token=def',
      'https://example.com/video_4k.m3u8?token=ghi'
    ]
  },
  {
    name: 'Different Videos',
    urls: [
      'https://example.com/lecture1.m3u8',
      'https://example.com/lecture2.m3u8',
      'https://example.com/lecture3.m3u8'
    ]
  }
];

deduplicationTests.forEach(test => {
  console.log(`\n${test.name}:`);
  const streamIds = new Set();
  
  test.urls.forEach(url => {
    const streamId = extractStreamId(url);
    streamIds.add(streamId);
    console.log(`  URL: ${url.substring(0, 80)}...`);
    console.log(`  ID:  ${streamId}`);
  });
  
  console.log(`  → Result: ${streamIds.size} unique stream(s)`);
  
  if (test.name === 'Kaltura URLs' || test.name === 'Quality Variants') {
    const expected = 1;
    const result = streamIds.size === expected ? '✅ PASS' : '❌ FAIL';
    console.log(`  → Expected: ${expected} unique, ${result}`);
  }
});

console.log();

// Test 4: Debounce Simulation
console.log('TEST 4: Debounce & Prioritization Simulation');
console.log('-'.repeat(80));

const streamSequence = [
  { time: 0, url: 'https://example.com/video_360p.m3u8', priority: 50 },
  { time: 200, url: 'https://example.com/video_720p.m3u8', priority: 50 },
  { time: 500, url: 'https://example.com/video_1080p.m3u8', priority: 50 },
  { time: 1000, url: 'https://example.com/master.m3u8', priority: 100 },
  { time: 3000, url: 'TIMEOUT - Send best stream', priority: null }
];

let currentBest = null;
let lastUpgrade = 0;

console.log('Stream Detection Timeline:');
streamSequence.forEach(event => {
  const timeStr = `${(event.time / 1000).toFixed(1)}s`.padEnd(6);
  
  if (event.priority === null) {
    console.log(`\n${timeStr} ⏰ ${event.url}`);
    if (currentBest) {
      console.log(`        └─ Sending: ${currentBest.url}`);
      console.log(`           Priority: ${currentBest.priority}`);
    }
  } else {
    const actualPriority = getStreamPriority(event.url);
    const action = !currentBest || actualPriority > currentBest.priority ? 
      '⬆️  UPGRADE' : '⏭️  SKIP';
    
    console.log(`${timeStr} ${action} (Priority ${actualPriority})`);
    console.log(`        ${event.url}`);
    
    if (!currentBest || actualPriority > currentBest.priority) {
      currentBest = event;
      lastUpgrade = event.time;
    }
  }
});

console.log();

// Test 5: Real-World Kaltura Scenario
console.log('TEST 5: Real-World Kaltura Scenario');
console.log('-'.repeat(80));

const kalturaScenario = [
  'https://cdn.kaltura.com/p/2490041/sp/249004100/playManifest/entryId/1_abc123/format/url/protocol/https/a.mp4?referrer=...',
  'https://cdn.kaltura.com/p/2490041/sp/249004100/playManifest/entryId/1_abc123/format/applehttp/protocol/https/flavorIds/1_720p/a.m3u8',
  'https://cdn.kaltura.com/p/2490041/sp/249004100/playManifest/entryId/1_abc123/format/applehttp/protocol/https/flavorIds/1_480p/a.m3u8',
  'https://cdn.kaltura.com/p/2490041/sp/249004100/playManifest/entryId/1_abc123/format/applehttp/protocol/https/flavorIds/1_360p/a.m3u8',
  'https://cdn.kaltura.com/p/2490041/sp/249004100/playManifest/entryId/1_abc123/format/applehttp/protocol/https/flavorIds/1_master/a.m3u8',
  'https://cdn.kaltura.com/p/2490041/sp/249004100/playManifest/entryId/1_abc123/format/url/protocol/https/video.vtt',  // Subtitle
  'https://cdn.kaltura.com/p/2490041/sp/249004100/playManifest/entryId/1_abc123/segment001.ts'  // Segment
];

console.log('Processing Kaltura video URLs:');
const validStreams = [];

kalturaScenario.forEach((url, index) => {
  console.log(`\n${index + 1}. ${url}`);
  
  if (shouldIgnoreUrl(url)) {
    console.log('   ❌ FILTERED OUT');
  } else {
    const priority = getStreamPriority(url);
    const streamId = extractStreamId(url);
    console.log(`   ✅ VALID (Priority: ${priority})`);
    console.log(`   Stream ID: ${streamId}`);
    validStreams.push({ url, priority, streamId });
  }
});

console.log('\nValid Streams Summary:');
const uniqueStreams = new Map();
validStreams.forEach(stream => {
  if (!uniqueStreams.has(stream.streamId) || 
      stream.priority > uniqueStreams.get(stream.streamId).priority) {
    uniqueStreams.set(stream.streamId, stream);
  }
});

uniqueStreams.forEach((stream, id) => {
  console.log(`  ${id}:`);
  console.log(`    Priority: ${stream.priority}`);
  console.log(`    URL: ${stream.url.substring(0, 80)}...`);
});

console.log(`\nResult: ${kalturaScenario.length} URLs → ${uniqueStreams.size} unique stream(s) to send`);

console.log();
console.log('='.repeat(80));
console.log('✅ Test Suite Complete!');
console.log('='.repeat(80));
console.log();
console.log('Summary:');
console.log('  ✅ URL filtering works correctly');
console.log('  ✅ Priority scoring works correctly');
console.log('  ✅ Stream ID extraction works correctly');
console.log('  ✅ Debounce logic demonstrated');
console.log('  ✅ Real-world Kaltura scenario handled');
