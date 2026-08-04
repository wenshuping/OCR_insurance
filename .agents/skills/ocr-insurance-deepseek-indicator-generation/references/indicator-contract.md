# DeepSeek Indicator Contract

## Output Scope

The product identity and official responsibility inventory are immutable input.
DeepSeek may propose structured indicators only for those responsibility IDs.
It may not add or remove official responsibilities.

Each product output must retain:

- `company`, `productName`, `sourceUrl`, and `sourceDigest`;
- the immutable manifest and inventory identifiers;
- the actual `provider` and `modelId`.

Each responsibility must retain:

- stable `responsibilityId`, official title, liability, parent/branch relation,
  and applicable optional or mutually-exclusive group;
- one or more indicators when official evidence supports distinct measures;
- exact evidence segments with page, start offset, end offset, and verbatim text.

Each indicator must contain, where applicable:

```text
indicatorId
indicatorName
status
basis
basisKey
calculationKey
calculationStatus
formulaText
normalizedFormula
requiredInputs
operands
branches
evidenceSegments
```

Use explicit `not_present_in_source`, `not_quantitative`, `needs_claim_facts`, or
another repository-supported status when the official source does not provide a
computable value. Do not invent a number, formula, date, rate, input, branch, or
source excerpt.

## Semantic Rules

- Preserve all official numeric tokens and formula alternatives.
- Preserve legitimate multiple indicators; never collapse them because an old
  record has only one indicator.
- Do not duplicate one combined death/total-disability payment merely because
  the clause lists both insured events.
- Keep different payment amounts, disease tiers, reimbursement limits, repeated
  benefits, or mutually exclusive alternatives structurally distinct when the
  official terms do.
- Keep formula branches and their operands under the indicator they calculate.
- `normalizedFormula`, `requiredInputs`, `operands`, and `branches` must be
  derivable from `formulaText` and exact evidence.
- Shared waiting periods, definitions, and exclusions may constrain an
  indicator but are not standalone responsibilities.

## Acceptance Invariants

Approval requires all of the following:

```text
official inventory responsibility IDs == artifact responsibility IDs
artifact indicator IDs == nested card indicator IDs == indicator record IDs
sourceDigest == SHA256(official PDF)
every excerpt == exact official text slice at recorded offsets
formula and branch fields survive canonicalization and importer dry-run
terminal union == manifest
terminal intersections == 0
```

For later materialization, strict readback must additionally prove formula,
evidence, source, multi-indicator, parent/branch, duplicate, and orphan fields
without loss. That write gate belongs to the IMPORT lane, not this Skill.

## Failure Routing

| Failure | Route |
|---|---|
| Provider auth, billing, rate-limit, timeout, upstream, transport | `model_retry` |
| Unsafe or irreparable JSON | `model_retry` |
| Exact evidence or schema gate | `validation_review` |
| Missing responsibility chapter, page, or table | `source_retry` |
| Incomplete or ambiguous official inventory | `inventory_review` |
| Competing nonempty digest | `version_conflict` |
| Manifest/output identity mismatch | `identity_blocked` |

Never convert one failure class into another to improve pass rate.
