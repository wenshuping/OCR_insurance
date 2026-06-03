#!/usr/bin/env python3
"""PDF-Extract-Kit / MinerU backend for insurance policy OCR.

Accepts a local file path (PDF or image) as the first CLI argument and
outputs a JSON object with the same contract as policy_ocr_paddle.py:

    {
      "ok": true,
      "pipeline": "pdf_extract_kit",
      "lines": ["line1", "line2", ...],
      "ocrText": "line1\nline2\n...",
      "boxes": []
    }

Uses the ``mineru`` CLI (v3.x) internally.  When neither the CLI nor the
Python package is available locally, falls back to running the mineru-ocr
Docker image.

Environment variables
---------------------
POLICY_OCR_PDF_EXTRACT_KIT_BACKEND
    "pipeline" (default) – uses MinerU pipeline backend (CPU-friendly).
    "vlm"               – uses MinerU VLM backend (GPU recommended).
POLICY_OCR_PDF_EXTRACT_KIT_LANG
    OCR language hint, default "ch" (Chinese).
POLICY_OCR_PDF_EXTRACT_KIT_DEVICE
    "cpu" (default) or "cuda" / "mps".
POLICY_OCR_MINERU_DOCKER_IMAGE
    Docker image name, default "mineru-ocr".
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# ---------------------------------------------------------------------------
# Docker fallback – when mineru CLI is not installed locally, run inside a
# Docker container that has MinerU pre-installed.
# ---------------------------------------------------------------------------
DOCKER_IMAGE = os.environ.get("POLICY_OCR_MINERU_DOCKER_IMAGE", "mineru-ocr")
_DOCKER_REENTRY_KEY = "MINERU_DOCKER_REENTRY"


def _is_docker_reentry() -> bool:
    return os.environ.get(_DOCKER_REENTRY_KEY) == "1"


def _docker_available() -> bool:
    """Quick check: is the `docker` CLI on PATH and daemon running?"""
    try:
        result = subprocess.run(
            ["docker", "info"],
            capture_output=True, timeout=10,
        )
        return result.returncode == 0
    except Exception:
        return False


def _docker_image_exists() -> bool:
    """Check if the mineru-ocr Docker image is available locally."""
    try:
        result = subprocess.run(
            ["docker", "image", "inspect", DOCKER_IMAGE],
            capture_output=True, timeout=10,
        )
        return result.returncode == 0
    except Exception:
        return False


def fail(message: str, code: int = 1) -> None:
    sys.stderr.write(f"{message}\n")
    raise SystemExit(code)


def load_input_path() -> str:
    if len(sys.argv) < 2:
        fail("POLICY_OCR_INPUT_REQUIRED")
    input_path = Path(sys.argv[1]).expanduser().resolve()
    if not input_path.exists():
        fail("POLICY_OCR_INPUT_NOT_FOUND")
    return str(input_path)


def is_warmup_mode() -> bool:
    return "--warmup" in sys.argv[1:]


def resolve_backend() -> str:
    raw = os.environ.get("POLICY_OCR_PDF_EXTRACT_KIT_BACKEND", "").strip().lower()
    if raw in ("pipeline", "vlm"):
        return raw
    return "pipeline"


def resolve_device() -> str:
    return os.environ.get("POLICY_OCR_PDF_EXTRACT_KIT_DEVICE", "cpu").strip().lower() or "cpu"


def resolve_lang() -> str:
    return os.environ.get("POLICY_OCR_PDF_EXTRACT_KIT_LANG", "ch").strip() or "ch"


def _mineru_cli_available() -> bool:
    """Check if the ``mineru`` CLI is on PATH."""
    return shutil.which("mineru") is not None


def _run_mineru_cli(input_path: str, output_dir: str) -> None:
    """Run the mineru CLI to parse a document.

    Raises RuntimeError if the CLI fails.
    """
    backend = resolve_backend()
    lang = resolve_lang()
    cmd = [
        "mineru",
        "-p", input_path,
        "-o", output_dir,
        "-b", backend,
        "-l", lang,
    ]
    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=300,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr or "mineru CLI failed\n")
        raise RuntimeError("POLICY_OCR_MINERU_CLI_FAILED")


def _run_mineru_via_docker(input_path: str, output_dir: str) -> None:
    """Run mineru CLI inside Docker container.

    Mounts input file and output dir into the container.
    """
    abs_input = str(Path(input_path).resolve())
    abs_output = str(Path(output_dir).resolve())
    container_input = "/mnt/input/" + Path(input_path).name

    cmd = [
        "docker", "run", "--rm",
        "-e", f"{_DOCKER_REENTRY_KEY}=1",
        "-v", f"{abs_input}:{container_input}:ro",
        "-v", f"{abs_output}:/mnt/output",
        "--entrypoint", "mineru",
        DOCKER_IMAGE,
        "-p", container_input,
        "-o", "/mnt/output",
        "-b", resolve_backend(),
        "-l", resolve_lang(),
    ]
    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=300,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr or "Docker mineru failed\n")
        raise RuntimeError("POLICY_OCR_DOCKER_FAILED")


def _extract_lines_from_markdown(output_dir: str) -> list[str]:
    """Read all .md files in the output directory and extract text lines."""
    lines: list[str] = []
    output_path = Path(output_dir)

    # mineru creates subdirectories; find all .md files recursively
    md_files = sorted(output_path.rglob("*.md"))
    if not md_files:
        return lines

    for md_file in md_files:
        text = md_file.read_text(encoding="utf-8", errors="replace")
        for raw_line in text.replace("\r", "\n").split("\n"):
            # Strip markdown image/table syntax but keep text
            stripped = raw_line.strip()
            # Skip empty lines
            if not stripped:
                continue
            # Skip pure image references like ![image](...)
            if re.match(r"^!\[.*\]\(.*\)$", stripped):
                continue
            # Remove inline images but keep surrounding text
            stripped = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", stripped)
            # Remove markdown links but keep text
            stripped = re.sub(r"\[([^\]]*)\]\([^)]+\)", r"\1", stripped)
            # Remove HTML tags
            stripped = re.sub(r"<[^>]+>", "", stripped)
            stripped = stripped.strip()
            if stripped:
                lines.append(stripped)

    # Deduplicate consecutive identical lines
    deduped: list[str] = []
    for line in lines:
        if not deduped or deduped[-1] != line:
            deduped.append(line)
    return deduped


def main() -> None:
    backend = resolve_backend()

    # --- warmup: just verify mineru is available ---
    if is_warmup_mode():
        if _mineru_cli_available():
            sys.stdout.write(json.dumps(
                {"ok": True, "warmup": True, "pipeline": "pdf_extract_kit",
                 "backend": backend, "runtime": "local"}, ensure_ascii=False))
            return

        if not _is_docker_reentry() and _docker_available() and _docker_image_exists():
            sys.stdout.write(json.dumps(
                {"ok": True, "warmup": True, "pipeline": "pdf_extract_kit",
                 "backend": backend, "runtime": "docker"}, ensure_ascii=False))
            return

        fail("POLICY_OCR_PDF_EXTRACT_KIT_IMPORT_FAILED")

    # --- normal OCR ---
    input_path = load_input_path()

    # Choose runtime: local CLI or Docker
    use_docker = False
    if not _mineru_cli_available():
        if not _is_docker_reentry() and _docker_available() and _docker_image_exists():
            use_docker = True
        else:
            fail("POLICY_OCR_PDF_EXTRACT_KIT_IMPORT_FAILED")

    # Create temp output directory
    with tempfile.TemporaryDirectory(prefix="mineru_out_") as output_dir:
        try:
            if use_docker:
                _run_mineru_via_docker(input_path, output_dir)
            else:
                _run_mineru_cli(input_path, output_dir)
        except Exception as exc:
            sys.stderr.write(f"PDF-Extract-Kit error: {exc}\n")
            fail("POLICY_OCR_FAILED")

        lines = _extract_lines_from_markdown(output_dir)

    if not lines:
        fail("POLICY_OCR_EMPTY")

    runtime = "docker" if use_docker else "local"
    output = {
        "ok": True,
        "pipeline": "pdf_extract_kit",
        "backend": backend,
        "runtime": runtime,
        "lines": lines,
        "ocrText": "\n".join(lines),
        "boxes": [],
    }
    sys.stdout.write(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
