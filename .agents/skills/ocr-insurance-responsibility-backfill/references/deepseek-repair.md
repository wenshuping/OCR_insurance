# Legacy DeepSeek Responsibility Repair

Use this contract only for `deepseek-repair` runs coordinated by the
responsibility-backfill skill.

## Authority And Scope

1. Pin the development database and immutable current-approved manifest.
2. Recompute all counts from those exact inputs before building a queue. For the
   current handoff, assert:

```text
legacy DeepSeek published artifacts = 4059
current approved products = 4997
overlap by canonical product identity = 3759
legacy-only products = 300
```

Treat these as snapshot assertions, not permanent constants. Stop and regenerate
the audit if any count differs. Never reuse earlier risk-tier counts such as
`1996 / 1705 / 352 / 6`; recompute tiers from the current database and
validator.

3. Give the current approved result absolute precedence. Partition overlapping
   products by `sourceDigest`:

- `same_source`: exact digest match; eligible for deterministic field repair.
- `version_conflict`: missing or different digest; do not overwrite, merge, or
  publish the legacy result over the current approved result.

Keep current-approved-only products out of the repair queue. Keep legacy-only
products in a separate cohort and require an unchanged `source_ready` manifest
before publication; otherwise invoke
`$ocr-insurance-official-source-acquisition`.

## Repair Contract

Generate a new immutable repair artifact. Never update legacy artifact JSON in
place.

For every indicator, branch, and referenced shared rule:

1. Map only semantically equivalent aliases into canonical `requiredInputs`.
2. Remove constants such as a literal zero or evidence-backed fixed amount from
   `requiredInputs`.
3. Preserve every input that cannot be mapped losslessly under
   `unresolvedRequiredInputs` or equivalent immutable audit metadata. Record at
   least its original value, artifact location, and unresolved reason.
4. Set `calculationEligible: false` when an unresolved input affects the
   formula.
5. Use `manualFormulaInputs` only when the merge contract calls for manual
   formula execution. Never use it as a lossy replacement for unknown business
   operands or discard the corresponding unresolved metadata.
6. Compute a parent indicator's canonical inputs as the union of direct inputs,
   every branch input, and inputs from explicitly applicable referenced rules.
7. Reject missing rule references and rules whose scope does not explicitly
   include the responsibility, responsibility group, or whole product.
8. Require every number, percentage, boundary, operator, and important limit to
   occur in the responsibility branch's exact evidence or an explicitly
   referenced shared rule that applies to it.

`unresolvedRequiredInputs` is audit metadata, not a calculation-engine input
dictionary. Preserve it through validation and import, but never pass it to the
runtime calculator.

## Routing

Run this sequence exactly:

```text
legacy DeepSeek artifacts
-> current-database re-audit
-> canonical product match
-> sourceDigest partition
-> deterministic requiredInputs / branch-union / ruleRefs repair
-> deterministic validator
-> Gemini verifier for failed responsibility packets only
-> high-capability reviewer for still-unresolved semantic packets only
-> importer dry-run
-> serial publication and exact readback
```

Use `$ocr-insurance-fast-responsibility-pipeline` for deterministic gates,
bounded evidence packets, table repair, verifier routing, and importer dry-run.
Use `$ocr-insurance-responsibility-merge` for formula branches, shared-rule
scope, mutual exclusion, canonical fields, and final merge artifacts. Use
`$ocr-insurance-single-product-responsibility-review` for the high-capability
queue and pilot-level human review. Use
`$ocr-insurance-official-source-acquisition` only for missing pages, damaged
OCR, lost table columns, uncertain versions, or source conflicts; never ask a
model to guess through those defects.

Do not send an entire product document to Gemini or the high-capability
reviewer. Send only the failed responsibility packet, applicable shared clauses,
exact official offsets, and deterministic failure receipt. Do not rerun
responsibilities that already passed.

## Immutable Batches And Publication Isolation

- Build deterministic immutable manifests of 100 products after deduplication.
- Make the first cohort no larger than 50 representative products and include
  every currently calculation-enabled high-risk product that fits. Quarantine
  all such products before review.
- Keep source conflicts, source repair, deterministic failures, verifier
  failures, high-capability review, importer failures, and publish failures in
  separate resumable queues.
- Preserve before/after artifact digests, source digest, validator version,
  repair reasons, provider/model IDs, and retry ancestry in every receipt.
- Produce repair artifacts without writing SQLite. Back up the development
  database only after a batch passes all gates.
- Publish one batch at a time. Materialize the repair artifact, indicators, and
  responsibility cards from the same repair version in one serial publication
  transaction.
- Do not touch a current approved product unless its source digest matches the
  legacy artifact and every deterministic, importer, and exact-readback gate
  passes.
- Do not sync Feishu unless explicitly requested.

## Repair Gates

Fail a product or batch when:

- baseline snapshot counts or manifest digests changed;
- a current approved result would be replaced by a different or missing source
  digest;
- canonical product identity is ambiguous;
- an original unknown input disappeared from both canonical inputs and
  unresolved audit metadata;
- `calculationEligible` remains true with unresolved inputs or an unsupported
  runtime calculation key;
- responsibility titles, branch counts, table rows, rule scope, numeric
  evidence, or required inputs fail deterministic validation;
- artifact titles, materialized card titles, and accepted indicator liabilities
  differ;
- importer dry-run is not clean.

Report freshly computed cohort and tier counts, same-source products, version
conflicts, legacy-only products, deterministic passes, Gemini escalations,
high-capability escalations, source repairs, unresolved inputs, published
products, skipped current-approved products, and the exact resume cursor.
Candidate-tier counts are ceilings; report actual model calls separately.
