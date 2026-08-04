---
name: ocr-insurance-fast-responsibility-pipeline
description: Run the fast, source-grounded OCR_insurance responsibility workflow from official-source acquisition through bounded low-cost model extraction, capability-based merge-model routing, deterministic validation, and optional development publication. Use for one product, batch backfills, daily-refresh handoffs, 403-blocked insurer sites, newly crawled terms, missing responsibility cards, or inaccurate long-document model parses.
---

# OCR Insurance Fast Responsibility Pipeline

Optimize for source fidelity first, then cost and speed. Never send an unbounded
document to one model and trust the result.

Read [references/quality-gates.md](references/quality-gates.md) before accepting
or publishing an artifact.
Read
[references/local-candidate-assistant.md](references/local-candidate-assistant.md)
when a local text model assists online extraction.
Read [references/extraction-contract.md](references/extraction-contract.md)
before building model inputs or accepting extraction proposals.
Read
[the responsibility formula rule packs](../ocr-insurance-responsibility-merge/references/formula-rule-packs.md)
before routing formulas or scheduled cashflows.
Read [references/high-throughput-batch.md](references/high-throughput-batch.md)
when the request covers multiple products, a backfill, or a throughput test.
Read and run
`$ocr-insurance-manifest-output-integrity` before canonicalization, validation,
importer dry-run, retry/resume selection, or approved-artifact reuse. It is a
mandatory identity gate for every batch path; a non-zero audit is an identity
block, not `validation-review` or `model-retry`.

## Stage 1: Acquire Official Evidence

Invoke `$ocr-insurance-official-source-acquisition`.

- Reuse unchanged official source digests.
- Route 403 and JavaScript pages through the documented browser ladder.
- Invoke `$insurance-official-headless-pdf` when a public official disclosure
  page requires real Chrome or when an official PDF is AES encrypted. Preserve
  the original bytes, allow only empty-user-password decryption, record
  encryption metadata, and use OCR only when the decrypted text layer is
  unreadable.
- Do not send an encrypted PDF directly to `source-retry` solely because the
  current `pypdf` runtime lacks a crypto dependency. Run the headless/encrypted
  PDF acquisition route first; reserve `source_blocked` for an unproven source,
  access gate, version mismatch, damaged bytes, or a required non-empty password.
- Continue only when the source manifest is `source_ready`.
- Keep screenshot OCR products in review until numbers and tables are verified.

## Stage 2: Index And Lock Responsibility Inventory

Index official text with page, heading, paragraph, table, and absolute character
offsets. Then:

1. Locate the complete responsibility chapter and reject contents-page title
   duplicates.
2. Build the official title and section-boundary inventory before extracting
   summaries or formulas.
3. Keep separately named responsibilities separate; keep tiers, groups, and
   formula branches under their official parent title.
4. Map directly applicable waiting periods, payment restrictions, tables,
   definitions, and continuation ranges to stable responsibility IDs.
5. Preserve extraction markers in raw evidence only.

If chapter boundaries are uncertain, use complete extracted text for repair
rather than declaring a responsibility absent.

### Legacy Card And Indicator Reuse

After the official inventory is locked, invoke
`$ocr-insurance-legacy-indicator-safe-reuse` when historical responsibility
cards or indicators exist. Keep its model-blind official packet separate from
the legacy diff. Use exact reuse only for source-supported one-to-one matches;
send only proven missing targets to bounded extraction, and route broad or
version conflicts to fresh parse or review. Never let legacy values determine
the official inventory or enter model prompts as proposed truth.

## Stage 3: Shadow Local Candidate Assistant

Start a configured local text model after deterministic reduction, in parallel
with online extraction. The online branches must not wait for it.

- Address the assistant through a replaceable adapter with `baseUrl`, `modelId`,
  `apiStyle`, `timeoutMs`, generation settings, and measured capability roles.
  Do not key behavior from a model name.
- Before replacing an existing assistant, replay the same source-digest-pinned
  benchmark packets against both models and apply the promotion rules in
  [references/local-candidate-assistant.md](references/local-candidate-assistant.md).
- Use it for page classification, responsibility-title candidates, clause
  labels, risk signals, and exact-span candidates.
- Require page numbers and source offsets for every evidence candidate.
- Discard any candidate excerpt that is not an exact substring of official
  extracted text.
- Never let the local model remove a page or clause selected by deterministic
  rules.
- Send the deterministic evidence packet to online extraction immediately.
- Accept local candidates only when they arrive before merge, pass deterministic
  validation, and add evidence not already present.
- Do not restart completed online branches when late local candidates arrive.
- Route a material, validated local-versus-online inventory disagreement to the
  verifier; otherwise keep the local result as audit metadata only.
- Treat local timeout, malformed output, unavailable service, or low benchmark
  performance as a non-blocking shadow failure.

The local model is replaceable. Record its actual provider and model ID as run
metadata; do not make a particular model part of the workflow contract.
Keep a newly selected model in shadow mode until its measured recall and
structured-output reliability pass. A domain model may replace the previous
assistant without changing the online extractor or merge-model routing.
Promote capabilities independently: a model that passes formula-branch review
but fails title-inventory or latency gates may assist formulas only.

## Stage 4: Bounded Parallel Online Extraction

Before starting or resuming a batch, bind every selected/input/provider/artifact/
terminal row by `sourceDigest` (then `sourceUrl`, then normalized company plus
product name only as fallback). Treat manifest and selected ordinals as display
fields only; never join or fill a gap by ordinal, including copying the final
item during resume. Require terminal union to equal the manifest and terminal
queue intersections to be zero. Stop with `identity_blocked` or
`manifest_output_identity_misaligned` until the identity audit passes.

Build one evidence packet per locked responsibility using the extraction
contract. Each packet contains the complete responsibility section plus only its
applicable shared clauses, referenced definitions, tables, and continuation
ranges.

Run these bounded proposal tasks:

1. `coverage-facts`: triggers, obligations, limits, deductions, payment counts,
   intervals, mutual exclusion, and termination effects with exact offsets.
2. `calculation-structure`: formula branches, operands, operators, numeric
   tokens, structured table cells, and canonical input proposals.
3. `customer-wording`: only after facts and formulas validate; generate concise
   wording from validated structured fields, not the long document.

Keep packets below the extraction-contract target without truncating a clause or
formula. Batch only small packets with stable IDs. Validate exact source slices
and retry only the failed task for the failed responsibility.

These tasks are read-only proposals. Do not allow any branch to write SQLite,
Feishu, code, or the final artifact.

Invoke `$ocr-insurance-deepseek-indicator-generation` for the automatic online
indicator-generation step. DeepSeek receives only the model-blind official
packets and must produce the provider, artifact, canonicalizer, validator,
dedicated importer dry-run, terminal, and SHA receipts required by that Skill.
Historical cards and indicators remain outside the prompt as `legacyDiff`.

## Stage 5: Deterministic Formula Routing

Classify each official responsibility by clause and formula shape using the
responsibility formula rule packs. A product may use several packs.

1. Build the result from official section offsets and applicable shared clauses.
2. Auto-merge a responsibility when title, evidence, numeric coverage, formula
   branches, and canonical inputs pass deterministic checks.
3. Keep complete tables, tiered formulas, and `max`/`min` expressions
   programmatic when their structure is provable; store unsupported calculations
   as `manual_formula`.
4. Before declaring a local-versus-online conflict, normalize equivalent Chinese
   and Arabic numerals and percentages, include structured `importantLimits` in
   numeric coverage, and reject generic chapter titles such as `保险责任`.
5. Treat branch comparison asymmetrically: a validated artifact with more
   source-grounded branches than the local candidate is not an omission. Escalate
   only when official evidence supports a material branch or constraint missing
   from the validated artifact.
6. Send only unresolved responsibility packets to a verifier.
7. Route missing pages, damaged tables, or unreadable OCR to source repair
   instead of a stronger merge model.

Regenerate final evidence from official text after either programmatic or model
merge. Never retain a model-written excerpt.

## Stage 6: Merge Model Routing

Use the cheapest model that passes deterministic gates:

1. Keep deterministic `auto_merge` responsibilities without model rewriting.
2. Let the cheapest configured verifier resolve only `verifier_required`
   responsibility packets with the fixed schema and canonical field dictionary.
3. Escalate to the configured high-capability reviewer only when verification
   still leaves responsibility ownership, branch scope, package boundary, or
   semantic conflicts.
4. Never use a reviewer to compensate for `source_repair_required`.

Use `$ocr-insurance-responsibility-merge` for merge rules regardless of
which model performs the merge.

Choose models by measured capability, context support, structured-output
reliability, latency, and price. Do not make a provider or model ID part of the
workflow contract. Record the actual `provider` and `modelId` in run metadata.

### Role-Based Model Routing

Treat the online models as replaceable roles, not as one global provider. A run
may define these roles independently:

- `standard_extractor`: the measured low-cost model for ordinary products;
- `complex_extractor`: the measured high-capability model for complex products;
- `verifier`: the model that resolves only bounded validation or semantic
  conflicts;
- `local_shadow`: a non-blocking local candidate assistant.

The default automatic indicator generator is DeepSeek. It must use
`$ocr-insurance-deepseek-indicator-generation` and record the actual provider
and model ID. DeepSeek failures remain explicit DeepSeek/model-layer failures;
do not silently move them to Luna, Gemini, DianJin, or another provider. A
different verifier or reviewer may be used only through a new, explicitly
authorized manifest, never as implicit failover inside the same run.

Route a product to the complex pool when deterministic manifest evidence shows
one or more of the following:

- medical, million-medical, critical-illness, or other health insurance with
  reimbursement, provider-network, deductible, compensation, or multi-item
  medical rules;
- critical illness products with light/medium/severe illness tiers, repeated
  claims, group limits, disease definitions, or waiver interactions;
- annuity, endowment, participating, universal, or whole-life products with
  survival/maturity cashflows, policy-year schedules, dividend/account values,
  multiple death or disability bases, or branch formulas;
- accident or rescue products with disability-grade tables, overseas assistance
  services, multiple service caps, or table-derived benefits;
- any product whose locked inventory contains structured tables, `max`/`min`,
  multiple formula branches, cross-page continuation, or a prior
  `validation-review`/`high-capability-review` result.

Medical and critical-illness product categories route directly to the complex
pool. Simple accidental death and single-branch term-life responsibilities may
remain in the standard pool after the pinned benchmark confirms equivalent
validator quality. For categories other than medical and critical illness,
product category alone never overrides source or validator gates.

Apply the routing threshold narrowly. A category word in `productName` never
counts as structural evidence, except for the explicit medical and
critical-illness category override. Route other products directly to the
complex pool for an explicit prior-review receipt or one strong signal such as
repeated claims, disease-group intervals, or a numeric benefit table. Otherwise
require at least two independent signals from the responsibility evidence, such
as a scheduled cashflow plus annual/monthly options. A standard-pool validator
failure may escalate the bounded product to the complex pool.

Build disjoint immutable manifests for the standard and complex pools. A
product belongs to one primary extraction pool only; a later verifier may see
the approved artifact, exact evidence window, and conflict packet, but must not
restart both full parses. Both pools use the same source digest, extraction
contract, canonical fields, validator, and importer dry-run rules.

Complex-model results are not automatically trusted because the model is more
capable. Require the same official inventory, exact-evidence, numeric-coverage,
responsibility/indicator one-to-one, and importer dry-run gates as the standard
pool. Keep model cost, latency, token usage, approval status, and escalation
reason in the receipt so the two pools can be compared.

## Stage 7: Deterministic Gates

Require:

- official title inventory equals accepted responsibility inventory;
- accepted responsibilities and internal checks are one-to-one;
- every number, percentage, boundary, operator, and important limit has official
  evidence;
- no invented calculation input field;
- `basis` describes calculation basis, not merely trigger conditions;
- tiered and max/min formulas retain every branch and operand;
- unknown values are omitted;
- customer text contains no internal audit vocabulary;
- importer dry-run returns `ok: true`, zero issues, and expected count.

Model self-reported confidence or `mergeAudit.finalCrossChecks` does not satisfy a
gate.

### Deterministic Table Review

After packetized shadow comparison, send a review queue through deterministic
table repair only when every material conflict is
`numeric_tokens_missing_from_artifact`. Each JSONL record must contain the
immutable `artifactPath` and its `comparisonPath`; company and product name are
optional.

```bash
python3 \
  "$REPO/.agents/skills/ocr-insurance-fast-responsibility-pipeline/scripts/run_review_table_repair_pipeline.py" \
  --review-queue="$REVIEW_REQUIRED_JSONL" \
  --output-dir="$IMMUTABLE_REPAIR_OUTPUT"
```

The coordinator runs:

```text
review queue -> deterministic table repair -> validator -> importer dry-run
```

It never overwrites the input artifact and never writes SQLite, Feishu, or
published cards. Treat only `ready-for-import.jsonl` as release-gated output.
Require the validator responsibility count and importer accepted count to equal
the repaired artifact count, zero importer issues, zero materialization, and no
dry-run database file. Route ambiguous or damaged tables to
`source-repair-required.jsonl`; route mixed or semantic conflicts to
`unhandled-review.jsonl`. Do not use this path to infer missing responsibility
titles, ownership, package boundaries, or unsupported formula bases.

## Stage 8: Publish Serially

For review-only work, stop after validated artifact output.

For requested publication:

1. Back up the development SQLite database.
2. Import one validated batch serially.
3. Materialize cards.
4. Read back exact titles, limits, formulas, required inputs, and source fields.
5. Require artifact titles, card titles, and accepted indicator liabilities to
   match exactly.
6. Sync Feishu only when explicitly requested, with dry-run and readback.

Never run parallel database or Feishu writes.

## Batch And Daily Refresh

### Shared DeepSeek Provider Breaker Recovery

When a DeepSeek request returns an explicit authentication, spend, billing,
quota, rate-limit, or upstream failure, stop new DeepSeek work and write a
provider-layer stop receipt. This is a pause marker, not a source failure or
permanent product state.

The coordinator must recover the marker in two phases:

1. Preserve the original receipt and atomically move it to a temporary
   `*.pending-canary` name. Run exactly one DeepSeek product from the next
   immutable manifest with `workers=1`, `repair-rounds=0`,
   `--parse-only`, and shadow disabled. The canary must complete the normal
   validator and must not write SQLite, Feishu, or published cards.
2. If the canary returns another spend-based `429`, restore the shared stop
   marker and end the recovery attempt. If it is approved by the validator,
   archive the stop receipt as a recovery record and resume only in a new
   immutable output directory. Never delete the evidence, blindly retry the
   whole batch, or rerun an existing approved product.

Every recovery receipt must record the stop reason, canary product/digest,
provider/model, validator result, timestamps, and the resumed manifest. A
stale marker must therefore be tested, not manually deleted.

- Deduplicate by normalized official URL and source digest before model work.
- Use the `balanced-12` profile from
  [references/high-throughput-batch.md](references/high-throughput-batch.md) by
  default: three disjoint lanes, one active batch per lane, four online workers
  per batch, and 100 products per immutable manifest.
- Keep the first pass to one online extraction attempt
  (`repair-rounds=0`). Do not make healthy products wait while one product
  performs repeated model repair.
- Run the local candidate assistant with at most its measured serving
  concurrency. It remains non-blocking: queued, late, timed-out, or malformed
  shadow work must not reduce online throughput.
- Use the existing validated batch runner as the high-throughput path with
  DeepSeek as the configured automatic indicator generator. Provider choice
  must not change retrieval, canonicalization, validation, or publication
  behavior.
- Persist model billing/auth/rate-limit/upstream failures separately from source
  acquisition failures. A bare model HTTP error must never be reported as an
  insurer-site failure.
- Resume failed cohorts by failure layer. Keep successful products immutable;
  after a DeepSeek provider incident, retry only the DeepSeek model cohort in a
  new immutable output directory after a one-product recovery canary.
- Do not automatically fail over thousands of products to another paid model.
  Require an explicit retry command with the replacement provider and preserve
  both provider/model IDs in the product receipts.
- Parse only new or changed `source_ready` manifests.
- Keep `source_blocked`, `ocr_needs_review`, parse failures, and publish failures
  in separate queues.
- Parallelize source retrieval and candidate extraction branches within bounded
  concurrency.
- Cache local candidate packets by source digest and model ID, but rebuild them
  when either changes.
- Start local shadow inference and online extraction concurrently. Record
  `onlineReadyMs` separately from `shadowReadyMs`; never include shadow-only wait
  time in main-path latency.
- Compare validated late shadow results offline against the immutable approved
  artifact. Apply the same deterministic normalization rules before creating a
  high-capability-review packet.
- For an approved complex product whose whole-product shadow output is
  truncated, malformed, or exceeds four locked responsibilities, run
  `scripts/run_packetized_shadow.py`. Build packets from the immutable approved
  inventory and exact artifact evidence. Default to one responsibility per
  packet; use two or three only after a pinned benchmark passes. Require every
  locked responsibility ID exactly
  once, reject unknown or duplicate IDs, validate numeric tokens against each
  packet's official evidence, cache successful packets, and retry only failed
  packets. Merge packets programmatically. Do not ask a model to merge packet
  outputs.
- When a validated local packet recovers a complete source table whose numeric
  rows exist in official evidence but are absent from artifact branches or
  evidence tokens, route the responsibility to deterministic table repair.
  Do not use a high-capability reviewer merely to copy provable table cells.
- Serialize final merge per product only when evidence conflicts; otherwise batch
  low-risk products.
- Persist a resume cursor so a daily run does not restart completed products.
- Measure successful validated products per hour, not merely completed
  requests. Authentication, billing, rate-limit, and upstream failures can
  return quickly and must not be counted as parsing throughput.

## Completion Report

Report counts for cache hits, direct successes, browser successes, screenshot
OCR, blocked sources, parsed products, first-pass products, verifier
escalations, high-capability-review escalations, validation failures, published
products, and exact resume point. Include official inventory count, packet count,
largest packet size, per-task retries, table/source repairs, unresolved
shared-clause links, and deterministic/verifier outcome per responsibility.
Include the actual provider and model ID for each model role, plus
local-assistant availability, latency, exact-span pass rate, and candidate-page
recall against the final accepted evidence.
