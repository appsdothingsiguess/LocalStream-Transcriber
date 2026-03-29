#!/usr/bin/env python3
import sys
import os
import warnings
import json
import time
from datetime import datetime
from faster_whisper import WhisperModel
from faster_whisper.utils import download_model

# Suppress warnings for cleaner output
warnings.filterwarnings("ignore", category=UserWarning)

def _sidecar_path(audio_file):
    """Path for the JSON sidecar that persists transcription results to disk."""
    return os.path.join(
        os.path.dirname(audio_file),
        os.path.splitext(os.path.basename(audio_file))[0] + ".transcribe_result.json"
    )

def transcribe_audio(audio_file, model_size="medium", use_gpu=True):
    """Transcribe audio file using faster-whisper"""
    try:
        # Determine device and compute type
        device = "cuda" if use_gpu else "cpu"
        # Use float32 for CPU to get better quality (int8 quantizes and reduces accuracy)
        # For GPU, use float16 for speed/quality balance
        compute_type = "float16" if use_gpu else "float32"
        
        print(f"STATUS:Initializing {device.upper()} processing...", flush=True)
        
        # Resolve model to an actual local path/repo before loading so setup can
        # display what was really loaded (not just configured size string).
        resolved_model_path = model_size
        resolved_model_id = model_size
        if not os.path.isdir(model_size):
            resolved_model_path = download_model(model_size)
            path_parts = resolved_model_path.replace("\\", "/").split("/")
            snapshots_idx = path_parts.index("snapshots") if "snapshots" in path_parts else -1
            if snapshots_idx > 0:
                resolved_model_id = path_parts[snapshots_idx - 1].replace("models--", "").replace("--", "/")
        
        # Load model with timing
        print(f"STATUS:Loading Whisper model ({model_size})...", flush=True)
        print(f"STATUS:Resolved model source: {resolved_model_id}", flush=True)
        print(f"STATUS:Resolved model path: {resolved_model_path}", flush=True)
        print(f"STATUS:Checking cache (downloading if needed)...", flush=True)
        
        start_time = time.time()
        model = WhisperModel(resolved_model_path, device=device, compute_type=compute_type)
        load_time = time.time() - start_time
        
        # Determine if it was cached based on load time
        # Cached models load very quickly (< 2s for GPU, < 3s for CPU)
        if use_gpu:
            is_cached = load_time < 2.0
        else:
            is_cached = load_time < 3.0
        
        if is_cached:
            print(f"STATUS:Model loaded from cache ({load_time:.1f}s)", flush=True)
        else:
            print(f"STATUS:Model downloaded and loaded ({load_time:.1f}s)", flush=True)
        
        print(f"STATUS:Starting transcription...", flush=True)
        # Transcribe
        segments, info = model.transcribe(audio_file, beam_size=5)
        
        print(f"STATUS:Processing segments...", flush=True)
        # Collect segments with timestamps
        transcript_text = ""
        segment_count = 0
        for segment in segments:
            start_time = segment.start
            end_time = segment.end
            # Format timestamps as [MM:SS.mmm]
            start_formatted = f"[{int(start_time//60):02d}:{start_time%60:06.3f}]"
            end_formatted = f"[{int(end_time//60):02d}:{end_time%60:06.3f}]"
            transcript_text += f"{start_formatted} {segment.text.strip()}\n"
            segment_count += 1
            if segment_count % 10 == 0:  # Progress update every 10 segments
                print(f"STATUS:Processed {segment_count} segments...", flush=True)
        
        print(f"STATUS:Transcription complete!", flush=True)

        result = {
            "success": True,
            "transcript": transcript_text.strip(),
            "language": info.language,
            "language_probability": info.language_probability,
            "device": device,
            "compute_type": compute_type,
            "model_size": model_size,
            "resolved_model_id": resolved_model_id,
            "resolved_model_path": resolved_model_path,
            "segment_count": segment_count
        }

        # CRITICAL: Emit the full result to stdout IMMEDIATELY.
        # A background CUDA thread can crash the process at any moment after
        # the last segment.  stdout is captured by Node's execSync even on
        # crash, making this the most reliable way to persist the data.
        try:
            sys.stdout.write("RESULT_JSON:" + json.dumps(result) + "\n")
            sys.stdout.flush()
        except Exception:
            pass

        # Secondary backup: persist to sidecar JSON on disk with fsync.
        try:
            sp = _sidecar_path(audio_file)
            with open(sp, "w", encoding="utf-8") as f:
                f.write(json.dumps(result))
                f.flush()
                os.fsync(f.fileno())
            print("RESULT:SUCCESS", flush=True)
        except Exception:
            pass

        # Save the .txt transcription file while model is still alive.
        try:
            out = save_transcription(
                transcript_text.strip(), audio_file, device, compute_type,
                info.language, info.language_probability, model_size
            )
            if out:
                result["output_file"] = out
        except Exception:
            pass

        return result
        
    except Exception as e:
        error_msg = str(e)
        return {
            "success": False,
            "error": error_msg,
            "device": device,
            "compute_type": compute_type,
            "model_size": model_size,
            "resolved_model_id": resolved_model_id if 'resolved_model_id' in locals() else model_size,
            "resolved_model_path": resolved_model_path if 'resolved_model_path' in locals() else model_size
        }

def check_gpu_availability():
    """Check if GPU libraries are available"""
    # Debug: print what we're checking
    print("DEBUG:Checking GPU availability...", flush=True)
    
    # First try torch (most reliable)
    try:
        import torch
        print(f"DEBUG:torch imported, cuda available: {torch.cuda.is_available()}", flush=True)
        if torch.cuda.is_available():
            print("DEBUG:GPU available via torch.cuda", flush=True)
            return True
    except ImportError as e:
        print(f"DEBUG:torch not available: {e}", flush=True)
        pass
    
    # Then try CUDA libraries
    try:
        import nvidia.cublas
        import nvidia.cudnn
        print("DEBUG:CUDA libraries imported successfully", flush=True)
        # If we can import both, assume GPU is available
        # The actual transcription will fallback to CPU if GPU fails
        return True
    except ImportError as e:
        print(f"DEBUG:CUDA libraries not available: {e}", flush=True)
        return False

def save_transcription(transcript, audio_file, device, compute_type, language, confidence, model_size):
    """Save transcription to transcriptions folder"""
    try:
        # Get base filename without extension
        base_name = os.path.splitext(os.path.basename(audio_file))[0]
        
        # Create transcriptions directory if it doesn't exist
        transcriptions_dir = os.path.join(os.path.dirname(audio_file), "..", "transcriptions")
        os.makedirs(transcriptions_dir, exist_ok=True)
        
        # Create output file path
        output_file = os.path.join(transcriptions_dir, f"{base_name}.txt")
        
        # Create header with metadata
        header = f"""Transcription Results
Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
Source: {os.path.basename(audio_file)}
Device: {device.upper()}
Compute Type: {compute_type}
Model Size: {model_size}
Language: {language} ({confidence:.1%} confidence)

--- TRANSCRIPTION ---
"""
        
        # Write to file
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(header)
            f.write(transcript)
        
        return output_file
    except Exception as e:
        return None

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(json.dumps({"success": False, "error": "Usage: python transcribe.py <audio_file>"}))
        sys.exit(1)
    
    audio_file = sys.argv[1]
    if not os.path.exists(audio_file):
        print(json.dumps({"success": False, "error": f"Audio file not found: {audio_file}"}))
        sys.exit(1)
    
    # Check GPU availability first
    gpu_available = check_gpu_availability()
    
    # Try GPU first if available, otherwise use CPU
    # Use "medium" model for GPU, "base" model for CPU (better performance on CPU)
    if gpu_available:
        result = transcribe_audio(audio_file, model_size="medium", use_gpu=True)
        if not result["success"] and ("CUDA" in result["error"] or "cudnn" in result["error"].lower() or "cublas" in result["error"].lower()):
            # Fallback to CPU if GPU fails
            result = transcribe_audio(audio_file, model_size="base", use_gpu=False)
    else:
        # Use CPU directly with base model
        result = transcribe_audio(audio_file, model_size="base", use_gpu=False)
    
    # save_transcription() is now called inside transcribe_audio() so the .txt
    # file is written before the model destructor can crash the process.

    print(json.dumps(result), flush=True)
    sys.stdout.flush()
    sys.stderr.flush()

    # Hard-exit to skip Python interpreter teardown.  CUDA/CTranslate2 DLL
    # unload during normal exit triggers STATUS_STACK_BUFFER_OVERRUN (0xC0000409)
    # on Windows.  The RESULT_JSON line and sidecar written inside
    # transcribe_audio() ensure Node can recover even if this is bypassed.
    os._exit(0)
