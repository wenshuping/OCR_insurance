# Legacy Indicator Safe-Reuse Decision Contract

## Decision Matrix

| Gate | exact_reuse | missing_only | fresh_parse | hold |
|---|---|---|---|---|
| Official PDF and nonempty digest | required | required | required | source_reacquire if absent |
| Complete official inventory | required | required | required before model | inventory_review if uncertain |
| Competing nonempty digest | forbidden | forbidden | forbidden | version_conflict |
| Legacy inventory equals official inventory | required | bounded gaps allowed | not required | - |
| Evidence exact in official text | required for reused fields | required for reused fields | model proposals must revalidate | review if unreadable |
| Formula and structured fields complete | required for reused fields | missing fields become bounded targets | parse from official packet | materializer review after persistence loss |
| Duplicate/orphan legacy rows | forbidden | may identify a bounded cleanup target | ignore legacy values | review if authority is unclear |

## Exact-Reuse Field Contract

Require source support and deterministic equality for every reused field that is
present:

```text
responsibilityId
parentResponsibilityId
indicatorId
title / liability
formulaText
normalizedFormula
basisKey
calculationKey
calculationStatus
calculationEligible
requiredInputs
operands
branches
evidenceSegments / sourceExcerpt / sourcePage
sourceUrl / sourceDigest / provenance
optional and mutually-exclusive branch metadata
```

Do not synthesize an omitted field solely to make equality pass. A field required
by the canonical schema but absent from legacy data is a missing-only target or a
fresh-parse reason.

## Model Input Boundary

Allowed:

- official source excerpt and offsets;
- locked official responsibility title and stable target ID;
- official shared clauses and referenced tables;
- the names of fields that failed deterministic gates;
- prior validator failure pointers that do not contain proposed business values.

Forbidden:

- legacy amount, percentage, limit, formula, branch, or summary as proposed
  truth;
- legacy responsibility titles not present in the official inventory;
- legacy values from a different or missing digest;
- count equality as proof of completeness.

## Merge Boundary

Merge by stable missing target only. Preserve immutable exact-reuse targets.
Reject unknown responsibility IDs, duplicate proposals, cross-product IDs, and
proposals whose evidence is not an exact official substring. Regenerate final
evidence from official text after merging.

## Persistence Boundary

Use authoritative-only materialization. Retain knowledge records as context but
do not allow knowledge-derived, optional-alias, or sentence-fragment rows to
create cards outside the approved artifact. Preserve all legitimate nested
indicators under their reviewed responsibility parent.

If formal import loses structured fields or produces extra/missing cards or
indicators, restore the batch backup and route the product to
`materializer_blocked`. Do not use ad hoc SQL or delete legacy rows to force a
pass.
