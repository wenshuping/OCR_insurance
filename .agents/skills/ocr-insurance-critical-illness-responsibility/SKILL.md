---
name: ocr-insurance-critical-illness-responsibility
description: Parse, review, or audit critical-illness and disease-insurance responsibilities from exact-version official clauses. Use for single-pay or multi-pay critical illness, grouped or ungrouped disease benefits, mild/moderate/severe tiers, additional or age-conditioned benefits, waivers, optional death or total-disability benefits, waiting-period outcomes, responsibility cards, quantitative indicators, and customer summaries.
---

# OCR Insurance Critical-Illness Responsibility

Build a source-locked responsibility inventory and structured artifact without
guessing from a product name or disease list. Read
[references/contract.md](references/contract.md) before producing an artifact.

## Safety Boundary

- Keep review read-only unless publication is separately and explicitly authorized.
- Do not write SQLite, Feishu, production, `.env.local`, or source caches during parsing or review.
- Do not call a model from this Skill. Emit one mutually exclusive route for an external runner.
- Treat existing cards, indicators, summaries, and artifacts as comparison data. Only exact-version official evidence defines responsibilities.
- Do not publish or label an item approved unless canonicalization, validator, and the dedicated importer dry-run all pass.

## Workflow

### 1. Lock identity and source

1. Resolve exact legal `company`, `productName`, version evidence, official URL,
   and `sourceDigest`.
2. Record `contractTopology` as `standalone`, `rider`, `group`, or
   `bundle_component` from exact contract evidence.
3. Verify the digest against preserved official bytes and retain complete
   responsibility text plus referenced formula tables and definitions.
4. Stop at `source_review` for missing bytes, digest mismatch, unreadable text,
   unofficial sources, or unresolved versions.

Use `sourceDigest` as the primary identity, then exact source URL, then normalized
company plus product name. Never combine distinct digests.

### 2. Build the responsibility-title inventory

Scan the complete responsibility chapter twice. Record each source heading and
classify it before writing cards:

- accept a concrete heading only when bounded evidence proves both a trigger and
  an insurer obligation;
- preserve group headings as group metadata, not responsibilities;
- reject disease definitions, exclusions, claim procedures, interpretations,
  tables of contents, and isolated descriptive headings;
- keep every rejected or unresolved heading in the audit ledger with its reason.

Do not use a disease-name dictionary to decide whether a heading is a
responsibility. Do not infer inventory from the product name.

For a rider, record the main-contract dependency separately. For a group
contract, record member eligibility separately. For a bundle component such as
a student accident plan's fixed disease benefit, record the containing contract
and component relationship separately. Apply the same critical-illness
responsibility semantics inside every topology. Never treat a marketing plan as
the governing terms.

### 3. Create one bounded evidence packet per responsibility

For every accepted title, capture the smallest exact official passages that
jointly prove:

- title and responsibility boundary;
- covered trigger and insurer obligation;
- level, disease group, count, interval, waiting period, termination, and
  mutual-exclusion rules;
- formula, percentage, amount, age, stage, and referenced definition/table.

Prefer one contiguous excerpt. Use ordered exact `evidenceSegments` for real
page, column, or cross-reference boundaries; never concatenate paraphrases.
Leave unsupported fields empty and route them to review.

### 4. Preserve critical-illness structure

- Keep mild, moderate, and severe benefits as source-defined tiers.
- Preserve grouped and ungrouped multi-pay structures, group identity, cumulative
  count, per-group count, interval, reset, and termination effects.
- Split independently headed first/second/subsequent payments and link siblings
  with `parentResponsibilityId`; keep formula-only branches inside one responsibility.
- Preserve additional benefits and exact age, diagnosis-order, policy-year, or
  disease-stage conditions as structured branches.
- Classify premium waiver as `waiver`.
- Preserve death or total-disability duties and their optional selection state.
- Represent a standalone waiting-period premium return as
  `waiting_period_refund` with `coverageAggregation: exclude`; keep a waiting
  period rule that has no separate obligation as a limit or branch.

### 5. Build artifact, cards, indicators, and summary

Use the field and evidence contract in `references/contract.md`.

1. Map each responsibility to one card by stable `responsibilityId`.
2. Give every responsibility at least one indicator or an explicit
   `not_quantitative` decision.
3. Preserve exact `formulaText`, `normalizedFormula`, `requiredInputs`,
   `branches`, `operands`, counts, intervals, ages, and source provenance.
4. Write customer summaries only from the accepted responsibility packet.
   Keep definitions, exclusions, conditions, and missing information visibly
   separate. Do not add broader promises or calculation results.

### 6. Select one external model route

Emit `deepseek-standard` only when the locked inventory is simple: one disease
benefit, no grouping or multi-pay, no mild/moderate tier, no additional or
age/stage branch, no optional package, no waiver, and no referenced table or
complex comparison.

Emit `luna-complex` for every grouped/ungrouped multi-pay, tiered, optional,
waiver, additional, age/stage-conditioned, table-dependent, multi-branch, or
uncertain case. The routes must be disjoint. A failed route remains in its own
model-failure queue; never silently fall back.

This Skill records the route only. It never sends a model request.

### 7. Run deterministic gates and exact readback

Run the existing responsibility canonicalizer and validator from the selected
pipeline Skill, then the dedicated importer in dry-run mode. Require `ok=true`,
zero validation issues, and exact expected accepted counts.

After any separately authorized publication, compare the artifact with both:

- card fields and every nested indicator; and
- `insurance_indicator_records.payload`.

Require exact stable IDs, titles, formulas, inputs, branches, operands, source
URL/digest, selection state, and customer summary. Missing provenance or a
collapsed formula is review, even when row counts or SQLite checks pass.

## Output Status

Use only:

- `approved`: all source, inventory, evidence, formula, validator, dry-run, and
  exact-readback gates passed;
- `validation_review`: exact source exists but an inventory, evidence, formula,
  summary, or deterministic gate is incomplete;
- `source_review`: exact source identity, bytes, digest, or readable evidence is
  unresolved;
- `model_retry`: the selected external route failed without a valid artifact;
- `materializer_blocked`: artifact gates passed but persisted card/indicator
  projections are not exact.

Report counts and paths for each status. `not_run` never means passed.

## Fixtures and Read-Only Audit

Use the focused fixtures under `fixtures/` to verify the generic contract. For
a bounded local database audit, run:

```bash
python3 scripts/audit_forward_test.py \
  --fixtures-dir fixtures \
  --db /absolute/path/policy-ocr.sqlite \
  --output-dir /absolute/path/empty-audit-directory \
  --sample-size 24
```

The script opens SQLite with `mode=ro` and `PRAGMA query_only=ON`; it never
publishes or calls a model.
