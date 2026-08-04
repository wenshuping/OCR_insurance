---
name: ocr-insurance-unified-responsibility-parser
description: Orchestrate source-locked insurance responsibility parsing across all OCR_insurance product families without duplicating domain rules. Use for one product or a full responsibility backfill when Codex must build one inventory per official source digest, assign exactly one domain owner and reusable payment profile per responsibility, route bounded field proposals to DeepSeek or Luna, run deterministic approval gates, or audit artifact/card/indicator alignment.
---

# Unified Insurance Responsibility Parser

Use this Skill as the only orchestration entry point. Delegate domain semantics
to the existing Skills; do not reimplement their rule packs here.

Read [references/contract.md](references/contract.md) before creating a
manifest, inventory, artifact, status, or approval decision. Read
[references/routing-matrix.md](references/routing-matrix.md) before assigning
an owner, payment profile, model route, or contract topology.

## Safety boundary

- Resolve the active repository/worktree and preserve all unrelated dirty work.
- Default to parse-only and read-only. Do not write SQLite, Feishu, published
  cards, `.env.local`, or production data without separate explicit authority.
- Do not call a network or model during offline audit or forward-test work.
- Never treat existing `approved`, card presence, importer success, or
  `quick_check` as a current validation pass.
- Do not change a production parser to accommodate one product. Record the gap
  in the handoff and add a focused fixture.

## Workflow

1. Build an immutable product manifest. Deduplicate in this order:
   `sourceDigest > sourceUrl > normalized company+productName`.
2. Pass every source through the official-source gate. Stop it at
   `source_pending`, `source_blocked`, or `version_conflict` unless exact
   identity, official bytes/digest, readable responsibility text, and source
   contract all pass.
3. Build and lock the responsibility-title inventory exactly once per
   `sourceDigest`. Reuse the locked inventory for every downstream domain Skill.
   An event cause or condition is not a second responsibility: when one official
   heading owns “身故或/和身体全残保险金”, keep disease, accident, waiting-period,
   age, and payment-period variants as branches under that one responsibility
   and one indicator decision. Do not emit a separate “疾病全残” indicator.
4. Create one bounded evidence packet per locked responsibility. Include its
   complete section and only directly applicable shared clauses, definitions,
   tables, topology evidence, and continuation ranges.
5. Assign one `ownerProfile` and one or more reusable `paymentProfile` values
   per responsibility using the routing matrix. Invoke only the owning domain
   Skill for that responsibility. Send owner ambiguity or duplicate ownership
   to `manual_review`.
6. Keep product labels and product functions separate from ownership. A product
   can be multi-label; a responsibility cannot have multiple owners.
7. Select one mutually exclusive model route from deterministic evidence.
   Models may propose fields or decide a bounded field conflict only. They may
   not edit official titles, responsibility IDs, source digests, numeric tokens,
   or evidence text.
8. Regenerate the final artifact from locked identity and official offsets.
   Run the existing canonicalizer, validator, and dedicated importer dry-run.
9. After separately authorized publication, compare the artifact with cards,
   every nested indicator, and `insurance_indicator_records.payload` by exact
   identity and semantic fields.
10. Emit exactly one terminal status from the contract and preserve every
    failure-layer receipt. `not_run` is never a pass.

## Domain composition

Use these existing Skills as delegated profiles:

- `$ocr-insurance-medical-health-responsibility`
- `$ocr-insurance-critical-illness-responsibility`
- `$ocr-insurance-accident-responsibility`
- `$ocr-insurance-term-life-responsibility`
- `$ocr-insurance-annuity-responsibility`
- `$ocr-insurance-long-term-care-responsibility`
- `$ocr-insurance-endowment-responsibility`
- `$ocr-insurance-universal-account-responsibility`
- `$ocr-insurance-incremental-whole-life-responsibility`

Use `$ocr-insurance-fast-responsibility-pipeline` for bounded packet execution,
`$ocr-insurance-responsibility-backfill` for immutable batch accounting, and
`$ocr-insurance-single-product-responsibility-review` for disputed products.

`standalone|rider|group|bundle_component` is an orthogonal contract-topology
layer. Do not create separate parsers for riders, group products, student plans,
or bundles.

## Required deterministic fields

For every responsibility preserve:

```text
sourceDigest, responsibilityId, officialTitle, evidencePacketId
ownerProfile, paymentProfile
triggerCondition, insurerObligation, importantLimits
formulaText, normalizedFormula, requiredInputs, operands, branches
sourceUrl, sourcePage/offsets, exact evidence segments
```

Preserve topology and product functions at product scope. Examples:

- accident medical: `ownerProfile=accident`,
  `paymentProfile=medical_reimbursement`;
- universal annuity: annuity responsibilities owned by `annuity`, while account
  settlement and fees remain `universal_account` product functions;
- endowment plus accident extra payment: maturity/death obligations owned by
  `endowment`, independently headed accident extras owned by `accident`.

## Responsibility alias boundary

- Merge neither by wording similarity nor by product name. Independent official
  headings with independent obligations remain independent responsibilities.
- Treat `疾病全残` or `疾病全残保险金` as a legacy alias only when exact official
  evidence proves it belongs to the same combined death/full-disability heading.
- Collapse the alias only for the same non-empty `sourceDigest`, or when both
  digests are absent and the normalized official `sourceUrl` is identical.
- Different non-empty digests are `version_conflict`; preserve both versions.
- Accident disability, traffic disability, disease waiver, premium waiver, and
  separately headed total-disability benefits are not aliases.
- Persist cause variants in `branches`/`operands` and verify that the artifact,
  card, nested indicators, and indicator table retain one stable responsibility
  and indicator identity after materialization.

## Model routing

- Use `deepseek-standard` only for source-complete simple term life, ordinary
  annuity, or another few-responsibility single-branch product.
- Use `luna-complex` for medical, critical illness, accident, long-term care,
  multi-responsibility, multi-branch, complex cashflow, max/min/table, disputed
  ownership, or historical validation failure.
- Disable Gemini and DianJin.
- A DeepSeek failure remains `model_retry` on the DeepSeek route. Never silently
  fall back to Luna.

## Offline verification

Validate the fixture contract:

```bash
python3 scripts/validate_unified_parser.py --fixtures fixtures
python3 -m unittest scripts/test_unified_parser.py
```

Run the bounded SSD audit:

```bash
python3 scripts/forward_test_readonly.py \
  --db /absolute/path/policy-ocr.sqlite \
  --output-dir /absolute/path/audit-output \
  --sample-size 48
```

The forward test opens SQLite with `mode=ro`, enables `query_only`, uses scoped
card/indicator reads after product selection, and writes only JSON/SHA audit
files to the requested output directory. It does not call a model, importer,
publisher, network service, or Feishu.

Validate all generated JSON and the SHA manifest:

```bash
python3 scripts/validate_unified_parser.py \
  --fixtures fixtures \
  --audit-dir /absolute/path/audit-output
```

## Completion report

Report absolute paths, immutable sample size and dedupe counts, owner and
payment coverage, DeepSeek/Luna route counts, owner conflicts, duplicate
responsibilities, gate failures by layer, exact card/indicator alignment,
systemic gaps, every command run, and every skipped gate with its reason.
