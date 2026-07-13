# OCR Insurance Release 2026-07-02

## Artifacts

- `ocr-insurance-code-2026-07-02T14-35-00.tar.gz`
- `policy-ocr-knowledge-data-2026-07-02T14-18-21-209Z.sqlite.gz`
- `policy-ocr-knowledge-data-2026-07-02T14-18-21-209Z.manifest.json`

## Local Verification

- `npm run check`
- `npm run typecheck`
- `npm run build`
- `node --test --test-name-pattern "remote GPU vision|configured OCR runtime|product suggestions" tests/policy-ocr-flow.test.mjs`

## Upload Targets On ECS

```bash
mkdir -p ~/OCR_insurance/production-data
```

Upload:

```text
ocr-insurance-code-2026-07-02T14-35-00.tar.gz -> ~/OCR_insurance/
policy-ocr-knowledge-data-2026-07-02T14-18-21-209Z.sqlite.gz -> ~/OCR_insurance/production-data/
policy-ocr-knowledge-data-2026-07-02T14-18-21-209Z.manifest.json -> ~/OCR_insurance/production-data/
```

## ECS Code Deploy

```bash
cd ~/OCR_insurance
tar -xzf ocr-insurance-code-2026-07-02T14-35-00.tar.gz -C ~/OCR_insurance

docker-compose -f docker-compose.poptonic.yml stop api web
docker-compose -f docker-compose.poptonic.yml rm -f api web
docker-compose -f docker-compose.poptonic.yml build --no-cache api web
docker-compose -f docker-compose.poptonic.yml up -d
```

## ECS Knowledge Data Install

This preserves production users, policies, pending scans, memberships, family data, policy source records, cash values, and cashflows.

```bash
cd ~/OCR_insurance

docker-compose -f docker-compose.poptonic.yml stop api

docker run --rm \
  -v ocr_insurance_poptonic_policy_data:/data \
  -v "$PWD":/workspace \
  -w /workspace \
  node:22-alpine \
  node scripts/production-data-bundle.mjs install-knowledge \
    --bundle /workspace/production-data/policy-ocr-knowledge-data-2026-07-02T14-18-21-209Z.sqlite.gz \
    --manifest /workspace/production-data/policy-ocr-knowledge-data-2026-07-02T14-18-21-209Z.manifest.json \
    --target-db /data/policy-ocr.sqlite

docker-compose -f docker-compose.poptonic.yml up -d api web
```

## Verify

```bash
docker-compose -f docker-compose.poptonic.yml ps
curl -fsS http://127.0.0.1/api/health
curl -fsS https://ocr.joyhive.cn/api/health
docker-compose -f docker-compose.poptonic.yml logs --tail=40 api | grep "db=/data/policy-ocr.sqlite"
```

Product suggestion smoke test:

```bash
curl -fsS -G 'https://ocr.joyhive.cn/api/policy-responsibilities/product-suggestions' \
  --data-urlencode 'company=新华保险' \
  --data-urlencode 'q=i他男性特定疾病保险' \
  --data-urlencode 'limit=8'
```
