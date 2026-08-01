# Targeted policy-input import: ECS runbook

This release patches calculation inputs for exactly 14 existing policies in the approved nine-product scope. It never imports users, families, source records, cashflows, cash values, cards, indicators, or a full SQLite database.

The importer refuses to write unless all of the following match for every entry:

- an existing production policy has the same `policy_id` and `user_id`;
- production policy company and name equal the reviewed source policy;
- production has the exact policy source product name and URL;
- the related responsibility card and indicator are present with the approved card source URL;
- `PRAGMA quick_check` returns `ok`.

The import command exits nonzero whenever `ok` is not `true` or `validationIssueCount` is nonzero. Do not bypass a failed dry-run.

## 1. Verify and extract the uploaded bundle

```bash
cd ~/OCR_insurance

ARCHIVE='production-data/ocr-insurance-targeted-policy-inputs-20260801.tar.gz'
REL='production-data/20260801-targeted-policy-inputs'

test -f "$ARCHIVE"
sha256sum "$ARCHIVE"
tar -xzf "$ARCHIVE" -C production-data
cd "$REL"
sha256sum -c SHA256SUMS
cd ~/OCR_insurance
```

The expected archive SHA-256 is supplied with the release receipt. The `LIBARCHIVE.xattr...` tar warning from macOS metadata is harmless if `SHA256SUMS` passes.

## 2. Read-only target dry-run

```bash
cd ~/OCR_insurance

REL='production-data/20260801-targeted-policy-inputs'

docker run --rm \
  -v ocr_insurance_poptonic_policy_data:/data:ro \
  -v "$PWD":/workspace:ro \
  -w /workspace \
  node:22-alpine \
  node --experimental-sqlite \
    "/workspace/$REL/targeted-policy-input-handoff.mjs" \
    --mode import \
    --handoff "/workspace/$REL/targeted-policy-input-handoff.json" \
    --db-path /data/policy-ocr.sqlite \
  | tee "$REL/target-dry-run.json"

node --input-type=module --eval '
  import { readFileSync } from "node:fs";
  const result = JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (result.ok !== true || result.validationIssueCount !== 0 || result.preflight?.entries?.length !== 14) process.exit(1);
  console.log(JSON.stringify({ ok: result.ok, validationIssueCount: result.validationIssueCount, entries: result.preflight.entries.length }, null, 2));
' "$REL/target-dry-run.json"
```

Stop here on any error. A target identity/source mismatch is intentionally a no-write `version-conflict` or data-identity blocker; do not edit the JSON or force the write.

## 3. Single-writer production import

Only run this after step 2 succeeds. The backup is outside the repository and is mounted only for the import container.

```bash
cd ~/OCR_insurance

REL='production-data/20260801-targeted-policy-inputs'
BACKUP_DIR='/root/ocr-insurance-release-backups-20260801'

docker-compose -f docker-compose.poptonic.yml stop api
docker-compose -f docker-compose.poptonic.yml ps

install -d -m 700 "$BACKUP_DIR"

docker run --rm \
  -v ocr_insurance_poptonic_policy_data:/data \
  -v "$PWD":/workspace:ro \
  -v "$BACKUP_DIR":/backups \
  -w /workspace \
  node:22-alpine \
  node --experimental-sqlite \
    "/workspace/$REL/targeted-policy-input-handoff.mjs" \
    --mode import \
    --handoff "/workspace/$REL/targeted-policy-input-handoff.json" \
    --db-path /data/policy-ocr.sqlite \
    --backup-dir /backups \
    --write \
  | tee "$REL/target-write-receipt.json"
```

The JSON receipt must show all of: `ok: true`, `validationIssueCount: 0`, `modifiedTables: ["policies"]`, a backup path plus SHA-256, `foreignKeyIssueCount: 0`, `quickCheck: "ok"`, and 14 semantic readback entries.

## 4. Restart and verify service health

```bash
cd ~/OCR_insurance

docker-compose -f docker-compose.poptonic.yml up -d api
docker-compose -f docker-compose.poptonic.yml ps
curl -fsS http://127.0.0.1/api/health
curl -fsS https://ocr.joyhive.cn/api/health
docker-compose -f docker-compose.poptonic.yml logs --tail=80 api | grep '\[policy-ocr-app\] db=/data/policy-ocr.sqlite'
```

If the import command fails after the API has stopped, do not run another write command. Start the API again with step 4, retain the backup and both JSON receipts, and report the exact blocker.
