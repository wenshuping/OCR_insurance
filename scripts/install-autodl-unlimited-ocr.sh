#!/bin/sh
set -eu

IMAGE="${UNLIMITED_OCR_IMAGE:-vllm/vllm-openai:unlimited-ocr}"
PORT="${UNLIMITED_OCR_PORT:-6009}"
CONTAINER="${UNLIMITED_OCR_CONTAINER:-unlimited-ocr}"
PROJECT_DIR="${UNLIMITED_OCR_PROJECT_DIR:-/root/autodl-tmp/OCR_insurance}"
ENV_DIR="${UNLIMITED_OCR_ENV_DIR:-/root/autodl-tmp/unlimited-ocr-env}"
LOG_FILE="${UNLIMITED_OCR_LOG_FILE:-/root/autodl-tmp/unlimited-ocr.log}"

if ! command -v docker >/dev/null 2>&1; then
  CONDA_BIN="${CONDA_BIN:-$(command -v conda 2>/dev/null || true)}"
  [ -n "$CONDA_BIN" ] || CONDA_BIN=/root/miniconda3/bin/conda
  [ -x "$CONDA_BIN" ] || { echo "ERROR: conda is required when Docker is unavailable" >&2; exit 1; }
  SERVER_FILE="$PROJECT_DIR/ocr-service/scripts/unlimited_ocr_server.py"
  [ -f "$SERVER_FILE" ] || { echo "ERROR: missing $SERVER_FILE" >&2; exit 1; }

  echo "Docker unavailable; installing isolated Transformers runtime"
  if [ ! -x "$ENV_DIR/bin/python" ]; then
    "$CONDA_BIN" create -y -p "$ENV_DIR" python=3.12
  fi
  "$ENV_DIR/bin/python" -m pip install --upgrade pip
  "$ENV_DIR/bin/python" -m pip install \
    torch==2.10.0 torchvision==0.25.0 transformers==4.57.1 \
    Pillow==12.1.1 matplotlib==3.10.8 einops==0.8.2 addict==2.4.0 \
    easydict==1.13 pymupdf==1.27.2.2 psutil==7.2.2 fastapi uvicorn

  export HF_HOME="${HF_HOME:-/root/autodl-tmp/huggingface}"
  export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
  mkdir -p "$HF_HOME" "$(dirname "$LOG_FILE")"
  pkill -f "unlimited_ocr_server.py" >/dev/null 2>&1 || true
  nohup "$ENV_DIR/bin/python" "$SERVER_FILE" --host 127.0.0.1 --port "$PORT" >"$LOG_FILE" 2>&1 &
  SERVICE_PID=$!

  echo "Downloading/loading Unlimited-OCR; first startup can take 10-20 minutes"
  attempt=0
  until curl -fsS "http://127.0.0.1:$PORT/v1/models" >/dev/null; do
    attempt=$((attempt + 1))
    if ! kill -0 "$SERVICE_PID" >/dev/null 2>&1; then
      tail -n 120 "$LOG_FILE" >&2 || true
      echo "ERROR: Unlimited-OCR service exited" >&2
      exit 1
    fi
    if [ "$attempt" -ge 240 ]; then
      tail -n 120 "$LOG_FILE" >&2 || true
      echo "ERROR: Unlimited-OCR startup timed out" >&2
      exit 1
    fi
    sleep 5
  done
  curl -fsS "http://127.0.0.1:$PORT/v1/models"
  echo
  echo "Unlimited-OCR is ready. Log: $LOG_FILE"
  exit 0
fi

echo "Pulling $IMAGE"
docker pull "$IMAGE"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

echo "Starting Unlimited-OCR on 127.0.0.1:$PORT"
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --gpus all \
  --network host \
  --ipc host \
  "$IMAGE" \
  baidu/Unlimited-OCR \
  --host 127.0.0.1 \
  --port "$PORT" \
  --trust-remote-code \
  --logits_processors vllm.model_executor.models.unlimited_ocr:NGramPerReqLogitsProcessor \
  --no-enable-prefix-caching \
  --mm-processor-cache-gb 0

echo "Waiting for model service"
attempt=0
until curl -fsS "http://127.0.0.1:$PORT/v1/models" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 180 ]; then
    docker logs --tail 100 "$CONTAINER" >&2 || true
    echo "ERROR: Unlimited-OCR did not become ready" >&2
    exit 1
  fi
  sleep 2
done

curl -fsS "http://127.0.0.1:$PORT/v1/models"
echo
echo "Unlimited-OCR is ready. Set POLICY_OCR_UNLIMITED_OCR_BASE_URL=http://127.0.0.1:$PORT"
