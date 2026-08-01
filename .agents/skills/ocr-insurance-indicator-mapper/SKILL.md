---
name: ocr-insurance-indicator-mapper
description: Map every approved insurance responsibility to source-backed quantitative indicators, formulas, bases, timing, limits, and calculation metadata. Use after responsibility inventory and card creation, when indicators are missing or wrong, when optional responsibilities need metrics, or when formulas mention insured amount, premium, cash value, age, date, percentage, count, benefit table, or actual expense.
---

# Insurance Indicator Mapper

Extract and map indicators without changing responsibility content. A displayable formula is still an indicator even when the current policy lacks enough inputs to calculate a monetary amount.

## Input Gate

Require approved inventory items with stable `responsibilityId` and exact source excerpts. Use policy fields only as calculation inputs; never use them to rewrite the official formula.

## Mapping Rules

- Map indicators by `responsibilityId`, not fuzzy title alone.
- Separate responsibility-specific basis/limit from cross-cutting settlement rules. Store a rule used by multiple responsibilities once in `productRules[].calculation`, and reference it from affected indicators with `ruleRefs`.
- Validate shared deductible, reimbursement-ratio, annual-limit, or compensation branches once under the rule. Do not copy the same branches into every responsibility indicator.
- Produce one or more indicators for every responsibility containing an amount, insured amount, premium, cash value, percentage, age, date, duration, count, daily amount, actual expense, deductible, limit, table reference, or comparison such as `max`/`min`.
- Preserve formulas that cannot currently produce a number. Mark them `display_only`, `needs_claim_facts`, or `needs_table` instead of dropping them.
- Set `calculable` only when every `requiredInputs` value is supplied in artifact-level `currentPolicyInputs`. The existence of a simple formula alone does not make it calculable for the current policy.
- Distinguish at minimum:
  - `insured_amount` / 基本保险金额;
  - `annual_premium`, `first_premium`, and `total_paid_premium`;
  - `cash_value`;
  - `actual_expense`;
  - fixed amount, percentage, count, date, age, and table value.
- Never substitute premium for insured amount or insured amount for premium.
- Preserve all branches of `max`, `min`, tiered, age-dependent, group-dependent, and cumulative-limit formulas.
- Do not model `max/较大者` or `min/较小者` as a condition-based piecewise formula. Use an exact `max_of_...` or `min_of_...` composite `basisKey`, a comparison calculation key, and explicit `operands`.
- Store an explicit `branches` entry and calculation status for each piecewise branch; never collapse a mixed `needs_table`/`needs_claim_facts` formula into one misleading status.
- If one piecewise branch contains a max/min comparison, keep the parent indicator as `piecewise` and put the explicit comparison `operands` on that branch. Do not duplicate branch operands at indicator level.
- Do not use ambiguous aliases such as `effective_insured_amount`, `sum_assured`, or `death_formula`; retain the exact formula components in `basisKey`.
- Distinguish an invented ambiguous alias from an official contract-defined term. When the formula literally uses `有效保险金额`, store `basisKey: contract_defined_effective_insured_amount` on the exact direct basis, branch, or comparison operand and preserve the definition clause in `basisDefinition`; do not simplify it to basic amount plus dividend amount. The containing comparison retains its composite `max_of_...` or `min_of_...` basis.
- Include all timing-dependent components stated by the definition. For example, an arbitrary-date death benefit may involve不足整保单年度红利保险金额 even when anniversary-date survival benefits do not.
- Use parent `basisKey: piecewise` for a piecewise formula. On every branch store exact source-backed `conditionText`, `formulaText`, `basisKey`, `requiredInputs`, and `evidenceTokens`.
- Mark a branch using cash value as `needs_table` unless the exact current-policy cash value was supplied. Do not hide that dependency behind a top-level `needs_claim_facts` status.
- Mark a max/min comparison containing any unavailable cash-value operand as top-level `needs_table`.
- For waivers, quantify the waived future premium scope and timing; do not label already-paid premium as the waiver amount.
- Do not turn waived future premiums into a present value or discounted amount unless the same responsibility excerpt explicitly states `现值`, `折现`, or an equivalent discounting rule. Otherwise use an exact basis such as `future_premiums_from_diagnosis_date` and preserve the clause wording.
- Map the exact term `实际交纳的保险费` to `actual_paid_premium`. Reject `total_paid_premium` for that term; use a total-paid basis only when the source actually states a total or aggregate paid-premium concept.
- For optional responsibilities, retain the indicator regardless of selection status. Downstream aggregation may count it only when `selectionStatus == included`.
- Do not infer a missing percentage, amount, age, count, or table value from a similar product.

## Evidence Check

Every constant and operator in a responsibility-specific formula must be supported by that responsibility's evidence or a precisely referenced table row. Shared rule constants/operators must be supported by the referenced product rule's evidence. Prefer one continuous excerpt; use ordered exact `evidenceSegments` for separated official passages and never fabricate a concatenated excerpt. Record unsupported tokens as blockers.

## Output Contract

```json
{
  "responsibilityId": "",
  "liability": "",
  "indicatorName": "",
  "formulaText": "官方原文公式或可展示量化描述",
  "normalizedFormula": "",
  "basisKey": "insured_amount",
  "calculationKey": "percent_of_insured_amount",
  "calculationStatus": "calculable",
  "calculationEligible": true,
  "calculationReason": "",
  "requiredInputs": [],
  "timing": {},
  "limits": {},
  "groupId": null,
  "selectionStatus": "included",
  "sourceUrl": "",
  "sourcePage": "",
  "sourceExcerpt": "",
  "evidenceTokens": []
}
```

For an official contract-defined basis, also include:

```json
{
  "basisKey": "contract_defined_effective_insured_amount",
  "basisDefinition": {
    "term": "有效保险金额",
    "sourcePage": "条款第6.10条",
    "sourceExcerpt": "完整定义原文",
    "evidenceTokens": ["有效保险金额", "基本保险金额", "累计红利保险金额"]
  }
}
```

For a piecewise formula, also include:

```json
{
  "basisKey": "piecewise",
  "branches": [
    {
      "branchId": "stable-branch-id",
      "conditionText": "官方原文边界条件",
      "formulaText": "该分支公式",
      "basisKey": "cash_value",
      "calculationStatus": "needs_table",
      "requiredInputs": ["cash_value"],
      "evidenceTokens": ["现金价值"]
    }
  ]
}
```

When a branch performs a comparison, add `operands` to that branch using the comparison operand shape below; keep the parent indicator's `operands` empty.

For a comparison formula, use operands rather than branches:

```json
{
  "formulaText": "基本保险金额对应现金价值与实际交纳保险费二者之较大者",
  "normalizedFormula": "max(basic_insured_amount_cash_value, actual_paid_premium)",
  "basisKey": "max_of_basic_insured_amount_cash_value_actual_paid_premium",
  "calculationKey": "maximum_of_bases",
  "calculationStatus": "needs_table",
  "operands": [
    {
      "operandId": "basic_insured_amount_cash_value",
      "formulaText": "基本保险金额对应现金价值",
      "basisKey": "basic_insured_amount_cash_value",
      "requiredInputs": ["basic_insured_amount_cash_value"],
      "evidenceTokens": ["基本保险金额", "现金价值"]
    },
    {
      "operandId": "actual_paid_premium",
      "formulaText": "实际交纳保险费",
      "basisKey": "actual_paid_premium",
      "requiredInputs": ["actual_paid_premium"],
      "evidenceTokens": ["实际交纳保险费"]
    }
  ]
}
```

Allowed `calculationStatus` values:

- `calculable`: current policy fields deterministically produce a value;
- `display_only`: formula is meaningful but the current record lacks an input;
- `needs_table`: exact official table data is required;
- `needs_claim_facts`: amount depends on an actual claim event, expense, diagnosis, disability grade, or date;
- `not_quantitative`: responsibility has no useful quantitative term after review.

## Verification

- Confirm every responsibility has an explicit indicator decision, including `not_quantitative`.
- Confirm every displayed monetary value uses the correct basis.
- Confirm every source percentage, age, count, timing rule, and formula branch is preserved.
- Confirm cards and indicators share the same `responsibilityId`.
