#!/usr/bin/env python3
# TRANSCRIBE_SCRIPT_VERSION = 3 — incremental disk writes for Windows CUDA teardown crashes
import sys
import os
import warnings
import json
import time
from datetime import datetime
from faster_whisper import WhisperModel
from faster_whisper.utils import download_model

warnings.filterwarnings("ignore", category=UserWarning)

TRANSCRIBE_SCRIPT_VERSION = 3
FLUSH_SEGMENTS_EVERY = 1
FLUSH_SIDECAR_EVERY = 10


def resolve_transcriptions_dir(audio_file):
    root = os.environ.get("MP3GRABBER_ROOT")
    if root:
        return os.path.join(root, "transcriptions")
    return os.path.normpath(
        os.path.join(os.path.dirname(os.path.abspath(audio_file)), "..", "transcriptions")
    )


def log_transcription_event(message):
    try:
        transcriptions_dir = resolve_transcriptions_dir(
            os.environ.get("MP3GRABBER_LAST_AUDIO", "") or "."
        )
        os.makedirs(transcriptions_dir, exist_ok=True)
        log_path = os.path.join(transcriptions_dir, "transcriptions.log")
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"[{stamp}] {message}\n")
            f.flush()
    except Exception:
        pass


def sidecar_path_for(audio_file, progress=False):
    base = os.path.splitext(os.path.basename(audio_file))[0]
    suffix = ".transcribe_progress.json" if progress else ".transcribe_result.json"
    return os.path.join(os.path.dirname(os.path.abspath(audio_file)), base + suffix)


def format_segment_line(segment):
    start_time = segment.start
    start_formatted = f"[{int(start_time // 60):02d}:{start_time % 60:06.3f}]"
    return f"{start_formatted} {segment.text.strip()}\n"


class IncrementalTranscriptWriter:
    """Stream transcript lines to disk during inference (survives Windows CUDA crashes)."""

    def __init__(self, audio_file, device, compute_type, model_size):
        self.audio_file = os.path.abspath(audio_file)
        self.device = device
        self.compute_type = compute_type
        self.model_size = model_size
        self.base_name = os.path.splitext(os.path.basename(audio_file))[0]
        transcriptions_dir = resolve_transcriptions_dir(audio_file)
        os.makedirs(transcriptions_dir, exist_ok=True)
        self.output_file = os.path.join(transcriptions_dir, f"{self.base_name}.txt")
        self.segment_count = 0
        self._write_initial_file()

    def _header(self, *, complete=False, language=None, confidence=None):
        status = "complete" if complete else "in progress"
        lang_line = ""
        if language is not None and confidence is not None:
            lang_line = f"Language: {language} ({confidence:.1%} confidence)\n"
        return f"""Transcription Results
Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
Source: {os.path.basename(self.audio_file)}
Device: {self.device.upper()}
Compute Type: {self.compute_type}
Model Size: {self.model_size}
Status: {status}
{lang_line}
--- TRANSCRIPTION ---
"""

    def _write_initial_file(self):
        with open(self.output_file, "w", encoding="utf-8") as f:
            f.write(self._header(complete=False))
            f.write("(in progress — segments stream below as they complete)\n")
            f.flush()
            os.fsync(f.fileno())
        log_transcription_event(
            f"started {self.base_name} -> {self.output_file}"
        )

    def append_segment(self, segment):
        line = format_segment_line(segment)
        with open(self.output_file, "a", encoding="utf-8") as f:
            if self.segment_count == 0:
                # Replace placeholder on first real segment
                pass
            f.write(line)
            f.flush()
            os.fsync(f.fileno())
        self.segment_count += 1
        if self.segment_count == 1:
            self._strip_progress_placeholder()
        if self.segment_count % FLUSH_SEGMENTS_EVERY == 0:
            self.write_progress_sidecar()

    def _strip_progress_placeholder(self):
        try:
            with open(self.output_file, "r", encoding="utf-8") as f:
                content = f.read()
            placeholder = "(in progress — segments stream below as they complete)\n"
            if placeholder in content:
                content = content.replace(placeholder, "", 1)
                with open(self.output_file, "w", encoding="utf-8") as f:
                    f.write(content)
                    f.flush()
                    os.fsync(f.fileno())
        except Exception:
            pass

    def write_progress_sidecar(self, language=None, language_probability=None):
        payload = {
            "success": True,
            "complete": False,
            "output_file": self.output_file,
            "segment_count": self.segment_count,
            "device": self.device,
            "compute_type": self.compute_type,
            "model_size": self.model_size,
            "language": language,
            "language_probability": language_probability,
        }
        path = sidecar_path_for(self.audio_file, progress=True)
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
        except Exception as exc:
            print(f"WARNING:Failed to write progress sidecar: {exc}", flush=True)

    def finalize(self, language, language_probability, resolved_model_id, resolved_model_path):
        body_lines = []
        try:
            with open(self.output_file, "r", encoding="utf-8") as f:
                content = f.read()
            marker = "--- TRANSCRIPTION ---"
            idx = content.index(marker)
            body = content[idx + len(marker) :].strip()
            placeholder = "(in progress — segments stream below as they complete)"
            if body and body != placeholder:
                body_lines.append(body)
        except Exception as read_exc:
            # If we can't re-read the file we already wrote, do NOT overwrite it
            # with an empty header — that would destroy all incrementally-written
            # segments.  Log a warning and return a partial success so the caller
            # can still find the file on disk.
            print(f"WARNING:finalize() could not re-read transcript ({read_exc}); "
                  f"keeping existing file as-is", flush=True)
            log_transcription_event(
                f"finalize-read-error {self.base_name}: {read_exc}; file preserved"
            )
            return {
                "success": True,
                "output_file": self.output_file,
                "language": language,
                "language_probability": language_probability,
                "device": self.device,
                "compute_type": self.compute_type,
                "model_size": self.model_size,
                "resolved_model_id": resolved_model_id,
                "resolved_model_path": resolved_model_path,
                "segment_count": self.segment_count,
                "transcript_saved": True,
            }

        with open(self.output_file, "w", encoding="utf-8") as f:
            f.write(
                self._header(
                    complete=True,
                    language=language,
                    confidence=language_probability,
                )
            )
            if body_lines:
                f.write(body_lines[0])
                if not body_lines[0].endswith("\n"):
                    f.write("\n")
            f.flush()
            os.fsync(f.fileno())

        progress_path = sidecar_path_for(self.audio_file, progress=True)
        if os.path.exists(progress_path):
            try:
                os.remove(progress_path)
            except Exception:
                pass

        log_transcription_event(
            f"completed {self.base_name} segments={self.segment_count} file={self.output_file}"
        )

        return {
            "success": True,
            "output_file": self.output_file,
            "language": language,
            "language_probability": language_probability,
            "device": self.device,
            "compute_type": self.compute_type,
            "model_size": self.model_size,
            "resolved_model_id": resolved_model_id,
            "resolved_model_path": resolved_model_path,
            "segment_count": self.segment_count,
            "transcript_saved": True,
        }


def transcribe_audio(audio_file, model_size="medium", use_gpu=True):
    """Transcribe audio file using faster-whisper with incremental disk output."""
    os.environ["MP3GRABBER_LAST_AUDIO"] = os.path.abspath(audio_file)
    device = "cuda" if use_gpu else "cpu"
    compute_type = "float16" if use_gpu else "float32"
    resolved_model_id = model_size
    resolved_model_path = model_size

    try:
        print(f"STATUS:Initializing {device.upper()} processing...", flush=True)

        if not os.path.isdir(model_size):
            resolved_model_path = download_model(model_size)
            path_parts = resolved_model_path.replace("\\", "/").split("/")
            snapshots_idx = path_parts.index("snapshots") if "snapshots" in path_parts else -1
            if snapshots_idx > 0:
                resolved_model_id = path_parts[snapshots_idx - 1].replace("models--", "").replace("--", "/")

        print(f"STATUS:Loading Whisper model ({model_size})...", flush=True)
        print(f"STATUS:Resolved model source: {resolved_model_id}", flush=True)
        print(f"STATUS:Resolved model path: {resolved_model_path}", flush=True)
        print(f"STATUS:Checking cache (downloading if needed)...", flush=True)

        load_start = time.time()
        model = WhisperModel(resolved_model_path, device=device, compute_type=compute_type)
        load_time = time.time() - load_start

        is_cached = load_time < (2.0 if use_gpu else 3.0)
        if is_cached:
            print(f"STATUS:Model loaded from cache ({load_time:.1f}s)", flush=True)
        else:
            print(f"STATUS:Model downloaded and loaded ({load_time:.1f}s)", flush=True)

        print(f"STATUS:Starting transcription...", flush=True)
        segments, info = model.transcribe(audio_file, beam_size=5)

        writer = IncrementalTranscriptWriter(audio_file, device, compute_type, model_size)
        print(f"STATUS:Processing segments...", flush=True)
        print(f"STATUS:Writing to {writer.output_file}", flush=True)

        for segment in segments:
            writer.append_segment(segment)
            if writer.segment_count % 10 == 0:
                print(f"STATUS:Processed {writer.segment_count} segments...", flush=True)
                writer.write_progress_sidecar(info.language, info.language_probability)

        print(f"STATUS:Transcription complete!", flush=True)

        result = writer.finalize(
            info.language,
            info.language_probability,
            resolved_model_id,
            resolved_model_path,
        )

        # On Windows, write the result sidecar NOW — before CUDA teardown — so
        # crash-recovery can find device/language even if os._exit() triggers a
        # CUDA atexit crash and the RESULT_JSON stdout line is lost.
        if sys.platform == "win32":
            _early_sidecar = sidecar_path_for(audio_file, progress=False)
            try:
                with open(_early_sidecar, "w", encoding="utf-8") as _f:
                    json.dump(result, _f, ensure_ascii=False)
                    _f.flush()
                    os.fsync(_f.fileno())
            except Exception:
                pass

        # Explicitly release the CUDA context before returning so that the
        # ctranslate2/cuDNN atexit handler (fired by os._exit) has nothing left
        # to tear down — this is the primary fix for exit-code 0xC0000409.
        import gc
        try:
            del model
        except Exception:
            pass
        gc.collect()

        return result

    except Exception as e:
        log_transcription_event(f"failed {os.path.basename(audio_file)}: {e}")
        return {
            "success": False,
            "error": str(e),
            "device": device,
            "compute_type": compute_type,
            "model_size": model_size,
            "resolved_model_id": resolved_model_id,
            "resolved_model_path": resolved_model_path,
        }


def check_gpu_availability():
    print("DEBUG:Checking GPU availability...", flush=True)
    try:
        import ctranslate2
        device_count = ctranslate2.get_cuda_device_count()
        print(f"DEBUG:ctranslate2 CUDA device count: {device_count}", flush=True)
        if device_count > 0:
            print("DEBUG:GPU available via ctranslate2", flush=True)
            return True
        print("DEBUG:ctranslate2 reports no CUDA devices, using CPU", flush=True)
        return False
    except Exception as e:
        print(f"DEBUG:ctranslate2 CUDA check failed: {e}", flush=True)

    try:
        import nvidia.cublas
        import nvidia.cudnn
        print("DEBUG:CUDA libraries imported successfully", flush=True)
        return True
    except ImportError as e:
        print(f"DEBUG:CUDA libraries not available: {e}", flush=True)
        return False


def emit_success_result(result, audio_file):
    """Emit compact stdout and exit before Windows CUDA teardown."""
    sidecar_path = sidecar_path_for(audio_file, progress=False)
    try:
        with open(sidecar_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
    except Exception as exc:
        print(f"WARNING:Failed to write sidecar: {exc}", flush=True)

    print("RESULT:SUCCESS", flush=True)
    compact = {
        "success": True,
        "output_file": result.get("output_file"),
        "language": result.get("language"),
        "language_probability": result.get("language_probability"),
        "device": result.get("device"),
        "compute_type": result.get("compute_type"),
        "model_size": result.get("model_size"),
        "resolved_model_id": result.get("resolved_model_id"),
        "resolved_model_path": result.get("resolved_model_path"),
        "segment_count": result.get("segment_count"),
        "transcript_saved": bool(result.get("output_file")),
    }
    print("RESULT_JSON:" + json.dumps(compact), flush=True)
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    if sys.platform == "win32":
        # One final GC pass to release any residual CUDA references before the
        # C-level atexit handlers (cuDNN/cuBLAS) run inside os._exit().
        import gc
        gc.collect()
        os._exit(0)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(json.dumps({"success": False, "error": "Usage: python transcribe.py <audio_file>"}))
        sys.exit(1)

    audio_file = os.path.abspath(sys.argv[1])
    if not os.path.exists(audio_file):
        print(json.dumps({"success": False, "error": f"Audio file not found: {audio_file}"}))
        sys.exit(1)

    if os.environ.get("MP3GRABBER_ROOT"):
        os.environ["MP3GRABBER_LAST_AUDIO"] = audio_file

    gpu_available = check_gpu_availability()
    chosen_model = os.environ.get("WHISPER_MODEL") or ("medium" if gpu_available else "base")

    if gpu_available:
        result = transcribe_audio(audio_file, model_size=chosen_model, use_gpu=True)
        if not result["success"] and (
            "CUDA" in result.get("error", "")
            or "cudnn" in result.get("error", "").lower()
            or "cublas" in result.get("error", "").lower()
        ):
            result = transcribe_audio(audio_file, model_size=chosen_model, use_gpu=False)
    else:
        result = transcribe_audio(audio_file, model_size=chosen_model, use_gpu=False)

    if result["success"]:
        emit_success_result(result, audio_file)
    else:
        print(json.dumps(result))
        sys.exit(1)
