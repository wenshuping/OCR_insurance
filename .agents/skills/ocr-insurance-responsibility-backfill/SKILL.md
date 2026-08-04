---
name: ocr-insurance-responsibility-backfill
description: Orchestrate safe batch completion and repair of OCR_insurance product overviews, official responsibility inventories, customer responsibility cards, optional-responsibility children, and quantitative indicators in local SQLite and optionally Feishu. Use for coverage audits, historical-data cleanup, incomplete-product repair, manual artifact imports, and batch publication across products with zero, partial, stale, or previously verified data.
---

# Insurance Responsibility Backfill

Batch the same four-stage review used for one product. A product with existing cards is not automatically complete.

## Required Pipeline Per Product

Run `$ocr-insurance-product-responsibility-pipeline` once for every target product. It automatically applies the inventory, card, indicator, mapping, and independent-audit stages. Use `$ocr-insurance-single-product-responsibility-review` for disputed products or any product that fails batch audit.

## Product States

Classify every target product, not only products with zero cards:

- `uncovered`: no reviewed inventory/cards;
- `partial`: official checklist has missing cards or indicator decisions;
- `stale`: source version or source digest changed;
- `conflicted`: duplicate, merged, generic-group, basis, formula, or selection disagreement;
- `blocked`: exact official source or product version unresolved;
- `approved`: independent semantic audit passed for the current source digest.

Only `approved` products for the current source digest may be skipped. The presence of one or more cards must never exclude a product from completeness review.

## Hard Rules

- Use official insurer/regulator sources tied to the exact product version.
- Never treat existing indicators, cards, or model output as the official responsibility checklist.
- Keep optional groups separate from concrete child responsibilities.
- Do not run parallel SQLite or Feishu writes. Parallelize source discovery/review only when permitted.
- Review artifacts may be produced independently, but the main process performs backups, imports, pruning, publication, and final audits serially.
- Stop for CAPTCHA, login gates, blocked downloads, ambiguous versions, or unsupported formula constants.
- Default to development SQLite. Do not touch production without explicit instruction.
- Sync Feishu only when explicitly requested; require post-write readback.

## Batch Workflow

For unattended development-database backfill, use the bundled pipeline runner. It selects official PDF-backed products, parses products concurrently, repairs validator failures, writes approved products serially, and isolates remaining failures for manual review:

```bash
PIPELINE_SKILL_DIR="$PWD/.agents/skills/ocr-insurance-product-responsibility-pipeline"
STAMP="$(date +%Y%m%d-%H%M%S)"
python3 "$PIPELINE_SKILL_DIR/scripts/batch_deepseek_backfill.py" \
  --db-path="$POLICY_OCR_APP_DB_PATH" \
  --output-dir="$PWD/artifacts/responsibility-backfill-$STAMP" \
  --env-file="$PWD/.env.local" \
  --limit=20 \
  --workers=3 \
  --repair-rounds=3
```

Run with `--plan-only` first when changing selection filters. Use `--manifest=<json-array>` to process an explicit product/source list. Do not increase concurrent workers for SQLite publication: only parsing is parallel; the runner publishes approved products serially.

Required outputs:

- `selected-products.json`: exact batch queue;
- `published.jsonl`: approved products with publication/readback receipts;
- `manual-review.jsonl`: products still failing source retrieval, model generation, deterministic validation, or publication;
- `summary.json`: selected, published, and manual-review counts plus the batch backup path.

Each product directory also preserves `responsibility-candidate.pages.txt` and `responsibility-retrieval-report.json`. The first model pass uses those candidate pages. Any deterministic validation failure automatically escalates the next repair pass to the complete official source text, so keyword retrieval cannot silently remove a responsibility.

Treat `manual-review.jsonl` as the only human queue. Preserve each failed artifact, validator receipt, source PDF, and extracted source text so a later manual repair does not repeat discovery or model work.

1. Pin the development database and create a run directory.

```bash
export POLICY_OCR_APP_DB_PATH="/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite"
export POLICY_OCR_APP_STATE_PATH="$PWD/.runtime/local/state.json"
export STAMP="$(date +%Y%m%d-%H%M%S)"
export RUN_DIR="$PWD/.runtime/responsibility-backfill-$STAMP"
mkdir -p "$RUN_DIR"
```

2. Capture baseline counts and a source digest for each product.
3. Classify all products using the states above. Do not build a `missing cards only` queue.
4. Process small product batches. Produce one JSONL row per product containing:
   - exact product identity and source digest;
   - product overview;
   - independent official responsibility checklist;
   - optional groups and concrete child responsibilities;
   - customer cards;
   - indicator decisions and mapped indicators;
   - rejected fragments and blockers;
   - independent audit matrix and status.
5. Reject an artifact before import when:
   - product identity/version is unresolved;
   - an official checklist item lacks a card or indicator decision;
   - a generic group heading became a card;
   - a formula constant/basis lacks same-responsibility evidence;
   - optional selection is missing or an unselected benefit would enter current totals;
   - audit status is not `approved`.
6. Back up SQLite before each accepted import group.

```bash
sqlite3 "$POLICY_OCR_APP_DB_PATH" \
  "VACUUM INTO '$RUN_DIR/policy-ocr-before-import.sqlite';"
```

7. Import approved artifacts serially. Upsert by stable responsibility ID and source digest. Prune stale cards/indicators only when the approved official inventory explicitly supersedes them.
8. Read back the affected products and run the independent audit again against SQLite.
9. Run focused materialization/import tests and `npm run check` when implementation code changed.
10. Sync Feishu only after local audit passes, then save readback evidence.

## Required Artifact Acceptance

For every product require these set comparisons:

```text
independent official responsibility IDs == inventory responsibility IDs
inventory responsibility IDs == card responsibility IDs
inventory responsibility IDs == indicator-decision responsibility IDs
```

Also require semantic checks:

- exact product/source version;
- trigger and obligation evidence;
- formula constants, bases, branches, timing, and limits;
- optional selection behavior;
- no duplicate, merged, or generic-heading cards;
- product overview supported by official material.

Count equality without these semantic checks is not sufficient.

## Recovery and Safety

- If interrupted, inspect artifacts, SQLite transaction state, and hashes before retrying.
- Never continue to the next write while the prior readback or audit is unfinished.
- Preserve rejected and blocked artifacts for later manual resolution.
- Do not delete historical rows globally. Limit pruning to an exact approved product/version and record every removed ID.

## Final Report

Report:

- products by state before and after the run;
- official sources and version evidence;
- responsibilities/cards/indicator decisions per product;
- semantic audit failures, unsupported formulas, and optional-selection issues;
- SQLite backup, imported/pruned IDs, and readback result;
- Feishu write/readback status when requested;
- remaining partial, stale, conflicted, and blocked products.
