# Chinese Term-Life Responsibility Contract

Use this contract only after exact-version official evidence is `source_ready`.
Domain knowledge can classify a source-backed field but cannot create a fact.

## 1. Identity And Source

Lock one immutable identity:

```json
{
  "company": "legal insurer name",
  "productName": "exact official product name and version",
  "sourceDigest": "sha256:<64 lowercase hex>",
  "sourceUrl": "https://official-host.example/terms.pdf",
  "sourceStatus": "source_ready"
}
```

Require the artifact, cards, indicators, and source manifest to use the same
identity triple and digest. A same-name product with another digest is another
version. A card or indicator without the exact digest is not a valid readback.

Every evidence span must be an exact substring of the official text associated
with `sourceDigest`. Preserve page/offset mappings and do not author excerpts.

## 2. Product Classification

Classify from official contract structure and responsibility wording, not the
product name.

Use `semanticFamily: term_life` when the reviewed contract:

- provides death and optionally total-disability protection during a bounded
  insurance period or personal insurance period;
- makes the benefit claim-contingent; and
- does not provide a whole-life duration, annuity schedule, or universal-account
  accumulation as the owning responsibility.

Cash value, a decreasing or staged sum assured, annual effective amount, paid
premium return, or max/min comparison does not imply increasing whole life.

Route to review when term duration cannot be established. Reject these
classifications unless an explicitly bounded term-life component is being
reviewed:

- `whole_life`
- `increasing_whole_life`
- `annuity`
- `endowment_scheduled_cashflow`
- `universal_account`

## 3. Contract Topology

Allowed values:

```text
standalone
rider
group
bundle_component
```

Record:

```json
{
  "contractTopology": "standalone",
  "topology": {
    "mainContractDependency": null,
    "groupMembership": null,
    "sumAssuredReference": {
      "kind": "contract_amount|member_amount|schedule|loan_balance|referenced_main_contract|bundle_plan",
      "sourcePage": "",
      "sourceExcerpt": ""
    },
    "terminationLinkage": [
      {
        "event": "",
        "effect": "contract_terminates|rider_terminates|member_coverage_terminates|responsibility_terminates|bundle_component_terminates|linked_contract_terminates",
        "sourcePage": "",
        "sourceExcerpt": ""
      }
    ]
  }
}
```

Additional requirements:

- `rider`: identify the referenced main contract, premium/sum-assured dependency,
  and whether main-contract termination ends the rider.
- `group`: identify eligible member scope, personal insurance-period start/end,
  exit effect, member-level sum assured, and whether payment ends only that
  member's coverage.
- `bundle_component`: identify the documented component boundary, bundle plan
  amount reference, and component/bundle termination interaction.
- Do not default missing topology evidence to `standalone`.

## 4. Inventory

Build the inventory independently before cards or indicators.

Accept a responsibility only when its evidence contains:

1. a death or total-disability trigger; and
2. the insurer's obligation to pay or return a benefit.

Keep separate official headings separate. Keep formula branches inside one
responsibility when the source does not name a separate obligation.

For a combined heading such as `身故或身体全残保险金` or
`身故和身体全残保险金`, create one responsibility and one indicator
decision. Store disease, accident, waiting-period, age, and payment-period
variants as branches. Do not derive `疾病全残` from a disease-cause sentence.
Conversely, retain two responsibilities when the source independently heads and
defines `身故保险金` and `全残保险金`.

Reject:

- `保险责任`, `基本责任`, `可选责任`, `释义`, `责任免除`;
- death or total-disability definitions without a payment obligation;
- beneficiary designation, benefit application, claims documents, notice,
  proof, limitation, surrender, loan, or cash-value-only procedures;
- long clause prose used as a liability title;
- waiting-period, age, or amount conditions without an owning obligation.

## 5. Responsibility Fields

Each accepted responsibility must contain:

```json
{
  "responsibilityId": "stable source-derived id",
  "liability": "official responsibility heading",
  "responsibilityKind": "benefit|waiting_period_refund",
  "coverageAggregation": "include|exclude",
  "semanticFamily": "term_life",
  "contractTopology": "standalone|rider|group|bundle_component",
  "responsibilityEffectivePeriod": {
    "start": "",
    "end": "",
    "scope": "contract|rider|member|bundle_component",
    "sourcePage": "",
    "sourceExcerpt": ""
  },
  "triggerCondition": "",
  "insurerObligation": "",
  "beneficiaryPaymentSemantic": {
    "recipientScope": "beneficiary|insured|policyholder|estate|not_stated",
    "paymentMeaning": "",
    "sourcePage": "",
    "sourceExcerpt": ""
  },
  "importantLimits": [],
  "terminationEffects": [],
  "sourcePage": "",
  "sourceExcerpt": "",
  "evidenceSegments": []
}
```

Use `not_stated` when the responsibility clause does not specify the recipient.
Do not infer a named beneficiary from general contract practice.

## 6. Formula And Branches

Keep every source-backed formula component:

- basic or member insurance amount;
- annual effective or decreasing amount;
- loan balance or schedule;
- paid or actually paid premium;
- cash value;
- age, payment-period, waiting-period, and policy-year boundary;
- `max`, `min`, tie rule, deduction, and termination effect.

Use a piecewise parent for mutually exclusive conditions. Use operands for
comparisons. A branch containing max/min owns its own operands.

Example branch shape:

```json
{
  "branchId": "waiting_period_non_accident",
  "conditionText": "exact condition text",
  "formulaText": "exact formula text",
  "basisKey": "actual_paid_premium",
  "calculationStatus": "display_only|needs_table|needs_claim_facts",
  "requiredInputs": ["actual_paid_premium_at_event"],
  "evidenceTokens": ["literal token"],
  "operands": []
}
```

Example comparison shape:

```json
{
  "normalizedFormula": "max(actual_paid_premium_at_event, cash_value, term_sum_assured_at_event)",
  "basisKey": "max_of_actual_paid_premium_cash_value_term_sum_assured",
  "calculationKey": "maximum_of_bases",
  "operands": [
    {
      "operandId": "actual_paid_premium_at_event",
      "formulaText": "事件发生时实际交纳的保险费",
      "basisKey": "actual_paid_premium",
      "requiredInputs": ["actual_paid_premium_at_event"],
      "evidenceTokens": ["实际交纳的保险费"]
    }
  ]
}
```

Do not invent a repository input alias. Use the selected current pipeline's
canonical dictionary. When an official operand has no canonical field, keep the
formula displayable, mark it non-calculable, and name the missing operand in
`requiredInputDetails`.

## 7. Term-Specific Gates

Require all applicable gates:

- insurance period and responsibility effective period;
- death and total-disability trigger ownership;
- basic, decreasing, staged, annual-effective, loan-balance, or referenced
  member amount;
- paid-premium, cash-value, and sum-assured comparisons;
- age, payment-period, waiting-period, accident/non-accident, and exclusion
  branches;
- contract, rider, member, responsibility, or bundle termination effect;
- beneficiary-facing payment meaning without inventing a recipient;
- exact topology dependencies.

Omit unsupported fields and add a review issue. Do not treat `not_run` as pass.

## 8. Model Routing

The Skill only emits routing metadata:

```text
deepseek_standard
luna_complex
```

Use `deepseek_standard` only for a source-complete, single-branch level benefit
or simple death-plus-total-disability amount. Use `luna_complex` for max/min,
cash value, decreasing/staged amount, multiple branches, age or payment-period
boundaries, group eligibility, rider dependency, bundle topology, or disputed
responsibility ownership.

Routes are mutually exclusive. Provider errors enter a terminal review queue;
the Skill does not call or fall back to another model.

## 9. Approval And Readback

Approval order:

```text
sourceDigest
  -> independent inventory
  -> bounded evidence packets
  -> artifact formula/branches/requiredInputs
  -> canonicalizer
  -> validator
  -> dedicated importer dry-run
  -> exact card/indicator/customer-summary readback
```

Require:

- `audit.status == approved`;
- official checklist IDs equal responsibility IDs;
- responsibility IDs equal card IDs;
- every responsibility has at least one indicator decision;
- formulas, branches, operands, required inputs, source URL, and source digest
  survive in both card and indicator projections;
- customer summaries retain material limits and contain no internal audit keys;
- zero validator and importer issues.

Canonicalizer success, validator success, importer dry-run success, and exact
readback are separate gates. None implies another.

## 10. Customer Summary And Gaps

Generate customer wording only from validated fields. Present:

- protection period and responsibility effective scope;
- covered death/total-disability events;
- payment method and important limits;
- waiting-period or termination consequences;
- official source citation.

Keep a source map for key facts and a separate `gaps` list. Do not add United
States litigation, jurisdiction, endorsement, or claims-dispute analysis.
