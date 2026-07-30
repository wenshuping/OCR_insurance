# Responsibility Formula Rule Packs

Use these packs after the official responsibility inventory is locked. Select a
pack from the clause's obligation, trigger, and formula shape, not from the
product name alone. A single product may use several packs.

## Common Deterministic Contract

For every official responsibility, preserve:

- one official liability title;
- trigger and insurer obligation;
- every formula branch, operand, percentage, multiplier, cap, count, interval,
  age boundary, policy-year boundary, and termination effect;
- exact official evidence covering all customer and calculation fields;
- one matching internal indicator.

Programmatic merge may accept a responsibility without model review only when:

1. its title and section boundary are unambiguous;
2. all cited text is an exact substring of the official source;
3. every numeric token and inclusive/exclusive boundary in the result occurs in
   its evidence;
4. the parsed formula preserves the same branch and table-row count as the
   official clause;
5. all inputs use the canonical dictionary; and
6. no source, version, responsibility-scope, or OCR ambiguity remains.

Complexity alone is not an escalation reason. A complete, machine-parsed table
or `max` formula can remain deterministic and use `manual_formula`. Escalate
only when the program cannot prove the six conditions. Send the verifier the
single responsibility packet plus applicable shared clauses, not the whole
document.

Never use a model-written excerpt in the final artifact. Rebuild final evidence
from official section offsets after merge.

## Pack 1: Disease And Critical Illness

Recognize named disease benefits, including severe, moderate, mild, specific
disease, cancer extension/recurrence, transplant, care, and premium waiver.

Preserve these dimensions when present:

- benefit level and percentage or multiple of basic amount;
- disease groups and whether each group is independently payable;
- payment count per disease, group, and contract;
- interval between diagnoses or claims;
- first-versus-subsequent payment ratios;
- age, policy-year, sex, or disease-specific tiers;
- extra benefits and whether they are additive or mutually exclusive;
- deductions for benefits already paid;
- responsibility or contract termination after payment;
- waiting-period treatment, including refund versus no liability.

Field routing:

| Formula shape | Basis/calculation | Treatment |
| --- | --- | --- |
| basic amount × one explicit ratio | `basic_amount` / `percent_of_basic_amount` | `claim_contingent` |
| basic amount × one explicit multiple | `basic_amount` / `multiple_of_basic_amount` | `claim_contingent` |
| several ratios, stages, groups, deductions, or conditional branches | most material supported basis / `manual_formula` | `claim_contingent` |
| complete age or policy-year ratio table | `schedule_or_policy_table` / `schedule_or_policy_table` or `manual_formula` | `claim_contingent` |
| waiver of future premiums only | `rule_parameter` / `not_calculable` | `waiver_only` |

Keep tiers or groups inside one item when the clause gives them one
responsibility title. Create separate items only for separately named official
responsibilities.

Do not turn disease definitions, waiting periods, payment order, disease-group
lists, or termination clauses into standalone responsibilities.

## Pack 2: Annuity And Scheduled Returns

Recognize annuity, pension, survival, birthday, education, care, maturity, and
other payments triggered by reaching a contractually scheduled date while
alive.

Extract a scheduled cashflow tuple:

```text
(start, end, frequency, survival condition, amount basis, ratio or amount,
 growth rule, guarantee rule)
```

Preserve:

- first payment date or age;
- final payment date, age, duration, or lifetime condition;
- annual, monthly, one-time, or policy-anniversary frequency;
- payment in advance versus arrears when stated;
- basic amount, premium, account value, or policy-table basis;
- annual/monthly conversion factors and increasing ratios;
- guaranteed payment period/count and treatment after death;
- selected annuity option and option-specific branches.

Field routing:

| Formula shape | Basis/calculation | Treatment |
| --- | --- | --- |
| fixed amount or one supported premium/basic-amount ratio at explicit dates | corresponding supported key | `scheduled_cashflow` |
| amount or ratio comes from the policy schedule | `schedule_or_policy_table` / `schedule_or_policy_table` | `scheduled_cashflow` |
| growth, guarantee, monthly conversion, option, or multiple timing branches | appropriate basis / `manual_formula` | `scheduled_cashflow` |
| death benefit during accumulation or payment period | its own supported/manual formula | `claim_contingent` |

Survival to a scheduled date is still `scheduled_cashflow`; it is not converted
to `claim_contingent` merely because survival is a condition. A guarantee rule
belongs inside the annuity responsibility unless the contract names a separate
death or guaranteed-payment responsibility.

Do not treat cash value, surrender, policy loans, dividends, universal-account
interest, or optional withdrawal methods as scheduled responsibilities.

## Pack 3: Life And Endowment

Recognize death, total disability, maturity, and separately named premium-return
benefits.

Preserve:

- accident versus non-accident and waiting-period branches;
- age-at-event and policy-year bands;
- paid-premium, basic-amount, cash-value, and account-value operands;
- every operand and tie rule in `max` or `min`;
- premium percentages or multipliers;
- deductions for prior payments;
- mutual exclusion among death, disability, maturity, and disease benefits;
- contract termination consequences.

Field routing:

| Formula shape | Basis/calculation | Treatment |
| --- | --- | --- |
| maturity payment at the scheduled expiry date | supported/manual formula | `scheduled_cashflow` |
| death or total disability | supported/manual formula | `claim_contingent` |
| `max`/`min`, age bands, cash value, or several operands | material basis / `manual_formula` | trigger-dependent |
| account value payment | `account_value` / `account_value` or `manual_formula` | trigger-dependent |

Do not derive cumulative premiums at the event date as
`policy.firstPremium × policy.paymentPeriodYears` unless level premium,
frequency, payment completion, and event timing make it exact. Otherwise require
`manualFormulaInputs` and name `cumulativePaidPremiumAtEvent`.

## Pack 4: Medical Reimbursement And Allowance

Recognize expense reimbursement, fixed medical benefits, inpatient/outpatient
benefits, drug/device benefits, and daily allowances.

Preserve:

- eligible expense scope and hospital/provider constraints that directly affect
  payment;
- social-insurance status and whether it was actually used;
- deductible, reimbursement ratio, third-party payment, and compensation order;
- per-item, per-visit, annual, lifetime, and overall liability limits;
- waiting period, observation period, and days excluded;
- actual days, deductible days, daily amount, and day limit;
- renewal-year or plan-specific branches.

Field routing:

| Formula shape | Basis/calculation | Treatment |
| --- | --- | --- |
| `(eligible expense - deductible - third-party paid) × ratio`, subject to limit | `medical_expense` / `medical_formula` | `claim_contingent` |
| daily amount × payable days, subject to a day limit | `daily_allowance` / `daily_allowance` | `claim_contingent` |
| one fixed diagnosed/procedure amount | `fixed_amount` / `fixed_amount` | `claim_contingent` |
| several expense buckets or shared/sub-limits | `medical_expense` / `manual_formula` | `claim_contingent` |

Medical reimbursement and allowance calculations normally remain
`calculationEligible: false` until actual claim inputs are available. Do not
promote provider networks, claims procedures, health services, or exclusions to
responsibilities.

## Pack 5: Accident

Recognize accidental death, disability, medical reimbursement, allowance, and
extra benefits for transport, occupation, location, or specified events.

Preserve:

- accident definition and covered scenario;
- disability grade and official percentage table;
- transport/event-specific multiple or additional percentage;
- age, occupation, vehicle, location, and time restrictions that directly alter
  payment;
- medical deductibles, ratios, and limits;
- cumulative disability adjustment and prior-payment deductions;
- mutual exclusion and aggregate caps.

Field routing:

| Formula shape | Basis/calculation | Treatment |
| --- | --- | --- |
| death benefit at one basic-amount ratio/multiple | corresponding basic-amount key | `claim_contingent` |
| disability grade table | `schedule_or_policy_table` / `schedule_or_policy_table` or `manual_formula` | `claim_contingent` |
| transport/event multiple combined with another benefit | material basis / `manual_formula` | `claim_contingent` |
| accident medical reimbursement or allowance | medical or daily-allowance pack | `claim_contingent` |

Do not infer a disability percentage from domain knowledge. The exact product's
official table is required.

## Shared Rules And Routing

Attach a shared clause only to responsibilities it expressly governs:

- waiting period and its consequence;
- common payment count or aggregate limit;
- benefit-order deduction;
- mutual exclusion;
- main-versus-rider payment restriction;
- contract or responsibility termination.

The deterministic router should emit one of:

```text
auto_merge
verifier_required
source_repair_required
```

Use `auto_merge` when all common deterministic conditions pass, even if the
formula is stored as `manual_formula`.

Use `verifier_required` for unresolved responsibility ownership, ambiguous
branch scope, contradictory model proposals that cannot be settled by offsets,
or a formula/table whose exact structure cannot be parsed reliably.

Use `source_repair_required`, not a stronger language model, for missing pages,
truncated continuation text, unreadable OCR numbers, table-column loss, or
unproven product/version identity.

After any verifier response, rerun the same deterministic gates. A verifier
cannot waive evidence, numeric, canonical-input, or importer validation.
