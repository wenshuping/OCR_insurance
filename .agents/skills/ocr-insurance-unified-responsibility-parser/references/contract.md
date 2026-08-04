# Unified Responsibility Orchestration Contract

## 1. Identity and immutable manifest

Use this identity:

```json
{
  "company": "legal insurer name",
  "productName": "exact filed product title",
  "sourceUrl": "official exact-version URL",
  "sourceDigest": "sha256:<64 lowercase hex>"
}
```

Deduplicate candidates in this strict order:

1. identical non-empty `sourceDigest`;
2. otherwise identical normalized official `sourceUrl`;
3. otherwise normalized `company + productName`.

Do not merge different non-empty digests. A same-name or same-URL digest
disagreement is `version_conflict`. Record selected and excluded identities,
dedupe rule, original row ID, and manifest SHA.

The full-backfill contract targets 30,592 products, but every run uses a bounded,
immutable, digest-pinned manifest. Never let a retry mutate a completed manifest.

## 2. Source and inventory gates

Require official identity, `%PDF-` bytes or an equivalent preserved official
source, verified SHA-256, page count, readable complete responsibility text,
and a source contract before parsing.

Build exactly one title inventory per `sourceDigest`. Its ledger contains:

```json
{
  "sourceDigest": "sha256:...",
  "inventoryId": "inventory:<digest>",
  "responsibilities": [
    {
      "responsibilityId": "stable-source-derived-id",
      "officialTitle": "unchanged official title",
      "sectionBoundary": {},
      "evidencePacketId": "packet:<digest>:<responsibilityId>"
    }
  ]
}
```

Downstream Skills may enrich fields but cannot add, remove, rename, split, or
merge inventory items. Send a disputed boundary back to inventory review.

### Trigger conditions do not create responsibilities

Use official headings and insurer obligations to determine responsibility
cardinality. If one heading is `身故或身体全残保险金`,
`身故和身体全残保险金`, or an equivalent combined heading, disease,
accident, waiting-period, age, and payment-period wording are trigger or formula
branches under that one responsibility. They do not create a second
`疾病全残` responsibility or indicator.

Preserve separate items only when the exact-version source gives independent
headings and obligations. For historical projections, suppress a legacy
`疾病全残` alias only when exact evidence ties it to the combined heading and
the rows share the same non-empty `sourceDigest`, or both lack a digest and
share the same normalized official URL. Different non-empty digests are
`version_conflict`, never an automatic merge.

## 3. Ownership invariant

Define the immutable responsibility key as:

```text
sourceDigest + responsibilityId + officialTitle + evidencePacketId
```

Exactly one `ownerProfile` owns that key. A second owner proposal is an
`owner_conflict`; do not run both domain generators or choose by majority.
Route the product to `manual_review` with both proposals and their evidence.

Product labels are many-to-many discovery metadata. They never grant ownership.
Contract topology is product/contract metadata. It never grants ownership.

Primary owner profiles are:

```text
medical_health
critical_illness
accident
term_life
annuity
long_term_care
endowment
whole_life
incremental_whole_life
```

`universal_account` normally supplies product functions, not ownership of
ordinary annuity, death, or maturity responsibilities. It may own only a
separately headed account-based payable obligation proven by exact terms.

## 4. Orthogonal contract topology

Use one source-backed value:

```text
standalone | rider | group | bundle_component
```

- `rider`: preserve main-contract dependency, amount/premium references, and
  effective/termination linkage.
- `group`: preserve member eligibility, entry/exit, and member/shared/tiered
  limit ownership.
- `bundle_component`: map a plan to each exact filed component and digest
  before inventory. Marketing material is discovery only.

Do not create `rider`, `group`, `student`, or `bundle` responsibility parsers.
Apply the owning domain profile inside the topology.

## 5. Payment profiles

Attach reusable calculation/settlement behavior independently of ownership:

```text
lump_sum
medical_reimbursement
daily_allowance
annuity
waiver
account
max_min_comparison
fixed_benefit
scheduled_maturity
periodic_care
disability_table
```

A responsibility may have more than one payment profile when the official
formula composes them, such as `lump_sum + max_min_comparison`. Payment profiles
cannot change the owner.

## 6. Evidence packet and field contract

One packet contains one locked responsibility, its full section, exact
continuations, and only directly applicable shared rules, definitions, tables,
and topology clauses. Every segment has page/offset identity and must be an
exact substring of the source for the same digest.

Required artifact shape:

```json
{
  "responsibilityId": "stable-source-derived-id",
  "officialTitle": "unchanged official title",
  "evidencePacketId": "stable packet id",
  "ownerProfile": "one owner",
  "paymentProfile": ["one or more profiles"],
  "triggerCondition": "source-backed field",
  "insurerObligation": "source-backed field",
  "importantLimits": [],
  "formula": {
    "formulaText": "unchanged source formula",
    "normalizedFormula": "source-equivalent structure",
    "requiredInputs": [],
    "requiredInputDetails": [],
    "operands": [],
    "branches": []
  },
  "evidenceSegments": [],
  "sourceUrl": "official URL",
  "sourceDigest": "sha256:..."
}
```

Use `branches` only for mutually exclusive conditions. Use `operands` only for
literal max/min comparisons. Unknown values remain absent and non-calculable.
Never invent a canonical input to make a formula calculable.

## 7. Model boundary

Models receive the locked identity and bounded packet. They may return field
candidates or one bounded field-level adjudication. They may not:

- change `sourceDigest`, `responsibilityId`, `officialTitle`, or packet identity;
- author, normalize, translate, truncate, or concatenate evidence text;
- change or omit official numbers, boundaries, operators, tables, or negation;
- approve an artifact, write data, or waive a deterministic gate.

Regenerate accepted evidence from official offsets after every model response.
Final authority remains the source/inventory/canonicalizer/validator/importer
and exact-readback gates.

## 8. Deterministic acceptance chain

Run in this order:

```text
official source gate
-> one inventory per sourceDigest
-> one owner per responsibility
-> bounded evidence packet
-> formula/normalizedFormula/requiredInputs/operands/branches
-> canonicalizer
-> validator
-> dedicated importer dry-run
-> exact card + nested indicator + indicator-table readback
```

Approval requires each gate to pass in the current run. Historical `approved`,
model/runner success, equal counts, card presence, importer success, and
`quick_check` do not substitute for a gate.

Readback compares stable IDs, official titles, source URL/digest, formula text,
normalized formula, required inputs, operands, branches, selection state,
topology relationships, payment profiles, and customer wording.
For a combined death/full-disability heading, readback must contain one owning
card and one stable indicator decision; cause-specific disease/accident
conditions must survive as branches rather than sibling indicators.

## 9. Mutually exclusive terminal status

Emit exactly one:

```text
source_pending
source_blocked
version_conflict
parse_pending
validation_review
model_retry
approved
materializer_blocked
import_pending
imported
manual_review
```

Priority:

1. source/version failures;
2. owner conflict or irreducible semantic ambiguity;
3. parse/model failure on its selected route;
4. canonicalizer/validator/importer-dry-run failure;
5. persisted projection mismatch;
6. approved artifact awaiting import;
7. exact imported readback.

`approved` means a release-gated artifact exists but no import is asserted.
`imported` requires an authorized write receipt and exact readback. A read-only
forward test can report alignment but cannot create a fresh `imported` claim.

## 10. Audit outputs

Every run writes:

- `immutable-manifest.json`: selected/excluded identities and dedupe proof;
- `forward-test.json`: per-product gate and alignment findings;
- `routing-audit.json`: owner, payment, topology, DeepSeek/Luna, and conflict
  accounting;
- `handoff.json`: systemic gaps, skipped gates, and next-layer queues;
- `SHA256SUMS`: digest of every final JSON audit file.

The manifest and reports must state that database reads were `mode=ro` and
`query_only=ON`, and whether models, network, importer, SQLite writes, Feishu,
or publication were invoked.
