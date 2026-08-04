---
name: ocr-insurance-legacy-indicator-safe-reuse
description: Safely reuse legacy insurance responsibility cards and indicators only after the exact official source version and complete responsibility inventory are locked. Use for responsibility backfills, approved-artifact reconstruction, missing-indicator repair, card-only or indicator-only products, model-call reduction, legacy-versus-official gap analysis, and missing-only parsing manifests. Routes each product to exact_reuse, missing_only, fresh_parse, version_conflict, or review without treating legacy data as official truth.
---

# Insurance Legacy Indicator Safe Reuse

Reduce model work without allowing historical cards or indicators to determine
the official responsibility inventory.

Read [references/decision-contract.md](references/decision-contract.md) before
generating a reuse or missing-only manifest. Also use
`$ocr-insurance-fast-responsibility-pipeline` for source, extraction, validator,
and publication gates.

## Required Inputs

Require all of the following before evaluating reuse:

- an immutable `source_ready` record with official PDF, `sourceDigest`, URL,
  page text, and source contract;
- a model-blind official responsibility inventory with titles, page/absolute
  offsets, shared clauses, tables, and continuation ranges;
- a read-only snapshot of legacy responsibility cards, nested indicators, and
  standalone indicator records for the exact product identity;
- current approved, terminal, in-flight, and database state for deduplication.

Use identity priority:

```text
sourceDigest > sourceUrl > normalized company+productName
```

Treat competing nonempty digests as `version_conflict`. Never merge or overwrite
them because the names or URLs look similar.

## Keep Official And Legacy Data Separate

Build and persist two separate structures:

```text
modelBlindOfficialPacket
legacyDiff
```

`modelBlindOfficialPacket` contains only official evidence and deterministic
inventory metadata. `legacyDiff` contains historical cards/indicators and the
comparison result.

Do not place unverified legacy amounts, formulas, branches, limits, evidence, or
responsibility titles in a model prompt. Legacy data may locate a suspected gap,
but official evidence must define the target and accepted value.

## Decision Workflow

### 1. Lock Official Inventory

Complete the official title inventory before reading legacy values. Preserve
separate official responsibilities; keep tiers and formula branches under their
official parent. Route uncertain chapters or damaged tables to inventory/source
review instead of using legacy rows to fill the gap.

### 2. Compare Three Projections

Compare, by stable responsibility and indicator identity:

```text
official inventory / approved artifact
<-> responsibility card plus nested indicators
<-> standalone indicator record payloads
```

Check both directions for missing or extra IDs. Compare titles, evidence,
numeric tokens, formula fields, source fields, parent/branch relationships,
duplicates, and orphans.

### 3. Route The Product

Choose exactly one route:

- `exact_reuse`: the locked digest matches and every responsibility, indicator,
  evidence span, formula field, branch, and ID mapping is source-supported and
  one-to-one. Rebuild the artifact deterministically without a model.
- `missing_only`: the official inventory is complete and proves a bounded set of
  missing responsibilities or fields. Reuse only exact fields; create model
  packets only for the missing official targets.
- `fresh_parse`: legacy coverage is unreliable, broadly incomplete, polluted by
  duplicates/orphans, or semantically conflicts with official evidence. Parse
  from official packets without legacy business values.
- `version_conflict`: exact identity has competing nonempty digests or distinct
  proven versions. Preserve both and stop automatic replacement.
- `inventory_review` or `source_reacquire`: official inventory or source bytes
  are not sufficient to prove completeness.

Never call `exact_reuse` merely because card and indicator counts match.

## Build Missing-Only Packets

For each missing responsibility or field, include:

- locked product and source digest;
- official responsibility ID and title;
- exact official evidence window, page, and absolute offsets;
- the specific missing fields or failed gate;
- applicable shared definitions, waiting periods, tables, and continuation
  ranges.

Keep each packet within the fast-pipeline target without truncating a clause or
formula. Do not include legacy proposed values. Merge successful proposals only
into the matching missing target; never rerun or rewrite exact-reuse targets.

Invoke `$ocr-insurance-deepseek-indicator-generation` for every `missing_only`
or `fresh_parse` indicator proposal. DeepSeek sees only the model-blind official
packet; keep `legacyDiff` outside the prompt. A DeepSeek failure remains in its
model-retry queue and must not automatically fall back to Luna, Gemini, or
DianJin.

## Validate Reuse And Repairs

Require every deterministic reconstruction and missing-only repair to pass:

1. canonicalizer;
2. validator with the expected responsibility count;
3. dedicated importer dry-run with `ok=true`, zero issues, expected accepted
   responsibilities, and zero materialization;
4. isolated clone materialization and exact three-projection readback;
5. duplicate/orphan checks, bidirectional IDs, `quick_check=ok`, and FK=0.

Read back `formulaText`, `normalizedFormula`, `requiredInputs`,
`operands/branches`, parent/branch metadata, evidence, URL, and source digest.
An importer success or count-only match is not sufficient.

Only a clone-passed item may enter `import_ready`. Real SSD publication remains
serial and requires explicit authorization, one writer, backup/SHA, actual-target
dry-run, exact readback, and rollback on any failed product gate.

## Mandatory Rejection Cases

Do not reuse automatically when any of these applies:

- competing source digests or unproven source identity;
- official and legacy responsibility inventories differ without a bounded,
  source-proven missing set;
- one historical indicator hides legitimate multiple indicators;
- duplicated cards, orphan indicators, optional aliases, or sentence fragments;
- unsupported or lost `normalizedFormula`, inputs, operands, or branches;
- card-only or indicator-only data without a complete official inventory;
- waiting periods, exclusions, definitions, or claim procedures materialized as
  responsibilities;
- product aliases that could cross versions.

## Immutable Outputs

Write a mutually exclusive ledger and queues for:

```text
exact-reuse.jsonl
missing-only.jsonl
fresh-parse.jsonl
version-conflict.jsonl
inventory-review.jsonl
source-reacquire.jsonl
materializer-blocked.jsonl
import-ready.jsonl
```

Include input locks, exclusion/intersection audit, per-product receipts, summary,
and SHA verification. Report `exactReuseProducts`, `missingOnlyProducts`,
`freshParseProducts`, `savedModelCalls`, `legacyMismatchDetected`, approved,
clone-passed, and remaining counts. Do not extrapolate a global reuse rate from
a preselected canary.
