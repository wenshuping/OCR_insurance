---
name: ocr-insurance-single-product-responsibility-review
description: Use for OCR_insurance single-product review of insurance responsibilities and quantitative indicators from exact-version official insurer evidence. Trigger when a product has no responsibility cards, official pages return 403, source material requires browser screenshots or OCR, pageText is garbled or weak, model parses disagree, or the user wants one-by-one source acquisition, bounded extraction, merge validation, and controlled SQLite or Feishu publication.
---

# OCR Insurance Single Product Responsibility Review

Use this skill to review exactly one insurance product at a time, split official responsibility clauses, decide indicator computability, and write only manually checked rows into the OCR_insurance development database.

## Hard Rules

- Do not batch inject responsibilities with broad rules.
- Do not treat `scripts/materialize-product-responsibility-cards.mjs` output as trusted until every generated card is manually reviewed.
- Use official insurer PDFs, official insurer pages, or regulator/industry disclosure sources only.
- Acquire and prove the exact-version source with
  `$ocr-insurance-official-source-acquisition` before responsibility parsing.
- Use `$ocr-insurance-fast-responsibility-pipeline` for bounded model extraction,
  merge routing, and deterministic gates.
- Apply `policy-qa` source discipline: keep source URL, product name, company, title, access/extraction evidence, and exact excerpt.
- Apply `policy-liability-qa` responsibility threshold: accepted text must include a covered event/condition and the insurer obligation to pay, reimburse, waive, or provide a benefit.
- For code or DB writes, follow `karpathy-guidelines`, project `AGENTS.md`, and create a SQLite backup first.
- Write the development DB unless the user explicitly names production: `.runtime/local/policy-ocr.sqlite`.
- If the user asks Feishu too, write local first, then sync Feishu and prove readback separately. Never claim Feishu is done without readback.
- Keep customer-facing policy responsibility text separate from internal indicator validation.
  - Customer-facing output may show product summary, covered event/condition, benefit/payment explanation, limits, exclusions, and official source.
  - Do not show `indicatorCheckStatus`, `indicatorCheckIssues`, `basisKey`, `calculationKey`, `calculationEligible`, `calculationStatus`, `calculationReason`, `needs_table`, or phrases such as `指标核对`, `结构化指标`, `现金流测算`, `需表格`.
  - Internal verification reports may include those fields, but label them as internal and keep them out of policy responsibility copy shown to customers.

## Single Product Workflow

1. Lock the product scope.
   - Identify exact `company`, `product_name`, and official URL.
   - Query local rows before changing anything:
     ```bash
     sqlite3 .runtime/local/policy-ocr.sqlite "
       select count(*) from product_responsibility_cards where company='<公司>' and product_name='<产品>';
       select id, url, length(json_extract(payload,'$.pageText')) from knowledge_records where company='<公司>' and product_name='<产品>';
       select id, liability, coverage_type from insurance_indicator_records where company='<公司>' and product_name='<产品>';
     "
     ```

2. Inspect the official source directly.
   - Reuse a valid unchanged local official source before making network calls.
   - Run the matching company `crawl:*knowledge` adapter when available.
   - For 403, JavaScript, or browser-context downloads, follow
     `$ocr-insurance-official-source-acquisition`; capture rendered screenshots
     and official bytes, and stop at CAPTCHA/SMS/login.
   - Save temporary review evidence under `/tmp` unless the user authorizes a
     run directory under `.runtime`.
   - Extract official text locally with `pypdf` or the existing project
     extractor.
   - Locate the real responsibility section, not the table of contents. Prefer anchors such as `在本合同有效期内`, `我们按以下约定承担保险责任`, `保险责任`, `保险金`, `年金`, `满期`, `身故`, `全残`, `医疗`, `豁免`.
   - If local `pageText` starts with escaped or garbled text such as `\376\377`, treat the local source as broken and re-extract from PDF.
   - Do not continue until the source manifest is `source_ready`.

3. Build and merge responsibility proposals.
   - Follow the fast pipeline extraction contract: lock the official title and
     section-boundary inventory before extracting facts or formulas.
   - Build one bounded packet per responsibility with stable ID, source digest,
     exact offsets, continuation ranges, applicable shared clauses, and directly
     referenced definitions/tables.
   - When a local candidate assistant is configured, use it to add page, title,
     clause-label, risk-signal, and exact-span candidates before online model
     calls. Never let it remove deterministic or referenced evidence.
   - Run separate low-cost proposals for coverage facts and calculation
     structure against the bounded packets. Generate customer wording only from
     validated structured facts.
   - Programmatically auto-merge responsibilities that pass all gates. Send only
     unresolved responsibility packets to the configured verifier, and reserve
     the high-capability reviewer for unresolved semantic or package-boundary
     conflicts.
   - Send missing pages, damaged tables, and unreadable OCR back to source
     repair, not to a stronger merge model.
   - Apply `$ocr-insurance-responsibility-merge` for the final artifact.

4. Decide responsibilities manually.
   - Create one responsibility per clean liability name, for example `身故保险金`, `满期保险金`, `生存保险金`, `住院医疗保险金`, `豁免保险费`.
   - Reject section labels and fragments such as `保险金`, `诉讼时效受益人向我们请求给付保险金`, `未还款项我们在给付各项保险金`, `责任免除`, claim procedure text, surrender-only text, or headings without an obligation.
   - Preserve the exact official `sourceExcerpt` covering each accepted liability.

5. Decide indicator computability.
   - Scheduled returns such as maturity, survival, annuity, birthday, education, retirement, and other certain payments can be `scheduled_cashflow` when the amount and timing are computable from policy fields.
   - Death, full disability, critical illness, medical, accident, and waiver benefits are responsibility indicators but normally not fixed cashflows; use `claim_contingent` or `waiver_only`.
   - Keep table-dependent formulas structured but not directly computable. Examples:
     - `满期保险金 = 已支付保险费 × 110%`: `basisKey: total_paid_premium`, `calculationKey: percent_of_total_paid_premium`, `calculationEligible: true`.
     - `身故保险金 = max(现金价值 + 附加险现金价值, 已支付保险费 × 110%)`: `basisKey: cash_value`, `calculationKey: manual_formula`, `calculationEligible: false`, reason: needs cash value / attached-policy data.
   - Do not silently reduce a `max(...)` formula to only the paid-premium side.
   - Every stored indicator must include `basisKey`, `calculationKey`, `calculationEligible`, `calculationReason`, and `calculationMetadataVersion`.
   - Use only canonical `requiredInputs` from
     `src/indicator-calculation.mjs`; reject plausible but unknown aliases.
   - Require `basis` to describe formula inputs rather than trigger conditions.

6. Back up before writing.
   ```bash
   RUN_DIR=".runtime/single-product-responsibility-$(date +%Y%m%d-%H%M%S)"
   mkdir -p "$RUN_DIR"
   sqlite3 .runtime/local/policy-ocr.sqlite "VACUUM INTO '$RUN_DIR/policy-ocr-before.sqlite';"
   ```

7. Write only reviewed rows.
   - Update `knowledge_records.payload.pageText` only for the matching source row when PDF extraction repaired broken or incomplete text.
   - Upsert only the manually reviewed `insurance_indicator_records`.
   - Include source fields on every indicator: `sourceRecordId`, `sourceUrl`, `sourceTitle`, `sourceExcerpt`, `sourceEvidenceLevel`, `responsibilityScope`, `selectionStatus`, `selectionEvidence`.
   - Use the repo normalizer from `src/indicator-calculation.mjs` to generate calculation metadata; do not hand-write inconsistent keys.

8. Materialize and prune.
   - Run materialization only for the product:
     ```bash
     node scripts/materialize-product-responsibility-cards.mjs \
       --db-path=.runtime/local/policy-ocr.sqlite \
       --company='<公司>' \
       --product-name='<产品>' \
       --write \
       --sample-limit=20
     ```
   - Immediately inspect generated cards.
   - Delete any card not manually accepted. The final product card count must equal the reviewed responsibility list, not the raw materializer output.

9. Verify.
   - Read back final cards:
     ```bash
     sqlite3 .runtime/local/policy-ocr.sqlite "
       select title, category, cashflow_treatment, calculation_status, calculation_reason,
              json_extract(payload,'$.indicatorCheckStatus'),
              json_extract(payload,'$.indicatorCheckSummary')
         from product_responsibility_cards
        where company='<公司>' and product_name='<产品>'
        order by title;
     "
     ```
   - Read back indicators and confirm formulas/source excerpts.
   - Run computability audit for the DB and ensure no metadata drift for the written rows.
   - Confirm every important limit is supported by that responsibility's exact
     excerpt or page-specific evidence segment.
   - Confirm final excerpts contain no OCR/PDF extraction page markers.
   - If code changed, run focused tests plus `npm run check`.

## Final Report

For customer-facing responsibility output, report these items:

- What type of product this is and what need it solves.
- The main covered responsibilities in plain language.
- Benefit/payment method and important limits.
- Major exclusions or waiting-period limits when relevant.
- Official source URL or title.

For internal verification output, report these items separately:

- Product and company.
- Official source URL and PDF/page title.
- Whether local `pageText` was repaired.
- Accepted responsibilities and rejected fragments.
- Indicator table with formula, `cashflowTreatment`, `calculationStatus`, and `indicatorCheckStatus`.
- Exact DB path written.
- Backup path.
- Verification commands/results.
- Feishu status separately if requested.
