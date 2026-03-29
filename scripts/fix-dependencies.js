#!/usr/bin/env node

/**
 * Fix corrupted node_modules installation
 * 
 * This script deletes node_modules and package-lock.json,
 * then reinstalls dependencies to fix "Cannot find module" errors.
 */

import { existsSync, rmSync } from 'fs';
import { execSync } from 'child_process';

console.log('🔧 Fixing corrupted node_modules...\n');

// Delete node_modules if it exists
if (existsSync('node_modules')) {
  console.log('🗑️  Deleting node_modules...');
  try {
    rmSync('node_modules', { recursive: true, force: true });
    console.log('✅ Deleted node_modules');
  } catch (error) {
    console.error('❌ Failed to delete node_modules:', error.message);
    console.error('   Please delete it manually and run: npm install');
    process.exit(1);
  }
} else {
  console.log('ℹ️  node_modules not found (already clean)');
}

// Delete package-lock.json if it exists
if (existsSync('package-lock.json')) {
  console.log('🗑️  Deleting package-lock.json...');
  try {
    rmSync('package-lock.json', { force: true });
    console.log('✅ Deleted package-lock.json');
  } catch (error) {
    console.error('❌ Failed to delete package-lock.json:', error.message);
  }
} else {
  console.log('ℹ️  package-lock.json not found (already clean)');
}

// Clear npm cache
console.log('\n🧹 Clearing npm cache...');
try {
  execSync('npm cache clean --force', { stdio: 'inherit' });
  console.log('✅ npm cache cleared');
} catch (error) {
  console.warn('⚠️  Failed to clear npm cache (this is usually okay)');
}

// Reinstall dependencies
console.log('\n📦 Reinstalling dependencies...');
try {
  execSync('npm install', { stdio: 'inherit' });
  console.log('\n✅ Dependencies reinstalled successfully!');
  console.log('   You can now run: npm run setup');
} catch (error) {
  console.error('\n❌ Failed to reinstall dependencies');
  console.error('   Error:', error.message);
  console.error('   Please run manually: npm install');
  process.exit(1);
}
