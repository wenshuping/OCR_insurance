# Responsibility Extraction Contract

Use this contract after official-source acquisition and before formula routing.
The purpose of model extraction is to propose structured facts from bounded
official evidence. It does not decide the final responsibility inventory or
write final evidence.

## 1. Build A Source Index

Normalize the extracted source without changing its wording. Preserve:

- `sourceDigest`, product/version identity, page number, and absolute character
  offsets;
- heading text and heading level;
- paragraph and table boundaries;
- page continuation links;
- references from a responsibility to definitions, formula tables, and shared
  rules.

Keep both raw page text and a normalized search view. Offset validation always
uses the raw official text.

Detect duplicated extraction layers and broken multi-column reading order.
Choose the coherent body occurrence that contains the obligation and complete
continuation flow; do not count repeated text-layer copies as additional
responsibilities.

When a source contains both plain extraction and layout-preserving extraction,
build one canonical view from one layer and retain page-to-raw-source mappings.
Never choose one responsibility's start from the layout layer and its next
boundary from the plain layer. Before model work, require each primary packet to
contain exactly one same-level responsibility heading; a foreign same-level
heading is a source-index failure.

Detect and label, but do not delete:

```text
responsibility_heading
shared_rule
definition
formula_table
exclusion
claim_procedure
table_of_contents
other
```

Table-of-contents lines often duplicate real responsibility titles. A title is
not accepted from the contents page unless a later body section with an insurer
obligation is found.

## 2. Inventory Pass

Run inventory before customer or calculation extraction.

Build a deterministic heading candidate list from section numbers and obligation
anchors such as `给付`, `赔付`, `补偿`, `报销`, `豁免`, and `领取`. Give one bounded
responsibility-chapter packet to the inventory model only when deterministic
heading analysis cannot finalize the list.

Inventory output is a proposal with this logical shape:

```json
{
  "sourceDigest": "sha256",
  "responsibilities": [
    {
      "responsibilityId": "stable-section-id",
      "sectionNumber": "1.4.1",
      "officialTitle": "重大疾病保险金",
      "headingStart": 1200,
      "clauseStart": 1200,
      "clauseEnd": 1820,
      "continuationRanges": [],
      "referencedEvidenceIds": []
    }
  ],
  "sharedClauses": [
    {
      "evidenceId": "shared-waiting-period",
      "kind": "waiting_period",
      "start": 800,
      "end": 1050,
      "appliesTo": ["stable-section-id"]
    }
  ],
  "rejectedHeadings": [
    {
      "text": "保险责任",
      "reason": "chapter heading, not an insurer obligation"
    }
  ]
}
```

Accept an inventory item only when:

- the title occurs at the proposed heading offset or is recoverable from
  adjacent heading fragments with exact component spans;
- its body contains or directly references a covered condition and insurer
  obligation;
- the range ends at the next same-or-higher-level heading, including proven
  continuation text;
- it is not a contents entry, definition, exclusion, procedure, or fragment;
- separately named official responsibilities remain separate;
- subgroups, age tiers, formula branches, and disease lists under one official
  title remain inside one responsibility.

When PDF layout truncates a body heading, an exact same-section-number title
from the official contents page may repair the title only. Preserve separate
title-evidence offsets and require the body section to prove the trigger and
obligation. Never use a contents title to create a responsibility whose body is
missing.

Assign stable IDs from source digest plus official section number or heading
offset. Never use array position as identity.

## 3. Build One Evidence Packet Per Responsibility

After inventory validation, construct packets programmatically. Each packet
contains:

1. exact product/version identity and source digest;
2. one responsibility's complete official section;
3. its continuation ranges;
4. only shared clauses explicitly applicable to it;
5. only definitions and tables directly referenced by it;
6. raw offsets for every included range.

Do not include unrelated responsibilities, the full definitions chapter, the
full exclusions chapter, surrender/cash-value prose, or marketing content.

Aim to keep a packet below 12,000 Unicode characters. This is an operational
target, not permission to truncate. If a packet is larger:

- retain the complete primary responsibility section;
- split referenced definitions or tables into labeled attachments;
- split at child-heading or table boundaries;
- repeat the responsibility ID and source digest in every part;
- never split a formula row, condition/result pair, or negation from its target.

## 4. Parallel Proposal Passes

Run bounded proposal tasks after the inventory is locked. Pack several small
responsibilities into one request only when every item retains its stable ID and
offset ranges.

### `coverage-facts`

Extract:

- covered event or condition;
- insurer payment, reimbursement, waiver, or benefit obligation;
- waiting-period consequence;
- payment count, interval, cap, mutual exclusion, deduction, and termination
  effect;
- exact span references for every fact.

Do not write customer prose in this pass.

### `calculation-structure`

Extract:

- formula branches in source order;
- each branch condition and result;
- operands and `max`/`min` operators;
- percentages, multiples, fixed amounts, ages, days, counts, and boundaries;
- table headers, rows, and merged-cell scope;
- canonical required-input proposals.

Represent every table row as cells with its header path. Never flatten a table
into pipe-delimited prose. If row/column ownership is uncertain, return
`source_repair_required`.

### `customer-wording`

Generate concise customer-facing wording only from the validated inventory,
coverage facts, and calculation structure. Do not give this task raw unrelated
document text. It may simplify language but must retain all material limits and
must not add facts.

All proposal tasks are read-only. A proposal must identify each output by
`responsibilityId`; title-only matching is insufficient.

## 5. Exact-Span Validation

For every proposed fact, require:

```text
sourceDigest
startOffset
endOffset
exactText
```

Accept it only when:

```text
officialRawText.slice(startOffset, endOffset) == exactText
```

Normalize whitespace only after this comparison. Reject a proposal that:

- paraphrases its evidence;
- points to another product or responsibility;
- cites a title without the supporting obligation;
- omits a number, negation, comparison operator, or inclusive/exclusive
  boundary;
- combines non-contiguous spans into a fabricated quote.

Exact slicing proves quotation integrity, not semantic coverage. For each
formula branch, also require every declared numeric token, age/day/count
boundary, and operator to occur in that branch's accepted evidence spans.
Evidence that contains only the payout percentage does not prove an age or
interval condition. Expand evidence deterministically or route that
responsibility to verification.

Final `sourceExcerpt` and evidence segments are regenerated from accepted
official offsets, never copied from model output.

## 6. Shared-Clause Applicability

Build an explicit applicability map for waiting periods, aggregate limits,
payment-order rules, mutual exclusions, main/rider restrictions, and
termination rules.

Use deterministic references and scope wording first. A model may propose an
applicability link, but the link is accepted only when the shared clause names
the responsibility, a containing group, or an unambiguous all-responsibilities
scope.

Do not attach a general waiting-period refund to accident branches when the
clause excludes accidents. Do not create a shared clause as an independent
responsibility.

## 7. Validation And Retry

Validate each responsibility independently:

- inventory identity and range;
- exact-span coverage;
- branch and table-row count;
- all numeric and boundary tokens;
- canonical inputs;
- customer wording derived only from validated facts.

Retry only the failed responsibility and failed proposal task.

- A transient transport/provider error may retry the same request with bounded
  backoff.
- Malformed JSON may retry once with the same evidence and a stricter schema.
- A semantic failure must change the evidence packet, parser, or model role; do
  not repeat the unchanged prompt.
- A missing page, truncated clause, unreadable number, or damaged table routes
  to source repair.

Do not rerun successful responsibilities because another packet failed.

## 8. Extraction Completion Record

Record:

- official inventory count;
- packet count and largest packet size;
- responsibilities extracted on first pass;
- per-task retries and transient failures;
- exact-span acceptance/rejection counts;
- table/source-repair count;
- unresolved shared-clause links;
- provider, model ID, latency, and token usage for each proposal role;
- deterministic versus verifier routing outcome per responsibility.
