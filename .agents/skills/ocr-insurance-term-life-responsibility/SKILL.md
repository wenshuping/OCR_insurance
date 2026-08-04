---
name: ocr-insurance-term-life-responsibility
description: Parse, review, or audit Chinese term-life responsibilities from exact-version official evidence, including standalone, rider, group, borrower, decreasing-sum-assured, and bundle-component contracts. Use when OCR_insurance must distinguish term life from whole life, increasing whole life, annuity, or universal-account products; preserve death or total-disability triggers, waiting-period branches, premium/cash-value/sum-assured comparisons, contract topology, and exact card/indicator readback without guessing from a product name.
---

# OCR Insurance Term-Life Responsibility

Parse Chinese term-life contracts as source-backed claim-contingent protection.
Do not infer a responsibility or product subtype from a product name.

Read [references/contract.md](references/contract.md) before producing an
artifact. Run the fixture and SSD checks with
[`scripts/forward_test_term_life.py`](scripts/forward_test_term_life.py).

## Boundaries

- Cover standalone term life, attached term life, group or borrower term life,
  decreasing term life, and a term-life component inside a documented bundle.
- Keep `semanticFamily: term_life` independent from
  `contractTopology: standalone|rider|group|bundle_component`.
- Do not reclassify a contract as increasing whole life merely because it has
  cash value, a changing sum assured, or a premium comparison.
- Exclude whole life, increasing whole life, annuity, endowment cashflows,
  universal accounts, and pure waiver or accident products unless the exact
  reviewed responsibility is a term-life component with explicit scope.
- Reject definitions, exclusions, claims procedures, beneficiary designation
  procedures, surrender rules, and generic headings as responsibilities.
- Treat existing cards, indicators, and summaries as comparison targets, never
  as evidence of completeness.
- Use Chinese insurer or regulator materials tied to the exact product/version.
  Do not apply United States policy, litigation, or jurisdiction rules.

## Workflow

1. Invoke `$ocr-insurance-official-source-acquisition` unless an unchanged
   `source_ready` manifest already proves the exact official bytes.
2. Lock the exact `(company, productName, sourceDigest)` identity. Reject
   cross-version or same-name substitutions.
3. Invoke `$ocr-insurance-responsibility-inventory` and independently bound the
   responsibility chapter. Record every accepted or rejected heading.
4. Build one bounded evidence packet per responsibility. Include its complete
   section, applicable waiting-period or termination clause, referenced
   definition, formula table, and topology clause only.
5. Apply the field and formula contract in `references/contract.md`. Preserve
   exact conditions, formula branches, max/min operands, required inputs,
   responsibility effective period, and termination effects.
6. Invoke `$ocr-insurance-responsibility-card-builder` and
   `$ocr-insurance-indicator-mapper`. Keep customer wording separate from
   internal formula and validation fields.
7. Invoke `$ocr-insurance-responsibility-audit`, then run the selected current
   pipeline canonicalizer, validator, and dedicated importer dry-run.
8. Compare artifact, cards, indicators, and customer summary by stable
   `responsibilityId`, exact identity triple, formula, branches, required
   inputs, source URL, and source digest. Approval requires exact readback.
9. Omit an unsupported field and route the product to review. Never fill a gap
   from a similar product or from general insurance knowledge.

## Contract Topology

Record one topology from explicit official evidence:

- `standalone`: the responsibility is governed by the reviewed main contract.
- `rider`: an attached contract depends on a named or referenced main contract.
- `group`: coverage is attached to eligible group members and their personal
  insurance periods.
- `bundle_component`: the term-life responsibility is one documented component
  of a combined plan or package.

For `rider`, record main-contract dependency and termination linkage. For
`group`, record membership/eligibility, entry or exit effects, per-member sum
assured source, and per-member responsibility termination. For
`bundle_component`, record the component boundary, referenced sum assured, and
bundle/component termination linkage. Missing topology evidence is review, not
`standalone`.

## Responsibility Rules

- Accept only a covered death or total-disability event plus an insurer
  obligation to pay or return an amount.
- Keep death and total disability separate only when the official contract
  gives them independent headings and obligations.
- When one official heading combines death and total disability, keep disease,
  accident, waiting-period, age, and payment-period variants as branches under
  one responsibility and one indicator. Never create a sibling `疾病全残`
  indicator from a cause clause.
- Keep accident/non-accident, age, payment-period, waiting-period, and
  policy-year outcomes as branches under the owning responsibility.
- Keep a waiting-period premium return as
  `responsibilityKind: waiting_period_refund` with
  `coverageAggregation: exclude` only when the contract gives it an independent
  obligation. Otherwise retain it as a branch of the death/disability benefit.
- Preserve level, decreasing, annual-effective, loan-balance, or staged sum
  assured exactly. Cite the schedule or definition that determines the amount.
- Preserve every operand and tie rule in premium, cash-value, and sum-assured
  comparisons. Do not collapse `max` or `min` to one convenient basis.
- Record whether payment terminates the contract, only the member's coverage,
  only the responsibility, the rider, or a linked main/bundle contract.
- Record beneficiary-facing payment semantics as a payment destination or
  obligation; do not turn beneficiary designation or application procedures
  into coverage.

## Model Routing Metadata

This Skill does not call an external model. If a surrounding authorized
pipeline uses models, route one immutable cohort only:

- simple single-branch death or death-plus-total-disability structures may use
  DeepSeek;
- max/min, cash-value, decreasing/staged amount, age/payment/waiting-period
  branches, group membership, rider dependency, or bundle termination conflicts
  go to Luna.

Never silently fall back between providers. A model failure remains in its
provider-specific review queue. Both routes use the same official evidence,
canonicalizer, validator, importer dry-run, and readback gates.

## Safety

- Default to read-only review.
- Do not write SQLite, Feishu, published cards, `.env.local`, or production.
- Do not call a model or network merely to validate this Skill.
- Write an approved artifact only when the user separately authorizes the
  normal publication workflow and every deterministic gate passes.
- Put parser, source, or persistence gaps in a handoff; do not patch production
  code from this Skill.

## Completion

Report the exact identity triples, topology distribution, accepted and rejected
responsibilities, formula/branch/evidence failures, classification errors,
readback mismatches, review queue, commands, and absolute artifact paths.
