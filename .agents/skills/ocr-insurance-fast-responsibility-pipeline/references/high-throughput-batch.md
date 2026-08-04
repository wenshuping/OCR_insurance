# High-Throughput Responsibility Batch

Use this profile to reproduce the earlier multi-window throughput without
weakening source or validation gates.

## Success Criteria

- process only immutable, disjoint manifests;
- keep SQLite and Feishu read-only during extraction;
- count validated approvals, review packets, and failures separately;
- sustain the selected online concurrency without repeated 429 or 503 errors;
- keep local shadow latency outside the main-path completion time;
- resume only failed layers and never rerun approved products.

## Preconditions

1. Resolve the repository root and validated batch runner. In the current
   development layout the runner is:

   ```text
   .worktrees/dev-agent-semantic-integration/.agents/skills/ocr-insurance-product-responsibility-pipeline/scripts/batch_deepseek_backfill.py
   ```

2. Require a configured provider API key without printing it.
3. For a local OpenAI-compatible assistant, verify `/v1/models` before the run.
4. Use `--parse-only`. Do not publish during parallel extraction.
5. Prefer existing `source_ready` text and source-digest cache entries. Keep
   source acquisition, screenshot OCR, and source repair in separate queues.

Stop before paid model work when manifests overlap, the provider key is absent,
or the requested output directory already contains an unfinished unrelated run.

## Concurrency Profiles

| Profile | Lanes | Active batches per lane | Online workers per batch | Global online requests |
| --- | ---: | ---: | ---: | ---: |
| `pilot-4` | 1 | 1 | 4 | 4 |
| `balanced-12` | 3 | 1 | 4 | 12 |
| `legacy-24` | 3 | 2 | 4 | 24 |

Start a new provider or model with `pilot-4` on 20 source-ready products. Use
`balanced-12` after the pilot has no systemic authentication, billing,
rate-limit, schema, or upstream failure. Do not use `legacy-24` until a
100-product `balanced-12` batch demonstrates quota headroom and stable approval
quality.

The earlier three-window run used the equivalent of `legacy-24`. Fast 402, 403,
429, and upstream failures are not successful throughput.

Roll out `balanced-12` in two steps:

1. canary: three lanes with 20 disjoint products per lane, 60 total;
2. full batch: after the canary has no systemic 429/5xx failures, three lanes
   with 100 disjoint products per lane.

Stop the remaining lanes when one canary lane shows a systemic provider failure.
Keep completed products immutable and resume only the affected failure layer.

### Spend-Based 429 Recovery

`GEMINI_SPEND_RATE_STOP` is a shared pause receipt, not a permanent lock. When
it exists, all lanes remain read-only until a coordinator performs one
single-product recovery canary. Preserve the receipt, move it atomically to a
temporary `*.pending-canary` path, select one uncompleted
`route=standard_gemini` product, and run the existing batch runner with one
worker, zero repair rounds, parse-only, and no shadow. The canary must pass the
same validator used by the batch.

On another spend-based `429`, restore the stop receipt and do not start any
lane. On a successful validated canary, archive the receipt with a recovery
record and start each disjoint lane in a new immutable output directory. Do
not delete the marker, reuse a stopped output directory, or count the canary
twice. This prevents a single historical 429 from blocking all later work
while still preventing blind quota retries.

## Dual-Pool Model Allocation

For a mixed run, keep Gemini and Luna in separate, disjoint manifests instead
of switching models inside one worker loop. The coordinator should create:

```text
run-root/
  standard-gemini/manifest-*.json
  standard-gemini/run/
  complex-luna/manifest-*.json
  complex-luna/run/
  routing-report.json
```

Use Gemini Flash as the default standard pool, but route medical and
critical-illness product categories directly to Luna. Other category words such
as annuity, participating, universal, or endowment are hints only and must not
route a product by themselves. Route explicit previous-review products and
products with one strong structural signal (repeated claims, disease-group
intervals, or numeric benefit tables) to Luna. For other products, require at
least two independent signals in the responsibility evidence, such as a
scheduled cashflow plus annual/monthly options. Keep simple single-branch
non-health products in Gemini and escalate a bounded validator failure to Luna.
Do not count a product as processed twice because it appears in a retry or
verifier queue.

The Luna pool is a high-capability role, not a hard-coded provider contract.
It requires an explicit `provider`, `model`, and callable `baseUrl`/runner. A
Codex-only Luna client cannot be passed as `--provider=gemini` or silently
substituted into the Gemini endpoint. When no callable Luna endpoint exists,
leave the complex products in a `luna-pending` manifest and continue the
standard Gemini pool; do not fabricate shadow or Luna receipts.

Start Luna conservatively with `workers=2` for a 20-product canary. Promote to
four workers only after the canary has no systemic authentication, billing,
429/5xx, malformed-schema, or timeout failure and its validator approval rate
does not regress against the same-category Gemini benchmark. Keep Gemini at the
measured `balanced-12` capacity independently. Local DianJin shadow capacity is
separate and must never consume or block either online pool.

For each dual-pool run, report separately and in aggregate:

```text
route
provider
modelId
selected
approved
validationReview
modelFailures
sourceFailures
elapsedSeconds
validatedProductsPerHour
estimatedInputTokens
estimatedOutputTokens
estimatedCost
```

Do not decide that Luna should replace Gemini from one or two products. Use a
same-source 20-product canary, compare responsibility recall, validator pass
rate, material formula/table omissions, p50/p95 latency, and cost per approved
product. Existing approved Gemini artifacts remain immutable; only failed or
explicitly selected complex products enter the Luna pool.

When changing routing while windows are active, let in-flight products finish
and stop at the current batch boundary. Do not kill active model requests or
reuse their unfinished output directory. Write a new immutable manifest and
run directory for the next pool.

## Manifest Layout

Use batches of 100 products. Split products deterministically and assign each
manifest to exactly one lane:

```text
run-root/
  lane-1/manifests/batch-001.json
  lane-1/runs/batch-001/
  lane-2/manifests/batch-001.json
  lane-2/runs/batch-001/
  lane-3/manifests/batch-001.json
  lane-3/runs/batch-001/
```

Keep each output directory immutable after completion. A retry writes to a new
run directory and references the original failure receipt.

## First-Pass Command

Run one command per active lane. Substitute absolute paths and the selected
replaceable provider:

```bash
python3 "$RUNNER" \
  --db-path="$POLICY_OCR_APP_DB_PATH" \
  --env-file="$REPO/.env.local" \
  --manifest="$MANIFEST" \
  --output-dir="$OUTPUT_DIR" \
  --provider=gemini \
  --model=gemini-flash-latest \
  --workers=4 \
  --repair-rounds=0 \
  --shadow-base-url=http://127.0.0.1:18080/v1 \
  --shadow-model=DianJin-R1-32B \
  --shadow-routing=auto \
  --parse-only
```

Provider and model IDs are examples, not workflow dependencies. Replace them
with configured, measured values. If the local endpoint is unavailable, omit
both shadow endpoint arguments and continue the online first pass.

Run only one batch at a time in each `balanced-12` lane. A coordinator may use
three subagents, one per lane. Each subagent owns its lane and must not edit
code, `.env.local`, SQLite, another lane, or a completed batch.

## Main-Path Rules

1. Send one bounded extraction request per product on the first pass.
2. Start local formula and risk-signal shadow work only for products selected by
   deterministic complexity routing.
3. Never wait for a local result after the online artifact passes deterministic
   gates.
4. Auto-merge aligned formula branches programmatically.
5. Normalize semantically equivalent numeric forms before comparison, including
   Chinese numerals, Arabic numerals, `百分之十`, and `10%`.
6. Include structured formula fields and `importantLimits` when checking numeric
   coverage. Do not use customer prose as formula evidence.
7. Reject generic headings such as `保险责任` when they do not match the locked
   official responsibility inventory.
8. Do not escalate merely because the validated artifact has more
   source-grounded branches than the local candidate. Escalate when the official
   source supports a material branch, operand, limit, or constraint missing from
   the artifact.
9. Emit a minimal high-capability review packet only for material,
   evidence-grounded conflicts.
10. Do not call a high-capability reviewer for aligned products, source failures,
   transport failures, or malformed OCR.

The local server's measured concurrency is independent of online concurrency.
For a two-sequence local server, allow at most two active generations; excess
shadow jobs may queue or become late audit metadata. They cannot restart or
invalidate completed online work.

For a measured four-sequence server, keep at most four active local generations.
When a whole-product shadow response ends with `finish_reason=length`, produces
malformed JSON, or covers more than four locked responsibilities, move it to the
offline packet queue after online approval. Use:

```bash
python3 "$REPO/.agents/skills/ocr-insurance-fast-responsibility-pipeline/scripts/run_packetized_shadow.py" \
  --artifact="$APPROVED_ARTIFACT" \
  --batch-runner="$RUNNER" \
  --output-dir="$PACKET_OUTPUT_DIR" \
  --base-url=http://127.0.0.1:18080/v1 \
  --model="$LOCAL_MODEL_ID" \
  --packet-size=1 \
  --workers=4 \
  --timeout-ms=90000 \
  --max-tokens=768
```

Use one responsibility per packet for verbose reasoning models; increase to two
or three only after the pinned benchmark has no length truncation. The script
uses the approved responsibility IDs as the immutable inventory. Each packet
must return every assigned ID exactly once. Merge packet outputs
deterministically; never spend an online merge-model call on packet assembly.
For a 12-20 product promotion canary, run the sibling
`scripts/run_packetized_shadow_canary.py` against an immutable manifest of final
approved artifact paths. It resumes completed products and reports packet JSON
validity, responsibility coverage, timeouts, OOMs, and comparison outcomes.
Promote the measured serving profile only when packet valid-JSON rate is at
least 98%, locked-ID coverage is 100%, and there are no timeouts or OOMs.
Keep successful packet receipts immutable and retry only missing or malformed
packets.

For branch-count comparison, count distinct formula outputs before escalating.
Trigger-only variants such as death versus total disability are not additional
calculation branches when their formula output is identical. Preserve a review
when the official source contains numeric table rows that the approved artifact
did not structure; route that case to deterministic table repair.

For table-only conflicts, aggregate immutable `artifactPath` and
`comparisonPath` pairs into a JSONL queue, then run:

```bash
python3 "$REPO/.agents/skills/ocr-insurance-fast-responsibility-pipeline/scripts/run_review_table_repair_pipeline.py" \
  --review-queue="$REVIEW_REQUIRED_JSONL" \
  --output-dir="$REPAIR_OUTPUT_DIR"
```

Run this after the online lanes complete; it does not consume online or local
model capacity. Continue toward publication only from `ready-for-import.jsonl`.
Keep `source-repair-required.jsonl`, `unhandled-review.jsonl`, validator
failures, and importer dry-run failures as separate retry layers.

## Selective Retry

After all first-pass lanes finish, aggregate queues by failure layer:

- `model-retry.jsonl`: retry only transport, provider, billing, rate-limit, or
  malformed-model-output failures with an explicitly selected provider;
- `source-retry.jsonl`: run official-source acquisition or screenshot OCR;
- `validation-review.jsonl`: repair only the failed responsibility or field;
- `high-capability-review.jsonl`: send only the conflicting responsibility,
  exact official evidence window, validated online artifact, and validated
  local candidate to the configured reviewer.

Use `--retry-failure-layer` and `--retry-failure-class` when supported by the
runner. A retry may use `repair-rounds=1`; never restore repeated repair for the
whole first-pass batch.

## Throughput Report

For each lane and the aggregate, report:

```text
selected
approved
manualReview
skipped
modelFailures
sourceFailures
validationFailures
highCapabilityReview
elapsedSeconds
validatedProductsPerHour
onlineConcurrency
shadowRouted
shadowCompleted
shadowLateOrFailed
provider
modelId
route
```

Estimate capacity from `validatedProductsPerHour`, not average latency alone.
At 82 seconds per online request, 12 continuously occupied online workers have a
theoretical ceiling of about 526 products per hour before retries and quota
effects. A 1,000-product target therefore needs roughly two hours at that
latency and concurrency.
