# ECS + AutoDL Split Deployment

This deployment keeps the business app on Alibaba Cloud ECS and runs OCR / GPU vision on AutoDL.

For the full production release runbook, see `docs/production-release-wiki.md`.

## Topology

```text
Browser
  -> ECS nginx/web/api
  -> AutoDL OCR service
       -> PaddleOCR boxes, or
       -> DeepSeek-OCR vLLM markdown OCR, or
       -> local GPU vision model
```

ECS owns the frontend, Node API, persistence, SMS, WeChat, and policy workflows. AutoDL owns OCR and model inference.

## ECS

On ECS, copy `deploy/poptonic.env.example` to `deploy/poptonic.env` and fill:

```bash
POLICY_ADMIN_PASSWORD=...
POLICY_OCR_SERVICE_URL=https://YOUR_AUTODL_OCR_HOST
POLICY_OCR_SERVICE_TOKEN=...
POLICY_OCR_SERVICE_TIMEOUT_MS=600000
DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=
DEEPSEEK_MODEL=
DEEPSEEK_FAMILY_REVIEW_MODEL=deepseek-v4-pro
DEEPSEEK_FAMILY_REVIEW_TIMEOUT_MS=600000
DEEPSEEK_FAMILY_REVIEW_MAX_TOKENS=16000
DEEPSEEK_FAMILY_REPORT_MODEL=deepseek-v4-pro
DEEPSEEK_FAMILY_REPORT_TIMEOUT_MS=600000
DEEPSEEK_FAMILY_REPORT_MAX_TOKENS=8000
WECHAT_H5_APP_ID=...
WECHAT_H5_APP_SECRET=...
WECHAT_PAY_MODE=live
WECHAT_PAY_MCH_ID=...
WECHAT_PAY_API_V3_KEY=...
WECHAT_PAY_SERIAL_NO=...
WECHAT_PAY_PRIVATE_KEY=...
WECHAT_PAY_PLATFORM_PUBLIC_KEY=...
WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID=...
WECHAT_PAY_NOTIFY_URL=https://ocr.joyhive.cn/api/membership/wechatpay/notify
```

If PEM values are easier to manage as files, set `WECHAT_PAY_PRIVATE_KEY_PATH` and
`WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH` instead. The paths must exist inside the API
container.

Start only web and API:

```bash
docker compose -f docker-compose.poptonic.yml up -d --build
```

Verify:

```bash
curl -fsS http://127.0.0.1:5601/health
curl -fsS http://127.0.0.1:5601/api/health
```

## AutoDL

Use the Miniconda image with Python 3.10, Ubuntu 22.04, and CUDA 11.8. Copy `deploy/autodl-ocr.env.example` to `deploy/autodl-ocr.env` and fill the same `POLICY_OCR_SERVICE_TOKEN` used on ECS.

Install Node dependencies:

```bash
npm ci --omit=dev
```

For PaddleOCR GPU:

```bash
python -m pip install -U pip
python -m pip install paddlepaddle-gpu==3.2.0 -i https://www.paddlepaddle.org.cn/packages/stable/cu118/
python -m pip install paddleocr
```

For DeepSeek-OCR vLLM, start the local vLLM service on AutoDL first and set:

```bash
POLICY_OCR_PROVIDER=deepseek_ocr_vllm
POLICY_OCR_DEEPSEEK_OCR_BASE_URL=http://127.0.0.1:6008
POLICY_OCR_DEEPSEEK_OCR_MODEL=deepseek-ai/DeepSeek-OCR
```

Start OCR service:

```bash
set -a
. deploy/autodl-ocr.env
set +a
node ocr-service/index.mjs
```

Verify locally on AutoDL:

```bash
curl -fsS http://127.0.0.1:4105/internal/ocr-service/health
```

Verify from ECS:

```bash
curl -fsS -H "x-ocr-service-token: $POLICY_OCR_SERVICE_TOKEN" \
  "$POLICY_OCR_SERVICE_URL/internal/ocr-service/config"
```

## Security

- Restrict AutoDL ingress to the ECS public IP when possible.
- Always set `POLICY_OCR_SERVICE_TOKEN`.
- Prefer HTTPS in front of AutoDL. If AutoDL only exposes HTTP, keep the endpoint private or tunnel it through a trusted reverse proxy.
- Do not expose `/internal/ocr/policies/scan` without the shared token.

## Rollback

If AutoDL is unavailable, restore the previous ECS sidecar topology from git and set:

```bash
POLICY_OCR_SERVICE_URL=http://ocr:4105
```

Then redeploy the older compose file. Recovery signal: `curl http://127.0.0.1:5601/api/health` succeeds and a policy upload returns OCR scan data.
