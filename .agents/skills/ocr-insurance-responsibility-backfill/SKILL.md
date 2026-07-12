---
name: ocr-insurance-responsibility-backfill
description: Use when supplementing OCR_insurance insurance product responsibility data from official insurer or regulator sources into local SQLite and Feishu, or when running manual/subagent batches to create product responsibility cards and quantify insurance indicators. Applies to low-coverage insurer crawls, blank or weak responsibility repairs, product_responsibility_cards backfills, insurance_indicator_records review, policy-qa source checks, policy-liability-qa responsibility thresholds, subagent artifact imports, SQLite exact audits, Feishu parity verification, and stuck batch recovery.
---

# OCR Insurance Responsibility Backfill

Use this skill to add or repair insurance product responsibility text in the
OCR_insurance knowledge base, or to review product responsibility cards and
indicator records from official sources.

## Success Criteria

A knowledge-row backfill run is complete only when all of these are true:

- Each accepted row has an official source URL and a concrete product name.
- Responsibility text passes the source gate and responsibility gate below.
- Local SQLite rows are written to the active development database.
- Feishu dry-run, write, post-write dry-run, and readback all pass.
- The run directory contains enough artifacts to reproduce the decision.

A product-responsibility-card run is complete only when all of these are true:

- Each reviewed product has one JSONL artifact row with accepted, rejected, and
  blocker evidence.
- Accepted customer summaries contain only customer-facing responsibility text,
  not internal indicator or calculation audit fields.
- Each accepted responsibility has a matching accepted manual indicator.
- The exact audit passes: artifact accepted liability names equal
  `product_responsibility_cards.title` and accepted
  `insurance_indicator_records.liability` for every product in the batch.
- A SQLite backup exists from before the import.
- Focused materialization tests and `npm run check` pass.
- Feishu is synced and read back only when the user explicitly asks for Feishu
  parity for this data shape. Never claim Feishu completion without readback.

## Hard Rules

- Use official insurer pages, insurer-hosted PDFs, or regulator/industry product
  disclosures. Do not use third-party summaries as source material.
- Prefer terms, clauses, product brochures, and official product descriptions.
  Sales pages are acceptable only when they contain concrete responsibility text.
- Stop and record a blocker for CAPTCHA, SMS login, 403, 503, or unavailable
  files. Do not bypass access controls.
- For public official product disclosure pages, apply the
  `crawl-insurance-product-knowledge` Tool Ladder before declaring a crawl
  blocked: direct API/static fetch, browser/CDP, cloakbrowser, crawl4ai, then
  firecrawl as appropriate. Browser/cloak/crawl4ai/firecrawl may be used to
  retrieve public official tables and official PDF/ZIP bytes, but not to solve
  CAPTCHAs, bypass login, or scrape private policy/account pages.
- Keep regulator or industry disclosures distinct from insurer official catalog
  status. A regulator hit proves existence/disclosure, not current sale status.
- Never claim Feishu is complete without readback evidence from Feishu.
- Do not run parallel writes to SQLite or Feishu. Parallelize only discovery or
  source review when needed.
- Subagents may review official sources and write JSONL/source-cache artifacts
  only. The main thread must do all SQLite writes, Feishu writes, backups, and
  final audits serially.
- If code changes are required, follow this repo's AGENTS.md and the
  karpathy-guidelines coding standard first.

## Source Gate

Apply the policy-qa source discipline before accepting any material:

- Capture source URL, source host, access time, product name, company, and file
  type.
- Verify the source host is official enough for the claim being made.
- Preserve enough quote or extracted text context to audit the row later.
- Reject text that cannot be tied to a specific product or source URL.
- Reject OCR garbage, continuation fragments, table-of-contents text, claim
  procedure text, exclusions-only text, and marketing text without obligations.

## Responsibility Gate

Apply the policy-liability-qa threshold before writing page text. Accepted text
must include a covered event or condition and the insurer obligation, such as:

- death, disability, disease, critical illness, medical expense, accident,
  maternity, survival, maturity, annuity, waiver, reimbursement, or benefit;
- payment, reimbursement, benefit amount, insured amount, annuity payment,
  premium waiver, or settlement responsibility.

Do not write cash-value-only text, eligibility-only text, exclusions, claim
documents, renewal rules, underwriting questions, or isolated headings as
responsibility text.

## Standard Workflow

1. Lock the active local environment:

```bash
export POLICY_OCR_APP_DB_PATH="$PWD/.runtime/local/policy-ocr.sqlite"
export POLICY_OCR_APP_STATE_PATH="$PWD/.runtime/local/state.json"
export STAMP="$(date +%Y%m%d-%H%M%S)"
export RUN_DIR="$PWD/.runtime/responsibility-backfill-$STAMP"
mkdir -p "$RUN_DIR"
```

2. Capture baseline counts before any write:

```bash
sqlite3 "$POLICY_OCR_APP_DB_PATH" \
  "select count(*) from knowledge_records;" > "$RUN_DIR/baseline-count.txt"
sqlite3 "$POLICY_OCR_APP_DB_PATH" \
  "select company, count(*) from knowledge_records group by company order by count(*) asc;" \
  > "$RUN_DIR/company-counts.tsv"
```

3. Create a SQLite backup:

```bash
sqlite3 "$POLICY_OCR_APP_DB_PATH" \
  "VACUUM INTO '$RUN_DIR/policy-ocr-before.sqlite';"
```

4. Build a source profile for each target company:

- official website domains and product-list pages;
- official PDF patterns and download endpoints;
- known Feishu routing or historical table location;
- known blockers, such as 503 pages or gated downloads;
- chosen crawler layer and fallback layer, for example direct API, CDP,
  cloakbrowser, crawl4ai, or firecrawl.

5. Crawl or repair in small batches:

- review existing rows first to avoid duplicates;
- reuse official source text already stored in the database when it meets both
  gates;
- use PDF extraction when web pages are too short or page text is missing;
- for browser-context downloads, save official PDF/ZIP bytes under the run
  directory and pass `pdfPath`/`zipPath` into the extractor instead of storing
  raw rendered HTML as responsibility text;
- write only rows that pass both gates;
- record rejected candidates with a reason.

6. Validate local writes:

```bash
sqlite3 "$POLICY_OCR_APP_DB_PATH" \
  "select id, company, productName, length(pageText), sourceUrl from knowledge_records where id between $MIN_ID and $MAX_ID order by id;" \
  > "$RUN_DIR/local-readback.tsv"
```

Check for:

- expected count delta;
- non-empty pageText;
- official source URL;
- no duplicate source URL for the same product unless intentionally repaired;
- responsibility text with both trigger and insurer obligation.

7. Sync to Feishu only after local validation. Use the existing company config
   when historical rows already route there. Do not create a new Feishu table
   just because the table display name differs.

```bash
node scripts/sync-feishu-knowledge.mjs \
  --company="$COMPANY" \
  --config-path="$FEISHU_CONFIG" \
  --local-id-min="$MIN_ID" \
  --local-id-max="$MAX_ID" \
  --create-only \
  --skip-existing-local-ids \
  --dry-run > "$RUN_DIR/feishu-dry-run-before.log"

node scripts/sync-feishu-knowledge.mjs \
  --company="$COMPANY" \
  --config-path="$FEISHU_CONFIG" \
  --local-id-min="$MIN_ID" \
  --local-id-max="$MAX_ID" \
  --create-only \
  --skip-existing-local-ids > "$RUN_DIR/feishu-write.log"

node scripts/sync-feishu-knowledge.mjs \
  --company="$COMPANY" \
  --config-path="$FEISHU_CONFIG" \
  --local-id-min="$MIN_ID" \
  --local-id-max="$MAX_ID" \
  --create-only \
  --skip-existing-local-ids \
  --dry-run > "$RUN_DIR/feishu-dry-run-after.log"
```

8. Read back Feishu by local ID or exact product name. Save JSON or TSV
   evidence in the run directory. The post-write dry-run should report no
   remaining create candidates for the inserted local IDs.

9. Write a final report with at least:

- target companies and source hosts reviewed;
- inserted local IDs;
- products skipped as existing;
- candidates rejected and why;
- blockers;
- Feishu table or config used;
- local and Feishu verification result;
- whether quality metadata fields were blank, updated, or intentionally left as
  notes for a later quality pass.

## Product Responsibility Card Batch Workflow

Use this workflow when the user asks to cover all products, continue batches,
use subagents, write insurance responsibilities, or verify quantifiable
indicators.

1. Keep the target database pinned to development:

```bash
export POLICY_OCR_APP_DB_PATH="$PWD/.runtime/local/policy-ocr.sqlite"
```

2. Build the missing-product batch from products that have knowledge rows but no
   responsibility cards. Exclude products that already have reviewed artifacts
   for the current run. Split into 10-product TSV files named like
   `agent-batch-177.tsv`.

3. Delegate only source review to subagents. Each subagent must:

- read the single-product responsibility skill plus `policy-qa` and
  `policy-liability-qa`;
- use official insurer/regulator material only;
- prefer official PDF download and extraction, falling back to same-source DB
  `pageText` only with a blocker note;
- output one JSON object per TSV row to `agent-N-review.jsonl`;
- write source caches only under the run directory;
- not write SQLite, not write Feishu, and not change code.

4. Require each JSONL row to include:

- `batchNo`, `inputRowIndex`, `company`, `productName`, `sourceRecords`;
- `acceptedResponsibilities` with customer-facing `customerSummary`,
  `triggerCondition`, `insurerObligation`, `benefitFormulaText`,
  `importantLimits`, `cashflowTreatment`, `sourceUrl`, and `sourceExcerpt`;
- `rejectedFragments` with reasons;
- `blockers` for blocked downloads, extraction failures, gated files, or source
  uncertainty;
- `internalIndicatorChecks` and `recommendedDbWrites` with liability,
  `basisKey`, `calculationKey`, `calculationEligible`, calculation status or
  reason, metadata version, treatment, formula, source URL, source excerpt, and
  accepted manual review status.

5. Before importing, run an artifact audit. Fail the batch if:

- any JSONL line is invalid or out of TSV order;
- accepted count differs from recommended DB write count;
- a customer summary contains internal terms such as `指标核对`, `basisKey`,
  `calculationKey`, `calculationStatus`, `calculationReason`,
  `indicatorCheckStatus`, `recommendedDbWrites`, or `internalIndicatorChecks`;
- an accepted item lacks liability, customer summary, trigger, obligation,
  official URL, or source excerpt;
- an unselected optional responsibility is written as selected.

6. Back up SQLite before each import:

```bash
sqlite3 .runtime/local/policy-ocr.sqlite \
  "VACUUM INTO '$RUN_DIR/policy-ocr-before-agents-177-180.sqlite';"
```

7. Import only after the artifact audit passes:

```bash
node scripts/import-reviewed-responsibility-artifacts.mjs \
  --db-path=.runtime/local/policy-ocr.sqlite \
  --artifacts="$RUN_DIR/agent-177-review.jsonl,$RUN_DIR/agent-178-review.jsonl" \
  --write --sample-limit=12
```

8. Run the exact audit immediately after import. For every product in the
   artifacts, compare sorted accepted liability names to sorted DB card titles
   and sorted accepted manual indicator liabilities. The batch is not complete
   until:

```text
rawAccepted == totalCards == totalAcceptedIndicators
issueCount == 0
```

9. If import counts disagree, stop and diagnose before continuing. Common causes
   are local standardization rules hiding valid cards, merging similar titles, or
   leaving stale display-only cards. Fix narrowly, add a focused regression test,
   rerun the affected import, then rerun exact audit. Example: a full liability
   title ending in `年金` must not be filtered only because it contains `增额`;
   `增额/利率` can be a parameter, but `保证给付十年增额终身年金` is a card.

10. Verify after every imported group:

```bash
node --test tests/materialize-product-responsibility-cards.test.mjs
npm run check
```

11. Report separate statuses:

- artifact review result: products, accepted responsibilities, blockers, and
  zero-accepted products;
- SQLite result: cards, indicators, exact audit result, backup path;
- Feishu result: synced or not synced, with readback evidence if synced;
- remaining uncovered products from the active development database.

## Stuck Batch Handling

- Distinguish no progress from slow official-source extraction. Check source
  cache file counts and JSONL hashes before deciding that a subagent is stuck.
- Do not wait on non-essential cleanup such as closing old subagents when it
  blocks progress. Reuse existing agents or spawn fresh ones if allowed.
- Treat replacement artifacts explicitly. If a retry artifact is canonical, copy
  or rename it to the expected `agent-N-review.jsonl` only after auditing it.
- If a tool call is interrupted, inspect whether files were partially written
  before retrying or importing.
- Never continue to the next import while a previous import or exact audit is
  unfinished.

## Quality Metadata

Blank quality fields are not automatically bad data. They usually mean the
ingestion path did not populate quality metadata. Treat them as a follow-up
quality task unless pageText, source URL, or responsibility content fails the
gates above.

When adding or updating ingestion scripts, populate both the legacy quality
field and the responsibility-specific quality field if the schema supports them.

## Common Pitfalls

- Wrong database: always verify `.runtime/local/policy-ocr.sqlite`, not an old
  `.runtime/policy-ocr.sqlite` copy.
- Wrong app state: export `POLICY_OCR_APP_STATE_PATH`; some scripts read the
  environment rather than a command-line state path.
- Feishu routing mismatch: if historical rows for a company live in a shared
  table, keep using that table and document the reason.
- Feishu config churn: sync helpers may rewrite config files; re-check routing
  notes after a sync.
- Markdown readback: prefer JSON or TSV readback artifacts when comparing local
  IDs and page text lengths.
- Current catalog confusion: a product can be officially disclosed or historical
  without being currently sold on the insurer website.

## When To Stop

Stop the batch and report status when:

- official sources are blocked or unavailable after the crawler ladder has been
  tried for public disclosure pages;
- local write succeeds but Feishu write or readback fails;
- a company needs a new crawler adapter rather than a small repair;
- source evidence is insufficient for the responsibility gate;
- duplicate or conflicting official materials need manual product matching.
