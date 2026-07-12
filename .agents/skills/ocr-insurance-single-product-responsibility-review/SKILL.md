---
name: ocr-insurance-single-product-responsibility-review
description: Use for OCR_insurance single-product manual review of insurance responsibilities and quantitative indicators from official insurer PDFs or official pages. Trigger when a product has no responsibility cards, garbled or weak pageText, user disputes whether text is an insurance responsibility, or the user says not to batch inject responsibilities and wants one-by-one policy-qa plus policy-liability-qa verification before writing SQLite or Feishu.
---

# OCR Insurance Single Product Responsibility Review

Use this skill to review exactly one insurance product at a time, split official responsibility clauses, decide indicator computability, and write only manually checked rows into the OCR_insurance development database.

## Hard Rules

- Do not batch inject responsibilities with broad rules.
- Do not treat `scripts/materialize-product-responsibility-cards.mjs` output as trusted until every generated card is manually reviewed.
- Use official insurer PDFs, official insurer pages, or regulator/industry disclosure sources only.
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
   - Download official PDF to `.runtime/tmp/`.
   - Extract text with `pypdf`.
   - Locate the real responsibility section, not the table of contents. Prefer anchors such as `在本合同有效期内`, `我们按以下约定承担保险责任`, `保险责任`, `保险金`, `年金`, `满期`, `身故`, `全残`, `医疗`, `豁免`.
   - If local `pageText` starts with escaped or garbled text such as `\376\377`, treat the local source as broken and re-extract from PDF.

3. Decide responsibilities manually.
   - Create one responsibility per clean liability name, for example `身故保险金`, `满期保险金`, `生存保险金`, `住院医疗保险金`, `豁免保险费`.
   - Reject section labels and fragments such as `保险金`, `诉讼时效受益人向我们请求给付保险金`, `未还款项我们在给付各项保险金`, `责任免除`, claim procedure text, surrender-only text, or headings without an obligation.
   - Preserve the exact official `sourceExcerpt` covering each accepted liability.

4. Decide indicator computability.
   - Scheduled returns such as maturity, survival, annuity, birthday, education, retirement, and other certain payments can be `scheduled_cashflow` when the amount and timing are computable from policy fields.
   - Death, full disability, critical illness, medical, accident, and waiver benefits are responsibility indicators but normally not fixed cashflows; use `claim_contingent` or `waiver_only`.
   - Keep table-dependent formulas structured but not directly computable. Examples:
     - `满期保险金 = 已支付保险费 × 110%`: `basisKey: total_paid_premium`, `calculationKey: percent_of_total_paid_premium`, `calculationEligible: true`.
     - `身故保险金 = max(现金价值 + 附加险现金价值, 已支付保险费 × 110%)`: `basisKey: cash_value`, `calculationKey: manual_formula`, `calculationEligible: false`, reason: needs cash value / attached-policy data.
   - Do not silently reduce a `max(...)` formula to only the paid-premium side.
   - Every stored indicator must include `basisKey`, `calculationKey`, `calculationEligible`, `calculationReason`, and `calculationMetadataVersion`.

5. Back up before writing.
   ```bash
   RUN_DIR=".runtime/single-product-responsibility-$(date +%Y%m%d-%H%M%S)"
   mkdir -p "$RUN_DIR"
   sqlite3 .runtime/local/policy-ocr.sqlite "VACUUM INTO '$RUN_DIR/policy-ocr-before.sqlite';"
   ```

6. Write only reviewed rows.
   - Update `knowledge_records.payload.pageText` only for the matching source row when PDF extraction repaired broken or incomplete text.
   - Upsert only the manually reviewed `insurance_indicator_records`.
   - Include source fields on every indicator: `sourceRecordId`, `sourceUrl`, `sourceTitle`, `sourceExcerpt`, `sourceEvidenceLevel`, `responsibilityScope`, `selectionStatus`, `selectionEvidence`.
   - Use the repo normalizer from `src/indicator-calculation.mjs` to generate calculation metadata; do not hand-write inconsistent keys.

7. Materialize and prune.
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

8. Verify.
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
