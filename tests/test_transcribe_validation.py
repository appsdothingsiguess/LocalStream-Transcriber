#!/usr/bin/env python3
"""
Test script to demonstrate the validation and error handling
improvements in the refactored transcribe.py
"""

import os
import sys
import json
import tempfile
import subprocess

def run_transcribe(file_path, description):
    """Run transcribe.py and capture output."""
    print("=" * 70)
    print(f"TEST: {description}")
    print("=" * 70)
    print(f"File: {file_path}")
    print()
    
    try:
        result = subprocess.run(
            [sys.executable, 'transcribe.py', file_path],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        print("STDOUT:")
        print(result.stdout)
        print()
        
        if result.stderr:
            print("STDERR (Logs):")
            print(result.stderr)
            print()
        
        # Try to parse JSON output
        try:
            for line in result.stdout.split('\n'):
                if line.strip().startswith('{'):
                    output = json.loads(line)
                    print("Parsed JSON Output:")
                    print(f"  Success: {output.get('success')}")
                    print(f"  Error: {output.get('error', 'N/A')}")
                    break
        except json.JSONDecodeError:
            print("Could not parse JSON output")
        
        print()
        
    except subprocess.TimeoutExpired:
        print("❌ Test timed out (>10 seconds)")
        print()
    except Exception as e:
        print(f"❌ Test error: {e}")
        print()

def main():
    print("=" * 70)
    print("TRANSCRIBE.PY VALIDATION TEST SUITE")
    print("=" * 70)
    print()
    
    # Test 1: Non-existent file
    run_transcribe(
        "nonexistent_file.mp4",
        "Non-existent file (should fail validation)"
    )
    
    # Test 2: Empty file
    empty_file = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', suffix='.mp4', delete=False) as f:
            empty_file = f.name
        
        run_transcribe(
            empty_file,
            "Empty file (0 bytes, should fail validation)"
        )
    finally:
        if empty_file and os.path.exists(empty_file):
            os.remove(empty_file)
    
    # Test 3: Very small file
    tiny_file = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', suffix='.mp4', delete=False) as f:
            f.write("x")  # 1 byte
            tiny_file = f.name
        
        run_transcribe(
            tiny_file,
            "Tiny file (1 byte, should fail validation)"
        )
    finally:
        if tiny_file and os.path.exists(tiny_file):
            os.remove(tiny_file)
    
    # Test 4: Directory instead of file
    test_dir = tempfile.mkdtemp()
    try:
        run_transcribe(
            test_dir,
            "Directory instead of file (should fail validation)"
        )
    finally:
        if os.path.exists(test_dir):
            os.rmdir(test_dir)
    
    # Test 5: Unusual extension
    unusual_file = None
    try:
        with tempfile.NamedTemporaryFile(mode='wb', suffix='.txt', delete=False) as f:
            f.write(b"x" * 1000)  # 1000 bytes
            unusual_file = f.name
        
        run_transcribe(
            unusual_file,
            "Text file with .txt extension (should warn about extension)"
        )
    finally:
        if unusual_file and os.path.exists(unusual_file):
            os.remove(unusual_file)
    
    print("=" * 70)
    print("TEST SUITE COMPLETE")
    print("=" * 70)
    print()
    print("Expected Results:")
    print("  ✅ Test 1: File not found error")
    print("  ✅ Test 2: Empty file error")
    print("  ✅ Test 3: File too small error")
    print("  ✅ Test 4: Not a file error")
    print("  ✅ Test 5: Warning about unusual extension")
    print()
    print("All tests should fail gracefully with clear error messages,")
    print("demonstrating the robust validation and error handling.")

if __name__ == "__main__":
    main()
