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

# Deploy the current working branch before merge:
scripts/release-ecs-production.sh --ref origin/codex/wechat-pay-membership

# After merge, deploy master:
scripts/release-ecs-production.sh --ref origin/master
```

The script fetches the selected ref, rebuilds `api` and `web` without cache,
waits for container, local, and public health checks, verifies the persistent
SQLite path, and checks admin plus WeChat Pay readiness without printing
secrets. It does not install or overwrite production SQLite data.

Manual equivalent:

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

Verify that the API is using the persistent SQLite path:

```bash
docker-compose -f docker-compose.poptonic.yml logs --tail=40 api | grep "db=/data/policy-ocr.sqlite"
```

Verify admin and annual membership payment configuration without printing secrets:

```bash
docker-compose -f docker-compose.poptonic.yml exec -T api node --input-type=module <<'NODE'
import { resolveWechatPayConfig } from './server/wechat-pay.service.mjs';

const pay = resolveWechatPayConfig();
console.log(JSON.stringify({
  adminPasswordConfigured: Boolean(process.env.POLICY_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD),
  wechatPay: {
    mode: pay.mode,
    ready: pay.ready,
    appId: Boolean(pay.appId),
    mchId: Boolean(pay.mchId),
    apiV3Key: Boolean(pay.apiV3Key),
    serialNo: Boolean(pay.serialNo),
    privateKey: Boolean(pay.privateKey),
    platformPublicKey: Boolean(pay.platformPublicKey),
    platformPublicKeyId: Boolean(pay.platformPublicKeyId),
    notifyUrl: pay.notifyUrl,
  },
}, null, 2));
NODE
```

Expected production values:

- `adminPasswordConfigured: true`
- `wechatPay.mode: "live"`
- `wechatPay.ready: true`
- `wechatPay.notifyUrl: "https://ocr.joyhive.cn/api/membership/wechatpay/notify"`

The admin login page is `https://ocr.joyhive.cn/admin`. If the login API returns
`ADMIN_PASSWORD_NOT_CONFIGURED`, update `~/OCR_insurance/deploy/poptonic.env` on
ECS with `POLICY_ADMIN_PASSWORD=...`, then restart `api`.

If a recent code line must be present in the container, verify it directly. Example:

```bash
grep -n "const scanPayload" server/ocr-runtime.mjs
docker-compose -f docker-compose.poptonic.yml exec api sh -lc \
  "grep -n \"const scanPayload\" /app/server/ocr-runtime.mjs || true"
```

If the host has the line but the container does not, the image is stale. Re-run the `build --no-cache` release commands above.

## Production Knowledge Data Release

Use this when production must receive local knowledge-base updates: knowledge records, insurance indicators, optional responsibility records, official-domain profiles, indicator definitions, and the indicator snapshot document.

This is separate from code release. Rebuilding Docker images must not create or overwrite production data. Knowledge data release must not replace production users, policies, pending scans, memberships, family data, policy source records, cash values, or cashflows.

On the local machine, generate a consistent SQLite bundle with `VACUUM INTO`:

```bash
cd /Users/wenshuping/Documents/OCR_insurance
node scripts/production-data-bundle.mjs export \
  --db-path .runtime/local/policy-ocr.sqlite \
  --out-dir .runtime/production-data-bundles
```

The command prints `bundlePath` and `manifestPath`. Upload both files to ECS, for example:

```text
~/OCR_insurance/production-data/<name>.sqlite.gz
~/OCR_insurance/production-data/<name>.manifest.json
```

Install only the knowledge tables on ECS through a disposable Node container so the host does not need Node installed:

```bash
cd ~/OCR_insurance
mkdir -p production-data

docker-compose -f docker-compose.poptonic.yml stop api

docker run --rm \
  -v ocr_insurance_poptonic_policy_data:/data \
  -v "$PWD":/workspace \
  -w /workspace \
  node:22-alpine \
  node scripts/production-data-bundle.mjs install-knowledge \
    --bundle /workspace/production-data/<name>.sqlite.gz \
    --manifest /workspace/production-data/<name>.manifest.json \
    --target-db /data/policy-ocr.sqlite

docker-compose -f docker-compose.poptonic.yml up -d api web
curl -fsS http://127.0.0.1/api/health
```

The knowledge installer writes a backup under `/data/backups/`, then replaces only the knowledge/indicator tables. It preserves real production users, policies, pending scans, memberships, family data, policy source records, cash values, and cashflows.

Full SQLite replacement is a disaster-recovery operation, not a normal release path. The full installer refuses to replace a non-empty target by default. Even with `--replace-non-empty`, it now refuses if the incoming bundle would remove protected production rows such as `users`, `policies`, `pending_scans`, memberships, family rows, source records, cash values, or cashflows. Use `--allow-user-data-loss` only after a separate written confirmation that deleting those rows is intentional.

Inspect production data counts without changing anything:

```bash
docker run --rm \
  -v ocr_insurance_poptonic_policy_data:/data \
  -v "$PWD":/workspace \
  -w /workspace \
  node:22-alpine \
  node scripts/production-data-bundle.mjs inspect --db-path /data/policy-ocr.sqlite
```

After installation, verify the product-suggestion path:

```bash
curl -fsS -G 'https://ocr.joyhive.cn/api/policy-responsibilities/product-suggestions' \
  --data-urlencode 'company=新华保险' \
  --data-urlencode 'q=福如东海A款终身寿险（分红型）' \
  --data-urlencode 'limit=8'
```

## AutoDL OCR Release

Run on AutoDL when OCR service code or OCR dependencies changed:

```bash
cd /root/autodl-tmp/OCR_insurance

# Deploy the current working branch before merge:
scripts/release-autodl-ocr.sh --ref origin/codex/wechat-pay-membership

# After merge, deploy master:
scripts/release-autodl-ocr.sh --ref origin/master
```

The script fetches the selected ref, installs production Node dependencies,
restarts `ocr-service/index.mjs` with `nohup`, tails the log, and waits for the
local OCR health endpoint. It does not touch ECS or SQLite data.

Manual equivalent:

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
