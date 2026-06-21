# JRCPCX Major Company PDF-Only Backfill Design

## Background

The OCR Insurance knowledge library already has official-source responsibility rows and a growing local PDF archive under `.runtime/policy-material-pdfs/`. Recent Ping An JRCPCX work confirmed that saving the PDF first is useful: later responsibility extraction can run from `pdfLocalPath` without reopening JRCPCX detail pages or re-triggering slider verification.

The existing major-company gap design covers a full responsibility pipeline: discover, download, extract, write SQLite, and sync Feishu. This design is narrower. It only fills missing product material data and archives terms PDFs for later extraction.

## Goal

Backfill missing JRCPCX terms PDFs for eight major human-insurance companies, after first comparing against local knowledge and existing PDF artifacts.

Target issuing institutions:

- `中国人寿保险股份有限公司`
- `泰康人寿保险有限责任公司`
- `新华人寿保险股份有限公司`
- `阳光人寿保险股份有限公司`
- `中国人民人寿保险股份有限公司`
- `友邦人寿保险有限公司`
- `中国太平洋人寿保险股份有限公司`
- `太平人寿保险有限公司`

Success means the run produces per-company and aggregate JSON/CSV artifacts that identify already-covered materials, newly downloaded PDFs, blocked rows, and failed rows. Every newly downloaded row must include a valid local PDF path, file metadata, source URLs, and product metadata needed for a future responsibility extraction pass.

## Non-Goals

- Do not extract insurance responsibility text.
- Do not classify responsibility quality.
- Do not write `knowledge_records` or any other SQLite table.
- Do not sync Feishu.
- Do not crawl property-insurance products.
- Do not download company introductions, product introductions, rate tables, cash-value tables, statements, or non-terms attachments.
- Do not treat a product-name match as enough to skip a different terms material version.
- Do not use third-party document sites or generated summaries as source material.

## Source Scope

Primary source:

- `https://www.jrcpcx.cn/#/query`

Allowed material hosts:

- JRCPCX life-insurance detail and clause endpoints under official platform hosts such as `inspdinfo.iachina.cn`.

Source rows must keep the visible platform metadata:

- issuing institution full name
- product name
- product type
- product status
- industry code when visible
- detail URL when available
- clause/PDF URL
- query shard metadata

## Recommended Approach

Use a differential PDF-only backfill.

The run first builds a local coverage index from existing knowledge and PDF-only artifacts. It then queries JRCPCX for the eight companies and only opens details or downloads PDFs for materials that are not already represented by normalized clause URL, PDF hash, or an already completed same-batch material key.

This is preferred over a full recrawl because JRCPCX can truncate broad queries, require slider verification, or return `前方拥堵`. Skipping known URLs and hashes reduces platform pressure and makes the run easier to resume.

## Data Flow

1. Build a local coverage index.
   - Read local `knowledge_records` from the active development data source when available.
   - Read known PDF-only JSON artifacts under `.runtime/`.
   - Normalize existing clause URLs by removing volatile timestamp parameters.
   - Record known PDF hashes and known material keys.

2. Build or load an eight-company JRCPCX query plan.
   - Query by issuing institution full name.
   - Restrict product type to `人身保险类`.
   - Use product status shards such as `在售`, `停售`, and `停用`.
   - Split broad or truncated shards by product keywords when needed.

3. Collect catalog rows.
   - Save product rows and detail links.
   - Deduplicate by issuing institution, product name, industry code, product status, and detail URL.
   - Keep unresolved truncated shards in the artifact instead of claiming full coverage.

4. Compare before download.
   - Skip if normalized clause URL is already known.
   - Skip if the PDF hash is already known after a lightweight download/checkpoint.
   - Skip duplicates already completed in the same batch.
   - Treat same company and product name with a different clause URL as a separate material version.

5. Download only missing terms PDFs.
   - Open the JRCPCX detail URL only when needed.
   - Download only the terms PDF.
   - Reject non-PDF responses.
   - Archive the PDF using the existing hash-based storage rule.

6. Write artifacts only.
   - Write JSON/CSV result files under `.runtime/`.
   - Do not mutate SQLite.
   - Do not sync Feishu.

## PDF Storage Rule

Keep the existing storage convention:

`.runtime/policy-material-pdfs/<batch-name>/<sha256[0..2]>/<sha256[2..4]>/<sha256>.pdf`

The physical file name remains the SHA256 hash. Readable product names are not used as file names, because existing extraction and dedupe scripts already rely on hash-based paths.

Each successful PDF row must include:

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
- `pdfSha256`
- `pdfBytes`
- `pdfContentType`
- `pdfArchivedAt`
- `suggestedReadableName`
- `futureExtractionStatus: "pending"`
- `responsibilityDeferred: true`

`suggestedReadableName` is for manual inspection and later extraction reports only. It does not change the archived PDF path.

## Deduplication Rules

Skip download when:

- the normalized clause URL already exists in local knowledge or prior PDF-only artifacts;
- the PDF SHA256 already exists in the archive;
- the same issuing institution, product name, industry code, and clause URL has already succeeded in the current batch.

Do not skip when:

- only the product name matches but the clause URL differs;
- the same product has a different industry code or material version;
- the local product row has responsibility text but no matching terms material URL.

Rows skipped by URL or hash must still be recorded in `skipped-existing` artifacts with the matched local evidence when available.

## Artifacts

Use timestamped output paths.

Per company:

- `.runtime/jrcpcx-major-company-pdf-only-<company-slug>-<stamp>-catalog.json`
- `.runtime/jrcpcx-major-company-pdf-only-<company-slug>-<stamp>-catalog.csv`
- `.runtime/jrcpcx-major-company-pdf-only-<company-slug>-downloaded.json`
- `.runtime/jrcpcx-major-company-pdf-only-<company-slug>-downloaded.csv`
- `.runtime/jrcpcx-major-company-pdf-only-<company-slug>-skipped-existing.json`
- `.runtime/jrcpcx-major-company-pdf-only-<company-slug>-skipped-existing.csv`
- `.runtime/jrcpcx-major-company-pdf-only-<company-slug>-blocked.json`
- `.runtime/jrcpcx-major-company-pdf-only-<company-slug>-blocked.csv`
- `.runtime/jrcpcx-major-company-pdf-only-<company-slug>-summary.json`

Aggregate:

- `.runtime/jrcpcx-major-company-pdf-only-<stamp>-summary.json`
- `.runtime/jrcpcx-major-company-pdf-only-<stamp>-downloaded.csv`
- `.runtime/jrcpcx-major-company-pdf-only-<stamp>-skipped-existing.csv`
- `.runtime/jrcpcx-major-company-pdf-only-<stamp>-blocked.csv`

The aggregate summary must include per-company counts for:

- catalog rows
- unique candidate materials
- already represented by URL
- already represented by hash
- newly downloaded PDFs
- blocked rows
- failed rows
- missing PDF paths
- unresolved truncated shards

## Error Handling

If JRCPCX shows slider verification, pause and ask the user to complete it in the visible browser.

If JRCPCX shows `前方拥堵`, checkpoint the current company and shard, then continue later with a fresh browser profile or smaller shard.

If a shard is still truncated after keyword splitting, record it as unresolved and continue with the next shard.

If detail extraction fails, record the product in `blocked` or `failed` with the exact reason and source query metadata.

If a PDF download returns HTML, JSON error text, an empty response, or an unsupported attachment type, reject it and do not archive it as a PDF.

## Verification

Before calling the PDF-only run complete, verify:

- every downloaded row has an existing `pdfLocalPath`;
- every downloaded file starts as a PDF and has `pdfBytes > 0`;
- every downloaded row's `pdfSha256` matches the file on disk;
- every downloaded row has product name, issuing institution full name, detail URL when available, clause URL, and clause file name;
- `futureExtractionStatus` is `pending` for downloaded rows;
- the run produced per-company and aggregate artifacts;
- no SQLite row count changed as part of this PDF-only workflow;
- no Feishu sync command ran;
- blocked and failed rows are preserved with reasons.

No full application test suite is required for a data-only run. If crawler code changes are needed to support this workflow, run the nearest focused JRCPCX tests before using the code for a data run.

## Handoff To Future Responsibility Extraction

The next phase can read the aggregate `downloaded.csv` or `downloaded.json`, iterate `pdfLocalPath`, extract responsibility text, classify quality, and build a separate SQLite insert plan.

That later phase must not re-query JRCPCX for records that already have a local PDF path unless the PDF file is missing or corrupt.
