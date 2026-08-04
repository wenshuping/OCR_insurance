---
name: ocr-insurance-responsibility-card-builder
description: Convert an approved official-source responsibility inventory into one customer-facing OCR_insurance responsibility card per concrete responsibility. Use after responsibility inventory approval and before indicator mapping or database materialization, including products with basic, attached, or optional responsibilities.
---

# Insurance Responsibility Card Builder

Build customer-facing cards from an approved inventory. Do not discover missing responsibilities or invent quantitative indicators in this stage.

## Input Gate

Require a completed artifact from `$ocr-insurance-responsibility-inventory`. Stop if product identity is unresolved, source evidence is missing, or the inventory has blockers.

## Card Rules

- Create exactly one card for each concrete `responsibilityId`.
- Preserve `responsibilityId`, group membership, selection status, and source evidence.
- Preserve `ruleRefs`. Shared settlement rules remain separate from responsibility cards and may be displayed only as applicable calculation notes.
- Never create a card titled `基本责任`, `可选责任`, `可选责任一`, `可选责任二`, `保险责任`, or another group/section heading.
- Never merge responsibilities merely because their formulas look similar.
- Never split one responsibility only because its formula contains several branches.
- Create separate cards for source-defined staged payments when each stage has its own numbered heading, trigger, and payment obligation. Preserve their shared `parentResponsibilityId` so the UI can group them without losing the individual cards.
- Display waiting-period refunds as separate explanatory cards and preserve `coverageAggregation: exclude`; do not present them as active disease or death coverage.
- Keep optional responsibilities in the card set even when unselected; mark them `not_included` or `unknown` so downstream reports can exclude them from current-policy totals.
- Keep customer copy separate from internal audit/calculation metadata.
- Preserve cumulative counts and termination scope exactly. Never shorten `累计给付达到六次时终止` to `给付后终止`.
- Do not broaden `合同继续有效` into `其他权益不受影响` unless that exact promise appears in the cited source.
- Do not broaden `合同继续有效` into `不影响其他保险责任` or `其他责任不受影响` unless the cited source explicitly states that relationship.
- Do not add `与其他责任不重复` unless that exact relationship is stated in the cited responsibility evidence.

## Customer Card Content

Each card must contain:

- concrete responsibility title;
- plain-language benefit summary;
- trigger condition;
- insurer obligation or payment method;
- important limits, waiting periods, counts, termination effects, or deductions;
- optional group and selection status when applicable;
- exact official source reference.

Do not expose `basisKey`, `calculationKey`, internal check status, model names, or implementation commentary in customer-facing text.

## Output Contract

```json
{
  "responsibilityId": "",
  "title": "具体责任名称",
  "category": "",
  "customerSummary": "",
  "triggerCondition": "",
  "benefitExplanation": "",
  "importantLimits": [],
  "groupId": null,
  "selectionStatus": "included",
  "sourceUrl": "",
  "sourceTitle": "",
  "sourcePage": "",
  "sourceExcerpt": ""
}
```

## Verification

Compare stable IDs, not only normalized titles:

```text
inventory responsibility IDs == card responsibility IDs
```

Fail when a concrete responsibility is missing, duplicated, merged, represented only by a group heading, or backed by a different product version.
