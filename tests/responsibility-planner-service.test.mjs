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

const endowmentTrafficRouting = {
  productCategory: 'endowment',
  categoryLabel: '两全保险',
  featureTags: ['traffic_accident_extra'],
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
  supplementSections: [{ title: '保单贷款', body: '最高可贷现金价值余额的80%。' }],
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
    shouldUseResponsibilityPlanner({
      mode: 'auto',
      routing: simpleWholeLifeRouting,
      sourceSections: { quality: { status: 'complete' }, responsibilityItems: [] },
    }).usePlanner,
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
  assert.match(prompt, /positioningFocus/);
  assert.match(prompt, /functionFocus/);
  assert.match(prompt, /attentionFocus/);
  assert.match(prompt, /只返回 JSON/);
  assert.match(prompt, /不要营销话术/);
  assert.match(prompt, /两全保险.*交通\/特定意外高倍保障/u);
});

test('normalizeResponsibilityPlannerOutput keeps advisory fields and falls back to routing category', () => {
  const parsed = normalizeResponsibilityPlannerOutput(
    JSON.stringify({
      plannerVersion: 'product-understanding-planner-v1',
      productCategory: 'annuity',
      categoryLabel: '年金保险（分红型）',
      confidence: 'high',
      recommendedTemplate: 'annuity_participating',
      positioningFocus: ['年金保险', '分红型'],
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
  assert.deepEqual(parsed.positioningFocus, ['年金保险', '分红型']);
  assert.deepEqual(parsed.functionFocus, ['红利', '保单贷款']);
  assert.deepEqual(parsed.notesForFinalPrompt, ['不要把红利写成确定保险责任']);
});

test('runResponsibilityPlanner enriches endowment traffic products with composite positioning', async () => {
  const result = await runResponsibilityPlanner({
    mode: 'all',
    model: 'deepseek-v4-flash',
    product: { company: '新华保险', productName: '畅行万里智赢版两全保险' },
    routing: endowmentTrafficRouting,
    sourceSections: {
      quality: { status: 'complete' },
      mainResponsibilityText: [
        '满期生存保险金 按实际交纳保险费给付。',
        '一般意外伤害身故或身体全残保险金 按基本保险金额10倍给付。',
        '客运列车及航空意外伤害身故或身体全残保险金 按基本保险金额60倍给付。',
        '电梯意外伤害身故或身体全残保险金 按基本保险金额30倍给付。',
      ].join('\n'),
    },
    cards: [],
    indicators: [],
    generateWithDeepSeek: async () => JSON.stringify({
      productCategory: 'endowment',
      categoryLabel: '两全保险',
      confidence: 'medium',
      recommendedTemplate: 'endowment',
      productPurposeFocus: ['满期生存给付'],
      responsibilityFocus: ['满期生存保险金', '多类意外身故或全残保障'],
      functionFocus: [],
      attentionFocus: [],
      evidenceNeeds: [],
      missingOrUnclear: [],
      notesForFinalPrompt: [],
    }),
  });

  assert.equal(result.plannerUsed, true);
  assert.equal(result.planner.categoryLabel, '意外保障型两全保险');
  assert.deepEqual(result.planner.positioningFocus, ['两全保险', '交通/特定意外高倍保障']);
  assert.match(result.planner.notesForFinalPrompt[0], /不要把10条以上责任机械塞进一个展示块/u);
});

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

test('runResponsibilityPlanner repairs malformed JSON from DeepSeek', async () => {
  const result = await runResponsibilityPlanner({
    mode: 'all',
    model: 'deepseek-v4-flash',
    product: { company: '新华保险', productName: '尊贵人生年金保险（分红型）' },
    routing: annuityRouting,
    sourceSections,
    cards: [],
    indicators: [],
    generateWithDeepSeek: async () => [
      '```json',
      '{',
      '  productCategory: "annuity",',
      '  categoryLabel: "年金保险",',
      '  confidence: "high",',
      '  responsibilityFocus: ["年金领取", "身故保险金"],',
      '}',
      '```',
    ].join('\n'),
  });

  assert.equal(result.plannerUsed, true);
  assert.equal(result.planner.productCategory, 'annuity');
  assert.deepEqual(result.planner.responsibilityFocus, ['年金领取', '身故保险金']);
});

test('runResponsibilityPlanner returns skipped metadata when auto does not need Planner', async () => {
  let called = false;
  const result = await runResponsibilityPlanner({
    mode: 'auto',
    model: 'deepseek-v4-flash',
    product: { company: '新华保险', productName: '普通终身寿险' },
    routing: simpleWholeLifeRouting,
    sourceSections: { quality: { status: 'complete' }, responsibilityItems: [] },
    cards: [],
    indicators: [],
    generateWithDeepSeek: async () => {
      called = true;
      throw new Error('should not be called');
    },
  });

  assert.equal(called, false);
  assert.equal(result.plannerUsed, false);
  assert.equal(result.plannerReason, 'simple_product');
});

test('runResponsibilityPlanner returns planner_failed for malformed generator JSON', async () => {
  const result = await runResponsibilityPlanner({
    mode: 'all',
    model: 'deepseek-v4-flash',
    product: { company: '新华保险', productName: '鑫荣耀终身寿险' },
    routing: simpleWholeLifeRouting,
    sourceSections,
    cards: [],
    indicators: [],
    generateWithDeepSeek: async () => 'not json',
  });

  assert.equal(result.plannerUsed, false);
  assert.equal(result.plannerReason, 'planner_failed');
  assert.match(result.plannerError, /JSON/);
});
