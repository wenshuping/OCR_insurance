# 2026-08-01 生产静态责任数据发布

本包只会替换 9 个精确公司加产品名下的两张静态表：

- `product_responsibility_cards`
- `insurance_indicator_records`

不会写入 `policies`、用户、家庭、`source_records`、现金流、现金价值、别名公司或同名其他版本。

每个产品按 `sourceDigest > sourceUrl > 公司加产品名` 校验。任何非空的目标 digest 竞争都会以 `version_conflict` 停止，且不写入。

## 1. 校验并解包

```bash
cd ~/OCR_insurance

ARCHIVE='production-data/ocr-insurance-static-responsibility-overwrite-20260801.tar.gz'
REL='production-data/20260801-static-responsibility-overwrite'

sha256sum "$ARCHIVE"
tar -xzf "$ARCHIVE" -C production-data
(cd "$REL" && sha256sum -c SHA256SUMS)
```

`LIBARCHIVE.xattr...` 警告可忽略；必须以 `SHA256SUMS` 的全部 `OK` 为准。

## 2. 真实生产库只读 dry-run

```bash
cd ~/OCR_insurance
REL='production-data/20260801-static-responsibility-overwrite'

docker run --rm \
  -v ocr_insurance_poptonic_policy_data:/data:ro \
  -v "$PWD":/workspace:ro \
  -w /workspace \
  node:22-alpine \
  node --experimental-sqlite \
    "/workspace/$REL/static-responsibility-handoff.mjs" \
    --mode import \
    --handoff "/workspace/$REL/static-responsibility-handoff.json" \
    --db-path /data/policy-ocr.sqlite \
  > "$REL/target-dry-run.json"

node --input-type=module --eval '
  import { readFileSync } from "node:fs";
  const result = JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (result.ok !== true || result.validationIssueCount !== 0 || result.preflight?.products?.length !== 9) process.exit(1);
  console.log(JSON.stringify({
    ok: result.ok,
    validationIssueCount: result.validationIssueCount,
    products: result.preflight.products.map(({ order, productName, existingCards, existingIndicators, cardsToReplace, indicatorsToReplace }) => ({ order, productName, existingCards, existingIndicators, cardsToReplace, indicatorsToReplace })),
  }, null, 2));
' "$REL/target-dry-run.json"
```

停止条件：`ok !== true`、`validationIssueCount !== 0`、非 9 个产品、`version_conflict`、或 `quick_check` 非 `ok`。不要编辑 JSON 或强制写入。

## 3. 单写者导入、备份与语义回读

仅在第 2 步全部通过后执行。先停止 API，避免并发写入；Web 容器可继续运行并会短暂返回 502。

```bash
cd ~/OCR_insurance
REL='production-data/20260801-static-responsibility-overwrite'
BACKUP_DIR='/root/ocr-insurance-release-backups-20260801'

docker-compose -f docker-compose.poptonic.yml stop api
docker-compose -f docker-compose.poptonic.yml ps
docker ps --format 'table {{.Names}}\t{{.Status}}'

install -d -m 700 "$BACKUP_DIR"

docker run --rm \
  -v ocr_insurance_poptonic_policy_data:/data \
  -v "$PWD":/workspace:ro \
  -v "$BACKUP_DIR":/backups \
  -w /workspace \
  node:22-alpine \
  node --experimental-sqlite \
    "/workspace/$REL/static-responsibility-handoff.mjs" \
    --mode import \
    --handoff "/workspace/$REL/static-responsibility-handoff.json" \
    --db-path /data/policy-ocr.sqlite \
    --backup-dir /backups \
    --write \
  > "$REL/production-write-receipt.json"

node --input-type=module --eval '
  import { readFileSync } from "node:fs";
  const result = JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (result.ok !== true || result.validationIssueCount !== 0 || result.readback?.ok !== true || result.readback?.foreignKeyIssueCount !== 0 || result.readback?.quickCheck !== "ok") process.exit(1);
  console.log(JSON.stringify({
    ok: result.ok,
    backup: result.backup,
    modifiedTables: result.modifiedTables,
    readback: result.readback,
  }, null, 2));
' "$REL/production-write-receipt.json"

docker-compose -f docker-compose.poptonic.yml up -d api
curl -fsS http://127.0.0.1/api/health
curl -fsS https://ocr.joyhive.cn/api/health
```

导入器会先创建可恢复 SQLite 备份和 SHA-256，然后在 `BEGIN IMMEDIATE` 事务内仅删除并重新插入上述 9 个精确产品的卡片和指标。它会检查 `foreign_key_check`、`quick_check`，并对每张卡、每条指标及其嵌入投影做哈希和来源版本回读。

## 4. 应用层确认（可选）

```bash
curl -fsS http://127.0.0.1:5601/api/policy-responsibilities/customer-summary \
  -H 'content-type: application/json' \
  --data '{"company":"新华人寿保险股份有限公司","name":"阳光灿烂少儿两全保险（分红型）"}'
```

应返回 `source: "responsibility_cards"`。不要把本地 commit 或 package SHA 当作生产写入成功；以 `production-write-receipt.json` 的 backup SHA、两个表名和 readback 结果为准。
