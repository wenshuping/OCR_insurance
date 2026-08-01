# Endowment Responsibility Contract

## 1. Exact identity and evidence

Bind every result to one immutable tuple:

```json
{
  "company": "legal insurer name",
  "productName": "exact filed product title",
  "sourceDigest": "sha256:<64 lowercase hex>",
  "sourceUrl": "official insurer or regulator URL",
  "artifactStatus": "approved"
}
```

Require the same digest in the official artifact, card payload, every nested
indicator, and every `insurance_indicator_records.payload`. A matching name or
URL with another digest is a version conflict. Existing cards and indicators
are comparison layers, not proof of responsibility content.

Every accepted field uses one exact contiguous `sourceExcerpt` or ordered
page-specific `evidenceSegments`. A product name, marketing summary, definition,
exclusion, claim process, or another product/version cannot supply missing
evidence.

## 2. Contract topology

Use exactly one topology supported by official relationship evidence:

- `standalone`: independently effective filed contract.
- `rider`: attached contract; preserve main-contract dependency, effective and
  termination linkage, and any insured-amount or premium reference.
- `group`: preserve policyholder/member eligibility, entry/exit rules, and
  member/plan-tier amount ownership.
- `bundle_component`: map the marketing bundle to one exact filed component and
  its own source digest before parsing it.

Do not infer topology from `附加`, `团体`, `学平`, a plan name, or a company
convention. Unknown topology fields remain empty and enter handoff.

Minimum shape:

```json
{
  "contractTopology": {
    "type": "standalone|rider|group|bundle_component",
    "evidenceSegments": [],
    "parentContract": {},
    "groupContract": {},
    "bundle": {}
  }
}
```

## 3. Endowment classification gate

Classify a product as endowment only when official responsibility evidence proves
both distinct obligations:

1. `death_or_total_disability`: the insured dies or becomes totally disabled
   during the insurance period and the insurer pays the stated benefit.
2. `maturity_survival`: the insured survives to the finite maturity date and the
   insurer makes one maturity payment.

The two roles must use different stable `responsibilityId` values. A death
formula mentioning `交费期满`, a cash-value provision, surrender payment,
premium refund on termination, periodic survival benefit, or a name containing
`两全/返还` does not prove the maturity-survival role.

Minimum product profile:

```json
{
  "endowmentProfile": {
    "classification": "endowment|not_endowment|review",
    "deathOrTotalDisabilityResponsibilityIds": [],
    "maturitySurvivalResponsibilityIds": [],
    "periodicAnnuityResponsibilityIds": [],
    "classificationEvidenceSegments": [],
    "unresolvedFields": []
  }
}
```

## 4. Responsibility versus supporting material

Accept only a covered event/state plus an insurer obligation.

Concrete responsibilities may include:

- death insurance benefit;
- death or total-disability benefit;
- one-time maturity or maturity-survival benefit;
- independently titled accidental death/total-disability extra benefit;
- independently titled premium return at maturity.

Keep these out of responsibility counts:

- terms/definitions of death, total disability, maturity, premium, cash value,
  and basic insured amount;
- exclusions and liability-exemption clauses;
- claims application, notice, appraisal, and document procedures;
- surrender value, policy loan, and general termination descriptions without a
  maturity-survival obligation;
- group headings such as `保险责任`, `基本责任`, or `可选责任`;
- dividend declarations, bonus allocation, accumulated interest, and bonus
  realization;
- an annuity payment schedule or option that has its own periodic role.

Store rejected candidates with source location and a reason.

## 5. Maturity and annuity boundary

A maturity-survival responsibility must preserve:

```json
{
  "responsibilityRole": "maturity_survival",
  "cashflowTreatment": "scheduled_cashflow",
  "cashflowCadence": "once_at_maturity",
  "triggerCondition": "survival to exact maturity date",
  "insurerObligation": "one source-backed payment",
  "terminationEffect": ""
}
```

Repeated benefits at every anniversary, year, month, or other interval use
`responsibilityRole=periodic_annuity` and their own cadence. A product can contain
both roles; never merge them. A one-time maturity benefit is not an annuity merely
because it is scheduled.

## 6. Death and total-disability formulas

Preserve:

- insurance-period trigger and covered cause;
- age/date/policy-year condition;
- whether the premium payment period is ongoing or complete;
- basic insured amount, actual paid premium, total paid premium, cash value, and
  any contract-defined basis as distinct inputs;
- exact `max`/`min` operands and branch-local operands;
- deductions, previously paid benefits, and contract termination.

Use `branches` only for mutually exclusive conditions:

```json
{
  "branchId": "stable-id",
  "conditionText": "exact source condition",
  "formulaText": "exact branch formula",
  "basisKey": "exact_branch_basis",
  "calculationStatus": "display_only|needs_table|needs_claim_facts|calculable",
  "requiredInputs": [],
  "evidenceTokens": [],
  "operands": []
}
```

Use `operands` only for literal comparisons:

```json
{
  "operandId": "stable-id",
  "formulaText": "exact compared amount",
  "basisKey": "exact_operand_basis",
  "requiredInputs": [],
  "evidenceTokens": []
}
```

Map exact official terms consistently. In particular,
`实际交纳的保险费` is `actual_paid_premium`, not `total_paid_premium`.

## 7. Premium-return and amount bases

A maturity benefit may pay a basic insured amount, a percentage/multiple of
premium, an account value, or another exact basis. Preserve the source formula;
do not normalize every maturity benefit to premium return.

When the source says `较大者` or `较小者`, set an exact comparison basis and list
every operand. When cash value is an operand and no current value/table exists,
use `needs_table`. Missing current policy inputs never justify a guessed amount.

## 8. Accident additional relationship

An independently titled accident benefit requires:

```json
{
  "benefitRelationship": {
    "baseResponsibilityIds": [],
    "additionalResponsibilityId": "",
    "semantics": "additive|substitutive|exclusive|capped_additive|max_of",
    "multiplierOrLimit": "",
    "sourceExcerpt": ""
  }
}
```

Source wording such as `额外`, `另行`, or `除上述给付外` may prove additive
semantics. Wording such as `不再给付`, `仅给付`, or `二者择一` may prove
substitutive/exclusive semantics. If the relationship is absent, keep the
responsibility but route aggregation to review.

## 9. Dividends and product functions

For participating products, store source-backed dividend/bonus mechanisms only
under `productFunctions`, for example:

```json
{
  "functionKind": "participating_dividend",
  "guaranteeStatus": "non_guaranteed",
  "sourceExcerpt": ""
}
```

Do not create a guaranteed responsibility or add dividends to an insured amount
unless the exact payment responsibility and formula expressly include a
contract-defined dividend-related basis. Preserve that basis definition and its
non-guaranteed status.

## 10. Role exclusions

- `periodic_annuity`: repeated survival payments; not the maturity role.
- `term_life`: finite death coverage without a maturity-survival obligation.
- `whole_life`: lifetime death coverage without a finite maturity-survival
  obligation.
- `incremental_whole_life`: whole-life death coverage using an officially proven
  effective-sum-assured growth rule; the growth factor is not maturity.

Names may help locate a candidate but never satisfy these exclusions or the
endowment gate.

## 11. Deterministic acceptance sequence

Require this order:

```text
exact sourceDigest
-> complete heading inventory
-> bounded official evidence packets
-> endowment dual-role gate
-> formulas/branches/operands/requiredInputs/relationships
-> canonicalizer
-> validator
-> dedicated importer dry-run
-> card + nested-indicator + indicator-table exact readback
```

Approval additionally requires:

- exact stable IDs and titles at every projection;
- same source URL/digest at every projection;
- one-time maturity not represented as periodic annuity;
- comparison operands and age/payment-period branches preserved;
- accident extra relationship preserved without double counting;
- dividends absent from guaranteed responsibility counts;
- unresolved source, topology, formula, or projection gaps emitted only to
  handoff.

A model/runner result, `ok=true`, equal counts, card presence, importer success,
or SQLite `quick_check` alone is insufficient.
