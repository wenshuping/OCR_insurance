# JRCPCX CDP Data Backfill Design

## Background

The responsibility knowledge library has already ingested most available insurer-official materials from company websites. Recent refreshes show that ordinary official-site crawlers now produce little new data, while JRCPCX / China Insurance Association still exposes old and registered product materials that may not exist in current insurer catalogs.

The JRCPCX workflow has two known constraints:

- It depends on a live browser/CDP session and may require manual slider verification.
- Broad queries can be truncated, stale, or blocked by `前方拥堵`, so the crawl must be sharded and verified before writing any rows.

## Goal

Backfill additional human-insurance responsibility records from JRCPCX terms PDFs into the local knowledge library and the matching Feishu tables.

The pass should prioritize:

- `中国平安人寿保险股份有限公司`
- other large or low-coverage human-insurance companies with existing Feishu table configs, such as 中国人寿, 人保寿险, 太保寿险, 泰康, 新华保险, 阳光人寿, 友邦, and 中国太平

Success means every inserted record has a JRCPCX detail source, a locally archived terms PDF, extracted insurance-responsibility text, a valid quality status, a local SQLite ID, and a post-sync Feishu dry-run showing pending rows as zero.

## Non-Goals

- Do not ingest property-insurance products.
- Do not ingest company introductions, product catalogs without terms PDFs, or third-party document pages.
- Do not write rows from OCR garbage, table-of-contents snippets, exclusion-only text, cash-value tables, dividend-only notes, or fragments that cannot support a responsibility answer.
- Do not modify production data or production runtime.
- Do not merge multiple insurers into a shared Feishu destination when an insurer-specific table exists.

## Approach Options

### Recommended: Fresh CDP Session With Narrow JRCPCX Shards

Open a new Chrome profile on a fresh CDP port, let the user complete slider verification when needed, then run JRCPCX queries in narrow batches by issuing institution, human-insurance type, status, and product-name keywords.

This is the best fit because official-site refreshes are mostly exhausted and JRCPCX is the source most likely to contain old materials.

### Alternative: Continue Official-Site Incremental Crawls

Keep running insurer official-site crawlers without JRCPCX. This is stable and needs no user interaction, but recent runs show low yield.

### Alternative: Repair Previously Skipped Dirty PDFs

Reprocess old invalid or suspicious local records with OCR and stricter extraction. This may recover a small number of rows, but it risks spending time on noisy PDFs and should stay separate from this JRCPCX pass.

## Architecture

### CDP Session Manager

The run starts by creating or verifying a Chrome/CDP session on a fresh port, such as `9225` or the next free port.

Responsibilities:

- open `https://www.jrcpcx.cn/#/query`
- verify that the query page is reachable
- pause when the page shows slider verification
- avoid reusing a tainted session after `前方拥堵` or repeated verification failures

### Query Planner

The planner builds small JRCPCX UI queries.

Query dimensions:

- issuing institution full name from the platform or local company profile
- product type: `人身保险类`
- product status: `在售`, `停售`, `停用`
- product-name keyword shards when broad issuer/status queries are truncated

Each query records row count, truncation state, verification state, and next action.

### Catalog Collector

The collector reads visible table rows and expanded detail links. It does not write SQLite.

Each catalog row keeps:

- issuing institution full name
- product name
- product type
- product status
- industry code if visible
- JRCPCX detail URL
- query metadata

Deduplication key:

`issuer full name + product name + industry code + detail URL`

### Detail Extractor

The extractor opens each deduped JRCPCX detail URL, downloads the terms PDF, archives it under `.runtime/policy-material-pdfs/`, computes the PDF hash, and extracts only the insurance responsibility section.

Each detail record keeps:

- JRCPCX detail URL
- JRCPCX clause PDF URL
- local PDF path
- PDF sha256
- PDF byte size
- product metadata
- extracted responsibility text
- quality status

### Quality Gate

Only records classified as `valid_complete` or clearly usable `valid_partial` can move to the insert plan.

The gate rejects:

- empty text
- OCR garbage
- table of contents
- responsibility-exemption-only content
- claim application sections
- company or product introductions
- dividend-only, cash-value-only, surrender, loan, or benefit-illustration text
- fragments that begin mid-clause without enough payment rules

### Coverage Reconciler

The reconciler compares detail records with `.runtime/policy-ocr.sqlite`.

Match keys:

- normalized JRCPCX clause PDF URL
- terms text code or industry code when available
- company plus product name as a secondary review key

Outcomes:

- represented: same terms PDF already exists locally
- insertable: valid JRCPCX terms PDF is not represented locally
- skipped invalid: quality gate failed
- blocked: verification, congestion, missing detail link, missing PDF, or truncated query

### SQLite Writer

The writer backs up `.runtime/policy-ocr.sqlite` before any write and inserts only the approved insertable rows.

Inserted rows use:

- `url`: normalized JRCPCX clause PDF URL
- `seedSourceUrl`: JRCPCX detail URL
- `sourceType`: `pdf`
- `materialType`: `terms`
- `officialDomain`: `inspdinfo.iachina.cn`
- `evidenceLevel`: `regulatory_industry_terms`
- `evidenceLabel`: `金融产品查询平台/中国保险行业协会条款 PDF`
- `qualityStatus` and `responsibilityQualityStatus`: same approved quality value

The company field should preserve the JRCPCX issuing institution full name. Feishu table selection can use the existing local company-to-table config where needed.

### Feishu Sync

Each insurer sync runs against its own Feishu table config.

Rules:

- dry-run before writing
- use the exact new local ID range
- create only
- skip existing remote local IDs
- require `duplicateKeyCount: 0`
- after writing, run dry-run again and require pending rows to be zero

## Data Flow

1. Start or verify a fresh CDP browser.
2. User completes slider verification if JRCPCX asks for it.
3. Run query shards for the selected issuers and statuses.
4. Expand rows and collect detail links.
5. Download terms PDFs and archive them locally.
6. Extract responsibility text and classify quality.
7. Reconcile against local SQLite by normalized material identity.
8. Back up SQLite and insert approved rows.
9. Sync each new local ID range to the matching Feishu table.
10. Run post-sync dry-run checks and produce a short report.

## Artifacts

Use timestamped or batch-specific runtime files so failed batches can resume without mixing evidence:

- `.runtime/jrcpcx-cdp-backfill-<stamp>-queries.json`
- `.runtime/jrcpcx-cdp-backfill-<stamp>-catalog.json`
- `.runtime/jrcpcx-cdp-backfill-<stamp>-responsibilities.json`
- `.runtime/jrcpcx-cdp-backfill-<stamp>-coverage-gap.json`
- `.runtime/jrcpcx-cdp-backfill-<stamp>-insert-report.json`
- `.runtime/jrcpcx-cdp-backfill-<stamp>-feishu-sync-report.json`

## Error Handling

If JRCPCX shows slider verification, stop the crawler and wait for user action.

If JRCPCX shows `前方拥堵` or repeated verification failures, close the batch and start a fresh Chrome profile/port before retrying.

If a query is truncated, split by narrower product-name keywords instead of treating the query as complete.

If a detail link or PDF cannot be fetched, mark that row blocked and do not synthesize from another source.

If extracted text is suspicious, keep the PDF evidence but do not write the row to SQLite or Feishu.

## Verification

Before reporting completion, verify:

- active SQLite path is `.runtime/policy-ocr.sqlite`
- SQLite backup exists for the write batch
- inserted local ID range is contiguous for the approved batch
- every inserted row has non-empty responsibility text, `pdfLocalPath`, PDF hash, JRCPCX clause URL, and approved quality status
- each synced company has a before-sync dry-run with the expected count
- each synced company has an after-sync dry-run with pending count zero
- remaining blocked rows are reported by issuer and reason

No code test suite is required for a data-only run unless crawler code changes. If any script is changed, run the nearest syntax checks and focused tests before using it.
