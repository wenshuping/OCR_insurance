# Accident Responsibility Contract

## 1. Identity and source gate

Use exactly one tuple:

```json
{
  "company": "legal insurer name",
  "productName": "exact filed product name",
  "sourceDigest": "sha256:<64 lowercase hex>",
  "sourceUrl": "official insurer or regulator URL",
  "artifactStatus": "approved"
}
```

Require equality between the table digest, artifact
`productIdentity.sourceDigest`, official evidence packet, cards' nested
indicators, and indicator-table payloads. Select one canonical artifact row for
an exact duplicate tuple and record the duplicate rows. A different digest is a
different version.

An accepted responsibility needs exact official evidence for both:

1. event/condition plus accident causation; and
2. insurer payment, reimbursement, allowance, or other obligation.

Missing official evidence produces `review`. Do not use the product name,
marketing category, another version, another rider, or a similar company's
terms.

## 2. Contract topology

Set `contractTopology` to exactly one of:

- `standalone`: an independently effective filed contract.
- `rider`: an attached contract whose existence or effect depends on a main
  contract.
- `group`: a group contract whose covered persons depend on member eligibility.
- `bundle_component`: one exact filed product inside a multi-product bundle.

Do not infer topology from the words 附加, 学平, 团体, 校园, or a sales-plan
name. Cite official relationship evidence.

### Standalone

Record the contract's own effective date/rule, termination events, and insured
amount source. Do not invent a parent contract.

### Rider

Require:

```json
{
  "contractTopology": "rider",
  "topologyEvidence": [],
  "mainContractDependency": {
    "required": true,
    "sourceExcerpt": ""
  },
  "effectiveTerminationLinkage": {
    "effectiveRule": "",
    "terminationRule": "",
    "sourceExcerpt": ""
  },
  "insuredAmountReference": {
    "source": "main_contract|rider_schedule|separately_agreed",
    "formulaText": "",
    "sourceExcerpt": ""
  }
}
```

If any relationship is absent from the same-digest evidence packet, keep it
empty and set topology status to `review`. A rider responsibility may still be
inventory-complete while topology remains under review.

### Group

Require:

```json
{
  "contractTopology": "group",
  "memberEligibility": {
    "entryRule": "",
    "exitRule": "",
    "sourceExcerpt": ""
  },
  "planTier": {
    "tierId": "",
    "insuredAmountOrLimitSource": "",
    "sourceExcerpt": ""
  }
}
```

Preserve which member, occupation, project, or employment state is covered and
when coverage ends after loss of eligibility. A profession table or risk note
is a condition/rule, not a benefit.

### Bundle component

First decompose the bundle into actual filed products:

```json
{
  "contractTopology": "bundle_component",
  "bundleEvidence": {
    "bundleLabel": "",
    "sourceExcerpt": ""
  },
  "filedComponentIdentity": {
    "company": "",
    "productName": "",
    "sourceDigest": ""
  },
  "componentContractTopology": "standalone|rider|group"
}
```

Never parse 学平险 or another package label as one legal product. Each filed
component gets its own exact-key inventory and its concrete accident
responsibilities use the same accident profile below.

## 3. Responsibility versus supporting material

### Responsibilities

Accept independently headed obligations such as:

- accidental death;
- accidental disability;
- accident medical expense reimbursement;
- accident inpatient allowance;
- an independently promised transport, aviation, disaster, rescue, or other
  scenario benefit.

### Supporting material, not standalone responsibilities

- accident definition or causation definition;
- disability-grade table or assessment standard;
- exclusion/免责 section;
- occupation category, member qualification, or risk description;
- waiting period or termination clause without an insurer obligation;
- claims application, document list, notice, or process;
- generic headings such as 保险责任, 基本责任, 可选责任, 释义, 附表.

Attach supporting material through `ruleRefs`, `tableRefs`, relationship fields,
or `importantLimits`. One disability table produces one table-backed indicator,
not dozens or hundreds of grade responsibilities.

## 4. Accident profile

Every responsibility preserves:

```json
{
  "responsibilityId": "stable source-derived id",
  "liability": "official concrete title",
  "triggerCondition": "",
  "accidentCausation": {
    "accidentDefinitionRef": "",
    "causationText": "",
    "coveredTimeWindow": ""
  },
  "insurerObligation": "",
  "importantLimits": [],
  "terminationEffect": "",
  "sourcePage": "",
  "sourceExcerpt": "",
  "card": {},
  "indicators": []
}
```

### Death

Keep the accident-to-death time window, direct/sole-cause wording, deduction of
previous disability payments, amount basis, and contract termination.

### Disability and grade tables

Keep the assessment standard, grade-to-ratio mapping, multiple-disability rule,
prior-disability deduction, cumulative limit, and termination. Represent the
schedule with:

```json
{
  "tableRole": "disability_grade_ratio",
  "attachmentToResponsibilityId": "",
  "requiredInputs": ["insured_amount", "disability_grade"],
  "calculationStatus": "needs_table|needs_claim_facts",
  "sourceExcerpt": ""
}
```

### Accident medical

Preserve eligible actual expense, hospital/provider scope, social insurance or
other compensation, deductible, reimbursement ratio branches, per-event/annual
limit, treatment window, and termination. Do not turn a deductible or
compensation principle into a responsibility.

### Hospital allowance

Preserve `actual inpatient days x daily allowance`, deductible days when
present, per-stay and annual day caps, repeated-admission rule, ICU multiplier
or separate obligation, and responsibility termination.

### Scenario and transport benefits

When official wording says 额外, 另行, 除上述给付外, 同时再按, or 在基础上,
require:

```json
{
  "benefitRelationship": {
    "baseResponsibilityIds": [],
    "additionalResponsibilityId": "",
    "semantics": "additive|substitutive|exclusive|max_of|capped_additive",
    "multiplierOrLimit": "",
    "sourceExcerpt": ""
  }
}
```

Do not collapse a scenario benefit into the base benefit. Do not describe a
replacement benefit as additive. If the base relationship is not proven, set
`review`.

## 5. Formula contract

Each quantitative responsibility has an indicator or an explicit
`not_quantitative` decision. Preserve:

- official `formulaText` and structured `normalizedFormula`;
- exact bases and `requiredInputs`;
- every condition branch;
- explicit operands for max/min;
- disability table reference;
- medical deductible/compensation/reimbursement order;
- daily amount and day/count limits;
- additional-benefit base reference and multiplier;
- `calculationEligible=false` when policy or claim inputs are absent.

Unknown values remain absent. A disability grade, actual expense, inpatient
days, third-party compensation, member plan tier, or policy-schedule amount is
not guessed.

## 6. Deterministic acceptance sequence

Run in this order:

```text
sourceDigest
  -> exact inventory
  -> bounded evidence packet
  -> artifact formulas/branches/requiredInputs
  -> canonicalizer
  -> validator
  -> dedicated importer dry-run
  -> card/nested-indicator/indicator-table/customer-summary readback
```

Require the existing pipeline's validator and dedicated importer dry-run. A
passing model, runner, renderer, card count, importer return value, or
`quick_check` alone does not approve an artifact.

Readback compares:

- responsibility IDs and titles;
- formula text, normalized formula, bases, inputs, branches, and operands;
- source URL and digest;
- base/additional relationships;
- topology fields;
- customer summary causation, limits, additive/replacement meaning, and
  termination.

## 7. Status

- `approved`: every source, topology, responsibility, formula, relationship,
  deterministic, and readback gate passes.
- `review`: official source is usable but a topology, relationship, formula,
  evidence, or projection field is incomplete.
- `blocked`: exact identity or same-digest official evidence is unresolved.
- `rejected`: output contradicts official evidence or manufactures a
  responsibility.

Write unresolved items to handoff. Do not write SQLite or weaken the gates.
