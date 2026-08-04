# Critical-Illness Responsibility Contract

## Contents

1. Identity and source gate
2. Heading inventory and evidence packets
3. Responsibility and formula fields
4. Critical-illness structural rules
5. False-responsibility gate
6. Customer-summary contract
7. Deterministic gates and failure routing

## 1. Identity and source gate

Bind one artifact to one exact triple:

```text
company + productName + sourceDigest
```

Require:

- insurer/regulator official source URL;
- exact product/version evidence;
- preserved official bytes with `sha256:<64 lowercase hex>`;
- readable complete responsibility chapter;
- cited definition and formula-table pages;
- field-level evidence for populated filing/product/version fields.

Also require one source-backed topology:

```text
contractTopology = standalone | rider | group | bundle_component
```

- `standalone`: no governing-contract dependency is asserted.
- `rider`: record the exact main-contract dependency and termination/effect link.
- `group`: record policyholder/member eligibility and member-level responsibility
  scope separately from benefit formulas.
- `bundle_component`: record the containing contract/plan and the exact
  component clause, such as a fixed disease benefit inside student accident
  insurance.

Topology never supplies responsibility content. Do not infer it from words in a
product name, and do not use a marketing package or plan sheet as governing
terms when exact clauses are absent.

Do not merge distinct digests. Missing or conflicting source identity routes to
`source_review`.

Store topology at artifact root:

```json
{
  "contractTopology": "standalone",
  "topology": {
    "mainContractDependency": null,
    "terminationLink": null,
    "memberEligibility": null,
    "containingContract": null,
    "component": null,
    "sourcePage": "",
    "sourceExcerpt": ""
  }
}
```

Populate only fields supported by exact clauses. Leave the rest null.

## 2. Heading inventory and evidence packets

Inventory every heading in the complete responsibility chapter as one of:

- `responsibility`;
- `group`;
- `rule`;
- `definition`;
- `exclusion`;
- `claim_procedure`;
- `interpretation`;
- `unresolved`.

Accept `responsibility` only when exact bounded evidence contains:

1. a covered event, diagnosis, age/date/stage, survival/death/disability state,
   expense, or waiver trigger; and
2. an insurer payment, reimbursement, waiver, service, or refund obligation.

Use this packet shape:

```json
{
  "responsibilityId": "stable-source-derived-id",
  "officialHeading": "",
  "sectionPath": [],
  "sourcePage": "",
  "sourceExcerpt": "",
  "evidenceSegments": [],
  "triggerCondition": "",
  "insurerObligation": "",
  "definitionRefs": [],
  "ruleRefs": [],
  "formulaEvidence": [],
  "unresolvedFields": []
}
```

Every `sourceExcerpt` and segment must be an exact contiguous official substring.
Cross-referenced definitions can prove the meaning of a basis or covered disease,
but cannot create a responsibility without a source responsibility heading and
insurer obligation.

## 3. Responsibility and formula fields

Each accepted responsibility requires:

```json
{
  "responsibilityId": "",
  "liability": "",
  "responsibilityKind": "benefit",
  "coverageAggregation": "include",
  "groupId": null,
  "parentResponsibilityId": null,
  "selectionStatus": "included",
  "triggerCondition": "",
  "insurerObligation": "",
  "importantLimits": [],
  "ruleRefs": [],
  "sourcePage": "",
  "sourceExcerpt": "",
  "evidenceSegments": [],
  "card": {
    "title": "",
    "customerSummary": "",
    "benefitExplanation": ""
  },
  "indicators": []
}
```

Allowed `responsibilityKind` values include `benefit`, `waiver`, and
`waiting_period_refund`. A waiting-period refund uses
`coverageAggregation: exclude`.

Every responsibility has at least one indicator or an explicit
`not_quantitative` decision. A quantitative indicator preserves:

```json
{
  "indicatorName": "",
  "formulaText": "",
  "normalizedFormula": "",
  "basisKey": "",
  "calculationKey": "",
  "calculationStatus": "display_only",
  "calculationEligible": false,
  "calculationReason": "",
  "requiredInputs": [],
  "sourcePage": "",
  "sourceExcerpt": "",
  "evidenceTokens": [],
  "branches": [],
  "operands": []
}
```

Use `branches` only for mutually exclusive conditions. Preserve exact condition
text, formula, basis, status, required inputs, evidence tokens, and branch-local
operands. Use `operands` only for source-stated max/min comparisons. A missing
cash value or coefficient table routes to `needs_table`, not an invented value.

## 4. Critical-illness structural rules

Preserve, without company or product special cases:

- single-pay severe/major disease;
- mild/moderate/severe tier relationships;
- grouped multi-pay: group identity, one-per-group limit, total count, interval,
  and termination;
- ungrouped multi-pay: total count, recurrence/new-disease rule, interval, and
  termination;
- additional benefits: base responsibility link plus exact percentage/amount;
- age, policy-year, diagnosis-order, and disease-stage conditions as branches;
- specific-disease benefits only when the responsibility heading and obligation
  are present;
- premium waiver scope and start/end timing;
- optional death/total-disability selection and mutual exclusion;
- standalone waiting-period refund separately from normal protection totals.
- the same responsibility semantics for standalone, rider, group, and
  bundle-component contracts, while storing main-contract dependency, member
  eligibility, and component relationship outside the responsibility formula.

Do not enumerate disease names to decide responsibility membership. Disease
lists belong to definition evidence or an audit fixture only.

## 5. False-responsibility gate

Never create a responsibility from:

- `疾病定义`, a disease count, or a named disease definition alone;
- `责任免除` or an excluded event;
- `保险金申请`, documents, notice, appraisal, or claim workflow;
- `释义`, `名词解释`, hospital/doctor definitions, or a table of contents;
- waiting-period duration without a separate insurer obligation;
- group labels such as `基本责任`, `可选责任一`, or `保险责任`;
- a formula table, payment ratio, interval, or limit without its owning
  responsibility;
- an existing card, indicator, customer summary, or product-name keyword.
- a marketing package, plan name, enrollment label, or member category without
  exact governing clause evidence.

Record false or unresolved headings in `rejectedFragments` with source location
and reason.

## 6. Customer-summary contract

Generate one summary per accepted responsibility and retain its source map.

- State trigger, insurer obligation, amount/formula, waiting/interval/count,
  termination, optional selection, and material limitations only when evidenced.
- Keep responsibility, definitions, exclusions, and claim procedures in separate
  sections.
- Mark missing source, version, table, policy input, or claim fact as a gap.
- Do not convert `合同继续有效` into a broader promise.
- Do not state current coverage for `not_included` or `unknown` optional benefits.
- Do not calculate a value unless every `requiredInputs` item is present.

## 7. Deterministic gates and failure routing

Required order:

```text
official sourceDigest
-> heading inventory
-> bounded evidence packets
-> artifact formula/branches/requiredInputs
-> canonicalizer
-> validator
-> dedicated importer dry-run
-> card + nested indicator + indicator-table + customer-summary exact readback
```

Gate results:

- missing official bytes/digest/version/readable responsibility text:
  `source_review`;
- missing title, trigger, obligation, evidence, formula token, group/count/interval,
  or summary support: `validation_review`;
- external `deepseek-standard` or `luna-complex` execution failure:
  `model_retry` on the same route;
- canonicalizer/validator/importer dry-run not run or failed:
  `validation_review`;
- exact artifact passed but persisted formulas, indicators, provenance, or summary
  differ: `materializer_blocked`;
- all gates and exact readback passed: `approved`.

`ok=true`, equal counts, a card's presence, or SQLite `quick_check` alone never
proves semantic approval.
