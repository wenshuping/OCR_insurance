# Ping An Coverage Audit Design

## Background

The current Ping An responsibility work has two different problem types that must be kept separate:

- Existing local records can have weak or stale responsibility text, missing archived PDFs, or over-broad excerpts that include later sections such as liability exclusions or policy benefits.
- Authoritative sources can contain Ping An products that are not present in the local responsibility library at all.

The first type is a repair workflow. The second type is a coverage-gap workflow. Treating both as one batch risks duplicate rows, wrong product-version matches, and untraceable source swaps.

## Goal

Build a read-only full-coverage audit for China Ping An life/person insurance products. The audit should produce two reviewable lists before any database write:

1. Existing local records that need repair.
2. Authoritative-source records that appear to be missing from the local library and are candidates for insertion.

For missing candidates, the audit must go beyond product names. It should download or archive the official PDF when possible, extract a responsibility preview, and classify extraction quality.

## Non-Goals

- Do not write new knowledge records during the audit step.
- Do not sync Feishu during the audit step.
- Do not use third-party article, broker, encyclopedia, or forum text as responsibility content.
- Do not merge suspicious product variants automatically when names differ by plan code, year, currency edition, product type, or version wording.
- Do not OCR every PDF by default. OCR is a fallback for official PDFs whose text layer is unusable.

## Source Scope

The audit uses three source groups:

- Local SQLite `knowledge_records` where `company = 中国平安`.
- Ping An official product/material sources already supported by the project, including current and historical Ping An product flows.
- JRCPCX / China Insurance Association financial product query data for human insurance products, limited to Ping An-related issuing institutions.

JRCPCX data is authoritative for this workflow because it exposes registered product metadata and terms material. The crawler must filter to human insurance products and should preserve the platform's issuing institution full name when available.

## Output Files

The audit writes JSON reports under `.runtime/`:

- `.runtime/ping-an-existing-repair-audit.json`
- `.runtime/ping-an-missing-source-candidates.json`
- `.runtime/ping-an-coverage-audit-summary.json`

These files are audit artifacts, not the source of truth. Durable writes happen only in a later approved implementation step through the existing SQLite knowledge store.

## Existing Local Repair List

This list contains local Ping An records that need follow-up work. Each item includes:

- local record id
- product name
- title and material type
- source URL
- current quality status
- responsibility text length
- PDF archive state
- detected issue types
- recommended action

Recommended actions are:

- `reextract_official_pdf`: official PDF exists, but responsibility text is weak or stale.
- `ocr_official_pdf`: official PDF exists but text extraction is unreadable or empty.
- `switch_official_material`: same official product has another usable Ping An official material such as a product manual containing concrete responsibility text.
- `boundary_cleanup`: responsibility text exists but includes later non-responsibility sections.
- `manual_review`: matching or source quality is ambiguous.

## Missing Candidate List

This list contains authoritative-source Ping An products not confidently represented in local SQLite. Each candidate includes:

- product name from source
- normalized product name
- issuing institution full name
- product type
- sales status
- platform/source name
- detail URL
- clause or material URL
- local archived PDF path if downloaded
- PDF sha256 and byte size
- responsibility preview
- responsibility quality status
- local match candidates, if any
- missing reason
- recommended action

Missing reasons are:

- `no_local_product_match`: no local product name match after normalization.
- `same_name_no_material_match`: product name exists locally, but the authoritative material/version is absent.
- `ambiguous_local_match`: possible local matches exist, but version/type/status differs enough to require review.
- `source_unusable`: official source exists but PDF cannot be downloaded or parsed.

## Product Matching

Matching is conservative. The audit should normalize names for comparison by:

- trimming spaces
- converting full-width and half-width parentheses consistently
- normalizing common punctuation
- treating `中国平安`, `中国平安人寿`, and `中国平安人寿保险股份有限公司` as Ping An life/person-insurance scope

The audit should not collapse materially distinct variants. Differences such as `2012`, `2017`, `外币版`, `互联网`, `万能型`, `分红型`, `A/B款`, and plan-code-derived variants must stay reviewable unless the same source URL or plan code proves identity.

## Responsibility Quality

Responsibility previews use the existing responsibility-extraction judgment:

- `valid_complete`
- `valid_partial`
- `invalid_empty`
- `invalid_non_responsibility`
- `suspect_needs_source_check`

Savings-style responsibility text counts as valid when it includes triggers and payment rules, such as survival benefits, annuities, education benefits, maturity benefits, death benefits, total disability benefits, premium waivers, or account-value payment rules.

Dividend allocation, cash-value tables, surrender, policy loans, and product introductions are not responsibility text unless they appear alongside real obligation text and are not the only extracted content.

## Data Flow

1. Load local Ping An records from SQLite.
2. Build local indexes by normalized product name, URL, plan code, material type, and title.
3. Load or crawl Ping An official and JRCPCX Ping An human-insurance source records.
4. For each external source record, download/archive official PDF when available.
5. Extract responsibility preview and classify quality.
6. Match external source records against local indexes.
7. Emit missing candidates and existing repair candidates.
8. Emit a summary with counts by source, match status, issue type, quality status, and PDF archive state.

## Safety Rules

- The audit is read-only for SQLite knowledge records.
- PDF archives may be written under `.runtime/policy-material-pdfs/` because they are source evidence, but no knowledge row should point to them until a later approved write step.
- Failed downloads or failed extraction must not clear local responsibility text.
- Every candidate must retain original source URLs and enough metadata to reproduce the match decision.
- Anti-bot or CAPTCHA gates stop that source segment and record the blocked URL and required user action.

## Verification

The implementation should verify:

- generated report files parse as JSON
- local Ping An record count and product count are reported
- external source count and Ping An human-insurance source count are reported
- missing candidate count and existing repair count are reported
- sampled missing candidates have source URL, product name, issuing institution, and match reason
- every candidate with `pdfLocalPath` points to an existing file
- no SQLite `knowledge_records` row count changes during audit
- crawler and audit scripts pass syntax checks

## Open Decisions Resolved

- The workflow will produce both local repair and missing-new-candidate lists.
- Missing-new candidates must include PDF archive and responsibility preview when possible.
- The first deliverable is a reviewable audit report, not direct database insertion.
