---
name: ocr-insurance-annuity-responsibility
description: Parse, repair, or audit exact-version Chinese annuity, pension-annuity, education-annuity, survival-payment, and guaranteed-payment responsibilities. Use when OCR_insurance must distinguish recurring annuity obligations from one-time maturity benefits, death benefits, universal-account settlement, participating dividends, cash value, policy loans, surrender rights, or annuity-conversion options, while preserving payout start, frequency, duration, survival conditions, guarantees, formulas, branches, operands, topology, cards, indicators, and same-digest provenance.
---

# Annuity Responsibility Parsing

Read [references/contract.md](references/contract.md) before parsing, repairing,
validating, dry-running, forward-testing, or reviewing an annuity product.

## Safety boundary

- Lock one exact `company + productName + sourceDigest`. Use only the same-digest
  official terms, approved artifact, cards, and indicators.
- Never infer a responsibility, payout mode, guarantee, formula, or topology
  from a product or company name. Product-specific knowledge belongs only in
  `fixtures/`.
- Keep SQLite, Feishu, network, models, publication, `.env.local`, and the
  production parser unchanged unless separately authorized. Read-only work
  stays read-only.
- Treat canonicalizer, validator, and dedicated importer dry-run as separate
  gates. A model result, card, row count, or `quick_check` is not approval.

## Workflow

1. Resolve the exact source tuple and reject cross-digest or duplicate-version
   ambiguity.
2. Establish `contractTopology` as `standalone`, `rider`, `group`, or
   `bundle_component` only from official relationship evidence.
3. Inventory the complete responsibility chapter before writing profiles,
   cards, or formulas.
4. Accept an annuity responsibility only when exact evidence proves a payout
   start/eligibility condition, the insured's required survival state, and an
   insurer payment obligation.
5. Apply the annuity profile in the contract. Preserve start, frequency,
   duration, each amount formula, guarantee, remainder payment, death/maturity
   responsibilities, payout choices, growth rules, and termination.
6. Keep mutually exclusive payout methods as formula branches unless the source
   creates independently headed obligations with distinct triggers and effects.
7. Put account settlement, dividends, surrender/cash value, loans, conversion
   rights, and other non-payment functions in `productFunctions`; never count
   them as annuity responsibilities by themselves.
8. Run the existing canonicalizer and validator, then the dedicated importer
   dry-run. After any separately authorized publication, compare the artifact,
   cards, nested indicators, indicator-table payloads, and customer summary on
   the same digest.
9. Write unresolved source, topology, split, formula, guarantee, or projection
   gaps to a handoff. Never fill a gap by analogy.

## Required annuity semantics

- Preserve payout start by exact date, age, policy anniversary, elapsed policy
  years, application condition, or account-value threshold.
- Preserve `annual`, `monthly`, installment, lump-sum, or other source-defined
  frequency and the complete payout period or lifetime boundary.
- Preserve the insured-survival condition for every scheduled payment.
- Preserve guarantee periods, remaining guaranteed annuity, refund-of-premium
  or account-value death benefits, maturity benefits, and exact termination.
- Preserve bases including basic insured amount, annual/paid premium, account
  value, cash value, accumulated paid annuity, and contract-defined terms.
- Preserve `requiredInputs`, condition `branches`, literal max/min `operands`,
  and arithmetic or geometric increase/decrease rules without flattening them.

## Verification resources

Validate the focused fixtures:

```bash
python3 scripts/validate_fixtures.py fixtures
```

Run the bounded SSD audit:

```bash
python3 scripts/forward_test_readonly.py \
  --db /absolute/path/policy-ocr.sqlite \
  --output-dir /absolute/path/empty-output-directory \
  --sample-size 24
```

The forward test opens SQLite with `mode=ro`, enables `query_only`, writes only
the requested manifest/audit/report files, and never calls a model, network,
importer write, or publisher.
