# Local Candidate Assistant Contract

Use a local text model to reduce online-model cost and latency without granting
it authority over official evidence. The model is replaceable. General small
models and finance-domain reasoning models are deployment candidates, not
workflow dependencies.

## Replaceable Adapter

Configure the assistant by role rather than model name:

```json
{
  "role": "local_candidate_assistant",
  "provider": "autodl",
  "baseUrl": "http://host:port/v1",
  "apiStyle": "openai_chat_completions",
  "modelId": "server-reported-model-id",
  "timeoutMs": 45000,
  "capabilityRoles": [
    "candidate_pages",
    "responsibility_titles",
    "formula_branches",
    "risk_signals"
  ],
  "generation": {
    "temperature": 0,
    "maxTokens": 1024,
    "structuredOutput": "json_schema"
  }
}
```

The caller must support a disabled adapter and treat connection, timeout,
server, context-length, and malformed-JSON failures as non-blocking shadow
outcomes. Preserve the exact endpoint model ID and generation settings in run
metadata. Never infer output handling from names such as `ERNIE`, `DianJin`, or
`R1`.

When a reasoning model emits analysis wrappers or prose, extract only one
explicit JSON object and reject the result if more than one plausible object is
present. Do not repair semantic fields with another model. Enforce the shadow
deadline at the caller; a correct late result remains audit metadata and cannot
delay or restart online extraction.

If a whole-product response is truncated or malformed, do not increase the
output budget blindly. After the online artifact passes deterministic gates,
split its immutable responsibility inventory into one-responsibility packets.
Increase to two or three IDs only after a pinned benchmark has no length
truncation. Include only each responsibility's exact evidence and applicable
shared clauses. Validate every packet independently, require each assigned ID
exactly once, and merge packet arrays programmatically. A missing, duplicate, or
unknown ID fails the packet; the local model never performs the merge.
Cache each valid packet by source digest, artifact responsibility ID, model ID,
schema version, and generation settings. On a partial failure, resume only the
failed packet. A table candidate may trigger deterministic repair only when
every proposed cell is an exact official token and the locked responsibility
already owns the table evidence.

When an OpenAI-compatible endpoint supports structured output, require
`response_format.type = json_schema` with `additionalProperties: false`.
Reasoning models may otherwise spend the complete output budget before reaching
their final JSON. Schema validity does not satisfy semantic or evidence gates.

Treat capability roles independently. A candidate may be promoted for
`formula_branches` or `risk_signals` while remaining disabled for
`responsibility_titles` or `candidate_pages`. Deterministic inventory always
wins: drop waiting periods, exclusions, group headings, and formula branches
that fail the repository responsibility gate even when the local model returns
them as titles. For formula-only assistants, accept output only for stable
responsibility IDs already present in the locked inventory; ignore additional
model-generated titles.

## Input

Provide:

- exact company and product name;
- source digest and source path;
- official extracted text split into page blocks;
- stable document-level character offsets;
- deterministic responsibility-heading and formula anchors.

Do not send images to a text-only local model. Run PDF text extraction or OCR
first.

## Output

Require one JSON object:

```json
{
  "sourceDigest": "sha256:...",
  "modelRun": {
    "role": "local_candidate_assistant",
    "provider": "autodl",
    "modelId": "actual-model-id"
  },
  "candidatePages": [2, 3],
  "responsibilityTitleCandidates": [
    {
      "title": "重大疾病保险金",
      "page": 2
    }
  ],
  "clauseLabels": [
    {
      "page": 3,
      "label": "waiting_period"
    }
  ],
  "evidenceSpanCandidates": [
    {
      "page": 3,
      "startOffset": 1200,
      "endOffset": 1260,
      "text": "必须逐字复制的官方连续原文"
    }
  ],
  "riskSignals": [
    "age_branch",
    "waiting_period",
    "max_formula",
    "mutual_exclusion"
  ]
}
```

Allowed `riskSignals` should be a controlled list maintained by the caller.
Useful initial values are `age_branch`, `policy_year_branch`, `waiting_period`,
`accident_exception`, `max_formula`, `min_formula`, `table_reference`,
`cross_page_continuation`, `optional_package`, and `mutual_exclusion`.

## Deterministic Validation

For every span require:

```text
officialText.slice(startOffset, endOffset) === text
```

Reject spans with ellipses, rewritten punctuation, normalized wording, invalid
offsets, or a page mismatch. Keep rejection counts in run metadata.

## Recall Protection

Build the evidence sent to online models immediately as:

```text
deterministic responsibility chapter
UNION responsibility-heading matches and adjacent pages
UNION referenced definitions, tables, and continuation pages
```

The local model has no exclusion or veto authority. A local miss must not remove
official text from downstream review. When deterministic and local inventories
disagree, retain both and mark the product for verifier review.

## Shadow Execution

Start the online `source-inventory`, `customer-limits`, and `calculation`
branches concurrently with local inference. Do not wait for the local result
before sending the deterministic evidence packet.

When the local result arrives:

- validate offsets and exact text before use;
- attach validated candidates to merge inputs only when merge has not started;
- use material inventory disagreements to trigger verifier review;
- keep late, malformed, or redundant results as audit metadata only;
- never restart completed online extraction solely for a late shadow result.

Record `onlineReadyMs`, `shadowReadyMs`, `shadowJoinedBeforeMerge`, and the
shadow timeout or validation outcome. Main-path latency ends when online
proposals are ready, not when the shadow task finishes.

Do not copy local or online summaries into final `sourceExcerpt`. Generate final
evidence from official text offsets and rerun exact-substring validation.

## Evaluation

Before enabling automatic use, measure on manually approved products:

- responsibility-title recall and precision;
- candidate-page recall against final accepted evidence;
- exact-span validation pass rate;
- numeric and boundary recall;
- valid-JSON rate;
- latency and GPU memory;
- online input-token reduction;
- verifier escalation rate.

### Replacement Test

Compare a candidate model with the current assistant on the exact same
source-digest-pinned packets. Include at least:

- one simple life or annuity product;
- one critical-illness product with light, moderate, and severe benefits;
- one medical product with deductible, reimbursement rate, and limits;
- one product with age or policy-year branches;
- one product with a cross-page table or continuation.

Use deterministic official inventory and final accepted evidence as labels.
Score models independently; do not let either model see the other output.
Record per product and aggregate:

```text
validJsonRate
titleRecall
titlePrecision
candidatePageRecall
exactSpanPassRate
numericBoundaryRecall
p50LatencyMs
p95LatencyMs
peakGpuMemoryMiB
deadlineJoinRate
```

Reject replacement when valid JSON, title recall, candidate-page recall, or
numeric-boundary recall regresses materially. Prefer the candidate only when it
meets all quality floors and improves at least one of latency, GPU memory, or
online input-token reduction. A useful starting floor is `validJsonRate >=
0.98`, `titleRecall >= 0.98`, `candidatePageRecall >= 0.99`, and
`exactSpanPassRate == 1.0`; calibrate these floors from the approved benchmark,
not model self-reports.

### Promotion States

1. `shadow_compare`: run old and candidate assistants asynchronously; neither
   may alter online evidence selection.
2. `shadow_primary`: attach validated candidate output before merge, while
   retaining deterministic recall protection.
3. `active_additive`: allow validated candidates to reduce online input only
   after the benchmark shows no recall loss.

Never allow a local assistant to become evidence authority or final merger.
Rollback means changing adapter configuration to the previous measured model;
no artifact schema or pipeline code should change.

Promotion is per capability role. Keep a model in `shadow_compare` for any role
whose quality floor or deadline-join rate fails, even when another role passes.
