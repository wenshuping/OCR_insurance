# Product Knowledge RAG V2 Implementation Plan

> Implementation follows the approved architecture in `docs/superpowers/specs/2026-07-10-product-knowledge-rag-agent-architecture.md`. This plan covers the independently verifiable parsing, governance, indexing and retrieval slice. Agent memory is a separate follow-up plan.

**Goal:** Turn quarantined company product documents into page-level evidence, product-aware parent/child chunks and review-gated hybrid retrieval without allowing unreviewed material into formal recommendations.

**Architecture:** A deterministic ingestion service reads the stored BLOB, delegates format parsing to a narrow parser adapter, detects product candidates and document type, then atomically replaces pages and chunks. SQLite FTS5 with the trigram tokenizer provides Chinese-friendly lexical retrieval. Product matching produces candidates only; publishing remains an explicit admin action. Retrieval defaults to published evidence and returns citations, conflicts and missing-information fields.

**Tech stack:** Node.js ESM, Express, `node:sqlite`, OfficeParser for structured PDF/PPTX/DOCX/XLSX parsing, existing project authentication and test harness.

---

## Success criteria

- PDF, PPTX, DOCX, XLSX, TXT and Markdown can be normalized into page/slide/sheet-level records; legacy binary Office files and images fail safely with an actionable conversion/OCR status.
- One document can expose multiple product candidates and matching never silently overwrites an existing canonical product.
- Chunking preserves page, heading and table provenance, creates parent/child chunks and does not cut tables by raw character count.
- Reprocessing is idempotent: old pages, chunks and FTS rows are replaced transactionally.
- Default retrieval returns only `published` chunks; an explicit admin preview can include quarantined material.
- Every result contains document, page range, review status, source authority and retrieval score.
- Focused tests, `npm run check` and the full test suite pass. Existing unrelated harness findings are documented, not expanded.

## Task 1: Add the parser dependency and document parser contract

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `server/product-document-parser.service.mjs`
- Create: `tests/product-document-parser.test.mjs`

1. Add OfficeParser as a runtime dependency using the package manager so the lockfile remains authoritative.
2. Write tests for TXT/Markdown page normalization, AST page/slide/sheet normalization through an injected parser, warning preservation, and safe failures for unsupported legacy/image inputs.
3. Implement `parseProductDocument({ bytes, extension, parser })` returning:

```js
{
  parser: 'plain-text' | 'officeparser',
  documentType: 'terms' | 'product_intro' | 'training_deck' | 'rate_table' | 'unknown',
  metadata: {},
  warnings: [],
  pages: [{ pageNo, rawText, layout, tables, headings, sourceLabel }],
}
```

4. Keep OCR out of this synchronous module. For JPG/PNG and textless scanned PDFs, return a stable `PRODUCT_DOCUMENT_OCR_REQUIRED` error so a later OCR worker can resume the same job.
5. Run `node --test tests/product-document-parser.test.mjs` and commit.

## Task 2: Detect document type and product boundaries

**Files:**
- Create: `server/product-boundary.service.mjs`
- Create: `tests/product-boundary.test.mjs`

1. Add fixtures covering one product, two products in one deck, a comparison page mentioning multiple products, and generic prose with no product.
2. Implement deterministic extraction of company names, product names, product/filing codes and page ranges. Preserve all evidence pages.
3. Return candidates with `confidence`, `signals`, `pageStart`, `pageEnd`, and `relationType` (`primary`, `comparison`, or `unknown`).
4. Implement candidate matching against both the new product table and the existing knowledge catalog using this priority: exact code, canonical ID, exact company/name, then normalized-name similarity.
5. Matching returns ranked candidates and reasons; it never creates or publishes a product automatically.
6. Run focused tests and commit.

## Task 3: Implement business-aware parent/child chunking

**Files:**
- Create: `server/product-chunker.service.mjs`
- Create: `tests/product-chunker.test.mjs`

1. Test page/slide boundaries, heading paths, numbered insurance clauses, tables, long paragraphs and contextual prefixes.
2. Build one parent chunk per coherent page or section and 200–500 estimated-token child chunks, allowing up to 800 for indivisible clauses/tables.
3. Split on headings, paragraphs, sentences and numbered-list boundaries in that order. Add overlap only when forced to split inside a natural unit.
4. Repeat table headers for row-group children and record `isTable`, `sourceLabel`, and parent linkage in payload.
5. Contextual prefixes contain only deterministic metadata. Generated summaries must never be stored as evidence content.
6. Run focused tests and commit.

## Task 4: Persist pages/chunks and maintain FTS5 atomically

**Files:**
- Modify: `server/product-knowledge-store.mjs`
- Modify: `tests/product-knowledge-store.test.mjs`

1. Add a trigram-tokenized FTS5 table keyed by chunk ID and tenant ID.
2. Add store methods to replace parsed artifacts, update document parse/review state, list products, save document-product candidate links, publish/reject a document and search chunks.
3. `replaceParsedArtifacts` must delete old page/chunk/FTS rows and insert the replacement set in one transaction.
4. FTS queries must bind tenant, review status and optional product/version filters; never interpolate user input into SQL.
5. Add rollback, idempotency, tenant isolation and published-only tests.
6. Run focused tests and commit.

## Task 5: Orchestrate ingestion and expose review-gated APIs

**Files:**
- Create: `server/product-ingestion.service.mjs`
- Modify: `server/routes/product-knowledge.routes.mjs`
- Modify: `server/app.mjs`
- Modify: `tests/product-knowledge-routes.test.mjs`
- Create: `tests/product-ingestion.test.mjs`

1. Implement `ingestDocument` with explicit job transitions: `parsing`, `detecting_products`, `chunking`, `indexed_pending_review`, and stable failure states.
2. Preserve retryability and increment attempts once per run. A failed retry must not expose partial pages or chunks.
3. Add admin endpoints:

```text
POST /api/admin/product-knowledge/documents/:documentId/process
GET  /api/admin/product-knowledge/documents/:documentId/candidates
POST /api/admin/product-knowledge/documents/:documentId/review
POST /api/admin/product-knowledge/search
```

4. Review supports `publish` and `reject`. Publish requires parsed chunks and records reviewer/time. Reject removes the document from default retrieval without deleting evidence.
5. Admin search defaults to published material; `includeQuarantined: true` is explicit and response metadata marks preview mode.
6. Run route and ingestion tests and commit.

## Task 6: Build the RAG evidence-package service

**Files:**
- Create: `server/product-rag.service.mjs`
- Create: `tests/product-rag.test.mjs`
- Modify: `docs/harness-test-map.json`

1. Classify queries into exact field, clause explanation, comparison, advantage, recommendation, version history or sales guidance using deterministic signals first.
2. Retrieve lexical candidates, deduplicate child chunks, expand parents, and enforce a configurable evidence budget.
3. Return the stable package:

```js
{
  queryType,
  products: [],
  structuredFacts: [],
  evidenceChunks: [],
  conflicts: [],
  missingInformation: [],
  retrievalVersion: 'rag-v2',
}
```

4. Every evidence chunk carries a citation and separates `content` from `contextualPrefix`.
5. If no published evidence exists, return `missingInformation`; do not generate a confident answer.
6. Add all focused tests to the harness map, run `npm run check`, `npm test`, `npm run harness:audit`, and commit.

## Task 7: Document the next independent implementation slice

Create a separate Agent Context and Memory plan covering session state, summaries, long-term memory write gates, prompt-injection isolation, evidence-only generation, post-generation citation checks, and expert/sales-knowledge ingestion. Do not mix those concerns into the RAG persistence modules.
