import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStructureV3LlmMessages,
  buildStructureV3LlmReport,
  extractStructureV3WithLocalModel,
  normalizeStructureV3LlmPayload,
  validateStructureV3LlmExtraction,
} from '../ocr-service/policy-structurev3-llm-extractor.mjs';

test('buildStructureV3LlmMessages includes tables, OCR text, and rule candidates', () => {
  const messages = buildStructureV3LlmMessages({
    normalized: {
      ocrText: '新华保险 投保人 张三 被保险人 李四',
      tables: [
        {
          title: '保险利益表',
          source: 'raw-table',
          headers: ['险种名称', '保险费'],
          rows: [['主险A', '100元']],
        },
      ],
    },
    candidates: {
      policyFields: {
        company: { value: '新华保险' },
      },
    },
  });

  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /保险保单结构化字段理解器/u);
  assert.match(messages[0].content, /只输出严格 JSON/u);
  assert.match(messages[1].content, /主险A/u);
  assert.match(messages[1].content, /ruleCandidates/u);
  assert.match(messages[1].content, /不要把日期年份/u);
  assert.match(messages[1].content, /按表头字段顺序/u);
  assert.match(messages[1].content, /不要脱离表头顺序猜测金额含义/u);
  assert.match(messages[1].content, /不能默认法定继承人/u);
});

test('normalizeStructureV3LlmPayload normalizes model JSON and validates premium total', () => {
  const result = normalizeStructureV3LlmPayload({
    policyFields: {
      company: { value: '新华保险', evidence: '页眉', confidence: 0.9 },
      applicant: { value: '张三' },
      insured: { value: '李四' },
      beneficiary: { value: '法定' },
      firstPremium: { value: '￥300.00' },
    },
    plans: [
      { role: '主险', name: '主险A', amount: '100000元', coveragePeriod: '终身', paymentPeriod: '20年', premium: '100元' },
      { role: '附加险', name: '附加险B', amount: '20000元', coveragePeriod: '1年', paymentPeriod: '1年', premium: '200元' },
    ],
  });

  assert.equal(result.policyFields.productName.value, '主险A');
  assert.equal(result.policyFields.firstPremium.value, '300');
  assert.deepEqual(result.plans.map((plan) => plan.role), ['main', 'rider']);
  assert.deepEqual(result.plans.map((plan) => plan.premium), ['100', '200']);
  assert.equal(result.validation.premiumMatches, true);
  assert.equal(result.validation.ready, true);
});

test('validateStructureV3LlmExtraction flags incomplete rows and premium mismatch', () => {
  const validation = validateStructureV3LlmExtraction({
    policyFields: {
      company: { value: '新华保险' },
      productName: { value: '主险A' },
      applicant: { value: '张三' },
      insured: { value: '李四' },
      beneficiary: { value: '法定' },
      firstPremium: { value: '500' },
    },
    plans: [
      { role: 'main', name: '主险A', amount: '100000', coveragePeriod: '终身', paymentPeriod: '20年', premium: '300' },
      { role: 'rider', name: '附加险B', amount: '', coveragePeriod: '1年', paymentPeriod: '1年', premium: '100' },
    ],
  });

  assert.equal(validation.premiumMatches, false);
  assert.deepEqual(validation.incompletePlans, ['附加险B']);
  assert.equal(validation.ready, false);
});

test('normalizeStructureV3LlmPayload drops fields inferred from defaults without evidence', () => {
  const result = normalizeStructureV3LlmPayload({
    policyFields: {
      company: { value: '中国人寿', evidence: '推断自产品名称', confidence: 0.6 },
      beneficiary: { value: '法定继承人', evidence: '受益人列表为空，按规则默认为法定继承人', confidence: 0.8 },
      applicant: { value: '张三', evidence: '投保人姓名：张三', confidence: 1 },
    },
  });

  assert.equal(result.policyFields.company, undefined);
  assert.equal(result.policyFields.beneficiary, undefined);
  assert.equal(result.policyFields.applicant.value, '张三');
});

test('extractStructureV3WithLocalModel calls Ollama chat and parses JSON response', async () => {
  let requested = null;
  const fakeFetch = async (url, options) => {
    requested = { url, body: JSON.parse(options.body) };
    return {
      ok: true,
      async json() {
        return {
          message: {
            content: JSON.stringify({
              policyFields: {
                company: { value: '新华保险' },
                applicant: { value: '张三' },
                insured: { value: '李四' },
                beneficiary: { value: '法定' },
                firstPremium: { value: '300' },
              },
              plans: [
                { role: 'main', name: '主险A', amount: '100000', coveragePeriod: '终身', paymentPeriod: '20年', premium: '300' },
              ],
            }),
          },
        };
      },
    };
  };

  const result = await extractStructureV3WithLocalModel({
    normalized: { ocrText: 'OCR文本', tables: [] },
    candidates: {},
    fetchImpl: fakeFetch,
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:8b',
  });

  assert.equal(result.ok, true);
  assert.equal(requested.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(requested.body.model, 'qwen3:8b');
  assert.equal(requested.body.format, 'json');
  assert.equal(result.result.policyFields.productName.value, '主险A');
  assert.equal(result.result.validation.ready, true);
});

test('buildStructureV3LlmReport summarizes failed model calls', () => {
  const report = buildStructureV3LlmReport({
    ok: false,
    model: 'qwen3:8b',
    error: 'MODEL_TIMEOUT',
  });

  assert.match(report, /状态: 失败/u);
  assert.match(report, /MODEL_TIMEOUT/u);
});
