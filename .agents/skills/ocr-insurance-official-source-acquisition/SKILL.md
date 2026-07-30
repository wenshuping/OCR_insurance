---
name: ocr-insurance-official-source-acquisition
description: Acquire exact-version official insurance clauses, product manuals, disclosure pages, PDFs, ZIPs, or raster-only terms with an auditable source manifest. Use before insurance-responsibility parsing when local source text is missing, stale, garbled, incomplete, blocked by HTTP 403/405/412/503, rendered only by JavaScript, downloadable only inside a browser session, or available only as page images requiring screenshots and OCR.
---

# OCR Insurance Official Source Acquisition

Obtain trustworthy source evidence before asking any model to parse
responsibilities. Do not let a model compensate for missing source material.

Read [references/crawler-routing.md](references/crawler-routing.md) before using a
browser fallback. Emit the contract in
[references/source-contract.md](references/source-contract.md).

## Fast Path

1. Lock exact `company`, `productName`, and version clues.
2. Search existing `knowledge_records`, archived official files, and normalized
   material URLs.
3. Reuse a local source only when its official URL, exact product title, digest,
   and readable responsibility chapter are proven.
4. Skip network retrieval when an unchanged official digest already has a
   `source_ready` manifest.
5. When a blocked URL has `alternativeSourceUrls` or `sourceCandidates` from
   verified official knowledge records, try those candidates before repeating
   browser work on the legacy URL. Keep the original URL, candidate URL, title,
   material type, and rejection reason in the source receipt.

Local cache reuse is the fastest route and must still preserve official identity.

## Company-Specific Migration: Soochow Life

For 东吴人寿 / Soochow Life, treat legacy asset URLs under
`/eportal/fileDir/cs/resource/` as a retired route. A 403 from that prefix does
not by itself mean the official material is unavailable. First use the current
official product disclosure page:

```text
https://www.soochowlife.net/cs/gkxxpl/jbxx/cpjbxx/index.html
```

Match the exact product title and version in the official product row, then
prefer the linked PDF or the canonical static equivalent under
`/cs/resource/`. Preserve both the historical URL and the discovered URL in
the receipt. A same-filename static fallback is allowed only after verifying
the official host, PDF bytes, exact product/version identity, and readable
responsibility evidence. Never replace an old version with the current one
silently: classify an unresolved version change as `version_conflict`.

Before a bulk Soochow repair, run a 20-product source-only canary (or all
available products when fewer than 20 remain). Require every canary item to
pass the normal `source_ready` gates; otherwise keep the company queue
blocked and do not start bulk repair. The successful route is official-page
rediscovery and static-path migration, not repeated direct requests or access
control bypassing.

## Retrieval Ladder

Escalate one layer at a time and stop after the first layer that proves the exact
official material:

1. Existing insurer-specific `npm run crawl:*knowledge` adapter.
2. Direct official API, static HTML, PDF, or ZIP request.
3. `$insurance-official-headless-pdf` for public insurer disclosure pages that
   require real Chrome, JavaScript product-link discovery, browser-context PDF
   download, or standard PDF encryption handling.
4. Rendered Browser/Chrome session for JavaScript, cookies, or browser-context
   downloads.
5. Existing CDP or cloakbrowser company runner for public anti-bot pages.
6. crawl4ai for complex public SPA pagination or structured extraction.
7. firecrawl for official-site discovery across a large public section.
8. `$jrcpcx-pipe-backfill` as a source-only final fallback after all insurer-owned
   routes above fail for the exact product/version. Query the public JRCPCX
   platform by exact company and product; accept only the matching human-
   insurance detail's `clauseInfo` terms PDF from a verified industry official
   asset host such as `inspdinfo.iachina.cn`.

Use search results only to discover official URLs. Never use third-party wording
as responsibility evidence.

### JRCPCX final fallback evidence

JRCPCX is not an insurer-website substitute and must never be attempted before
the official cache/API/real-Chrome-headless/Browser/CDP/crawler ladder is
exhausted. It is allowed only for public source repair, with no model parsing,
SQLite writes, Feishu writes, or publication in the source-only phase.

For a JRCPCX source candidate, record every failed official route and use
`retrievalMethod=jrcpcx_industry_terms` and
`evidenceLevel=regulatory_industry_terms`. Require an exact company, product,
and version match; `%PDF-` magic bytes; preserved bytes and SHA-256; and a
readable responsibility chapter. A list row, product introduction, missing or
unmatched `clauseInfo`, or version mismatch is `source_candidate`, never
`source_ready`. Stop with `source_blocked` on a slider, `code=700`, login,
congestion/verification page, invalid bytes, or missing/unreadable responsibility
text. Do not bypass verification.

## Encrypted Official PDFs

Invoke `$insurance-official-headless-pdf` before placing an official PDF in
`source-retry` merely because `pypdf` reports AES encryption or the current
runtime lacks a PDF crypto dependency.

- Preserve the original downloaded bytes and SHA-256 before decryption.
- Verify the official domain, `%PDF-` magic bytes, exact product/version, and
  responsibility chapter.
- For standard PDF encryption, try only the empty user password
  (`PdfReader.decrypt("")`). Record that the source is encrypted and whether the
  empty password succeeded.
- Never brute-force a password. If a non-empty authorized password is required,
  keep the source `source_blocked` and record that exact blocker.
- If decryption succeeds but the text layer is empty or garbled, render only the
  affected pages and use the screenshot/OCR route below.
- Write a `source-contract.json` with retrieval route, source digest, page count,
  encryption metadata, extracted text path, and responsibility pages.

A missing local crypto package is an environment repair condition, not evidence
that the public official source is unavailable. Do not fabricate an artifact or
silently substitute a third-party PDF.

## Handle 403 And Rendered Pages

- Treat HTTP 403/405/412 as a routing signal, not immediate proof that the public
  material is unavailable.
- Open the same official URL in the available Browser or Chrome skill.
- Record final URL, visible product/version identity, rendered title, retrieval
  time, and a screenshot when the rendered page proves official content or a
  blocker.
- Prefer network-discovered official PDF/ZIP URLs over OCR of rendered prose.
- Prefer a verified same-company, same-product alternative PDF already present
  in the local official knowledge records when the legacy asset URL is blocked.
  Candidate bytes still require the full official-host, exact-identity,
  responsibility-chapter, and SHA-256 gates; a matching product name alone is
  not enough.
- Download official bytes inside the browser context when direct download is
  blocked. Verify PDF magic bytes or ZIP structure and calculate SHA-256.
- Use cloakbrowser only for public official content that renders in an ordinary
  browser but rejects direct automation.
- Stop at CAPTCHA, slider verification, SMS, account login, private policy pages,
  or unproven download bytes. Record `source_blocked`; do not automate around the
  access control.

Screenshots prove what rendered. They are not a substitute for downloadable
official text when official PDF/HTML bytes are available.

## Screenshot And OCR Route

Use screenshot OCR only when the official page or terms document is genuinely
raster-only:

1. Capture full-resolution page screenshots with stable page numbers.
2. Preserve the original images unchanged.
3. OCR each page independently and keep page-to-text mapping.
4. Locate the complete responsibility chapter plus directly referenced formula
   tables and definitions.
5. Compare every number, percentage, age boundary, and negation against the
   screenshot.
6. Mark the source `ocr_needs_review` when OCR confidence is uncertain or a table
   cannot be reconstructed reliably.

Do not crop away headings, page numbers, table headers, or continuation context
needed to prove responsibility boundaries.

## Source Quality Gate

Return `source_ready` only when all are true:

- Host is insurer-owned, regulator-owned, or a verified official asset host.
- Exact company, product name, and version are supported.
- Source bytes or rendered evidence are preserved.
- Responsibility chapter is readable and bounded.
- Referenced formula tables and continuation pages are retained.
- SHA-256 and retrieval method are recorded.
- No unresolved CAPTCHA, login, unofficial-source, or cross-version blocker
  remains.

Otherwise return `source_blocked` or `ocr_needs_review`. Responsibility parsing
must not start from those statuses automatically.

## Safety And Writes

- Keep acquisition read-only until the user authorizes persistence.
- Use a user-specified run directory; otherwise use a unique `/tmp` directory.
- Do not write SQLite, Feishu, production, or `.runtime` merely to prove a source.
- Parallelize independent product discovery and extraction only. Never run
  parallel SQLite or Feishu writes.

## Final Report

Report the manifest path, status, selected retrieval layer, official URL, source
digest, extracted responsibility text path, screenshot paths when used, rejected
alternatives, and blockers. Do not claim responsibility parsing is complete.
