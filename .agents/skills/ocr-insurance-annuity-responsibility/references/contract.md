# Annuity Responsibility Contract

## Contents

1. Identity and source gate
2. Contract topology
3. Responsibility boundary
4. Annuity profile
5. Formula contract
6. Split and branch rules
7. Product-function boundary
8. Deterministic gates and output status

## 1. Identity and source gate

Bind all work to one immutable tuple:

```json
{
  "company": "legal insurer name",
  "productName": "exact filed product title",
  "sourceDigest": "sha256:<64 lowercase hex>",
  "sourceUrl": "official exact-version URL",
  "artifactStatus": "approved"
}
```

Resolve identity in the order `sourceDigest -> exact official source URL ->
normalized company + productName`. A different digest is a different version.
Select one canonical artifact for an exact duplicate tuple and record duplicate
rows.

Require the artifact table digest and `productIdentity.sourceDigest` to match.
Cards, nested indicators, and indicator-table rows must use that same digest.
Use only exact official excerpts carried by that tuple. A similar product,
marketing page, current product name, or model output is never source evidence.

An accepted annuity obligation needs exact official evidence for:

1. a payout start or eligibility boundary;
2. the insured's survival on the applicable payout date; and
3. the insurer's obligation to pay a scheduled amount.

Missing identity, digest, readable responsibility text, or exact evidence is
`blocked`. Do not infer.

## 2. Contract topology

Use exactly one topology:

- `standalone`: independently effective filed contract;
- `rider`: attached contract dependent on a main contract;
- `group`: group contract with member-level eligibility or account ownership;
- `bundle_component`: exact filed product inside a multi-product bundle.

Store topology outside the annuity formula:

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
      "accountOwnershipText": "",
      "effectiveEntryText": "",
      "exitText": ""
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

Do not infer topology from `附加`, `团体`, `学平`, `少儿`, or another product-name
token. Cite official relationship text. A rider retains its main-contract
dependency and termination linkage. A group contract retains member eligibility
and whether the value belongs to the member, group, or retained account. A
bundle must first resolve each filed component; the marketing bundle never
defines final responsibilities.

## 3. Responsibility boundary

Classify every candidate block as exactly one of:

```text
annuity_responsibility
death_responsibility
maturity_responsibility
waiver_responsibility
other_insurance_responsibility
group_heading
shared_rule
definition
exclusion
claim_procedure
product_function
product_service
unresolved
```

Accept a concrete responsibility only when exact evidence proves a trigger and
an insurer obligation.

### Annuity responsibilities

An annuity responsibility is a contractually scheduled payment conditional on
the insured's survival or another exact annuity eligibility condition. It may
be ordinary, pension, education, lifetime, fixed-term, guaranteed-period,
annual, monthly, installment, lump-sum, level, increasing, decreasing, or
account-value based.

Education, birthday, longevity, care, or other named survival payments remain
separate responsibilities when each has its own official heading, age/date
window, and payment obligation.

### Separate insurance responsibilities

Keep these separate from recurring annuity payments:

- a one-time maturity benefit under an endowment or annuity contract;
- death or total-disability benefits;
- a separately headed obligation to pay remaining guaranteed annuity after
  death;
- premium waiver;
- any other independently headed insurance payment.

A one-time maturity payment is not recurring annuity merely because it appears
inside an annuity product. A whole-life death benefit does not become annuity
because the contract offers an annuity conversion option.

## 4. Annuity profile

Every accepted annuity responsibility uses:

```json
{
  "annuityProfile": {
    "startConditionText": "",
    "startAgeOrDateText": "",
    "survivalConditionText": "",
    "frequency": {
      "type": "annual|monthly|installment|lump_sum|multiple|other",
      "optionTexts": []
    },
    "paymentPeriod": {
      "type": "lifetime|fixed_term|until_age|until_maturity|single_payment|other",
      "startText": "",
      "endText": "",
      "durationText": ""
    },
    "amountRule": {},
    "guarantee": {
      "type": "none|fixed_period|guaranteed_total|refund_balance|other",
      "periodText": "",
      "deathDuringGuaranteeText": "",
      "remainingPaymentText": ""
    },
    "growthRule": {
      "type": "level|arithmetic_increase|geometric_increase|decrease|table|other",
      "rateText": "",
      "baseText": "",
      "yearConventionText": ""
    },
    "terminationConditions": [],
    "deathResponsibilityIds": [],
    "maturityResponsibilityIds": [],
    "ruleRefs": []
  }
}
```

Preserve exact start boundaries:

- policy anniversary or elapsed policy years;
- specified age or retirement age;
- application or election conditions;
- account-value thresholds;
- immediate versus deferred commencement.

Preserve frequency exactly. Do not convert annual to monthly, infer a monthly
ratio from an annual amount, or treat premium payment frequency as annuity
payout frequency.

Preserve the complete payment period. Distinguish lifetime, fixed years, until a
specified age, until maturity, and one-time payment. A guaranteed period is not
the same as the full annuity period.

Preserve the survival condition on every scheduled payment. Death-triggered
remaining guaranteed payments are separate from survival-triggered annuity even
when they share an amount formula.

## 5. Formula contract

Each quantitative responsibility has one or more indicators. Preserve:

```json
{
  "formulaText": "",
  "normalizedFormula": "",
  "basisKey": "",
  "calculationKey": "",
  "calculationStatus": "calculable|display_only|needs_table|needs_claim_facts",
  "calculationEligible": false,
  "calculationReason": "",
  "requiredInputs": [],
  "evidenceTokens": [],
  "branches": [],
  "operands": []
}
```

Recognize only source-backed bases, including:

- `basic_insurance_amount`;
- `annual_premium`, `actual_paid_premium`, or another exact premium term;
- `personal_account_value` or another exact account value;
- `cash_value`;
- `cumulative_paid_annuity`;
- `guaranteed_total_annuity`;
- an exact contract-defined amount or conversion standard.

Do not substitute one basis for another. `实际交纳的保险费` is
`actual_paid_premium`, not generic total premium. An account value is not cash
value unless the clause says so.

Use `branches` only for mutually exclusive conditions such as annual/monthly
choice, start-age bands, insurance-period variants, or pre/post commencement.
Every branch preserves exact condition text, formula, basis, status,
`requiredInputs`, evidence tokens, and branch-local operands.

Use `operands` only for literal `max/较大者` or `min/较小者`. A max/min inside a
piecewise branch stays on that branch. A cash-value operand without the exact
table/value produces `needs_table`.

Preserve growth semantics:

- level: same source-defined amount each period;
- arithmetic increase: prior or first-period amount plus a fixed increment;
- geometric increase: prior-period amount multiplied by a factor;
- decrease: exact reduction rule or account-value depletion;
- table: exact row/column dependency.

Do not rewrite `上一年金额基础上按首年标准的5%递增` as compound growth. Preserve
the stated base and year convention.

Typical required inputs include payout frequency, start age/date, basic insured
amount, premium basis, account/cash value, conversion standard, policy year,
accumulated payments, guarantee duration, and death/maturity date. Missing
inputs remain missing; do not calculate a representative value.

## 6. Split and branch rules

- Split independently titled survival payments with distinct age/date windows
  and obligations.
- Keep annual/monthly or installment choices as branches of one responsibility
  when they are mutually exclusive methods under one official annuity heading.
- Split annual/monthly into separate responsibilities only when the source gives
  each an independent heading, trigger, obligation, and effect. Record their
  shared conceptual parent.
- Keep lifetime and fixed-term options as branches when they are payout choices
  under one heading; split only when official headings and obligations are
  independently bounded.
- Split remaining guaranteed annuity after death only when it is an independent
  insurer obligation. Otherwise retain it as a guarantee/death branch.
- Never split formula age bands, policy-year bands, payout-frequency branches,
  or max/min operands into fake responsibilities.
- Never merge a maturity payment, death benefit, waiver, or independent
  education/survival payment into the recurring annuity.

## 7. Product-function boundary

Store these under `productFunctions`, not responsibility counts, unless the
same clause creates a concrete payment obligation with a trigger:

- universal-account crediting, settlement, guaranteed interest, fees, account
  value accumulation, partial withdrawal, and surrender;
- participating dividend allocation, cash/accumulated dividend options, and
  terminal dividend;
- cash value, surrender value, policy loan, automatic premium loan, reduction,
  and reinstatement;
- a right or option to convert a maturity/death/cash value to a future annuity
  product when the current contract does not itself promise the annuity stream;
- benefit illustrations, sales projections, tax explanations, and claims
  procedures.

An account value may be the exact basis of a genuine annuity payment. In that
case, preserve the annuity responsibility and reference the account rule as a
`productFunction`/`ruleRef`; do not turn the settlement rule itself into another
responsibility.

For participating products, guaranteed annuity/death/maturity obligations and
separately stated bonus-linked insurance obligations may be responsibilities.
The dividend declaration/allocation rule remains a product function. Do not
assume future non-guaranteed dividends.

## 8. Deterministic gates and output status

Run in this order:

```text
sourceDigest
-> official heading inventory
-> bounded evidence packets
-> annuity profile + formulas/branches/operands/requiredInputs
-> canonicalizer
-> validator
-> dedicated importer dry-run
-> same-digest card + nested indicator + indicator-table + customer-summary readback
```

Audit for:

- omitted payout start, frequency, period, survival condition, guarantee, death,
  maturity, growth, or termination;
- false responsibilities from maturity-only, account, dividend, cash-value,
  loan, surrender, or conversion-option text;
- formula bases or numeric tokens without exact evidence;
- annual/monthly choice flattened or split incorrectly;
- guarantee-period and total-payment-period confusion;
- collapsed branches, max/min operands, required inputs, or provenance;
- cross-digest card or indicator rows.

Use only:

- `approved`: all source, inventory, profile, formula, deterministic, and exact
  readback gates pass;
- `review`: exact source exists but a topology, split, profile, formula,
  evidence, or projection field is incomplete;
- `blocked`: exact identity or same-digest official evidence is unresolved;
- `rejected`: output contradicts evidence or manufactures a responsibility.

`not_run`, count equality, card presence, importer success, or `quick_check`
alone never proves approval.
