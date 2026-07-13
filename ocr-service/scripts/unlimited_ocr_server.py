import argparse
import base64
import os
import tempfile
import threading

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import AutoModel, AutoTokenizer


MODEL_NAME = os.environ.get("UNLIMITED_OCR_MODEL", "baidu/Unlimited-OCR")
app = FastAPI()
inference_lock = threading.Lock()
tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME, trust_remote_code=True)
model = AutoModel.from_pretrained(
    MODEL_NAME,
    trust_remote_code=True,
    use_safetensors=True,
    torch_dtype=torch.bfloat16,
).eval().cuda()


class ChatRequest(BaseModel):
    model: str = MODEL_NAME
    messages: list[dict]
    max_tokens: int = 8192
    temperature: float = 0


def image_data_url(messages: list[dict]) -> tuple[str, bytes]:
    for message in messages:
        for item in message.get("content", []):
            if item.get("type") != "image_url":
                continue
            value = item.get("image_url", {}).get("url", "")
            if not value.startswith("data:") or ";base64," not in value:
                continue
            header, encoded = value.split(",", 1)
            suffix = ".png" if "png" in header else ".jpg"
            return suffix, base64.b64decode(encoded)
    raise HTTPException(status_code=400, detail="image data URL is required")


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME}


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": MODEL_NAME, "object": "model"}]}


@app.post("/v1/chat/completions")
def chat_completions(request: ChatRequest):
    suffix, image_bytes = image_data_url(request.messages)
    with tempfile.TemporaryDirectory(prefix="unlimited-ocr-") as tmp_dir:
        image_path = os.path.join(tmp_dir, f"input{suffix}")
        with open(image_path, "wb") as image_file:
            image_file.write(image_bytes)
        with inference_lock:
            content = model.infer(
                tokenizer,
                prompt="<image>document parsing.",
                image_file=image_path,
                output_path=tmp_dir,
                base_size=1024,
                image_size=640,
                crop_mode=True,
                eval_mode=True,
                max_length=32768,
                no_repeat_ngram_size=35,
                ngram_window=128,
                temperature=0.0,
            )
    if not str(content or "").strip():
        raise HTTPException(status_code=502, detail="Unlimited-OCR returned empty output")
    return {
        "id": "unlimited-ocr-local",
        "object": "chat.completion",
        "model": MODEL_NAME,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": str(content)},
            "finish_reason": "stop",
        }],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=6009)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)
