# Ping An JRCPCX Full Material Backfill Design

## Background

The Ping An responsibility library currently has two different coverage facts:

- Local SQLite already contains many Ping An products and materials.
- The JRCPCX / China Insurance Association product query platform exposes additional registered material versions, but broad queries can be truncated at 50 rows and status filters can drift.

The previous batch proved that JRCPCX terms PDFs can fill real local material gaps. It also proved that a simple status query is not enough to claim full coverage. For example, a broad Ping An Life query can return `truncated: true`, and the visible rows may not match the requested status cleanly.

## Goal

Build a Ping An Life-only JRCPCX full material backfill workflow.

The workflow should discover, extract, reconcile, write, and sync JRCPCX terms materials for:

- issuing institution: `中国平安人寿保险股份有限公司`
- product type: `人身保险类`
- material granularity: terms material version, not just product name

Success means we can say which JRCPCX Ping An Life material versions are already represented locally, which were newly written, which synced to Feishu, and which remain blocked for manual review.

## Non-Goals

- Do not include Ping An Health, Ping An Pension, or other Ping An group entities in this pass.
- Do not use third-party article, broker, encyclopedia, forum, or document-hosting text as responsibility content.
- Do not treat a product name match as enough when the JRCPCX terms PDF or terms text code is different.
- Do not write invalid, empty, non-responsibility, or suspect excerpts into the responsibility knowledge library.
- Do not touch production SQLite or production deployment in this workflow.

## Confirmed Decisions

- Scope is `中国平安人寿保险股份有限公司` only.
- Completeness is judged by terms material version.
- Automatic writes allow `valid_complete` and `valid_partial`.
- Automatic writes still require a JRCPCX terms PDF, local PDF archive, PDF hash, source URL, and responsibility text.
- `invalid_empty`, `invalid_non_responsibility`, and `suspect_needs_source_check` go to review reports only.

## Recommended Approach

Use product-name keyword sharding as the primary discovery method, with terms-code/year sharding as a supplemental check.

Status-only queries are insufficient because they can hit the platform's 50-row truncation and can return rows whose status does not match the selected status. Product-name shards make each query narrower, and remaining truncated shards can be split again.

## Architecture

### Shard Planner

The shard planner generates JRCPCX UI queries for:

- department: `中国平安人寿保险股份有限公司`
- product type: `人身保险类`
- product status: `在售`, `停售`, `停用`
- product-name keywords, such as `附加`, `终身`, `年金`, `两全`, `医疗`, `重疾`, `意外`, `万能`, `分红`, `养老`, `少儿`, `护理`, `教育`, `金`, `福`, `安`, `智`, `鑫`, `御`, `盛世`

Each shard records row count, truncation state, retry count, and next action. If a shard is still `truncated: true`, it must be split into narrower product keywords or marked as unresolved.

### Catalog Collector

The catalog collector reads list rows and detail links only. It does not download PDFs and does not write SQLite.

Each catalog row keeps:

- issuing institution full name
- product name
- industry code
- product type
- sales status
- detail URL
- query shard metadata

Catalog dedupe key:

`issuing institution + product name + industry code + detail URL`

### Detail Extractor

The detail extractor processes deduped detail URLs, downloads terms PDFs, archives PDFs under `.runtime/policy-material-pdfs/`, extracts responsibility text, and assigns quality status.

Each detail record keeps:

- detail URL
- terms PDF URL
- local PDF path
- PDF sha256
- PDF byte size
- terms text code
- product metadata from JRCPCX
- extracted responsibility text
- quality status

### Coverage Reconciler

The reconciler compares JRCPCX detail records with local SQLite `knowledge_records`.

The identity and review keys are:

- terms PDF URL
- terms text code
- product name

Matching rules:

- Same terms PDF URL already exists locally: represented, skip write.
- Same product name but different terms PDF URL or terms text code: material gap, eligible for detail-quality review.
- No product match: product gap, eligible for detail-quality review.
- Multiple local candidates with unclear identity: manual review.

### Writer And Feishu Sync

The writer adds only eligible records to `.runtime/policy-ocr.sqlite`.

Inserted knowledge rows should use:

- `url`: terms PDF URL
- `seedSourceUrl`: JRCPCX detail URL
- `sourceType`: `pdf`
- `materialType`: `terms`
- `evidenceLevel`: `regulatory_industry_terms`
- `evidenceLabel`: `金融产品查询平台/中国保险行业协会条款 PDF`
- `officialDomain`: `inspdinfo.iachina.cn`

The sync step sends only the new local ID range to the Ping An Feishu table by using the existing `sync:feishu-knowledge` flow with create-only and remote-local-ID skipping.

## Data Flow And Artifacts

### Shard Plan

Path:

`.runtime/jrcpcx-ping-an-life-shard-plan.json`

Contains:

- query keyword
- status
- row count
- `truncated` state
- retry count
- next action
- error or verification gate state

### Full Catalog

Path:

`.runtime/jrcpcx-ping-an-life-catalog-full.json`

Contains the deduped JRCPCX catalog rows. This file answers how many Ping An Life JRCPCX candidates were found, but it is not an insert source by itself.

### Full Responsibilities

Path:

`.runtime/jrcpcx-ping-an-life-responsibilities-full.json`

Contains PDF and responsibility extraction output for detail records.

### Coverage Gap Report

Path:

`.runtime/jrcpcx-ping-an-life-coverage-gap-full.json`

Contains represented records, material gaps, product gaps, ambiguous records, invalid extraction records, and unresolved truncated shards.

### Insert Report

Path:

`.runtime/jrcpcx-ping-an-life-insert-report.json`

Contains DB path, backup path, before and after knowledge row counts, inserted IDs, skipped records, and quality distribution.

### Feishu Sync Report

Path:

`.runtime/jrcpcx-ping-an-life-feishu-sync-report.json`

Contains synced local ID range, dry-run result before sync, write result, and post-sync dry-run verification.

## Automatic Insert Rules

Automatic inserts are allowed only when all of these are true:

- issuing institution full name is `中国平安人寿保险股份有限公司`
- product type is `人身保险类`
- JRCPCX detail URL exists
- terms PDF URL exists
- terms PDF is archived locally
- PDF sha256 exists
- responsibility text is non-empty
- quality status is `valid_complete` or `valid_partial`

Records are not automatically inserted when:

- the PDF is missing or failed to download
- responsibility text is empty
- extracted text is product introduction, company introduction, dividend notes, cash value table, exclusion text only, or other non-responsibility content
- quality status is `invalid_empty`, `invalid_non_responsibility`, or `suspect_needs_source_check`
- the shard is still truncated and cannot prove its local candidate set

## Verification

Implementation should verify:

- shard plan JSON parses and reports unresolved truncated shards
- full catalog JSON parses and reports total rows, unique products, and unique material candidates
- responsibility JSON parses and every eligible record has PDF path, PDF sha256, terms PDF URL, and responsibility text
- coverage report separates represented, material-gap, product-gap, ambiguous, invalid, and unresolved rows
- SQLite row count increases only during the approved write step
- SQLite is backed up before writes
- inserted local ID range is reported
- `findKnowledgeRecordsForPolicy` can retrieve sampled newly inserted rows
- Feishu dry-run before sync shows pending rows
- Feishu dry-run after sync shows pending rows as zero
- focused tests for JRCPCX query planning, result summarization, and Ping An coverage matching pass

## Risks And Handling

### JRCPCX CAPTCHA Or Anti-Bot Gate

Stop that shard and record the blocked URL, query, and required user action. Do not fabricate data or mark the shard complete.

### 50-Row Truncation

Split the shard into narrower product keywords. If it remains truncated after configured splits, report it as unresolved.

### Status Filter Drift

Treat status as metadata, not as an exclusive completeness proof. Deduplicate by material identity after all shards are collected.

### Same-Name Historical Products

Do not collapse by product name alone. Preserve terms PDF URL and terms text code as material-version evidence.

### Feishu Limits Or Long Text Failures

Sync by small ID ranges and rerun create-only with remote-local-ID skipping. If long responsibility text causes Feishu write failure, keep SQLite as source of truth and record the failed IDs.

### SQLite Path Confusion

All write reports must state the exact SQLite DB path. This workflow defaults to `.runtime/policy-ocr.sqlite` and does not publish to production.

## Acceptance Criteria

The workflow is complete only when:

- all planned shards are either complete or explicitly unresolved in the shard report
- unresolved shards are not counted as complete coverage
- eligible JRCPCX material records are written to SQLite
- inserted rows are synced to the Ping An Feishu table
- a post-sync dry-run confirms zero pending rows for the inserted ID range
- final reports state candidate counts, inserted counts, synced counts, skipped counts, and manual-review counts

