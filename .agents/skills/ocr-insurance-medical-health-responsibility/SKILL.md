---
name: ocr-insurance-medical-health-responsibility
description: Parse and audit exact-version Chinese medical and health insurance responsibilities, including reimbursement and fixed-benefit medical coverage, inpatient/outpatient/special-drug/proton-heavy-ion/overseas structures, riders, group contracts, and filed components of student or other bundled plans. Use when OCR_insurance must build, repair, review, or forward-test medical responsibility inventories, formulas, cards, indicators, or customer summaries without confusing definitions, exclusions, services, renewal functions, expense subitems, or marketing bundles with insurance responsibilities.
---

# Medical And Health Responsibility

Apply this Skill after an exact-version official source is `source_ready`. Read
[references/contract.md](references/contract.md) before producing a profile,
formula, card, indicator, audit, or customer summary.

## Boundaries

- Use the selected artifact's exact `company + productName + sourceDigest`.
- Treat an approved artifact, cards, indicators, and official evidence as
  separate layers. Match persisted projections by the same digest.
- Do not use a product name to infer a responsibility, calculation, topology,
  hospital scope, social-insurance branch, deductible, ratio, or limit.
- Do not borrow a rule from another version, plan, rider, company, or similar
  product.
- Keep source acquisition, parsing, validation, dry-run, publication, and
  readback as distinct gates. Model or runner success is not approval.
- Keep read-only work read-only. Do not write SQLite, Feishu, or published data
  unless the user separately authorizes publication.

## Workflow

1. Lock the exact official source digest and responsibility chapter.
2. Classify contract topology as `standalone`, `rider`, `group`, or
   `bundle_component` from exact evidence. If evidence is insufficient, stop
   that field at review; never infer it from `附加`, `团体`, `学平`, or `学生`.
3. Build the official responsibility-title inventory before extracting fields.
4. Classify every candidate block as responsibility, definition, expense
   definition, exclusion, shared rule, service, product function, group
   heading, care process, or claims process.
5. Build one bounded evidence packet per accepted responsibility, plus only its
   applicable shared rules, definitions, schedules, and topology clauses.
6. Extract the medical profile and calculation structure in the contract.
7. Build one card per contractual payment or reimbursement obligation. Keep
   expense components under their owning responsibility unless the source gives
   each component an independent title, trigger, and insurer obligation.
8. Put shared deductibles, ratios, and aggregate limits in `productRules` and
   reference them. Preserve responsibility-specific expense scope and sublimits.
9. Put renewal or guaranteed-renewal terms only in `productFunctions`, and
   non-insurance health or assistance services only in `productServices`.
10. Run the main pipeline canonicalizer, validator, and dedicated importer
    dry-run. Approval requires all three, not this profile alone.
11. Compare the artifact, cards, indicators, and customer summary by stable
    responsibility ID, formula structure, source URL, and source digest.

## Split Gate

- Split independently titled insurance payments or reimbursements.
- Keep mutually exclusive calculation branches inside one responsibility.
- Keep `住院费用`, `门诊费用`, `药品费`, `检查费`, and similar covered-expense
  items under the total responsibility when they only define its expense scope.
- Keep a total responsibility when it has its own contractual obligation or
  aggregate limit; use `parentResponsibilityId` for independently payable child
  responsibilities.
- Do not create cards from `释义`, `除外责任`, `如何申请理赔`, hospital-network
  instructions, or a plan table heading.
- Return `review` for an ambiguous parent/child boundary. Do not delete a total
  responsibility or create child cards merely to satisfy counts.

## Medical Calculation Gate

- Distinguish `reimbursement`, `fixed_benefit`, and `mixed`.
- For reimbursement, preserve actual eligible expense, other compensation,
  deductible, reimbursement ratio, applicable limit, and every social-insurance
  branch in source order.
- For fixed benefits, preserve fixed amount or daily amount, actual eligible
  days/counts, per-event and annual caps, and termination effects.
- Preserve hospital, department, network, geography, social-insurance identity,
  waiting period, pre-existing-condition/exclusion references, annual/lifetime/
  single-event/shared/sub-limits, and payment counts only when evidenced.
- Use `branches` for mutually exclusive conditions and `operands` only for
  literal max/min comparisons.
- Omit an unsupported number or scope and route it to review. Never fill it from
  a product name, card, similar product, marketing plan, or model knowledge.

## Topology Gate

- `rider`: retain the main-contract dependency, termination linkage, and any
  insured-amount or premium reference. Unknown main-contract identity remains
  unknown.
- `group`: retain policyholder-group identity, member eligibility, effective
  entry/exit rules, and whether limits are member-specific, shared, or
  item-specific.
- `bundle_component`: first map a marketing/student plan to each actual filed
  product and terms digest. A brochure or plan sheet is discovery evidence only
  and cannot prove the component's final responsibilities.
- Parse a medical component with the same medical profile rules after its filed
  identity is locked.

## Resources

- Validate the focused fixtures:

```bash
python3 scripts/validate_medical_fixtures.py references/fixtures
```

- Run the read-only SSD forward test:

```bash
python3 scripts/forward_test_ssd.py \
  --db /absolute/path/policy-ocr.sqlite \
  --output /absolute/path/forward-test.json \
  --sample-size 24
```

The forward test never writes SQLite. It reports cohort identity, sample
stratum, topology evidence, exact-digest layer gates, split risks, and
numeric/evidence omissions. Treat its heuristics as review signals, not parser
authority.
