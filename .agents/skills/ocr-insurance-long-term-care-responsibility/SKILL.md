---
name: ocr-insurance-long-term-care-responsibility
description: Parse, repair, review, and audit exact-version Chinese long-term-care, nursing-care, and disability-income insurance responsibilities. Use for standalone, rider, group, or filed bundle-component products involving care-state definitions, ADL or cognitive-impairment triggers, disease or accident causation, observation or waiting periods, lump-sum or periodic benefits, benefit periods and limits, reassessment and termination, related death/waiver/medical duties, formulas, cards, indicators, or read-only SSD forward tests.
---

# Long-Term-Care Responsibility Parsing

Read [references/contract.md](references/contract.md) before producing or
reviewing an artifact, card, indicator, formula, or customer summary.

## Safety Boundary

- Lock one exact `company + productName + sourceDigest`. Use only the approved
  artifact and its same-digest official source, cards, and indicators.
- Treat different digests as different versions. Do not infer from a product
  name, another insurer, a rider's main contract, or a similar product.
- Keep parse-only and audit work read-only. Do not write SQLite, Feishu,
  published data, `.env.local`, or call a model or network.
- Put any company/product exception only in a focused fixture. Do not change the
  production parser for a single product.
- Missing or conflicting official evidence is `review`, never a guessed value.

## Workflow

1. Build an exact-key manifest and reject version or duplicate ambiguity.
2. Prove `standalone`, `rider`, `group`, or `bundle_component` topology from
   official relationship evidence.
3. Inventory the entire responsibility chapter before extracting fields.
4. Classify each block as responsibility, care-state definition, disease or
   medical definition, exclusion, shared rule, medical note, assessment or
   claims process, or group heading.
5. Accept only a covered trigger plus an insurer payment, waiver, reimbursement,
   or other contractual obligation.
6. Preserve care-state trigger, ADL item/count threshold, cognitive evidence,
   continuous-state or observation period, waiting period, disease/accident
   causation, benefit cadence, formula, period/count/limit, reassessment, and
   termination.
7. Keep lump-sum and periodic obligations separate only when the official source
   gives each an independent heading and obligation. Keep formula branches inside
   one responsibility.
8. Keep death, waiver, and medical reimbursement duties as independent sibling
   responsibilities when the source does. Record their exact relationship; never
   present care cash benefits as reimbursement of medical expenses.
9. Run the existing canonicalizer, validator, and dedicated importer dry-run.
   Model or runner success is not approval.
10. Compare stable IDs, formulas, `requiredInputs`, `operands`, `branches`,
    source URL/digest, cards, nested indicators, and indicator-table payloads.

## Non-Negotiable Distinctions

- A care-state, ADL, cognitive-impairment, disease, or disability definition is
  supporting evidence, not a responsibility by itself.
- Medical explanation and claims/assessment procedure do not prove an insurer
  obligation.
- Do not decide whether a customer is disabled, cognitively impaired, or
  eligible. Extract only the contractual test and required evidence.
- Do not treat exclusions as negative responsibilities.
- Do not convert a fixed or periodic care benefit into `medical_expense`
  reimbursement. Reimbursement requires actual eligible expense and an explicit
  reimbursement obligation.
- Leave unsupported topology, thresholds, periods, amounts, or relationships
  empty and route them to `review`.

## Resources

Validate the generic fixtures:

```bash
python3 scripts/validate_fixtures.py fixtures
```

Run an explicit offline read-only SSD audit:

```bash
python3 scripts/forward_test_readonly.py \
  --db /absolute/path/policy-ocr.sqlite \
  --output /absolute/path/forward-test.json \
  --sample-size 24
```

The forward test opens SQLite with `mode=ro`, enables `query_only`, uses only
approved exact-digest artifact/card/indicator layers, and writes only the
requested JSON report.

## Completion Gate

Return `approved` only after exact source, inventory, bounded evidence, formula,
canonicalizer, validator, importer dry-run, and exact projection readback all
pass. Otherwise use `source_review`, `validation_review`, or
`materializer_blocked` and list the missing evidence or mismatch. `not_run`
never means passed.
