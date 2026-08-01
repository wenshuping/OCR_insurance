---
name: ocr-insurance-accident-responsibility
description: Parse, repair, and audit source-backed accident-insurance responsibilities, formulas, contract topology, customer cards, and indicators. Use for standalone, rider, group, or filed bundle-component accident products involving accidental death or disability, disability-grade tables, accident medical reimbursement, hospital allowance, transport or aviation extra benefits, occupation/member conditions, exclusions, or false responsibility headings.
---

# Accident Responsibility Parsing

Read [references/contract.md](references/contract.md) before parsing, repairing,
validating, dry-running, or reviewing an accident product.

## Safety boundary

- Lock one exact `company + productName + sourceDigest`. Resolve identity in the
  order `sourceDigest -> inventory -> bounded evidence packet`; never classify
  from a product name.
- Use only an approved artifact, its same-digest official evidence, and
  same-digest card/indicator projections. Treat an absent or conflicting source
  as `review`, never as permission to infer.
- Keep SQLite, Feishu, network, model, publication, and `.env.local` writes off
  unless separately authorized. A parse-only or audit task remains read-only.
- Do not change the production parser to accommodate one insurer or product.
  Put real exceptions only in fixtures or the run audit.

## Workflow

1. Build an exact-key manifest and reject cross-version or duplicate ambiguity.
2. Determine `contractTopology` from official relationship evidence:
   `standalone`, `rider`, `group`, or `bundle_component`.
3. Inventory the complete responsibility chapter before writing cards or
   formulas. Bound each responsibility packet with its trigger, causation,
   obligation, limits, directly applicable definitions/tables, and termination
   language.
4. Apply the accident profile in the contract. Keep definitions, disability
   schedules, exclusions, occupation/risk notes, and claims procedures out of
   responsibility counts.
5. Preserve formulas, branches, inputs, base/additional-benefit relationships,
   and additive versus replacement semantics.
6. Run the existing canonicalizer and validator, then the dedicated importer
   dry-run. A runner/model result is not approval.
7. Read back the artifact, card, nested indicators, indicator-table payload,
   and customer summary on the same digest. Stop at `review` on any mismatch.

## Required accident semantics

- Treat the accident definition as trigger/causation evidence, not a
  responsibility by itself.
- Keep accidental death, disability, medical reimbursement, hospital
  allowance, and independently headed scenario benefits separate.
- Attach a disability-grade schedule to the disability responsibility as an
  indicator/table rule. Do not create one responsibility per grade or table
  row.
- Preserve accident causation, covered-time boundary, deductible, reimbursement
  ratio, daily amount, day/count limit, waiting period, exclusion, and
  responsibility termination.
- For transport or aviation extra benefits, preserve the base responsibility ID
  and whether the clause is additive, substitutive, exclusive, or capped.
- For a rider, preserve main-contract dependency, effective/termination linkage,
  and the exact source of the insured amount. For a group contract, preserve
  membership/exit rules and plan tier. For a student bundle, first split the
  actual filed components; each concrete accident responsibility still uses
  this accident profile.

## Outputs and gates

Produce:

- exact-key manifest and bounded evidence packets;
- unified artifact with topology, responsibilities, indicators, relationships,
  audit matrix, and customer cards;
- canonicalizer, validator, and importer dry-run receipts;
- same-digest card/indicator/customer-summary readback;
- a handoff containing unresolved source, topology, formula, or projection
  gaps. Never fill a missing field by analogy.

Use [scripts/validate_fixtures.py](scripts/validate_fixtures.py) to check the
focused fixtures. Use
[scripts/forward_test_readonly.py](scripts/forward_test_readonly.py) only for an
explicit offline read-only SQLite audit; it opens the database with
`mode=ro`, sets `query_only`, writes reports only to the requested output
directory, and never invokes a model, network, importer write, or publisher.
