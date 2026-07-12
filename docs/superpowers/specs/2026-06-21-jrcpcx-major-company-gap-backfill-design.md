# JRCPCX Major Company Gap Backfill Design

## Background

The local responsibility knowledge library already has broad coverage from insurer official sites. Recent JRCPCX checks show a different gap: some large human-insurance companies have registered products or material versions on the 金融产品查询平台 that are not represented locally, especially old, stopped, or disabled products.

The prior Ping An pipe-browser run proved that JRCPCX detail pages and terms PDFs can produce valid `保险责任` records when the official company website no longer exposes old terms. It also proved that broad JRCPCX list queries are fragile: they can truncate at 50 rows, trigger slider verification, or show `前方拥堵`.

## Goal

Backfill high-yield large-company gaps from JRCPCX into the OCR Insurance knowledge library.

This batch targets:

- `阳光人寿保险股份有限公司`
- `中国人民人寿保险股份有限公司`

Success means each inserted record has a JRCPCX detail URL, a downloaded local terms PDF, a PDF hash, extracted non-empty insurance responsibility text, an approved quality status, a local SQLite ID, and a Feishu post-sync dry-run showing no pending rows.

## Non-Goals

- Do not crawl property-insurance products.
- Do not ingest company introductions, product introductions, catalogs without terms PDFs, third-party articles, document-hosting pages, or generated summaries.
- Do not treat a product-name match as enough when the terms PDF/material identity differs.
- Do not write empty, OCR-garbage, table-of-contents, exclusion-only, dividend-only, cash-value-only, or suspicious fragments into the responsibility library.
- Do not modify production SQLite or production deployment.
- Do not include Ping An in this batch; Ping An has its own JRCPCX workflow and artifacts.

## Source Scope

Primary source:

- `https://www.jrcpcx.cn/#/query`

Allowed detail and material source:

- JRCPCX life-insurance detail pages and clause/PDF endpoints under official platform hosts such as `inspdinfo.iachina.cn`.

The crawler must keep the visible JRCPCX metadata together with the downloaded terms material:

- issuing institution full name
- product name
- product type
- product status
- industry code when visible
- detail URL
- clause/PDF URL
- query shard metadata

## Recommended Approach

Run a small, company-first JRCPCX pipe-browser batch for 阳光人寿 and 人保寿险.

This is preferred over a five-company batch because existing gap data shows these two companies have the largest shallow candidate gaps, and smaller batches are easier to recover when JRCPCX requires manual verification or returns congestion.

## Query Strategy

Use three levels of sharding:

1. Company:
   - `阳光人寿保险股份有限公司`
   - `中国人民人寿保险股份有限公司`

2. Product status:
   - `在售`
   - `停售`
   - `停用`

3. Product keyword:
   - Start with existing product names from `.runtime/jrcpcx-major-company-life-sharded-gaps.json`.
   - If a query is broad or truncated, split by keywords such as `附加`, `医疗`, `意外`, `重疾`, `两全`, `年金`, `终身`, `万能`, `分红`, `住院`, `护理`, `福`, and `金`.

Do not rely on empty-keyword company/status queries as complete evidence. If JRCPCX returns 50 rows or marks the page as truncated, split the shard or report the shard as unresolved.

## Data Flow

1. Load the existing large-company JRCPCX gap file and select 阳光、人保 candidates.
2. Build a timestamped query plan under `.runtime/`.
3. Open a visible Playwright pipe browser using the JRCPCX backfill method.
4. Query each shard and collect list rows plus detail links.
5. Deduplicate catalog records by issuing institution, product name, industry code, and detail URL.
6. Open each detail URL, download the terms PDF, archive it under `.runtime/policy-material-pdfs/`, and compute its hash.
7. Extract only the insurance responsibility section from the PDF.
8. Classify responsibility quality.
9. Reconcile candidates against `.runtime/policy-ocr.sqlite` by normalized clause/PDF URL first, then company plus product name as review context.
10. Generate an insert plan without writing.
11. After approval, back up SQLite and insert eligible records.
12. Sync each insurer's new local ID range to its Feishu table.
13. Run post-sync dry-runs and write a final report.

## Insert Rules

Automatic insert is allowed only when all of these are true:

- issuing institution is one of the two target companies
- source is JRCPCX human-insurance material
- detail URL exists
- terms PDF URL exists
- local PDF path exists
- PDF hash exists
- responsibility text is non-empty
- quality status is `valid_complete` or `valid_partial`
- normalized clause/PDF URL is not already represented locally

Records must be skipped when:

- product type is property insurance
- PDF is missing or failed to download
- extracted text is blank
- extracted text is product introduction, company introduction, table of contents, exclusion text only, claim application text, dividend notes, cash-value table, surrender/loan text, or benefit illustration only
- quality status is `invalid_empty`, `invalid_non_responsibility`, or `suspect_needs_source_check`
- JRCPCX verification or congestion prevents reliable detail extraction

## SQLite Write

The writer must use the existing knowledge state path and not edit SQLite manually.

Before writing, create a backup:

`.runtime/policy-ocr.sqlite.backup-before-jrcpcx-major-company-gap-<stamp>`

Inserted rows should use:

- `sourceType: "pdf"`
- `materialType: "terms"`
- `official: true`
- `officialDomain: "inspdinfo.iachina.cn"`
- `evidenceLevel: "regulatory_industry_terms"`
- `evidenceLabel: "金融产品查询平台/中国保险行业协会条款 PDF"`
- `url`: normalized clause/PDF URL
- `seedSourceUrl`: JRCPCX detail URL
- `pdfFilePath` and `pdfFileHash`
- `responsibilityQualityStatus`

## Feishu Sync

Sync one company to one existing Feishu table config:

- 阳光人寿 -> `.runtime/feishu-knowledge-sunshine-life.json`
- 人保寿险 -> `.runtime/feishu-knowledge-picc-life.json`

Each sync must:

- dry-run before write
- sync only the new local ID range
- use create-only behavior
- skip existing remote local IDs
- require duplicate key count to be zero
- run a post-write dry-run and require pending create count to be zero

## Artifacts

Use timestamped artifacts:

- `.runtime/jrcpcx-major-company-gap-<stamp>-queries.json`
- `.runtime/jrcpcx-major-company-gap-<stamp>-catalog.json`
- `.runtime/jrcpcx-major-company-gap-<stamp>-responsibilities.json`
- `.runtime/jrcpcx-major-company-gap-<stamp>-insert-plan.json`
- `.runtime/jrcpcx-major-company-gap-<stamp>-insert-report.json`
- `.runtime/jrcpcx-major-company-gap-<stamp>-feishu-sync-report.json`

The final report should include per-company counts for:

- candidate products
- collected detail links
- downloaded PDFs
- extracted responsibility records
- records inserted into SQLite
- records synced to Feishu
- skipped records by reason
- unresolved shards by reason

## Error Handling

If JRCPCX shows slider verification, pause and ask the user to complete it in the visible browser.

If JRCPCX shows `前方拥堵`, stop the current shard, checkpoint the current state, and retry later with a fresh browser profile or smaller shard.

If a shard remains truncated after keyword splitting, report it as unresolved instead of claiming full coverage.

If a PDF cannot be fetched or parsed, keep the metadata in the gap report but do not write a knowledge row.

If a record appears to duplicate an existing product by name but has a different clause/PDF URL, treat it as a material-version review candidate, not as an automatic duplicate.

## Verification

Before completion, verify:

- active database path is `.runtime/policy-ocr.sqlite`
- SQLite backup exists
- inserted local ID ranges are recorded per company
- every inserted row has non-empty `pageText`, local PDF path, PDF hash, JRCPCX detail URL, clause/PDF URL, and approved quality status
- local total count increased exactly by inserted count
- inserted rows have blank responsibility count `0`
- inserted rows have missing PDF count `0`
- Feishu pre-sync dry-run shows the expected pending rows
- Feishu post-sync dry-run shows pending rows `0`
- final report separates inserted, already represented, skipped invalid, blocked, and unresolved truncated records

No full test suite is required for a data-only run. If crawler code changes, run the nearest syntax checks and focused crawler tests before using it for writes.
