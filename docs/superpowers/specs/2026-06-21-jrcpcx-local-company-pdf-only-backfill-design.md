# JRCPCX Local Company PDF-Only Backfill Design

## Background

The OCR Insurance knowledge library now has a reusable JRCPCX PDF-only path. The last major-company run proved the important rule: even when a JRCPCX material is already represented locally, the output still needs a PDF manifest row with `pdfLocalPath`, file name, hash, and byte size. Otherwise the next responsibility extraction phase cannot reliably find the source PDF.

The user wants to continue beyond the previous eight-company pass. The new scope is all human-insurance companies already represented in the local knowledge library, using JRCPCX as the only source for this phase.

## Goal

Build a PDF-only backfill design that starts from local `knowledge_records`, discovers local insurance companies, queries JRCPCX for human-insurance products for those companies, and produces durable PDF material artifacts for later responsibility extraction.

Success means the workflow produces aggregate and per-company JSON/CSV artifacts that show:

- which local companies were considered;
- which companies were included or excluded;
- which JRCPCX products were found;
- which terms PDFs were newly downloaded;
- which terms PDFs already existed locally and where their local files are;
- which rows were blocked or failed and why.

This phase is complete when every usable PDF row has `pdfLocalPath`, `pdfFileName`, `pdfSha256`, and `pdfBytes`, and the SQLite row count is unchanged.

## Non-Goals

- Do not extract insurance responsibility text.
- Do not classify responsibility quality.
- Do not write `knowledge_records` or any other SQLite table.
- Do not sync Feishu.
- Do not crawl insurer official websites.
- Do not use third-party document sites.
- Do not crawl property-insurance products.
- Do not download company introductions, product introductions, rate tables, cash-value tables, statements, or non-terms attachments.
- Do not claim JRCPCX is complete for products that JRCPCX does not expose.

## Source Scope

Only use the JRCPCX financial product query platform:

- `https://www.jrcpcx.cn/#/query`
- official JRCPCX life-insurance detail and clause endpoints such as `inspdinfo.iachina.cn`

This phase should not fall back to insurer official websites. Insurer official website crawling can be a separate spec after this JRCPCX-only pass produces a clear gap list.

## Company Scope

The input company list comes from the active local SQLite knowledge library.

The inventory step should read local `knowledge_records` and build one row per company with:

- `company`
- `localKnowledgeRecordCount`
- `localHumanInsuranceEvidenceCount`
- `localJrcpcxClauseUrlCount`
- `localPdfPathCount`
- `included`
- `excludeReason`

Include companies that have local human-insurance evidence or whose product rows are clearly life/health/accident/annuity/endowment/critical-illness/medical related.

Exclude companies when the available local evidence is clearly property insurance, broker/intermediary-only, empty, or not an insurer.

Company names should use the best local full name available. If JRCPCX accepts fuzzy issuing institution names, the submitted `deptName` can use the local company name, but the artifact must preserve both:

- `localCompanyName`
- `submittedDeptName`

## Recommended Approach

Use a sharded, resumable local-company PDF-only sweep.

This is preferred over one large full run because JRCPCX can require slider verification, show `前方拥堵`, return stale rows, or truncate broad searches. Company-level batches make failures auditable and retryable without rerunning successful companies.

## Alternatives Considered

### Approach 1: Sharded local-company sweep

Build an inventory, group companies into batches, query JRCPCX per company, and write batch-level and company-level artifacts.

Trade-offs:

- Pros: resumable, easier to audit, safer under JRCPCX verification limits.
- Cons: more artifact files and a slightly longer setup step.

This is the recommended approach.

### Approach 2: One-shot full sweep

Generate all company queries and run them in one crawler session.

Trade-offs:

- Pros: simplest command shape.
- Cons: hard to isolate failures, more likely to lose progress when the browser session is blocked.

This should not be used for the full local-company pass.

### Approach 3: Sample then full sweep

Run 10 representative companies first, inspect output, then run the rest.

Trade-offs:

- Pros: safest if the company inventory contains many ambiguous names.
- Cons: adds an extra manual gate and delays full coverage.

This can be used if the initial inventory looks noisy, but it is not required for the first implementation.

## Data Flow

1. Build local company inventory.
   - Read `knowledge_records` from the selected SQLite database.
   - Count local records by company.
   - Count existing JRCPCX clause URLs and existing PDF paths.
   - Mark included and excluded companies with reasons.

2. Build query batches.
   - Use included companies only.
   - Query JRCPCX with product type `人身保险类`.
   - Keep product status broad enough to include `在售`, `停售`, and `停用`.
   - Group large companies into one-company batches.
   - Group smaller companies into 5 to 10 company batches.

3. Crawl JRCPCX catalog and detail data.
   - Save catalog rows separately from PDF material rows.
   - Preserve issuing institution full name, product name, product type, product status, industry code, detail URL, clause URL, and query metadata.
   - Treat pagination truncation as a blocked/retryable condition when narrower sharding is needed.

4. Compare before download.
   - Normalize clause URLs by removing volatile `t` parameters.
   - Skip materials already represented by normalized clause URL.
   - Skip materials already represented by PDF SHA256.
   - Skip duplicates already completed in the same batch.
   - Do not skip a different clause URL only because the product name matches.

5. Download only missing terms PDFs.
   - Download terms PDFs only.
   - Reject HTML, JSON error responses, empty responses, and non-PDF attachments.
   - Store PDFs using the existing hash-based archive rule.

6. Enrich existing materials.
   - For skipped-existing rows, look up the matching local JRCPCX record.
   - Fill `pdfLocalPath`, `pdfFileName`, `pdfSha256`, `pdfBytes`, and source record metadata.
   - Verify the local PDF file exists and the hash matches.

7. Write artifacts only.
   - Write JSON/CSV files under `.runtime/`.
   - Do not write SQLite.
   - Do not sync Feishu.

## Batch and File Naming

Use a single timestamped batch prefix:

`.runtime/jrcpcx-local-company-pdf-only-<stamp>-*`

Aggregate files:

- `jrcpcx-local-company-pdf-only-<stamp>-company-inventory.json`
- `jrcpcx-local-company-pdf-only-<stamp>-company-inventory.csv`
- `jrcpcx-local-company-pdf-only-<stamp>-queries.json`
- `jrcpcx-local-company-pdf-only-<stamp>-catalog.json`
- `jrcpcx-local-company-pdf-only-<stamp>-catalog.csv`
- `jrcpcx-local-company-pdf-only-<stamp>-downloaded.json`
- `jrcpcx-local-company-pdf-only-<stamp>-downloaded.csv`
- `jrcpcx-local-company-pdf-only-<stamp>-existing-pdf-manifest.json`
- `jrcpcx-local-company-pdf-only-<stamp>-existing-pdf-manifest.csv`
- `jrcpcx-local-company-pdf-only-<stamp>-blocked.json`
- `jrcpcx-local-company-pdf-only-<stamp>-blocked.csv`
- `jrcpcx-local-company-pdf-only-<stamp>-summary.json`

Per-batch and per-company files should use the same prefix plus:

- `batch-<nnn>`
- a stable company slug derived from the local company name

## PDF Storage Rule

Use the existing PDF archive convention:

`.runtime/policy-material-pdfs/<batch-name>/<sha256[0..2]>/<sha256[2..4]>/<sha256>.pdf`

The physical file name remains the SHA256 hash. A readable product-based name may be recorded as `suggestedReadableName`, but it must not replace the hash-based path.

## Required PDF Manifest Fields

Every row in `downloaded` and `existing-pdf-manifest` must include:

- `status`
- `reason`
- `localCompanyName`
- `submittedDeptName`
- `issuerFullName`
- `productName`
- `productType`
- `productState`
- `industryCode`
- `detailUrl`
- `clauseUrl`
- `normalizedClauseUrl`
- `clauseFileName`
- `pdfOriginalUrl`
- `pdfLocalPath`
- `pdfFileName`
- `pdfSha256`
- `pdfBytes`
- `pdfContentType`
- `pdfArchivedAt`
- `suggestedReadableName`
- `futureExtractionStatus: "pending"`
- `responsibilityDeferred: true`

Existing local rows should additionally include:

- `sourceKnowledgeRecordId`
- `sourceKnowledgeCompany`
- `sourceKnowledgeProductName`
- `sourceKnowledgeUrl`
- `existingPdfPathExists`
- `pdfSha256MatchesFile`

## Deduplication Rules

Use these keys in order:

1. Normalized JRCPCX clause URL.
2. PDF SHA256.
3. Issuing institution full name + product name + industry code + detail URL.

Do not use product name alone as a dedupe key.

If the same product name has different clause URLs or different industry codes, treat the rows as separate material versions.

## Blocked and Failed Rows

Blocked rows must be preserved with enough metadata for retry:

- company name
- submitted JRCPCX query fields
- product name when known
- detail URL when known
- clause URL when known
- reason code
- source batch
- browser/CDP profile when relevant

Expected blocked reasons include:

- `verification_required`
- `congestion`
- `truncated_catalog_shard`
- `detail_failed`
- `missing_clause_url`
- `pdf_fetch_failed`
- `non_pdf_response`
- `pdf_file_not_found`
- `pdf_sha256_mismatch`

## Summary Requirements

The aggregate summary must include:

- local company count
- included company count
- excluded company count
- query count
- catalog row count
- unique candidate material count
- downloaded count
- existing PDF manifest count
- existing PDF path exists count
- missing existing PDF path count
- missing existing PDF file count
- PDF SHA256 mismatch count
- blocked count
- failed count
- unresolved truncated shard count
- per-company breakdown for the same counts

## Error Handling

If JRCPCX asks for slider verification, pause and let the user complete it in the visible browser.

If JRCPCX shows `前方拥堵`, checkpoint the current batch and continue later with a fresh browser profile or smaller shard.

If a broad query is truncated, record it and retry with narrower shards rather than claiming complete coverage.

If a local skipped-existing row cannot be enriched with a PDF path, keep it in `skipped-existing` and count it under `missingExistingPdfPathCount`; do not treat it as successful future extraction input.

## Verification

Before calling a batch complete:

- every `downloaded` row has an existing `pdfLocalPath`;
- every `existing-pdf-manifest` row has an existing `pdfLocalPath`;
- every PDF file starts with a PDF signature and has `pdfBytes > 0`;
- every row's `pdfSha256` matches the file on disk;
- no SQLite row count changed;
- no responsibility text extraction ran;
- no Feishu sync ran;
- blocked and failed rows are preserved with reasons.

If crawler code changes are required, run the focused JRCPCX tests before using the crawler for data collection.

## Handoff To Future Responsibility Extraction

The next phase should read only:

- aggregate `downloaded.json` or `downloaded.csv`;
- aggregate `existing-pdf-manifest.json` or `existing-pdf-manifest.csv`.

It should iterate `pdfLocalPath`, extract responsibility text, classify quality, and build a separate insert plan. It should not re-query JRCPCX unless the recorded PDF file is missing or corrupt.

## Open Operational Boundary

The implementation plan should decide the first batch size after seeing the generated company inventory. The design default is:

- one-company batches for high-volume companies;
- 5 to 10 companies per batch for smaller companies.

This is an operational tuning point, not a product requirement.
