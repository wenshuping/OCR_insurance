# Production Release Wiki

This runbook describes how to release the OCR Insurance app when ECS hosts the web/API service and AutoDL hosts OCR/GPU inference.

## Topology

```text
User browser / WeChat
  -> https://ocr.joyhive.cn
  -> Alibaba Cloud ECS nginx
  -> ECS docker compose web + api
  -> AutoDL OCR service
```

ECS is responsible for the frontend, API, SQLite volume, SMS, WeChat, and responsibility assistant. AutoDL is responsible for OCR and local model inference.

## Release Checklist

Before releasing:

```bash
npm run check
node --test --test-name-pattern "remote GPU vision|configured OCR runtime|product suggestions" tests/policy-ocr-flow.test.mjs
```

Push the code to GitHub `master`.

Never commit or paste production secrets. Keep these files only on the target machines:

- ECS: `~/OCR_insurance/deploy/poptonic.env`
- AutoDL: `/root/autodl-tmp/OCR_insurance/deploy/autodl-ocr.env`

## ECS Release

Run on ECS:

```bash
cd ~/OCR_insurance

git fetch origin
git reset --hard origin/master

git log -1 --oneline
grep -n "env_file" -A2 docker-compose.poptonic.yml
test -f deploy/poptonic.env && echo "poptonic.env exists"
```

The ECS machine currently uses legacy `docker-compose` 1.29.x. Keep `docker-compose.poptonic.yml` compatible with it:

```yaml
env_file:
  - ./deploy/poptonic.env
```

Do not use the newer Compose-only object form:

```yaml
env_file:
  - path: ./deploy/poptonic.env
    required: false
```

Rebuild and restart:

```bash
docker-compose -f docker-compose.poptonic.yml stop api web
docker-compose -f docker-compose.poptonic.yml rm -f api web
docker-compose -f docker-compose.poptonic.yml build --no-cache api web
docker-compose -f docker-compose.poptonic.yml up -d
```

Verify:

```bash
docker-compose -f docker-compose.poptonic.yml ps
curl -fsS http://127.0.0.1/api/health
curl -fsS https://ocr.joyhive.cn/api/health
```

If a recent code line must be present in the container, verify it directly. Example:

```bash
grep -n "const scanPayload" server/ocr-runtime.mjs
docker-compose -f docker-compose.poptonic.yml exec api sh -lc \
  "grep -n \"const scanPayload\" /app/server/ocr-runtime.mjs || true"
```

If the host has the line but the container does not, the image is stale. Re-run the `build --no-cache` release commands above.

## AutoDL OCR Release

Run on AutoDL when OCR service code or OCR dependencies changed:

```bash
cd /root/autodl-tmp/OCR_insurance

git fetch origin
git reset --hard origin/master

git log -1 --oneline
test -f deploy/autodl-ocr.env && echo "autodl-ocr.env exists"
```

Restart the OCR service:

```bash
pkill -f "node ocr-service/index.mjs" || true

set -a
. deploy/autodl-ocr.env
set +a

nohup node ocr-service/index.mjs > /root/autodl-tmp/ocr-service.log 2>&1 &

sleep 2
ps -ef | grep "ocr-service/index.mjs" | grep -v grep
tail -n 30 /root/autodl-tmp/ocr-service.log
```

Verify locally on AutoDL:

```bash
curl -fsS http://127.0.0.1:6006/internal/ocr-service/health
```

Verify through the AutoDL public service URL:

```bash
curl --http1.1 -fsS \
  -H "x-ocr-service-token: $POLICY_OCR_SERVICE_TOKEN" \
  "$POLICY_OCR_SERVICE_URL/internal/ocr-service/config"
```

## End-To-End OCR Smoke Test

After release, upload a known policy image through `https://ocr.joyhive.cn`.

Expected result:

- OCR text is visible under "查看或粘贴 OCR 文本".
- Insurance company, product name, applicant, insured, amount, and premium are filled when the page is readable.
- Similar product matching shows local candidates or a matched official product.

For API-level testing from a local machine:

```bash
node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const file = '/Users/wenshuping/Documents/保单/多倍7000.jpg';
const bytes = fs.readFileSync(file);
const dataUrl = `data:image/jpeg;base64,${bytes.toString('base64')}`;

const res = await fetch('https://ocr.joyhive.cn/api/policies/recognize', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    guestId: `smoke-${Date.now()}`,
    uploadItem: {
      name: path.basename(file),
      type: 'image/jpeg',
      size: bytes.length,
      dataUrl,
    },
  }),
});

const json = await res.json();
const scan = json.scan || {};
console.log(JSON.stringify({
  status: res.status,
  ok: json.ok,
  company: scan.data?.company,
  name: scan.data?.name,
  applicant: scan.data?.applicant,
  insured: scan.data?.insured,
  ocrTextLength: String(scan.ocrText || '').length,
  plans: scan.data?.plans?.map((plan) => ({
    name: plan.name,
    matchedProductName: plan.matchedProductName,
  })),
}, null, 2));
NODE
```

## Troubleshooting

### API health is OK but OCR fields are empty

Check whether ECS is running the newest code:

```bash
cd ~/OCR_insurance
git log -1 --oneline
docker-compose -f docker-compose.poptonic.yml exec api sh -lc \
  "grep -n \"const scanPayload\" /app/server/ocr-runtime.mjs || true"
```

If the container is old, rebuild with no cache:

```bash
docker-compose -f docker-compose.poptonic.yml stop api web
docker-compose -f docker-compose.poptonic.yml rm -f api web
docker-compose -f docker-compose.poptonic.yml build --no-cache api web
docker-compose -f docker-compose.poptonic.yml up -d
```

If ECS is current, check AutoDL:

```bash
cd /root/autodl-tmp/OCR_insurance
git log -1 --oneline
ps -ef | grep "ocr-service/index.mjs" | grep -v grep
tail -n 100 /root/autodl-tmp/ocr-service.log
```

### `docker-compose` says `env_file` is invalid

The ECS host uses legacy docker-compose. Use this:

```yaml
env_file:
  - ./deploy/poptonic.env
```

Then rerun the ECS release commands.

### Build output keeps saying `Using cache`

For emergency correctness, use:

```bash
docker-compose -f docker-compose.poptonic.yml build --no-cache api web
```

Then verify the expected source line inside the container.

### AutoDL SSH session disconnected

Start the OCR service with `nohup`, not directly in the SSH foreground:

```bash
nohup node ocr-service/index.mjs > /root/autodl-tmp/ocr-service.log 2>&1 &
```

Use:

```bash
tail -f /root/autodl-tmp/ocr-service.log
```

to watch OCR logs.

## Rollback

On ECS:

```bash
cd ~/OCR_insurance
git log --oneline -5
git reset --hard <previous-good-commit>

docker-compose -f docker-compose.poptonic.yml stop api web
docker-compose -f docker-compose.poptonic.yml rm -f api web
docker-compose -f docker-compose.poptonic.yml build --no-cache api web
docker-compose -f docker-compose.poptonic.yml up -d
curl -fsS https://ocr.joyhive.cn/api/health
```

On AutoDL, use the same `git reset --hard <previous-good-commit>` and restart `node ocr-service/index.mjs`.
