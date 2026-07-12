# Structured Responsibility RAG Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a structured, insurance-specific responsibility RAG generation path that extracts complete official responsibility sections, routes by product category, generates customer summaries with DeepSeek Flash/Pro, quality-gates the output, and records governance runs.

**Architecture:** Add focused server modules for source resolution, section extraction, category routing, prompt/template generation, and summary quality gates. Wire them into the existing `generateProductCustomerResponsibilitySummary` path behind a new `customer-summary-v22-structured-rag` version, then add a batch backfill script and governance run persistence for C2.

**Tech Stack:** Node.js ESM `.mjs`, built-in `node:test`, SQLite via `node:sqlite`, existing Express routes and SQLite state store, DeepSeek chat completions API.

---

## File Structure

Create these focused modules:

- `server/responsibility-source-resolver.mjs`  
  Finds official source records for one company/product pair and ranks terms PDFs ahead of product manuals.

- `server/responsibility-section-extractor.mjs`  
  Extracts bounded responsibility sections from official text or full PDF text. It owns chapter-heading detection, category supplements, source-section digests, and extraction quality warnings.

- `server/insurance-product-category-router.mjs`  
  Classifies products into category labels and model tiers using product name, product types, indicators, cards, and extracted source text.

- `server/responsibility-summary-templates.mjs`  
  Builds category-specific DeepSeek prompts and exposes category-required keyword rules.

- `server/responsibility-summary-quality-gate.mjs`  
  Validates model output against schema, category coverage, source support, safety separation, and formulas.

Modify these existing files:

- `server/product-customer-responsibility-summary.service.mjs`  
  Switch the active version to `customer-summary-v22-structured-rag`, build structured context, call category templates, apply quality gates, retry/upgrade models, and stop writing long raw official text fallback summaries as ready v22 rows.

- `server/sqlite-state-store.mjs`  
  Add `product_customer_summary_generation_runs`, plus persistence/read helpers for generation runs.

- `server/routes/responsibilities.routes.mjs`  
  Keep route shape stable; pass store helpers into the summary service.

- `package.json`  
  Add a C2 batch command for summary backfill.

- `scripts/backfill-product-customer-responsibility-summaries.mjs`  
  Batch-generate v22 summaries with `--limit`, `--company`, `--category`, and `--dry-run`.

Add or extend tests:

- `tests/responsibility-section-extractor.test.mjs`
- `tests/insurance-product-category-router.test.mjs`
- `tests/responsibility-summary-quality-gate.test.mjs`
- `tests/product-customer-responsibility-summary.test.mjs`
- `tests/sqlite-state-store.test.mjs`
- `tests/backfill-product-customer-responsibility-summaries.test.mjs`

---

### Task 1: Add Structured Source Resolver

**Files:**
- Create: `server/responsibility-source-resolver.mjs`
- Test: `tests/responsibility-source-resolver.test.mjs`

- [ ] **Step 1: Write resolver tests**

Create `tests/responsibility-source-resolver.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveOfficialResponsibilitySources,
} from '../server/responsibility-source-resolver.mjs';

test('resolveOfficialResponsibilitySources prefers official terms pdfs over manuals', () => {
  const result = resolveOfficialResponsibilitySources({
    company: '新华保险',
    productName: '鑫荣耀终身寿险',
    records: [
      {
        id: 2,
        company: '新华保险',
        productName: '新华人寿保险股份有限公司鑫荣耀终身寿险',
        title: '产品说明书',
        materialType: 'product_manual',
        official: true,
        url: 'https://static-cdn.newchinalife.com/manual.pdf',
        pageText: '保险责任 产品说明书责任正文',
      },
      {
        id: 1,
        company: '新华保险',
        productName: '新华人寿保险股份有限公司鑫荣耀终身寿险',
        title: '条款',
        materialType: 'terms',
        official: true,
        url: 'https://static-cdn.newchinalife.com/terms.pdf',
        pageText: '保险责任 条款责任正文',
      },
    ],
  });

  assert.equal(result.productKey, 'company_product:新华保险:新华人寿保险股份有限公司鑫荣耀终身寿险');
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].materialType, 'terms');
  assert.equal(result.records[0].url, 'https://static-cdn.newchinalife.com/terms.pdf');
});

test('resolveOfficialResponsibilitySources rejects non-official records for ready summaries', () => {
  const result = resolveOfficialResponsibilitySources({
    company: '新华保险',
    productName: '测试产品',
    records: [
      {
        company: '新华保险',
        productName: '测试产品',
        official: false,
        url: 'https://example.test/article',
        pageText: '保险责任 来自第三方',
      },
    ],
  });

  assert.equal(result.records.length, 0);
  assert.equal(result.status, 'needs_source_review');
});
```

- [ ] **Step 2: Run resolver tests and verify failure**

Run:

```bash
node --test tests/responsibility-source-resolver.test.mjs
```

Expected: fail with module not found for `server/responsibility-source-resolver.mjs`.

- [ ] **Step 3: Implement resolver**

Create `server/responsibility-source-resolver.mjs`:

```js
function text(value) {
  return String(value ?? '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function comparable(value) {
  return text(value).replace(/[\s《》（）()【】\[\]·,，。:：;；、-]/gu, '');
}

function productNameMatches(candidate, query) {
  const left = comparable(candidate);
  const right = comparable(query);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

function productKeyFor(company, productName) {
  return `company_product:${text(company)}:${text(productName)}`;
}

function materialRank(record = {}) {
  const materialType = text(record.materialType || record.material_type).toLowerCase();
  const title = text(record.title);
  const url = text(record.url);
  if (materialType === 'terms' || /条款/u.test(title)) return 0;
  if (materialType === 'product_manual' || /说明书/u.test(title)) return 1;
  if (/\.pdf(?:$|\?)/iu.test(url)) return 2;
  return 3;
}

function hasResponsibilityText(record = {}) {
  return /保险责任|给付|保险金|年金|豁免/u.test(text(record.pageText || record.responsibilityText || record.content));
}

function isOfficial(record = {}) {
  if (record.official === true) return true;
  const url = text(record.url);
  return /(?:newchinalife\.com|pingan\.com|chinalife\.com|cpic\.com|picc\.com)/iu.test(url);
}

function preferredProductName({ inputProductName, records }) {
  const counts = new Map();
  for (const record of records) {
    const name = text(record.productName || record.product_name || record.title);
    if (!name || !productNameMatches(name, inputProductName)) continue;
    counts.set(name, (counts.get(name) || 0) + (materialRank(record) === 0 ? 4 : 2));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0] || text(inputProductName);
}

export function resolveOfficialResponsibilitySources({
  company = '',
  productName = '',
  records = [],
} = {}) {
  const resolvedCompany = text(company);
  const inputProductName = text(productName);
  const matched = normalizeArray(records)
    .filter((record) => text(record.company || record.companyName) === resolvedCompany)
    .filter((record) => productNameMatches(record.productName || record.product_name || record.title, inputProductName))
    .filter((record) => isOfficial(record))
    .filter((record) => text(record.url) || hasResponsibilityText(record))
    .sort((left, right) => materialRank(left) - materialRank(right) || text(right.pageText).length - text(left.pageText).length);

  const officialWithResponsibility = matched.filter(hasResponsibilityText);
  const product = preferredProductName({ inputProductName, records: matched });

  return {
    productKey: productKeyFor(resolvedCompany, product),
    company: resolvedCompany,
    productName: product,
    records: officialWithResponsibility,
    status: officialWithResponsibility.length ? 'ready' : 'needs_source_review',
  };
}
```

- [ ] **Step 4: Run resolver tests and verify pass**

Run:

```bash
node --test tests/responsibility-source-resolver.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit resolver**

Run:

```bash
git add server/responsibility-source-resolver.mjs tests/responsibility-source-resolver.test.mjs
git commit -m "feat: resolve official responsibility sources"
```

---

### Task 2: Add Responsibility Section Extractor

**Files:**
- Create: `server/responsibility-section-extractor.mjs`
- Test: `tests/responsibility-section-extractor.test.mjs`

- [ ] **Step 1: Write extractor tests**

Create `tests/responsibility-section-extractor.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractStructuredResponsibilitySections,
} from '../server/responsibility-section-extractor.mjs';

test('extractStructuredResponsibilitySections ignores inline 第六条 references', () => {
  const pageText = [
    '第一条 合同构成',
    '第五条 保险责任',
    '1.等待期 自合同生效起90日为等待期。',
    '轻度疾病、中度疾病或重度疾病（详见本合同利益条款第六条）。',
    '2.身故保险金 18周岁后按三者较大者给付。',
    '3.豁免保险费 累计给付达到基本保险金额时豁免。',
    '第六条 本合同保障的疾病列表',
    '轻度疾病共40项，中度疾病共20项，重度疾病共130项，所有疾病分为5组。',
  ].join('\n');

  const result = extractStructuredResponsibilitySections({
    productCategory: 'critical_illness',
    records: [{ title: '条款', url: 'https://example.test/terms.pdf', pageText }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /身故保险金/u);
  assert.match(result.mainResponsibilityText, /豁免保险费/u);
  assert.equal(result.supplementSections[0].type, 'disease_list_overview');
  assert.match(result.supplementSections[0].text, /轻度疾病共40项/u);
});

test('extractStructuredResponsibilitySections flags missing responsibility chapter', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'critical_illness',
    records: [{ title: '条款', pageText: '这是产品简介，没有保险责任正文。' }],
  });

  assert.equal(result.quality.status, 'needs_extraction_review');
  assert.equal(result.mainResponsibilityText, '');
});
```

- [ ] **Step 2: Run extractor tests and verify failure**

Run:

```bash
node --test tests/responsibility-section-extractor.test.mjs
```

Expected: fail with module not found.

- [ ] **Step 3: Implement extractor**

Create `server/responsibility-section-extractor.mjs`:

```js
import crypto from 'node:crypto';

function text(value) {
  return String(value ?? '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return text(value)
    .normalize('NFKC')
    .replace(/\r/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function compact(value) {
  return text(value).replace(/\s+/gu, ' ');
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function headingPattern(title) {
  return new RegExp(`(?:^|\\n)\\s*(?:第[一二三四五六七八九十百0-9]+条|\\d+(?:\\.\\d+)*)\\s*${title}\\s*(?:\\n|$)`, 'u');
}

function findHeading(source, title, from = 0) {
  const slice = source.slice(from);
  const match = slice.match(headingPattern(title));
  return match ? from + (match.index || 0) + match[0].search(/(?:第|\\d)/u) : -1;
}

function findNextArticleHeading(source, from) {
  const slice = source.slice(from);
  const match = slice.match(/(?:^|\n)\s*(?:第[一二三四五六七八九十百0-9]+条|\d+(?:\.\d+)*)\s*(?:责任免除|本合同保障的疾病列表|释义|保险金申请|保单分红|合同解除|现金价值|账户价值)\s*(?:\n|$)/u);
  return match ? from + (match.index || 0) + match[0].search(/(?:第|\d)/u) : -1;
}

function extractResponsibilityChapter(source) {
  const normalized = normalizeText(source);
  if (!normalized) return '';
  const start = findHeading(normalized, '保险责任');
  if (start < 0) {
    const loose = normalized.search(/(?:^|\n|\s)保险责任(?:\s|：|:)/u);
    if (loose < 0) return '';
    const looseEnd = normalized.slice(loose).search(/(?:责任免除|保险金申请|释义|合同解除)/u);
    return compact(looseEnd > 80 ? normalized.slice(loose, loose + looseEnd) : normalized.slice(loose));
  }
  const end = findNextArticleHeading(normalized, start + 20);
  return compact(end > start ? normalized.slice(start, end) : normalized.slice(start));
}

function extractDiseaseListOverview(source) {
  const normalized = normalizeText(source);
  const start = findHeading(normalized, '本合同保障的疾病列表');
  if (start < 0) return '';
  const end = findNextArticleHeading(normalized, start + 20);
  const section = end > start ? normalized.slice(start, end) : normalized.slice(start);
  const overviewEnd = section.search(/(?:以下疾病名称|1[.．、]\s*轻度疾病|第一组)/u);
  return compact(overviewEnd > 60 ? section.slice(0, overviewEnd) : section.slice(0, 1000));
}

function extractDividendSection(source) {
  const normalized = normalizeText(source);
  const start = findHeading(normalized, '保单分红');
  if (start < 0) return '';
  const end = findNextArticleHeading(normalized, start + 20);
  return compact(end > start ? normalized.slice(start, end) : normalized.slice(start, start + 1800));
}

export function extractStructuredResponsibilitySections({
  productCategory = '',
  records = [],
} = {}) {
  const warnings = [];
  const texts = normalizeArray(records).map((record) => ({
    title: text(record.title || record.productName),
    url: text(record.url),
    text: normalizeText(record.fullText || record.pageText || record.responsibilityText || record.content),
  })).filter((record) => record.text);

  const main = texts
    .map((record) => ({ record, section: extractResponsibilityChapter(record.text) }))
    .filter((item) => item.section)
    .sort((left, right) => right.section.length - left.section.length)[0];

  const supplementSections = [];
  if (productCategory === 'critical_illness') {
    const diseaseOverview = texts.map((item) => extractDiseaseListOverview(item.text)).find(Boolean);
    if (diseaseOverview) supplementSections.push({ type: 'disease_list_overview', text: diseaseOverview });
  }
  if (texts.some((item) => /分红型|红利|分红/u.test(item.text))) {
    const dividend = texts.map((item) => extractDividendSection(item.text)).find(Boolean);
    if (dividend) supplementSections.push({ type: 'dividend', text: dividend });
  }

  if (!main?.section) warnings.push('responsibility_chapter_missing');

  const output = {
    mainResponsibilityText: main?.section || '',
    sourceUrl: main?.record?.url || '',
    sourceTitle: main?.record?.title || '',
    supplementSections,
    quality: {
      status: main?.section ? 'complete' : 'needs_extraction_review',
      warnings,
    },
  };
  return {
    ...output,
    sourceSectionsDigest: digest({
      mainResponsibilityText: output.mainResponsibilityText,
      supplementSections: output.supplementSections,
      sourceUrl: output.sourceUrl,
    }),
  };
}
```

- [ ] **Step 4: Run extractor tests and verify pass**

Run:

```bash
node --test tests/responsibility-section-extractor.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit extractor**

Run:

```bash
git add server/responsibility-section-extractor.mjs tests/responsibility-section-extractor.test.mjs
git commit -m "feat: extract structured responsibility sections"
```

---

### Task 3: Add Product Category Router

**Files:**
- Create: `server/insurance-product-category-router.mjs`
- Test: `tests/insurance-product-category-router.test.mjs`

- [ ] **Step 1: Write router tests**

Create `tests/insurance-product-category-router.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { routeInsuranceProductCategory } from '../server/insurance-product-category-router.mjs';

test('routeInsuranceProductCategory identifies incremental whole life with compound formula', () => {
  const result = routeInsuranceProductCategory({
    productName: '新华人寿保险股份有限公司鑫荣耀终身寿险',
    records: [{ productType: '寿险' }],
    indicators: [{ productType: '增额终身寿险' }],
    sourceSections: {
      mainResponsibilityText: '基本保险金额×(1+3.5%)^(n-1)，特定公共交通工具意外额外赔',
    },
  });

  assert.equal(result.productCategory, 'incremental_whole_life');
  assert.equal(result.categoryLabel, '增额终身寿险');
  assert.equal(result.modelTier, 'flash');
  assert.ok(result.featureTags.includes('compound_growth'));
});

test('routeInsuranceProductCategory routes critical illness to pro', () => {
  const result = routeInsuranceProductCategory({
    productName: '多倍保障少儿重大疾病保险（超越版）',
    records: [{ productType: '重疾险' }],
    sourceSections: {
      mainResponsibilityText: '等待期 轻度疾病保险金 中度疾病保险金 重度疾病保险金 疾病分组 累计给付限额',
    },
  });

  assert.equal(result.productCategory, 'critical_illness');
  assert.equal(result.modelTier, 'pro');
  assert.ok(result.featureTags.includes('disease_grouping'));
});

test('routeInsuranceProductCategory routes participating annuity to pro', () => {
  const result = routeInsuranceProductCategory({
    productName: '尊贵人生年金保险(分红型)',
    records: [{ productType: '年金险' }],
    sourceSections: { mainResponsibilityText: '关爱年金 生存保险金 身故保险金 累积红利保险金额' },
  });

  assert.equal(result.productCategory, 'annuity');
  assert.equal(result.categoryLabel, '年金保险（分红型）');
  assert.equal(result.modelTier, 'pro');
  assert.ok(result.featureTags.includes('participating'));
});
```

- [ ] **Step 2: Run router tests and verify failure**

Run:

```bash
node --test tests/insurance-product-category-router.test.mjs
```

Expected: fail with module not found.

- [ ] **Step 3: Implement router**

Create `server/insurance-product-category-router.mjs`:

```js
function text(value) {
  return String(value ?? '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function allText({ productName = '', records = [], indicators = [], cards = [], sourceSections = {} } = {}) {
  return [
    productName,
    sourceSections.mainResponsibilityText,
    ...normalizeArray(sourceSections.supplementSections).map((item) => item.text),
    ...normalizeArray(records).flatMap((record) => [record.productType, record.title, record.pageText]),
    ...normalizeArray(indicators).flatMap((indicator) => [indicator.productType, indicator.coverageType, indicator.liability, indicator.formulaText]),
    ...normalizeArray(cards).flatMap((card) => [card.title, card.category, card.sourceExcerpt]),
  ].map(text).join(' ');
}

function has(content, pattern) {
  return pattern.test(content);
}

export function routeInsuranceProductCategory(input = {}) {
  const content = allText(input);
  const productName = text(input.productName);
  const featureTags = [];
  const participating = /分红型|分红|红利|累积红利/u.test(content);
  if (participating) featureTags.push('participating');
  if (/(?:基本保险金额|基本保额)[×xX*][（(]1[+＋][0-9.]+%/u.test(content)) featureTags.push('compound_growth');
  if (/特定公共交通工具|交通工具意外/u.test(content)) featureTags.push('traffic_accident_extra');
  if (/疾病分组|单组给付限额|累计给付限额/u.test(content)) featureTags.push('disease_grouping');
  if (/少儿|儿童|前10年关爱/u.test(content)) featureTags.push('children');
  if (/可选责任/u.test(content)) featureTags.push('optional_responsibility');

  let productCategory = 'other';
  let categoryLabel = '其他';
  if (has(content, /重大疾病|重疾|轻度疾病|中度疾病|重度疾病/u)) {
    productCategory = 'critical_illness';
    categoryLabel = '重大疾病保险';
  } else if (has(content, /年金|生存保险金|关爱年金|养老金|祝寿金/u)) {
    productCategory = 'annuity';
    categoryLabel = participating ? '年金保险（分红型）' : '年金保险';
  } else if (has(content, /两全|满期保险金/u)) {
    productCategory = 'endowment';
    categoryLabel = '两全保险';
  } else if (has(content, /医疗保险金|住院|门诊|免赔额|报销/u)) {
    productCategory = 'medical';
    categoryLabel = '医疗保险';
  } else if (has(content, /意外伤害保险|意外身故|意外伤残|意外医疗/u) && !has(productName, /终身寿|寿险/u)) {
    productCategory = 'accident';
    categoryLabel = '意外伤害保险';
  } else if (has(content, /增额终身寿|基本保险金额[×xX*][（(]1[+＋][0-9.]+%|有效保险金额/u)) {
    productCategory = 'incremental_whole_life';
    categoryLabel = participating ? '增额终身寿险（分红型）' : '增额终身寿险';
  } else if (has(content, /定期寿险|保险期间.{0,20}(?:年|岁)/u) && has(content, /身故|全残/u)) {
    productCategory = 'term_life';
    categoryLabel = '定期寿险';
  } else if (has(content, /终身寿|寿险|身故|全残/u)) {
    productCategory = 'ordinary_whole_life';
    categoryLabel = participating ? '终身寿险（分红型）' : '终身寿险';
  }

  const proRequired = productCategory === 'critical_illness'
    || productCategory === 'annuity'
    || productCategory === 'endowment'
    || participating
    || /以下二者|以下三者|可选责任|账户价值|累计给付限额|疾病分组/u.test(content)
    || content.length > 5000;

  return {
    productCategory,
    categoryLabel,
    featureTags: [...new Set(featureTags)],
    modelTier: proRequired ? 'pro' : 'flash',
  };
}
```

- [ ] **Step 4: Run router tests and verify pass**

Run:

```bash
node --test tests/insurance-product-category-router.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit router**

Run:

```bash
git add server/insurance-product-category-router.mjs tests/insurance-product-category-router.test.mjs
git commit -m "feat: route insurance products by category"
```

---

### Task 4: Add Category Prompt Templates

**Files:**
- Create: `server/responsibility-summary-templates.mjs`
- Test: `tests/responsibility-summary-templates.test.mjs`

- [ ] **Step 1: Write template tests**

Create `tests/responsibility-summary-templates.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStructuredResponsibilityPrompt,
  requiredKeywordsForCategory,
} from '../server/responsibility-summary-templates.mjs';

test('buildStructuredResponsibilityPrompt adds critical illness checklist', () => {
  const prompt = buildStructuredResponsibilityPrompt({
    product: { company: '新华保险', productName: '多倍保障少儿重大疾病保险（超越版）' },
    routing: { productCategory: 'critical_illness', categoryLabel: '重大疾病保险', featureTags: ['children'] },
    sourceSections: { mainResponsibilityText: '第五条 保险责任 等待期 轻度疾病保险金' },
  });

  assert.match(prompt, /少儿前10年关爱保险金/u);
  assert.match(prompt, /成人意外伤害特定疾病或身故关爱保险金/u);
  assert.match(prompt, /豁免保险费/u);
  assert.match(prompt, /不要展开全部疾病名称/u);
});

test('requiredKeywordsForCategory returns annuity required keywords', () => {
  assert.deepEqual(requiredKeywordsForCategory('annuity').slice(0, 3), ['年金', '生存保险金', '身故保险金']);
});
```

- [ ] **Step 2: Run template tests and verify failure**

Run:

```bash
node --test tests/responsibility-summary-templates.test.mjs
```

Expected: fail with module not found.

- [ ] **Step 3: Implement templates**

Create `server/responsibility-summary-templates.mjs`:

```js
function text(value) {
  return String(value ?? '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

const CATEGORY_KEYWORDS = {
  incremental_whole_life: ['身故', '全残', '基本保险金额', '现金价值', '给付系数'],
  annuity: ['年金', '生存保险金', '身故保险金', '领取日', '可选责任'],
  critical_illness: ['等待期', '轻度疾病保险金', '中度疾病保险金', '重度疾病保险金', '身故保险金', '豁免保险费'],
  medical: ['医疗保险金', '住院', '免赔额', '赔付比例', '年度限额'],
  accident: ['意外身故', '意外伤残', '意外医疗'],
  endowment: ['满期保险金', '身故保险金', '全残保险金'],
  term_life: ['身故', '全残', '等待期'],
  ordinary_whole_life: ['身故', '全残', '现金价值'],
  universal_life: ['账户价值', '身故保险金', '结算利率'],
  investment_linked: ['账户价值', '身故保险金', '投资风险'],
};

export function requiredKeywordsForCategory(category) {
  return CATEGORY_KEYWORDS[text(category)] || [];
}

function categoryInstructions(category) {
  if (category === 'critical_illness') {
    return [
      '如果是重大疾病保险，必须写清：等待期、轻度疾病保险金、中度疾病保险金、重度疾病保险金、疾病分组、单组给付限额、累计给付限额、疾病保险金给付特别约定、身故保险金、少儿前10年关爱保险金、成人意外伤害特定疾病或身故关爱保险金、豁免保险费。',
      '不要展开全部疾病名称，只摘要疾病数量、分组、赔付比例、赔付限制和关键间隔期。',
      '如果原文有某项责任，必须列入 responsibilities；只有原文确实没有时，才写入 missingOrUnclear。',
    ].join('\n');
  }
  if (category === 'annuity') {
    return [
      '如果是年金保险，必须按责任名称拆开：关爱年金、生存保险金、养老年金、祝寿金、满期金、身故保险金、可选责任。',
      '每项年金必须说明领取时间、领取频率、领取比例或金额基准。',
      '分红属于产品功能，不是保险责任；必须提示红利不保证。',
    ].join('\n');
  }
  if (category === 'incremental_whole_life') {
    return [
      '如果是增额终身寿险，必须写清身故或身体全残保险金、有效保额递增公式、现金价值比较项、给付系数、年龄段、交通意外额外赔。',
      '如果出现 基本保险金额×(1+X%)^(n-1)，必须解释为对应给付基准按每年X%复利递增。',
      '必须提示复利递增不等于现金价值按X%增长，也不代表实际收益率。',
    ].join('\n');
  }
  return '按该险种的保险责任名称逐项摘要，保单权益和产品功能不得混入保险责任。';
}

export function buildStructuredResponsibilityPrompt({
  product = {},
  routing = {},
  sourceSections = {},
  cards = [],
  indicators = [],
} = {}) {
  const payload = {
    product,
    routing,
    sourceSections,
    cards,
    indicators,
  };
  return [
    '你是一名中国保险责任摘要助手。请只依据输入资料，为普通用户输出保险责任摘要。',
    '',
    '硬性规则：',
    '- 只输出合法 JSON，不要 Markdown。',
    '- 只使用输入资料，不要编造。',
    '- 保险责任和产品功能必须分开。',
    '- 现金价值、红利、保单贷款、减保、指定受益人属于产品功能或重要提示，不得混入 responsibilities。',
    '- 遇到现金价值、账户价值、疾病分组、伤残等级表、医疗费用、红利，不要硬算金额。',
    '- 没有来源的内容不要写。',
    '',
    categoryInstructions(text(routing.productCategory)),
    '',
    '输出 JSON Schema：',
    '{"productCategory":"","categoryLabel":"","headline":"","responsibilities":[{"title":"","plainText":"","triggerCondition":"","paymentRule":"","calculationStatus":"claim_contingent|scheduled_cashflow|needs_table|waiver_only|not_calculable"}],"productFunctions":[],"importantNotes":[],"missingOrUnclear":[]}',
    '',
    '输入资料：',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}
```

- [ ] **Step 4: Run template tests and verify pass**

Run:

```bash
node --test tests/responsibility-summary-templates.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit templates**

Run:

```bash
git add server/responsibility-summary-templates.mjs tests/responsibility-summary-templates.test.mjs
git commit -m "feat: add responsibility summary templates"
```

---

### Task 5: Add Summary Quality Gate

**Files:**
- Create: `server/responsibility-summary-quality-gate.mjs`
- Test: `tests/responsibility-summary-quality-gate.test.mjs`

- [ ] **Step 1: Write quality gate tests**

Create `tests/responsibility-summary-quality-gate.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateResponsibilitySummaryQuality } from '../server/responsibility-summary-quality-gate.mjs';

test('evaluateResponsibilitySummaryQuality passes complete critical illness summary', () => {
  const result = evaluateResponsibilitySummaryQuality({
    routing: { productCategory: 'critical_illness' },
    sourceSections: {
      mainResponsibilityText: '等待期 轻度疾病保险金 中度疾病保险金 重度疾病保险金 身故保险金 少儿前10年关爱保险金 成人意外伤害特定疾病或身故关爱保险金 豁免保险费',
    },
    summary: {
      headline: '少儿重疾保障',
      responsibilities: [
        { title: '等待期', plainText: '90日' },
        { title: '轻度疾病保险金', plainText: '20%' },
        { title: '中度疾病保险金', plainText: '50%' },
        { title: '重度疾病保险金', plainText: '基本保额与已交保费较大者' },
        { title: '身故保险金', plainText: '18岁前后分情形' },
        { title: '少儿前10年关爱保险金', plainText: '额外给付基本保额' },
        { title: '成人意外伤害特定疾病或身故关爱保险金', plainText: '给付50%基本保额' },
        { title: '豁免保险费', plainText: '累计疾病金达到基本保额后豁免' },
      ],
      productFunctions: [],
      importantNotes: [],
      missingOrUnclear: [],
    },
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(result.issues, []);
});

test('evaluateResponsibilitySummaryQuality fails when critical illness care and waiver responsibilities are missing', () => {
  const result = evaluateResponsibilitySummaryQuality({
    routing: { productCategory: 'critical_illness' },
    sourceSections: {
      mainResponsibilityText: '等待期 轻度疾病保险金 中度疾病保险金 重度疾病保险金 身故保险金 少儿前10年关爱保险金 豁免保险费',
    },
    summary: {
      responsibilities: [
        { title: '等待期', plainText: '90日' },
        { title: '轻度疾病保险金', plainText: '20%' },
        { title: '中度疾病保险金', plainText: '50%' },
        { title: '重度疾病保险金', plainText: '100%' },
        { title: '身故保险金', plainText: '身故赔付' },
      ],
      productFunctions: [],
      importantNotes: [],
      missingOrUnclear: [],
    },
  });

  assert.equal(result.status, 'failed');
  assert.ok(result.issues.some((issue) => issue.code === 'missing_required_keyword' && issue.keyword === '少儿前10年关爱保险金'));
  assert.ok(result.issues.some((issue) => issue.code === 'missing_required_keyword' && issue.keyword === '豁免保险费'));
});

test('evaluateResponsibilitySummaryQuality rejects product functions inside responsibilities', () => {
  const result = evaluateResponsibilitySummaryQuality({
    routing: { productCategory: 'incremental_whole_life' },
    sourceSections: { mainResponsibilityText: '身故 全残 现金价值 保单贷款' },
    summary: {
      responsibilities: [
        { title: '保单贷款', plainText: '可以贷款' },
        { title: '身故或身体全残保险金', plainText: '按条款给付' },
      ],
      productFunctions: [],
      importantNotes: [],
      missingOrUnclear: [],
    },
  });

  assert.equal(result.status, 'failed');
  assert.ok(result.issues.some((issue) => issue.code === 'function_mixed_into_responsibilities'));
});
```

- [ ] **Step 2: Run quality gate tests and verify failure**

Run:

```bash
node --test tests/responsibility-summary-quality-gate.test.mjs
```

Expected: fail with module not found.

- [ ] **Step 3: Implement quality gate**

Create `server/responsibility-summary-quality-gate.mjs`:

```js
function text(value) {
  return String(value ?? '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

const REQUIRED_BY_CATEGORY = {
  critical_illness: ['等待期', '轻度疾病保险金', '中度疾病保险金', '重度疾病保险金', '身故保险金'],
  incremental_whole_life: ['身故', '全残'],
  annuity: ['年金', '身故'],
};

const OPTIONAL_IF_SOURCE_HAS = {
  critical_illness: ['少儿前10年关爱保险金', '成人意外伤害特定疾病或身故关爱保险金', '豁免保险费'],
  incremental_whole_life: ['特定公共交通工具', '给付系数'],
  annuity: ['可选责任', '祝寿金', '累积红利保险金额'],
};

function summaryText(summary = {}) {
  return [
    summary.headline,
    ...normalizeArray(summary.responsibilities).flatMap((item) => [item.title, item.plainText, item.paymentRule]),
    ...normalizeArray(summary.productFunctions).flatMap((item) => [item.title, item.plainText]),
    ...normalizeArray(summary.importantNotes),
    ...normalizeArray(summary.missingOrUnclear),
  ].map(text).join(' ');
}

function sourceText(sourceSections = {}) {
  return [
    sourceSections.mainResponsibilityText,
    ...normalizeArray(sourceSections.supplementSections).map((item) => item.text),
  ].map(text).join(' ');
}

function includesLoose(content, keyword) {
  const normalized = text(content).replace(/\s+/gu, '');
  const key = text(keyword).replace(/\s+/gu, '');
  return normalized.includes(key);
}

function hasCustomerResponsibilities(summary = {}) {
  return normalizeArray(summary.responsibilities).some((item) => text(item.title) || text(item.plainText));
}

export function evaluateResponsibilitySummaryQuality({
  routing = {},
  sourceSections = {},
  summary = {},
} = {}) {
  const issues = [];
  if (!hasCustomerResponsibilities(summary)) {
    issues.push({ code: 'empty_responsibilities', message: 'Summary has no customer responsibilities.' });
  }

  const category = text(routing.productCategory);
  const combinedSummary = summaryText(summary);
  const combinedSource = sourceText(sourceSections);
  for (const keyword of REQUIRED_BY_CATEGORY[category] || []) {
    if (!includesLoose(combinedSummary, keyword)) {
      issues.push({ code: 'missing_required_keyword', keyword });
    }
  }
  for (const keyword of OPTIONAL_IF_SOURCE_HAS[category] || []) {
    if (includesLoose(combinedSource, keyword) && !includesLoose(combinedSummary, keyword)) {
      issues.push({ code: 'missing_required_keyword', keyword });
    }
  }

  for (const item of normalizeArray(summary.responsibilities)) {
    const title = text(item.title);
    if (/^(?:保单贷款|减保|指定受益人|现金价值管理|红利分配|年度分红)$/u.test(title)) {
      issues.push({ code: 'function_mixed_into_responsibilities', title });
    }
  }

  if (/(?:基本保险金额|基本保额)[×xX*][（(]1[+＋][0-9.]+%/u.test(combinedSource)
    && !/(?:复利|递增|有效保险金额|给付基准)/u.test(combinedSummary)) {
    issues.push({ code: 'compound_growth_not_explained', message: 'Compound growth formula appears in source but is not explained.' });
  }

  return {
    status: issues.length ? 'failed' : 'passed',
    issues,
  };
}
```

- [ ] **Step 4: Run quality gate tests and verify pass**

Run:

```bash
node --test tests/responsibility-summary-quality-gate.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit quality gate**

Run:

```bash
git add server/responsibility-summary-quality-gate.mjs tests/responsibility-summary-quality-gate.test.mjs
git commit -m "feat: gate customer responsibility summary quality"
```

---

### Task 6: Add Generation Run Persistence

**Files:**
- Modify: `server/sqlite-state-store.mjs`
- Test: `tests/sqlite-state-store.test.mjs`

- [ ] **Step 1: Write SQLite generation run test**

Append to `tests/sqlite-state-store.test.mjs`:

```js
test('sqlite state store persists product customer summary generation runs', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  try {
    const state = await store.load();
    const run = {
      id: 'customer_summary_run:company_product:新华保险:鑫荣耀:v22:1',
      productKey: 'company_product:新华保险:鑫荣耀',
      company: '新华保险',
      productName: '鑫荣耀',
      summaryVersion: 'customer-summary-v22-structured-rag',
      status: 'needs_model_review',
      productCategory: 'incremental_whole_life',
      categoryLabel: '增额终身寿险',
      modelProvider: 'deepseek',
      modelName: 'deepseek-v4-pro',
      modelTier: 'pro',
      sourceDigest: 'source-digest',
      sourceSectionsDigest: 'sections-digest',
      qualityIssues: [{ code: 'missing_required_keyword', keyword: '复利递增' }],
      rawPreview: '{"headline":"..."}',
      createdAt: '2026-07-01T00:00:00.000Z',
      payload: { attempt: 1 },
    };

    await store.persistProductCustomerSummaryGenerationRun({ state, run });
    const reloaded = await store.load();

    assert.equal(reloaded.productCustomerSummaryGenerationRuns.length, 1);
    assert.equal(reloaded.productCustomerSummaryGenerationRuns[0].status, 'needs_model_review');
    assert.equal(reloaded.productCustomerSummaryGenerationRuns[0].qualityIssues[0].keyword, '复利递增');
  } finally {
    store.close();
  }
});
```

- [ ] **Step 2: Run SQLite test and verify failure**

Run:

```bash
node --test tests/sqlite-state-store.test.mjs --test-name-pattern "generation runs"
```

Expected: fail because `persistProductCustomerSummaryGenerationRun` does not exist.

- [ ] **Step 3: Add table and load state**

In `server/sqlite-state-store.mjs`, inside `createSchema(db)`, after `product_customer_responsibility_summaries`, add:

```js
    CREATE TABLE IF NOT EXISTS product_customer_summary_generation_runs (
      id TEXT PRIMARY KEY,
      product_key TEXT NOT NULL,
      company TEXT,
      product_name TEXT,
      summary_version TEXT NOT NULL,
      status TEXT NOT NULL,
      product_category TEXT,
      category_label TEXT,
      model_provider TEXT,
      model_name TEXT,
      model_tier TEXT,
      source_digest TEXT,
      source_sections_digest TEXT,
      quality_issues_json TEXT NOT NULL DEFAULT '[]',
      raw_preview TEXT,
      created_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_product_customer_summary_generation_runs_product_version
      ON product_customer_summary_generation_runs(product_key, summary_version);
    CREATE INDEX IF NOT EXISTS idx_product_customer_summary_generation_runs_status
      ON product_customer_summary_generation_runs(status);
```

In the object returned by `load()`, add:

```js
productCustomerSummaryGenerationRuns: loadPayloadRows(
  db,
  'product_customer_summary_generation_runs',
  'created_at DESC, id ASC',
).map(normalizeProductCustomerSummaryGenerationRun),
```

- [ ] **Step 4: Add normalizer and persistence helper**

In `server/sqlite-state-store.mjs`, near other normalizers, add:

```js
function normalizeProductCustomerSummaryGenerationRun(row = {}) {
  const payload = parseJson(row.payload, row) || {};
  const qualityIssues = normalizeArray(payload.qualityIssues || parseJson(row.quality_issues_json, []));
  return {
    id: String(payload.id || row.id || '').trim(),
    productKey: String(payload.productKey || payload.product_key || row.product_key || '').trim(),
    company: String(payload.company || row.company || '').trim(),
    productName: String(payload.productName || payload.product_name || row.product_name || '').trim(),
    summaryVersion: String(payload.summaryVersion || payload.summary_version || row.summary_version || '').trim(),
    status: String(payload.status || row.status || '').trim(),
    productCategory: String(payload.productCategory || payload.product_category || row.product_category || '').trim(),
    categoryLabel: String(payload.categoryLabel || payload.category_label || row.category_label || '').trim(),
    modelProvider: String(payload.modelProvider || payload.model_provider || row.model_provider || '').trim(),
    modelName: String(payload.modelName || payload.model_name || row.model_name || '').trim(),
    modelTier: String(payload.modelTier || payload.model_tier || row.model_tier || '').trim(),
    sourceDigest: String(payload.sourceDigest || payload.source_digest || row.source_digest || '').trim(),
    sourceSectionsDigest: String(payload.sourceSectionsDigest || payload.source_sections_digest || row.source_sections_digest || '').trim(),
    qualityIssues,
    rawPreview: String(payload.rawPreview || payload.raw_preview || row.raw_preview || '').trim(),
    createdAt: String(payload.createdAt || payload.created_at || row.created_at || '').trim(),
    payload,
  };
}
```

Inside `createSqliteStateStore`, add:

```js
  async function persistProductCustomerSummaryGenerationRun({ state, run } = {}) {
    const normalized = normalizeProductCustomerSummaryGenerationRun(run);
    if (!normalized.id || !normalized.productKey || !normalized.summaryVersion) {
      throw new Error('Product customer summary generation run requires id, productKey, and summaryVersion');
    }
    db.prepare(`
      INSERT INTO product_customer_summary_generation_runs (
        id, product_key, company, product_name, summary_version, status,
        product_category, category_label, model_provider, model_name, model_tier,
        source_digest, source_sections_digest, quality_issues_json, raw_preview,
        created_at, payload
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        quality_issues_json = excluded.quality_issues_json,
        raw_preview = excluded.raw_preview,
        payload = excluded.payload
    `).run(
      normalized.id,
      normalized.productKey,
      normalized.company,
      normalized.productName,
      normalized.summaryVersion,
      normalized.status,
      normalized.productCategory,
      normalized.categoryLabel,
      normalized.modelProvider,
      normalized.modelName,
      normalized.modelTier,
      normalized.sourceDigest,
      normalized.sourceSectionsDigest,
      JSON.stringify(normalized.qualityIssues),
      normalized.rawPreview,
      normalized.createdAt,
      JSON.stringify(normalized),
    );
    if (state && typeof state === 'object') {
      state.productCustomerSummaryGenerationRuns = loadPayloadRows(
        db,
        'product_customer_summary_generation_runs',
        'created_at DESC, id ASC',
      ).map(normalizeProductCustomerSummaryGenerationRun);
    }
    return normalized;
  }
```

Return it from the store object:

```js
persistProductCustomerSummaryGenerationRun,
```

- [ ] **Step 5: Run SQLite generation run test and verify pass**

Run:

```bash
node --test tests/sqlite-state-store.test.mjs --test-name-pattern "generation runs"
```

Expected: pass.

- [ ] **Step 6: Commit persistence**

Run:

```bash
git add server/sqlite-state-store.mjs tests/sqlite-state-store.test.mjs
git commit -m "feat: persist customer summary generation runs"
```

---

### Task 7: Wire Structured RAG into Customer Summary Service

**Files:**
- Modify: `server/product-customer-responsibility-summary.service.mjs`
- Modify: `server/routes/responsibilities.routes.mjs`
- Test: `tests/product-customer-responsibility-summary.test.mjs`

- [ ] **Step 1: Add service tests for v22 structured generation**

Append to `tests/product-customer-responsibility-summary.test.mjs`:

```js
test('generateProductCustomerResponsibilitySummary uses structured critical illness context and persists ready v22 summary', async () => {
  const product = '新华人寿保险股份有限公司多倍保障少儿重大疾病保险（超越版）';
  const state = {
    knowledgeRecords: [
      {
        company,
        productName: product,
        productType: '重疾险',
        title: '条款',
        official: true,
        url: sourceUrl,
        pageText: [
          '第五条 保险责任',
          '1.等待期 90日。',
          '2.疾病保险金 轻度疾病保险金 中度疾病保险金 重度疾病保险金 疾病分组 累计给付限额。',
          '3.身故保险金 18周岁前后分情形。',
          '4.少儿前10年关爱保险金 按基本保险金额给付。',
          '5.成人意外伤害特定疾病或身故关爱保险金 按基本保险金额的50%给付。',
          '6.豁免保险费 累计给付达到基本保险金额时豁免。',
          '第六条 本合同保障的疾病列表',
          '轻度疾病共40项，中度疾病共20项，重度疾病共130项，所有疾病分为5组。',
        ].join('\\n'),
      },
    ],
    insuranceIndicatorRecords: [],
  };
  const savedRows = [];
  const runRows = [];
  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards([]),
    input: { company, name: product },
    findSummary: async () => null,
    persistSummary: async (row) => {
      savedRows.push(row);
      return row;
    },
    persistGenerationRun: async (run) => {
      runRows.push(run);
      return run;
    },
    generateWithDeepSeek: async ({ prompt }) => {
      assert.match(prompt, /少儿前10年关爱保险金/u);
      return {
        productCategory: 'critical_illness',
        categoryLabel: '重大疾病保险',
        headline: '少儿重疾保障。',
        responsibilities: [
          { title: '等待期', plainText: '90日', paymentRule: '90日' },
          { title: '轻度疾病保险金', plainText: '20%', paymentRule: '20%' },
          { title: '中度疾病保险金', plainText: '50%', paymentRule: '50%' },
          { title: '重度疾病保险金', plainText: '基本保额与已交保费较大者', paymentRule: 'max' },
          { title: '身故保险金', plainText: '18岁前后分情形', paymentRule: '分情形' },
          { title: '少儿前10年关爱保险金', plainText: '基本保额', paymentRule: '100%' },
          { title: '成人意外伤害特定疾病或身故关爱保险金', plainText: '50%基本保额', paymentRule: '50%' },
          { title: '豁免保险费', plainText: '豁免后续保费', paymentRule: '豁免' },
        ],
        productFunctions: [],
        importantNotes: ['疾病定义以条款为准。'],
        missingOrUnclear: [],
      };
    },
    nowIso: () => '2026-07-01T00:00:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'generated');
  assert.equal(savedRows.length, 1);
  assert.equal(savedRows[0].summaryVersion, 'customer-summary-v22-structured-rag');
  assert.equal(savedRows[0].payload.productCategory, 'critical_illness');
  assert.equal(savedRows[0].payload.qualityGate.status, 'passed');
  assert.equal(runRows.at(-1)?.status, 'passed');
  assert.ok(result.summary.mainResponsibilities.some((item) => item.title === '少儿前10年关爱保险金'));
});

test('generateProductCustomerResponsibilitySummary does not persist ready summary when quality gate fails', async () => {
  const product = '新华人寿保险股份有限公司多倍保障少儿重大疾病保险（超越版）';
  const state = {
    knowledgeRecords: [
      {
        company,
        productName: product,
        productType: '重疾险',
        official: true,
        url: sourceUrl,
        pageText: '第五条 保险责任 等待期 轻度疾病保险金 中度疾病保险金 重度疾病保险金 身故保险金 少儿前10年关爱保险金 豁免保险费 第六条 本合同保障的疾病列表',
      },
    ],
    insuranceIndicatorRecords: [],
  };
  let persisted = false;
  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards([]),
    input: { company, name: product },
    findSummary: async () => null,
    persistSummary: async () => {
      persisted = true;
      throw new Error('invalid ready summary should not persist');
    },
    persistGenerationRun: async (run) => run,
    generateWithDeepSeek: async () => ({
      headline: '缺少关爱和豁免。',
      responsibilities: [
        { title: '等待期', plainText: '90日' },
        { title: '轻度疾病保险金', plainText: '20%' },
        { title: '中度疾病保险金', plainText: '50%' },
        { title: '重度疾病保险金', plainText: '100%' },
        { title: '身故保险金', plainText: '身故赔付' },
      ],
      productFunctions: [],
      importantNotes: [],
      missingOrUnclear: [],
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'needs_model_review');
  assert.equal(persisted, false);
});
```

- [ ] **Step 2: Run service tests and verify failure**

Run:

```bash
node --test tests/product-customer-responsibility-summary.test.mjs --test-name-pattern "structured"
```

Expected: fail because the service still uses the old prompt/version path.

- [ ] **Step 3: Import structured modules and update version**

At the top of `server/product-customer-responsibility-summary.service.mjs`, add imports:

```js
import { routeInsuranceProductCategory } from './insurance-product-category-router.mjs';
import { resolveOfficialResponsibilitySources } from './responsibility-source-resolver.mjs';
import { extractStructuredResponsibilitySections } from './responsibility-section-extractor.mjs';
import { buildStructuredResponsibilityPrompt } from './responsibility-summary-templates.mjs';
import { evaluateResponsibilitySummaryQuality } from './responsibility-summary-quality-gate.mjs';
```

Change:

```js
export const CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION = 'customer-summary-v22-structured-rag';
```

- [ ] **Step 4: Add normalizer from structured output to existing summary shape**

In `server/product-customer-responsibility-summary.service.mjs`, add:

```js
function normalizeStructuredSummaryToCustomerSummary(raw = {}, { company, productName, sourceUrls = [] } = {}) {
  const source = raw?.summary || raw?.result || raw?.data || raw;
  const responsibilities = normalizeArray(source?.responsibilities)
    .concat(normalizeArray(source?.mainResponsibilities))
    .map((item) => ({
      title: text(item?.title || item?.name || item?.责任名称),
      plainText: text(item?.plainText || item?.summary || item?.description || item?.内容),
      howItPays: text(item?.paymentRule || item?.howItPays || item?.给付规则 || item?.赔付方式),
      requiredPolicyFields: requiredFieldsFromText(`${item?.plainText || ''} ${item?.paymentRule || ''}`),
    }))
    .filter((item) => item.title || item.plainText || item.howItPays);
  const notices = uniqueStrings([
    ...normalizeArray(source?.importantNotes).map(text),
    ...normalizeArray(source?.notices).map(text),
    ...normalizeArray(source?.missingOrUnclear).map((item) => `需核验：${text(item)}`).filter(Boolean),
  ]);
  return {
    company,
    productName,
    headline: text(source?.headline || source?.productSummary || source?.summary),
    mainResponsibilities: responsibilities,
    notices,
    requiredPolicyFields: uniqueStrings(responsibilities.flatMap((item) => item.requiredPolicyFields)),
    sourceUrls: uniqueStrings(source?.sourceUrls || sourceUrls),
  };
}
```

- [ ] **Step 5: Build structured context before prompt generation**

Inside `generateProductCustomerResponsibilitySummary`, after records/cards/indicators are resolved, add:

```js
  const structuredNow = nowIso();
  const resolvedSources = resolveOfficialResponsibilitySources({
    company,
    productName,
    records,
  });
  const sourceRecords = resolvedSources.records.length ? resolvedSources.records : records;
  const preliminaryRouting = routeInsuranceProductCategory({
    productName,
    records: sourceRecords,
    indicators,
    cards,
    sourceSections: { mainResponsibilityText: sourceRecords.map((record) => record.pageText).join('\n') },
  });
  const sourceSections = extractStructuredResponsibilitySections({
    productCategory: preliminaryRouting.productCategory,
    records: sourceRecords,
  });
  if (sourceSections.quality.status !== 'complete') {
    const run = buildGenerationRun({
      productKey,
      company,
      productName,
      status: 'needs_extraction_review',
      routing: preliminaryRouting,
      sourceDigest,
      sourceSections,
      qualityIssues: sourceSections.quality.warnings.map((warning) => ({ code: warning })),
      modelName: '',
      modelTier: preliminaryRouting.modelTier,
      now: structuredNow,
    });
    if (typeof persistGenerationRun === 'function') await persistGenerationRun(run);
    return {
      ok: false,
      status: 'needs_extraction_review',
      message: '这个产品的保险责任资料需要进一步核验，请稍后再试。',
    };
  }
  const routing = routeInsuranceProductCategory({
    productName,
    records: sourceRecords,
    indicators,
    cards,
    sourceSections,
  });
```

Add `persistGenerationRun` to the function arguments:

```js
  persistGenerationRun,
```

Add `buildGenerationRun` helper:

```js
function buildGenerationRun({
  productKey,
  company,
  productName,
  status,
  routing = {},
  sourceDigest = '',
  sourceSections = {},
  qualityIssues = [],
  rawPreview = '',
  modelName = '',
  modelTier = '',
  now = new Date().toISOString(),
} = {}) {
  return {
    id: `customer_summary_run:${productKey}:${CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION}:${crypto.randomUUID()}`,
    productKey,
    company,
    productName,
    summaryVersion: CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION,
    status,
    productCategory: text(routing.productCategory),
    categoryLabel: text(routing.categoryLabel),
    modelProvider: modelName ? 'deepseek' : '',
    modelName: text(modelName),
    modelTier: text(modelTier || routing.modelTier),
    sourceDigest,
    sourceSectionsDigest: text(sourceSections.sourceSectionsDigest),
    qualityIssues: normalizeArray(qualityIssues),
    rawPreview,
    createdAt: now,
    payload: {
      routing,
      sourceSectionsQuality: sourceSections.quality,
      qualityIssues,
    },
  };
}
```

- [ ] **Step 6: Replace old prompt generation with structured prompt and gate**

Replace:

```js
const prompt = buildDeepSeekPrompt({ company, productName, cards, indicators, records });
```

with:

```js
const prompt = buildStructuredResponsibilityPrompt({
  product: { company, productName },
  routing,
  sourceSections,
  cards: normalizeArray(cards).map(cardPromptItem),
  indicators: normalizeArray(indicators).map(indicatorPromptItem),
});
```

After DeepSeek returns raw output, convert and gate it:

```js
const raw = await generateWithDeepSeek({ prompt, company, productName, cards, indicators, records });
const quality = evaluateResponsibilitySummaryQuality({
  routing,
  sourceSections,
  summary: raw,
});
if (quality.status !== 'passed') {
  if (typeof persistGenerationRun === 'function') {
    await persistGenerationRun(buildGenerationRun({
      productKey,
      company,
      productName,
      status: 'needs_model_review',
      routing,
      sourceDigest,
      sourceSections,
      qualityIssues: quality.issues,
      rawPreview: previewForLog(JSON.stringify(raw)),
      modelName: resolvedModelName,
      modelTier: routing.modelTier,
      now: structuredNow,
    }));
  }
  return {
    ok: false,
    status: 'needs_model_review',
    message: '这个产品的保险责任资料需要进一步核验，请稍后再试。',
  };
}
summaryJson = normalizeStructuredSummaryToCustomerSummary(raw, {
  company,
  productName,
  sourceUrls: uniqueStrings(sourceRecords.map(sourceUrlFrom)),
});
```

When building the persisted summary row later in the function, use the same
timestamp:

```js
const now = structuredNow;
```

Store metadata in row payload:

```js
productCategory: routing.productCategory,
categoryLabel: routing.categoryLabel,
featureTags: routing.featureTags,
sourceSectionsDigest: sourceSections.sourceSectionsDigest,
sourceSections,
modelTier: routing.modelTier,
qualityGate: { status: 'passed', warnings: [] },
```

- [ ] **Step 7: Pass persistence helper from route**

In `server/routes/responsibilities.routes.mjs`, where `generateProductCustomerResponsibilitySummary` is called, pass:

```js
persistGenerationRun: store.persistProductCustomerSummaryGenerationRun,
```

Use the local variable names already present in the route module.

- [ ] **Step 8: Run focused service tests**

Run:

```bash
node --test tests/product-customer-responsibility-summary.test.mjs --test-name-pattern "structured"
```

Expected: pass.

- [ ] **Step 9: Run full customer summary tests**

Run:

```bash
node --test tests/product-customer-responsibility-summary.test.mjs
```

Expected: pass.

- [ ] **Step 10: Commit structured service integration**

Run:

```bash
git add server/product-customer-responsibility-summary.service.mjs server/routes/responsibilities.routes.mjs tests/product-customer-responsibility-summary.test.mjs
git commit -m "feat: generate structured customer responsibility summaries"
```

---

### Task 8: Add Flash/Pro Model Routing

**Files:**
- Modify: `server/product-customer-responsibility-summary.service.mjs`
- Test: `tests/product-customer-responsibility-summary.test.mjs`

- [ ] **Step 1: Add model routing test**

Append to `tests/product-customer-responsibility-summary.test.mjs`:

```js
test('generateProductCustomerResponsibilitySummary passes pro model for critical illness routing', async () => {
  const product = '新华人寿保险股份有限公司多倍保障少儿重大疾病保险（超越版）';
  const calls = [];
  const result = await generateProductCustomerResponsibilitySummary({
    state: {
      knowledgeRecords: [{
        company,
        productName: product,
        productType: '重疾险',
        official: true,
        url: sourceUrl,
        pageText: '第五条 保险责任 等待期 轻度疾病保险金 中度疾病保险金 重度疾病保险金 身故保险金 豁免保险费 第六条 本合同保障的疾病列表',
      }],
      insuranceIndicatorRecords: [],
    },
    db: dbWithCards([]),
    input: { company, name: product },
    findSummary: async () => null,
    persistSummary: async (row) => row,
    persistGenerationRun: async (run) => run,
    generateWithDeepSeek: async (args) => {
      calls.push(args);
      return {
        headline: '重疾摘要',
        responsibilities: [
          { title: '等待期', plainText: '90日' },
          { title: '轻度疾病保险金', plainText: '20%' },
          { title: '中度疾病保险金', plainText: '50%' },
          { title: '重度疾病保险金', plainText: '100%' },
          { title: '身故保险金', plainText: '身故' },
          { title: '豁免保险费', plainText: '豁免' },
        ],
        productFunctions: [],
        importantNotes: [],
        missingOrUnclear: [],
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].modelNameOverride, 'deepseek-v4-pro');
});
```

- [ ] **Step 2: Run routing test and verify failure**

Run:

```bash
node --test tests/product-customer-responsibility-summary.test.mjs --test-name-pattern "pro model"
```

Expected: fail because `modelNameOverride` is not passed.

- [ ] **Step 3: Allow model override in DeepSeek call**

In `callDeepSeekForCustomerResponsibilitySummary`, accept `modelNameOverride`:

```js
  modelNameOverride = '',
```

Use:

```js
const requestedModel = text(modelNameOverride) || config.model;
```

Then in request body:

```js
model: requestedModel,
```

And in logs use `requestedModel`.

- [ ] **Step 4: Pass model tier override from service**

Before calling `generateWithDeepSeek`, derive:

```js
const routedModelName = routing.modelTier === 'pro' ? 'deepseek-v4-pro' : resolvedModelName;
```

Call:

```js
generateWithDeepSeek({ prompt, company, productName, cards, indicators, records, modelNameOverride: routedModelName });
```

Persist `modelName: routedModelName`.

- [ ] **Step 5: Run routing test and customer summary tests**

Run:

```bash
node --test tests/product-customer-responsibility-summary.test.mjs --test-name-pattern "pro model"
node --test tests/product-customer-responsibility-summary.test.mjs
```

Expected: both pass.

- [ ] **Step 6: Commit model routing**

Run:

```bash
git add server/product-customer-responsibility-summary.service.mjs tests/product-customer-responsibility-summary.test.mjs
git commit -m "feat: route complex responsibility summaries to pro model"
```

---

### Task 9: Add Batch Backfill Script

**Files:**
- Create: `scripts/backfill-product-customer-responsibility-summaries.mjs`
- Modify: `package.json`
- Test: `tests/backfill-product-customer-responsibility-summaries.test.mjs`

- [ ] **Step 1: Write batch script test**

Create `tests/backfill-product-customer-responsibility-summaries.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseBackfillArgs,
  selectBackfillProducts,
} from '../scripts/backfill-product-customer-responsibility-summaries.mjs';

test('parseBackfillArgs resolves v22 alias and dry run', () => {
  const args = parseBackfillArgs(['--version', 'v22', '--limit', '10', '--company', '新华保险', '--dry-run']);
  assert.equal(args.summaryVersion, 'customer-summary-v22-structured-rag');
  assert.equal(args.limit, 10);
  assert.equal(args.company, '新华保险');
  assert.equal(args.dryRun, true);
});

test('selectBackfillProducts deduplicates by company and product name', () => {
  const products = selectBackfillProducts({
    knowledgeRecords: [
      { company: '新华保险', productName: '产品A' },
      { company: '新华保险', productName: '产品A' },
      { company: '新华保险', productName: '产品B' },
    ],
    limit: 2,
  });
  assert.deepEqual(products, [
    { company: '新华保险', productName: '产品A' },
    { company: '新华保险', productName: '产品B' },
  ]);
});
```

- [ ] **Step 2: Run batch tests and verify failure**

Run:

```bash
node --test tests/backfill-product-customer-responsibility-summaries.test.mjs
```

Expected: fail with module not found.

- [ ] **Step 3: Implement batch helpers and executable script**

Create `scripts/backfill-product-customer-responsibility-summaries.mjs`:

```js
#!/usr/bin/env node
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';
import { generateProductCustomerResponsibilitySummary } from '../server/product-customer-responsibility-summary.service.mjs';

const V22 = 'customer-summary-v22-structured-rag';

function text(value) {
  return String(value ?? '').trim();
}

export function parseBackfillArgs(argv = process.argv.slice(2)) {
  const out = { summaryVersion: V22, limit: 50, company: '', category: '', dryRun: false, dbPath: '.runtime/local/policy-ocr.sqlite' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--version') out.summaryVersion = argv[++index] === 'v22' ? V22 : text(argv[index]);
    else if (arg === '--limit') out.limit = Math.max(1, Number(argv[++index] || 50));
    else if (arg === '--company') out.company = text(argv[++index]);
    else if (arg === '--category') out.category = text(argv[++index]);
    else if (arg === '--db') out.dbPath = text(argv[++index]);
    else if (arg === '--dry-run') out.dryRun = true;
  }
  return out;
}

export function selectBackfillProducts({ knowledgeRecords = [], company = '', limit = 50 } = {}) {
  const seen = new Set();
  const products = [];
  for (const record of knowledgeRecords) {
    const row = { company: text(record.company), productName: text(record.productName || record.product_name || record.title) };
    if (!row.company || !row.productName) continue;
    if (company && row.company !== company) continue;
    const key = `${row.company}\n${row.productName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    products.push(row);
    if (products.length >= limit) break;
  }
  return products;
}

async function main() {
  const args = parseBackfillArgs();
  const store = await createSqliteStateStore({ dbPath: args.dbPath });
  try {
    const state = await store.load();
    const products = selectBackfillProducts({ knowledgeRecords: state.knowledgeRecords, company: args.company, limit: args.limit });
    const report = { total: products.length, generated: 0, failed: 0, skippedDryRun: 0, failures: [] };
    for (const product of products) {
      if (args.dryRun) {
        report.skippedDryRun += 1;
        continue;
      }
      try {
        const result = await generateProductCustomerResponsibilitySummary({
          state,
          db: store.db,
          input: { company: product.company, productName: product.productName },
          findSummary: store.findProductCustomerResponsibilitySummary,
          persistSummary: store.persistProductCustomerResponsibilitySummary,
          persistGenerationRun: store.persistProductCustomerSummaryGenerationRun,
        });
        if (result.ok) report.generated += 1;
        else {
          report.failed += 1;
          report.failures.push({ ...product, status: result.status });
        }
      } catch (error) {
        report.failed += 1;
        report.failures.push({ ...product, status: 'failed', message: text(error.message) });
      }
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
```

- [ ] **Step 4: Add npm script**

In `package.json`, add:

```json
"responsibility-summary:backfill": "node scripts/backfill-product-customer-responsibility-summaries.mjs"
```

Keep the JSON ordering consistent with neighboring scripts.

- [ ] **Step 5: Run batch script tests**

Run:

```bash
node --test tests/backfill-product-customer-responsibility-summaries.test.mjs
```

Expected: pass.

- [ ] **Step 6: Run dry-run command**

Run:

```bash
npm run responsibility-summary:backfill -- --version v22 --limit 2 --dry-run
```

Expected: prints JSON with `total`, `generated: 0`, and `skippedDryRun` equal to `total`.

- [ ] **Step 7: Commit batch script**

Run:

```bash
git add package.json scripts/backfill-product-customer-responsibility-summaries.mjs tests/backfill-product-customer-responsibility-summaries.test.mjs
git commit -m "feat: add customer responsibility summary backfill"
```

---

### Task 10: Seed Product Regression Tests

**Files:**
- Modify: `tests/product-customer-responsibility-summary.test.mjs`
- Modify: `tests/responsibility-section-extractor.test.mjs`

- [ ] **Step 1: Add extractor seed tests**

Add tests for the four seed snippets:

```js
test('extractStructuredResponsibilitySections keeps incremental whole life formula and traffic extra', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'incremental_whole_life',
    records: [{
      title: '鑫荣耀条款',
      pageText: '第五条 保险责任 身故或身体全残保险金 基本保险金额×(1+3.5%)^(n-1)。特定公共交通工具意外伤害身故或身体全残保险金，额外给付基本保险金额的1.5倍。第六条 责任免除',
    }],
  });
  assert.match(result.mainResponsibilityText, /3\.5%/u);
  assert.match(result.mainResponsibilityText, /1\.5倍/u);
});

test('extractStructuredResponsibilitySections keeps participating annuity optional responsibility', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'annuity',
    records: [{
      title: '尊贵人生条款',
      pageText: '第五条 保险责任 关爱年金 生存保险金 身故保险金 2.3.2 可选责任 祝寿金 身故或身体全残保险金。第六条 责任免除 保单分红 年度分红以增加保险金额的方式进行分配。',
    }],
  });
  assert.match(result.mainResponsibilityText, /可选责任/u);
  assert.match(result.mainResponsibilityText, /祝寿金/u);
});
```

- [ ] **Step 2: Add summary seed test names**

Add a table-driven test with mocked DeepSeek output:

```js
test('generateProductCustomerResponsibilitySummary seed product prompts include required category terms', async () => {
  const cases = [
    {
      name: '鑫荣耀',
      pageText: '第五条 保险责任 身故或身体全残保险金 基本保险金额×(1+3.5%)^(n-1) 特定公共交通工具意外伤害身故或身体全残保险金 第六条 责任免除',
      expectedPrompt: /复利递增/u,
      responseTitle: '身故或身体全残保险金',
    },
    {
      name: '尊贵人生年金保险(分红型)',
      pageText: '第五条 保险责任 关爱年金 生存保险金 身故保险金 可选责任 祝寿金 第六条 本合同保障的疾病列表 保单分红 年度分红',
      expectedPrompt: /领取时间/u,
      responseTitle: '关爱年金',
    },
  ];
  for (const item of cases) {
    const result = await generateProductCustomerResponsibilitySummary({
      state: {
        knowledgeRecords: [{ company, productName: item.name, official: true, url: sourceUrl, pageText: item.pageText }],
        insuranceIndicatorRecords: [],
      },
      db: dbWithCards([]),
      input: { company, name: item.name },
      findSummary: async () => null,
      persistSummary: async (row) => row,
      persistGenerationRun: async (run) => run,
      generateWithDeepSeek: async ({ prompt }) => {
        assert.match(prompt, item.expectedPrompt);
        return {
          headline: '摘要',
          responsibilities: [{ title: item.responseTitle, plainText: item.pageText, paymentRule: item.pageText }],
          productFunctions: [],
          importantNotes: [],
          missingOrUnclear: [],
        };
      },
    });
    assert.equal(result.ok, true);
  }
});
```

- [ ] **Step 3: Run seed tests**

Run:

```bash
node --test tests/responsibility-section-extractor.test.mjs
node --test tests/product-customer-responsibility-summary.test.mjs --test-name-pattern "seed product"
```

Expected: pass.

- [ ] **Step 4: Commit regression tests**

Run:

```bash
git add tests/product-customer-responsibility-summary.test.mjs tests/responsibility-section-extractor.test.mjs
git commit -m "test: cover structured responsibility seed products"
```

---

### Task 11: Final Verification

**Files:**
- No new source files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
node --test tests/responsibility-source-resolver.test.mjs
node --test tests/responsibility-section-extractor.test.mjs
node --test tests/insurance-product-category-router.test.mjs
node --test tests/responsibility-summary-templates.test.mjs
node --test tests/responsibility-summary-quality-gate.test.mjs
node --test tests/product-customer-responsibility-summary.test.mjs
node --test tests/sqlite-state-store.test.mjs --test-name-pattern "product customer|generation runs"
node --test tests/backfill-product-customer-responsibility-summaries.test.mjs
```

Expected: all pass.

- [ ] **Step 2: Run server check**

Run:

```bash
npm run check
```

Expected: pass.

- [ ] **Step 3: Run full test suite**

Run:

```bash
npm test
```

Expected: pass, or document any existing unrelated failures with exact test names and assertions.

- [ ] **Step 4: Run dry-run backfill smoke test**

Run:

```bash
npm run responsibility-summary:backfill -- --version v22 --limit 2 --dry-run
```

Expected: JSON report prints successfully and does not write summaries.

- [ ] **Step 5: Commit final verification notes if a docs update was needed**

If verification uncovered a command or behavior that needs project documentation, update the closest relevant docs file and commit it:

```bash
git add docs/superpowers/plans/2026-07-01-structured-responsibility-rag-governance.md
git commit -m "docs: update structured responsibility rag plan"
```

If no docs change was needed, skip this commit step.
