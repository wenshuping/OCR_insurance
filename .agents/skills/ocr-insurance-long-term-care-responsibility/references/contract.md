# Long-Term-Care Responsibility Contract

## Contents

1. Identity and evidence
2. Contract topology
3. Responsibility boundary
4. Care-state trigger
5. Benefit and formula structure
6. Related responsibilities
7. Review and acceptance gates

## 1. Identity And Evidence

Use exactly one immutable identity:

```json
{
  "company": "legal insurer name",
  "productName": "exact filed product title",
  "sourceDigest": "sha256:<64 lowercase hex>",
  "sourceUrl": "official insurer or regulator URL",
  "artifactStatus": "approved"
}
```

Require equality between the artifact table digest,
`productIdentity.sourceDigest`, every selected card's `sourceDigest`, and every
selected indicator payload's `sourceDigest`. A matching company/product name
with another digest is another version, not supporting evidence.

Every accepted field needs an exact contiguous `sourceExcerpt` or ordered exact
`evidenceSegments` from the official source for that digest. Existing cards and
indicators are projection/readback evidence only; they cannot repair missing
official text.

## 2. Contract Topology

Use one of:

- `standalone`: independently effective filed contract;
- `rider`: contract dependent on a main contract;
- `group`: contract dependent on member/group eligibility;
- `bundle_component`: one exact filed component mapped from a bundle.

Do not infer topology from `附加`, `团体`, `组合`, or a sales plan name. Require
official relationship evidence.

For a rider, preserve:

```json
{
  "mainContractDependency": "",
  "effectiveTerminationLinkage": "",
  "insuredAmountReference": "",
  "premiumReference": "",
  "evidenceSegments": []
}
```

For a group contract, preserve:

```json
{
  "groupIdentity": "",
  "memberEntryRule": "",
  "memberExitRule": "",
  "planTierOrLimitSource": "",
  "evidenceSegments": []
}
```

For a bundle component, first prove the marketing-to-filed-product mapping.
Parse responsibilities only from the component's own exact source digest.

Unknown topology evidence stays empty with status `review`. A product-name
heuristic may be used only to form an audit candidate pool, never to approve
topology.

## 3. Responsibility Boundary

Accept a responsibility only when one evidence packet proves both:

1. a covered event, care state, disease/accident cause, date, or condition; and
2. an insurer payment, waiver, reimbursement, or other contractual obligation.

Classify every source block as one of:

```text
insurance_responsibility
care_state_definition
disease_definition
medical_explanation
exclusion
shared_rule
assessment_process
claims_process
group_heading
```

Supporting material is not a standalone responsibility:

- the definition of long-term care, disability, severe disability, ADL, or
  cognitive impairment;
- an ADL item list, scoring table, disease list, disability-grade table, or
  medical diagnostic note;
- observation, assessment, review, claim-document, or designated-agency process;
- exclusion or termination language without a separate insurer obligation;
- generic headings such as 保险责任, 基本责任, 护理状态, 释义, 责任免除.

Attach supporting material through stable references to its owning
responsibility. Do not create one responsibility per ADL item, disease, grade,
review step, or payment month.

## 4. Care-State Trigger

Preserve this minimum structure for every care or disability-income
responsibility:

```json
{
  "careTrigger": {
    "careStateText": "",
    "adl": {
      "standardName": "",
      "items": [],
      "requiredItemCount": null,
      "assessmentEvidence": []
    },
    "cognitiveImpairment": {
      "definitionText": "",
      "diagnosisOrEvidenceText": "",
      "assessmentEvidence": []
    },
    "continuousState": {
      "durationText": "",
      "startRule": "",
      "observationPeriodText": ""
    },
    "waitingPeriod": {
      "durationText": "",
      "startRule": "",
      "accidentExceptionText": ""
    },
    "cause": {
      "diseaseText": "",
      "accidentText": "",
      "disabilityText": "",
      "causationWindowText": ""
    },
    "reassessment": {
      "frequencyText": "",
      "evidenceRequiredText": "",
      "failureEffectText": ""
    },
    "stateTermination": {
      "recoveryText": "",
      "deathText": "",
      "contractTerminationText": ""
    }
  }
}
```

### ADL

Preserve the official standard name, every listed activity, the threshold
count, whether the inability must be complete or partial, who assesses it, and
the applicable duration. Never assume a six-item list or a two/three-item
threshold.

### Cognitive impairment

Preserve the exact contractual definition, diagnostic or evidence requirement,
duration, assessment authority, and relationship to ADL alternatives. A disease
name or medical explanation alone does not prove a care-benefit trigger.

### Continuous state, observation, and waiting

Keep these separate:

- `waitingPeriod`: time after contract effect/reinstatement before coverage;
- `observationPeriod`: time a care state must persist before first eligibility;
- `continuousState`: ongoing condition during periodic payment;
- `reassessment`: later review of continuing eligibility.

Do not merge their durations or termination effects.

### Disease and accident causes

Keep disease-care and accident-care causation as separate branches when the
contract does. Preserve age limits, direct-cause wording, event-to-state time
window, disability grade/table, and accident exceptions to waiting periods.

The Skill extracts the contract test. It must not judge a customer's ADL
ability, cognition, diagnosis, disability grade, or current eligibility.

## 5. Benefit And Formula Structure

Use one object per independently headed insurer obligation:

```json
{
  "responsibilityId": "stable-source-derived-id",
  "liability": "official concrete title",
  "triggerCondition": "",
  "insurerObligation": "",
  "careTrigger": {},
  "benefit": {
    "paymentMode": "lump_sum|periodic|reimbursement|waiver|mixed",
    "cadence": "once|daily|monthly|annual|other",
    "amountText": "",
    "insuredAmountPercentageText": "",
    "firstPaymentRule": "",
    "benefitPeriodText": "",
    "paymentCountText": "",
    "perPeriodLimitText": "",
    "aggregateLimitText": "",
    "terminationText": ""
  },
  "formulaText": "",
  "normalizedFormula": "",
  "requiredInputs": [],
  "branches": [],
  "operands": [],
  "sourceExcerpt": ""
}
```

### Lump sum

Preserve the single-payment trigger, formula, `only once` or responsibility
termination language, any paid-premium/cash-value/insured-amount comparison,
and mutual exclusion with another lump-sum benefit.

### Periodic payment

Preserve cadence, first payment date, per-period amount, eligible period/count,
maximum period/count, continuation test, reassessment, recovery/death effect,
and whether a remaining amount becomes payable at death. Monthly and annual
benefits are not interchangeable.

Typical structured dependencies include:

```text
basic_sum_insured
monthly_benefit_amount
annual_benefit_amount
eligible_payment_periods
payment_count
attained_age
care_state_status
reassessment_result
actual_paid_premium
cash_value
manualFormulaInputs
```

Use repository canonical inputs when an artifact is headed to the main
pipeline. Unknown inputs remain explicit blockers; do not invent aliases merely
to make a formula calculable.

### Formula rules

- Preserve exact `formulaText` and a source-equivalent `normalizedFormula`.
- Preserve every condition path in `branches`.
- Use `operands` only for literal max/min comparisons.
- Keep amount percentage, cadence, count, cap, and benefit period independently
  structured.
- Set `calculationEligible=false` when policy or claim facts are missing.
- Do not use zero or a guessed representative amount for an unknown result.

## 6. Related Responsibilities

Keep these as separate sibling responsibilities when the official source gives
them independent triggers and obligations:

- death benefit or a remaining-care-benefit payment at death;
- premium waiver;
- medical expense reimbursement;
- disability-income benefit;
- waiting-period refund;
- maturity, survival, or other life benefit.

Record relationships through stable IDs:

```json
{
  "relatedResponsibilityIds": [],
  "relationship": "independent|mutually_exclusive|additional|remaining_balance|terminates_after|unknown",
  "sourceExcerpt": ""
}
```

Do not state that another responsibility continues, stops, is additional, or is
mutually exclusive without exact source evidence.

### Care benefit versus medical reimbursement

A fixed or periodic care cash benefit is not medical reimbursement even when
the insured needs medical treatment or care services. Classify
`reimbursement` only when official text bases payment on actual eligible
expenses and explicitly promises reimbursement or compensation, with any
deductible, other compensation, ratio, and limit.

### Disability income

Preserve the occupation/earnings/disability definition, elimination period,
partial/residual or total-disability branches, benefit cadence, benefit period,
income or insured-amount basis, offsets, reassessment, return-to-work/recovery,
and termination. Do not substitute an ADL care-state definition for an
occupation or income-loss definition.

## 7. Review And Acceptance Gates

Run:

```text
exact identity and approved source digest
-> complete official title inventory
-> bounded evidence packets
-> care-state and formula contract
-> canonicalizer + validator + dedicated importer dry-run
-> exact cards + nested indicators + indicator-table readback
```

Audit at minimum:

- `omissions`: accepted heading, trigger, obligation, care-state field, formula,
  or projection missing;
- `falseResponsibilities`: definition, medical note, exclusion, or process
  promoted to responsibility;
- `stateConditionGate`: ADL/cognitive/cause/duration/reassessment/termination
  conditions unsupported or collapsed;
- `periodicPaymentGate`: cadence, amount, period/count/limit, continuation, or
  termination unsupported or missing;
- `medicalReimbursementConfusion`: care cash mislabeled as expense
  reimbursement or vice versa;
- `sameDigestProjectionGate`: artifact/card/indicator identity or formula
  mismatch.

Use statuses:

- `approved`: every source, semantic, deterministic, and exact-readback gate
  passed;
- `validation_review`: exact source exists but semantics or deterministic
  artifact gates are incomplete;
- `source_review`: source identity, bytes, digest, or readable evidence is
  unresolved;
- `materializer_blocked`: approved artifact does not survive exact card and
  indicator projections.

An offline forward test is an audit signal, not artifact approval. It must open
SQLite read-only, select mutually exclusive exact-key products, and report every
gap rather than rewriting data.
