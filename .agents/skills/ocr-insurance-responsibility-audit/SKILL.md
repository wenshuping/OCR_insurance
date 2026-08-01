---
name: ocr-insurance-responsibility-audit
description: Independently audit an insurance product's official responsibility inventory, customer cards, quantitative indicators, formulas, optional selections, and exact product version before SQLite or Feishu writes. Use for single-product approval, batch acceptance, historical-data repair, regression review, and any claim that responsibility data is complete or verified.
---

# Insurance Responsibility Audit

Audit independently from the generation artifacts. Do not approve a product merely because its inventory, cards, and indicators agree with one another.

## Independent Evidence Rule

Re-open the exact-version official source and build a fresh heading/checklist from the responsibility section. Do not reuse the generated accepted list as the official checklist.

Also build `officialOptionalGroupChecklist` directly from the source. Each row must contain the official option label, exact child responsibility IDs, source page, and an excerpt containing the option label and all child headings. Do not copy this checklist from generated `optionalGroups`.

## Required Comparisons

Compare all of the following by stable `responsibilityId` and source location:

1. Independent official responsibility checklist.
2. Approved responsibility inventory.
3. Customer responsibility cards.
4. Indicator decisions and mapped indicators.
5. Independent official optional-package checklist and generated optional groups.

For every concrete responsibility require:

- exactly one inventory item;
- exactly one customer card;
- at least one explicit indicator decision;
- exact product-version evidence;
- source-supported trigger and insurer obligation;
- source-supported formula constants, bases, branches, ages, dates, counts, and limits.
- exact optional package boundaries, not merely the same overall set of optional children.
- exact definition evidence for every official contract-defined basis used by an indicator or formula branch.
- valid `ruleRefs` for every shared settlement rule, with the rule formula and branches audited once against exact rule evidence;
- every `evidenceSegments` item is independently exact and the ordered segments jointly support the generated claim.

For product identity, independently verify each populated filing code, product code, and filing date against its cited official excerpt or official URL. Reject a filing code derived from a product/risk code. Accept an empty field only when it is explicitly marked `not_present_in_source` with a complete review scope.
When an official query URL contains `riskCode`, require the matching verified `productCode` and preserve the reviewed URL. Do not accept `not_present_in_source` after the evidence URL was omitted.

## Semantic Failure Conditions

Fail the product when any of these occur:

- an official responsibility is absent from all generated sets;
- a group heading is emitted as a responsibility card;
- optional child responsibilities are not enumerated;
- separate source-defined optional packages were merged or one package was split;
- an unselected or unknown optional responsibility is counted as current coverage;
- two concrete responsibilities were merged or one was duplicated;
- independently headed staged payments were merged, or their sibling cards do not share one conceptual parent;
- a waiting-period refund is counted in normal protection coverage;
- a premium-waiver responsibility is classified as an ordinary benefit;
- a cited excerpt contains model-authored ellipsis that hides a responsibility, formula, count, or termination rule;
- premium is used as insured amount, or another basis is substituted;
- a max/min comparison is modeled as a condition-based piecewise formula or omits a compared operand;
- a piecewise branch performs max/min but its operands were flattened to indicator level, duplicated, or omitted;
- an indicator is labeled `calculable` although one or more required current-policy inputs are absent;
- a waiver formula introduces present value, discounting, `现值`, `折现`, or `present_value` without support in the same responsibility excerpt;
- the exact term `实际交纳的保险费` is mapped to `total_paid_premium` instead of `actual_paid_premium`;
- `sum_assured`, `effective_insured_amount`, or another ambiguous basis hides the official formula components;
- an official term such as `有效保险金额` was simplified into a fixed component sum that omits definition-level timing rules;
- a formula constant or branch is unsupported by the cited excerpt;
- the source belongs to a similar name, older/newer version, rider, or brochure not proven to match;
- a product/risk code was relabeled as a filing code, or any identity value lacks field-level official evidence;
- the product overview describes benefits not supported by the exact source.
- customer copy drops a cumulative count, changes `累计达到N次终止` into `给付后终止`, or broadens `合同继续有效` into an unsupported promise such as `不影响其他保险责任`.

## Acceptance Matrix

Produce a row for every independent official responsibility:

```text
responsibilityId | official heading | inventory | card | indicator decision |
formula evidence | selection evidence | product version | result | issues
```

Also report:

- official checklist count;
- inventory count;
- card count;
- responsibilities with indicators;
- display-only/not-calculable indicators;
- blockers and unsupported formula tokens;
- stale database rows that should be removed.

## Approval Status

Use only:

- `approved`: no missing, duplicate, version, selection, or formula-evidence issue;
- `partial`: exact source is valid but one or more responsibilities/cards/indicator decisions are incomplete;
- `blocked`: source or product identity is unresolved;
- `rejected`: generated data conflicts with official evidence.

Count equality alone never proves approval. A product may be written only after semantic audit status is `approved`; otherwise preserve the artifact and blocker report without publishing it as verified data.
