# Structured Responsibility RAG Governance Design

## Context

The customer responsibility summary flow already stores generated summaries in
`product_customer_responsibility_summaries` and reads local official materials
from `knowledge_records`, `product_responsibility_cards`, and
`insurance_indicator_records`.

Recent product tests exposed two root causes behind unstable summaries:

- The current prompt can receive truncated or noisy responsibility excerpts.
  For example, a critical illness product lost the later `身故保险金`,
  `少儿前10年关爱保险金`, and `豁免保险费` clauses when only a short
  `pageText` excerpt was used.
- The model is not consistently routed by product category. DeepSeek can
  understand formulas such as `基本保险金额×(1+3.5%)^(n-1)`, but the system
  does not always force an incremental whole life template to explain annual
  compound growth or a critical illness template to check all disease, death,
  care, and waiver responsibilities.

The new design builds a structured, insurance-specific RAG layer before model
generation. It retrieves official materials, extracts complete responsibility
sections, routes by product category, generates with a category template, then
quality-gates the result before writing a ready customer summary cache.

## Goals

- Generate customer-readable insurance responsibility summaries from complete
  official responsibility context, not partial snippets.
- Route products through category-specific templates for incremental whole life,
  participating life, annuity, critical illness, medical, accident, endowment,
  term life, whole life, universal life, and investment-linked products.
- Use local quality gates to catch missing responsibilities, missing formulas,
  product-function/insurance-responsibility mixing, and unsupported model
  claims.
- Keep the existing customer summary API shape usable by the frontend.
- Introduce a new summary version so old cached summaries remain available for
  rollback.
- Support a second-phase batch governance workflow with run records, reports,
  and reviewable failures.

## Non-Goals

- Do not rewrite OCR extraction or policy recognition in this project slice.
- Do not replace existing responsibility cards or indicator records.
- Do not expose internal quality metadata in customer-facing UI.
- Do not use third-party articles or broker content as responsibility source
  evidence.
- Do not calculate exact claim amounts when the amount depends on a policy
  value table, disease definition, cash value, account value, or claim facts.

## Proposed Approach

Build the full governance target, but implement it in two phases.

### C1: Realtime Structured Generation

C1 improves the existing realtime endpoint:

```text
POST /api/policy-responsibilities/customer-summary
→ lookup v22 ready summary
→ resolve official materials
→ extract responsibility sections
→ classify product category
→ choose category template and model tier
→ generate DeepSeek JSON
→ run local quality gates
→ persist ready summary or generation failure
→ return customer summary
```

The endpoint keeps returning the existing customer-safe summary shape. Internal
fields such as source section digests, model tier, category, and quality-gate
results are stored in the row payload or run records.

### C2: Batch Governance

C2 adds batch rewriting and reporting:

```text
npm run responsibility-summary:backfill -- --version v22 --limit 100
```

The batch process skips products with an unchanged source digest and ready v22
summary, generates missing or stale summaries, writes run records, and produces
reports grouped by company, product category, model tier, status, and failure
reason.

## Architecture

### 1. Responsibility Source Resolver

Purpose: find official materials for one product.

Input:

- `company`
- `productName`
- optional already-loaded state records

Output:

```json
{
  "productKey": "company_product:新华保险:产品名",
  "records": [
    {
      "title": "官方条款",
      "url": "https://...",
      "materialType": "terms",
      "official": true,
      "pageText": "..."
    }
  ]
}
```

Rules:

- Prefer official terms PDFs.
- Use product manuals when they include concrete responsibility text.
- Keep existing `knowledge_records` as a source index and fallback text source.
- Reject non-official sources for ready customer summaries.

### 2. Responsibility Section Extractor

Purpose: turn official PDF/text materials into complete, bounded responsibility
context.

The extractor should prefer full PDF text extraction when a source URL points to
a PDF. Existing `pageText` is useful as fallback, but it must not be the only
source for complex products when a PDF URL is available.

Extraction steps:

1. Normalize whitespace while preserving heading boundaries where possible.
2. Detect chapter headings instead of simple substring boundaries.
3. Extract the main responsibility chapter.
4. Add category-specific supplement sections.
5. Compute extraction quality and warnings.

Heading detection must avoid the bug where:

```text
轻度疾病、中度疾病或重度疾病（详见本合同利益条款第六条）
```

is mistaken for the next chapter heading. Boundaries should match heading-like
patterns such as line starts, article numbering, and title text:

```text
第五条 保险责任
第六条 本合同保障的疾病列表
2.3 保险责任
2.4 责任免除
```

Example output:

```json
{
  "mainResponsibilityText": "...第五条保险责任完整正文...",
  "supplementSections": [
    {
      "type": "disease_list_overview",
      "text": "轻度疾病40项，中度疾病20项，重度疾病130项，分5组..."
    }
  ],
  "quality": {
    "status": "complete",
    "warnings": []
  }
}
```

Category supplements:

- Critical illness: include disease-list overview counts, grouping, and named
  special disease sets, but not full disease definitions.
- Annuity: include basic responsibility and optional responsibility sections.
- Participating products: include dividend section summary, especially whether
  dividends are annual/terminal, additive sum assured, or otherwise uncertain.
- Universal/investment-linked: include account value, settlement rate,
  guaranteed rate, fees, and risk disclosures when present.

### 3. Product Category Router

Purpose: decide the product template and model tier.

Signals:

- product name
- `knowledge_records.productType`
- `insurance_indicator_records.productType`
- official responsibility text keywords
- responsibility card titles

Output:

```json
{
  "productCategory": "critical_illness",
  "categoryLabel": "重大疾病保险",
  "featureTags": ["children", "multi_pay", "disease_grouping"],
  "modelTier": "pro"
}
```

Initial categories:

- `incremental_whole_life`
- `ordinary_whole_life`
- `term_life`
- `annuity`
- `endowment`
- `critical_illness`
- `medical`
- `accident`
- `long_term_care`
- `universal_life`
- `investment_linked`
- `participating_life`
- `other`

Model routing:

- Use Flash for simple short life and accident products.
- Use Pro for critical illness, annuity, participating, universal,
  investment-linked, endowment, long clauses, optional responsibilities, disease
  grouping, account value, cumulative dividend sum assured, or formulas with
  `以下二者/三者`.
- Retry with Pro when Flash fails quality gates.

### 4. Responsibility Summary Generator

Purpose: call DeepSeek with a category-specific prompt and normalize the result.

The generator receives:

- product identity
- category routing result
- source sections
- responsibility cards and indicators as supporting evidence

Unified output:

```json
{
  "productCategory": "",
  "categoryLabel": "",
  "headline": "",
  "responsibilities": [
    {
      "title": "",
      "plainText": "",
      "triggerCondition": "",
      "paymentRule": "",
      "calculationStatus": ""
    }
  ],
  "productFunctions": [],
  "importantNotes": [],
  "missingOrUnclear": []
}
```

This output maps into the existing customer summary shape:

```json
{
  "headline": "",
  "mainResponsibilities": [
    {
      "title": "",
      "plainText": "",
      "howItPays": "",
      "requiredPolicyFields": []
    }
  ],
  "notices": []
}
```

### 5. Summary Quality Gate

Purpose: decide whether a generated summary is customer-displayable.

Gate layers:

1. Structure gate: JSON parses, required arrays exist, responsibilities are not
   empty.
2. Category gate: category-required responsibility keywords are present or
   explicitly justified as missing.
3. Source gate: every responsibility title is supported by source text or a
   known synonym mapping.
4. Safety gate: product functions such as dividends, loans, cash value
   management, partial withdrawals, and beneficiary designation are not mixed
   into the insurance responsibility list.
5. Formula gate: formulas present in source text are either preserved or
   accurately explained.

Failure routing:

```text
Flash failed → retry Pro
Pro failed → needs_model_review
source missing → needs_source_review
section extraction incomplete → needs_extraction_review
invalid JSON → retry once
```

The existing fallback that returns a long `保险责任正文` as a customer summary
should be retired for the v22 flow. A customer-visible ready summary must be
structured. Long official text can remain in diagnostic payloads and review
records.

## Category Template Requirements

### Incremental Whole Life

Must check:

- death or total disability
- effective sum assured / compound growth formula
- cash value comparison item
- payment coefficients and age bands
- public transport or other accident extras
- dividend uncertainty when participating

Quality keywords:

```text
身故
全残
基本保险金额
现金价值
给付系数
复利递增
(1+X%)^(n-1)
```

Required function notes:

- Explain annual compound growth when source has a formula such as
  `基本保险金额×(1+3.5%)^(n-1)`.
- State that compound growth is a claim calculation basis, not guaranteed cash
  value growth or actual yield.
- Keep cash value, loan, reduction, and beneficiary features in
  `productFunctions`, not `responsibilities`.

### Annuity

Must check:

- annuity or care annuity names
- survival benefit
- start date, frequency, and payment basis
- death benefit
- optional responsibilities
- participating dividend uncertainty when present

Quality keywords:

```text
年金
生存保险金
身故保险金
领取日
保单周年日
可选责任
累积红利保险金额
```

### Critical Illness

Must check:

- waiting period
- mild, moderate, and severe disease benefits
- disease counts and groups
- payment percentages
- single-group and cumulative limits
- repeated severe disease rules and intervals
- death benefit
- waiver
- child care or adult accident-specific care benefits when present

Quality keywords:

```text
等待期
轻度疾病保险金
中度疾病保险金
重度疾病保险金
身故保险金
豁免保险费
关爱保险金
给付特别约定
累计给付限额
```

The prompt must instruct the model not to expand full disease definitions.

### Medical

Must check:

- inpatient, outpatient, special drug, proton/heavy ion, or other medical
  responsibilities
- deductible
- reimbursement ratio
- annual limit
- social-insurance status
- waiting period
- renewal conditions

Quality keywords:

```text
医疗保险金
住院
门诊
免赔额
赔付比例
年度限额
社保
等待期
```

### Accident

Must check:

- accidental death
- accidental disability
- accidental medical
- traffic accident extras
- sudden death only when explicitly present
- disability schedule dependency

Quality keywords:

```text
意外身故
意外伤残
意外医疗
伤残等级
交通工具
猝死
```

### Endowment

Must check:

- maturity benefit
- death or total disability
- survival or birthday/longevity benefits when present
- waiting period
- return basis

Quality keywords:

```text
满期保险金
身故保险金
全残保险金
生存保险金
已交保险费
基本保险金额
```

### Term Life and Ordinary Whole Life

Must check:

- death
- total disability
- waiting period
- age bands
- paid premium / basic sum assured / cash value comparison
- insurance period

Quality keywords:

```text
身故
全残
等待期
基本保险金额
已交保险费
现金价值
```

### Universal and Investment-Linked

First version should be conservative:

- death benefit
- account value
- settlement or credited rate
- guaranteed rate when present
- fees
- investment risk
- no promise of actual yield

Quality keywords:

```text
账户价值
身故保险金
结算利率
保证利率
费用
投资风险
```

## Data Model

Continue using `product_customer_responsibility_summaries` for ready customer
summaries, with a new version:

```text
customer-summary-v22-structured-rag
```

Implementation should use the full string above as the persisted
`summary_version`. CLI scripts may accept `v22` as a human-friendly alias, but
must resolve it to `customer-summary-v22-structured-rag` before reads or writes.

Store internal metadata in `payload`:

```json
{
  "productCategory": "critical_illness",
  "categoryLabel": "重大疾病保险",
  "featureTags": ["children", "multi_pay"],
  "sourceSectionsDigest": "...",
  "sourceSections": [],
  "modelTier": "pro",
  "qualityGate": {
    "status": "passed",
    "warnings": []
  }
}
```

Add a governance table for generation attempts:

```text
product_customer_summary_generation_runs
```

Suggested columns:

- `id TEXT PRIMARY KEY`
- `product_key TEXT NOT NULL`
- `company TEXT`
- `product_name TEXT`
- `summary_version TEXT NOT NULL`
- `status TEXT NOT NULL`
- `product_category TEXT`
- `category_label TEXT`
- `model_provider TEXT`
- `model_name TEXT`
- `model_tier TEXT`
- `source_digest TEXT`
- `source_sections_digest TEXT`
- `quality_issues_json TEXT NOT NULL DEFAULT '[]'`
- `raw_preview TEXT`
- `created_at TEXT`
- `payload TEXT NOT NULL`

Run statuses:

- `passed`
- `needs_source_review`
- `needs_extraction_review`
- `needs_model_review`
- `failed`

Only `ready` rows in `product_customer_responsibility_summaries` are shown to
customers.

## Error Handling

Customer-facing failures should stay simple:

```text
这个产品的保险责任资料需要进一步核验，请稍后再试。
```

Internal statuses:

- `needs_source_review`: no official responsibility source.
- `needs_extraction_review`: official source exists, but bounded
  responsibility extraction is incomplete.
- `needs_model_review`: model output failed Flash/Pro quality gates.
- `failed`: network, API, or unexpected runtime failure.

Do not write a customer-ready row for any failed status.

## Verification

C1 focused product cases:

- `新华人寿保险股份有限公司鑫荣耀终身寿险`
  - category: incremental whole life
  - must explain 3.5% annual compound growth
  - must include public transport accident extra 1.5x basic amount
- `新华人寿保险股份有限公司盛世荣耀臻享版终身寿险（分红型）`
  - category: participating incremental whole life
  - must explain 1.75% annual compound growth
  - must state dividend uncertainty
- `尊贵人生年金保险(分红型)`
  - category: annuity participating
  - must include care annuity, survival benefit, death benefit, optional
    birthday/longevity benefit, optional death/total disability, and dividend
    uncertainty
- `新华人寿保险股份有限公司多倍保障少儿重大疾病保险（超越版）`
  - category: critical illness
  - must include waiting period, mild/moderate/severe disease benefits, disease
    grouping/limits, death benefit, child first-10-years care benefit, adult
    accident-specific care benefit, and premium waiver

C2 focused tests:

- batch job skips ready v22 rows when source digest is unchanged
- batch job writes generation run records for pass and fail
- Flash failure upgrades to Pro in a mocked generation path
- old v21 summaries remain untouched
- no customer-visible summary is written when the quality gate fails

Required verification for implementation:

- `npm run check`
- focused tests around `product-customer-responsibility-summary`
- focused extractor/router/gate tests added with implementation
- `npm test` before completing cross-cutting C2 work

## Rollout

C1 rollout:

1. Add extractor, router, templates, and quality gate behind v22.
2. Keep v21 rows untouched.
3. Generate v22 on realtime query when no ready v22 row exists.
4. Log raw model response shape and quality-gate result.
5. Validate the four seed products before broader use.

C2 rollout:

1. Add batch backfill script with `--limit`, `--company`, `--category`, and
   `--dry-run`.
2. Write run records and a console/report summary.
3. Run small batches by category.
4. Review `needs_*_review` products.
5. Increase batch size after failure patterns are understood.

## Open Decisions

- Whether C1 should persist failed generation runs immediately or only after C2
  introduces the governance table. Recommendation: persist in C1 so debugging
  starts early.
- Whether realtime queries should ever fall back to v21 when v22 generation
  fails. Recommendation: use v21 only if it already exists and is ready, but do
  not create a new v21 fallback row.
