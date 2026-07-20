#!/usr/bin/env python3
import argparse
import base64
import json
import os
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

from paddleocr import PaddleOCRVL


MODEL_NAME = "PaddleOCR-VL-1.6"
VLLM_MODEL_NAME = os.environ.get(
    "PADDLEOCR_VL16_VLLM_MODEL", "PaddleOCR-VL-1.6-0.9B"
)
VLLM_SERVER_URL = os.environ.get(
    "PADDLEOCR_VL16_VLLM_SERVER_URL", "http://127.0.0.1:8118/v1"
)
inference_lock = threading.Lock()
pipeline = PaddleOCRVL(
    pipeline_version="v1.6",
    device="gpu:0",
    vl_rec_backend="vllm-server",
    vl_rec_server_url=VLLM_SERVER_URL,
    vl_rec_api_model_name=VLLM_MODEL_NAME,
)


def extract_image(messages):
    for message in messages or []:
        for item in message.get("content", []):
            if item.get("type") != "image_url":
                continue
            value = item.get("image_url", {}).get("url", "")
            if value.startswith("data:") and ";base64," in value:
                header, encoded = value.split(",", 1)
                suffix = ".png" if "png" in header else ".jpg"
                return suffix, base64.b64decode(encoded)
    raise ValueError("image data URL is required")


def normalize_bbox(value):
    if not isinstance(value, list) or not value:
        return None
    if len(value) >= 4 and all(isinstance(item, (int, float)) for item in value[:4]):
        return value[:4]
    if all(
        isinstance(point, list)
        and len(point) >= 2
        and all(isinstance(item, (int, float)) for item in point[:2])
        for point in value
    ):
        return [point[:2] for point in value]
    return None


def collect_document(results, y_offset=0):
    lines = []
    blocks = []
    for item in results:
        payload = getattr(item, "json", None)
        payload = payload() if callable(payload) else payload
        if not isinstance(payload, dict):
            continue
        res = payload.get("res", payload)
        for block in res.get("parsing_res_list", []):
            content = str(block.get("block_content") or "").strip()
            if content and (not lines or lines[-1] != content):
                lines.append(content)
            bbox = normalize_bbox(
                block.get("block_bbox")
                or block.get("block_box")
                or block.get("bbox")
                or block.get("coordinate")
            )
            if content and bbox:
                if y_offset and len(bbox) >= 4 and all(
                    isinstance(item, (int, float)) for item in bbox[:4]
                ):
                    bbox = [bbox[0], bbox[1] + y_offset, bbox[2], bbox[3] + y_offset]
                elif y_offset and all(
                    isinstance(point, list) and len(point) >= 2 for point in bbox
                ):
                    bbox = [[point[0], point[1] + y_offset] for point in bbox]
                blocks.append({
                    "text": content,
                    "box": bbox,
                    "confidence": float(block.get("block_confidence") or block.get("score") or 1),
                    "label": str(block.get("block_label") or block.get("label") or ""),
                    "order": block.get("block_order"),
                })
    return "\n".join(lines), blocks


def merge_documents(documents):
    lines = []
    blocks = []
    seen_lines = set()
    for content, document_blocks in documents:
        for line in content.splitlines():
            normalized = line.strip()
            if normalized and normalized not in seen_lines:
                seen_lines.add(normalized)
                lines.append(normalized)
        blocks.extend(document_blocks)
    return "\n".join(lines), blocks


def recognize_tall_image_segments(image_path, tmp_dir):
    with Image.open(image_path) as image:
        width, height = image.size
        if height < 1000 or height / max(width, 1) < 1.15:
            return "", []
        ranges = [
            (0, round(height * 0.55)),
            (round(height * 0.20), round(height * 0.80)),
            (round(height * 0.45), height),
        ]
        documents = []
        for index, (top, bottom) in enumerate(ranges):
            segment_path = os.path.join(tmp_dir, f"segment-{index}.jpg")
            image.crop((0, top, width, bottom)).convert("RGB").save(
                segment_path, format="JPEG", quality=95
            )
            documents.append(collect_document(pipeline.predict(segment_path), top))
    return merge_documents(documents)


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"ok": True, "model": MODEL_NAME})
            return
        if self.path == "/v1/models":
            self.send_json(200, {"object": "list", "data": [{"id": MODEL_NAME, "object": "model"}]})
            return
        self.send_json(404, {"detail": "not found"})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_json(404, {"detail": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length))
            suffix, image_bytes = extract_image(request.get("messages"))
            with tempfile.TemporaryDirectory(prefix="paddleocr-vl16-") as tmp_dir:
                image_path = os.path.join(tmp_dir, f"input{suffix}")
                with open(image_path, "wb") as image_file:
                    image_file.write(image_bytes)
                with inference_lock:
                    started_at = time.monotonic()
                    print(f"OCR inference started: {len(image_bytes)} bytes", flush=True)
                    results = pipeline.predict(image_path)
                    content, blocks = collect_document(results)
                    segmented = False
                    if len(content.strip()) < 300:
                        segmented_content, segmented_blocks = recognize_tall_image_segments(
                            image_path, tmp_dir
                        )
                        if len(segmented_content) > len(content):
                            content, blocks = segmented_content, segmented_blocks
                            segmented = True
                    print(
                        f"OCR inference completed: {len(content)} chars, {len(blocks)} blocks, "
                        f"{time.monotonic() - started_at:.1f}s, segmented={segmented}",
                        flush=True,
                    )
            if not content:
                raise RuntimeError("empty OCR output")
            self.send_json(200, {
                "id": "paddleocr-vl16-local",
                "object": "chat.completion",
                "model": MODEL_NAME,
                "paddle_blocks": blocks,
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }],
            })
        except Exception as error:
            self.send_json(500, {"detail": str(error)})

    def log_message(self, format_string, *args):
        print(format_string % args, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=6011)
    args = parser.parse_args()
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
