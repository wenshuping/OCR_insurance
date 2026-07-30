# Merge Contract

## Evidence Precedence

Use this order:

1. Official responsibility-section wording for facts and exact formulas.
2. Official adjacent clauses for waiting periods and direct payment restrictions.
3. Model proposals as extraction aids only.
4. Domain knowledge only to classify fields, never to add contract facts.

When evidence conflicts, retain the official wording and add a `mergeAudit`
decision. When the official source is ambiguous, preserve the ambiguity and add a
blocker instead of choosing the most plausible model answer.

## Output Shape

Write one compact JSON object per product. This is an illustrative shape, not
permission to copy its sample text into another product:

```json
{
  "company": "保险公司",
  "productName": "产品全称及版本",
  "sourceRecords": [
    {
      "sourceRecordId": "optional-existing-record-id",
      "sourceUrl": "https://official.example/terms.pdf",
      "sourceTitle": "官方条款标题"
    }
  ],
  "acceptedResponsibilities": [
    {
      "liability": "责任名称",
      "coverageType": "现金流",
      "customerSummary": "面向客户的责任说明",
      "triggerCondition": "条款明确的触发条件",
      "insurerObligation": "条款明确的给付义务",
      "importantLimits": [
        "直接影响该责任给付的限制"
      ],
      "responsibilityScope": "basic_or_unspecified",
      "selectionStatus": "accepted",
      "selectionEvidence": "official_clause_cross_merge",
      "sourceRecordId": "optional-existing-record-id",
      "sourceUrl": "https://official.example/terms.pdf",
      "sourceTitle": "官方条款标题",
      "sourceExcerpt": "支持本责任、触发条件及公式的官方原文"
    }
  ],
  "internalIndicatorChecks": [
    {
      "liability": "责任名称",
      "coverageType": "现金流",
      "basis": "公式计算基础的中文说明",
      "formulaText": "完整公式，保留全部分档和分支",
      "basisKey": "manual_formula",
      "calculationKey": "manual_formula",
      "requiredInputs": [
        "policy.amount",
        "policy.firstPremium"
      ],
      "calculationEligible": false,
      "calculationStatus": "needs_table",
      "calculationReason": "缺少哪些保单字段或条款表格",
      "cashflowTreatment": "scheduled_cashflow",
      "indicatorCheckStatus": "accepted_manual_review",
      "indicatorCheckSummary": "内部核对结论"
    }
  ],
  "rejectedFragments": [
    {
      "text": "被拒绝的候选标题或片段",
      "reason": "不是独立责任或无官方原文支持"
    }
  ],
  "blockers": [],
  "mergeAudit": {
    "officialResponsibilityCount": 1,
    "proposalInputsReviewed": [
      "source-extraction",
      "customer-limits",
      "calculation"
    ],
    "modelRuns": [
      {
        "role": "local_candidate_assistant",
        "provider": "actual-provider",
        "modelId": "actual-model-id",
        "tasks": [
          "page-classification",
          "title-candidates",
          "evidence-span-candidates"
        ]
      },
      {
        "role": "candidate_extractor",
        "provider": "actual-provider",
        "modelId": "actual-model-id",
        "tasks": [
          "source-extraction",
          "customer-limits",
          "calculation"
        ]
      },
      {
        "role": "merge_or_verifier",
        "provider": "actual-provider",
        "modelId": "actual-model-id",
        "tasks": [
          "cross-merge"
        ]
      }
    ],
    "decisions": [
      {
        "field": "责任名称或字段路径",
        "modelClaims": [
          "各分支提出的不同内容"
        ],
        "selected": "最终采用内容",
        "officialEvidence": "支持决定的原文短句",
        "reason": "采用或拒绝原因"
      }
    ]
  }
}
```

## Field Rules

- Keep `acceptedResponsibilities` and `internalIndicatorChecks` one-to-one by
  normalized `liability`.
- Use one accepted item per official responsibility. Keep age bands or scenario
  branches inside that item unless the contract names separate responsibilities.
- Allowed `coverageType` values are `现金流`, `医疗保障`, `疾病保障`, `人寿保障`,
  `意外保障`, `豁免`, `规则参数`, and `其他`.
- Allowed `cashflowTreatment` values should follow repository conventions:
  `scheduled_cashflow`, `claim_contingent`, or `waiver_only`.
- `manual_formula` requires a non-empty `requiredInputs` array.
- `requiredInputs` must use only:

```text
policy.amount
policy.firstPremium
policy.paymentPeriodYears
cashValue
policyYear
policyScheduleTable
policyYearOrAge
accountValue
actualMedicalExpense
deductible
reimbursementRate
thirdPartyPaid
liabilityLimit
actualDays
dailyAmount
dayLimit
manualFormulaInputs
```

- Reject invented aliases such as `policy.totalPaidPremium`,
  `insured.ageAtClaim`, or Chinese field labels.
- Use `manualFormulaInputs` only when the exact official operand has no canonical
  project field. Name the missing operand, such as
  `cumulativePaidPremiumAtEvent`, in `calculationReason` or an additional
  `requiredInputDetails` array.
- Do not replace cumulative premiums paid at an event date with
  `policy.firstPremium × policy.paymentPeriodYears` unless the source and policy
  structure prove that calculation is exact.
- `basis` must describe the values used by the formula. A trigger such as
  `保险期间届满时生存` belongs in `triggerCondition`, not `basis`.
- When a tiered formula materially compares against cash value, prefer
  `basisKey: cash_value` with `calculationKey: manual_formula`.
- Omit `value` when unknown. A JSON `null` can be coerced by downstream numeric
  handling, so omission is the safe representation for a non-computable result.
- Put waiting-period consequences in the affected responsibility's
  `importantLimits`; do not create a standalone waiting-period responsibility.
- Include waiting-period evidence in that responsibility's `sourceExcerpt` or
  page-specific evidence segments.
- Put unsupported model candidates in `rejectedFragments` with a concrete
  reason.
- Put source-access or version uncertainty in `blockers`.

## Final Cross-Checks

Before dry-run, verify:

- Every accepted title exists in or is directly supported by the official
  responsibility chapter.
- Every number, percentage, day count, age boundary, and formula operator appears
  in the cited official evidence.
- Every `importantLimits` item is supported by the same responsibility evidence.
- Inclusive and exclusive boundaries such as `未满`, `已满`, `不满`, `达到`, and
  `含` are preserved.
- A main-contract payment restriction is attached only where the official clause
  says it applies.
- Customer-facing fields contain no internal audit vocabulary.
- No responsibility depends on an uncited model-only fact.
- `basis` is a calculation basis and every `requiredInputs` value belongs to the
  canonical dictionary.
- Final excerpts contain no extraction-only page markers.
