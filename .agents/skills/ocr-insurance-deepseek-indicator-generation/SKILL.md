---
name: ocr-insurance-deepseek-indicator-generation
description: Generate insurance responsibility indicators with DeepSeek from an immutable source-ready manifest and locked official responsibility inventory. Use for first parse, missing-only repair, or model retry when indicator facts, formulas, branches, inputs, and exact evidence must be produced without treating legacy cards or indicators as truth. This workflow is parse-only by default, forbids automatic provider fallback, and requires canonicalizer, validator, importer dry-run, terminal, and SHA receipts before approval.
---

# DeepSeek Insurance Indicator Generation

Use DeepSeek as the default automatic indicator generator after official source
and responsibility inventory gates have passed. The model proposes structured
indicator data; deterministic repository gates decide whether it is approved.

Read [references/indicator-contract.md](references/indicator-contract.md) before
building prompts or accepting output. Invoke
`$ocr-insurance-manifest-output-integrity` before processing or resuming any
manifest. Invoke `$ocr-insurance-legacy-indicator-safe-reuse` when historical
cards or indicators exist.

## Required Input Gates

Start only when every selected product has:

- an immutable manifest row and dedup key;
- `source_ready=true`, official PDF bytes, `sourceDigest`, URL, page text, and
  source contract;
- a model-blind official responsibility inventory with stable responsibility
  IDs, titles, section boundaries, pages, absolute offsets, referenced tables,
  shared clauses, and continuation ranges;
- no competing nonempty digest for the same product identity.

Use identity priority:

```text
sourceDigest > sourceUrl > normalized company+productName
```

Route competing nonempty digests to `version_conflict`. Route missing or
unreadable official responsibility evidence to `source_retry` or
`inventory_review`; never ask DeepSeek to guess it.

## Build Bounded Evidence Packets

Build one packet per locked responsibility. Include the complete responsibility
section and only directly applicable definitions, waiting periods, tables,
shared rules, and continuation ranges. Preserve page and absolute character
offsets. Target at most 12,000 characters without truncating a clause, formula,
or table.

Keep these structures separate:

```text
modelBlindOfficialPacket
legacyDiff
```

`legacyDiff` may identify a suspected missing target but must not enter the
model prompt as proposed truth. Do not copy historical amounts, formulas,
branches, titles, or evidence into DeepSeek input unless each value has first
been independently proven against the locked official source.

## Run DeepSeek

- Record the actual provider, model ID, endpoint profile, manifest ID,
  `sourceDigest`, prompt SHA, response SHA, timing, and call count.
- Use the configured DeepSeek structured-output model. Never print credentials.
- First pass is exactly one call per product with `repairRounds=0`.
- Generate only the locked responsibility inventory. Keep multiple legitimate
  indicators under one responsibility when the official terms define separate
  measurements, tiers, benefits, or formula branches.
- Do not create responsibility cards or indicators from waiting periods,
  definitions, exclusions, claim procedures, notices, examples, or contents
  headings.
- Treat death and total-disability wording as branches of one indicator when
  the official clause defines one combined payment responsibility. Do not split
  synonymous conditions into duplicate indicators.

DeepSeek failure stays in the DeepSeek/model layer. On authentication, billing,
rate-limit, timeout, upstream, transport, malformed-response, or context failure,
write an explicit `model_retry` receipt. Do not silently fall back to Luna,
Gemini, DianJin, or another provider. A different provider requires a new,
explicitly authorized manifest.

For malformed JSON, allow one deterministic syntax-only `jsonrepair` attempt.
It must not add, delete, or reinterpret business fields. If repair is unsafe or
the repaired artifact fails a semantic gate, route it to `model_retry` or
`validation_review` rather than calling it approved.

## Validate Every Proposal

Regenerate evidence excerpts from official text and require exact page/offset
matches. Then run, in order:

1. manifest/output identity audit;
2. repository canonicalizer;
3. repository validator with expected inventory and indicator counts;
4. dedicated importer dry-run with `ok=true`, zero issues, expected accepted
   responsibilities, and zero materialization;
5. mutually exclusive terminal routing and SHA verification.

The required indicator fields and forbidden shortcuts are defined in
[references/indicator-contract.md](references/indicator-contract.md). A provider
HTTP 200, parseable JSON, matching counts, or canonicalizer pass alone is not
approval.

Choose exactly one terminal state per product:

```text
approved
validation_review
model_retry
source_retry
inventory_review
identity_blocked
version_conflict
manual_review
```

Require terminal union to equal the manifest and pairwise intersections to be
zero. Preserve provider/result/canonicalizer/validator/importer/terminal/SHA
receipts even for failures.

## Batch Expansion

Begin with one immutable canary of at most 20 products. Expand only when there
is no systematic provider or schema failure and at least 80% pass validator and
dedicated importer dry-run. Subsequent manifests remain at most 100 products;
online concurrency must not exceed the measured healthy limit and defaults to
12 or less.

Stop only the affected provider lane on systemic authentication, billing,
rate-limit, upstream, or schema failure. Keep approved products immutable and
retry only the failed layer.

## Write Boundary And Reporting

This skill is parse-only by default. It must not write SQLite, Feishu, or
publish. A separate, explicitly authorized IMPORT lane may later write only the
configured SSD database after backup, single-writer verification, and exact
artifact-to-card-to-indicator-to-record readback.

Report `processed`, `approved`, `validationReview`, `modelRetry`,
`sourceOrInventoryBlocked`, `remaining`, and `validatedProductsPerHour`. Do not
report model calls as completed products.
