---
name: ocr-insurance-single-product-responsibility-review
description: "Orchestrate complete OCR_insurance review for exactly one insurance product: exact-version official-source responsibility inventory, product overview, customer responsibility cards, quantitative indicator mapping, independent semantic audit, and guarded SQLite or Feishu publication. Use when a product is missing, incomplete, disputed, duplicated, version-confused, or needs one-by-one repair."
---

# Single Product Responsibility Review

Review exactly one product through four separate evidence stages. Never let generated cards or existing indicators define what the official product contains.

## Required Pipeline

Use `$ocr-insurance-product-responsibility-pipeline` as the single entry point. It automatically applies the inventory, card, indicator, mapping, and independent-audit stages. Do not skip its inventory or audit even when the database already has cards and indicators.

## Hard Rules

- Use exact-version official insurer clauses/pages or regulator disclosures.
- Keep `可选责任一/二` and similar labels as groups; create cards and indicators for their concrete child responsibilities.
- Preserve product overview, responsibility text, card copy, and indicator metadata as separate outputs.
- Never substitute premium for insured amount or simplify unsupported formula branches.
- Existing database rows are comparison targets, not completeness evidence.
- Back up SQLite before any write.
- In development, use the SSD database configured by `.runtime/local/policy-ocr-env.json`; use production only when explicitly requested.
- Keep customer-facing cards free of internal audit keys, model names, and implementation commentary.
- Write Feishu only when explicitly requested and prove readback separately.

## Workflow

1. Pin exact `company`, `productName`, and product-version evidence.
2. Read existing knowledge, cards, indicators, and optional-responsibility records for comparison.
3. Run the inventory stage from official source and save the artifact.
4. Build exactly one card per inventory responsibility.
5. Map every responsibility to one or more indicators or an explicit `not_quantitative` decision.
6. Run an independent audit against a fresh official responsibility checklist.
7. Stop unless audit status is `approved`.
8. Create a SQLite backup.
9. Upsert reviewed indicators/cards by stable responsibility ID; prune stale rows only when the independent audit identifies them and the accepted inventory replaces them.
10. Read back SQLite and compare it again to the approved artifact.
11. Run focused tests and `npm run check` if code changed.

## Development Database Inspection

```bash
sqlite3 "$POLICY_OCR_APP_DB_PATH" "
  select count(*) from product_responsibility_cards
   where company='<公司>' and product_name='<产品>';
  select id, url, length(json_extract(payload,'$.pageText'))
    from knowledge_records
   where company='<公司>' and product_name='<产品>';
  select id, liability, coverage_type
    from insurance_indicator_records
   where company='<公司>' and product_name='<产品>';
"
```

## Backup Before Write

```bash
RUN_DIR=".runtime/single-product-responsibility-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN_DIR"
sqlite3 "$POLICY_OCR_APP_DB_PATH" \
  "VACUUM INTO '$RUN_DIR/policy-ocr-before.sqlite';"
```

## Publication Gate

Require all of these before marking the product verified:

- independent official checklist equals approved inventory by stable IDs;
- approved inventory equals responsibility cards by stable IDs;
- every responsibility has an indicator decision;
- all formula constants and bases are supported by the responsibility source excerpt;
- optional selection is preserved and unselected/unknown benefits are not included in current-policy totals;
- exact product version is proven;
- SQLite readback equals the approved artifact.

Do not use `inventory count == card count == indicator count` as the only approval test.

## Final Report

Report separately:

- product overview and customer-facing responsibilities;
- optional responsibility selection state;
- indicator formulas and calculability status;
- official source and exact-version evidence;
- independent audit matrix and status;
- database path, backup path, writes/prunes, and readback result;
- Feishu status only when requested.
