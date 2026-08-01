---
name: ocr-insurance-endowment-responsibility
description: Parse, repair, review, and audit exact-version Chinese endowment-insurance responsibilities. Use for ordinary or participating endowment contracts, premium-return or amount-based maturity benefits, death or total-disability branches, accident additional benefits, age/payment-period/policy-year formulas, riders, group contracts, and filed bundle components without confusing one-time maturity benefits with annuities, term life, whole life, incremental whole life, dividends, definitions, exclusions, or claims procedures.
---

# Endowment Responsibility Parsing

Read [references/contract.md](references/contract.md) before producing an
inventory, artifact, card, indicator, customer summary, or audit.

## Safety boundary

- Lock one exact `company + productName + sourceDigest`. Use only same-digest
  official evidence, an approved artifact, and same-digest cards/indicators.
- Treat names containing `两全`, `返还`, or similar words as discovery signals
  only. Require official evidence for both the in-term death/total-disability
  obligation and the one-time maturity-survival obligation.
- Keep SQLite, network, models, Feishu, publication, `.env.local`, and
  production parsers untouched unless separately authorized.
- Put any company/product exception only in a focused fixture. Never add it to
  the generic parser contract.

## Workflow

1. Resolve the exact identity, official URL, digest, version, and contract
   topology: `standalone`, `rider`, `group`, or `bundle_component`.
2. Inventory the complete responsibility chapter. Accept only a covered trigger
   plus an insurer payment or benefit obligation.
3. Prove the endowment pair as two distinct responsibilities:
   - death or total disability during the insurance period; and
   - survival to the contract maturity date with one maturity payment.
4. Keep recurring survival/annuity payments separate from the one-time maturity
   responsibility. If the contract has no proven maturity-survival obligation,
   do not classify it as endowment.
5. Preserve exact formulas, bases, age/payment-period/policy-year branches,
   `requiredInputs`, max/min `operands`, termination effects, and
   additional-benefit relationships.
6. Store dividends and bonus realization only in `productFunctions`, marked
   non-guaranteed when the source says so. Never count them as guaranteed
   insurance responsibilities.
7. Run the existing canonicalizer, validator, and dedicated importer dry-run.
   Approval requires all three and exact same-digest card/indicator readback.
8. Write every source, topology, formula, or projection gap to handoff. Do not
   fill a gap by analogy or change the production parser for one product.

## Core distinctions

- `maturity_survival`: one payment triggered by survival to the maturity date;
  use `cashflowTreatment=scheduled_cashflow` with cadence
  `once_at_maturity`.
- `periodic_annuity`: repeated payments at annual, monthly, anniversary, or
  other recurring dates; keep separate and never infer endowment from it.
- `term_life`: in-term death coverage without a maturity-survival payment.
- `whole_life` / `incremental_whole_life`: lifetime death coverage, including
  effective-sum-assured growth, without a finite maturity-survival payment.
- Dividends, cash-value descriptions, surrender rights, definitions,
  exclusions, and claim processes are supporting material or product
  functions, not responsibilities.

## Formula and relationship gates

- Use `branches` for mutually exclusive age, payment-period, or policy-year
  paths.
- Use `operands` only for literal `较大者/max` or `较小者/min` comparisons.
- Preserve distinct bases such as `basic_insured_amount`,
  `actual_paid_premium`, `total_paid_premium`, and `cash_value`; never
  substitute one for another.
- Link an accident extra benefit to its base death/total-disability
  responsibility and preserve whether it is additive, substitutive, exclusive,
  or capped. Do not double count a replacement benefit.
- Preserve when each payment terminates the responsibility or entire contract.

## Resources

Validate the focused fixtures:

```bash
python3 scripts/validate_fixtures.py fixtures
```

Run a bounded read-only SSD audit:

```bash
python3 scripts/forward_test_readonly.py \
  --db /absolute/path/policy-ocr.sqlite \
  --output-dir /absolute/path/audit-directory \
  --sample-size 20
```

The forward test opens SQLite with `mode=ro`, sets `query_only=ON`, writes only
to the requested output directory, and never invokes a network service, model,
importer, publisher, or Feishu.
