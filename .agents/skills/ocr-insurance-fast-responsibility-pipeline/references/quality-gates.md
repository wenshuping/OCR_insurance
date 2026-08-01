# Responsibility Quality Gates

## Source Gate

- Manifest status is `source_ready`.
- Official host and exact product/version are proven.
- Original source digest and complete extracted text exist.
- Responsibility chapter, referenced tables, and continuation pages are present.

## Inventory Gate

- Build the official title checklist independently from model branches.
- Do not count waiting periods, exclusions, group headings, or formula branches as
  independent responsibilities unless the contract names a distinct obligation.
- Do not merge independently named staged or optional benefits.

## Extraction Gate

- Lock inventory and section boundaries before facts, formulas, or customer
  wording.
- Build boundaries from one coherent extraction layer; fail a packet containing
  another same-level responsibility heading.
- Identify every proposal by stable responsibility ID, source digest, and exact
  offsets.
- Give each responsibility only its section, continuations, applicable shared
  clauses, and directly referenced definitions/tables.
- Require formula branch count and table-row count to match official evidence.
- Require every numeric token and boundary in a formula branch to occur in that
  branch's own evidence, not merely elsewhere in the responsibility packet.
- Represent tables as header-aware cells, never flattened pipe-delimited prose.
- Generate customer wording only from validated structured facts.
- Retry only the failed task and responsibility packet.

## Local Candidate Assistant Gate

- Treat local-model output as additive proposals, never as authority to discard
  deterministic evidence.
- Form the online evidence packet from the union of deterministic chapter
  selection, responsibility-heading anchors with adjacent pages, referenced
  pages, and local-model candidates.
- Require `page`, `startOffset`, `endOffset`, and exact `text` for every evidence
  span candidate.
- Drop a span when
  `officialText.slice(startOffset, endOffset) !== text`.
- Continue without the local assistant when its service is unavailable.
- Record provider, model ID, source digest, latency, selected pages, and rejected
  span count.

## Evidence Gate

- Every accepted responsibility has exact official evidence for title, trigger,
  obligation, formula, and limits.
- Every numeric token and inclusive/exclusive boundary appears in evidence.
- A limit in `importantLimits` must be included in the responsibility excerpt or
  a page-specific evidence segment.
- Remove extraction-only markers such as `===== PAGE 4 =====` from final excerpts.

## Calculation Gate

For the simple importer artifact, required inputs must come from this canonical
dictionary:

```text
policy.amount
policy.firstPremium
policy.paymentPeriodYears
cashValue
policyYear
policyScheduleTable
policyYearOrAge
accountValue
actualMedicalExpense
deductible
reimbursementRate
thirdPartyPaid
liabilityLimit
actualDays
dailyAmount
dayLimit
manualFormulaInputs
```

- `basis` names the values used by the formula.
- `manual_formula` has explicit canonical `requiredInputs`.
- When the official formula requires cumulative premiums paid at an event date,
  do not assume `policy.firstPremium × policy.paymentPeriodYears` is exact unless
  payment frequency, level premium, payment completion, and timing make that
  derivation provable. Otherwise use `manualFormulaInputs` and name
  `cumulativePaidPremiumAtEvent` in `calculationReason` or
  `requiredInputDetails`.
- Omit `value` when not computable.
- Preserve every age/policy-year/table branch.
- Preserve each `max`/`min` operand.
- Use `cash_value` as `basisKey` when cash value is a material formula basis and
  `manual_formula` as `calculationKey` when the full expression is unsupported.

## Customer Gate

Customer fields must not contain:

```text
basisKey
calculationKey
requiredInputs
calculationStatus
indicatorCheckStatus
needs_table
指标核对
结构化指标
现金流测算
需表格
```

## Escalation Triggers

Escalate from the first-pass merge model to the configured verifier model when:

- branch responsibility counts or titles disagree;
- the formula branch split differs;
- a field dictionary check fails;
- evidence coverage fails;
- importer dry-run fails;
- source was recovered through screenshot OCR;
- tables span columns or pages;
- optional-package boundaries are disputed.
- one responsibility contains multiple age/policy-year branches with `max` or
  `min` comparisons.
- the local assistant and deterministic inventory disagree on a responsibility
  title or applicable page;
- local evidence candidates fail exact-offset validation.

Escalate from the verifier model to the configured high-capability reviewer when
the same issue remains after one repair, exact-version identity conflicts, or
semantic review still has unsupported numeric claims.

Do not retry the same model repeatedly with unchanged evidence.
