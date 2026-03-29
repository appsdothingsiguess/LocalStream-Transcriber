// test_queue.js
// Simple test to demonstrate the JobQueue deduplication logic

class JobQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.currentJob = null;
    this.completedIds = new Set();
  }

  extractEntryId(url) {
    if (!url) return null;
    
    // Match Kaltura entryId pattern: /entryId/[ID]/
    const kalturaMatch = url.match(/\/entryId\/([^\/]+)\//);
    if (kalturaMatch) {
      return kalturaMatch[1];
    }
    
    // For non-Kaltura URLs, use the full URL as the identifier
    return url;
  }

  isDuplicate(entryId) {
    if (!entryId) return false;
    
    // Check if currently processing
    if (this.currentJob && this.currentJob.entryId === entryId) {
      return true;
    }
    
    // Check if in queue
    const inQueue = this.queue.some(job => job.entryId === entryId);
    if (inQueue) {
      return true;
    }
    
    // Check if already completed in this session
    if (this.completedIds.has(entryId)) {
      return true;
    }
    
    return false;
  }

  enqueue(job) {
    const entryId = this.extractEntryId(job.url);
    job.entryId = entryId;
    
    if (this.isDuplicate(entryId)) {
      console.log(`⏭️  [SKIP] Duplicate stream detected: ${entryId || 'unknown'}`);
      return false;
    }
    
    this.queue.push(job);
    console.log(`📥 [QUEUE] Added job ${job.jobId} (entryId: ${entryId || 'N/A'}) - Queue size: ${this.queue.length}`);
    return true;
  }

  simulateCompletion() {
    if (this.queue.length === 0) {
      console.log('No jobs to process');
      return;
    }
    
    const job = this.queue.shift();
    this.currentJob = job;
    console.log(`🚀 [QUEUE] Processing job ${job.jobId}`);
    
    // Simulate completion
    if (job.entryId) {
      this.completedIds.add(job.entryId);
    }
    console.log(`✅ [QUEUE] Job ${job.jobId} completed`);
    this.currentJob = null;
  }

  getStatus() {
    return {
      queueSize: this.queue.length,
      processing: this.processing,
      currentJob: this.currentJob ? this.currentJob.jobId : null,
      completedCount: this.completedIds.size
    };
  }
}

// ============================================================================
// TEST SCENARIOS
// ============================================================================

console.log('='.repeat(80));
console.log('Job Queue Deduplication Test');
console.log('='.repeat(80));
console.log();

const queue = new JobQueue();

// Test 1: Add multiple URLs for same Kaltura video (master + variants)
console.log('TEST 1: Multiple URLs for same Kaltura video');
console.log('-'.repeat(80));

const kalturaId = '1_abc123xyz';
const urls = [
  `https://example.com/p/123/sp/12300/playManifest/entryId/${kalturaId}/format/url/protocol/https/flavorIds/1_master`,
  `https://example.com/p/123/sp/12300/playManifest/entryId/${kalturaId}/format/url/protocol/https/flavorIds/1_720p`,
  `https://example.com/p/123/sp/12300/playManifest/entryId/${kalturaId}/format/url/protocol/https/flavorIds/1_480p`,
  `https://example.com/p/123/sp/12300/playManifest/entryId/${kalturaId}/format/url/protocol/https/flavorIds/1_360p`
];

urls.forEach((url, index) => {
  const result = queue.enqueue({
    jobId: `job-${index + 1}`,
    url: url
  });
  console.log(`Result: ${result ? 'Added ✅' : 'Skipped ❌'}`);
  console.log();
});

console.log('Queue Status:', queue.getStatus());
console.log();

// Test 2: Process first job and try to add duplicate again
console.log('TEST 2: Process job and check completed IDs');
console.log('-'.repeat(80));

queue.simulateCompletion();
console.log();

// Try to add the same video again
const resultAfterCompletion = queue.enqueue({
  jobId: 'job-retry',
  url: urls[0]
});
console.log(`Result: ${resultAfterCompletion ? 'Added ✅' : 'Skipped ❌'}`);
console.log();

console.log('Queue Status:', queue.getStatus());
console.log();

// Test 3: Different video should be added
console.log('TEST 3: Different Kaltura video should be added');
console.log('-'.repeat(80));

const differentVideo = `https://example.com/p/123/sp/12300/playManifest/entryId/1_different/format/url`;
const resultDifferent = queue.enqueue({
  jobId: 'job-different',
  url: differentVideo
});
console.log(`Result: ${resultDifferent ? 'Added ✅' : 'Skipped ❌'}`);
console.log();

console.log('Queue Status:', queue.getStatus());
console.log();

// Test 4: Non-Kaltura URLs
console.log('TEST 4: Non-Kaltura URLs use full URL as identifier');
console.log('-'.repeat(80));

const regularUrl = 'https://example.com/videos/lecture1.mp4';
const sameRegularUrl = 'https://example.com/videos/lecture1.mp4';
const differentRegularUrl = 'https://example.com/videos/lecture2.mp4';

queue.enqueue({ jobId: 'regular-1', url: regularUrl });
queue.enqueue({ jobId: 'regular-2', url: sameRegularUrl }); // Should be skipped
queue.enqueue({ jobId: 'regular-3', url: differentRegularUrl }); // Should be added
console.log();

console.log('Final Queue Status:', queue.getStatus());
console.log();

console.log('='.repeat(80));
console.log('Test Complete!');
console.log('='.repeat(80));
console.log();
console.log('Summary:');
console.log('✅ Kaltura videos are deduplicated by entryId');
console.log('✅ Multiple URLs (master + variants) for same video are detected');
console.log('✅ Completed videos are tracked and rejected if re-requested');
console.log('✅ Regular URLs are deduplicated by full URL');
console.log('✅ Different videos are properly added to queue');
