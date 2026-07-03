# Product Understanding Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a DeepSeek-powered Planner layer, a Planner mode switch, and configurable customer summary blocks for insurance product responsibility summaries.

**Architecture:** Keep the existing official-source and structured RAG flow as the evidence source. Add a focused backend Planner service that optionally calls DeepSeek before final summary generation, then pass the Planner output into the existing final DeepSeek prompt while preserving current customer-summary fields. The frontend only sends a debug Planner mode and renders the existing summary shape in this phase.

**Tech Stack:** Node.js ESM modules under `server/`, Node test runner under `tests/`, React/TypeScript under `src/`, existing DeepSeek HTTP integration, existing SQLite-backed customer summary persistence.

---

## File Structure

- Create `server/responsibility-planner.service.mjs`: Planner mode normalization, auto-trigger decision, Planner prompt builder, DeepSeek Planner call wrapper, JSON normalization, and failure fallback metadata.
- Create `tests/responsibility-planner-service.test.mjs`: focused unit tests for Planner mode, trigger rules, prompt shape, output normalization, success, and fallback.
- Modify `server/responsibility-summary-templates.mjs`: accept optional Planner output, include it in the final prompt, and require the new `contentBlocks` schema.
- Modify `tests/responsibility-summary-templates.test.mjs`: prompt tests for Planner context, content block schema, official-evidence-only product functions, and old field compatibility.
- Modify `server/product-customer-responsibility-summary.service.mjs`: bump summary version, run Planner between routing and final prompt, normalize/persist content blocks, store Planner metadata in payload and generation runs.
- Modify `tests/product-customer-responsibility-summary.test.mjs`: integration tests for `auto/all/off`, Planner fallback, payload/run metadata, content blocks, and version bump.
- Modify `server/app.mjs`: preserve `plannerMode` in normalized responsibility query input.
- Modify `server/routes/responsibilities.routes.mjs`: pass the Planner DeepSeek caller into the customer-summary service.
- Modify `tests/policy-ocr-flow.test.mjs`: route-level assertion that request `plannerMode` reaches the generation service without changing existing API shape.
- Modify `src/api/contracts/responsibility.ts`: add Planner mode type, request field, and optional content block response type.
- Modify `src/apps/customer/CustomerApp.tsx`: add responsibility assistant Planner mode state and pass it to the API and assistant UI.
- Modify `src/features/responsibility-assistant/ResponsibilityAssistant.tsx`: add a compact segmented Planner switch for debug testing.
- Modify `tests/customer-ui-style.test.mjs`: source-level assertions that the UI exposes the switch and sends `plannerMode`.

## Success Criteria

- `plannerMode=auto` skips Planner for simple ordinary whole life and calls Planner for complex products such as participating annuity and critical illness.
- `plannerMode=all` forces Planner for every customer-summary generation.
- `plannerMode=off` skips Planner even when the product is complex.
- Planner failure never blocks final summary generation when official source extraction and final DeepSeek generation succeed.
- Final prompt contains Planner advice only when Planner was used, and still contains the official structured RAG evidence.
- Final model output can include four configurable blocks: product purpose, main responsibilities, product functions, and attention notes.
- Existing frontend/API consumers can keep using `headline`, `mainResponsibilities`, `notices`, `requiredPolicyFields`, and `sourceUrls`.
- Payload and run records show `plannerMode`, `plannerUsed`, `plannerReason`, `plannerModel`, Planner output or Planner error, and content blocks.
- Old `customer-summary-v23-structured-rag` cache rows are not reused for the new behavior.

---

### Task 1: Planner Service Unit Tests

**Files:**
- Create: `tests/responsibility-planner-service.test.mjs`
- Create later in Task 2: `server/responsibility-planner.service.mjs`

- [ ] **Step 1: Write failing tests for mode normalization and trigger rules**

Create `tests/responsibility-planner-service.test.mjs` with these imports and tests:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildResponsibilityPlannerPrompt,
  normalizeResponsibilityPlannerMode,
  normalizeResponsibilityPlannerOutput,
  runResponsibilityPlanner,
  shouldUseResponsibilityPlanner,
} from '../server/responsibility-planner.service.mjs';

const simpleWholeLifeRouting = {
  productCategory: 'ordinary_whole_life',
  categoryLabel: '终身寿险',
  featureTags: [],
  modelTier: 'flash',
};

const annuityRouting = {
  productCategory: 'annuity',
  categoryLabel: '年金保险',
  featureTags: ['participating'],
  modelTier: 'pro',
};

const criticalIllnessRouting = {
  productCategory: 'critical_illness',
  categoryLabel: '重大疾病保险',
  featureTags: ['disease_grouping'],
  modelTier: 'pro',
};

const sourceSections = {
  quality: { status: 'complete' },
  sourceInventory: [{ title: '官方条款', url: 'https://example.test/a.pdf' }],
  responsibilityItems: [
    {
      title: '身故或身体全残保险金',
      body: '按已交保险费、现金价值、基本保险金额×(1+3.5%)^(n-1)三者最大者给付。',
      sourceRefs: [{ title: '官方条款', page: 2 }],
    },
  ],
  supplementSections: [
    { title: '保单贷款', body: '最高可贷现金价值余额的80%。' },
  ],
  gaps: [],
};

test('normalizeResponsibilityPlannerMode accepts auto all off and falls back on invalid values', () => {
  assert.equal(normalizeResponsibilityPlannerMode('auto'), 'auto');
  assert.equal(normalizeResponsibilityPlannerMode('all'), 'all');
  assert.equal(normalizeResponsibilityPlannerMode('off'), 'off');
  assert.equal(normalizeResponsibilityPlannerMode('bad', 'all'), 'all');
  assert.equal(normalizeResponsibilityPlannerMode('', 'off'), 'off');
});

test('shouldUseResponsibilityPlanner follows off all and auto trigger rules', () => {
  assert.equal(
    shouldUseResponsibilityPlanner({ mode: 'off', routing: annuityRouting, sourceSections }).usePlanner,
    false,
  );
  assert.equal(
    shouldUseResponsibilityPlanner({ mode: 'all', routing: simpleWholeLifeRouting, sourceSections }).usePlanner,
    true,
  );
  assert.equal(
    shouldUseResponsibilityPlanner({ mode: 'auto', routing: simpleWholeLifeRouting, sourceSections: { quality: { status: 'complete' }, responsibilityItems: [] } }).usePlanner,
    false,
  );
  assert.equal(
    shouldUseResponsibilityPlanner({ mode: 'auto', routing: annuityRouting, sourceSections }).usePlanner,
    true,
  );
  assert.equal(
    shouldUseResponsibilityPlanner({ mode: 'auto', routing: criticalIllnessRouting, sourceSections }).usePlanner,
    true,
  );
});
```

- [ ] **Step 2: Write failing tests for prompt shape and Planner output normalization**

Append these tests to the same file:

```js
test('buildResponsibilityPlannerPrompt includes compact product, routing, sources, and expected JSON keys', () => {
  const prompt = buildResponsibilityPlannerPrompt({
    product: { company: '新华保险', productName: '尊贵人生年金保险（分红型）' },
    localRouting: annuityRouting,
    sourceSections,
    cards: [{ title: '产品说明', content: '红利不保证。' }],
    indicators: [{ name: '保险期间', value: '终身' }],
  });

  assert.match(prompt, /新华保险/);
  assert.match(prompt, /尊贵人生年金保险/);
  assert.match(prompt, /annuity/);
  assert.match(prompt, /responsibilityFocus/);
  assert.match(prompt, /functionFocus/);
  assert.match(prompt, /attentionFocus/);
  assert.match(prompt, /只返回 JSON/);
  assert.doesNotMatch(prompt, /营销话术/);
});

test('normalizeResponsibilityPlannerOutput keeps advisory fields and falls back to routing category', () => {
  const parsed = normalizeResponsibilityPlannerOutput(
    JSON.stringify({
      plannerVersion: 'product-understanding-planner-v1',
      productCategory: 'annuity',
      categoryLabel: '年金保险（分红型）',
      confidence: 'high',
      recommendedTemplate: 'annuity_participating',
      productPurposeFocus: ['长期领取年金'],
      responsibilityFocus: ['年金领取规则', '身故保险金'],
      functionFocus: ['红利', '保单贷款'],
      attentionFocus: ['红利不保证'],
      evidenceNeeds: ['保险责任正文'],
      missingOrUnclear: ['领取金额需结合合同'],
      notesForFinalPrompt: ['不要把红利写成确定保险责任'],
    }),
    annuityRouting,
  );

  assert.equal(parsed.productCategory, 'annuity');
  assert.equal(parsed.categoryLabel, '年金保险（分红型）');
  assert.deepEqual(parsed.functionFocus, ['红利', '保单贷款']);
  assert.deepEqual(parsed.notesForFinalPrompt, ['不要把红利写成确定保险责任']);
});
```

- [ ] **Step 3: Write failing tests for Planner success and fallback**

Append these tests:

```js
test('runResponsibilityPlanner calls DeepSeek when trigger allows it', async () => {
  const calls = [];
  const result = await runResponsibilityPlanner({
    mode: 'all',
    model: 'deepseek-v4-flash',
    product: { company: '新华保险', productName: '鑫荣耀终身寿险' },
    routing: simpleWholeLifeRouting,
    sourceSections,
    cards: [],
    indicators: [],
    generateWithDeepSeek: async ({ prompt, model }) => {
      calls.push({ prompt, model });
      return JSON.stringify({
        productCategory: 'incremental_whole_life',
        categoryLabel: '增额终身寿险',
        confidence: 'high',
        recommendedTemplate: 'incremental_whole_life',
        productPurposeFocus: ['终身身故或全残保障', '有效保险金额递增'],
        responsibilityFocus: ['身故或身体全残保险金'],
        functionFocus: ['保单贷款'],
        attentionFocus: ['现金价值需看合同表'],
        evidenceNeeds: ['保险责任正文'],
        missingOrUnclear: [],
        notesForFinalPrompt: ['强调复利递增功能'],
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'deepseek-v4-flash');
  assert.equal(result.plannerUsed, true);
  assert.equal(result.plannerMode, 'all');
  assert.equal(result.plannerModel, 'deepseek-v4-flash');
  assert.deepEqual(result.planner.productPurposeFocus, ['终身身故或全残保障', '有效保险金额递增']);
});

test('runResponsibilityPlanner returns skipped metadata when auto does not need Planner', async () => {
  const result = await runResponsibilityPlanner({
    mode: 'auto',
    model: 'deepseek-v4-flash',
    product: { company: '新华保险', productName: '普通终身寿险' },
    routing: simpleWholeLifeRouting,
    sourceSections: { quality: { status: 'complete' }, responsibilityItems: [] },
    cards: [],
    indicators: [],
    generateWithDeepSeek: async () => {
      throw new Error('should not be called');
    },
  });

  assert.equal(result.plannerUsed, false);
  assert.equal(result.plannerReason, 'simple_product');
  assert.equal(result.planner, null);
});

test('runResponsibilityPlanner falls back when DeepSeek returns malformed output', async () => {
  const result = await runResponsibilityPlanner({
    mode: 'all',
    model: 'deepseek-v4-flash',
    product: { company: '新华保险', productName: '尊贵人生年金保险（分红型）' },
    routing: annuityRouting,
    sourceSections,
    cards: [],
    indicators: [],
    generateWithDeepSeek: async () => 'not json',
  });

  assert.equal(result.plannerUsed, false);
  assert.equal(result.plannerReason, 'planner_failed');
  assert.match(result.plannerError, /JSON/);
});
```

- [ ] **Step 4: Run tests to verify they fail before implementation**

Run:

```bash
node --test tests/responsibility-planner-service.test.mjs
```

Expected: FAIL with `Cannot find module '../server/responsibility-planner.service.mjs'`.

---

### Task 2: Planner Service Implementation

**Files:**
- Create: `server/responsibility-planner.service.mjs`
- Test: `tests/responsibility-planner-service.test.mjs`

- [ ] **Step 1: Create Planner constants, mode normalization, and compact helpers**

Create `server/responsibility-planner.service.mjs` with this starting implementation:

```js
const PLANNER_MODE_SET = new Set(['auto', 'all', 'off']);
const COMPLEX_CATEGORIES = new Set([
  'participating_life',
  'annuity',
  'critical_illness',
  'universal_life',
  'investment_linked',
  'endowment',
  'long_term_care',
]);

const COMPLEX_SIGNAL_PATTERN =
  /(分红|累积红利|可选责任|年金|领取日|疾病组|多次给付|豁免|护理|账户价值|结算利率|保证利率|投资风险|费用|复利|三者最大|二者较大|\(1\+\d+(?:\.\d+)?%\)\^\(n-1\))/;

function textOf(value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function compactText(value, limit = 1200) {
  const text = textOf(value).replace(/\s+/g, ' ');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function compactArray(items, mapper, limit = 8) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, limit).map(mapper).filter(Boolean);
}

export function normalizeResponsibilityPlannerMode(value, fallback = 'auto') {
  const normalizedFallback = PLANNER_MODE_SET.has(fallback) ? fallback : 'auto';
  const normalized = textOf(value).toLowerCase();
  return PLANNER_MODE_SET.has(normalized) ? normalized : normalizedFallback;
}
```

- [ ] **Step 2: Implement auto-trigger decision**

Append this function:

```js
export function shouldUseResponsibilityPlanner({ mode = 'auto', routing = {}, sourceSections = {} } = {}) {
  const normalizedMode = normalizeResponsibilityPlannerMode(mode);
  if (normalizedMode === 'off') return { usePlanner: false, reason: 'disabled' };
  if (normalizedMode === 'all') return { usePlanner: true, reason: 'forced_all' };

  const category = textOf(routing.productCategory);
  const tags = Array.isArray(routing.featureTags) ? routing.featureTags : [];
  const items = Array.isArray(sourceSections.responsibilityItems) ? sourceSections.responsibilityItems : [];
  const supplements = Array.isArray(sourceSections.supplementSections) ? sourceSections.supplementSections : [];
  const joinedEvidence = compactText(
    [
      category,
      textOf(routing.categoryLabel),
      tags.join(' '),
      ...items.map((item) => `${textOf(item.title)} ${textOf(item.body)} ${textOf(item.paymentRule)}`),
      ...supplements.map((item) => `${textOf(item.title)} ${textOf(item.body)}`),
    ].join('\n'),
    12000,
  );

  if (routing.modelTier === 'pro') return { usePlanner: true, reason: 'pro_model_routing' };
  if (COMPLEX_CATEGORIES.has(category)) return { usePlanner: true, reason: 'complex_category' };
  if (tags.some((tag) => /participating|optional|account|disease|compound|annuity/.test(textOf(tag)))) {
    return { usePlanner: true, reason: 'complex_feature_tag' };
  }
  if (joinedEvidence.length > 5000) return { usePlanner: true, reason: 'long_official_evidence' };
  if (COMPLEX_SIGNAL_PATTERN.test(joinedEvidence)) return { usePlanner: true, reason: 'complex_evidence_signal' };
  return { usePlanner: false, reason: 'simple_product' };
}
```

- [ ] **Step 3: Implement Planner prompt builder**

Append this function:

```js
function compactSourceSections(sourceSections = {}) {
  return {
    quality: sourceSections.quality || null,
    sourceInventory: compactArray(sourceSections.sourceInventory, (source) => ({
      title: compactText(source.title || source.name, 80),
      url: compactText(source.url, 240),
    })),
    responsibilityItems: compactArray(sourceSections.responsibilityItems, (item) => ({
      title: compactText(item.title, 80),
      body: compactText(item.body || item.plainText || item.paymentRule || item.triggerCondition, 1500),
      sourceRefs: compactArray(item.sourceRefs, (ref) => ({
        title: compactText(ref.title || ref.sourceTitle, 80),
        page: ref.page ?? ref.pageNumber ?? null,
      }), 4),
    }), 12),
    supplementSections: compactArray(sourceSections.supplementSections, (section) => ({
      title: compactText(section.title, 80),
      body: compactText(section.body || section.text, 1000),
    }), 8),
    gaps: compactArray(sourceSections.gaps, (gap) => compactText(gap, 120), 8),
  };
}

export function buildResponsibilityPlannerPrompt({
  product,
  localRouting,
  sourceSections,
  cards = [],
  indicators = [],
} = {}) {
  const payload = {
    product: {
      company: textOf(product?.company),
      productName: textOf(product?.productName || product?.name),
    },
    localRouting: localRouting || {},
    sourceSections: compactSourceSections(sourceSections),
    cards: compactArray(cards, (card) => ({
      title: compactText(card.title || card.productName || card.name, 80),
      content: compactText(card.content || card.text || card.summary, 1000),
    }), 6),
    indicators: compactArray(indicators, (indicator) => ({
      name: compactText(indicator.name || indicator.label || indicator.key, 80),
      value: compactText(indicator.value || indicator.text, 240),
    }), 10),
  };

  return [
    '你是保险产品理解 Planner，只负责整理证据和给最终写作模型提供方向，不写最终客户文案。',
    '只返回 JSON，不要 Markdown，不要解释，不要营销话术。',
    'Planner 不能覆盖官方资料；官方证据没有出现的产品功能必须写入 missingOrUnclear，不要放入 functionFocus。',
    '请输出字段：plannerVersion, productCategory, categoryLabel, confidence, recommendedTemplate, productPurposeFocus, responsibilityFocus, functionFocus, attentionFocus, evidenceNeeds, missingOrUnclear, notesForFinalPrompt。',
    'confidence 只能是 high, medium, low。',
    '输入证据如下：',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}
```

- [ ] **Step 4: Implement JSON parsing and output normalization**

Append this function:

```js
function parsePlannerJson(raw) {
  const text = textOf(raw);
  if (!text) throw new Error('Planner returned empty content');
  try {
    return JSON.parse(text);
  } catch (error) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Planner JSON parse failed: ${error.message}`);
    return JSON.parse(match[0]);
  }
}

function stringArray(value, limit = 8) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => compactText(item, 160)).filter(Boolean).slice(0, limit);
}

export function normalizeResponsibilityPlannerOutput(raw, fallbackRouting = {}) {
  const value = typeof raw === 'string' ? parsePlannerJson(raw) : raw;
  if (!value || typeof value !== 'object') throw new Error('Planner output is not an object');
  return {
    plannerVersion: compactText(value.plannerVersion || 'product-understanding-planner-v1', 80),
    productCategory: compactText(value.productCategory || fallbackRouting.productCategory, 80),
    categoryLabel: compactText(value.categoryLabel || fallbackRouting.categoryLabel, 80),
    confidence: ['high', 'medium', 'low'].includes(value.confidence) ? value.confidence : 'medium',
    recommendedTemplate: compactText(value.recommendedTemplate, 80),
    productPurposeFocus: stringArray(value.productPurposeFocus),
    responsibilityFocus: stringArray(value.responsibilityFocus),
    functionFocus: stringArray(value.functionFocus),
    attentionFocus: stringArray(value.attentionFocus),
    evidenceNeeds: stringArray(value.evidenceNeeds),
    missingOrUnclear: stringArray(value.missingOrUnclear),
    notesForFinalPrompt: stringArray(value.notesForFinalPrompt),
  };
}
```

- [ ] **Step 5: Implement DeepSeek Planner caller and orchestration**

Append this implementation:

```js
export async function callDeepSeekForResponsibilityPlanner({
  prompt,
  model = process.env.RESPONSIBILITY_PLANNER_MODEL || 'deepseek-v4-flash',
  fetchImpl = globalThis.fetch,
} = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required for responsibility Planner');
  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '你只返回可解析 JSON。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`DeepSeek Planner request failed: ${response.status} ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  return data?.choices?.[0]?.message?.content || '';
}

export async function runResponsibilityPlanner({
  mode = process.env.RESPONSIBILITY_PLANNER_MODE || 'auto',
  model = process.env.RESPONSIBILITY_PLANNER_MODEL || 'deepseek-v4-flash',
  product,
  routing,
  sourceSections,
  cards = [],
  indicators = [],
  generateWithDeepSeek = callDeepSeekForResponsibilityPlanner,
  logger = console,
} = {}) {
  const plannerMode = normalizeResponsibilityPlannerMode(mode, 'auto');
  const decision = shouldUseResponsibilityPlanner({ mode: plannerMode, routing, sourceSections });
  if (!decision.usePlanner) {
    logger?.info?.(`[customer-responsibility-planner] skipped/${decision.reason}`);
    return {
      plannerMode,
      plannerUsed: false,
      plannerReason: decision.reason,
      plannerModel: model,
      planner: null,
      plannerPrompt: null,
      plannerError: null,
    };
  }

  const prompt = buildResponsibilityPlannerPrompt({
    product,
    localRouting: routing,
    sourceSections,
    cards,
    indicators,
  });

  try {
    logger?.info?.(`[customer-responsibility-planner] called model=${model} mode=${plannerMode}`);
    const raw = await generateWithDeepSeek({ prompt, model });
    const planner = normalizeResponsibilityPlannerOutput(raw, routing);
    logger?.info?.(
      `[customer-responsibility-planner] parsed category=${planner.productCategory} template=${planner.recommendedTemplate}`,
    );
    return {
      plannerMode,
      plannerUsed: true,
      plannerReason: decision.reason,
      plannerModel: model,
      planner,
      plannerPrompt: prompt,
      plannerError: null,
    };
  } catch (error) {
    logger?.warn?.(`[customer-responsibility-planner] failed ${error.message}`);
    return {
      plannerMode,
      plannerUsed: false,
      plannerReason: 'planner_failed',
      plannerModel: model,
      planner: null,
      plannerPrompt: prompt,
      plannerError: error.message,
    };
  }
}
```

- [ ] **Step 6: Run focused Planner tests**

Run:

```bash
node --test tests/responsibility-planner-service.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit Planner service**

Run:

```bash
git add server/responsibility-planner.service.mjs tests/responsibility-planner-service.test.mjs
git commit -m "feat: add responsibility planner service"
```

Expected: commit succeeds.

---

### Task 3: Final Prompt Planner Context and Content Block Schema

**Files:**
- Modify: `server/responsibility-summary-templates.mjs`
- Modify: `tests/responsibility-summary-templates.test.mjs`

- [ ] **Step 1: Write failing prompt tests**

Add these tests to `tests/responsibility-summary-templates.test.mjs` near the existing `buildStructuredResponsibilityPrompt` tests:

```js
test('buildStructuredResponsibilityPrompt includes Planner advice when supplied', () => {
  const prompt = buildStructuredResponsibilityPrompt({
    product: { company: '新华保险', productName: '尊贵人生年金保险（分红型）' },
    routing: { productCategory: 'annuity', categoryLabel: '年金保险', featureTags: ['participating'], modelTier: 'pro' },
    sourceSections: {
      quality: { status: 'complete' },
      responsibilityItems: [{ title: '年金', body: '按合同约定领取年金。' }],
      supplementSections: [{ title: '红利', body: '红利分配是不保证的。' }],
    },
    plannerResult: {
      plannerUsed: true,
      plannerMode: 'auto',
      plannerReason: 'pro_model_routing',
      plannerModel: 'deepseek-v4-flash',
      planner: {
        productCategory: 'annuity',
        categoryLabel: '年金保险（分红型）',
        productPurposeFocus: ['长期领取年金', '参与红利分配但红利不保证'],
        responsibilityFocus: ['年金领取规则', '身故保险金'],
        functionFocus: ['红利', '保单贷款'],
        attentionFocus: ['红利不保证'],
        missingOrUnclear: ['具体领取金额需结合合同'],
        notesForFinalPrompt: ['不要把红利写成确定保险责任'],
      },
    },
  });

  assert.match(prompt, /Planner 结果/);
  assert.match(prompt, /长期领取年金/);
  assert.match(prompt, /不要把红利写成确定保险责任/);
});

test('buildStructuredResponsibilityPrompt requires contentBlocks while preserving old fields', () => {
  const prompt = buildStructuredResponsibilityPrompt({
    product: { company: '新华保险', productName: '鑫荣耀终身寿险' },
    routing: { productCategory: 'incremental_whole_life', categoryLabel: '增额终身寿险', featureTags: ['compound_growth'], modelTier: 'flash' },
    sourceSections: {
      quality: { status: 'complete' },
      responsibilityItems: [{ title: '身故或身体全残保险金', body: '有效保险金额每年3.5%复利递增。' }],
    },
  });

  assert.match(prompt, /contentBlocks/);
  assert.match(prompt, /productPurpose/);
  assert.match(prompt, /responsibilities/);
  assert.match(prompt, /productFunctions/);
  assert.match(prompt, /attentionNotes/);
  assert.match(prompt, /enabled/);
  assert.match(prompt, /editable/);
  assert.match(prompt, /headline/);
  assert.match(prompt, /mainResponsibilities/);
});
```

- [ ] **Step 2: Run prompt tests to verify failure**

Run:

```bash
node --test tests/responsibility-summary-templates.test.mjs
```

Expected: FAIL because `plannerResult` is ignored and `contentBlocks` instructions are absent.

- [ ] **Step 3: Add Planner prompt compaction helper**

In `server/responsibility-summary-templates.mjs`, add this helper near the other prompt compaction helpers:

```js
function compactPlannerResult(plannerResult) {
  if (!plannerResult?.plannerUsed || !plannerResult.planner) return null;
  const planner = plannerResult.planner;
  return {
    plannerMode: plannerResult.plannerMode,
    plannerReason: plannerResult.plannerReason,
    plannerModel: plannerResult.plannerModel,
    productCategory: planner.productCategory,
    categoryLabel: planner.categoryLabel,
    confidence: planner.confidence,
    recommendedTemplate: planner.recommendedTemplate,
    productPurposeFocus: planner.productPurposeFocus || [],
    responsibilityFocus: planner.responsibilityFocus || [],
    functionFocus: planner.functionFocus || [],
    attentionFocus: planner.attentionFocus || [],
    missingOrUnclear: planner.missingOrUnclear || [],
    notesForFinalPrompt: planner.notesForFinalPrompt || [],
  };
}
```

- [ ] **Step 4: Extend `buildStructuredResponsibilityPrompt` signature and prompt body**

Update the function signature in `server/responsibility-summary-templates.mjs` from:

```js
export function buildStructuredResponsibilityPrompt({
  product = {},
  routing = {},
  sourceSections = {},
  cards = [],
  indicators = [],
} = {}) {
```

to:

```js
export function buildStructuredResponsibilityPrompt({
  product = {},
  routing = {},
  sourceSections = {},
  cards = [],
  indicators = [],
  plannerResult = null,
} = {}) {
```

Then add this variable near the existing payload construction:

```js
const plannerPayload = compactPlannerResult(plannerResult);
```

Add this prompt section after local routing/category guidance and before the structured RAG evidence:

```js
...(plannerPayload
  ? [
      'Planner 结果如下。它只用于提示写作重点，不能覆盖官方资料：',
      JSON.stringify(plannerPayload, null, 2),
    ]
  : ['Planner 未使用：请完全根据本地分类、官方结构化证据和产品名称写作。']),
```

- [ ] **Step 5: Add content block output schema instructions**

In the same prompt instruction array, add this JSON schema instruction without removing the old fields:

```js
'必须返回 JSON，且同时保留旧字段和新字段。旧字段包括 headline, mainResponsibilities, notices, requiredPolicyFields, sourceUrls。',
'新增 contentBlocks 数组，固定包含以下 blockKey：productPurpose, responsibilities, productFunctions, attentionNotes。',
'每个 contentBlocks 元素必须包含 blockKey, title, enabled, editable, order, content。enabled 和 editable 均为 true，order 从 1 开始。',
'productPurpose 写这个保险主要做什么；responsibilities 写主要保险责任；productFunctions 只写官方证据明确出现的产品功能/权益；attentionNotes 写红利不保证、现金价值需查表、保障限制、缺失或需核验事项。',
'官方证据没有出现的产品功能不要编写到 productFunctions；如果疑似存在但证据不足，写入 attentionNotes。',
```

- [ ] **Step 6: Run prompt tests**

Run:

```bash
node --test tests/responsibility-summary-templates.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit prompt changes**

Run:

```bash
git add server/responsibility-summary-templates.mjs tests/responsibility-summary-templates.test.mjs
git commit -m "feat: include planner guidance in responsibility prompt"
```

Expected: commit succeeds.

---

### Task 4: Backend Summary Integration, Blocks, and Metadata

**Files:**
- Modify: `server/product-customer-responsibility-summary.service.mjs`
- Modify: `scripts/backfill-product-customer-responsibility-summaries.mjs`
- Modify: `tests/product-customer-responsibility-summary.test.mjs`
- Modify: `tests/backfill-product-customer-responsibility-summaries.test.mjs`

- [ ] **Step 1: Write failing integration tests for Planner modes**

Add tests to `tests/product-customer-responsibility-summary.test.mjs` near the existing model-routing tests:

```js
test('generateProductCustomerResponsibilitySummary skips Planner for simple products in auto mode', async () => {
  let plannerCalls = 0;
  let saved = null;
  const result = await generateProductCustomerResponsibilitySummary({
    state: baseState(),
    db: dbWithCards(),
    input: { company, name: productName, plannerMode: 'auto' },
    findSummary: async () => null,
    persistSummary: async (row) => {
      saved = row;
      return row;
    },
    generateWithDeepSeek: async () => structuredLifeSummary(),
    generatePlannerWithDeepSeek: async () => {
      plannerCalls += 1;
      return '{}';
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'generated');
  assert.equal(plannerCalls, 0);
  assert.equal(saved?.payload?.plannerMode, 'auto');
  assert.equal(saved?.payload?.plannerUsed, false);
});

test('generateProductCustomerResponsibilitySummary calls Planner for complex products in auto mode', async () => {
  let saved = null;
  const plannerPrompts = [];
  const annuityProductName = '尊贵人生年金保险（分红型）';
  const state = baseState();
  state.knowledgeRecords = state.knowledgeRecords.map((record) => ({
    ...record,
    productName: annuityProductName,
    pageText: '第五条 保险责任 年金 自约定领取日起按合同领取。身故保险金按现金价值给付。红利分配是不保证的。',
  }));
  state.insuranceIndicatorRecords = [];
  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards([]),
    input: { company, name: annuityProductName, plannerMode: 'auto' },
    findSummary: async () => null,
    persistSummary: async (row) => {
      saved = row;
      return row;
    },
    generateWithDeepSeek: async ({ prompt }) => {
      assert.match(prompt, /Planner 结果/);
      return structuredLifeSummary({
        productCategory: 'annuity',
        categoryLabel: '年金保险',
        headline: '这是一款长期领取年金并兼顾身故保障的保险。',
        responsibilities: [{ title: '年金', plainText: '按合同约定领取年金。', triggerCondition: '到达约定领取日。', paymentRule: '领取金额以合同约定为准。', calculationStatus: 'scheduled_cashflow' }],
        productFunctions: ['红利分配'],
        importantNotes: ['红利分配是不保证的。'],
        contentBlocks: validCustomerSummaryBlocks(),
      });
    },
    generatePlannerWithDeepSeek: async ({ prompt }) => {
      plannerPrompts.push(prompt);
      return JSON.stringify({
        productCategory: 'annuity',
        categoryLabel: '年金保险（分红型）',
        confidence: 'high',
        recommendedTemplate: 'annuity_participating',
        productPurposeFocus: ['长期领取年金'],
        responsibilityFocus: ['年金领取规则', '身故保险金'],
        functionFocus: ['红利'],
        attentionFocus: ['红利不保证'],
        evidenceNeeds: ['保险责任正文'],
        missingOrUnclear: [],
        notesForFinalPrompt: ['红利写入注意事项'],
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(plannerPrompts.length, 1);
  assert.equal(saved?.payload?.plannerUsed, true);
  assert.equal(result.summary.contentBlocks.length, 4);
});
```

Add this local helper near the existing helper section:

```js
function validCustomerSummaryBlocks() {
  return [
    { blockKey: 'productPurpose', title: '产品主要做什么', enabled: true, editable: true, order: 1, content: '主要提供长期保障。' },
    { blockKey: 'responsibilities', title: '主要保险责任', enabled: true, editable: true, order: 2, content: '包含身故或身体全残保险金。' },
    { blockKey: 'productFunctions', title: '产品功能/权益', enabled: true, editable: true, order: 3, content: '官方资料明确支持保单贷款。' },
    { blockKey: 'attentionNotes', title: '注意事项', enabled: true, editable: true, order: 4, content: '现金价值需结合合同表。' },
  ];
}
```

- [ ] **Step 2: Write failing tests for all/off, Planner failure, and payload metadata**

Add these tests:

```js
test('generateProductCustomerResponsibilitySummary honors plannerMode all and off', async () => {
  let allCalls = 0;
  await generateProductCustomerResponsibilitySummary({
    state: baseState(),
    db: dbWithCards(),
    input: { company, name: productName, plannerMode: 'all' },
    findSummary: async () => null,
    persistSummary: async (row) => row,
    generateWithDeepSeek: async () => structuredLifeSummary(),
    generatePlannerWithDeepSeek: async () => {
      allCalls += 1;
      return JSON.stringify({ productPurposeFocus: ['终身保障'], responsibilityFocus: ['身故保险金'] });
    },
  });
  assert.equal(allCalls, 1);

  let offCalls = 0;
  let offSaved = null;
  const annuityProductName = '尊贵人生年金保险（分红型）';
  const state = baseState();
  state.knowledgeRecords = state.knowledgeRecords.map((record) => ({
    ...record,
    productName: annuityProductName,
    pageText: '第五条 保险责任 年金 按合同领取。红利分配是不保证的。',
  }));
  state.insuranceIndicatorRecords = [];
  const offResult = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards([]),
    input: { company, name: annuityProductName, plannerMode: 'off' },
    findSummary: async () => null,
    persistSummary: async (row) => {
      offSaved = row;
      return row;
    },
    generateWithDeepSeek: async ({ prompt }) => {
      assert.doesNotMatch(prompt, /Planner 结果/);
      return structuredLifeSummary({ productCategory: 'annuity', categoryLabel: '年金保险' });
    },
    generatePlannerWithDeepSeek: async () => {
      offCalls += 1;
      return '{}';
    },
  });
  assert.equal(offResult.ok, true);
  assert.equal(offCalls, 0);
  assert.equal(offSaved?.payload?.plannerMode, 'off');
  assert.equal(offSaved?.payload?.plannerUsed, false);
});

test('generateProductCustomerResponsibilitySummary falls back when Planner fails and records failure metadata', async () => {
  let saved = null;
  const annuityProductName = '尊贵人生年金保险（分红型）';
  const state = baseState();
  state.knowledgeRecords = state.knowledgeRecords.map((record) => ({
    ...record,
    productName: annuityProductName,
    pageText: '第五条 保险责任 年金 按合同领取。红利分配是不保证的。',
  }));
  state.insuranceIndicatorRecords = [];
  const result = await generateProductCustomerResponsibilitySummary({
    state,
    db: dbWithCards([]),
    input: { company, name: annuityProductName, plannerMode: 'all' },
    findSummary: async () => null,
    persistSummary: async (row) => {
      saved = row;
      return row;
    },
    generateWithDeepSeek: async ({ prompt }) => {
      assert.doesNotMatch(prompt, /Planner 结果如下/);
      return structuredLifeSummary({ productCategory: 'annuity', categoryLabel: '年金保险' });
    },
    generatePlannerWithDeepSeek: async () => 'not json',
  });

  assert.equal(result.ok, true);
  assert.equal(saved?.payload?.plannerUsed, false);
  assert.equal(saved?.payload?.plannerReason, 'planner_failed');
  assert.match(saved?.payload?.plannerError, /JSON/);
});
```

- [ ] **Step 3: Bump summary version**

In `server/product-customer-responsibility-summary.service.mjs`, change:

```js
export const CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION = 'customer-summary-v23-structured-rag';
```

to:

```js
export const CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION = 'customer-summary-v24-planner-blocks';
```

Update the expected constant in `tests/product-customer-responsibility-summary.test.mjs` to `customer-summary-v24-planner-blocks`.

In `scripts/backfill-product-customer-responsibility-summaries.mjs`, update `resolveSummaryVersion` from accepting `v23` to accepting `v24`:

```js
function resolveSummaryVersion(value) {
  const version = text(value);
  if (!version || version === 'v24' || version === SUPPORTED_SUMMARY_VERSION) return SUPPORTED_SUMMARY_VERSION;
  throw new Error(`Only ${SUPPORTED_SUMMARY_VERSION} is supported`);
}
```

In `tests/backfill-product-customer-responsibility-summaries.test.mjs`, rename the first test to `parseBackfillArgs resolves v24 alias and options`, pass `v24`, and update all expected strings from `customer-summary-v23-structured-rag` to `customer-summary-v24-planner-blocks`.

- [ ] **Step 4: Import and inject Planner dependencies**

In `server/product-customer-responsibility-summary.service.mjs`, add:

```js
import {
  callDeepSeekForResponsibilityPlanner,
  normalizeResponsibilityPlannerMode,
  runResponsibilityPlanner,
} from './responsibility-planner.service.mjs';
```

Update the `generateProductCustomerResponsibilitySummary` function parameters from:

```js
export async function generateProductCustomerResponsibilitySummary({
  state = {},
  db,
  input = {},
  findSummary,
  persistSummary,
  persistGenerationRun,
  generateWithDeepSeek = callDeepSeekForCustomerResponsibilitySummary,
  generateOfficialAnalysis,
  modelName = resolveDeepSeekConfig().model,
  nowIso = () => new Date().toISOString(),
} = {}) {
```

to:

```js
export async function generateProductCustomerResponsibilitySummary({
  state = {},
  db,
  input = {},
  findSummary,
  persistSummary,
  persistGenerationRun,
  generateWithDeepSeek = callDeepSeekForCustomerResponsibilitySummary,
  generatePlannerWithDeepSeek = callDeepSeekForResponsibilityPlanner,
  generateOfficialAnalysis,
  modelName = resolveDeepSeekConfig().model,
  nowIso = () => new Date().toISOString(),
  logger = console,
} = {}) {
```

- [ ] **Step 5: Run Planner after final routing and before final prompt**

After the final `routing = routeInsuranceProductCategory(...)` block and before `buildStructuredResponsibilityPrompt(...)`, add:

```js
const plannerMode = normalizeResponsibilityPlannerMode(
  input?.plannerMode,
  process.env.RESPONSIBILITY_PLANNER_MODE || 'auto',
);
const plannerResult = await runResponsibilityPlanner({
  mode: plannerMode,
  model: process.env.RESPONSIBILITY_PLANNER_MODEL || 'deepseek-v4-flash',
  product: { company, productName },
  routing,
  sourceSections,
  cards,
  indicators,
  generateWithDeepSeek: generatePlannerWithDeepSeek,
  logger,
});
```

Update the `buildStructuredResponsibilityPrompt` call to include:

```js
plannerResult,
```

- [ ] **Step 6: Normalize content blocks while preserving old fields**

Add these helpers near the existing summary normalization helpers:

```js
const CUSTOMER_SUMMARY_BLOCK_DEFINITIONS = [
  { blockKey: 'productPurpose', title: '产品主要做什么', order: 1 },
  { blockKey: 'responsibilities', title: '主要保险责任', order: 2 },
  { blockKey: 'productFunctions', title: '产品功能/权益', order: 3 },
  { blockKey: 'attentionNotes', title: '注意事项', order: 4 },
];

function linesToText(lines) {
  return lines.map((line) => String(line || '').trim()).filter(Boolean).join('\n');
}

function defaultCustomerSummaryBlocks(summary, source = {}) {
  const responsibilities = Array.isArray(summary.mainResponsibilities) ? summary.mainResponsibilities : [];
  const notices = Array.isArray(summary.notices) ? summary.notices : [];
  const productFunctions = Array.isArray(source.productFunctions)
    ? source.productFunctions.map((item) => (typeof item === 'string' ? item : item?.title || item?.name || item?.plainText)).filter(Boolean)
    : [];
  return [
    { blockKey: 'productPurpose', content: summary.headline || '' },
    {
      blockKey: 'responsibilities',
      content: linesToText(responsibilities.map((item) => `${item.title || '保险责任'}：${item.plainText || item.howItPays || ''}`)),
    },
    { blockKey: 'productFunctions', content: linesToText(productFunctions) },
    { blockKey: 'attentionNotes', content: linesToText(notices) },
  ];
}

function normalizeCustomerSummaryContentBlocks(rawBlocks, normalizedSummary, source = {}) {
  const rawByKey = new Map(
    (Array.isArray(rawBlocks) ? rawBlocks : defaultCustomerSummaryBlocks(normalizedSummary, source))
      .filter((block) => block && typeof block === 'object')
      .map((block) => [String(block.blockKey || '').trim(), block]),
  );
  return CUSTOMER_SUMMARY_BLOCK_DEFINITIONS.map((definition) => {
    const raw = rawByKey.get(definition.blockKey) || {};
    return {
      blockKey: definition.blockKey,
      title: String(raw.title || definition.title).trim() || definition.title,
      enabled: raw.enabled !== false,
      editable: raw.editable !== false,
      order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : definition.order,
      content: String(raw.content || '').trim(),
    };
  });
}
```

Inside `normalizeStructuredSummaryToCustomerSummary`, after the old fields are normalized, assign:

```js
summary.contentBlocks = normalizeCustomerSummaryContentBlocks(source.contentBlocks, summary, source);
```

Inside the customer-safe return shaping function, preserve enabled content blocks:

```js
contentBlocks: Array.isArray(summary.contentBlocks)
  ? summary.contentBlocks.filter((block) => block.enabled !== false)
  : [],
```

- [ ] **Step 7: Persist Planner metadata in summary context, payload, and run records**

After `const summaryContext = buildSummaryContext(...)`, merge Planner fields into `summaryContext`:

```js
Object.assign(summaryContext, {
  plannerMode: plannerResult.plannerMode,
  plannerUsed: plannerResult.plannerUsed,
  plannerReason: plannerResult.plannerReason,
  plannerModel: plannerResult.plannerModel,
  plannerOutput: plannerResult.planner,
  plannerError: plannerResult.plannerError,
});
```

Inside `persistReadyCustomerSummary(...)`, include these fields in `row.payload`:

```js
plannerMode: summaryContext.plannerMode,
plannerUsed: summaryContext.plannerUsed,
plannerReason: summaryContext.plannerReason,
plannerModel: summaryContext.plannerModel,
plannerOutput: summaryContext.plannerOutput,
plannerError: summaryContext.plannerError,
contentBlocks: summaryJson.contentBlocks,
```

Extend `buildGenerationRun(...)` to accept `plannerResult = null` and include the same Planner fields plus a compact prompt preview in `payload`:

```js
planner: plannerResult
  ? {
      plannerMode: plannerResult.plannerMode,
      plannerUsed: plannerResult.plannerUsed,
      plannerReason: plannerResult.plannerReason,
      plannerModel: plannerResult.plannerModel,
      plannerOutput: plannerResult.planner,
      plannerError: plannerResult.plannerError,
      plannerPromptPreview: plannerResult.plannerPrompt ? plannerResult.plannerPrompt.slice(0, 2000) : null,
    }
  : null,
```

Add `plannerResult` to the `persistReadyCustomerSummary(...)` parameter list and to its `buildGenerationRun(...)` call:

```js
plannerResult,
```

When calling `persistReadyCustomerSummary(...)` from `generateProductCustomerResponsibilitySummary`, pass:

```js
plannerResult,
```

For any `buildGenerationRun(...)` call that happens after `plannerResult` has been created, also pass:

```js
plannerResult,
```

- [ ] **Step 8: Run focused backend summary tests**

Run:

```bash
node --test tests/product-customer-responsibility-summary.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Run backfill argument tests**

Run:

```bash
node --test tests/backfill-product-customer-responsibility-summaries.test.mjs
```

Expected: PASS after the version constant update.

- [ ] **Step 10: Commit backend integration**

Run:

```bash
git add server/product-customer-responsibility-summary.service.mjs scripts/backfill-product-customer-responsibility-summaries.mjs tests/product-customer-responsibility-summary.test.mjs tests/backfill-product-customer-responsibility-summaries.test.mjs
git commit -m "feat: wire planner into customer responsibility summaries"
```

Expected: commit succeeds.

---

### Task 5: API Request Override

**Files:**
- Modify: `server/app.mjs`
- Modify: `server/routes/responsibilities.routes.mjs`
- Modify: `tests/policy-ocr-flow.test.mjs`

- [ ] **Step 1: Write failing route test for request-level `plannerMode` and Planner injection**

In `tests/policy-ocr-flow.test.mjs`, add a test near the existing `/api/policy-responsibilities/customer-summary` tests:

```js
test('customer summary endpoint forwards plannerMode override to Planner', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE policies (id INTEGER PRIMARY KEY)');
  const state = {
    ...createInitialState(),
    knowledgeRecords: [{
      id: 1,
      company: '新华保险',
      productName: '盛世荣耀',
      title: '盛世荣耀条款',
      url: 'https://example.test/terms.pdf',
      pageText: '第五条 保险责任 身故或身体全残保险金 按合同约定给付。',
      official: true,
    }],
    insuranceIndicatorRecords: [],
  };
  const persistedSummaries = new Map();
  let plannerCalls = 0;
  const app = createPolicyOcrApp({
    state,
    db,
    recomputeCashflowOnStartup: false,
    findProductCustomerResponsibilitySummary: async ({ productKey, summaryVersion, sourceDigest }) => {
      const row = persistedSummaries.get(`${productKey}:${summaryVersion}`);
      return row && row.sourceDigest === sourceDigest ? row : null;
    },
    persistProductCustomerResponsibilitySummary: async ({ summary }) => {
      persistedSummaries.set(`${summary.productKey}:${summary.summaryVersion}`, summary);
      state.productCustomerResponsibilitySummaries = [...persistedSummaries.values()];
      return summary;
    },
    generateProductCustomerResponsibilitySummaryWithDeepSeek: async ({ prompt }) => {
      assert.match(prompt, /Planner 结果/);
      return {
        productCategory: 'ordinary_whole_life',
        categoryLabel: '终身寿险',
        headline: '这是一份以身故或身体全残保障为主的终身寿险。',
        responsibilities: [{
          title: '身故或身体全残保险金',
          plainText: '发生身故或身体全残时按合同约定给付。',
          triggerCondition: '身故或身体全残。',
          paymentRule: '金额以合同约定为准。',
          calculationStatus: 'claim_contingent',
        }],
        productFunctions: [],
        importantNotes: [],
        missingOrUnclear: [],
        contentBlocks: [
          { blockKey: 'productPurpose', title: '产品主要做什么', enabled: true, editable: true, order: 1, content: '主要提供终身保障。' },
          { blockKey: 'responsibilities', title: '主要保险责任', enabled: true, editable: true, order: 2, content: '包含身故或身体全残保险金。' },
          { blockKey: 'productFunctions', title: '产品功能/权益', enabled: true, editable: true, order: 3, content: '' },
          { blockKey: 'attentionNotes', title: '注意事项', enabled: true, editable: true, order: 4, content: '具体金额以合同为准。' },
        ],
      };
    },
    generateProductCustomerResponsibilityPlannerWithDeepSeek: async ({ prompt }) => {
      plannerCalls += 1;
      assert.match(prompt, /盛世荣耀/);
      return JSON.stringify({
        productCategory: 'ordinary_whole_life',
        categoryLabel: '终身寿险',
        confidence: 'high',
        productPurposeFocus: ['终身身故或全残保障'],
        responsibilityFocus: ['身故或身体全残保险金'],
        functionFocus: [],
        attentionFocus: ['具体金额以合同为准'],
        evidenceNeeds: ['保险责任正文'],
        missingOrUnclear: [],
        notesForFinalPrompt: ['按官方责任正文写'],
      });
    },
  });
  const server = await listen(app);

  try {
    const response = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/customer-summary', {
      method: 'POST',
      body: JSON.stringify({
        company: '新华保险',
        name: '盛世荣耀',
        plannerMode: 'all',
      }),
    });
    assert.equal(response.response.status, 200);
    assert.equal(response.payload.ok, true);
    assert.equal(plannerCalls, 1);
    assert.equal(response.payload.summary.contentBlocks.length, 4);
  } finally {
    await server.close();
    db.close();
  }
});
```

- [ ] **Step 2: Run the route test to verify failure**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "customer summary endpoint forwards plannerMode override to Planner"
```

Expected: FAIL because `plannerMode` is removed by request normalization and the Planner DeepSeek caller is not passed through the route context.

- [ ] **Step 3: Preserve `plannerMode` in request normalization**

In `server/app.mjs`, update `normalizeResponsibilityQueryInput(value = {})` from returning only:

```js
return {
  company,
  name,
};
```

to:

```js
const plannerMode = typeof value.plannerMode === 'string' ? value.plannerMode.trim() : '';
return {
  company,
  name,
  ...(plannerMode ? { plannerMode } : {}),
};
```

- [ ] **Step 4: Add Planner DeepSeek caller injection to app and route context**

In `server/app.mjs`, add this next to `generateProductCustomerResponsibilitySummaryWithDeepSeek`:

```js
const generateProductCustomerResponsibilityPlannerWithDeepSeek =
  options.generateProductCustomerResponsibilityPlannerWithDeepSeek;
```

Pass it into `createRouteContext`:

```js
generateProductCustomerResponsibilityPlannerWithDeepSeek,
```

In `server/routes/responsibilities.routes.mjs`, destructure it from context:

```js
generateProductCustomerResponsibilityPlannerWithDeepSeek,
```

Add it to the customer-summary service call:

```js
generatePlannerWithDeepSeek: generateProductCustomerResponsibilityPlannerWithDeepSeek,
```

- [ ] **Step 5: Run the focused route test**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "customer summary endpoint forwards plannerMode override to Planner"
```

Expected: PASS.

- [ ] **Step 6: Commit API override**

Run:

```bash
git add server/app.mjs server/routes/responsibilities.routes.mjs tests/policy-ocr-flow.test.mjs
git commit -m "feat: accept planner mode override"
```

Expected: commit succeeds.

---

### Task 6: Frontend Contract and Responsibility Assistant Switch

**Files:**
- Modify: `src/api/contracts/responsibility.ts`
- Modify: `src/apps/customer/CustomerApp.tsx`
- Modify: `src/features/responsibility-assistant/ResponsibilityAssistant.tsx`
- Modify: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Write failing UI source tests**

Append these tests to `tests/customer-ui-style.test.mjs` near the existing responsibility assistant tests:

```js
test('ResponsibilityAssistant exposes planner mode switch labels', () => {
  const source = componentSource('ResponsibilityAssistant', null);
  assert.match(source, /plannerMode/);
  assert.match(source, /自动/);
  assert.match(source, /全部Planner/);
  assert.match(source, /关闭Planner/);
});

test('CustomerApp sends selected plannerMode to customer summary API', () => {
  assert.match(customerSource, /assistantPlannerMode/);
  assert.match(customerSource, /plannerMode:\s*assistantPlannerMode/);
});
```

- [ ] **Step 2: Run UI source tests to verify failure**

Run:

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern "plannerMode|planner mode"
```

Expected: FAIL because the UI has no Planner switch yet.

- [ ] **Step 3: Extend frontend API contract**

In `src/api/contracts/responsibility.ts`, add these exported types near the customer summary types:

```ts
export type ResponsibilityPlannerMode = 'auto' | 'all' | 'off';

export type CustomerResponsibilitySummaryBlock = {
  blockKey: 'productPurpose' | 'responsibilities' | 'productFunctions' | 'attentionNotes' | string;
  title: string;
  enabled: boolean;
  editable: boolean;
  order: number;
  content: string;
};
```

Extend `CustomerResponsibilitySummary` with:

```ts
contentBlocks?: CustomerResponsibilitySummaryBlock[];
```

Change the API function signature from:

```ts
export function getProductCustomerResponsibilitySummary(input: { company: string; name: string }) {
```

to:

```ts
export function getProductCustomerResponsibilitySummary(input: {
  company: string;
  name: string;
  plannerMode?: ResponsibilityPlannerMode;
}) {
```

and include the mode in the request body:

```ts
body: JSON.stringify({
  company: input.company,
  name: input.name,
  ...(input.plannerMode ? { plannerMode: input.plannerMode } : {}),
}),
```

- [ ] **Step 4: Add state and request parameter in `CustomerApp`**

In `src/apps/customer/CustomerApp.tsx`, import the new type from the responsibility contract:

```ts
import type { ResponsibilityPlannerMode } from '../../api/contracts/responsibility';
```

Near existing responsibility assistant state, add:

```ts
const [assistantPlannerMode, setAssistantPlannerMode] = useState<ResponsibilityPlannerMode>('auto');
```

Update the summary request from:

```ts
const summaryPayload = await getProductCustomerResponsibilitySummary({
  company,
  name,
});
```

to:

```ts
const summaryPayload = await getProductCustomerResponsibilitySummary({
  company,
  name,
  plannerMode: assistantPlannerMode,
});
```

Pass these props to `<ResponsibilityAssistant />`:

```tsx
plannerMode={assistantPlannerMode}
onChangePlannerMode={setAssistantPlannerMode}
```

- [ ] **Step 5: Add compact switch in `ResponsibilityAssistant`**

In `src/features/responsibility-assistant/ResponsibilityAssistant.tsx`, import the type:

```ts
import type { ResponsibilityPlannerMode } from '../../api/contracts/responsibility';
```

Extend props with:

```ts
plannerMode: ResponsibilityPlannerMode;
onChangePlannerMode: (mode: ResponsibilityPlannerMode) => void;
```

Add this option list near component constants:

```ts
const plannerModeOptions: Array<{ value: ResponsibilityPlannerMode; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'all', label: '全部Planner' },
  { value: 'off', label: '关闭Planner' },
];
```

Render this switch near the query button:

```tsx
<div className="flex rounded-[8px] border border-slate-200 bg-slate-50 p-1 text-[12px] font-semibold text-slate-500">
  {plannerModeOptions.map((option) => (
    <button
      key={option.value}
      type="button"
      className={[
        'h-8 flex-1 rounded-[6px] px-2 transition',
        props.plannerMode === option.value ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500',
      ].join(' ')}
      onClick={() => props.onChangePlannerMode(option.value)}
    >
      {option.label}
    </button>
  ))}
</div>
```

- [ ] **Step 6: Run frontend source tests**

Run:

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern "plannerMode|planner mode"
```

Expected: PASS.

- [ ] **Step 7: Run frontend type and build checks**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both PASS.

- [ ] **Step 8: Commit frontend switch**

Run:

```bash
git add src/api/contracts/responsibility.ts src/apps/customer/CustomerApp.tsx src/features/responsibility-assistant/ResponsibilityAssistant.tsx tests/customer-ui-style.test.mjs
git commit -m "feat: add planner mode switch to assistant"
```

Expected: commit succeeds.

---

### Task 7: Verification, Development Cache, and Dev Stack

**Files:**
- No source files created in this task.
- Development SQLite path only: `.runtime/local/policy-ocr.sqlite`

- [ ] **Step 1: Run focused Planner and prompt tests**

Run:

```bash
node --test tests/responsibility-planner-service.test.mjs
node --test tests/responsibility-summary-templates.test.mjs
node --test tests/product-customer-responsibility-summary.test.mjs
node --test tests/backfill-product-customer-responsibility-summaries.test.mjs
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "customer summary endpoint forwards plannerMode override to Planner"
node --test tests/customer-ui-style.test.mjs --test-name-pattern "plannerMode|planner mode"
```

Expected: all listed focused tests PASS.

- [ ] **Step 2: Run project verification**

Run:

```bash
npm run check
npm run typecheck
npm run build
npm test
```

Expected: `npm run check`, `npm run typecheck`, and `npm run build` PASS. `npm test` should PASS or only show the already-known unrelated family report failures; if those failures remain, record the exact test names and assertions in the final handoff.

- [ ] **Step 3: Clear development customer responsibility caches**

Stop only the development stack:

```bash
npm run local:dev:stop
```

Clear only customer responsibility summary cache tables in the development database:

```bash
sqlite3 .runtime/local/policy-ocr.sqlite "
DELETE FROM product_customer_responsibility_summaries;
DELETE FROM product_customer_summary_generation_runs;
SELECT 'product_customer_responsibility_summaries', COUNT(*) FROM product_customer_responsibility_summaries;
SELECT 'product_customer_summary_generation_runs', COUNT(*) FROM product_customer_summary_generation_runs;
"
```

Expected output includes:

```text
product_customer_responsibility_summaries|0
product_customer_summary_generation_runs|0
```

- [ ] **Step 4: Start development stack**

Run:

```bash
npm run local:dev
```

Expected: development frontend/API/OCR start on the documented ports:

```text
Frontend: http://localhost:3014
API: http://localhost:4207
OCR: http://localhost:4109
```

- [ ] **Step 5: Smoke test the customer-summary endpoint**

Run:

```bash
curl -sS http://localhost:4207/api/policy-responsibilities/customer-summary \
  -H 'Content-Type: application/json' \
  -d '{"company":"新华保险","name":"新华人寿保险股份有限公司鑫荣耀终身寿险","plannerMode":"all"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s); console.log(j.ok); console.log(j.source || j.status); console.log(Array.isArray(j.summary?.contentBlocks) ? j.summary.contentBlocks.length : 0);})"
```

Expected when official source extraction succeeds:

```text
true
generated
4
```

Then inspect the latest development run payload:

```bash
sqlite3 .runtime/local/policy-ocr.sqlite "
SELECT
  json_extract(payload, '$.planner.plannerMode'),
  json_extract(payload, '$.planner.plannerUsed'),
  json_extract(payload, '$.planner.plannerReason')
FROM product_customer_summary_generation_runs
ORDER BY created_at DESC
LIMIT 1;
"
```

Expected with `plannerMode=all`:

```text
all|1|forced_all
```

If official source extraction returns `needs_source_review` or `needs_extraction_review`, capture the JSON status and inspect the generation logs before changing extraction code.

---

## Final Handoff Checklist

- State the final commit SHAs created by the implementation tasks.
- State which Planner mode was used for manual smoke testing.
- State whether development customer-summary cache tables were cleared.
- State that local production was untouched.
- Include verification results for:
  - `node --test tests/responsibility-planner-service.test.mjs`
  - `node --test tests/responsibility-summary-templates.test.mjs`
  - `node --test tests/product-customer-responsibility-summary.test.mjs`
  - `node --test tests/backfill-product-customer-responsibility-summaries.test.mjs`
  - `node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "customer summary endpoint forwards plannerMode override to Planner"`
  - `node --test tests/customer-ui-style.test.mjs --test-name-pattern "plannerMode|planner mode"`
  - `npm run check`
  - `npm run typecheck`
  - `npm run build`
  - `npm test`
