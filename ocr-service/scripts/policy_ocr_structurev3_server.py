#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import sys
import tempfile
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import unquote, urlparse

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "BOS")

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
PIPELINE = None
PIPELINE_LOCK = Lock()


def env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return str(raw).strip().lower() not in ("0", "false", "no", "off", "")


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def resolve_device() -> str:
    return (
        os.environ.get("POLICY_OCR_STRUCTUREV3_DEVICE")
        or os.environ.get("POLICY_OCR_PADDLE_DEVICE")
        or "gpu"
    ).strip() or "gpu"


def materialize(value):
    if callable(value):
        try:
            return value()
        except Exception:
            return None
    return value


def safe_attr(item, name: str):
    try:
        return getattr(item, name)
    except Exception:
        return None


def to_jsonable(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_jsonable(item) for item in value]
    if hasattr(value, "tolist"):
        try:
            return to_jsonable(value.tolist())
        except Exception:
            return str(value)
    if hasattr(value, "__dict__"):
        return to_jsonable(vars(value))
    return str(value)


def result_list(results) -> list:
    if results is None:
        return []
    if isinstance(results, (str, bytes, dict)):
        return [results]
    if isinstance(results, list):
        return results
    if isinstance(results, tuple):
        return list(results)
    try:
        return list(results)
    except TypeError:
        return [results]


def collect_result_payloads(results: list) -> list:
    payloads = []
    for item in results:
        payload = materialize(safe_attr(item, "json"))
        if payload is None:
            payload = materialize(safe_attr(item, "res"))
        if payload is None:
            payload = item
        payloads.append(to_jsonable(payload))
    return payloads


def find_first_file(root: Path, suffix: str) -> Path | None:
    matches = sorted(root.rglob(f"*{suffix}"))
    return matches[0] if matches else None


def read_json(source: Path | None):
    if not source or not source.exists():
        return None
    try:
        return json.loads(source.read_text(encoding="utf-8"))
    except Exception:
        return None


def read_text(source: Path | None) -> str:
    if not source or not source.exists():
        return ""
    try:
        return source.read_text(encoding="utf-8")
    except Exception:
        return ""


def raw_payload(device: str, result_payloads: list, generated_payload=None) -> dict:
    results = result_payloads
    if generated_payload is not None:
        results = [generated_payload] if not result_payloads else result_payloads

    payload = {
        "ok": True,
        "pipeline": "pp_structurev3",
        "device": device,
        "results": results,
    }
    if isinstance(generated_payload, dict):
        return {**generated_payload, **payload}
    if generated_payload is not None:
        payload["generatedJson"] = generated_payload
    return payload


def get_pipeline():
    global PIPELINE
    if PIPELINE is not None:
        return PIPELINE
    with PIPELINE_LOCK:
        if PIPELINE is not None:
            return PIPELINE
        from paddleocr import PPStructureV3

        PIPELINE = PPStructureV3(
            device=resolve_device(),
            use_doc_orientation_classify=env_flag("POLICY_OCR_STRUCTUREV3_USE_DOC_ORIENTATION_CLASSIFY", True),
            use_doc_unwarping=env_flag("POLICY_OCR_STRUCTUREV3_USE_DOC_UNWARPING", True),
            use_textline_orientation=env_flag("POLICY_OCR_STRUCTUREV3_USE_TEXTLINE_ORIENTATION", True),
            use_formula_recognition=env_flag("POLICY_OCR_STRUCTUREV3_USE_FORMULA_RECOGNITION", False),
            use_chart_recognition=env_flag("POLICY_OCR_STRUCTUREV3_USE_CHART_RECOGNITION", False),
        )
        return PIPELINE


def safe_filename(headers) -> str:
    raw = headers.get("x-filename", "") or "policy.jpg"
    name = Path(unquote(raw)).name or "policy.jpg"
    suffix = Path(name).suffix.lower()
    if suffix not in IMAGE_SUFFIXES:
        return "policy.jpg"
    return name


def work_root() -> Path:
    configured = os.environ.get("POLICY_OCR_STRUCTUREV3_WORK_DIR", "").strip()
    root = Path(configured) if configured else Path(tempfile.gettempdir()) / "policy-structurev3-server"
    root.mkdir(parents=True, exist_ok=True)
    return root


def run_structurev3(image_bytes: bytes, filename: str) -> dict:
    device = resolve_device()
    request_id = uuid.uuid4().hex
    request_dir = work_root() / request_id
    generated_dir = request_dir / "generated"
    request_dir.mkdir(parents=True, exist_ok=True)
    generated_dir.mkdir(parents=True, exist_ok=True)
    image_path = request_dir / filename
    image_path.write_bytes(image_bytes)

    try:
        pipeline = get_pipeline()
        with PIPELINE_LOCK:
            results = result_list(pipeline.predict(str(image_path)))
            for item in results:
                save_json = safe_attr(item, "save_to_json")
                if callable(save_json):
                    save_json(save_path=str(generated_dir))
                save_markdown = safe_attr(item, "save_to_markdown")
                if callable(save_markdown):
                    save_markdown(save_path=str(generated_dir))

        generated_json = find_first_file(generated_dir, ".json")
        generated_md = find_first_file(generated_dir, ".md")
        generated_payload = read_json(generated_json)
        result_payloads = collect_result_payloads(results)
        return {
            "ok": True,
            "pipeline": "pp_structurev3",
            "device": device,
            "requestId": request_id,
            "rawJson": raw_payload(device, result_payloads, generated_payload),
            "markdown": read_text(generated_md),
        }
    finally:
        if not env_flag("POLICY_OCR_STRUCTUREV3_KEEP_WORK_DIR", False):
            shutil.rmtree(request_dir, ignore_errors=True)


def json_response(handler, status: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json; charset=utf-8")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class StructureV3Handler(BaseHTTPRequestHandler):
    server_version = "PolicyStructureV3HTTP/1.0"

    def log_message(self, format: str, *args) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path not in ("/health", "/structurev3/health"):
            json_response(self, 404, {"ok": False, "error": "NOT_FOUND"})
            return
        json_response(self, 200, {
            "ok": True,
            "pipeline": "pp_structurev3",
            "device": resolve_device(),
        })

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path not in ("/structurev3", "/"):
            json_response(self, 404, {"ok": False, "error": "NOT_FOUND"})
            return

        length = env_int("POLICY_OCR_STRUCTUREV3_MAX_IMAGE_MB", 50) * 1024 * 1024
        content_length = int(self.headers.get("content-length") or "0")
        if content_length <= 0:
            json_response(self, 400, {"ok": False, "error": "EMPTY_BODY"})
            return
        if content_length > length:
            json_response(self, 413, {"ok": False, "error": "IMAGE_TOO_LARGE"})
            return

        try:
            payload = run_structurev3(self.rfile.read(content_length), safe_filename(self.headers))
            json_response(self, 200, payload)
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            json_response(self, 500, {
                "ok": False,
                "error": "POLICY_STRUCTUREV3_RUNTIME_FAILED",
                "message": str(exc),
                "device": resolve_device(),
            })


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run PP-StructureV3 as a small local HTTP service.")
    parser.add_argument("--host", default=os.environ.get("POLICY_OCR_STRUCTUREV3_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=env_int("POLICY_OCR_STRUCTUREV3_PORT", 8765))
    parser.add_argument("--warmup", action="store_true")
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args(sys.argv[1:])
    if args.warmup:
        get_pipeline()

    server = ThreadingHTTPServer((args.host, args.port), StructureV3Handler)
    print(f"PP-StructureV3 server listening on http://{args.host}:{args.port}/structurev3", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
