# Medical And Health Responsibility Contract

## Contents

1. Identity and evidence
2. Contract topology
3. Responsibility classification and splitting
4. Medical profile
5. Calculation structures
6. Service and product-function boundary
7. Validation and readback

## 1. Identity And Evidence

Use one immutable identity:

```json
{
  "company": "legal insurer name",
  "productName": "exact filed product title",
  "sourceDigest": "sha256:<64 lowercase hex>",
  "sourceUrl": "official exact-version URL"
}
```

Every accepted fact has an exact `sourceExcerpt` or ordered
`evidenceSegments`. Each segment must be a contiguous substring of the complete
official text for that digest. A database card or indicator may help detect an
omission, but it is not official evidence.

## 2. Contract Topology

Use this shape:

```json
{
  "contractTopology": {
    "type": "standalone|rider|group|bundle_component",
    "evidenceSegments": [],
    "parentContract": {
      "company": "",
      "productName": "",
      "sourceDigest": "",
      "dependencyText": "",
      "terminationLinkText": "",
      "insuredAmountReferenceText": "",
      "premiumReferenceText": ""
    },
    "groupContract": {
      "policyholderGroupText": "",
      "memberEligibilityText": "",
      "effectiveEntryText": "",
      "exitText": "",
      "limitAllocation": "member_specific|shared|itemized|mixed|unknown"
    },
    "bundle": {
      "marketingPlanName": "",
      "componentCompany": "",
      "componentProductName": "",
      "componentSourceDigest": "",
      "marketingEvidenceRole": "discovery_only",
      "mappingEvidenceSegments": []
    }
  }
}
```

Rules:

- Require exact topology evidence. A title containing `附加`, `团体`, `学平`,
  or `学生` is not enough.
- A rider may refer to the main contract without naming it. Keep unknown
  identity fields empty and preserve the dependency wording.
- Preserve main-contract termination linkage and references to main-contract
  insured amount or premium; do not turn those references into current values.
- A group contract needs actual group/member evidence. Preserve eligibility,
  effective entry, exit, and limit ownership separately.
- A bundle component needs two evidence layers: marketing-to-filed-component
  mapping and the component's own exact official terms. The marketing layer may
  discover identity but cannot prove final responsibility content.

## 3. Responsibility Classification And Splitting

Classify each source block as exactly one of:

```text
insurance_responsibility
definition
expense_definition
exclusion
shared_rule
product_service
product_function
group_heading
care_process
claims_process
```

Accept `insurance_responsibility` only when the evidence proves both a covered
event/expense/condition and an insurer payment, reimbursement, or fixed-benefit
obligation.

Split independently titled obligations. Do not split:

- cost categories listed only as the covered expense scope of one total
  reimbursement;
- formula branches, social-insurance branches, hospital tiers, plan-table rows,
  or deductible bands;
- definitions, exclusions, claims steps, or provider-network instructions.

When a total responsibility and independently payable child responsibilities
both exist, retain the total only if it has its own obligation or aggregate
limit and link children with `parentResponsibilityId`. Otherwise store the
parent as a group heading.

## 4. Medical Profile

Use this minimum shape per responsibility:

```json
{
  "medicalProfile": {
    "paymentMode": "reimbursement|fixed_benefit|mixed",
    "coveredExpenseItems": [],
    "careSettings": [],
    "facilityScope": {
      "hospitalText": "",
      "departmentText": "",
      "networkText": "",
      "geographyText": ""
    },
    "socialInsurance": {
      "identityText": "",
      "settlementText": "",
      "branchIds": []
    },
    "deductibles": [],
    "reimbursementRates": [],
    "limits": {
      "annual": [],
      "lifetime": [],
      "perEvent": [],
      "shared": [],
      "subLimits": []
    },
    "waitingPeriod": [],
    "paymentCounts": [],
    "preExistingOrExclusionRefs": [],
    "calculation": {}
  }
}
```

Supported care settings include inpatient, ordinary outpatient, emergency,
special outpatient, outpatient surgery, pre/post-inpatient outpatient, special
drug, proton/heavy-ion, rehabilitation, dental, maternity, overseas, and
emergency assistance. Add a setting only from official evidence.

Each deductible, rate, limit, waiting period, and count entry uses:

```json
{
  "valueText": "exact official token or phrase",
  "scopeText": "exact applicable scope",
  "sourceExcerpt": "exact contiguous evidence"
}
```

Unknown fields stay empty. Do not normalize away whether a limit is annual,
lifetime, per visit, per admission, shared across responsibilities, shared
across members, or item-specific.

## 5. Calculation Structures

### Reimbursement

Preserve the clause semantics:

```text
payable = min(
  max(eligibleMedicalExpense - thirdPartyPaid - deductible, 0)
  * reimbursementRate,
  applicableLimit
)
```

This is a schema, not a default formula. Include only evidenced terms. Keep
social-insurance settlement paths as separate `branches`; do not average or
select a ratio.

Typical required inputs:

```text
actualMedicalExpense
thirdPartyPaid
deductible
reimbursementRate
liabilityLimit
manualFormulaInputs
```

### Fixed Benefit

Preserve the exact basis:

```text
payable = eligibleDays * dailyAmount
```

or the exact fixed amount/count formula. Keep deductible days, per-admission
days, annual cumulative days, payment count, and termination scope separately.

Typical required inputs:

```text
actualDays
dailyAmount
dayLimit
liabilityLimit
manualFormulaInputs
```

Use `branches` only for mutually exclusive condition paths. Use `operands` only
for literal max/min comparisons. Store shared settlement rules once in
`productRules` and reference them with `ruleRefs`.

## 6. Service And Product-Function Boundary

Store non-insurance assistance, appointment, second-opinion, direct-billing, or
health-management services in `productServices`.

Store renewal, guaranteed renewal, rate adjustment, continuation, conversion,
and portability terms in `productFunctions`. Do not create an insurance
responsibility merely because the function affects continued access to
coverage. Preserve its own exact evidence and scope.

Definitions explain terms. Expense definitions delimit a responsibility's
eligible costs. Exclusions remove coverage. Care and claims processes explain
how to obtain treatment or payment. None is an insurer benefit by itself.

## 7. Validation And Readback

Require this chain:

```text
sourceDigest
-> official title inventory
-> bounded evidence packets
-> artifact formula/branches/requiredInputs
-> canonicalizer + validator + dedicated importer dry-run
-> cards + indicators + customer summary exact readback
```

Approval requires:

- exact official inventory equals artifact responsibilities by stable ID;
- one card per accepted responsibility;
- every responsibility has one or more indicators or an explicit
  `not_quantitative` decision;
- all quantitative tokens and scope boundaries are evidenced;
- artifact, card, and indicator source digests match;
- formula text, normalized formula, required inputs, branches, operands, limits,
  titles, and responsibility IDs survive readback;
- the customer summary preserves material deductibles, ratios, limits, waiting
  periods, counts, selection state, and uncertainty.

When any official number, scope, topology mapping, or persisted projection is
missing, return `review` or a narrower blocker. Do not guess or silently pass.
