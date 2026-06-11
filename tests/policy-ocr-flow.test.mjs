import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createPolicyOcrApp } from '../server/app.mjs';
import { createCashflowStore, createCashValueStore } from '../server/cashflow-store.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';
import { createInitialState, latestValidSmsCode } from '../server/policy-ocr.domain.mjs';
import { rebuildOptionalResponsibilityGovernance } from '../server/optional-responsibility-governance.mjs';
import { scanPolicyWithConfiguredRuntime } from '../server/ocr-runtime.mjs';
import {
  extractPaddleOcrText,
  extractPolicyFieldsFromImageWithOllamaVision,
  extractPolicyFieldsFromImageWithRemoteVision,
  extractPolicyFieldsFromText,
  normalizeExtractedPolicyFields,
  scanInsurancePolicyLocal,
} from '../ocr-service/insurance-ocr.service.mjs';
import { buildFamilyReport } from '../src/family-report-engine.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function listenHttpServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function startStructureV3MockServer(payload) {
  const requests = [];
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/structurev3') {
      response.writeHead(404).end();
      return;
    }

    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        body: Buffer.concat(chunks),
        filename: request.headers['x-filename'],
      });
      const body = JSON.stringify(typeof payload === 'function' ? payload(requests) : payload);
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
    });
  });
  const running = await listenHttpServer(server);
  return {
    endpoint: `${running.baseUrl}/structurev3`,
    requests,
    close: running.close,
  };
}

async function jsonFetch(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json();
  return { response, payload };
}

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'policy-ocr-flow-'));
}

function textResponse(body, { contentType = 'text/html; charset=utf-8' } = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return {
    ok: true,
    headers: {
      get(name) {
        const key = String(name || '').toLowerCase();
        if (key === 'content-type') return contentType;
        if (key === 'content-length') return String(buffer.length);
        return '';
      },
    },
    text: async () => buffer.toString('utf8'),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

function notFoundResponse() {
  return {
    ok: false,
    status: 404,
    headers: { get: () => '' },
    text: async () => '',
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

async function waitUntil(assertion, { timeoutMs = 500, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  if (lastError) throw lastError;
}

test('OCR extraction ignores insurer logo text and combines split product table name', () => {
  const data = extractPolicyFieldsFromText(`
心I新华保险
保险单
合同
生效日期:2026年04月01日
投保人:张三
被保险人:张三
保险利益表
险种名称
基本
保险金额/
保险金额
保险期间
交费方式
保险费约定支付日
保险费
/保障计划/份数
/
交费期间（续期
保险费交费日期）
/交费期满日
盛世荣耀臻享版
24441.00元
终身
年交
每年04月01日
每年3000.00元
终身寿险（分红型）
/10年
/2035年04月01日
首期
保险费合计:
￥3000.00
  `);

  assert.equal(data.company, '新华保险');
  assert.equal(data.name, '盛世荣耀臻享版终身寿险（分红型）');
  assert.equal(data.date, '2026-04-01');
  assert.equal(data.coveragePeriod, '终身');
  assert.equal(data.paymentPeriod, '10年交');
  assert.equal(data.amount, '24441');
  assert.equal(data.firstPremium, '3000');
});

test('remote GPU vision extraction keeps universal account plans as linked accounts', async () => {
  const calls = [];
  const sourceBuffer = Buffer.from('fake-image');
  const resizedBuffer = Buffer.from('resized-image');
  const result = await extractPolicyFieldsFromImageWithRemoteVision(
    {
      name: '冯力荣耀.jpg',
      type: 'image/jpeg',
      dataUrl: `data:image/jpeg;base64,${sourceBuffer.toString('base64')}`,
    },
    {
      env: {
        POLICY_OCR_REMOTE_VISION_BASE_URL: 'http://gpu4080.local:8000',
      },
      prepareImageForRemoteVision: async (buffer, mimeType) => {
        assert.equal(buffer.toString('utf8'), sourceBuffer.toString('utf8'));
        assert.equal(mimeType, 'image/jpeg');
        return { buffer: resizedBuffer, mimeType: 'image/jpeg' };
      },
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    company: '新华保险',
                    name: '荣耀鑫享赢家版终身寿险',
                    applicant: '冯力',
                    insured: '冯力',
                    plans: [
                      {
                        role: 'main',
                        name: '荣耀鑫享赢家版终身寿险',
                        productType: '增额终身寿险',
                        amount: '165020.00元',
                        coveragePeriod: '终身',
                        paymentMode: '年交',
                        paymentPeriod: '10年',
                        premium: '每年20000.00元',
                      },
                      {
                        role: 'linked_account',
                        name: '金利瑞享终身寿险（万能型）',
                        productType: '万能账户',
                        coveragePeriod: '终身',
                        paymentMode: '一次交清',
                        paymentPeriod: '一次交清',
                        premium: '10.00元',
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        };
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://gpu4080.local:8000/v1/chat/completions');
  const remoteRequestBody = JSON.parse(String(calls[0].options.body || '{}'));
  assert.equal(remoteRequestBody.model, 'qwen3-vl:8b-instruct');
  assert.equal(remoteRequestBody.temperature, 0);
  assert.equal(remoteRequestBody.max_tokens, 1536);
  assert.match(remoteRequestBody.messages[0].content[0].text, /只输出一个 JSON 对象/u);
  assert.match(remoteRequestBody.messages[0].content[0].text, /请逐行转录 tableRows/u);
  assert.match(remoteRequestBody.messages[0].content[0].text, /不要把 tableRows 责任明细直接合并为 plans/u);
  assert.match(remoteRequestBody.messages[0].content[0].text, /经社保赔付\/未经社保赔付.*不是交费方式/u);
  assert.equal(remoteRequestBody.messages[0].content[1].image_url.url, `data:image/jpeg;base64,${resizedBuffer.toString('base64')}`);
  assert.equal(result.data.plans.length, 2);
  assert.equal(result.data.plans[1].role, 'linked_account');
  assert.equal(result.data.plans[1].productType, '万能账户');
  assert.equal(result.ocrText, '');
});

test('remote GPU vision maps aborted vLLM requests to upstream timeout', async () => {
  const sourceBuffer = Buffer.from('fake-image');
  await assert.rejects(
    () => extractPolicyFieldsFromImageWithRemoteVision(
      {
        name: 'timeout.jpg',
        type: 'image/jpeg',
        dataUrl: `data:image/jpeg;base64,${sourceBuffer.toString('base64')}`,
      },
      {
        env: {
          POLICY_OCR_REMOTE_VISION_BASE_URL: 'http://gpu4080.local:8000',
        },
        prepareImageForRemoteVision: async (buffer, mimeType) => ({ buffer, mimeType }),
        fetchImpl: async () => {
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          throw error;
        },
      },
    ),
    /POLICY_OCR_UPSTREAM_TIMEOUT/u,
  );
});

test('remote GPU vision recovers fields from length-truncated JSON', async () => {
  const sourceBuffer = Buffer.from('fake-image');
  const result = await extractPolicyFieldsFromImageWithRemoteVision(
    {
      name: 'truncated.jpg',
      type: 'image/jpeg',
      dataUrl: `data:image/jpeg;base64,${sourceBuffer.toString('base64')}`,
    },
    {
      env: {
        POLICY_OCR_REMOTE_VISION_BASE_URL: 'http://gpu4080.local:8000',
      },
      prepareImageForRemoteVision: async (buffer, mimeType) => ({ buffer, mimeType }),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              finish_reason: 'length',
              message: {
                content: `{
  "company": "新华保险",
  "name": "盛世荣耀臻享版终身寿险（分红型）",
  "applicant": "温舒萍",
  "insured": "温舒萍",
  "policyNumber": "990204352040",
  "date": "2026年03月31日",
  "paymentPeriod": "10年",
  "coveragePeriod": "终身",
  "amount": "24441.00元",
  "firstPremium": "3000.00",
  "plans": [
    {
      "role": "main",
      "name": "盛世荣耀臻享版终身寿险（分红型）",
      "amount": "24441.00元",
      "coveragePeriod": "终身",
      "paymentMode": "年交",
      "paymentPeriod": "10年",
      "premium": "3000.00",
      "productType": `,
              },
            },
          ],
          usage: { prompt_tokens: 907, completion_tokens: 512 },
        }),
      }),
    },
  );

  assert.equal(result.data.company, '新华保险');
  assert.equal(result.data.name, '盛世荣耀臻享版终身寿险（分红型）');
  assert.equal(result.data.applicant, '温舒萍');
  assert.equal(result.data.policyNumber, '990204352040');
  assert.equal(result.data.firstPremium, '3000');
  assert.equal(result.data.plans.length, 1);
  assert.equal(result.data.plans[0].name, '盛世荣耀臻享版终身寿险（分红型）');
  assert.equal(result.data.plans[0].premium, '3000');
});

test('remote GPU vision recovers completed table rows from length-truncated JSON', async () => {
  const sourceBuffer = Buffer.from('fake-image');
  const result = await extractPolicyFieldsFromImageWithRemoteVision(
    {
      name: 'truncated-table.jpg',
      type: 'image/jpeg',
      dataUrl: `data:image/jpeg;base64,${sourceBuffer.toString('base64')}`,
    },
    {
      env: {
        POLICY_OCR_REMOTE_VISION_BASE_URL: 'http://gpu4080.local:8000',
        POLICY_OCR_REMOTE_VISION_MAX_TOKENS: '512',
      },
      prepareImageForRemoteVision: async (buffer, mimeType) => ({ buffer, mimeType }),
      fetchImpl: async (url, options) => {
        const requestBody = JSON.parse(String(options.body || '{}'));
        assert.equal(requestBody.max_tokens, 1536);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                finish_reason: 'length',
                message: {
                  content: `{
  "company": "新华保险",
  "name": "学生平安意外伤害保险",
  "policyNumber": "66248173100401",
  "insured": "王俊曦",
  "date": "2024年08月09日",
  "coveragePeriod": "2024年08月16日零时起至2025年08月15日二十四时止",
  "amount": "80000.00元",
  "firstPremium": "298.00",
  "plans": [],
  "tableRows": [
    {"planName":"学生平安意外伤害保险","responsibilityName":"意外伤害身故和残疾保险金","amountOrUnits":"80000.00元","benefitStandard":"","deductible":"","ratio":""},
    {"planName":"附加学生平安A1款意外伤害医疗保险","responsibilityName":"意外伤害医疗费用保险金","amountOrUnits":"20000.00元","benefitStandard":"未经社保赔付","deductible":"50元","ratio":"80%"},
    {"planName":"附加学生平安A款住院津贴医疗保险","responsibility`,
                },
              },
            ],
            usage: { prompt_tokens: 1074, completion_tokens: 512 },
          }),
        };
      },
    },
  );

  assert.equal(result.visionDebug.recoveredFromPartialJson, true);
  assert.equal(result.visionDebug.parsedData.tableRows.length, 2);
  assert.deepEqual(result.data.plans.map((plan) => plan.name), [
    '学生平安意外伤害保险',
    '附加学生平安A1款意外伤害医疗保险',
  ]);
  assert.equal(result.data.plans[0].amount, '80000');
  assert.equal(result.data.plans[1].amount, '20000');
  assert.deepEqual(result.data.plans[1].benefitRows.map((row) => ({
    responsibilityName: row.responsibilityName,
    amountText: row.amountText,
    benefitStandard: row.benefitStandard,
    deductible: row.deductible,
    ratio: row.ratio,
  })), [
    {
      responsibilityName: '意外伤害医疗费用保险金',
      amountText: '20000.00元',
      benefitStandard: '未经社保赔付',
      deductible: '50元',
      ratio: '80%',
    },
  ]);
});

test('remote GPU vision does not retry focused passes when whole response is empty', async () => {
  const calls = [];
  const sourceBuffer = Buffer.from('fake-image');
  await assert.rejects(
    () => extractPolicyFieldsFromImageWithRemoteVision(
      {
        name: 'focused.jpg',
        type: 'image/jpeg',
        dataUrl: `data:image/jpeg;base64,${sourceBuffer.toString('base64')}`,
      },
      {
        env: {
          POLICY_OCR_REMOTE_VISION_BASE_URL: 'http://gpu4080.local:8000',
        },
        prepareImageForRemoteVision: async (buffer, mimeType) => ({ buffer, mimeType }),
        fetchImpl: async (url, options) => {
          const body = JSON.parse(String(options.body || '{}'));
          const prompt = String(body.messages?.[0]?.content?.[0]?.text || '');
          calls.push({ url, prompt });
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
            }),
          };
        },
      },
    ),
    /POLICY_OCR_EMPTY/u,
  );

  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].prompt, /页眉和基本内容区|保险利益表和险种明细区|受益人、特别约定/u);
});

test('normalizer rejects amount-like identity numbers and repairs truncated main plan amount', () => {
  const data = normalizeExtractedPolicyFields({
    company: '中国人寿保险',
    name: '国寿鑫颐宝两全保险（2024版）',
    applicant: '翟卿',
    insured: '翟卿',
    insuredIdNumber: '159948001200000',
    amount: '159948.00',
    firstPremium: '12000.00',
    plans: [
      {
        role: 'main',
        name: '国寿鑫颐宝两全保险（2024版）',
        amount: '12',
        premium: '12000.00',
        coveragePeriod: '至60周岁',
        paymentMode: '年交',
        paymentPeriod: '10年交',
      },
    ],
  });

  assert.equal(data.insuredIdNumber, '');
  assert.equal(data.insuredBirthday, '');
  assert.equal(data.amount, '159948');
  assert.equal(data.plans[0].amount, '159948');
  assert.equal(data.firstPremium, '12000');
});

test('normalizer drops sparse duplicate rider and hydrates single main plan premium', () => {
  const data = normalizeExtractedPolicyFields({
    company: '中国人寿保险',
    name: '国寿鑫颐宝两全保险（2024版）（个人养老金）',
    amount: '159948.00',
    coveragePeriod: '至60周岁',
    paymentPeriod: '10年交',
    firstPremium: '12000.00',
    plans: [
      {
        role: 'main',
        name: '国寿鑫颐宝两全保险（2024版）',
        amount: '159948.00',
        coveragePeriod: '至60周岁',
        paymentPeriod: '10年交',
      },
      {
        role: 'rider',
        name: '国寿鑫颐宝两全保险（2024版）',
        paymentPeriod: '10年交',
      },
    ],
  });

  assert.equal(data.plans.length, 1);
  assert.equal(data.plans[0].role, 'main');
  assert.equal(data.plans[0].premium, '12000');
});

test('normalizer merges repeated plan rows that are responsibility details', () => {
  const data = normalizeExtractedPolicyFields({
    company: '新华保险',
    name: '学生平安意外伤害保险',
    amount: '80000.00元',
    firstPremium: '298.00元',
    plans: [
      {
        role: 'main',
        name: '学生平安意外伤害保险',
        amount: '80000.00元',
        premium: '100元',
        productType: '意外险',
      },
      {
        role: 'rider',
        name: '附加学生平安意外伤害住院医疗险',
        amount: '60000.00元',
        paymentMode: '经社保赔付',
        premium: '100元',
        productType: '医疗险',
        evidence: '险种名称 附加学生平安意外伤害住院医疗险 保险金额 60000 保险费 100',
      },
      {
        role: 'rider',
        name: '附加学生平安意外伤害住院医疗险',
        amount: '20000.00元',
        paymentMode: '未经社保赔付',
        premium: '0元',
        productType: '医疗险',
      },
      {
        role: 'rider',
        name: '附加学生平安意外伤害住院医疗险',
        amount: '9000.00元',
        paymentMode: '未经社保赔付',
        premium: '50元',
        productType: '医疗险',
      },
    ],
  });

  const repeatedPlans = data.plans.filter((plan) => plan.name === '附加学生平安意外伤害住院医疗险');
  assert.equal(repeatedPlans.length, 1);
  assert.equal(repeatedPlans[0].role, 'rider');
  assert.equal(repeatedPlans[0].amount, '60000');
  assert.equal(repeatedPlans[0].premium, '100');
  assert.equal(repeatedPlans[0].paymentMode, '');
  assert.deepEqual(
    repeatedPlans[0].benefitRows.map((row) => ({
      amount: row.amount,
      premium: row.premium,
      paymentBasis: row.paymentBasis,
    })),
    [
      { amount: '60000', premium: '100', paymentBasis: '经社保赔付' },
      { amount: '20000', premium: '0', paymentBasis: '未经社保赔付' },
      { amount: '9000', premium: '50', paymentBasis: '未经社保赔付' },
    ],
  );
  assert.equal(data.plans.length, 2);
  assert.equal(data.firstPremium, '298');
});

test('normalizer prefers vision table rows over malformed direct plans', () => {
  const data = normalizeExtractedPolicyFields({
    company: '新华保险',
    name: '学生平安意外伤害保险',
    amount: '80000.00元',
    firstPremium: '298.00元',
    plans: [
      {
        role: 'rider',
        name: '附加学生平安意外伤害医疗保险',
        amount: '9000.00元',
        premium: '9000.00元',
      },
    ],
    tableRows: [
      {
        planName: '学生平安意外伤害保险',
        responsibilityName: '意外伤害身故和残疾保险金',
        amountOrUnits: '80000.00元',
      },
      {
        planName: '附加学生平安A1款意外伤害医疗保险',
        responsibilityName: '意外伤害医疗费用保险金',
        amountOrUnits: '20000.00元',
        benefitStandard: '未经社保赔付',
        deductible: '50元',
        ratio: '80%',
      },
      {
        planName: '',
        responsibilityName: '特定牙齿缺损定额给付保险金',
        amountOrUnits: '9000.00元',
      },
      {
        planName: '附加学生平安A款住院津贴医疗保险',
        responsibilityName: '住院津贴保险金',
        amountOrUnits: '6份',
      },
    ],
  });

  assert.deepEqual(data.plans.map((plan) => plan.name), [
    '学生平安意外伤害保险',
    '附加学生平安A1款意外伤害医疗保险',
    '附加学生平安A款住院津贴医疗保险',
  ]);
  const medicalPlan = data.plans[1];
  assert.equal(medicalPlan.amount, '20000');
  assert.equal(medicalPlan.premium, '');
  assert.deepEqual(
    medicalPlan.benefitRows.map((row) => ({
      responsibilityName: row.responsibilityName,
      amountText: row.amountText,
      benefitStandard: row.benefitStandard,
      deductible: row.deductible,
      ratio: row.ratio,
    })),
    [
      {
        responsibilityName: '意外伤害医疗费用保险金',
        amountText: '20000.00元',
        benefitStandard: '未经社保赔付',
        deductible: '50元',
        ratio: '80%',
      },
      {
        responsibilityName: '特定牙齿缺损定额给付保险金',
        amountText: '9000.00元',
        benefitStandard: undefined,
        deductible: undefined,
        ratio: undefined,
      },
    ],
  );
  assert.equal(data.plans[2].amount, '');
  assert.equal(data.plans[2].benefitRows[0].amountText, '6份');
  assert.equal(data.firstPremium, '298');
});

test('normalizer clears applicant identity when it conflicts with insured birthday and parses dotted amounts', () => {
  const data = normalizeExtractedPolicyFields({
    company: '中國平安保險股份有限公司',
    name: '平安康泰(738)',
    applicant: '吴连英',
    insured: '翟卿',
    insuredIdNumber: '330106610131152',
    insuredBirthday: '1984年11月10日',
    amount: '20.000元',
    firstPremium: 'RMB3053.00',
    plans: [
      {
        role: 'main',
        name: '平安康泰(738)',
        amount: '20.000元',
        premium: '862.00元',
      },
      {
        role: 'rider',
        name: '附加万寿(739)',
        amount: '50.000元',
        premium: '2.165.00元',
      },
    ],
  });

  assert.equal(data.company, '中国平安保险');
  assert.equal(data.insuredIdNumber, '');
  assert.equal(data.insuredBirthday, '1984-11-10');
  assert.equal(data.amount, '20000');
  assert.equal(data.firstPremium, '3053');
  assert.equal(data.plans[0].amount, '20000');
  assert.equal(data.plans[1].amount, '50000');
  assert.equal(data.plans[1].premium, '2165');
});

test('normalizer does not keep product names as company and repairs generic main plan from top fields', () => {
  const data = normalizeExtractedPolicyFields({
    company: '保险利益表中对应行数据',
    name: '畅行万里智赢版两全保险',
    beneficiary: '被保险人的法定继承人',
    amount: '60000.00元',
    coveragePeriod: '至2068年9月30日零时',
    paymentPeriod: '10年交',
    firstPremium: '3296.00元',
    plans: [
      {
        role: 'main',
        name: '两全保险',
        amount: '3296.00元',
        coveragePeriod: '至2025年09月29日',
        premium: '3296.00元',
      },
      {
        role: 'main',
        name: 'i他男性特定疾病保险',
        amount: '50000.00元',
        coveragePeriod: '至2025年09月29日',
        paymentMode: '趸交',
        paymentPeriod: '趸交',
        premium: '140.00元',
      },
    ],
  });

  assert.equal(data.company, '');
  assert.equal(data.beneficiary, '法定');
  assert.equal(data.name, '畅行万里智赢版两全保险');
  assert.equal(data.amount, '60000');
  assert.equal(data.paymentPeriod, '10年交');
  assert.equal(data.coveragePeriod, '至2068年9月30日零时');
  assert.equal(data.plans[0].name, '畅行万里智赢版两全保险');
  assert.equal(data.plans[0].amount, '60000');
  assert.equal(data.plans[0].coveragePeriod, '至2068年9月30日零时');
  assert.equal(data.plans[0].paymentMode, '年交');
  assert.equal(data.plans[0].paymentPeriod, '10年交');
  assert.equal(data.plans[1].role, 'rider');
});

test('normalizer reads payment mode and years as one payment period', () => {
  const data = normalizeExtractedPolicyFields({
    company: '新华保险',
    name: '多倍保障重大疾病保险（智赢版）',
    amount: '170000.00元',
    coveragePeriod: '终身',
    paymentPeriod: '年交/20年',
    firstPremium: '7667.00元',
    plans: [
      {
        role: 'main',
        name: '多倍保障重大疾病保险（智赢版）',
        sourceColumn: '险种名称',
        amount: '170000.00元',
        coveragePeriod: '终身',
        paymentMode: '年交',
        paymentPeriod: '年交/20年',
        premium: '7667.00元',
      },
    ],
  });

  assert.equal(data.paymentPeriod, '20年交');
  assert.equal(data.plans[0].paymentPeriod, '20年交');
});

test('normalizer excludes plan candidates sourced from responsibility columns', () => {
  const data = normalizeExtractedPolicyFields({
    company: '新华保险',
    name: '学生平安意外伤害保险',
    amount: '80000.00元',
    firstPremium: '298.00元',
    plans: [
      {
        role: 'main',
        name: '学生平安意外伤害保险',
        sourceColumn: '险种名称',
        amount: '80000.00元',
      },
      {
        role: 'rider',
        name: '特定牙齿缺损额给付保险金',
        sourceColumn: '保险责任名称',
        amount: '9000.00元',
      },
      {
        role: 'rider',
        name: '疾病住院医疗费用保险金',
        sourceColumn: '保险责任名称',
        amount: '800000.00元',
      },
      {
        role: 'rider',
        name: '身故或全残保险金',
        sourceColumn: '保险责任名称',
        amount: '80000.00元',
      },
    ],
  });

  assert.deepEqual(
    data.plans.map((plan) => plan.name),
    ['学生平安意外伤害保险'],
  );
});

test('normalizer strips pasted responsibility tail back to plan name', () => {
  const data = normalizeExtractedPolicyFields({
    company: '新华保险',
    name: '学生平安意外伤害保险',
    amount: '80000.00元',
    firstPremium: '298.00元',
    plans: [
      {
        role: 'rider',
        name: '附加学生平安A1款意外伤害医疗保意外伤害医疗费用保险金',
        sourceColumn: '险种名称',
        amount: '20000.00元',
      },
      {
        role: 'rider',
        name: '附加学生平安A款疾病住院医疗保险',
        sourceColumn: '险种名称',
        amount: '800000.00元',
      },
    ],
  });

  assert.deepEqual(
    data.plans.map((plan) => plan.name),
    ['附加学生平安A1款意外伤害医疗保险', '附加学生平安A款疾病住院医疗保险'],
  );
});

test('normalizer uses main plan when top-level name concatenates riders', () => {
  const data = normalizeExtractedPolicyFields({
    company: '新华保险',
    name: '学生平安意外伤害保险附加学生平安A款定期寿险附加学生平安A款疾病住院医疗保险',
    amount: '80000.00元',
    firstPremium: '298.00元',
    plans: [
      {
        role: 'main',
        name: '学生平安意外伤害保险',
        amount: '80000.00元',
      },
      {
        role: 'rider',
        name: '附加学生平安A款定期寿险',
        amount: '80000.00元',
      },
    ],
  });

  assert.equal(data.name, '学生平安意外伤害保险');
});

test('text extractor maps legal heir beneficiary text to statutory beneficiary', () => {
  const data = extractPolicyFieldsFromText([
    '保险单',
    '基本内容',
    '身故保险金受益人',
    '被保险人的法定继承人',
    '保险利益表',
  ].join('\n'));

  assert.equal(data.beneficiary, '法定');
});

test('Ollama vision scan reports empty OCR instead of throwing on null extracted data', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  const previousBaseUrl = process.env.POLICY_OCR_OLLAMA_BASE_URL;
  const previousModel = process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
  const previousFetch = globalThis.fetch;
  process.env.POLICY_OCR_PROVIDER = 'ollama_vision_local';
  process.env.POLICY_OCR_OLLAMA_BASE_URL = 'http://ollama.test';
  process.env.POLICY_OCR_OLLAMA_VISION_MODEL = 'qwen3-vl:8b-instruct';
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      message: {
        content: '{"company":"","name":"","applicant":"","beneficiary":"","insured":"","insuredIdNumber":"","insuredBirthday":"","date":"","paymentPeriod":"","coveragePeriod":"","amount":"","firstPremium":"","plans":[]}',
      },
    }),
  });

  try {
    await assert.rejects(
      () => scanInsurancePolicyLocal({
        uploadItem: {
          name: 'empty.png',
          type: 'image/png',
          size: 12,
          dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
        },
        ocrText: '',
        paddleLayoutScanner: async () => {
          throw new Error('POLICY_OCR_EMPTY');
        },
      }),
      /POLICY_OCR_EMPTY/u,
    );
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
    if (previousBaseUrl === undefined) delete process.env.POLICY_OCR_OLLAMA_BASE_URL;
    else process.env.POLICY_OCR_OLLAMA_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
    else process.env.POLICY_OCR_OLLAMA_VISION_MODEL = previousModel;
    globalThis.fetch = previousFetch;
  }
});

test('Ollama vision scan reads policy JSON from thinking when content is empty', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  const previousBaseUrl = process.env.POLICY_OCR_OLLAMA_BASE_URL;
  const previousModel = process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
  const previousFetch = globalThis.fetch;
  process.env.POLICY_OCR_PROVIDER = 'ollama_vision_local';
  process.env.POLICY_OCR_OLLAMA_BASE_URL = 'http://ollama.test';
  process.env.POLICY_OCR_OLLAMA_VISION_MODEL = 'qwen3-vl:8b-instruct';
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      message: {
        content: '',
        thinking: [
          '我先看图片。用户给的结构是 {"company":"","name":"","applicant":""}。',
          '最终只输出：',
          '{"company":"新华保险","name":"盛世荣耀臻享版终身寿险","applicant":"温舒萍","beneficiary":"法定","insured":"温舒萍","insuredIdNumber":"","insuredBirthday":"","date":"2026-04-01","paymentPeriod":"10年交","coveragePeriod":"终身","amount":"24441","firstPremium":"3000","plans":[]}',
        ].join('\n'),
      },
    }),
  });

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: {
        name: 'thinking.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      ocrText: '',
      paddleLayoutScanner: async () => ({
        ocrText: 'Paddle OCR 原文 新华保险 盛世荣耀臻享版终身寿险',
        data: {},
      }),
    });
    assert.equal(scan.data.company, '新华保险');
    assert.equal(scan.data.name, '盛世荣耀臻享版终身寿险');
    assert.equal(scan.data.applicant, '温舒萍');
    assert.equal(scan.data.firstPremium, '3000');
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
    if (previousBaseUrl === undefined) delete process.env.POLICY_OCR_OLLAMA_BASE_URL;
    else process.env.POLICY_OCR_OLLAMA_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
    else process.env.POLICY_OCR_OLLAMA_VISION_MODEL = previousModel;
    globalThis.fetch = previousFetch;
  }
});

test('Ollama vision scan recovers field hints when thinking has no final JSON', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  const previousBaseUrl = process.env.POLICY_OCR_OLLAMA_BASE_URL;
  const previousModel = process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
  const previousFetch = globalThis.fetch;
  process.env.POLICY_OCR_PROVIDER = 'ollama_vision_local';
  process.env.POLICY_OCR_OLLAMA_BASE_URL = 'http://ollama.test';
  process.env.POLICY_OCR_OLLAMA_VISION_MODEL = 'qwen3-vl:8b';
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      message: {
        content: '',
        thinking: [
          '<think>',
          'company：页眉有“NCI 新华保险”，所以company填"新华保险"。',
          'applicant：基本内容区有“投保人：温舒萍”，所以applicant填"温舒萍"。',
          'beneficiary：写了“被保险人的法定继承人”，所以beneficiary输出"法定"。',
          'insured：基本内容区有“被保险人：温舒萍”，所以insured填"温舒萍"。',
          'insuredIdNumber：证件号码是360502198812160922，所以insuredIdNumber填"360502198812160922"。',
        ].join('\n'),
      },
    }),
  });

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: {
        name: 'thinking-hints.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      ocrText: '',
      paddleLayoutScanner: async () => ({
        ocrText: '保险利益表 盛世荣耀臻享版终身寿险 24441 10年交 终身 首期保险费合计 ￥3000',
        data: {
          name: '盛世荣耀臻享版终身寿险',
          date: '2026-04-01',
          paymentPeriod: '10年交',
          coveragePeriod: '终身',
          amount: '24441',
          firstPremium: '3000',
        },
      }),
    });

    assert.equal(scan.data.company, '新华保险');
    assert.equal(scan.data.applicant, '温舒萍');
    assert.equal(scan.data.beneficiary, '法定');
    assert.equal(scan.data.insured, '温舒萍');
    assert.equal(scan.data.insuredBirthday, '1988-12-16');
    assert.ok(scan.ocrWarnings.some((warning) => warning.includes('Ollama 视觉仅补充 OCR 缺失字段')));
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
    if (previousBaseUrl === undefined) delete process.env.POLICY_OCR_OLLAMA_BASE_URL;
    else process.env.POLICY_OCR_OLLAMA_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
    else process.env.POLICY_OCR_OLLAMA_VISION_MODEL = previousModel;
    globalThis.fetch = previousFetch;
  }
});

test('Ollama vision scan recovers unquoted field hints from thinking when content is empty', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  const previousBaseUrl = process.env.POLICY_OCR_OLLAMA_BASE_URL;
  const previousModel = process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
  const previousFetch = globalThis.fetch;
  process.env.POLICY_OCR_PROVIDER = 'ollama_vision_local';
  process.env.POLICY_OCR_OLLAMA_BASE_URL = 'http://ollama.test';
  process.env.POLICY_OCR_OLLAMA_VISION_MODEL = 'qwen3-vl:8b';
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      message: {
        content: '',
        thinking: [
          '<think>',
          'company是新华保险。',
          'name是荣耀鑫享赢家版终身寿险。',
          'applicant是冯力。',
          'beneficiary是法定。',
          'insured是冯力。',
          'insuredIdNumber是330106198712072413。',
          'date是2024-06-06。',
          'paymentPeriod应该是10年交。',
          'coveragePeriod是终身。',
          'amount是165020。',
          'firstPremium是20010。',
        ].join('\n'),
      },
    }),
  });

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: {
        name: 'thinking-unquoted.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      ocrText: '',
      paddleLayoutScanner: async () => ({
        ocrText: 'Paddle OCR 原文 新华保险 荣耀鑫享赢家版终身寿险',
        data: {},
      }),
    });

    assert.equal(scan.data.company, '新华保险');
    assert.equal(scan.data.name, '荣耀鑫享赢家版终身寿险');
    assert.equal(scan.data.applicant, '冯力');
    assert.equal(scan.data.insured, '冯力');
    assert.equal(scan.data.insuredIdNumber, '330106198712072413');
    assert.equal(scan.data.insuredBirthday, '1987-12-07');
    assert.equal(scan.data.firstPremium, '20010');
    assert.ok(!(scan.ocrWarnings || []).some((warning) => warning.includes('Ollama 视觉未返回可解析结果')));
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
    if (previousBaseUrl === undefined) delete process.env.POLICY_OCR_OLLAMA_BASE_URL;
    else process.env.POLICY_OCR_OLLAMA_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
    else process.env.POLICY_OCR_OLLAMA_VISION_MODEL = previousModel;
    globalThis.fetch = previousFetch;
  }
});

test('Ollama vision scan parses OCR-like thinking text with the OCR field rules', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  const previousBaseUrl = process.env.POLICY_OCR_OLLAMA_BASE_URL;
  const previousModel = process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
  const previousFetch = globalThis.fetch;
  process.env.POLICY_OCR_PROVIDER = 'ollama_vision_local';
  process.env.POLICY_OCR_OLLAMA_BASE_URL = 'http://ollama.test';
  process.env.POLICY_OCR_OLLAMA_VISION_MODEL = 'qwen3-vl:8b';
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      message: {
        content: '',
        thinking: [
          '<think>',
          '我看到基本内容区有“NCI 新华保险”。',
          '字段原文包括“投保人：张三”、“被保险人：李四”、“证件号码：110101199001012345”。',
          '基本内容区还写着“身故保险金受益人：被保险人的法定继承人”。',
          '页面里能看到“合同生效日期：2026年04月01日”和“首期保险费合计：￥3000”。',
        ].join('\n'),
      },
    }),
  });

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: {
        name: 'thinking-ocr-like.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      ocrText: '',
      paddleLayoutScanner: async () => ({
        ocrText: '保险利益表 盛世荣耀臻享版终身寿险 24441 10年交 终身',
        data: {
          name: '盛世荣耀臻享版终身寿险',
          paymentPeriod: '10年交',
          coveragePeriod: '终身',
          amount: '24441',
        },
      }),
    });

    assert.equal(scan.data.company, '新华保险');
    assert.equal(scan.data.applicant, '张三');
    assert.equal(scan.data.insured, '李四');
    assert.equal(scan.data.beneficiary, '法定');
    assert.equal(scan.data.insuredBirthday, '1990-01-01');
    assert.equal(scan.data.date, '2026-04-01');
    assert.equal(scan.data.firstPremium, '3000');
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
    if (previousBaseUrl === undefined) delete process.env.POLICY_OCR_OLLAMA_BASE_URL;
    else process.env.POLICY_OCR_OLLAMA_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
    else process.env.POLICY_OCR_OLLAMA_VISION_MODEL = previousModel;
    globalThis.fetch = previousFetch;
  }
});

test('Ollama vision scan backfills missing fields from returned OCR text', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  const previousBaseUrl = process.env.POLICY_OCR_OLLAMA_BASE_URL;
  const previousModel = process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
  const previousFetch = globalThis.fetch;
  process.env.POLICY_OCR_PROVIDER = 'ollama_vision_local';
  process.env.POLICY_OCR_OLLAMA_BASE_URL = 'http://ollama.test';
  process.env.POLICY_OCR_OLLAMA_VISION_MODEL = 'qwen3-vl:8b';
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      message: {
        content: JSON.stringify({
          company: '新华保险',
          name: '盛世荣耀臻享版终身寿险（分红型）',
          applicant: '',
          beneficiary: '',
          insured: '',
          insuredIdNumber: '',
          insuredBirthday: '',
          date: '',
          paymentPeriod: '10年交',
          coveragePeriod: '终身',
          amount: '24441',
          firstPremium: '',
          plans: [],
          ocrText: [
            'NCI 新华保险',
            '保险单',
            '基本内容',
            '合同成立日期:2026年03月31日',
            '投保人:温舒萍',
            '被保险人:温舒萍',
            '合同生效日期:2026年04月01日',
            '证件号码:360502198812160922',
            '证件号码:360502198812160922',
            '身故保险金受益人',
            '被保险人的法定继承人',
            '保险利益表',
            '险种名称',
            '盛世荣耀臻享版',
            '终身寿险（分红型）',
            '24441.00元',
            '终身',
            '年交',
            '/10年',
            '每年3000.00元',
            '首期保险费合计:',
            '￥3000.00',
          ].join('\n'),
        }),
      },
    }),
  });

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: {
        name: 'ollama-ocr-text.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      ocrText: '',
    });
    assert.equal(scan.data.applicant, '温舒萍');
    assert.equal(scan.data.insured, '温舒萍');
    assert.equal(scan.data.beneficiary, '法定');
    assert.equal(scan.data.insuredBirthday, '1988-12-16');
    assert.equal(scan.data.date, '2026-04-01');
    assert.equal(scan.data.amount, '24441');
    assert.equal(scan.data.firstPremium, '3000');
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
    if (previousBaseUrl === undefined) delete process.env.POLICY_OCR_OLLAMA_BASE_URL;
    else process.env.POLICY_OCR_OLLAMA_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
    else process.env.POLICY_OCR_OLLAMA_VISION_MODEL = previousModel;
    globalThis.fetch = previousFetch;
  }
});

test('Ollama vision request uses structured JSON output constraints', async () => {
  const previousBaseUrl = process.env.POLICY_OCR_OLLAMA_BASE_URL;
  const previousModel = process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
  const previousNumPredict = process.env.POLICY_OCR_OLLAMA_VISION_NUM_PREDICT;
  process.env.POLICY_OCR_OLLAMA_BASE_URL = 'http://ollama.test';
  process.env.POLICY_OCR_OLLAMA_VISION_MODEL = 'qwen3-vl:8b-instruct';
  process.env.POLICY_OCR_OLLAMA_VISION_NUM_PREDICT = '2048';
  let requestBody = null;

  try {
    const result = await extractPolicyFieldsFromImageWithOllamaVision(
      {
        name: 'schema-policy.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      async (_url, init) => {
        requestBody = JSON.parse(String(init.body || '{}'));
        return {
          ok: true,
          json: async () => ({
            message: {
              content: JSON.stringify({
                company: '新华保险',
                name: '盛世荣耀臻享版终身寿险',
                applicant: '温舒萍',
                beneficiary: '法定',
                insured: '温舒萍',
                insuredIdNumber: '',
                insuredBirthday: '1988-12-16',
                date: '2026-04-01',
                paymentPeriod: '年交/20年',
                coveragePeriod: '终身',
                amount: '24441',
                firstPremium: '3000',
                plans: [
                  {
                    role: 'main',
                    name: '盛世荣耀臻享版终身寿险',
                    amount: '24441',
                    coveragePeriod: '终身',
                    paymentMode: '年交',
                    paymentPeriod: '年交/20年',
                    premium: '3000',
                    productType: '增额终身寿险',
                    sourceColumn: '险种名称',
                    evidence: '险种名称 盛世荣耀臻享版终身寿险 24441.00元 终身 年交/20年 3000.00元',
                  },
                ],
                fieldEvidence: {
                  company: 'NCI 新华保险',
                  name: '盛世荣耀臻享版终身寿险',
                },
              }),
            },
            done_reason: 'stop',
            eval_count: 128,
          }),
        };
      },
      {
        companyHints: ['新华保险'],
        productCandidates: [
          {
            company: '新华保险',
            productName: '新华人寿保险股份有限公司盛世荣耀臻享版终身寿险（分红型）',
            productType: '增额终身寿险',
          },
        ],
      },
    );

    assert.equal(result.company, '新华保险');
    assert.equal(result.paymentPeriod, '20年交');
    assert.equal(result.plans[0].paymentPeriod, '20年交');
    assert.equal(requestBody.model, 'qwen3-vl:8b-instruct');
    assert.equal(requestBody.think, false);
    assert.equal(requestBody.stream, false);
    assert.equal(requestBody.format.type, 'object');
    assert.equal(requestBody.format.properties.policyNumber.type, 'string');
    assert.equal(requestBody.format.properties.plans.type, 'array');
    assert.equal(requestBody.format.properties.fieldEvidence.type, 'object');
    assert.equal(Object.hasOwn(requestBody.format.properties, 'ocrText'), false);
    assert.equal(requestBody.options.num_predict, 2048);
    assert.match(requestBody.messages[1].content, /保险字段词典/u);
    assert.match(requestBody.messages[1].content, /保障期间:终身.*不是产品名/u);
    assert.match(requestBody.messages[1].content, /字段为空、空白、横线、未填写、未标注或不确定时输出空字符串/u);
    assert.match(requestBody.messages[1].content, /证件号码\/身份证号\/客户号\/保单号\/电话不能作为 amount 或 premium/u);
    assert.match(requestBody.messages[1].content, /营销服务部、销售人员、网址、客服电话(?:、险种名称)?都不能作为 company/u);
    assert.match(requestBody.messages[1].content, /保险金额、保费、保单号、日期、客户号都不能作为证件号/u);
    assert.match(requestBody.messages[1].content, /保险金额是 159948\.00，标准保费是 12000\.00/u);
    assert.match(requestBody.messages[1].content, /像人脑理解表格一样把同一视觉行的单元格对齐/u);
    assert.match(requestBody.messages[1].content, /交费方式=年交、交费期间=20年.*20年交/u);
    assert.match(requestBody.messages[1].content, /不要输出 ocrText 或整页 OCR 原文/u);
    assert.match(requestBody.messages[1].content, /fieldEvidence 只输出字段附近短证据/u);
    assert.match(requestBody.messages[1].content, /本地产品候选/u);
    assert.match(requestBody.messages[1].content, /盛世荣耀臻享版终身寿险/u);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.POLICY_OCR_OLLAMA_BASE_URL;
    else process.env.POLICY_OCR_OLLAMA_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
    else process.env.POLICY_OCR_OLLAMA_VISION_MODEL = previousModel;
    if (previousNumPredict === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_NUM_PREDICT;
    else process.env.POLICY_OCR_OLLAMA_VISION_NUM_PREDICT = previousNumPredict;
  }
});

test('Ollama vision retries focused complex passes when the whole image is not parseable', async () => {
  const previousBaseUrl = process.env.POLICY_OCR_OLLAMA_BASE_URL;
  const previousModel = process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
  process.env.POLICY_OCR_OLLAMA_BASE_URL = 'http://ollama.test';
  process.env.POLICY_OCR_OLLAMA_VISION_MODEL = 'qwen3-vl:8b';
  const requestBodies = [];

  const responses = [
    { content: '图片内容较复杂，需要分区读取。' },
    {
      content: JSON.stringify({
        company: '新华保险',
        name: '',
        applicant: '冯力',
        beneficiary: '法定',
        insured: '冯力',
        insuredIdNumber: '330106198712072413',
        insuredBirthday: '1987-12-07',
        date: '2024-06-07',
        paymentPeriod: '',
        coveragePeriod: '',
        amount: '',
        firstPremium: '',
        plans: [],
        fieldEvidence: {
          company: 'NCI 新华保险',
          applicant: '投保人:冯力',
          insured: '被保险人:冯力',
          insuredIdNumber: '证件号码:330106198712072413',
        },
      }),
    },
    {
      content: JSON.stringify({
        company: '',
        name: '荣耀鑫享赢家版终身寿险',
        applicant: '',
        beneficiary: '',
        insured: '',
        insuredIdNumber: '',
        insuredBirthday: '',
        date: '',
        paymentPeriod: '10年交',
        coveragePeriod: '终身',
        amount: '165020',
        firstPremium: '',
        plans: [
          {
            role: 'main',
            name: '荣耀鑫享赢家版终身寿险',
            amount: '165020',
            coveragePeriod: '终身',
            paymentMode: '年交',
            paymentPeriod: '10年交',
            premium: '20000',
            productType: '增额终身寿险',
            evidence: '保险利益表 荣耀鑫享赢家版终身寿险 165020.00元 年交/10年',
          },
          {
            role: 'linked_account',
            name: '金利瑞享终身寿险（万能型）',
            amount: '',
            coveragePeriod: '终身',
            paymentMode: '趸交',
            paymentPeriod: '趸交',
            premium: '10',
            productType: '万能账户',
            evidence: '金利瑞享终身寿险（万能型） 10.00元 趸交',
          },
        ],
        fieldEvidence: {
          name: '保险利益表 荣耀鑫享赢家版终身寿险',
          amount: '165020.00元',
        },
      }),
    },
    {
      content: JSON.stringify({
        company: '',
        name: '',
        applicant: '',
        beneficiary: '',
        insured: '',
        insuredIdNumber: '',
        insuredBirthday: '',
        date: '',
        paymentPeriod: '',
        coveragePeriod: '',
        amount: '',
        firstPremium: '20010',
        plans: [],
        fieldEvidence: {
          firstPremium: '首期保险费合计:￥20010.00',
        },
      }),
    },
  ];

  try {
    const result = await extractPolicyFieldsFromImageWithOllamaVision(
      {
        name: 'complex-policy.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      async (_url, init) => {
        requestBodies.push(JSON.parse(String(init.body || '{}')));
        const response = responses[Math.min(requestBodies.length - 1, responses.length - 1)];
        return {
          ok: true,
          json: async () => ({
            message: { content: response.content },
            done_reason: 'stop',
          }),
        };
      },
    );

    assert.equal(requestBodies.length, 4);
    assert.match(requestBodies[1].messages[1].content, /分区视觉识别/u);
    assert.match(requestBodies[1].messages[1].content, /只输出下面这个小 JSON/u);
    assert.deepEqual(Object.keys(requestBodies[1].format.properties), [
      'company',
      'policyNumber',
      'applicant',
      'beneficiary',
      'insured',
      'insuredIdNumber',
      'insuredBirthday',
      'date',
      'fieldEvidence',
    ]);
    assert.match(requestBodies[2].messages[1].content, /保险利益表和险种明细区/u);
    assert.deepEqual(Object.keys(requestBodies[2].format.properties), [
      'name',
      'paymentPeriod',
      'coveragePeriod',
      'amount',
      'firstPremium',
      'plans',
      'fieldEvidence',
    ]);
    assert.equal(requestBodies[2].format.properties.plans.type, 'array');
    assert.equal(result.company, '新华保险');
    assert.equal(result.name, '荣耀鑫享赢家版终身寿险');
    assert.equal(result.applicant, '冯力');
    assert.equal(result.insured, '冯力');
    assert.equal(result.insuredBirthday, '1987-12-07');
    assert.equal(result.amount, '165020');
    assert.equal(result.firstPremium, '20010');
    assert.equal(result.plans.length, 2);
    assert.equal(result.plans[1].role, 'linked_account');
  } finally {
    if (previousBaseUrl === undefined) delete process.env.POLICY_OCR_OLLAMA_BASE_URL;
    else process.env.POLICY_OCR_OLLAMA_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
    else process.env.POLICY_OCR_OLLAMA_VISION_MODEL = previousModel;
  }
});

test('Ollama vision supplements partial whole image fields with focused complex passes', async () => {
  const previousBaseUrl = process.env.POLICY_OCR_OLLAMA_BASE_URL;
  const previousModel = process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
  process.env.POLICY_OCR_OLLAMA_BASE_URL = 'http://ollama.test';
  process.env.POLICY_OCR_OLLAMA_VISION_MODEL = 'qwen3-vl:8b';
  const requestBodies = [];

  const responses = [
    {
      content: JSON.stringify({
        company: '',
        name: '附加学生平安A款意外伤害医疗保险',
        applicant: '',
        beneficiary: '',
        insured: '',
        insuredIdNumber: '',
        insuredBirthday: '',
        date: '',
        paymentPeriod: '趸交',
        coveragePeriod: '至2025年08月15日',
        amount: '20000',
        firstPremium: '',
        plans: [],
        ocrText: '学平险.jpg',
      }),
    },
    {
      content: JSON.stringify({
        company: '新华保险',
        policyNumber: '86000001',
        applicant: '张三',
        beneficiary: '法定',
        insured: '李四',
        insuredIdNumber: '330106201001012345',
        insuredBirthday: '',
        date: '2024-08-15',
        fieldEvidence: {
          applicant: '投保人:张三',
          insured: '被保险人:李四',
        },
      }),
    },
    {
      content: JSON.stringify({
        name: '学生平安意外伤害保险',
        paymentPeriod: '趸交',
        coveragePeriod: '至2025年08月15日',
        amount: '80000',
        firstPremium: '',
        plans: [
          {
            role: 'main',
            name: '学生平安意外伤害保险',
            amount: '80000',
            coveragePeriod: '至2025年08月15日',
            paymentMode: '趸交',
            paymentPeriod: '趸交',
            premium: '298',
            productType: '意外险',
          },
          {
            role: 'rider',
            name: '附加学生平安A款意外伤害医疗保险',
            amount: '20000',
            coveragePeriod: '至2025年08月15日',
            paymentMode: '趸交',
            paymentPeriod: '趸交',
            premium: '',
            productType: '医疗险',
          },
        ],
      }),
    },
    {
      content: JSON.stringify({
        beneficiary: '',
        firstPremium: '298',
        plans: [],
        fieldEvidence: {
          firstPremium: '保险费合计:298元',
        },
      }),
    },
  ];

  try {
    const result = await extractPolicyFieldsFromImageWithOllamaVision(
      {
        name: '学平险.jpg',
        type: 'image/jpeg',
        size: 12,
        dataUrl: `data:image/jpeg;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      async (_url, init) => {
        requestBodies.push(JSON.parse(String(init.body || '{}')));
        const response = responses[Math.min(requestBodies.length - 1, responses.length - 1)];
        return {
          ok: true,
          json: async () => ({
            message: { content: response.content },
            done_reason: 'stop',
          }),
        };
      },
    );

    assert.equal(requestBodies.length, 4);
    assert.match(requestBodies[1].messages[1].content, /分区视觉识别/u);
    assert.equal(result.company, '新华保险');
    assert.equal(result.applicant, '张三');
    assert.equal(result.insured, '李四');
    assert.equal(result.insuredBirthday, '2010-01-01');
    assert.equal(result.date, '2024-08-15');
    assert.equal(result.firstPremium, '298');
    assert.equal(result.plans.length, 2);
    assert.equal(result.ocrText, undefined);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.POLICY_OCR_OLLAMA_BASE_URL;
    else process.env.POLICY_OCR_OLLAMA_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
    else process.env.POLICY_OCR_OLLAMA_VISION_MODEL = previousModel;
  }
});

test('Ollama vision skips focused complex passes when the speed mode disables them', async () => {
  const previousBaseUrl = process.env.POLICY_OCR_OLLAMA_BASE_URL;
  const previousModel = process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
  const previousComplexPasses = process.env.POLICY_OCR_OLLAMA_VISION_COMPLEX_PASSES;
  process.env.POLICY_OCR_OLLAMA_BASE_URL = 'http://ollama.test';
  process.env.POLICY_OCR_OLLAMA_VISION_MODEL = 'qwen3-vl:8b';
  process.env.POLICY_OCR_OLLAMA_VISION_COMPLEX_PASSES = 'false';
  const requestBodies = [];

  try {
    const result = await extractPolicyFieldsFromImageWithOllamaVision(
      {
        name: '学平险.jpg',
        type: 'image/jpeg',
        size: 12,
        dataUrl: `data:image/jpeg;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      async (_url, init) => {
        requestBodies.push(JSON.parse(String(init.body || '{}')));
        return {
          ok: true,
          json: async () => ({
            message: {
              content: JSON.stringify({
                company: '新华保险',
                name: '附加学生平安A款意外伤害医疗保险',
                applicant: '',
                beneficiary: '',
                insured: '',
                insuredIdNumber: '',
                insuredBirthday: '',
                date: '',
                paymentPeriod: '趸交',
                coveragePeriod: '至2025年08月15日',
                amount: '20000',
                firstPremium: '',
                plans: [],
                ocrText: '学平险.jpg',
              }),
            },
            done_reason: 'stop',
          }),
        };
      },
    );

    assert.equal(requestBodies.length, 1);
    assert.equal(result.company, '新华保险');
    assert.equal(result.name, '附加学生平安A款意外伤害医疗保险');
    assert.equal(result.beneficiary, '');
  } finally {
    if (previousBaseUrl === undefined) delete process.env.POLICY_OCR_OLLAMA_BASE_URL;
    else process.env.POLICY_OCR_OLLAMA_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
    else process.env.POLICY_OCR_OLLAMA_VISION_MODEL = previousModel;
    if (previousComplexPasses === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_COMPLEX_PASSES;
    else process.env.POLICY_OCR_OLLAMA_VISION_COMPLEX_PASSES = previousComplexPasses;
  }
});

test('Ollama vision supplements missing fields with line-by-line OCR when JSON passes stay partial', async () => {
  const previousBaseUrl = process.env.POLICY_OCR_OLLAMA_BASE_URL;
  const previousModel = process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
  process.env.POLICY_OCR_OLLAMA_BASE_URL = 'http://ollama.test';
  process.env.POLICY_OCR_OLLAMA_VISION_MODEL = 'qwen3-vl:8b';
  const requestBodies = [];

  const responses = [
    {
      content: JSON.stringify({
        company: '',
        name: '附加学生平安A款意外伤害医疗保险',
        applicant: '',
        beneficiary: '',
        insured: '',
        insuredIdNumber: '',
        insuredBirthday: '',
        date: '',
        paymentPeriod: '趸交',
        coveragePeriod: '至2025年08月15日',
        amount: '20000',
        firstPremium: '',
        plans: [],
      }),
    },
    {
      content: JSON.stringify({
        company: '',
        policyNumber: '',
        applicant: '',
        beneficiary: '',
        insured: '',
        insuredIdNumber: '',
        insuredBirthday: '',
        date: '',
        fieldEvidence: {},
      }),
    },
    {
      content: JSON.stringify({
        name: '',
        paymentPeriod: '',
        coveragePeriod: '',
        amount: '',
        firstPremium: '',
        plans: [],
        fieldEvidence: {},
      }),
    },
    {
      content: JSON.stringify({
        beneficiary: '',
        firstPremium: '',
        plans: [],
        fieldEvidence: {},
      }),
    },
    {
      content: JSON.stringify({
        lines: [
          '新华保险',
          '保险单',
          '投保人: 张三',
          '被保险人: 李四',
          '被保险人证件号码: 330106201001012345',
          '身故保险金受益人: 法定',
          '合同生效日期: 2024年08月15日',
        ],
        text: '',
      }),
    },
    {
      content: JSON.stringify({
        lines: [
          '保险利益表',
          '险种名称 保险金额 保险期间 交费期间 保险费',
          '学生平安意外伤害保险 80000 至2025年08月15日 趸交 298',
          '附加学生平安A款意外伤害医疗保险 20000 至2025年08月15日 趸交',
        ],
        text: '',
      }),
    },
    {
      content: JSON.stringify({
        lines: ['首期保险费合计: 298元'],
        text: '',
      }),
    },
  ];

  try {
    const result = await extractPolicyFieldsFromImageWithOllamaVision(
      {
        name: '学平险.jpg',
        type: 'image/jpeg',
        size: 12,
        dataUrl: `data:image/jpeg;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      async (_url, init) => {
        requestBodies.push(JSON.parse(String(init.body || '{}')));
        const response = responses[Math.min(requestBodies.length - 1, responses.length - 1)];
        return {
          ok: true,
          json: async () => ({
            message: { content: response.content },
            done_reason: 'stop',
          }),
        };
      },
    );

    assert.equal(requestBodies.length, 7);
    assert.match(requestBodies[4].messages[1].content, /一行一行抄写/u);
    assert.ok(requestBodies[4].format?.properties?.lines);
    assert.equal(result.company, '新华保险');
    assert.equal(result.applicant, '张三');
    assert.equal(result.insured, '李四');
    assert.equal(result.insuredBirthday, '2010-01-01');
    assert.equal(result.date, '2024-08-15');
    assert.equal(result.beneficiary, '法定');
    assert.equal(result.firstPremium, '298');
    assert.match(result.ocrText, /投保人: 张三/u);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.POLICY_OCR_OLLAMA_BASE_URL;
    else process.env.POLICY_OCR_OLLAMA_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
    else process.env.POLICY_OCR_OLLAMA_VISION_MODEL = previousModel;
  }
});

test('Ollama vision recovers field hints when thinking contains malformed JSON', async () => {
  const previousBaseUrl = process.env.POLICY_OCR_OLLAMA_BASE_URL;
  const previousModel = process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
  process.env.POLICY_OCR_OLLAMA_BASE_URL = 'http://ollama.test';
  process.env.POLICY_OCR_OLLAMA_VISION_MODEL = 'qwen3-vl:8b';

  try {
    const result = await extractPolicyFieldsFromImageWithOllamaVision(
      {
        name: 'thinking-policy.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      async () => ({
        ok: true,
        json: async () => ({
          message: {
            content: '',
            thinking: [
              '{"company":"新华保险",}',
              'company应该是“新华保险”。',
              'name应该是“荣耀鑫享赢家版终身寿险”。',
              'applicant是“冯力”。',
              'insured是“冯力”。',
              'insuredIdNumber应该是“330106198712072413”。',
              'date应该是“2024-06-06”。',
              'paymentPeriod应该是“10年交”。',
              'coveragePeriod是“终身”。',
              'amount应该是“165020元”。',
              'firstPremium应该是“20010元”。',
            ].join('\n'),
          },
          done_reason: 'length',
        }),
      }),
    );

    assert.equal(result.company, '新华保险');
    assert.equal(result.name, '荣耀鑫享赢家版终身寿险');
    assert.equal(result.applicant, '冯力');
    assert.equal(result.insured, '冯力');
    assert.equal(result.insuredIdNumber, '330106198712072413');
    assert.equal(result.insuredBirthday, '1987-12-07');
    assert.equal(result.date, '2024-06-06');
    assert.equal(result.paymentPeriod, '10年交');
    assert.equal(result.coveragePeriod, '终身');
    assert.equal(result.amount, '165020');
    assert.equal(result.firstPremium, '20010');
  } finally {
    if (previousBaseUrl === undefined) delete process.env.POLICY_OCR_OLLAMA_BASE_URL;
    else process.env.POLICY_OCR_OLLAMA_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
    else process.env.POLICY_OCR_OLLAMA_VISION_MODEL = previousModel;
  }
});

test('Ollama vision recovers narrative thinking without creating metadata plans', async () => {
  const previousBaseUrl = process.env.POLICY_OCR_OLLAMA_BASE_URL;
  const previousModel = process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
  process.env.POLICY_OCR_OLLAMA_BASE_URL = 'http://ollama.test';
  process.env.POLICY_OCR_OLLAMA_VISION_MODEL = 'qwen3-vl:8b';
  const thinking = [
    '<think>',
    '先看公司名称，图片顶部有“NCI 新华保险”，所以company应该是新华保险。',
    'name是保险产品/主险名称。在保险利益表里，第一个险种是“荣耀鑫享赢家版 终身寿险”，第二个是“金利瑞享终身寿险（万能型）”。通常主险是第一个，所以name可能是“荣耀鑫享赢家版终身寿险”。',
    'applicant是投保人，图片里“投保人：冯力”，所以applicant是冯力。',
    'beneficiary是身故保险金受益人，图片里有“被保险人的法定继承人”，所以beneficiary应该是“法定”。',
    'insured是被保险人，图片里“被保险人：冯力”，所以insured是冯力。',
    'insuredIdNumber是被保险人证件号码，图片里“证件号码：330106198712072413”，所以insuredIdNumber是这个号码。',
    'date应该是合同成立日期，图片里“合同成立日期：2024年06月06日”，格式要YYYY-MM-DD，所以是2024-06-06。',
    'paymentPeriod是交费期间，看保险利益表，“交费方式”列有“年交/10年”。',
  ].join('\n');

  try {
    const result = await extractPolicyFieldsFromImageWithOllamaVision(
      {
        name: 'narrative-thinking-policy.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      async () => ({
        ok: true,
        json: async () => ({
          message: { content: '', thinking },
          done_reason: 'length',
        }),
      }),
    );

    assert.equal(result.company, '新华保险');
    assert.equal(result.name, '荣耀鑫享赢家版终身寿险');
    assert.equal(result.applicant, '冯力');
    assert.equal(result.beneficiary, '法定');
    assert.equal(result.insured, '冯力');
    assert.equal(result.insuredIdNumber, '330106198712072413');
    assert.equal(result.insuredBirthday, '1987-12-07');
    assert.equal(result.date, '2024-06-06');
    assert.equal(result.paymentPeriod, '10年交');
    assert.ok(!(result.plans || []).some((plan) => /证件号码|合同成立日期/u.test(plan.name || '')));
  } finally {
    if (previousBaseUrl === undefined) delete process.env.POLICY_OCR_OLLAMA_BASE_URL;
    else process.env.POLICY_OCR_OLLAMA_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
    else process.env.POLICY_OCR_OLLAMA_VISION_MODEL = previousModel;
  }
});

test('Ollama vision complex pass continues after one focused pass fails', async () => {
  const previousBaseUrl = process.env.POLICY_OCR_OLLAMA_BASE_URL;
  const previousModel = process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
  process.env.POLICY_OCR_OLLAMA_BASE_URL = 'http://ollama.test';
  process.env.POLICY_OCR_OLLAMA_VISION_MODEL = 'qwen3-vl:8b';
  const requestBodies = [];

  try {
    const result = await extractPolicyFieldsFromImageWithOllamaVision(
      {
        name: 'complex-pass-failure-policy.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      async (_url, init) => {
        requestBodies.push(JSON.parse(String(init.body || '{}')));
        if (requestBodies.length === 1) {
          return {
            ok: true,
            json: async () => ({
              message: { content: '整图太复杂，无法输出JSON。' },
              done_reason: 'stop',
            }),
          };
        }
        if (requestBodies.length === 2) {
          return { ok: false, json: async () => ({}) };
        }
        if (requestBodies.length === 3) {
          return {
            ok: true,
            json: async () => ({
              message: {
                content: JSON.stringify({
                  company: '新华保险',
                  name: '荣耀鑫享赢家版终身寿险',
                  applicant: '冯力',
                  beneficiary: '法定',
                  insured: '冯力',
                  insuredIdNumber: '330106198712072413',
                  insuredBirthday: '1987-12-07',
                  date: '2024-06-06',
                  paymentPeriod: '10年交',
                  coveragePeriod: '终身',
                  amount: '165020',
                  firstPremium: '20010',
                  plans: [],
                  ocrText: '保险利益表\n荣耀鑫享赢家版终身寿险\n165020.00元\n首期保险费合计:20010.00元',
                }),
              },
              done_reason: 'stop',
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            message: { content: '当前区域没有可用字段。' },
            done_reason: 'stop',
          }),
        };
      },
    );

    assert.equal(requestBodies.length, 4);
    assert.match(requestBodies[2].messages[1].content, /保险利益表和险种明细区/u);
    assert.equal(result.company, '新华保险');
    assert.equal(result.name, '荣耀鑫享赢家版终身寿险');
    assert.equal(result.amount, '165020');
    assert.equal(result.firstPremium, '20010');
  } finally {
    if (previousBaseUrl === undefined) delete process.env.POLICY_OCR_OLLAMA_BASE_URL;
    else process.env.POLICY_OCR_OLLAMA_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
    else process.env.POLICY_OCR_OLLAMA_VISION_MODEL = previousModel;
  }
});

test('Ollama vision request aborts with a separate hard timeout', async () => {
  const previousBaseUrl = process.env.POLICY_OCR_OLLAMA_BASE_URL;
  const previousModel = process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
  const previousVisionTimeout = process.env.POLICY_OCR_OLLAMA_VISION_TIMEOUT_MS;
  const previousOllamaTimeout = process.env.POLICY_OCR_OLLAMA_TIMEOUT_MS;
  process.env.POLICY_OCR_OLLAMA_BASE_URL = 'http://ollama.test';
  process.env.POLICY_OCR_OLLAMA_VISION_MODEL = 'qwen3-vl:8b';
  process.env.POLICY_OCR_OLLAMA_VISION_TIMEOUT_MS = '25';
  process.env.POLICY_OCR_OLLAMA_TIMEOUT_MS = '180000';
  let signalSeen = false;

  try {
    await assert.rejects(
      extractPolicyFieldsFromImageWithOllamaVision(
        {
          name: 'slow-policy.png',
          type: 'image/png',
          size: 12,
          dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
        },
        async (_url, init) => {
          signalSeen = Boolean(init.signal);
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('AbortError')));
          });
        },
      ),
      /POLICY_OCR_VISION_TIMEOUT/u,
    );
    assert.equal(signalSeen, true);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.POLICY_OCR_OLLAMA_BASE_URL;
    else process.env.POLICY_OCR_OLLAMA_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
    else process.env.POLICY_OCR_OLLAMA_VISION_MODEL = previousModel;
    if (previousVisionTimeout === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_TIMEOUT_MS;
    else process.env.POLICY_OCR_OLLAMA_VISION_TIMEOUT_MS = previousVisionTimeout;
    if (previousOllamaTimeout === undefined) delete process.env.POLICY_OCR_OLLAMA_TIMEOUT_MS;
    else process.env.POLICY_OCR_OLLAMA_TIMEOUT_MS = previousOllamaTimeout;
  }
});

test('Ollama vision timeout inherits the generic Ollama timeout when unset', async () => {
  const previousBaseUrl = process.env.POLICY_OCR_OLLAMA_BASE_URL;
  const previousModel = process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
  const previousVisionTimeout = process.env.POLICY_OCR_OLLAMA_VISION_TIMEOUT_MS;
  const previousOllamaTimeout = process.env.POLICY_OCR_OLLAMA_TIMEOUT_MS;
  process.env.POLICY_OCR_OLLAMA_BASE_URL = 'http://ollama.test';
  process.env.POLICY_OCR_OLLAMA_VISION_MODEL = 'qwen3-vl:8b';
  delete process.env.POLICY_OCR_OLLAMA_VISION_TIMEOUT_MS;
  process.env.POLICY_OCR_OLLAMA_TIMEOUT_MS = '25';
  let signalSeen = false;

  try {
    await assert.rejects(
      extractPolicyFieldsFromImageWithOllamaVision(
        {
          name: 'slow-policy-generic-timeout.png',
          type: 'image/png',
          size: 12,
          dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
        },
        async (_url, init) => {
          signalSeen = Boolean(init.signal);
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('AbortError')));
          });
        },
      ),
      /POLICY_OCR_VISION_TIMEOUT/u,
    );
    assert.equal(signalSeen, true);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.POLICY_OCR_OLLAMA_BASE_URL;
    else process.env.POLICY_OCR_OLLAMA_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_MODEL;
    else process.env.POLICY_OCR_OLLAMA_VISION_MODEL = previousModel;
    if (previousVisionTimeout === undefined) delete process.env.POLICY_OCR_OLLAMA_VISION_TIMEOUT_MS;
    else process.env.POLICY_OCR_OLLAMA_VISION_TIMEOUT_MS = previousVisionTimeout;
    if (previousOllamaTimeout === undefined) delete process.env.POLICY_OCR_OLLAMA_TIMEOUT_MS;
    else process.env.POLICY_OCR_OLLAMA_TIMEOUT_MS = previousOllamaTimeout;
  }
});

test('Ollama provider supplements incomplete OCR fields with vision scan', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  process.env.POLICY_OCR_PROVIDER = 'ollama_vision_local';
  let visionCalls = 0;
  let paddleCalls = 0;

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: {
        name: 'complete-policy.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      ocrText: '',
      paddleLayoutScanner: async () => {
        paddleCalls += 1;
        return {
          ocrText: 'Paddle OCR 完整原文\n新华保险\n盛世荣耀臻享版终身寿险',
          data: {
            company: '新华保险',
            name: '盛世荣耀臻享版终身寿险',
          },
          fieldEvidence: {
            name: {
              value: '盛世荣耀臻享版终身寿险',
              rowText: 'Paddle OCR 完整原文 新华保险 盛世荣耀臻享版终身寿险',
              relation: 'layout',
            },
          },
        };
      },
      ollamaVisionExtractor: async () => {
        visionCalls += 1;
        return {
          company: '新华保险',
          name: '盛世荣耀臻享版终身寿险',
          applicant: '温舒萍',
          beneficiary: '法定',
          insured: '温舒萍',
          insuredBirthday: '1988-12-16',
          date: '2026-04-01',
          paymentPeriod: '10年交',
          coveragePeriod: '终身',
          amount: '24441',
          firstPremium: '3000',
        };
      },
    });

    assert.equal(visionCalls, 1);
    assert.equal(paddleCalls, 1);
    assert.equal(scan.data.applicant, '温舒萍');
    assert.equal(scan.data.beneficiary, '法定');
    assert.equal(scan.ocrText, 'PaddleOCR完整原文\n新华保险\n盛世荣耀臻享版终身寿险');
    assert.equal(scan.fieldEvidence.name.relation, 'layout');
    assert.ok(scan.ocrWarnings.some((warning) => warning.includes('Ollama 视觉仅补充 OCR 缺失字段')));
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
  }
});

test('Ollama provider skips vision scan when OCR fills more than 60 percent of scalar fields', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  process.env.POLICY_OCR_PROVIDER = 'ollama_vision_local';
  const calls = [];

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: {
        name: 'incomplete-policy.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      ocrText: '',
      paddleLayoutScanner: async () => {
        calls.push('paddle');
        return {
          ocrText: '新华保险 基本内容 被保险人 温舒萍 保险利益表',
          data: {
            company: '新华保险',
            name: '盛世荣耀臻享版终身寿险',
            applicant: '温舒萍',
            beneficiary: '法定',
            insured: '温舒萍',
            insuredBirthday: '1988-12-16',
            date: '2026-04-01',
            paymentPeriod: '10年交',
            coveragePeriod: '终身',
            amount: '24441',
            firstPremium: '3000',
          },
        };
      },
      ollamaVisionExtractor: async () => {
        calls.push('vision');
        throw new Error('VISION_SHOULD_NOT_RUN');
      },
    });

    assert.deepEqual(calls, ['paddle']);
    assert.equal(scan.data.applicant, '温舒萍');
    assert.equal(scan.data.beneficiary, '法定');
    assert.equal(scan.data.insuredBirthday, '1988-12-16');
    assert.equal(scan.data.firstPremium, '3000');
    assert.equal(scan.ocrWarnings, undefined);
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
  }
});

test('Ollama provider sends low Excel-read OCR result to vision and leaves uncertain table fields empty', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  const previousFallback = process.env.POLICY_OCR_FALLBACK_PADDLE;
  const previousThreshold = process.env.POLICY_OCR_EXCEL_SKILL_MIN_RECOGNITION_RATE;
  process.env.POLICY_OCR_PROVIDER = 'ollama_vision_local';
  process.env.POLICY_OCR_FALLBACK_PADDLE = 'true';
  process.env.POLICY_OCR_EXCEL_SKILL_MIN_RECOGNITION_RATE = '0.6';
  const calls = [];

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: {
        name: 'low-excel-recognition-policy.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      ocrText: '',
      paddleLayoutScanner: async () => {
        calls.push('paddle');
        return {
          ocrText: '新华保险',
          data: { company: '新华保险' },
        };
      },
      ollamaVisionExtractor: async () => {
        calls.push('vision');
        return {
          company: '新华保险',
          policyNumber: 'A001',
          applicant: '张三',
          insured: '温舒萍',
          insuredBirthday: '1988-12-16',
          date: '2026-04-01',
          paymentPeriod: '10年交',
          coveragePeriod: '终身',
          amount: '100000',
          firstPremium: '3000',
          plans: [
            {
              role: 'main',
              name: '荣耀鑫享赢家版终身寿险',
              amount: '100000',
              coveragePeriod: '终身',
              paymentPeriod: '10年交',
              premium: '3000',
            },
          ],
          fieldConfidence: { applicant: 'review' },
        };
      },
    });

    assert.deepEqual(calls, ['paddle', 'vision']);
    assert.equal(scan.data.company, '新华保险');
    assert.equal(scan.data.name, '荣耀鑫享赢家版终身寿险');
    assert.equal(scan.data.applicant || '', '');
    assert.equal(scan.data.firstPremium, '3000');
    assert.equal(scan.fieldAttribution.company.source, 'ocr');
    assert.equal(scan.fieldAttribution.name.source, 'vision');
    assert.equal(scan.fieldAttribution.name.parser, 'analyzer/csv-parser');
    assert.equal(scan.fieldAttribution.applicant, undefined);
    assert.equal(scan.ocrText, '新华保险');
    assert.ok(scan.ocrWarnings.some((warning) => warning.includes('Ollama 视觉仅补充 OCR 缺失字段')));
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
    if (previousFallback === undefined) delete process.env.POLICY_OCR_FALLBACK_PADDLE;
    else process.env.POLICY_OCR_FALLBACK_PADDLE = previousFallback;
    if (previousThreshold === undefined) delete process.env.POLICY_OCR_EXCEL_SKILL_MIN_RECOGNITION_RATE;
    else process.env.POLICY_OCR_EXCEL_SKILL_MIN_RECOGNITION_RATE = previousThreshold;
  }
});

test('Ollama provider falls back to Paddle when vision times out', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  process.env.POLICY_OCR_PROVIDER = 'ollama_vision_local';
  const calls = [];

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: {
        name: 'vision-timeout-policy.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      ocrText: '',
      paddleLayoutScanner: async () => {
        calls.push('paddle');
        return {
          ocrText: '新华保险\n投保人:冯力\n被保险人:冯力\n险种名称:荣耀鑫享赢家版终身寿险\n基本保险金额:165020元\n首期保险费合计:20010元',
          data: {
            company: '新华保险',
            name: '荣耀鑫享赢家版终身寿险',
            applicant: '冯力',
            insured: '冯力',
            amount: '165020',
            firstPremium: '20010',
          },
        };
      },
      ollamaVisionExtractor: async () => {
        calls.push('vision');
        throw new Error('POLICY_OCR_VISION_TIMEOUT');
      },
    });

    assert.deepEqual(calls, ['paddle', 'vision']);
    assert.equal(scan.data.name, '荣耀鑫享赢家版终身寿险');
    assert.equal(scan.data.amount, '165020');
    assert.ok(scan.ocrWarnings.some((warning) => warning.includes('Ollama 视觉识别超时')));
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
  }
});

test('remote GPU vision provider falls back to Paddle when parsed fields are unavailable', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  const previousRemoteBaseUrl = process.env.POLICY_OCR_REMOTE_VISION_BASE_URL;
  const previousFallback = process.env.POLICY_OCR_FALLBACK_PADDLE;
  const previousFetch = globalThis.fetch;
  process.env.POLICY_OCR_PROVIDER = 'remote_gpu_vision';
  process.env.POLICY_OCR_REMOTE_VISION_BASE_URL = 'http://gpu4080.test';
  process.env.POLICY_OCR_FALLBACK_PADDLE = 'true';
  const calls = [];

  globalThis.fetch = async () => {
    calls.push('remote');
    return {
      ok: false,
      status: 500,
      json: async () => ({}),
    };
  };

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: {
        name: 'remote-vision-failed-policy.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      ocrText: '',
      paddleLayoutScanner: async () => {
        calls.push('paddle');
        return {
          ocrText: '新华保险\n投保人:冯力\n被保险人:冯力\n险种名称:荣耀鑫享赢家版终身寿险\n基本保险金额:165020元\n首期保险费合计:20010元',
          data: {
            company: '新华保险',
            name: '荣耀鑫享赢家版终身寿险',
            applicant: '冯力',
            insured: '冯力',
            amount: '165020',
            firstPremium: '20010',
          },
        };
      },
    });

    assert.equal(calls.filter((call) => call === 'remote').length, 1);
    assert.equal(calls.filter((call) => call === 'paddle').length, 1);
    assert.equal(scan.data.name, '荣耀鑫享赢家版终身寿险');
    assert.equal(scan.data.firstPremium, '20010');
    assert.match(scan.ocrText, /投保人:冯力/u);
    assert.ok(scan.ocrWarnings.some((warning) => warning.includes('4080 视觉未返回可解析结果')));
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
    if (previousRemoteBaseUrl === undefined) delete process.env.POLICY_OCR_REMOTE_VISION_BASE_URL;
    else process.env.POLICY_OCR_REMOTE_VISION_BASE_URL = previousRemoteBaseUrl;
    if (previousFallback === undefined) delete process.env.POLICY_OCR_FALLBACK_PADDLE;
    else process.env.POLICY_OCR_FALLBACK_PADDLE = previousFallback;
    globalThis.fetch = previousFetch;
  }
});

test('remote GPU vision skips vLLM request when OCR fills more than 60 percent of scalar fields', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  const previousRemoteBaseUrl = process.env.POLICY_OCR_REMOTE_VISION_BASE_URL;
  const previousFallback = process.env.POLICY_OCR_FALLBACK_PADDLE;
  const previousFetch = globalThis.fetch;
  process.env.POLICY_OCR_PROVIDER = 'remote_gpu_vision';
  process.env.POLICY_OCR_REMOTE_VISION_BASE_URL = 'http://gpu4080.test';
  process.env.POLICY_OCR_FALLBACK_PADDLE = 'true';

  globalThis.fetch = async () => {
    throw new Error('REMOTE_SHOULD_NOT_RUN');
  };

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: {
        name: 'remote-parallel-policy.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      ocrText: '',
      paddleLayoutScanner: async () => {
        return {
          ocrText: '新华保险\n投保人:冯力\n被保险人:冯力\n险种名称:OCR识别主险\n基本保险金额:165020元\n首期保险费合计:20010元',
          data: {
            company: '新华保险',
            name: 'OCR识别主险',
            applicant: '冯力',
            beneficiary: '法定',
            policyNumber: '990163781859',
            insured: '冯力',
            insuredBirthday: '1987-12-07',
            date: '2024-06-07',
            paymentPeriod: '10年交',
            coveragePeriod: '终身',
            amount: '165020',
            firstPremium: '20010',
          },
        };
      },
    });

    assert.equal(scan.data.name, 'OCR识别主险');
    assert.equal(scan.data.applicant, '冯力');
    assert.equal(scan.data.insured, '冯力');
    assert.match(scan.ocrText, /投保人:冯力/u);
    assert.equal(scan.visionDebug, undefined);
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
    if (previousRemoteBaseUrl === undefined) delete process.env.POLICY_OCR_REMOTE_VISION_BASE_URL;
    else process.env.POLICY_OCR_REMOTE_VISION_BASE_URL = previousRemoteBaseUrl;
    if (previousFallback === undefined) delete process.env.POLICY_OCR_FALLBACK_PADDLE;
    else process.env.POLICY_OCR_FALLBACK_PADDLE = previousFallback;
    globalThis.fetch = previousFetch;
  }
});

test('remote GPU vision supplements only empty OCR fields', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  const previousRemoteBaseUrl = process.env.POLICY_OCR_REMOTE_VISION_BASE_URL;
  const previousFallback = process.env.POLICY_OCR_FALLBACK_PADDLE;
  const previousFetch = globalThis.fetch;
  process.env.POLICY_OCR_PROVIDER = 'remote_gpu_vision';
  process.env.POLICY_OCR_REMOTE_VISION_BASE_URL = 'http://gpu4080.test';
  process.env.POLICY_OCR_FALLBACK_PADDLE = 'true';
  const calls = [];

  globalThis.fetch = async () => {
    calls.push('remote');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                company: '新华保险',
                name: '视觉识别主险',
                applicant: '视觉投保人',
                beneficiary: '法定',
                amount: '165020',
                firstPremium: '20010',
              }),
            },
          },
        ],
      }),
    };
  };

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: {
        name: 'remote-supplement-policy.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      ocrText: '',
      paddleLayoutScanner: async () => {
        calls.push('paddle');
        return {
          ocrText: '新华保险\n投保人:冯力\n被保险人:冯力\n险种名称:OCR识别主险',
          data: {
            company: '新华保险',
            name: 'OCR识别主险',
            applicant: '冯力',
            insured: '冯力',
          },
        };
      },
    });

    assert.deepEqual(calls, ['paddle', 'remote']);
    assert.equal(scan.data.name, 'OCR识别主险');
    assert.equal(scan.data.applicant, '冯力');
    assert.equal(scan.data.beneficiary, '法定');
    assert.equal(scan.data.amount, '165020');
    assert.equal(scan.data.firstPremium, '20010');
    assert.equal(scan.fieldAttribution.name.source, 'ocr');
    assert.equal(scan.fieldAttribution.beneficiary.source, 'vision');
    assert.equal(scan.fieldAttribution.firstPremium.source, 'vision');
    assert.ok(scan.ocrWarnings.some((warning) => warning.includes('4080 视觉仅补充 OCR 缺失字段')));
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
    if (previousRemoteBaseUrl === undefined) delete process.env.POLICY_OCR_REMOTE_VISION_BASE_URL;
    else process.env.POLICY_OCR_REMOTE_VISION_BASE_URL = previousRemoteBaseUrl;
    if (previousFallback === undefined) delete process.env.POLICY_OCR_FALLBACK_PADDLE;
    else process.env.POLICY_OCR_FALLBACK_PADDLE = previousFallback;
    globalThis.fetch = previousFetch;
  }
});

test('Huawei Cloud insurance OCR provider maps structured response into policy scan fields', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  const previousProjectId = process.env.POLICY_OCR_HUAWEI_PROJECT_ID;
  const previousToken = process.env.POLICY_OCR_HUAWEI_X_AUTH_TOKEN;
  const previousEndpoint = process.env.POLICY_OCR_HUAWEI_ENDPOINT;
  const previousFetch = globalThis.fetch;
  process.env.POLICY_OCR_PROVIDER = 'huawei_cloud_insurance';
  process.env.POLICY_OCR_HUAWEI_PROJECT_ID = 'test-project-id';
  process.env.POLICY_OCR_HUAWEI_X_AUTH_TOKEN = 'test-token';
  process.env.POLICY_OCR_HUAWEI_ENDPOINT = 'https://ocr.cn-north-4.myhuaweicloud.com';
  const requestBodies = [];

  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://ocr.cn-north-4.myhuaweicloud.com/v2/test-project-id/ocr/insurance-policy');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-Auth-Token'], 'test-token');
    const body = JSON.parse(options.body);
    requestBodies.push(body);
    assert.equal(body.image, Buffer.from('fake-image').toString('base64'));
    assert.equal(body.detect_direction, true);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          company: { words: '华夏人寿保险股份有限公司' },
          bill_number: { words: 'P1234567890' },
          effective_date: { words: '2024年01月02日' },
          applicant_list: [
            { name: { words: '张三' } },
          ],
          insurant_list: [
            { name: { words: '李四' }, id_number: { words: '110105199001010010' } },
          ],
          beneficiary_list: [
            { beneficiary_type: { words: '身故保险金受益人' }, beneficiary_name: { words: '法定继承人' } },
          ],
          insurance_list: [
            {
              insurance_name: { words: '华夏黄金甲终身寿险' },
              insurance_amount: { words: 'RMB50000.00' },
              insurance_period: { words: '终身' },
              payment_frequency: { words: '年交' },
              payment_period: { words: '10年交' },
              payment_amount: { words: '4100.00' },
            },
            {
              insurance_name: { words: '附加投保人豁免保险' },
              payment_frequency: { words: '年交' },
              payment_period: { words: '10年交' },
              payment_amount: { words: '100.00' },
            },
          ],
        },
      }),
    };
  };

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: {
        name: 'huawei-policy.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      ocrText: '',
    });

    assert.equal(requestBodies.length, 1);
    assert.equal(scan.data.company, '华夏保险');
    assert.equal(scan.data.name, '华夏黄金甲终身寿险');
    assert.equal(scan.data.policyNumber, 'P1234567890');
    assert.equal(scan.data.applicant, '张三');
    assert.equal(scan.data.insured, '李四');
    assert.equal(scan.data.insuredIdNumber, '110105199001010010');
    assert.equal(scan.data.insuredBirthday, '1990-01-01');
    assert.equal(scan.data.beneficiary, '法定');
    assert.equal(scan.data.date, '2024-01-02');
    assert.equal(scan.data.paymentPeriod, '10年交');
    assert.equal(scan.data.coveragePeriod, '终身');
    assert.equal(scan.data.amount, '50000');
    assert.equal(scan.data.firstPremium, '4200');
    assert.equal(scan.data.plans.length, 2);
    assert.equal(scan.data.plans[1].role, 'rider');
    assert.match(scan.ocrText, /保险公司:华夏保险/u);
    assert.equal(scan.fieldConfidence.company, 'huawei-cloud');
    assert.equal(scan.fieldEvidence.policyNumber.source, 'huawei-cloud-ocr');
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
    if (previousProjectId === undefined) delete process.env.POLICY_OCR_HUAWEI_PROJECT_ID;
    else process.env.POLICY_OCR_HUAWEI_PROJECT_ID = previousProjectId;
    if (previousToken === undefined) delete process.env.POLICY_OCR_HUAWEI_X_AUTH_TOKEN;
    else process.env.POLICY_OCR_HUAWEI_X_AUTH_TOKEN = previousToken;
    if (previousEndpoint === undefined) delete process.env.POLICY_OCR_HUAWEI_ENDPOINT;
    else process.env.POLICY_OCR_HUAWEI_ENDPOINT = previousEndpoint;
    globalThis.fetch = previousFetch;
  }
});

test('Huawei Cloud insurance OCR provider signs requests with AK/SK when token is absent', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  const previousProjectId = process.env.POLICY_OCR_HUAWEI_PROJECT_ID;
  const previousToken = process.env.POLICY_OCR_HUAWEI_X_AUTH_TOKEN;
  const previousAuthToken = process.env.POLICY_OCR_HUAWEI_AUTH_TOKEN;
  const previousAk = process.env.POLICY_OCR_HUAWEI_AK;
  const previousSk = process.env.POLICY_OCR_HUAWEI_SK;
  const previousEndpoint = process.env.POLICY_OCR_HUAWEI_ENDPOINT;
  const previousFetch = globalThis.fetch;
  process.env.POLICY_OCR_PROVIDER = 'huawei_cloud_insurance';
  process.env.POLICY_OCR_HUAWEI_PROJECT_ID = 'test-project-id';
  delete process.env.POLICY_OCR_HUAWEI_X_AUTH_TOKEN;
  delete process.env.POLICY_OCR_HUAWEI_AUTH_TOKEN;
  process.env.POLICY_OCR_HUAWEI_AK = 'test-ak';
  process.env.POLICY_OCR_HUAWEI_SK = 'test-sk';
  process.env.POLICY_OCR_HUAWEI_ENDPOINT = 'https://ocr.cn-north-4.myhuaweicloud.com';

  globalThis.fetch = async (_url, options) => {
    assert.match(options.headers.Authorization, /^SDK-HMAC-SHA256 Access=test-ak,/u);
    assert.equal(options.headers['x-sdk-date'].length, 16);
    assert.equal(options.headers['content-type'], 'application/json');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          company: { words: '新华保险' },
          insurance_list: [
            {
              insurance_name: { words: '测试终身寿险' },
              insurance_amount: { words: '10万元' },
              payment_amount: { words: '1000元' },
            },
          ],
        },
      }),
    };
  };

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: {
        name: 'huawei-policy.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      ocrText: '',
    });

    assert.equal(scan.data.company, '新华保险');
    assert.equal(scan.data.name, '测试终身寿险');
    assert.equal(scan.data.amount, '100000');
    assert.equal(scan.data.firstPremium, '1000');
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
    if (previousProjectId === undefined) delete process.env.POLICY_OCR_HUAWEI_PROJECT_ID;
    else process.env.POLICY_OCR_HUAWEI_PROJECT_ID = previousProjectId;
    if (previousToken === undefined) delete process.env.POLICY_OCR_HUAWEI_X_AUTH_TOKEN;
    else process.env.POLICY_OCR_HUAWEI_X_AUTH_TOKEN = previousToken;
    if (previousAuthToken === undefined) delete process.env.POLICY_OCR_HUAWEI_AUTH_TOKEN;
    else process.env.POLICY_OCR_HUAWEI_AUTH_TOKEN = previousAuthToken;
    if (previousAk === undefined) delete process.env.POLICY_OCR_HUAWEI_AK;
    else process.env.POLICY_OCR_HUAWEI_AK = previousAk;
    if (previousSk === undefined) delete process.env.POLICY_OCR_HUAWEI_SK;
    else process.env.POLICY_OCR_HUAWEI_SK = previousSk;
    if (previousEndpoint === undefined) delete process.env.POLICY_OCR_HUAWEI_ENDPOINT;
    else process.env.POLICY_OCR_HUAWEI_ENDPOINT = previousEndpoint;
    globalThis.fetch = previousFetch;
  }
});

test('Ollama provider skips Paddle repair when Paddle fallback is disabled', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  const previousFallback = process.env.POLICY_OCR_FALLBACK_PADDLE;
  process.env.POLICY_OCR_PROVIDER = 'ollama_vision_local';
  process.env.POLICY_OCR_FALLBACK_PADDLE = 'false';
  const calls = [];

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: {
        name: 'vision-only-policy.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      ocrText: '',
      paddleLayoutScanner: async () => {
        calls.push('paddle');
        return {
          ocrText: 'Paddle OCR should not be used',
          data: { applicant: 'Paddle投保人' },
        };
      },
      ollamaVisionExtractor: async () => {
        calls.push('vision');
        return {
          company: '新华保险',
          name: '盛世荣耀臻享版终身寿险',
          applicant: '温舒萍',
          beneficiary: '法定',
          insured: '温舒萍',
          insuredBirthday: '1988-12-16',
          date: '2026-04-01',
          paymentPeriod: '10年交',
          coveragePeriod: '终身',
          amount: '24441',
          firstPremium: '3000',
        };
      },
    });

    assert.deepEqual(calls, ['vision']);
    assert.equal(scan.data.applicant, '温舒萍');
    assert.equal(scan.ocrText, '');
    assert.equal(scan.ocrWarnings, undefined);
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
    if (previousFallback === undefined) delete process.env.POLICY_OCR_FALLBACK_PADDLE;
    else process.env.POLICY_OCR_FALLBACK_PADDLE = previousFallback;
  }
});

test('Ollama provider keeps OCR plan-table structure when OCR fills enough scalar fields', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  process.env.POLICY_OCR_PROVIDER = 'ollama_vision_local';
  const calls = [];

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: {
        name: 'pingan-plan-table.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      ocrText: '',
      paddleLayoutScanner: async () => {
        calls.push('paddle');
        return {
          ocrText: '中国平安保险\n保险利益表\n险种名称\n平安福重大疾病保险\n附加长期意外伤害保险',
          data: {
            company: '中国平安保险',
            name: '平安福重大疾病保险',
            applicant: '李四',
            beneficiary: '法定',
            insured: '李四',
            insuredBirthday: '1990-01-01',
            date: '2026-01-01',
            paymentPeriod: '20年交',
            coveragePeriod: '终身',
            amount: '300000',
            firstPremium: '6800',
            plans: [
              {
                role: 'main',
                name: '平安福重大疾病保险',
                amount: '300000',
                coveragePeriod: '终身',
                paymentPeriod: '20年交',
                premium: '6000',
              },
              {
                role: 'rider',
                name: '附加长期意外伤害保险',
                amount: '100000',
                coveragePeriod: '30年',
                paymentPeriod: '20年交',
                premium: '800',
              },
            ],
          },
        };
      },
      ollamaVisionExtractor: async () => {
        calls.push('vision');
        return {
          company: '中国平安保险',
          name: '平安福重大疾病保险',
          applicant: '李四',
          beneficiary: '法定',
          insured: '李四',
          insuredBirthday: '1990-01-01',
          date: '2026-01-01',
          paymentPeriod: '20年交',
          coveragePeriod: '终身',
          amount: '300000',
          firstPremium: '6800',
          ocrText: '中国平安保险\n保险利益表\n险种名称\n平安福重大疾病保险\n附加长期意外伤害保险',
        };
      },
    });

    assert.deepEqual(calls, ['paddle']);
    assert.equal(scan.data.company, '中国平安保险');
    assert.equal(scan.data.plans.length, 2);
    assert.equal(scan.data.plans[1].role, 'rider');
    assert.equal(scan.data.plans[1].name, '附加长期意外伤害保险');
    assert.equal(scan.ocrWarnings, undefined);
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
  }
});

test('Ollama provider ignores identity-number amount and metadata rider rows during Paddle repair', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  process.env.POLICY_OCR_PROVIDER = 'ollama_vision_local';

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: {
        name: 'id-amount.png',
        type: 'image/png',
        size: 12,
        dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
      },
      ocrText: '',
      paddleLayoutScanner: async () => ({
        ocrText: '保险利益表\n盛世荣耀臻享版\n终身寿险（分红型）\n24441.00元\n终身\n年交\n/10年\n每年3000.00元',
        data: {
          company: '新华保险',
          name: '盛世荣耀臻享版终身寿险（分红型）',
          applicant: '温舒萍',
          beneficiary: '法定',
          insured: '温舒萍',
          insuredIdNumber: '360502198812160922',
          date: '2026-04-01',
          paymentPeriod: '10年交',
          coveragePeriod: '终身',
          amount: '24441',
          firstPremium: '3000',
        },
      }),
      ollamaVisionExtractor: async () => ({
        company: '新华保险',
        name: '保障期间:终身',
        applicant: '温舒萍',
        beneficiary: '法定',
        insured: '温舒萍',
        insuredIdNumber: '360502198812160922',
        insuredBirthday: '1988-12-16',
        date: '2026-04-01',
        paymentPeriod: '趸交',
        coveragePeriod: '终身',
        amount: '360502198812160900',
        firstPremium: '3000',
        plans: [
          {
            role: 'rider',
            name: '保障期间:终身',
            amount: '',
            premium: '',
            coveragePeriod: '',
            paymentPeriod: '趸交',
          },
        ],
      }),
    });

    assert.equal(scan.data.name, '盛世荣耀臻享版终身寿险（分红型）');
    assert.equal(scan.data.amount, '24441');
    assert.equal(scan.data.paymentPeriod, '10年交');
    assert.ok(!scan.data.plans?.some((plan) => plan.name === '保障期间:终身'));
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
  }
});

test('PaddleOCR line output maps insurance basic fields through the existing matcher', () => {
  const paddlePayload = {
    ok: true,
    pipeline: 'ocr',
    lines: [
      'NCI 新华保险',
      '保险单',
      '合同生效日期:2026年04月01日',
      '投保人:张三',
      '被保险人:张三',
      '保险利益表',
      '险种名称',
      '盛世荣耀臻享版',
      '终身寿险（分红型）',
      '24441.00元',
      '终身',
      '年交',
      '/10年',
      '每年3000.00元',
      '首期保险费合计:',
      '￥3000.00',
    ],
  };

  const recognizedText = extractPaddleOcrText(paddlePayload);
  const data = extractPolicyFieldsFromText(recognizedText);

  assert.equal(data.company, '新华保险');
  assert.equal(data.name, '盛世荣耀臻享版终身寿险（分红型）');
  assert.equal(data.date, '2026-04-01');
  assert.equal(data.coveragePeriod, '终身');
  assert.equal(data.paymentPeriod, '10年交');
  assert.equal(data.amount, '24441');
  assert.equal(data.firstPremium, '3000');
});

test('OCR extraction tolerates common OCR mistakes in applicant and insured labels', () => {
  const data = extractPolicyFieldsFromText(`
关爱人生每一天
保险单
保险合同号:990171228067
基本内容
合同成立日期:2024年09月29日
合同生效日期:2024年09月30日
设保人:冯力
证件号码:330106198712072413
披保险人:冯力
证件号码:330106198712072413
身故保险金受益人
被保险人的法定继承人
保险利益表
险种名称
基本保险金额/保险金额
保险期间
交费方式
保险费
畅行万里智赢版
60000.00元
至2068年9月30日零时
年交
两全保险
/10年
每年3156.00元
首期保险费合计:
￥3296.00
  `);

  assert.equal(data.applicant, '冯力');
  assert.equal(data.insured, '冯力');
  assert.equal(data.insuredIdNumber, '330106198712072413');
  assert.equal(data.insuredBirthday, '1987-12-07');
  assert.equal(data.beneficiary, '法定');
  assert.equal(data.date, '2024-09-30');
});

test('OCR extraction hydrates single main plan details from shuffled benefit-table sections', () => {
  const data = extractPolicyFieldsFromText(`
No. 422400000032674998
NCI新华保险
关爱人生每一天
币值单位:人民币元
合同成立日期:2024年09月28日
投保人:温舒萍
被保险人:温舒萍
身故保险金受益人
被保险人的法定继承人
险种名称
基本保险金额/保险金额
/保障计划/份数
畅行万里智赢版
两全保险
100000.00元
特别约定:
本栏空白
保险单
基本内容
保险合同号:990171130249
合同生效日期:2024年09月29日
证件号码:
360502198812160922
证件号码:360502198812160922
受益顺序
受益份额
证件号码
保险利益表
保险期间
交费方式
保险费约定支付日
/交费期间（续期保险费交费日期）
/交费期满日
至2069年9月29日零时年交
每年09月29日
/20年
/2043年09月29日
首期保险费合计:（大写）叁仟壹佰贰拾元整
保险费
每年3120.00元
¥3120.00
  `);

  assert.equal(data.name, '畅行万里智赢版两全保险');
  assert.equal(data.paymentPeriod, '20年交');
  assert.equal(data.coveragePeriod, '至2069年9月29日零时');
  assert.equal(data.amount, '100000');
  assert.equal(data.firstPremium, '3120');
  assert.deepEqual(
    data.plans.map((plan) => ({
      role: plan.role,
      name: plan.name,
      amount: plan.amount,
      coveragePeriod: plan.coveragePeriod,
      paymentMode: plan.paymentMode,
      paymentPeriod: plan.paymentPeriod,
      premium: plan.premium,
    })),
    [
      {
        role: 'main',
        name: '畅行万里智赢版两全保险',
        amount: '100000',
        coveragePeriod: '至2069年9月29日零时',
        paymentMode: '年交',
        paymentPeriod: '20年交',
        premium: '3120',
      },
    ],
  );
});

test('OCR extraction keeps rider when rider payment values appear before rider name', () => {
  const data = extractPolicyFieldsFromText(`
关爱人生每一天
保险单
值单位:人民币元
保险合同号:990171228067
基本内容
合同成立日期:2024年09月29日
合同生效日期:2024年09月30日
设保人:冯力
证件号码:330106198712072413
披保险人:冯力
证件号码:330106198712072413
身故保险金受益人
被保险人的法定继承人
保险利益表
险种名称
基本保险金额/保险金额
保险期间
交费方式
保险费约定支付日
保险费
/保障计划/份数
/交费期间（续期保险费交费日期）
/交费期满日
每年09月30日
每年3156.00元
畅行万里智赢版
60000.00元
至2068年9月30日零时
年交
两全保险
/10年
/2033年09月30日
一次交清
140.00元
i他男性特定疾病
50000.00元
至2025年09月29日
保险
（大写）叁仟贰佰玖拾陆元整
￥3296.00
首期保险费合计:
特别约定:
本栏空白
  `);

  assert.equal(data.firstPremium, '3296');
  assert.deepEqual(
    data.plans.map((plan) => ({
      role: plan.role,
      name: plan.name,
      amount: plan.amount,
      paymentMode: plan.paymentMode,
      paymentPeriod: plan.paymentPeriod,
      premium: plan.premium,
    })),
    [
      {
        role: 'main',
        name: '畅行万里智赢版两全保险',
        amount: '60000',
        paymentMode: '年交',
        paymentPeriod: '10年交',
        premium: '3156',
      },
      {
        role: 'rider',
        name: 'i他男性特定疾病保险',
        amount: '50000',
        paymentMode: '趸交',
        paymentPeriod: '趸交',
        premium: '140',
      },
    ],
  );
});

test('OCR extraction keeps consent text and linked-account descriptor out of main fields', () => {
  const data = extractPolicyFieldsFromText(`
NCI新华保险
保险单
保险合同号:990163781859
合同成立日期:2024年06月06日
投保人:冯力
合同生效日期:2024年06月07日
被保险入:冯力
证件号码:330106198712072413
身故保险金受益人
证件号码:330106198712072413
被保险入的法定继承人
保险利益表
险种名称
基本保险金额/保险金额
保险期间
交费方式
保险费约定支付日
/交费期间
/交费期满日
保险费
荣耀鑫享赢家版
165020.00元
终身
年交
每年06月07日
每年20000.00元
终身寿险
/10年
/2033年06月07日
金利瑞享终身寿险
终身
一次交清
10.00元
（万能型）
首期保险费合计:（大写）贰万零壹拾元整
￥20010.00
特别约定:
经投保人和被保险人同意，在保单990163781859项下设置万能账户。
  `);

  assert.equal(data.name, '荣耀鑫享赢家版终身寿险');
  assert.equal(data.applicant, '冯力');
  assert.equal(data.insured, '冯力');
  assert.equal(data.beneficiary, '法定');
  assert.equal(data.insuredIdNumber, '330106198712072413');
  assert.equal(data.insuredBirthday, '1987-12-07');
  assert.equal(data.amount, '165020');
  assert.equal(data.firstPremium, '20010');
  assert.equal(data.plans.length, 2);
  assert.equal(data.plans[0].role, 'main');
  assert.equal(data.plans[0].name, '荣耀鑫享赢家版终身寿险');
  assert.equal(data.plans[0].amount, '165020');
  assert.equal(data.plans[0].premium, '20000');
  assert.equal(data.plans[1].role, 'linked_account');
  assert.equal(data.plans[1].name, '金利瑞享终身寿险（万能型）');
  assert.equal(data.plans[1].premium, '10');
});

test('OCR extraction repairs noisy policy number from repeated policy references', () => {
  const data = extractPolicyFieldsFromText(`
NCI新华保险
保险单
保险合同号:090163181859
合同成立日期:2024年06月06日
投保人:冯力
被保险人:冯力
特别约定:
经投保人和被保险人同意，在保单990163781859下《金利瑞享终身寿险（万能型）》合同有效的情况下，保
单990163781859下《金利瑞享终身寿险（万能型）》合同部分领取保单账户价值用于交纳保单990163781859下《
荣耀鑫享赢家版终身寿险》及所附附加险的续期或者续保保险费。
  `);

  assert.equal(data.policyNumber, '990163781859');
});

test('OCR extraction keeps rider single-pay period out of main policy fields', () => {
  const data = extractPolicyFieldsFromText(`
NCI 新华保险
保险单
合同成立日期:2024年09月29日
投保人:冯力
被保险人:冯力
交费方式:一次交清
保险利益表
险种名称
基本保险金额/保险金额
保险期间
交费方式
/交费期间
保险费
畅行万里智赢版
两全保险
60000.00元
至2068年9月30日零时
年交
/10年
每年3156.00元
i他男性特定疾病
保险
50000.00元
至2025年09月29日
一次交清
140.00元
首期保险费合计:
￥3296.00
  `);

  assert.equal(data.name, '畅行万里智赢版两全保险');
  assert.equal(data.paymentPeriod, '10年交');
  assert.equal(data.plans.length, 2);
  assert.equal(data.plans[0].paymentPeriod, '10年交');
  assert.equal(data.plans[1].paymentPeriod, '趸交');
  assert.equal(data.plans[0].premium, '3156');
  assert.equal(data.plans[1].premium, '140');
});

test('OCR extraction keeps inline main/rider order and excludes optional responsibility clauses', () => {
  const data = extractPolicyFieldsFromText(`
公票使用。
伪说明
保险单
No. 021400000044079758
NCI新华保险
币值单位:人民币元
投保人:吴连英
保险合同号:886659772967
被保险人:吴连英
身份证:330106196012261521
身份证:330106196012261521
受益人
证件号码
翟米深
身份证:330106195508141510
受益顺序
合同成立日期:2014年01月28日
性别:女
性别:女
受益份额
100.00%
首期保险费交费日期:2014年01月27日
合同生效日期:2014年01月29日
险种名称:福如东海A款终身寿险（分红型）
保险费:每年5220.00元
保险期间:2014年01月29日零时起至被保险人终身
险种名称:附加安康提前给付重大疾病保险
交费方式:年交交费期间:10年续期保险费交费日期:每年01月29日
保险金额:60000.00元
可选责任的约定:癌症特别关爱金
保险费:每年1620.00元
保险期间:2014年01月29日零时起至被保险人终身
交费方式:年交交费期间:10年
续期保险费交费日期:每年01月29日
保险费合计:（大写）陆仟捌佰肆拾元整
¥6840.00
特别约定:
本栏以下空白
  `);

  assert.equal(data.name, '福如东海A款终身寿险（分红型）');
  assert.equal(data.firstPremium, '6840');
  assert.equal(data.plans.length, 2);
  assert.deepEqual(
    data.plans.map((plan) => ({
      role: plan.role,
      name: plan.name,
      amount: plan.amount,
      coveragePeriod: plan.coveragePeriod,
      paymentMode: plan.paymentMode,
      paymentPeriod: plan.paymentPeriod,
      premium: plan.premium,
    })),
    [
      {
        role: 'main',
        name: '福如东海A款终身寿险（分红型）',
        amount: '',
        coveragePeriod: '终身',
        paymentMode: '',
        paymentPeriod: '',
        premium: '5220',
      },
      {
        role: 'rider',
        name: '附加安康提前给付重大疾病保险',
        amount: '60000',
        coveragePeriod: '终身',
        paymentMode: '年交',
        paymentPeriod: '10年交',
        premium: '1620',
      },
    ],
  );
  assert.ok(!data.plans.some((plan) => /可选责任|基本责任/u.test(plan.name || '')));
});

test('OCR extraction keeps top-level name on main plan when later riders repeat plan labels', () => {
  const data = extractPolicyFieldsFromText(`
保险单
NCI新华保险
投保人:翟卿
被保险人:顾晨妍
保险合同号:886622461458
证件号码
受益人
身份证:
翟宸彬
330106201311261218
受益顺序
身份证:
330106198411101516
翟卿
受益份额
50.00%
50.00%
合同生效日期:2014年01月01日
酸种名称:福如东海A救终具寿险（分红提）
基本保险金额:100000.00元
保险期间:2014年01月01日零时起至被保险人终身
保险费:每年3000.00元
交费方式:年交交费期间:20年续期保险费交费日期:每年01月01日
险种名称:
住院费用医疗保险（2007）
保险金额:
10000.00元
保险费:234.00元
保险期间:2014年01月01日零时起至2014年12月31日二十四时止
交费方式:一次交清
险种名称:附加安康提前给付重大疾病保险
保险金额:100000.00元
保险费:每年1100.00元
保险费合计:（大写）肆仟叁佰叁拾肆元整
可选责任的约定:癌症特别关爱金
保险期间:2014年01月01日零时起至被保险人终身
交费方式:年交交费期间:20年续期保险费交费日期:每年01月01日
￥4334.00
特别约定:
本保险单的险种《福如东海A款终身寿险（分红型）》的效力因发生保险责任、责任免除、合同解除等事项终止时，险种《住院费用医疗保险（2007）》的效力终止。
本保险单的附加险种《附加安康提前给付重大疾病保险》仅为险种《福如东海A款终身寿险（分红型）》的附加险。
  `);

  assert.equal(data.name, '福如东海A救终具寿险（分红提）');
  assert.equal(data.beneficiary, '翟宸彬');
  assert.equal(data.paymentPeriod, '20年交');
  assert.equal(data.coveragePeriod, '终身');
  assert.equal(data.firstPremium, '4334');
  assert.equal(data.fieldEvidence.beneficiary.value, '翟宸彬');
  assert.equal(data.fieldEvidence.paymentPeriod.value, '20年交');
  assert.match(data.fieldEvidence.paymentPeriod.rowText, /交费期间:20年续期/u);
  assert.equal(data.fieldEvidence.coveragePeriod.value, '终身');
  assert.match(data.fieldEvidence.coveragePeriod.rowText, /被保险人终身/u);
  assert.deepEqual(
    data.plans.map((plan) => ({
      role: plan.role,
      name: plan.name,
      amount: plan.amount,
      coveragePeriod: plan.coveragePeriod,
      paymentMode: plan.paymentMode,
      paymentPeriod: plan.paymentPeriod,
      premium: plan.premium,
    })),
    [
      {
        role: 'main',
        name: '福如东海A救终具寿险（分红提）',
        amount: '100000',
        coveragePeriod: '终身',
        paymentMode: '年交',
        paymentPeriod: '20年交',
        premium: '3000',
      },
      {
        role: 'rider',
        name: '住院费用医疗保险（2007）',
        amount: '10000',
        coveragePeriod: '至2014年12月31日',
        paymentMode: '趸交',
        paymentPeriod: '趸交',
        premium: '234',
      },
      {
        role: 'rider',
        name: '附加安康提前给付重大疾病保险',
        amount: '100000',
        coveragePeriod: '终身',
        paymentMode: '年交',
        paymentPeriod: '20年交',
        premium: '1100',
      },
    ],
  );
});

test('OCR extraction keeps receipt product rows as main policy plus rider plans', () => {
  const data = extractPolicyFieldsFromText(`
保险业务收据
NCI新华保险
开具日期:
2024年09月29日
*90030000000030452629*
行业分类:保险业
收款单位:新华人寿保险股份有限公司浙江分公司
投保人名称（付款单位/个人）:冯力
交费日期:2024年09月29日
交费方式:详见各险种显示
保单合同号:990171228067
交费次数:首次
产品名称:畅行万里智赢版两全保险
产品名称:i他男性特定疾病保险
金额 ¥3156.00
金额 ¥140.00
合计（大写）人民币叁仟贰佰玖拾陆元整
服务人员编号:40364278
区部组:杭州收展本级营业区爱立方部陈雅萍1组
¥3296.00
服务人员姓名:温舒萍
⋯•以下内容空白
保险业务
收据专用章
收据说明:
第3页共44页
全国统一客服电话:95567
网址:www.newchinalife.com
  `);

  assert.equal(data.company, '新华保险');
  assert.equal(data.applicant, '冯力');
  assert.equal(data.date, '2024-09-29');
  assert.equal(data.name, '畅行万里智赢版两全保险');
  assert.equal(data.policyNumber, '990171228067');
  assert.equal(data.firstPremium, '3296');
  assert.equal(data.amount, '');
  assert.equal(data.plans.length, 2);
  assert.equal(data.plans[0].role, 'main');
  assert.equal(data.plans[0].name, '畅行万里智赢版两全保险');
  assert.equal(data.plans[0].premium, '3156');
  assert.equal(data.plans[1].role, 'rider');
  assert.equal(data.plans[1].name, 'i他男性特定疾病保险');
  assert.equal(data.plans[1].premium, '140');
});

test('OCR extraction keeps student responsibility-table amounts out of first premium', () => {
  const data = extractPolicyFieldsFromText(`
NCI新华保险
关爱人生每一天
保险单
保险合同号:66240173100401
基本内容
合同成立日期:2024年08月09日
投保人姓名:楼媛媛
被保险人姓名:王俊曦
残疾保险金、意外医疗保险金受益人
被保险人本人
身故保险金受益人
被保险人的法定继承人
合同生效日期:2024年08月16日
保险利益表
险种名称
学生平安意外伤害保险
附加学生平安A款定期寿险
保险责任名称
意外伤害身故和残疾保险金
疾病身故或全残保险金
金额/份数
80000.00元
80000.00元
给付标准
免赔额赔付比例
经社保赔付
未经社保赔付
疾病特定门诊医疗保险金
附加学生平安A1款意外伤害医疗保意外伤害医疗费用保险金
20000.00元
险
保险期间:2024年08月16日零时起至2025年08月15日二十四时止，一年交费方式:一次交清
保险费合计:（大写）贰佰玖拾捌元整
¥298.00
  `);

  assert.equal(data.beneficiary, '法定');
  assert.equal(data.firstPremium, '298');
  assert.equal(data.amount, '80000');
  assert.equal(data.fieldConfidence.beneficiary, 'text-high');
  assert.equal(data.fieldConfidence.firstPremium, 'text-high');
  assert.match(data.fieldEvidence.beneficiary.rowText, /身故保险金.*受益人/u);
  assert.match(data.fieldEvidence.firstPremium.rowText, /保险费合计/u);
  assert.ok(!data.plans.some((plan) => /保险责任名称|金额\/份数|给付标准|免赔额|赔付比例|社保赔付/u.test(plan.name || '')));
  assert.ok(!data.plans.some((plan) => ['80000', '100'].includes(String(plan.premium || ''))));
});

test('OCR normalization keeps explicit first premium ahead of noisy plan premium totals', () => {
  const normalized = normalizeExtractedPolicyFields({
    company: '新华保险',
    name: '学生平安意外伤害保险',
    firstPremium: '298',
    plans: [
      { role: 'main', name: '学生平安意外伤害保险', amount: '80000', premium: '80000' },
      { role: 'rider', name: '金额/份数', amount: '80000', premium: '80000' },
      { role: 'rider', name: '免赔额赔付比例', premium: '100' },
    ],
  });

  assert.equal(normalized.firstPremium, '298');
  assert.equal(normalized.plans.length, 1);
  assert.equal(normalized.plans[0].name, '学生平安意外伤害保险');
});

test('OCR extraction derives insured birthday from the insured identity number', () => {
  const data = extractPolicyFieldsFromText(`
保险单
投保人:张三
证件号码:110101198001012222
被保险人:李四
证件号码:330103199112243456
合同生效日期:2026年01月01日
险种名称:测试终身寿险
基本保险金额:100000元
首期保险费:5000元
  `);

  assert.equal(data.insured, '李四');
  assert.equal(data.insuredIdNumber, '330103199112243456');
  assert.equal(data.insuredBirthday, '1991-12-24');
});

test('OCR extraction reads death beneficiary from New China basic-content table', () => {
  const data = extractPolicyFieldsFromText(`
NCI 新华保险
保险单
基本内容
合同成立日期:2026年03月31日
投保人:温舒萍
被保险人:温舒萍
合同生效日期:2026年04月01日
证件号码:360502198812160922
证件号码:360502198812160922
身故保险金受益人
证件号码
受益顺序
受益份额
被保险人的法定继承人
--
--
--
保险利益表
险种名称
基本保险金额/保险金额/保障计划/份数
保险期间
交费方式
保险费约定支付日/交费期间（续期保险费交费日期）/交费期满日
保险费
盛世荣耀臻享版
终身寿险（分红型）
24441.00元
终身
年交
/10年
每年3000.00元
首期保险费合计:
￥3000.00
  `);

  assert.equal(data.beneficiary, '法定');
  assert.equal(data.date, '2026-04-01');
});

test('OCR extraction recognizes legal beneficiary when inheritance text has OCR mistakes', () => {
  const data = extractPolicyFieldsFromText(`
NCI 新华保险
保险单
基本内容
投保人:温舒萍
被保险人:温舒萍
身故保险金受益人
被保险人的法定继本人
保险利益表
险种名称
多倍保障重大疾病保险（智享版）
60000.00元
终身
年交
/15年
每年3030.00元
  `);

  assert.equal(data.beneficiary, '法定');
});

test('OCR extraction recovers table fields when labels contain OCR mistakes', () => {
  const data = extractPolicyFieldsFromText(`
心I新华保险
保险单
合同
生效日期:2026年04月01日
投保人:张三
被保险人:张三
保险利益表
险种名稼
基本
保险金颔/
保险金颔
保险期问
交费方武
保险费约定支付日
保险费
/保障计划/份数
/
交费期问（续期
保险费交费日期）
/交费期满日
盛世荣耀臻享版
24441.00元
终身
年交
每年04月01日
每年3000.00元
终身寿险（分红型）
/10年
/2035年04月01日
首期
保险费合汁:
￥3000.00
  `);

  assert.equal(data.company, '新华保险');
  assert.equal(data.name, '盛世荣耀臻享版终身寿险（分红型）');
  assert.equal(data.date, '2026-04-01');
  assert.equal(data.coveragePeriod, '终身');
  assert.equal(data.paymentPeriod, '10年交');
  assert.equal(data.amount, '24441');
  assert.equal(data.firstPremium, '3000');
});

test('OCR extraction does not treat policy document titles as insurer names', () => {
  const data = extractPolicyFieldsFromText(`
保险单
合同
保险利益表
险种名称
某某终身寿险
基本保险金额
300000元
保险期间
终身
  `);

  assert.notEqual(data.company, '保险单');
  assert.notEqual(data.company, '合同');
});

test('OCR extraction keeps China Life single-plan OCR as one plan with annual payment period', () => {
  const data = extractPolicyFieldsFromText(`
MAWAWAVAVAV
单证代码:9996
中国日！
/笛证
保险单
本公司根据保险条款和投保人的申请，签发本保险单
保险资料
（个人养老金）
投保人姓名:翟卿
合同成立日期:2024年12月05日
产品首期保费（元）:12000.00
币种:人民币
主险明细
险种名称:国寿鑫颐宝两全保险（2024版）
保单号:2024330133SCW500032558
保单生效日:2024年12月06日
交费方式:年交
每期交费日:每年的12月06日
险种性质:主险
被保险人姓名:翟卿
保单期满日:2044年12月05日
保险期间:至60周岁
交费期满日:2034年12月05日
交费期间:10年
加费（元）
子险种名称
保险金额(元）
标准保费（元）
国寿鑫颐宝两全保险（2024版）
159948.00
12000.00
身故保险金受益人列表
证件号码
被保险人受益顺序
受益人
性别
出生日期
与被保险人关系受益份额
证件名称
特别约定
无
  `);

  assert.equal(data.company, '中国人寿保险');
  assert.equal(data.name, '国寿鑫颐宝两全保险（2024版）');
  assert.equal(data.date, '2024-12-05');
  assert.equal(data.paymentPeriod, '10年交');
  assert.equal(data.coveragePeriod, '至60岁');
  assert.equal(data.amount, '159948');
  assert.equal(data.firstPremium, '12000');
  assert.equal(data.plans.length, 1);
  assert.equal(data.plans[0].role, 'main');
  assert.equal(data.plans[0].name, '国寿鑫颐宝两全保险（2024版）');
  assert.equal(data.plans[0].amount, '159948');
  assert.equal(data.plans[0].premium, '12000');
});

test('OCR extraction keeps China Life multi-section table values after label splitting', () => {
  const data = extractPolicyFieldsFromText(`
保险资料
投保人姓名:陈家明
合同成立日期:2015年12月31日
产品期文保费:100000.00元/年
■主险明细
险种名称:国寿鑫福年年养老年金保险
保单号:201534240053301511974
披保险人姓名:陈家明
保险期间:4年
文费方式:年交
文费期间:5年
子险种名称
保险金额（元）
标准保费（元）
加费（元）
国寿鑫福年年并老年金保险
00192.13
29491.41
险种名称:国寿鑫福年年年金保险
保单号:2015342400534015115980
保险期间:24年
文费方式:年交
文费期间:5年
子险种名称
保险金额（元）
标准保费（元)
加费（元）
国寿鑫招年年年金保险
56621.88
70505.56
险种名称:国寿鑫账户两全保险（万能型）（钻石版）
保单号:2015342423272000380206
保险期问:终身
文费方式:不定期文
文费期间:
子险种名称
保险金额（元）
标准保费（元）
加费（元）
寿鑫账户两全保险（万能型）（钻石版）
10000.00
  `);

  assert.equal(data.company, '中国人寿保险');
  assert.equal(data.name, '国寿鑫福年年养老年金保险');
  assert.equal(data.amount, '192');
  assert.equal(data.firstPremium, '99997');
  assert.deepEqual(
    data.plans.map((plan) => ({
      role: plan.role,
      name: plan.name,
      amount: plan.amount,
      premium: plan.premium,
      paymentPeriod: plan.paymentPeriod,
    })),
    [
      {
        role: 'main',
        name: '国寿鑫福年年养老年金保险',
        amount: '192',
        premium: '29491',
        paymentPeriod: '5年交',
      },
      {
        role: 'rider',
        name: '国寿鑫福年年年金保险',
        amount: '56622',
        premium: '70506',
        paymentPeriod: '5年交',
      },
      {
        role: 'linked_account',
        name: '国寿鑫账户两全保险（万能型）（钻石版）',
        amount: '10000',
        premium: '',
        paymentPeriod: '不定期交',
      },
    ],
  );
});

test('OCR extraction is not tied to Xinhua policy layouts', () => {
  const data = extractPolicyFieldsFromText(`
PING AN 中国平安保险
保险单
合同
生效日期:2026年04月01日
投保人:李四
被保险人:李四
保险利益表
险种名稼
基本
保险金颔/
保险金颔
保险期问
交费方武
保险费约定支付日
保险费
/保障计划/份数
/
交费期问（续期
保险费交费日期）
/交费期满日
平安福
500000.00元
终身
年交
每年04月01日
每年12000.00元
重大疾病保险
/20年
/2045年04月01日
首期
保险费合汁:
￥12000.00
  `);

  assert.equal(data.company, '中国平安保险');
  assert.equal(data.name, '平安福重大疾病保险');
  assert.equal(data.date, '2026-04-01');
  assert.equal(data.coveragePeriod, '终身');
  assert.equal(data.paymentPeriod, '20年交');
  assert.equal(data.amount, '500000');
  assert.equal(data.firstPremium, '12000');
});

test('health endpoint exposes runtime instance metadata for stale client detection', async () => {
  const app = createPolicyOcrApp({
    state: createInitialState(),
    runtimeStartedAt: '2026-06-04T04:00:00.000Z',
    runtimeSessionId: 'dev-runtime-test',
  });
  const server = await listen(app);

  try {
    const { response, payload } = await jsonFetch(server.baseUrl, '/api/health');
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.service, 'policy-ocr-app');
    assert.equal(payload.startedAt, '2026-06-04T04:00:00.000Z');
    assert.equal(payload.sessionId, 'dev-runtime-test');
  } finally {
    await server.close();
  }
});

test('OCR extraction includes all benefit-table plans and matches each plan by insurer knowledge', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      policies: [],
      pendingScans: [],
      sourceRecords: [],
      knowledgeRecords: [
        {
          id: 1,
          company: '新华保险',
          productName: '新华保险盛世恒盈年金保险（分红型）',
          title: '盛世恒盈年金保险（分红型）条款',
          url: 'https://www.newchinalife.com/demo-main.pdf',
          official: true,
        },
        {
          id: 2,
          company: '新华保险',
          productName: '鑫天利卓越版养老年金保险（万能型）',
          title: '鑫天利卓越版养老年金保险（万能型）条款',
          url: 'https://www.newchinalife.com/demo-linked.pdf',
          official: true,
        },
      ],
      officialDomainProfiles: [],
      nextId: 3,
    },
    scanner: async ({ ocrText }) => ({
      ocrText,
      data: extractPolicyFieldsFromText(ocrText),
    }),
    analyzer: async () => ({
      report: '已生成责任。',
      coverageTable: [
        {
          coverageType: '养老年金',
          scenario: '被保险人生存至约定年龄',
          payout: '按合同约定领取',
          note: '以条款为准',
        },
      ],
    }),
  });
  const server = await listen(app);

  try {
    const ocrText = `
NCI 新华保险
保险单
保险合同号:990197554618
合同成立日期:2025年12月22日
合同生效日期:2025年12月23日
投保人:温舒萍
被保险人:温舒萍
保险利益表
险种名称
基本保险金额/保险金额
/保障计划/份数
保险期间
交费方式
/交费期间
保险费约定支付日
/交费期满日
保险费
盛世恒盈年金保险
（分红型）
1465.20元
至2073年12月22日
年交
/10年
每年12月23日
/2034年12月23日
每年11000.00元
鑫天利卓越版养老年金
保险（万能型）
--
终身
一次交清
--
--
10.00元
首期保险费合计:
￥11010.00
特别约定:
在鑫天利卓越版养老年金保险（万能型）合同有效的情况下
    `;

    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-linked-account',
        ocrText,
      }),
    });

    assert.equal(recognized.response.status, 200);
    assert.equal(recognized.payload.scan.data.company, '新华保险');
    assert.equal(recognized.payload.scan.data.name, '新华保险盛世恒盈年金保险（分红型）');
    assert.equal(recognized.payload.scan.data.firstPremium, '11010');
    assert.equal(recognized.payload.scan.data.plans.length, 2);
    assert.equal(recognized.payload.scan.data.plans[0].matchedProductName, '新华保险盛世恒盈年金保险（分红型）');
    assert.equal(recognized.payload.scan.data.plans[1].matchedProductName, '鑫天利卓越版养老年金保险（万能型）');

    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-linked-account',
        ocrText,
        scan: recognized.payload.scan,
        manualData: {
          canonicalProductId: '',
          plans: recognized.payload.scan.data.plans.map((plan) => ({
            ...plan,
            canonicalProductId: '',
          })),
        },
        analysis: {
          report: '已生成责任。',
          coverageTable: [
            {
              coverageType: '养老年金',
              scenario: '被保险人生存至约定年龄',
              payout: '按合同约定领取',
              note: '以条款为准',
            },
          ],
        },
      }),
    });

    assert.equal(saved.response.status, 201);
    assert.equal(saved.payload.policy.name, '新华保险盛世恒盈年金保险（分红型）');
    assert.equal(saved.payload.policy.firstPremium, 11010);
    assert.equal(saved.payload.policy.plans.length, 2);
    assert.equal(saved.payload.policy.plans[0].role, 'main');
    assert.equal(saved.payload.policy.plans[0].matchedProductName, '新华保险盛世恒盈年金保险（分红型）');
    assert.match(saved.payload.policy.canonicalProductId, /^product_[a-f0-9]{16}$/u);
    assert.equal(saved.payload.policy.canonicalProductId, saved.payload.policy.plans[0].canonicalProductId);
    assert.equal(saved.payload.policy.plans[1].role, 'linked_account');
    assert.equal(saved.payload.policy.plans[1].matchedProductName, '鑫天利卓越版养老年金保险（万能型）');
  } finally {
    await server.close();
  }
});

test('visual OCR normalization repairs single fields from benefit-table plans', () => {
  const data = normalizeExtractedPolicyFields({
    company: '新华保险',
    name: '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）',
    applicant: '温舒萍',
    insured: '温舒萍',
    date: '2025-12-22',
    paymentPeriod: '趸交',
    coveragePeriod: '至2073年12月22日',
    amount: '1465',
    firstPremium: '1',
    plans: [
      {
        role: 'main',
        name: '盛世恒盈年金保险（分红型）',
        amount: '1465.20元',
        coveragePeriod: '至2073年12月22日',
        paymentMode: '年交',
        paymentPeriod: '10年交',
        premium: '每年11000.00元',
      },
      {
        role: 'linked_account',
        name: '鑫天利卓越版养老年金保险（万能型）',
        coveragePeriod: '终身',
        paymentMode: '一次交清',
        paymentPeriod: '一次交清',
        premium: '10.00元',
      },
    ],
  });

  assert.equal(data.paymentPeriod, '10年交');
  assert.equal(data.firstPremium, '11010');
  assert.equal(data.plans.length, 2);
  assert.equal(data.plans[1].role, 'linked_account');
});

test('visual OCR normalization rejects field labels as plan names and identity numbers as amounts', () => {
  const data = normalizeExtractedPolicyFields({
    company: '新华保险',
    name: '保障期间:终身',
    applicant: '温舒萍',
    insured: '温舒萍',
    insuredIdNumber: '360502198812160922',
    insuredBirthday: '1988-12-16',
    date: '2026-04-01',
    paymentPeriod: '趸交',
    coveragePeriod: '终身',
    amount: '360502198812160900',
    firstPremium: '3000',
    plans: [
      {
        role: 'rider',
        name: '保障期间:终身',
        amount: '360502198812160900',
        paymentPeriod: '趸交',
        premium: '',
      },
    ],
  });

  assert.equal(data.name, '');
  assert.equal(data.amount, '');
  assert.equal(data.firstPremium, '3000');
  assert.equal(data.plans, undefined);
});

test('visual OCR normalization strips model explanations from person and empty fields', () => {
  const data = normalizeExtractedPolicyFields({
    company: '新华保险',
    name: '荣耀鑫享赢家版终身寿险',
    applicant: '字段明确标注冯力',
    insured: '被保险人字段明确标注为冯力',
    beneficiary: '栏为空',
    insuredIdNumber: '330106198712072413',
    date: '2024-09-29',
  });

  assert.equal(data.applicant, '冯力');
  assert.equal(data.insured, '冯力');
  assert.equal(data.beneficiary, '');
  assert.equal(data.insuredBirthday, '1987-12-07');
});

test('recognize endpoint repairs single-policy fields from visual OCR plans when raw OCR text is empty', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      policies: [],
      pendingScans: [],
      sourceRecords: [],
      knowledgeRecords: [
        {
          id: 1,
          company: '新华保险',
          productName: '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）',
          title: '盛世恒盈年金保险（分红型）条款',
          url: 'https://www.newchinalife.com/demo-main.pdf',
          official: true,
        },
        {
          id: 2,
          company: '新华保险',
          productName: '鑫天利卓越版养老年金保险（万能型）',
          title: '鑫天利卓越版养老年金保险（万能型）条款',
          url: 'https://www.newchinalife.com/demo-linked.pdf',
          official: true,
        },
      ],
      officialDomainProfiles: [],
      nextId: 3,
    },
    scanner: async () => ({
      ocrText: '',
      data: {
        company: '新华保险',
        name: '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）',
        applicant: '温舒萍',
        insured: '温舒萍',
        date: '2025-12-22',
        paymentPeriod: '趸交',
        coveragePeriod: '至2073年12月22日',
        amount: '1465',
        firstPremium: '1',
        plans: [
          {
            company: '新华保险',
            role: 'main',
            name: '盛世恒盈年金保险（分红型）',
            amount: '1465',
            coveragePeriod: '至2073年12月22日',
            paymentMode: '年交',
            paymentPeriod: '10年交',
            premium: '11000',
          },
          {
            company: '新华保险',
            role: 'linked_account',
            name: '鑫天利卓越版养老年金保险（万能型）',
            coveragePeriod: '终身',
            paymentMode: '趸交',
            paymentPeriod: '趸交',
            premium: '10',
          },
        ],
      },
    }),
  });
  const server = await listen(app);

  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-visual-plans',
        uploadItem: {
          name: 'policy.jpg',
          type: 'image/jpeg',
          size: 12,
          dataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
        },
      }),
    });

    assert.equal(recognized.response.status, 200);
    assert.equal(recognized.payload.scan.data.name, '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）');
    assert.equal(recognized.payload.scan.data.paymentPeriod, '10年交');
    assert.equal(recognized.payload.scan.data.firstPremium, '11010');
    assert.equal(recognized.payload.scan.data.plans.length, 2);
    assert.equal(recognized.payload.scan.data.plans[0].matchedProductName, '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）');
    assert.equal(recognized.payload.scan.data.plans[1].matchedProductName, '鑫天利卓越版养老年金保险（万能型）');
  } finally {
    await server.close();
  }
});

test('recognize endpoint keeps OCR plan details when current form sends an empty plan list', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      policies: [],
      pendingScans: [],
      sourceRecords: [],
      knowledgeRecords: [
        {
          id: 1,
          company: '新华保险',
          productName: '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）',
          title: '盛世恒盈年金保险（分红型）条款',
          url: 'https://www.newchinalife.com/demo-main.pdf',
          official: true,
        },
        {
          id: 2,
          company: '新华保险',
          productName: '鑫天利卓越版养老年金保险（万能型）',
          title: '鑫天利卓越版养老年金保险（万能型）条款',
          url: 'https://www.newchinalife.com/demo-linked.pdf',
          official: true,
        },
      ],
      officialDomainProfiles: [],
      nextId: 3,
    },
    scanner: async () => ({
      ocrText: '',
      data: {
        company: '新华保险',
        name: '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）',
        applicant: '温舒萍',
        insured: '温舒萍',
        date: '2025-12-22',
        paymentPeriod: '趸交',
        coveragePeriod: '至2073年12月22日',
        amount: '1465',
        firstPremium: '1',
        plans: [
          {
            company: '新华保险',
            role: 'main',
            name: '盛世恒盈年金保险（分红型）',
            amount: '1465',
            coveragePeriod: '至2073年12月22日',
            paymentMode: '年交',
            paymentPeriod: '10年交',
            premium: '11000',
          },
          {
            company: '新华保险',
            role: 'linked_account',
            name: '鑫天利卓越版养老年金保险（万能型）',
            coveragePeriod: '终身',
            paymentMode: '趸交',
            paymentPeriod: '趸交',
            premium: '10',
          },
        ],
      },
    }),
  });
  const server = await listen(app);

  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-empty-form-plans',
        uploadItem: {
          name: 'policy.jpg',
          type: 'image/jpeg',
          size: 12,
          dataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
        },
        manualData: {
          company: '',
          name: '',
          applicant: '',
          insured: '',
          date: '',
          paymentPeriod: '',
          coveragePeriod: '',
          amount: '',
          firstPremium: '',
          plans: [],
        },
      }),
    });

    assert.equal(recognized.response.status, 200);
    assert.equal(recognized.payload.scan.data.paymentPeriod, '10年交');
    assert.equal(recognized.payload.scan.data.firstPremium, '11010');
    assert.equal(recognized.payload.scan.data.plans.length, 2);
    assert.equal(recognized.payload.scan.data.plans[1].matchedProductName, '鑫天利卓越版养老年金保险（万能型）');
  } finally {
    await server.close();
  }
});

test('policy recognize response preserves OCR review warnings from scanner', async () => {
  const calls = [];
  const app = createPolicyOcrApp({
    scanner: async (input) => {
      calls.push(input);
      return {
        ok: true,
        ocrText: [
          '投保人 张三',
          '被保险人 李四',
          '保险利益表',
          '附加投保人豁免保险 至2026年12月23日',
        ].join('\n'),
        data: {
          company: '新华保险',
          name: '附加投保人豁免保险',
          applicant: '附加投保人豁免保险',
          insured: '李四',
          date: '2026-12-23',
        },
        fieldConfidence: {
          applicant: 'high',
          insured: 'high',
          date: 'high',
        },
        fieldEvidence: {
          applicant: {
            value: '附加投保人豁免保险',
            labelText: '投保人',
            rowText: '保险利益表 附加投保人豁免保险 至2026年12月23日',
            relation: 'right',
            region: 'rider-table',
          },
        },
        ocrWarnings: ['检测到附加险区域，基础字段已限制为从基本信息区读取'],
      };
    },
  });
  const server = await listen(app);

  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest_layout',
        ocrText: '投保人 张三\n被保险人 李四',
        uploadItem: null,
        manualData: {},
      }),
    });

    assert.equal(recognized.response.status, 200);
    assert.equal(recognized.payload.scan.data.applicant, '附加投保人豁免保险');
    assert.equal(recognized.payload.scan.fieldConfidence.applicant, 'high');
    assert.equal(recognized.payload.scan.fieldEvidence.applicant.relation, 'right');
    assert.match(recognized.payload.scan.fieldEvidence.applicant.rowText, /附加投保人豁免保险/u);
    assert.ok(recognized.payload.scan.ocrWarnings.some((warning) => warning.includes('附加险')));
    assert.equal(calls.length, 1);
  } finally {
    await server.close();
  }
});

test('scan endpoint does not append stale OCR rider plans after manual deletion', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      policies: [],
      pendingScans: [],
      sourceRecords: [],
      knowledgeRecords: [],
      officialDomainProfiles: [],
      nextId: 1,
    },
  });
  const server = await listen(app);

  try {
    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-manual-plan-delete',
        scan: {
          ocrText: '中国人寿 国寿鑫颐宝两全保险（2024版）',
          data: {
            company: '中国人寿',
            name: '国寿鑫颐宝两全保险（2024版）',
            applicant: '翟卿',
            insured: '翟卿',
            date: '2024-12-05',
            paymentPeriod: '10年交',
            coveragePeriod: '至60岁',
            amount: '159948',
            firstPremium: '12000',
            plans: [
              {
                company: '中国人寿',
                role: 'main',
                name: '国寿鑫颐宝两全保险（2024版）',
                amount: '159948',
                coveragePeriod: '',
                paymentPeriod: '',
                premium: '12000',
              },
              {
                company: '中国人寿',
                role: 'rider',
                name: '保单生效日:2024年12月06日',
                premium: '0',
              },
              {
                company: '中国人寿',
                role: 'rider',
                name: '每期交费日:每年的12月06日',
                premium: '0',
              },
            ],
          },
        },
        manualData: {
          company: '中国人寿',
          name: '国寿鑫颐宝两全保险（2024版）',
          applicant: '翟卿',
          insured: '翟卿',
          date: '2024-12-05',
          paymentPeriod: '10年交',
          coveragePeriod: '至60岁',
          amount: '159948',
          firstPremium: '12000',
          plans: [
            {
              company: '中国人寿',
              role: 'main',
              name: '国寿鑫颐宝两全保险（2024版）',
              amount: '159948',
              coveragePeriod: '',
              paymentPeriod: '',
              premium: '12000',
            },
          ],
        },
      }),
    });

    assert.equal(saved.response.status, 201);
    assert.equal(saved.payload.policy.plans.length, 1);
    assert.equal(saved.payload.policy.plans[0].name, '国寿鑫颐宝两全保险（2024版）');
    assert.equal(saved.payload.policy.paymentPeriod, '10年交');
  } finally {
    await server.close();
  }
});

test('recognize endpoint does not let stale manual form fields overwrite a new OCR result', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      policies: [],
      pendingScans: [],
      sourceRecords: [],
      knowledgeRecords: [],
      officialDomainProfiles: [],
      nextId: 1,
    },
    scanner: async () => ({
      ocrText: 'NCI 新华保险 畅行万里智赢版两全保险 冯力 60000 10年交',
      data: {
        company: '新华保险',
        name: '畅行万里智赢版两全保险',
        applicant: '冯力',
        insured: '冯力',
        date: '2024-09-29',
        paymentPeriod: '10年交',
        coveragePeriod: '至2068年9月30日零时',
        amount: '60000',
        firstPremium: '3296',
        plans: [
          {
            company: '新华保险',
            role: 'main',
            name: '畅行万里智赢版两全保险',
            amount: '60000',
            coveragePeriod: '至2068年9月30日零时',
            paymentMode: '年交',
            paymentPeriod: '10年交',
            premium: '3156',
          },
        ],
      },
    }),
  });
  const server = await listen(app);

  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-stale-manual-form',
        uploadItem: {
          name: 'new-policy.jpg',
          type: 'image/jpeg',
          size: 12,
          dataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
        },
        manualData: {
          company: '中国平安保险',
          name: '上一张旧保单',
          applicant: '旧投保人',
          insured: '旧被保人',
          date: '2020-01-01',
          paymentPeriod: '趸交',
          coveragePeriod: '终身',
          amount: '1',
          firstPremium: '1',
        },
      }),
    });

    assert.equal(recognized.response.status, 200);
    assert.equal(recognized.payload.scan.data.company, '新华保险');
    assert.equal(recognized.payload.scan.data.name, '畅行万里智赢版两全保险');
    assert.equal(recognized.payload.scan.data.applicant, '冯力');
    assert.equal(recognized.payload.scan.data.insured, '冯力');
    assert.equal(recognized.payload.scan.data.paymentPeriod, '10年交');
    assert.equal(recognized.payload.scan.data.amount, '60000');
    assert.equal(recognized.payload.scan.data.firstPremium, '3296');
  } finally {
    await server.close();
  }
});

test('scan response filters metadata-like rider rows from saved China Life policy plans', async () => {
  const app = createPolicyOcrApp({
    state: createInitialState(),
  });
  const server = await listen(app);

  try {
    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-filter-metadata-riders',
        scan: {
          ocrText: '中国人寿 国寿鑫颐宝两全保险（2024版）',
          data: {
            company: '中国人寿',
            name: '国寿鑫颐宝两全保险（2024版）',
            applicant: '翟卿',
            insured: '翟卿',
            date: '2024-12-05',
            paymentPeriod: '10年交',
            coveragePeriod: '至60岁',
            amount: '159948',
            firstPremium: '12000',
            plans: [
              {
                company: '中国人寿',
                role: 'main',
                name: '国寿鑫颐宝两全保险（2024版）',
                amount: '159948',
                premium: '12000',
              },
              {
                company: '中国人寿',
                role: 'rider',
                name: '保单生效日:2024年12月06日',
                premium: '0',
              },
              {
                company: '中国人寿',
                role: 'rider',
                name: '险种性质:主险',
                premium: '0',
              },
              {
                company: '中国人寿',
                role: 'rider',
                name: '标准保费（元）国寿鑫颐宝两全保险（2024版）',
                amount: '159948',
                premium: '12000',
              },
            ],
          },
        },
        manualData: {
          company: '中国人寿',
          name: '国寿鑫颐宝两全保险（2024版）',
          applicant: '翟卿',
          insured: '翟卿',
          date: '2024-12-05',
          paymentPeriod: '10年交',
          coveragePeriod: '至60岁',
          amount: '159948',
          firstPremium: '12000',
          plans: [
            {
              company: '中国人寿',
              role: 'main',
              name: '国寿鑫颐宝两全保险（2024版）',
              amount: '159948',
              premium: '12000',
            },
            {
              company: '中国人寿',
              role: 'rider',
              name: '保单生效日:2024年12月06日',
              premium: '0',
            },
          ],
        },
      }),
    });

    assert.equal(saved.response.status, 201);
    assert.equal(saved.payload.policy.plans.length, 1);
    assert.equal(saved.payload.policy.plans[0].name, '国寿鑫颐宝两全保险（2024版）');

    const listed = await jsonFetch(server.baseUrl, '/api/policies?guestId=guest-filter-metadata-riders');

    assert.equal(listed.response.status, 200);
    assert.equal(listed.payload.policies[0].plans.length, 1);
    assert.equal(listed.payload.policies[0].plans[0].name, '国寿鑫颐宝两全保险（2024版）');
  } finally {
    await server.close();
  }
});

test('recognize endpoint ignores stale OCR text when a new upload item is provided', async () => {
  const scannerInputs = [];
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      policies: [],
      pendingScans: [],
      sourceRecords: [],
      knowledgeRecords: [],
      officialDomainProfiles: [],
      nextId: 1,
    },
    scanner: async ({ uploadItem, ocrText }) => {
      scannerInputs.push({
        uploadName: uploadItem?.name || '',
        ocrText,
      });
      return {
        ocrText: 'NCI 新华保险 第二张新保单',
        data: {
          company: '新华保险',
          name: '第二张新保单',
          applicant: '新投保人',
          insured: '新被保人',
        },
      };
    },
  });
  const server = await listen(app);

  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-stale-ocr-text',
        ocrText: '中国平安保险 第一张旧保单 旧投保人 旧被保人',
        uploadItem: {
          name: 'second-policy.jpg',
          type: 'image/jpeg',
          size: 12,
          dataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
        },
      }),
    });

    assert.equal(recognized.response.status, 200);
    assert.deepEqual(scannerInputs, [
      {
        uploadName: 'second-policy.jpg',
        ocrText: '',
      },
    ]);
    assert.equal(recognized.payload.scan.data.name, '第二张新保单');
  } finally {
    await server.close();
  }
});

test('sms verification accepts codes copied with spaces or full-width digits', () => {
  const state = {
    smsCodes: [
      {
        mobile: '13800000000',
        code: '123456',
        used: false,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
  };

  assert.equal(latestValidSmsCode(state, { mobile: '13800000000', code: '123 456' })?.code, '123456');
  assert.equal(latestValidSmsCode(state, { mobile: '13800000000', code: '１２３４５６' })?.code, '123456');
});

test('guest can scan once without registering and must verify phone before the second policy', async () => {
  const scannedTexts = [];
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [],
      nextId: 1,
    },
    scanner: async ({ ocrText }) => {
      scannedTexts.push(ocrText);
      return {
        ocrText,
        data: {
          company: '新华保险',
          name: '多倍保障重大疾病保险',
          applicant: '张三',
          insured: '张三',
          date: '2026-05-12',
          paymentPeriod: '20年交',
          coveragePeriod: '终身',
          amount: '500000',
          firstPremium: '12000',
        },
      };
    },
    analyzer: async () => ({
      report: '这是一份重疾保障保单。',
      coverageTable: [
        {
          coverageType: '重大疾病保险金',
          scenario: '确诊合同约定重大疾病',
          payout: '给付基本保险金额50万元',
          note: '给付后该项责任终止',
        },
      ],
    }),
    codeGenerator: () => '135790',
  });
  const server = await listen(app);

  try {
    const first = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-a',
        ocrText: '新华保险 多倍保障重大疾病保险 重大疾病保险金 50万元',
      }),
    });
    assert.equal(first.response.status, 201);
    assert.equal(first.payload.policy.company, '新华保险');
    assert.equal(first.payload.policy.reportStatus, 'generating');
    assert.equal(first.payload.registrationRequiredNext, true);

    const second = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-a',
        ocrText: '第二张保单',
      }),
    });
    assert.equal(second.response.status, 401);
    assert.equal(second.payload.code, 'REGISTRATION_REQUIRED');
    assert.equal(second.payload.registrationRequiredNext, true);

    const code = await jsonFetch(server.baseUrl, '/api/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ mobile: '13800000000' }),
    });
    assert.equal(code.response.status, 200);
    assert.equal(code.payload.devCode, '135790');

    const registered = await jsonFetch(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        mobile: '13800000000',
        code: '135790',
        guestId: 'guest-a',
      }),
    });
    assert.equal(registered.response.status, 200);
    assert.equal(registered.payload.migratedPolicyCount, 1);
    assert.ok(registered.payload.token);

    const auth = { authorization: `Bearer ${registered.payload.token}` };
    const list = await jsonFetch(server.baseUrl, '/api/policies', { headers: auth });
    assert.equal(list.response.status, 200);
    assert.equal(list.payload.policies.length, 1);
    assert.ok(list.payload.policies.some((policy) => policy.name === '多倍保障重大疾病保险'));

    await waitUntil(() => {
      const policy = app.locals.state.policies.find((row) => Number(row.id) === Number(list.payload.policies[0].id));
      assert.equal(policy.reportStatus, 'ready');
      assert.equal(policy.responsibilities[0].coverageType, '重大疾病保险金');
    });

    const detail = await jsonFetch(server.baseUrl, `/api/policies/${list.payload.policies[0].id}`, { headers: auth });
    assert.equal(detail.response.status, 200);
    assert.equal(detail.payload.policy.ocrText, '新华保险 多倍保障重大疾病保险 重大疾病保险金 50万元');
    assert.equal(detail.payload.policy.responsibilities[0].payout, '给付基本保险金额50万元');

    const third = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        ocrText: '登录后第二张保单',
        manualData: {
          company: '平安人寿',
          name: '平安福',
          insured: '李四',
          amount: '800000',
        },
      }),
    });
    assert.equal(third.response.status, 201);
    assert.equal(third.payload.policy.company, '平安人寿');
    assert.equal(third.payload.policy.insured, '李四');
    assert.equal(third.payload.policy.amount, 800000);
    assert.equal(scannedTexts.length, 2);
  } finally {
    await server.close();
  }
});

test('existing mobile verification reuses original account and migrates guest policy', async () => {
  const state = {
    users: [],
    sessions: [],
    smsCodes: [],
    policies: [],
    pendingScans: [],
    nextId: 1,
  };
  const app = createPolicyOcrApp({
    state,
    scanner: async ({ ocrText }) => ({
      ocrText,
      data: {
        company: '新华保险',
        name: '盛世荣耀臻享版终身寿险',
        applicant: '王五',
        insured: '王五',
        date: '2026-05-14',
        paymentPeriod: '10年交',
        coveragePeriod: '终身',
        amount: '24441',
        firstPremium: '3000',
      },
    }),
    analyzer: async () => ({
      report: '终身寿险责任解析。',
      coverageTable: [
        {
          coverageType: '身故或身体全残保险金',
          scenario: '发生合同约定身故或全残',
          payout: '按合同约定给付',
          note: '',
        },
      ],
    }),
    codeGenerator: () => '246810',
  });
  const server = await listen(app);

  try {
    await jsonFetch(server.baseUrl, '/api/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ mobile: '13900000000' }),
    });
    const firstLogin = await jsonFetch(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        mobile: '13900000000',
        code: '246810',
        guestId: 'first-login',
      }),
    });
    assert.equal(firstLogin.response.status, 200);
    assert.equal(state.users.length, 1);
    const originalUserId = firstLogin.payload.user.id;

    const guestPolicy = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-existing-mobile',
        ocrText: '新华保险 盛世荣耀臻享版终身寿险 终身 10年交',
      }),
    });
    assert.equal(guestPolicy.response.status, 201);
    assert.equal(guestPolicy.payload.policy.guestId, 'guest-existing-mobile');
    assert.equal(guestPolicy.payload.policy.userId, null);

    await jsonFetch(server.baseUrl, '/api/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ mobile: '13900000000' }),
    });
    const verifiedAgain = await jsonFetch(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        mobile: '13900000000',
        code: '246810',
        guestId: 'guest-existing-mobile',
      }),
    });

    assert.equal(verifiedAgain.response.status, 200);
    assert.equal(verifiedAgain.payload.user.id, originalUserId);
    assert.equal(verifiedAgain.payload.migratedPolicyCount, 1);
    assert.equal(state.users.length, 1);
    assert.equal(state.policies[0].userId, originalUserId);
    assert.equal(state.policies[0].guestId, '');

    const list = await jsonFetch(server.baseUrl, '/api/policies', {
      headers: { authorization: `Bearer ${verifiedAgain.payload.token}` },
    });
    assert.equal(list.response.status, 200);
    assert.equal(list.payload.policies.length, 1);
    assert.equal(list.payload.policies[0].name, '盛世荣耀臻享版终身寿险');
  } finally {
    await server.close();
  }
});

test('customer logout invalidates the active session token', async () => {
  const state = {
    users: [
      {
        id: 1,
        mobile: '13800000000',
        createdAt: '2026-05-15T00:00:00.000Z',
      },
    ],
    sessions: [
      {
        token: 'customer-token-a',
        userId: 1,
        createdAt: '2026-05-15T00:00:00.000Z',
      },
    ],
    smsCodes: [],
    policies: [
      {
        id: 2,
        userId: 1,
        guestId: '',
        company: '中国平安保险',
        name: '平安福重大疾病保险',
        applicant: '张三',
        insured: '张三',
        date: '2026-05-15',
        paymentPeriod: '20年交',
        coveragePeriod: '终身',
        amount: 500000,
        firstPremium: 12000,
        ocrText: '',
        responsibilities: [],
        report: '',
        reportStatus: 'ready',
        reportError: '',
        createdAt: '2026-05-15T00:00:00.000Z',
        updatedAt: '2026-05-15T00:00:00.000Z',
      },
    ],
    pendingScans: [],
    nextId: 3,
  };
  const app = createPolicyOcrApp({ state });
  const server = await listen(app);

  try {
    const auth = { authorization: 'Bearer customer-token-a' };
    const beforeLogout = await jsonFetch(server.baseUrl, '/api/policies', { headers: auth });
    assert.equal(beforeLogout.response.status, 200);
    assert.equal(beforeLogout.payload.policies.length, 1);

    const loggedOut = await jsonFetch(server.baseUrl, '/api/auth/logout', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
    });
    assert.equal(loggedOut.response.status, 200);
    assert.equal(loggedOut.payload.ok, true);
    assert.equal(state.sessions.length, 0);

    const afterLogout = await jsonFetch(server.baseUrl, '/api/policies', { headers: auth });
    assert.equal(afterLogout.response.status, 401);
    assert.equal(afterLogout.payload.code, 'UNAUTHORIZED');
  } finally {
    await server.close();
  }
});

test('register returns a readable message when sms code is wrong', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [
        {
          id: 1,
          mobile: '13800000000',
          code: '123456',
          deliveryMode: 'real',
          provider: 'aliyun',
          simulated: false,
          used: false,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      policies: [],
      pendingScans: [],
      nextId: 2,
    },
  });
  const server = await listen(app);

  try {
    const registered = await jsonFetch(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        mobile: '13800000000',
        code: '000000',
        guestId: 'guest-wrong-code',
      }),
    });

    assert.equal(registered.response.status, 400);
    assert.equal(registered.payload.code, 'INVALID_CODE');
    assert.match(registered.payload.message, /验证码/);
    assert.notEqual(registered.payload.message, 'INVALID_CODE');
  } finally {
    await server.close();
  }
});

test('recognize endpoint scans without saving and default runtime calls local OCR service', async () => {
  const scannedTexts = [];
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [],
      nextId: 1,
    },
    scanner: async ({ ocrText }) => {
      scannedTexts.push(ocrText);
      return {
        ocrText,
        data: {
          company: '新华保险',
          name: '多倍保障重大疾病保险',
          paymentPeriod: '20年交',
          coveragePeriod: '终身',
          amount: '300000',
        },
      };
    },
    analyzer: async ({ scan }) => ({
      report: `${scan.data.name} 已识别`,
      coverageTable: [
        {
          coverageType: '重大疾病保险金',
          scenario: '确诊合同约定重大疾病',
          payout: '给付基本保险金额30万元',
          note: '',
        },
      ],
    }),
  });
  const server = await listen(app);

  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-recognize',
        ocrText: '新华保险 多倍保障重大疾病保险 基本保险金额30万',
      }),
    });
    assert.equal(recognized.response.status, 200);
    assert.equal(recognized.payload.scan.data.company, '新华保险');
    assert.equal(recognized.payload.analysis, undefined);

    const listBeforeSave = await jsonFetch(server.baseUrl, '/api/policies', {});
    assert.equal(listBeforeSave.response.status, 401);
    assert.equal(scannedTexts.length, 1);
  } finally {
    await server.close();
  }

  const calls = [];
  const scan = await scanPolicyWithConfiguredRuntime(
    {
      uploadItem: { name: 'policy.png', type: 'image/png', size: 100, dataUrl: 'data:image/png;base64,AA==' },
      ocrText: '',
    },
    async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          ocrText: '新华保险 多倍保障重大疾病保险 基本保险金额30万',
          data: {
            company: '新华保险',
            name: '多倍保障重大疾病保险',
            amount: '',
          },
        }),
      };
    },
    {},
  );

  assert.equal(calls[0].url, 'http://127.0.0.1:4105/internal/ocr/policies/scan');
  assert.equal(JSON.parse(calls[0].options.body).uploadItem.name, 'policy.png');
  assert.equal(scan.data.company, '新华保险');
  assert.equal(scan.data.amount, 300000);
});

test('recognize endpoint maps OCR text through known insurer and product keywords', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [],
      knowledgeRecords: [
        {
          id: 1,
          company: '中国平安',
          productName: '平安福重大疾病保险',
          title: '平安福重大疾病保险产品条款',
          url: 'https://life.pingan.example/pinganfu.pdf',
          pageText: '保险责任包括重大疾病保险金。',
          official: true,
        },
        {
          id: 2,
          company: '中国太平',
          productName: '太平福重大疾病保险',
          title: '太平福重大疾病保险产品条款',
          url: 'https://life.taiping.example/taipingfu.pdf',
          pageText: '保险责任包括重大疾病保险金。',
          official: true,
        },
      ],
      nextId: 3,
    },
    scanner: async ({ ocrText }) => ({
      ocrText,
      data: {
        company: '保险单',
        name: '',
        paymentPeriod: '',
        coveragePeriod: '',
        amount: '',
      },
    }),
  });
  const server = await listen(app);

  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-ocr-keyword-map',
        ocrText: 'PING AN 中国平安 保单信息 平安福重大疾病保险 基本保险金额50万 20年交 保障期间终身',
      }),
    });
    assert.equal(recognized.response.status, 200);
    assert.equal(recognized.payload.scan.data.company, '中国平安');
    assert.equal(recognized.payload.scan.data.name, '平安福重大疾病保险');
    assert.equal(recognized.payload.scan.data.paymentPeriod, '20年交');
    assert.equal(recognized.payload.scan.data.coveragePeriod, '终身');
  } finally {
    await server.close();
  }
});

test('recognize endpoint derives insured birthday from OCR identity number after mapping', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [],
      knowledgeRecords: [
        {
          id: 1,
          company: '新华保险',
          productName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
          title: '畅行万里智赢版两全保险产品条款',
          url: 'https://newchinalife.example/policy.pdf',
          pageText: '保险责任包括交通意外保障。',
          official: true,
        },
      ],
      nextId: 2,
    },
    scanner: async ({ ocrText }) => ({
      ocrText,
      data: {
        company: '新华保险',
        name: '畅行万里智赢版两全保险',
        applicant: '冯力',
        insured: '冯力',
        insuredIdNumber: '',
        insuredBirthday: '',
        paymentPeriod: '10年交',
        coveragePeriod: '至2068年9月30日零时',
        amount: '60000',
        firstPremium: '3296',
      },
    }),
  });
  const server = await listen(app);

  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-ocr-insured-birthday-map',
        ocrText: [
          'NCI 新华保险',
          '保险单',
          '投保人：冯力',
          '证件号码：330106198712072413',
          '被保险人：冯力',
          '证件号码：330106198712072413',
          '保险利益表',
          '险种名称',
          '畅行万里智赢版 两全保险',
          '交费方式 年交 /10年',
        ].join('\n'),
      }),
    });

    assert.equal(recognized.response.status, 200);
    assert.equal(recognized.payload.scan.data.insured, '冯力');
    assert.equal(recognized.payload.scan.data.insuredIdNumber, '330106198712072413');
    assert.equal(recognized.payload.scan.data.insuredBirthday, '1987-12-07');
  } finally {
    await server.close();
  }
});

test('analysis report can be generated before save and reused without duplicate OCR or parsing', async () => {
  let scannerCalls = 0;
  let analyzerCalls = 0;
  const state = {
    users: [],
    sessions: [],
    smsCodes: [],
    policies: [],
    pendingScans: [],
    nextId: 1,
  };
  const app = createPolicyOcrApp({
    state,
    scanner: async ({ ocrText }) => {
      scannerCalls += 1;
      return {
        ocrText,
        data: {
          company: '中国平安保险',
          name: '平安福重大疾病保险',
          applicant: '李四',
          insured: '李四',
          date: '2026-05-14',
          paymentPeriod: '20年交',
          coveragePeriod: '终身',
          amount: '500000',
          firstPremium: '12000',
        },
      };
    },
    analyzer: async ({ scan }) => {
      analyzerCalls += 1;
      return {
        report: `${scan.data.name} 解析报告`,
        coverageTable: [
          {
            coverageType: '重大疾病保险金',
            scenario: '确诊合同约定重大疾病',
            payout: '给付基本保险金额50万元',
            note: '保存时应复用这份解析结果',
          },
        ],
      };
    },
  });
  const server = await listen(app);

  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-analysis-draft',
        ocrText: '中国平安保险 平安福重大疾病保险 基本保险金额50万',
      }),
    });
    assert.equal(recognized.response.status, 200);
    assert.equal(scannerCalls, 1);
    assert.equal(analyzerCalls, 0);

    const analyzed = await jsonFetch(server.baseUrl, '/api/policies/analyze', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-analysis-draft',
        scan: recognized.payload.scan,
        manualData: {
          insured: '李四',
        },
      }),
    });
    assert.equal(analyzed.response.status, 200);
    assert.equal(scannerCalls, 1);
    assert.equal(analyzerCalls, 1);
    assert.equal(state.policies.length, 0);
    assert.equal(analyzed.payload.analysis.report, '平安福重大疾病保险 解析报告');

    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-analysis-draft',
        scan: analyzed.payload.scan,
        analysis: analyzed.payload.analysis,
      }),
    });
    assert.equal(saved.response.status, 201);
    assert.equal(scannerCalls, 1);
    assert.equal(analyzerCalls, 1);
    assert.equal(saved.payload.policy.report, '平安福重大疾病保险 解析报告');
    assert.equal(saved.payload.policy.responsibilities[0].note, '保存时应复用这份解析结果');
  } finally {
    await server.close();
  }
});

test('recognize stores raw upload metadata for later OCR failure diagnosis', async () => {
  const state = createInitialState();
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async ({ uploadItem, ocrText }) => ({
      ocrText: ocrText || '新华保险 原始OCR文本',
      data: {
        company: '新华保险',
        name: uploadItem?.name || '待识别保单',
        insured: '李四',
      },
    }),
  });
  const server = await listen(app);

  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-raw-upload',
        ocrText: '上传前的OCR报告文本',
        uploadItem: {
          name: 'policy-report.pdf',
          type: 'application/pdf',
          size: 2048,
          dataUrl: 'data:application/pdf;base64,JVBERi0x',
        },
      }),
    });

    assert.equal(recognized.response.status, 200);
    assert.equal(state.pendingScans.length, 1);
    assert.deepEqual(state.pendingScans[0].rawUpload, {
      ocrText: '上传前的OCR报告文本',
      uploadItem: {
        name: 'policy-report.pdf',
        type: 'application/pdf',
        size: 2048,
        hasDataUrl: true,
      },
      hasProvidedScan: false,
      hasProvidedAnalysis: false,
    });
  } finally {
    await server.close();
  }
});

test('recognize stores authenticated scan diagnostics without saving a policy', async () => {
  const state = createInitialState();
  state.users.push({ id: 1, mobile: '13800000000', createdAt: '2026-05-01T00:00:00.000Z' });
  state.sessions.push({ token: 'user-token', userId: 1, createdAt: '2026-05-01T00:01:00.000Z' });
  let persistCalls = 0;
  const app = createPolicyOcrApp({
    state,
    persist: async () => {
      persistCalls += 1;
    },
    scanner: async ({ uploadItem, ocrText }) => ({
      ocrText: ocrText || '新华保险 登录用户识别文本',
      data: {
        company: '新华保险',
        name: uploadItem?.name || '待识别保单',
        applicant: '张三',
        insured: '李四',
      },
    }),
  });
  const server = await listen(app);

  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      headers: { authorization: 'Bearer user-token' },
      body: JSON.stringify({
        uploadItem: {
          name: 'auth-policy.jpg',
          type: 'image/jpeg',
          size: 4096,
          dataUrl: 'data:image/jpeg;base64,QQ==',
        },
      }),
    });

    assert.equal(recognized.response.status, 200);
    assert.equal(state.policies.length, 0);
    assert.equal(state.pendingScans.length, 1);
    assert.equal(state.pendingScans[0].guestId, 'user:1:recognize');
    assert.equal(state.pendingScans[0].scan.data.name, 'auth-policy.jpg');
    assert.deepEqual(state.pendingScans[0].rawUpload, {
      ocrText: '',
      uploadItem: {
        name: 'auth-policy.jpg',
        type: 'image/jpeg',
        size: 4096,
        hasDataUrl: true,
      },
      hasProvidedScan: false,
      hasProvidedAnalysis: false,
    });
    assert.equal(persistCalls, 2);
  } finally {
    await server.close();
  }
});

test('recognize stores pending scan diagnostics through incremental persistence when available', async () => {
  const state = createInitialState();
  let fullPersistCalls = 0;
  const pendingPersistKeys = [];
  const app = createPolicyOcrApp({
    state,
    persist: async () => {
      fullPersistCalls += 1;
    },
    persistPendingScan: async ({ guestId }) => {
      pendingPersistKeys.push(guestId);
    },
    scanner: async ({ uploadItem, ocrText }) => ({
      ocrText: ocrText || '新华保险 增量识别文本',
      data: {
        company: '新华保险',
        name: uploadItem?.name || '待识别保单',
        applicant: '张三',
        insured: '李四',
      },
    }),
  });
  const server = await listen(app);

  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-fast-recognize',
        uploadItem: {
          name: 'fast-policy.jpg',
          type: 'image/jpeg',
          size: 4096,
          dataUrl: 'data:image/jpeg;base64,QQ==',
        },
      }),
    });

    assert.equal(recognized.response.status, 200);
    assert.equal(fullPersistCalls, 0);
    assert.deepEqual(pendingPersistKeys, ['guest-fast-recognize', 'guest-fast-recognize']);
    assert.equal(state.pendingScans.length, 1);
    assert.equal(state.pendingScans[0].scan.data.name, 'fast-policy.jpg');
  } finally {
    await server.close();
  }
});

test('recognize passes local insurance terminology context into the scanner', async () => {
  const state = createInitialState();
  state.knowledgeRecords.push(
    {
      id: 1,
      company: '新华保险',
      productName: '新华人寿保险股份有限公司盛世荣耀臻享版终身寿险（分红型）',
      productType: '增额终身寿险',
    },
    {
      id: 2,
      company: '中国平安保险',
      productName: '平安福重大疾病保险',
      productType: '重疾险',
    },
    {
      id: 3,
      company: '中国人寿',
      productName: '国寿鑫享宝专属商业养老保险',
      productType: '养老年金保险',
    },
  );
  let scannerInput = null;
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async (input) => {
      scannerInput = input;
      return {
        ocrText: '',
        data: {
          company: '中国平安保险',
          name: '平安福重大疾病保险',
        },
      };
    },
  });
  const server = await listen(app);

  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-vision-context',
        uploadItem: {
          name: 'policy.jpg',
          type: 'image/jpeg',
          size: 1024,
          dataUrl: 'data:image/jpeg;base64,QQ==',
        },
        manualData: {
          company: '中国平安保险',
          name: '平安福',
        },
      }),
    });

    assert.equal(recognized.response.status, 200);
    assert.equal(scannerInput.ocrText, '');
    assert.deepEqual(scannerInput.ocrContext.companyHints, ['中国平安保险']);
    assert.ok(scannerInput.ocrContext.productCandidates.some((item) => item.productName === '平安福重大疾病保险'));
    assert.equal(scannerInput.ocrContext.productCandidates.some((item) => item.company === '新华保险'), false);
    assert.equal(scannerInput.ocrContext.productCandidates.some((item) => item.company === '中国人寿'), false);
  } finally {
    await server.close();
  }
});

test('recognize keeps raw upload metadata when OCR fails before parsing', async () => {
  const state = createInitialState();
  let persistCalls = 0;
  const app = createPolicyOcrApp({
    state,
    persist: async () => {
      persistCalls += 1;
    },
    scanner: async () => {
      throw new Error('OCR_SERVICE_FAILED');
    },
  });
  const server = await listen(app);

  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-raw-upload-failed',
        uploadItem: {
          name: 'failed-policy.jpg',
          type: 'image/jpeg',
          size: 4096,
          dataUrl: 'data:image/jpeg;base64,QQ==',
        },
      }),
    });

    assert.equal(recognized.response.status, 500);
    assert.equal(persistCalls, 1);
    assert.equal(state.pendingScans.length, 1);
    assert.equal(state.pendingScans[0].scan, null);
    assert.deepEqual(state.pendingScans[0].rawUpload, {
      ocrText: '',
      uploadItem: {
        name: 'failed-policy.jpg',
        type: 'image/jpeg',
        size: 4096,
        hasDataUrl: true,
      },
      hasProvidedScan: false,
      hasProvidedAnalysis: false,
    });
  } finally {
    await server.close();
  }
});

test('saving a policy persists analysis source links into the state database', async () => {
  const state = {
    users: [],
    sessions: [],
    smsCodes: [],
    policies: [],
    pendingScans: [],
    sourceRecords: [],
    nextId: 1,
  };
  const sourceUrl = 'https://www.pingan.com/official/productSeo/pinganfu-demo';
  const app = createPolicyOcrApp({
    state,
    scanner: async ({ ocrText }) => ({
      ocrText,
      data: {
        company: '中国平安保险',
        name: '平安福',
        insured: '李四',
      },
    }),
    analyzer: async () => ({
      report: '',
      coverageTable: [
        {
          coverageType: '身故保险金',
          scenario: '被保险人身故',
          payout: '按合同约定给付',
          note: '以正式合同为准。',
        },
      ],
      sources: [
        {
          title: '中国平安 平安福 保险条款与保险责任',
          url: sourceUrl,
          snippet: '平安福保险责任包括身故保险金。',
          evidenceLabel: '保险公司官方资料',
          evidenceLevel: 'insurer_official',
          official: true,
          sourceType: 'html',
        },
      ],
    }),
  });
  const server = await listen(app);

  try {
    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-source-record',
        ocrText: '中国平安保险 平安福 身故保险金',
      }),
    });
    assert.equal(saved.response.status, 201);
    await waitUntil(() => {
      const policy = state.policies.find((row) => Number(row.id) === Number(saved.payload.policy.id));
      assert.equal(policy.reportStatus, 'ready');
      assert.equal(policy.sources[0].url, sourceUrl);
      assert.equal(state.sourceRecords.length, 1);
      assert.equal(state.sourceRecords[0].policyId, policy.id);
      assert.equal(state.sourceRecords[0].company, '中国平安保险');
      assert.equal(state.sourceRecords[0].productName, '平安福');
      assert.equal(state.sourceRecords[0].url, sourceUrl);
      assert.equal(state.sourceRecords[0].official, true);
      assert.equal(state.sourceRecords[0].evidenceLevel, 'insurer_official');
    });
  } finally {
    await server.close();
  }
});

test('saving a policy does not backfill official sources from another insurer domain', async () => {
  const wrongSourceUrl = 'https://static-cdn.newchinalife.com/ncl/pdf/20260106/255be430-6330-4b85-a50e-829ac5e86c18.pdf';
  const state = {
    users: [],
    sessions: [],
    smsCodes: [],
    policies: [],
    pendingScans: [],
    sourceRecords: [],
    knowledgeRecords: [
      {
        id: 56,
        company: '新华保险',
        productName: '新华人寿保险股份有限公司盛世荣耀臻享版终身寿险（分红型）',
        title: '新华人寿保险股份有限公司盛世荣耀臻享版终身寿险（分红型）',
        url: wrongSourceUrl,
        snippet: '新华保险官网条款。',
        pageText: '保险责任 在本合同保险期间内，我们按下列规定承担保险责任。',
        sourceType: 'pdf',
        official: true,
        officialDomain: 'newchinalife.com',
      },
    ],
    nextId: 100,
  };
  const app = createPolicyOcrApp({
    state,
    scanner: async ({ ocrText }) => ({
      ocrText,
      data: {
        company: '英大泰和人寿保险股份有限公司',
        name: '英大出行护身福两全保险',
        applicant: '陶慧',
        insured: '郑小通',
      },
    }),
    analyzer: async () => ({
      report: '',
      coverageTable: [
        {
          coverageType: '保险责任',
          scenario: '错误来源不应回灌知识库',
          payout: '以正式条款为准',
          note: '新华人寿保险股份有限公司盛世荣耀臻享版终身寿险（分红型）',
        },
      ],
      sources: [
        {
          title: '新华人寿保险股份有限公司盛世荣耀臻享版终身寿险（分红型）',
          url: wrongSourceUrl,
          snippet: '新华保险官网条款。',
          evidenceLabel: '保险公司官方资料',
          evidenceLevel: 'insurer_official',
          official: true,
          sourceType: 'pdf',
        },
      ],
    }),
  });
  const server = await listen(app);

  try {
    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-cross-insurer-source',
        ocrText: '英大泰和人寿保险股份有限公司 英大出行护身福两全保险',
      }),
    });
    assert.equal(saved.response.status, 201);
    await waitUntil(() => {
      const policy = state.policies.find((row) => Number(row.id) === Number(saved.payload.policy.id));
      assert.equal(policy.reportStatus, 'ready');
      assert.equal(state.sourceRecords.length, 0);
      assert.equal(state.knowledgeRecords.length, 1);
      assert.equal(state.knowledgeRecords[0].company, '新华保险');
      assert.equal(state.knowledgeRecords[0].productName, '新华人寿保险股份有限公司盛世荣耀臻享版终身寿险（分红型）');
    });
  } finally {
    await server.close();
  }
});

test('manual applicant and insured relations are analyzed and saved with policy', async () => {
  let analyzerScanData = null;
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [],
      pendingScans: [],
      nextId: 1,
    },
    scanner: async ({ ocrText }) => ({
      ocrText,
      data: {
        company: '中国人寿保险',
        name: '国寿福终身寿险',
        applicant: '王五',
        insured: '小王',
        date: '2026-05-14',
        paymentPeriod: '20年交',
        coveragePeriod: '终身',
        amount: '300000',
        firstPremium: '6000',
      },
    }),
    analyzer: async ({ scan }) => {
      analyzerScanData = scan.data;
      return {
        report: '关系信息应进入解析上下文。',
        coverageTable: [
          {
            coverageType: '身故保险金',
            scenario: '被保险人身故',
            payout: '按合同约定给付保险金',
            note: '测试关系字段保存',
          },
        ],
      };
    },
  });
  const server = await listen(app);

  try {
    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-relation',
        ocrText: '中国人寿保险 国寿福终身寿险',
        manualData: {
          applicantRelation: '本人',
          insuredRelation: '子女',
        },
      }),
    });

    assert.equal(saved.response.status, 201);
    assert.equal(saved.payload.policy.reportStatus, 'generating');
    assert.equal(saved.payload.policy.applicantRelation, '本人');
    assert.equal(saved.payload.policy.insuredRelation, '子女');
    await waitUntil(() => {
      assert.equal(analyzerScanData.applicantRelation, '本人');
      assert.equal(analyzerScanData.insuredRelation, '子女');
    });

    const detail = await jsonFetch(server.baseUrl, `/api/policies/${saved.payload.policy.id}?guestId=guest-relation`);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.payload.policy.applicantRelation, '本人');
    assert.equal(detail.payload.policy.insuredRelation, '子女');
    assert.equal(detail.payload.policy.reportStatus, 'ready');
  } finally {
    await server.close();
  }
});

test('scan saves insured identity number and allows manual insured birthday correction', async () => {
  let analyzerScanData = null;
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [],
      pendingScans: [],
      nextId: 1,
    },
    scanner: async ({ ocrText }) => ({
      ocrText,
      data: {
        company: '新华保险',
        name: '测试终身寿险',
        applicant: '张三',
        insured: '李四',
        insuredIdNumber: '330103199112243456',
        insuredBirthday: '1991-12-24',
        date: '2026-01-01',
        paymentPeriod: '10年交',
        coveragePeriod: '终身',
        amount: '100000',
        firstPremium: '5000',
      },
    }),
    analyzer: async ({ scan }) => {
      analyzerScanData = scan.data;
      return {
        report: '被保险人生日用于后续家庭报表年龄轴。',
        coverageTable: [
          {
            coverageType: '身故保险金',
            scenario: '被保险人身故',
            payout: '按合同约定给付保险金',
            note: '测试被保险人生日保存',
          },
        ],
      };
    },
  });
  const server = await listen(app);

  try {
    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-insured-birthday',
        ocrText: '新华保险 测试终身寿险 李四 330103199112243456',
        manualData: {
          insuredBirthday: '1991-12-25',
        },
      }),
    });

    assert.equal(saved.response.status, 201);
    assert.equal(saved.payload.policy.insuredIdNumber, '330103199112243456');
    assert.equal(saved.payload.policy.insuredBirthday, '1991-12-25');
    await waitUntil(() => {
      assert.equal(analyzerScanData.insuredIdNumber, '330103199112243456');
      assert.equal(analyzerScanData.insuredBirthday, '1991-12-25');
    });

    const detail = await jsonFetch(server.baseUrl, `/api/policies/${saved.payload.policy.id}?guestId=guest-insured-birthday`);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.payload.policy.insuredIdNumber, '330103199112243456');
    assert.equal(detail.payload.policy.insuredBirthday, '1991-12-25');
  } finally {
    await server.close();
  }
});

test('scan saves beneficiary and policy update can edit beneficiary without regenerating responsibilities', async () => {
  let analyzerCalls = 0;
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [],
      pendingScans: [],
      nextId: 1,
    },
    analyzer: async () => {
      analyzerCalls += 1;
      return {
        report: '不应该重新生成。',
        coverageTable: [{ coverageType: '不应出现', scenario: '', payout: '', note: '' }],
      };
    },
  });
  const server = await listen(app);

  try {
    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-beneficiary',
        ocrText: '新华保险 测试终身寿险 身故保险金受益人 法定继承人',
        scan: {
          ocrText: '新华保险 测试终身寿险 身故保险金受益人 法定继承人',
          data: {
            company: '新华保险',
            name: '测试终身寿险',
            applicant: '张三',
            insured: '李四',
            beneficiary: '法定继承人',
            date: '2026-05-14',
            paymentPeriod: '10年交',
            coveragePeriod: '终身',
            amount: '100000',
            firstPremium: '5000',
          },
        },
        analysis: {
          report: '旧责任应保留。',
          coverageTable: [
            {
              coverageType: '身故保险金',
              scenario: '被保险人身故',
              payout: '按合同约定给付',
              note: '测试受益人保存',
            },
          ],
        },
      }),
    });

    assert.equal(saved.response.status, 201);
    assert.equal(saved.payload.policy.beneficiary, '法定');
    assert.equal(saved.payload.policy.date, '2026-05-14');

    const detail = await jsonFetch(server.baseUrl, `/api/policies/${saved.payload.policy.id}?guestId=guest-beneficiary`);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.payload.policy.applicant, '张三');
    assert.equal(detail.payload.policy.beneficiary, '法定');
    assert.equal(detail.payload.policy.date, '2026-05-14');

    const updated = await jsonFetch(server.baseUrl, `/api/policies/${saved.payload.policy.id}?guestId=guest-beneficiary`, {
      method: 'PATCH',
      body: JSON.stringify({
        applicant: '王五',
        beneficiary: '李四',
      }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.policy.applicant, '王五');
    assert.equal(updated.payload.policy.beneficiary, '李四');
    assert.equal(updated.payload.policy.reportStatus, 'ready');
    assert.equal(updated.payload.policy.responsibilities[0].note, '测试受益人保存');
    assert.equal(analyzerCalls, 0);
  } finally {
    await server.close();
  }
});

test('manual relation variants are normalized and saved when reusing a recognized scan', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [],
      pendingScans: [],
      nextId: 1,
    },
    scanner: async ({ ocrText }) => ({
      ocrText,
      data: {
        company: '新华保险',
        name: '测试保单',
        applicant: '张三',
        insured: '李四',
        amount: '100000',
        firstPremium: '1200',
      },
    }),
    analyzer: async () => ({
      report: '关系字段应随保存进入保单。',
      coverageTable: [
        {
          coverageType: '身故保险金',
          scenario: '被保险人身故',
          payout: '按合同约定给付',
          note: '测试关系变体保存',
        },
      ],
    }),
  });
  const server = await listen(app);

  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-relation-refresh',
        ocrText: '新华保险 测试保单',
      }),
    });
    assert.equal(recognized.response.status, 200);

    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-relation-refresh',
        scan: recognized.payload.scan,
        manualData: {
          applicantRelation: '母亲',
          insuredRelation: '儿子',
        },
      }),
    });

    assert.equal(saved.response.status, 201);
    assert.equal(saved.payload.policy.applicantRelation, '母亲');
    assert.equal(saved.payload.policy.insuredRelation, '儿子');
  } finally {
    await server.close();
  }
});

test('scan saves immediately and generates policy report asynchronously when no analysis is provided', async () => {
  let releaseAnalyzer;
  const analyzerStarted = new Promise((resolve) => {
    releaseAnalyzer = resolve;
  });
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [],
      pendingScans: [],
      nextId: 1,
    },
    scanner: async ({ ocrText }) => ({
      ocrText,
      data: {
        company: '新华保险',
        name: '盛世荣耀臻享版终身寿险',
        applicant: '张三',
        insured: '张三',
        date: '2026-05-14',
        paymentPeriod: '10年交',
        coveragePeriod: '终身',
        amount: '300000',
        firstPremium: '8000',
      },
    }),
    analyzer: async () => {
      await analyzerStarted;
      return {
        report: '后台生成的高质量报告。',
        coverageTable: [
          {
            coverageType: '身故保险金',
            scenario: '身故',
            payout: '按合同约定给付',
            note: '后台生成',
          },
        ],
      };
    },
  });
  const server = await listen(app);

  try {
    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-async-report',
        ocrText: '新华保险 盛世荣耀臻享版终身寿险',
      }),
    });

    assert.equal(saved.response.status, 201);
    assert.equal(saved.payload.policy.reportStatus, 'generating');
    assert.equal(saved.payload.policy.report, '');
    assert.equal(saved.payload.policy.responsibilities.length, 0);

    releaseAnalyzer();
    await waitUntil(() => {
      const policy = app.locals.state.policies.find((row) => Number(row.id) === Number(saved.payload.policy.id));
      assert.equal(policy.reportStatus, 'ready');
      assert.equal(policy.report, '后台生成的高质量报告。');
      assert.equal(policy.responsibilities[0].note, '后台生成');
    });
  } finally {
    await server.close();
  }
});

test('scan save uses incremental persistence when the sqlite store provides it', async () => {
  let fullPersistCalls = 0;
  const incrementalCalls = [];
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [],
      pendingScans: [
        { guestId: 'guest-fast-save', createdAt: '2026-06-08T00:00:00.000Z', scan: { data: { name: '待保存保单' } } },
      ],
      nextId: 1,
    },
    persist: async () => {
      fullPersistCalls += 1;
    },
    persistPolicyScanSave: async (input) => {
      incrementalCalls.push(input);
    },
  });
  const server = await listen(app);

  try {
    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-fast-save',
        scan: {
          ocrText: '新华保险 多倍保障重大疾病保险',
          data: {
            company: '新华保险',
            name: '多倍保障重大疾病保险',
            applicant: '温舒萍',
            insured: '温舒萍',
            date: '2026-06-08',
            paymentPeriod: '20年交',
            coveragePeriod: '终身',
            amount: '170000',
            firstPremium: '7667',
          },
        },
        analysis: {
          report: '已提供报告',
          coverageTable: [
            {
              coverageType: '重大疾病保险金',
              scenario: '确诊重大疾病',
              payout: '按合同约定给付',
              note: '已复用分析',
            },
          ],
        },
      }),
    });

    assert.equal(saved.response.status, 201);
    assert.equal(fullPersistCalls, 0);
    assert.equal(incrementalCalls.length, 1);
    assert.equal(incrementalCalls[0].policy.name, '多倍保障重大疾病保险');
    assert.equal(incrementalCalls[0].clearPendingGuestId, 'guest-fast-save');
    assert.equal(app.locals.state.pendingScans.length, 0);
  } finally {
    await server.close();
  }
});

test('async policy report generation marks the policy failed when analysis is empty', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [],
      pendingScans: [],
      nextId: 1,
    },
    scanner: async ({ ocrText }) => ({
      ocrText,
      data: {
        company: '新华保险',
        name: '盛世荣耀臻享版终身寿险',
        applicant: '张三',
        insured: '张三',
        date: '2026-05-14',
        paymentPeriod: '10年交',
        coveragePeriod: '终身',
        amount: '300000',
        firstPremium: '8000',
      },
    }),
    analyzer: async () => ({ report: '', coverageTable: [] }),
  });
  const server = await listen(app);

  try {
    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-empty-report',
        ocrText: '新华保险 盛世荣耀臻享版终身寿险',
      }),
    });

    assert.equal(saved.response.status, 201);
    assert.equal(saved.payload.policy.reportStatus, 'generating');
    await waitUntil(() => {
      const policy = app.locals.state.policies.find((row) => Number(row.id) === Number(saved.payload.policy.id));
      assert.equal(policy.reportStatus, 'failed');
      assert.equal(policy.reportError, '报告生成结果为空');
    });
  } finally {
    await server.close();
  }
});

test('failed guest policy report can be regenerated from the saved policy data', async () => {
  let analyzerCalls = 0;
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [
        {
          id: 2,
          userId: null,
          guestId: 'guest-retry-report',
          company: '中国平安保险',
          name: '平安福终身寿险',
          applicant: '王五',
          applicantRelation: '本人',
          insured: '王五',
          insuredRelation: '本人',
          date: '2026-05-14',
          paymentPeriod: '20年交',
          coveragePeriod: '终身',
          amount: 300000,
          firstPremium: 6000,
          ocrText: '中国平安保险 平安福终身寿险 身故保险金',
          responsibilities: [],
          report: '',
          sources: [],
          reportStatus: 'failed',
          reportError: '上一次生成失败',
          createdAt: '2026-05-14T00:00:00.000Z',
          updatedAt: '2026-05-14T00:00:00.000Z',
        },
      ],
      pendingScans: [],
      sourceRecords: [],
      nextId: 3,
    },
    analyzer: async ({ scan }) => {
      analyzerCalls += 1;
      assert.equal(scan.ocrText, '中国平安保险 平安福终身寿险 身故保险金');
      assert.equal(scan.data.company, '中国平安保险');
      assert.equal(scan.data.name, '平安福终身寿险');
      return {
        report: '重新生成后的简版责任报告。',
        coverageTable: [
          {
            coverageType: '身故保险金',
            scenario: '被保险人身故',
            payout: '按合同约定给付保险金',
            note: '重新生成成功',
          },
        ],
        sources: [
          {
            title: '平安福产品条款',
            url: 'https://life.pingan.com/product/pinganfuterms.pdf',
            official: true,
            evidenceLevel: 'official',
            sourceType: 'pdf',
          },
        ],
      };
    },
  });
  const server = await listen(app);

  try {
    const retry = await jsonFetch(server.baseUrl, '/api/policies/2/report?guestId=guest-retry-report', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    assert.equal(retry.response.status, 202);
    assert.equal(retry.payload.policy.reportStatus, 'generating');
    assert.equal(retry.payload.policy.reportError, '');
    await waitUntil(() => {
      const policy = app.locals.state.policies.find((row) => Number(row.id) === 2);
      assert.equal(analyzerCalls, 1);
      assert.equal(policy.reportStatus, 'ready');
      assert.equal(policy.report, '重新生成后的简版责任报告。');
      assert.equal(policy.responsibilities[0].coverageType, '身故保险金');
      assert.equal(policy.sources[0].url, 'https://life.pingan.com/product/pinganfuterms.pdf');
      assert.equal(app.locals.state.sourceRecords.length, 1);
    });
  } finally {
    await server.close();
  }
});

test('policy update preserves responsibilities when insurer and product are unchanged', async () => {
  let analyzerCalls = 0;
  const state = {
    users: [],
    sessions: [],
    smsCodes: [],
    policies: [
      {
        id: 7,
        userId: null,
        guestId: 'guest-edit-policy',
        company: '新华保险',
        name: '盛世荣耀臻享版终身寿险',
        applicant: '张三',
        applicantRelation: '本人',
        insured: '张三',
        insuredRelation: '本人',
        date: '2026-05-14',
        paymentPeriod: '10年交',
        coveragePeriod: '终身',
        amount: 300000,
        firstPremium: 8000,
        ocrText: '新华保险 盛世荣耀臻享版终身寿险',
        responsibilities: [
          {
            coverageType: '身故保险金',
            scenario: '被保险人身故',
            payout: '按合同约定给付',
            note: '旧责任应保留',
          },
        ],
        report: '旧报告应保留。',
        sources: [
          {
            title: '旧条款',
            url: 'https://example.test/old.pdf',
          },
        ],
        reportStatus: 'ready',
        reportError: '',
        createdAt: '2026-05-14T00:00:00.000Z',
        updatedAt: '2026-05-14T00:00:00.000Z',
      },
    ],
    pendingScans: [],
    sourceRecords: [
      {
        id: 8,
        policyId: 7,
        company: '新华保险',
        productName: '盛世荣耀臻享版终身寿险',
        title: '旧条款',
        url: 'https://example.test/old.pdf',
      },
    ],
    nextId: 9,
  };
  const app = createPolicyOcrApp({
    state,
    analyzer: async () => {
      analyzerCalls += 1;
      return {
        report: '不应该重新生成。',
        coverageTable: [{ coverageType: '不应出现', scenario: '', payout: '', note: '' }],
      };
    },
  });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/policies/7?guestId=guest-edit-policy`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ insured: '李四', amount: 500000 }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.policy.insured, '李四');
    assert.equal(payload.policy.amount, 500000);
    assert.equal(payload.policy.reportStatus, 'ready');
    assert.equal(payload.policy.responsibilities[0].note, '旧责任应保留');
    assert.equal(payload.policy.report, '旧报告应保留。');
    assert.equal(analyzerCalls, 0);
    assert.equal(state.sourceRecords.length, 1);
    assert.equal(state.sourceRecords[0].productName, '盛世荣耀臻享版终身寿险');
  } finally {
    await server.close();
  }
});

test('policy update regenerates responsibilities when insurer or product changes', async () => {
  let analyzerCalls = 0;
  const state = {
    users: [],
    sessions: [],
    smsCodes: [],
    policies: [
      {
        id: 11,
        userId: null,
        guestId: 'guest-regenerate-policy',
        company: '新华保险',
        name: '旧产品',
        canonicalProductId: 'product_old',
        applicant: '张三',
        insured: '张三',
        date: '2026-05-14',
        paymentPeriod: '10年交',
        coveragePeriod: '终身',
        amount: 300000,
        firstPremium: 8000,
        ocrText: '新华保险 旧产品',
        responsibilities: [
          {
            coverageType: '旧责任',
            scenario: '旧场景',
            payout: '旧给付',
            note: '应被重算',
          },
        ],
        report: '旧报告',
        sources: [{ title: '旧条款', url: 'https://example.test/old.pdf' }],
        reportStatus: 'ready',
        reportError: '',
        createdAt: '2026-05-14T00:00:00.000Z',
        updatedAt: '2026-05-14T00:00:00.000Z',
      },
    ],
    pendingScans: [],
    sourceRecords: [
      {
        id: 12,
        policyId: 11,
        company: '新华保险',
        productName: '旧产品',
        title: '旧条款',
        url: 'https://example.test/old.pdf',
      },
    ],
    nextId: 13,
  };
  const app = createPolicyOcrApp({
    state,
    analyzer: async ({ scan }) => {
      analyzerCalls += 1;
      assert.equal(scan.data.company, '新华保险');
      assert.equal(scan.data.name, '新产品');
      return {
        report: '新产品责任报告。',
        coverageTable: [
          {
            coverageType: '新产品身故保险金',
            scenario: '被保险人身故',
            payout: '按新产品条款给付',
            note: '已重算',
          },
        ],
        sources: [
          {
            company: '新华保险',
            productName: '新产品',
            title: '新产品条款',
            url: 'https://example.test/new.pdf',
          },
        ],
      };
    },
  });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/policies/11?guestId=guest-regenerate-policy`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '新产品', canonicalProductId: '' }),
    });

    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.policy.name, '新产品');
    assert.notEqual(payload.policy.canonicalProductId, 'product_old');
    assert.equal(payload.policy.canonicalProductId || '', '');
    assert.equal(payload.policy.reportStatus, 'generating');
    assert.equal(payload.policy.responsibilities.length, 0);
    await waitUntil(() => {
      const policy = state.policies.find((row) => Number(row.id) === 11);
      assert.equal(analyzerCalls, 1);
      assert.equal(policy.reportStatus, 'ready');
      assert.equal(policy.report, '新产品责任报告。');
      assert.equal(policy.responsibilities[0].coverageType, '新产品身故保险金');
      assert.equal(state.sourceRecords.length, 1);
      assert.equal(state.sourceRecords[0].productName, '新产品');
      assert.equal(state.sourceRecords[0].url, 'https://example.test/new.pdf');
    });
  } finally {
    await server.close();
  }
});

test('policy delete removes the policy and its source records', async () => {
  const state = {
    users: [],
    sessions: [],
    smsCodes: [],
    policies: [
      {
        id: 21,
        userId: null,
        guestId: 'guest-delete-policy',
        company: '新华保险',
        name: '待删除产品',
        responsibilities: [],
        reportStatus: 'ready',
        createdAt: '2026-05-14T00:00:00.000Z',
        updatedAt: '2026-05-14T00:00:00.000Z',
      },
      {
        id: 22,
        userId: null,
        guestId: 'guest-delete-policy',
        company: '中国平安保险',
        name: '保留产品',
        responsibilities: [],
        reportStatus: 'ready',
        createdAt: '2026-05-14T00:00:00.000Z',
        updatedAt: '2026-05-14T00:00:00.000Z',
      },
    ],
    pendingScans: [],
    sourceRecords: [
      { id: 23, policyId: 21, productName: '待删除产品', url: 'https://example.test/delete.pdf' },
      { id: 24, policyId: 22, productName: '保留产品', url: 'https://example.test/keep.pdf' },
    ],
    nextId: 25,
  };
  const app = createPolicyOcrApp({ state });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.baseUrl}/api/policies/21?guestId=guest-delete-policy`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.deepEqual(
      state.policies.map((policy) => policy.id),
      [22],
    );
    assert.deepEqual(
      state.sourceRecords.map((source) => source.policyId),
      [22],
    );
  } finally {
    await server.close();
  }
});

test('policy scan emits performance timings for OCR and responsibility analysis', async () => {
  const events = [];
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [],
      pendingScans: [],
      nextId: 1,
    },
    performanceLogger: (event) => events.push(event),
    scanner: async ({ ocrText }) => ({
      ocrText,
      data: {
        company: '新华保险',
        name: '盛世荣耀臻享版终身寿险',
        applicant: '张三',
        insured: '张三',
        date: '2026-05-14',
        paymentPeriod: '10年交',
        coveragePeriod: '终身',
        amount: '300000',
        firstPremium: '8000',
      },
    }),
    analyzer: async () => ({
      report: '保单责任解析。',
      coverageTable: [
        {
          coverageType: '身故保险金',
          scenario: '身故',
          payout: '按合同约定给付',
          note: '测试性能日志',
        },
      ],
    }),
  });
  const server = await listen(app);

  try {
    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-perf',
        ocrText: '新华保险 盛世荣耀臻享版终身寿险',
      }),
    });

    assert.equal(saved.response.status, 201);
    assert.ok(events.some((event) => event.event === 'policy.scan.ocr'));
    assert.ok(events.some((event) => event.event === 'policy.scan.complete'));
    await waitUntil(() => {
      assert.ok(events.some((event) => event.event === 'policy.report.background.analysis'));
    });
    for (const event of events) {
      assert.equal(typeof event.durationMs, 'number');
      assert.ok(event.durationMs >= 0);
    }
  } finally {
    await server.close();
  }
});

test('client performance endpoint logs sanitized timing events', async () => {
  const events = [];
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [],
      pendingScans: [],
      nextId: 1,
    },
    performanceLogger: (event) => events.push(event),
  });
  const server = await listen(app);

  try {
    const logged = await jsonFetch(server.baseUrl, '/api/client-perf', {
      method: 'POST',
      body: JSON.stringify({
        event: 'client.recognize.complete',
        durationMs: 3210.9,
        uploadBytes: 960030,
        note: '张三 盛世荣耀',
      }),
    });

    assert.equal(logged.response.status, 200);
    const event = events.find((item) => item.event === 'client.recognize.complete');
    assert.ok(event);
    assert.equal(event.durationMs, 3211);
    assert.equal(event.uploadBytes, 960030);
    assert.equal(event.note, undefined);
  } finally {
    await server.close();
  }
});

test('send-code uses real sms delivery without exposing the verification code', async () => {
  const delivered = [];
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [],
      nextId: 1,
    },
    smsDeliveryPlanResolver: ({ mobile }) => ({
      mobile,
      code: '246810',
      deliveryMode: 'real',
      exposeDevCode: false,
    }),
    smsDeliverer: async (input) => {
      delivered.push(input);
      return {
        ok: true,
        mode: 'real',
        provider: 'webhook',
        simulated: false,
      };
    },
  });
  const server = await listen(app);

  try {
    const code = await jsonFetch(server.baseUrl, '/api/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ mobile: '13800000001' }),
    });
    assert.equal(code.response.status, 200);
    assert.equal(code.payload.devCode, undefined);
    assert.equal(code.payload.deliveryMode, 'real');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].mobile, '13800000001');
    assert.equal(delivered[0].code, '246810');

    const registered = await jsonFetch(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        mobile: '13800000001',
        code: '246810',
        guestId: 'guest-real-sms',
      }),
    });
    assert.equal(registered.response.status, 200);
    assert.ok(registered.payload.token);
  } finally {
    await server.close();
  }
});

test('send-code fails closed when real sms provider is not ready', async () => {
  const state = {
    users: [],
    sessions: [],
    smsCodes: [],
    policies: [],
    nextId: 1,
  };
  const app = createPolicyOcrApp({
    state,
    smsDeliveryPlanResolver: ({ mobile }) => ({
      mobile,
      code: '112233',
      deliveryMode: 'real',
      exposeDevCode: false,
    }),
    smsDeliverer: async () => {
      const error = new Error('SMS_PROVIDER_NOT_READY');
      error.code = 'SMS_PROVIDER_NOT_READY';
      throw error;
    },
  });
  const server = await listen(app);

  try {
    const code = await jsonFetch(server.baseUrl, '/api/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ mobile: '13800000002' }),
    });
    assert.equal(code.response.status, 503);
    assert.equal(code.payload.code, 'SMS_PROVIDER_NOT_READY');
    assert.equal(code.payload.message, '短信服务未配置，请联系管理员');
    assert.equal(state.smsCodes.length, 0);
  } finally {
    await server.close();
  }
});

test('scan endpoint calls insurance responsibility query asynchronously after saving policy', async () => {
  const responsibilityQueries = [];
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [],
      nextId: 1,
    },
    scanner: async ({ ocrText }) => ({
      ocrText,
      data: {
        company: '新华保险',
        name: '多倍保障重大疾病保险',
        applicant: '张三',
        insured: '张三',
        date: '2026-05-13',
        paymentPeriod: '20年交',
        coveragePeriod: '终身',
        amount: '300000',
        firstPremium: '10000',
      },
    }),
    policyResponsibilityQuery: async ({ policy, ocrText }) => {
      responsibilityQueries.push({ policy, ocrText });
      return {
        analysis: {
          report: '来自保险责任查询的结果',
          coverageTable: [
            {
              coverageType: '重大疾病保险金',
              scenario: '确诊合同约定重大疾病',
              payout: '给付基本保险金额30万元',
              note: '责任查询返回的客户解释',
            },
          ],
        },
        modelOutput: {
          model: 'test-responsibility-query',
        },
      };
    },
  });
  const server = await listen(app);

  try {
    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-responsibility-query',
        ocrText: '新华保险 多倍保障重大疾病保险 重大疾病保险金 给付基本保险金额30万元',
      }),
    });
    assert.equal(saved.response.status, 201);
    assert.equal(saved.payload.policy.reportStatus, 'generating');
    await waitUntil(() => {
      assert.equal(responsibilityQueries.length, 1);
      assert.equal(responsibilityQueries[0].policy.name, '多倍保障重大疾病保险');
      assert.equal(responsibilityQueries[0].ocrText, '新华保险 多倍保障重大疾病保险 重大疾病保险金 给付基本保险金额30万元');
      const policy = app.locals.state.policies.find((row) => Number(row.id) === Number(saved.payload.policy.id));
      assert.equal(policy.report, '来自保险责任查询的结果');
      assert.equal(policy.responsibilities[0].note, '责任查询返回的客户解释');
    });
  } finally {
    await server.close();
  }
});

test('scan endpoint queries responsibilities for each OCR plan in a multi-plan policy', async () => {
  const responsibilityQueries = [];
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [],
      pendingScans: [],
      sourceRecords: [],
      knowledgeRecords: [],
      officialDomainProfiles: [],
      nextId: 1,
    },
    scanner: async ({ ocrText }) => ({
      ocrText,
      data: {
        company: '新华保险',
        name: '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）',
        applicant: '冯力',
        insured: '冯力',
        date: '2026-05-13',
        paymentPeriod: '10年交',
        coveragePeriod: '终身',
        amount: '100000',
        firstPremium: '11010',
        plans: [
          {
            role: 'main',
            name: '盛世恒盈年金保险（分红型）',
            matchedProductName: '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）',
            paymentPeriod: '10年交',
            coveragePeriod: '终身',
            amount: '100000',
            premium: '11000',
          },
          {
            role: 'linked_account',
            name: '鑫天利卓越版养老年金保险（万能型）',
            matchedProductName: '新华人寿保险股份有限公司鑫天利卓越版养老年金保险（万能型）',
            paymentPeriod: '趸交',
            coveragePeriod: '终身',
            amount: '0',
            premium: '10',
          },
        ],
      },
    }),
    policyResponsibilityQuery: async ({ policy, ocrText }) => {
      responsibilityQueries.push({ policy, ocrText });
      return {
        analysis: {
          report: `${policy.name}责任报告`,
          coverageTable: [
            {
              coverageType: `${policy.name}保险责任`,
              scenario: `${policy.name}触发条件`,
              payout: `${policy.name}按条款给付`,
              note: '',
            },
          ],
        },
        sources: [
          {
            title: `${policy.name}条款`,
            url: `https://example.test/${encodeURIComponent(policy.name)}.pdf`,
            company: policy.company,
            productName: policy.name,
            official: false,
          },
        ],
        modelOutput: {
          model: 'test-responsibility-query',
        },
      };
    },
  });
  const server = await listen(app);

  try {
    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-multi-plan-responsibility-query',
        ocrText: '新华保险 盛世恒盈年金保险 鑫天利卓越版养老年金保险',
      }),
    });
    assert.equal(saved.response.status, 201);
    await waitUntil(() => {
      assert.equal(responsibilityQueries.length, 2);
      assert.deepEqual(
        responsibilityQueries.map((item) => item.policy.name),
        [
          '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）',
          '新华人寿保险股份有限公司鑫天利卓越版养老年金保险（万能型）',
        ],
      );
      const policy = app.locals.state.policies.find((row) => Number(row.id) === Number(saved.payload.policy.id));
      assert.equal(policy.reportStatus, 'ready');
      assert.deepEqual(
        policy.responsibilities.map((row) => row.coverageType),
        [
          '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）保险责任',
          '新华人寿保险股份有限公司鑫天利卓越版养老年金保险（万能型）保险责任',
        ],
      );
      assert.deepEqual(
        app.locals.state.sourceRecords.map((row) => row.productName),
        [
          '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）',
          '新华人寿保险股份有限公司鑫天利卓越版养老年金保险（万能型）',
        ],
      );
    });
  } finally {
    await server.close();
  }
});

test('responsibility assistant queries coverage by company and product without saving a policy', async () => {
  const responsibilityQueries = [];
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [
        {
          id: 1,
          guestId: 'guest-has-policy',
          userId: null,
          company: '已有保司',
          name: '已有产品',
          responsibilities: [],
          report: '',
          createdAt: '2026-05-01T00:00:00.000Z',
        },
      ],
      pendingScans: [],
      nextId: 2,
    },
    policyResponsibilityQuery: async ({ policy, ocrText }) => {
      responsibilityQueries.push({ policy, ocrText });
      return {
        analysis: {
          coverageTable: [
            {
              coverageType: '身故保险金',
              scenario: '被保险人身故',
              payout: '按合同约定给付',
              note: '查询助手返回',
            },
          ],
        },
        sources: [
          {
            title: '测试保险安心一号保险条款',
            url: 'https://official.example-life.test/anxin-one.pdf',
            evidenceLabel: '本地知识库官方资料',
            official: true,
          },
        ],
      };
    },
  });
  const server = await listen(app);

  try {
    const queried = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/query', {
      method: 'POST',
      body: JSON.stringify({
        company: '测试保险',
        name: '安心一号',
      }),
    });
    assert.equal(queried.response.status, 200);
    assert.equal(queried.payload.analysis.coverageTable[0].coverageType, '身故保险金');
    assert.equal(queried.payload.analysis.sources[0].url, 'https://official.example-life.test/anxin-one.pdf');
    assert.equal(responsibilityQueries.length, 1);
    assert.equal(responsibilityQueries[0].policy.company, '测试保险');
    assert.equal(responsibilityQueries[0].policy.name, '安心一号');
    assert.equal(responsibilityQueries[0].ocrText, '测试保险 安心一号');
    assert.equal(app.locals.state.policies.length, 1);
  } finally {
    await server.close();
  }
});

test('responsibility assistant returns fuzzy local product matches before analysis', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      sourceRecords: [],
      pendingScans: [],
      officialDomainProfiles: [
        {
          id: 'example-life',
          company: '测试保险',
          aliases: ['测试保险'],
          siteDomains: ['official.example-life.test'],
          officialDomains: ['official.example-life.test'],
        },
      ],
      knowledgeRecords: [
        {
          id: 1,
          company: '测试保险',
          productName: '尊享人生年金保险（分红型）',
          title: '尊享人生年金保险（分红型）条款',
          url: 'https://official.example-life.test/zunxiang.pdf',
          pageText: '保险责任包括关爱年金、生存保险金、身故或身体全残保险金。',
          official: true,
          sourceType: 'pdf',
          materialType: 'terms',
        },
        {
          id: 2,
          company: '测试保险',
          productName: '尊尚人生两全保险（分红型）',
          title: '尊尚人生两全保险（分红型）条款',
          url: 'https://official.example-life.test/zunshang.pdf',
          pageText: '保险责任包括生存保险金、满期保险金、身故保险金。',
          official: true,
          sourceType: 'pdf',
          materialType: 'terms',
        },
      ],
      policies: [],
      nextId: 3,
    },
  });
  const server = await listen(app);

  try {
    const matched = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/matches', {
      method: 'POST',
      body: JSON.stringify({
        company: '测试保险',
        name: '尊享人生两全',
      }),
    });
    assert.equal(matched.response.status, 200);
    assert.equal(matched.payload.matches.length, 2);
    assert.ok(matched.payload.matches.some((item) => item.productName === '尊享人生年金保险（分红型）'));
    assert.ok(matched.payload.matches.some((item) => item.productName === '尊尚人生两全保险（分红型）'));
  } finally {
    await server.close();
  }
});

test('responsibility assistant returns company suggestions for partial input', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      sourceRecords: [],
      pendingScans: [],
      officialDomainProfiles: [],
      knowledgeRecords: [
        {
          id: 1,
          company: '中国平安',
          productName: '平安e生保医疗保险',
          title: '平安e生保医疗保险产品条款',
          url: 'https://life.pingan.example/pingan.pdf',
          pageText: '保险责任包括一般医疗保险金。',
          official: true,
        },
        {
          id: 2,
          company: '中国太平',
          productName: '太平测试保险',
          title: '太平测试保险产品条款',
          url: 'https://life.taiping.example/taiping.pdf',
          pageText: '保险责任包括身故保险金。',
          official: true,
        },
      ],
      policies: [],
      nextId: 3,
    },
  });
  const server = await listen(app);

  try {
    const suggested = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/company-suggestions?q=平');
    assert.equal(suggested.response.status, 200);
    assert.equal(suggested.payload.ok, true);
    assert.ok(suggested.payload.suggestions.some((item) => item.company === '中国平安'));
    assert.ok(suggested.payload.suggestions.some((item) => item.company === '中国太平'));
  } finally {
    await server.close();
  }
});

test('responsibility assistant company suggestions honor insurer aliases', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      sourceRecords: [],
      pendingScans: [],
      officialDomainProfiles: [],
      knowledgeRecords: [
        {
          id: 1,
          company: '新华保险',
          productName: '新华人寿保险股份有限公司健康无忧A款重大疾病保险',
          title: '新华人寿保险股份有限公司健康无忧A款重大疾病保险',
          url: 'https://static-cdn.newchinalife.com/ncl/pdf/health-a.pdf',
          pageText: '保险责任包括重大疾病保险金。',
          official: true,
        },
      ],
      policies: [],
      nextId: 2,
    },
  });
  const server = await listen(app);

  try {
    const suggested = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/company-suggestions?q=新华人寿');
    assert.equal(suggested.response.status, 200);
    assert.equal(suggested.payload.ok, true);
    assert.ok(suggested.payload.suggestions.some((item) => item.company === '新华保险' && item.matchType === 'alias'));
  } finally {
    await server.close();
  }
});

test('responsibility assistant company suggestions match legal-suffix variants without curated aliases', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      sourceRecords: [],
      pendingScans: [],
      officialDomainProfiles: [],
      knowledgeRecords: [
        {
          id: 1,
          company: '测试人寿保险股份有限公司',
          productName: '测试人寿安心终身寿险',
          title: '测试人寿安心终身寿险保险条款',
          url: 'https://example.test/policy.pdf',
          pageText: '保险责任包括身故保险金。',
          official: true,
        },
      ],
      policies: [],
      nextId: 2,
    },
  });
  const server = await listen(app);

  try {
    const suggested = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/company-suggestions?q=测试保险股份有限公司');
    assert.equal(suggested.response.status, 200);
    assert.equal(suggested.payload.ok, true);
    assert.ok(
      suggested.payload.suggestions.some(
        (item) => item.company === '测试人寿保险股份有限公司' && item.matchType === 'generic',
      ),
    );
  } finally {
    await server.close();
  }
});

test('responsibility assistant product suggestions are scoped to selected company', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      sourceRecords: [],
      pendingScans: [],
      officialDomainProfiles: [],
      knowledgeRecords: [
        {
          id: 1,
          company: '中国平安',
          productName: '平安e生保医疗保险',
          title: '平安e生保医疗保险产品条款',
          url: 'https://life.pingan.example/pingan-esheng.pdf',
          pageText: '保险责任包括一般医疗保险金。',
          official: true,
        },
        {
          id: 2,
          company: '中国平安',
          productName: '平安福重大疾病保险',
          title: '平安福重大疾病保险产品条款',
          url: 'https://life.pingan.example/pinganfu.pdf',
          pageText: '保险责任包括重大疾病保险金。',
          official: true,
        },
        {
          id: 3,
          company: '中国太平',
          productName: '太平e生保医疗保险',
          title: '太平e生保医疗保险产品条款',
          url: 'https://life.taiping.example/taiping-esheng.pdf',
          pageText: '保险责任包括医疗保险金。',
          official: true,
        },
      ],
      policies: [],
      nextId: 4,
    },
  });
  const server = await listen(app);

  try {
    const suggested = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/product-suggestions?company=中国平安&q=e生');
    assert.equal(suggested.response.status, 200);
    assert.equal(suggested.payload.ok, true);
    assert.ok(suggested.payload.suggestions.some((item) => item.productName === '平安e生保医疗保险'));
    assert.equal(suggested.payload.suggestions.some((item) => item.company === '中国太平'), false);
  } finally {
    await server.close();
  }
});

test('responsibility assistant product suggestions honor insurer aliases and fuzzy product names', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      sourceRecords: [],
      pendingScans: [],
      officialDomainProfiles: [],
      knowledgeRecords: [
        {
          id: 1,
          company: '新华保险',
          productName: '新华人寿保险股份有限公司健康无忧A款重大疾病保险',
          title: '新华人寿保险股份有限公司健康无忧A款重大疾病保险',
          url: 'https://static-cdn.newchinalife.com/ncl/pdf/health-a.pdf',
          pageText: '保险责任包括重大疾病保险金。',
          official: true,
        },
      ],
      policies: [],
      nextId: 2,
    },
  });
  const server = await listen(app);

  try {
    const suggested = await jsonFetch(
      server.baseUrl,
      '/api/policy-responsibilities/product-suggestions?company=新华人寿&q=健康无忧重疾',
    );
    assert.equal(suggested.response.status, 200);
    assert.equal(suggested.payload.ok, true);
    assert.ok(
      suggested.payload.suggestions.some(
        (item) => item.productName === '新华人寿保险股份有限公司健康无忧A款重大疾病保险',
      ),
    );
  } finally {
    await server.close();
  }
});

test('responsibility product suggestions include canonical product id', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      sourceRecords: [],
      pendingScans: [],
      officialDomainProfiles: [],
      knowledgeRecords: [
        {
          id: 1,
          company: '新华保险',
          productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
          title: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
          url: 'https://static-cdn.newchinalife.com/ncl/pdf/xiang.pdf',
          pageText: '保险责任。',
          official: true,
          sourceType: 'pdf',
          materialType: 'terms',
        },
      ],
      policies: [],
      nextId: 2,
    },
  });
  const server = await listen(app);

  try {
    const suggested = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/product-suggestions?company=新华保险&q=多倍');
    assert.equal(suggested.response.status, 200);
    assert.equal(suggested.payload.suggestions[0].productName, '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）');
    assert.match(suggested.payload.suggestions[0].canonicalProductId, /^product_[a-f0-9]{16}$/u);
  } finally {
    await server.close();
  }
});

test('responsibility product suggestions omit canonical id for non-official and policy-derived names', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      sourceRecords: [],
      pendingScans: [],
      officialDomainProfiles: [],
      knowledgeRecords: [
        {
          id: 1,
          company: '新华保险',
          productName: '非官方多倍保障重大疾病保险',
          title: '非官方多倍保障重大疾病保险',
          url: 'https://example.test/non-official.pdf',
          pageText: '保险责任。',
          official: false,
        },
        {
          id: 2,
          company: '新华保险',
          title: '标题多倍保障重大疾病保险',
          url: 'https://static-cdn.newchinalife.com/ncl/pdf/title-only.pdf',
          pageText: '保险责任。',
          official: true,
        },
      ],
      policies: [
        {
          id: 3,
          company: '新华保险',
          name: '用户录入多倍保障重大疾病保险',
        },
      ],
      nextId: 4,
    },
  });
  const server = await listen(app);

  try {
    const suggested = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/product-suggestions?company=新华保险&q=多倍');
    assert.equal(suggested.response.status, 200);
    assert.equal(suggested.payload.ok, true);
    assert.ok(suggested.payload.suggestions.some((item) => item.productName === '非官方多倍保障重大疾病保险'));
    assert.ok(suggested.payload.suggestions.some((item) => item.productName === '用户录入多倍保障重大疾病保险'));
    assert.equal(suggested.payload.suggestions.some((item) => item.productName === '标题多倍保障重大疾病保险'), false);
    for (const suggestion of suggested.payload.suggestions) {
      assert.equal(Object.hasOwn(suggestion, 'canonicalProductId') ? suggestion.canonicalProductId : undefined, undefined);
    }
  } finally {
    await server.close();
  }
});

test('responsibility product suggestions match one-character product keywords within selected company', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      sourceRecords: [],
      pendingScans: [],
      officialDomainProfiles: [],
      knowledgeRecords: [
        {
          id: 1,
          company: '新华保险',
          productName: '荣享人生养老年金保险（分红型）',
          title: '荣享人生养老年金保险（分红型）产品条款',
          url: 'https://newchina.example/rongxiang.pdf',
          pageText: '保险责任包括养老年金。',
          official: true,
        },
        {
          id: 2,
          company: '新华保险',
          productName: '荣耀人生两全保险（分红型）',
          title: '荣耀人生两全保险（分红型）产品条款',
          url: 'https://newchina.example/rongyao.pdf',
          pageText: '保险责任包括满期保险金。',
          official: true,
        },
        {
          id: 3,
          company: '中国平安',
          productName: '平安荣耀终身寿险',
          title: '平安荣耀终身寿险产品条款',
          url: 'https://pingan.example/rongyao.pdf',
          pageText: '保险责任包括身故保险金。',
          official: true,
        },
      ],
      policies: [],
      nextId: 4,
    },
  });
  const server = await listen(app);

  try {
    const suggested = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/product-suggestions?company=新华保险&q=荣');
    assert.equal(suggested.response.status, 200);
    assert.equal(suggested.payload.ok, true);
    assert.ok(suggested.payload.suggestions.some((item) => item.productName === '荣享人生养老年金保险（分红型）'));
    assert.ok(suggested.payload.suggestions.some((item) => item.productName === '荣耀人生两全保险（分红型）'));
    assert.equal(suggested.payload.suggestions.some((item) => item.company === '中国平安'), false);
  } finally {
    await server.close();
  }
});

test('responsibility assistant local matches are limited to three and do not query Feishu', async () => {
  let feishuCalled = false;
  const app = createPolicyOcrApp({
    resolveFeishuKnowledgeRecords: async () => {
      feishuCalled = true;
      return [];
    },
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      sourceRecords: [],
      pendingScans: [],
      officialDomainProfiles: [
        {
          id: 'example-life',
          company: '测试保险',
          aliases: ['测试保险'],
          siteDomains: ['official.example-life.test'],
          officialDomains: ['official.example-life.test'],
        },
      ],
      knowledgeRecords: ['尊享人生年金保险（分红型）', '尊尚人生两全保险（分红型）', '美利人生两全保险（分红型）', '卓越人生两全保险'].map(
        (productName, index) => ({
          id: index + 1,
          company: '测试保险',
          productName,
          title: `${productName}条款`,
          url: `https://official.example-life.test/product-${index + 1}.pdf`,
          pageText: '保险责任包括生存保险金、满期保险金、身故保险金。',
          official: true,
          sourceType: 'pdf',
          materialType: 'terms',
        }),
      ),
      policies: [],
      nextId: 5,
    },
  });
  const server = await listen(app);

  try {
    const matched = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/matches', {
      method: 'POST',
      body: JSON.stringify({
        company: '测试保险',
        name: '尊享人生两全',
      }),
    });
    assert.equal(matched.response.status, 200);
    assert.equal(matched.payload.matches.length, 3);
    assert.equal(feishuCalled, false);
  } finally {
    await server.close();
  }
});

test('responsibility assistant local matches honor insurer aliases for New China inputs', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      sourceRecords: [],
      pendingScans: [],
      officialDomainProfiles: [],
      knowledgeRecords: [
        {
          id: 1,
          company: '新华保险',
          productName: '新华人寿保险股份有限公司健康无忧重大疾病保险（专享版）',
          title: '新华人寿保险股份有限公司健康无忧重大疾病保险（专享版）',
          url: 'https://static-cdn.newchinalife.com/ncl/pdf/health.pdf',
          pageText: '保险责任包括重大疾病保险金。',
          official: true,
          sourceType: 'pdf',
          materialType: 'terms',
        },
      ],
      policies: [],
      nextId: 2,
    },
  });
  const server = await listen(app);

  try {
    const matched = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/matches', {
      method: 'POST',
      body: JSON.stringify({
        company: '新华人寿',
        name: '健康无忧',
        limit: 20,
        minScore: 0.1,
      }),
    });
    assert.equal(matched.response.status, 200);
    assert.equal(matched.payload.matches.length, 1);
    assert.equal(matched.payload.matches[0].company, '新华保险');
    assert.equal(matched.payload.matches[0].productName, '新华人寿保险股份有限公司健康无忧重大疾病保险（专享版）');
  } finally {
    await server.close();
  }
});

test('responsibility assistant local matches can include more than three candidates above a custom score threshold', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      sourceRecords: [],
      pendingScans: [],
      officialDomainProfiles: [
        {
          id: 'example-life',
          company: '测试保险',
          aliases: ['测试保险'],
          siteDomains: ['official.example-life.test'],
          officialDomains: ['official.example-life.test'],
        },
      ],
      knowledgeRecords: [
        '尊享人生年金保险（分红型）',
        '尊尚人生两全保险（分红型）',
        '美利人生两全保险（分红型）',
        '卓越人生两全保险',
        '安享人生医疗保险',
      ].map((productName, index) => ({
        id: index + 1,
        company: '测试保险',
        productName,
        title: `${productName}条款`,
        url: `https://official.example-life.test/product-${index + 1}.pdf`,
        pageText: '保险责任包括生存保险金、满期保险金、身故保险金。',
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
      })),
      policies: [],
      nextId: 6,
    },
  });
  const server = await listen(app);

  try {
    const matched = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/matches', {
      method: 'POST',
      body: JSON.stringify({
        company: '测试保险',
        name: '尊享人生两全',
        limit: 20,
        minScore: 0.1,
      }),
    });
    assert.equal(matched.response.status, 200);
    assert.equal(matched.payload.matches.length, 5);
    assert.ok(matched.payload.matches.some((item) => item.productName === '安享人生医疗保险'));
    assert.ok(matched.payload.matches.every((item) => item.score >= 0.1));
  } finally {
    await server.close();
  }
});

test('admin can login and read all accounts, insured groups, and policies', async () => {
  const app = createPolicyOcrApp({
    adminPassword: 'admin-pass',
    state: {
      users: [
        { id: 1, mobile: '13800000000', createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' },
      ],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      pendingScans: [],
      sourceRecords: [
        {
          id: 3,
          policyId: 2,
          company: '中国平安保险',
          productName: '平安福重大疾病保险',
          title: '中国平安 平安福 保险条款与保险责任',
          url: 'https://www.pingan.com/official/productSeo/pinganfu-demo',
          evidenceLabel: '保险公司官方资料',
          evidenceLevel: 'insurer_official',
          official: true,
          sourceType: 'html',
          discoveredAt: '2026-05-02T00:00:00.000Z',
          lastUsedAt: '2026-05-02T00:00:00.000Z',
          useCount: 1,
        },
      ],
      policies: [
        {
          id: 2,
          userId: 1,
          guestId: '',
          company: '中国平安保险',
          name: '平安福重大疾病保险',
          applicant: '李四',
          insured: '李四',
          date: '2026-04-01',
          paymentPeriod: '20年',
          coveragePeriod: '终身',
          amount: 500000,
          firstPremium: 12000,
          ocrText: 'PING AN 中国平安保险 平安福重大疾病保险',
          responsibilities: [
            {
              coverageType: '重大疾病保险金',
              scenario: '确诊合同约定重大疾病',
              payout: '给付基本保险金额50万元',
              note: '',
            },
          ],
          report: '平安福保障摘要',
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z',
        },
      ],
      nextId: 3,
    },
  });
  const server = await listen(app);

  try {
    const denied = await jsonFetch(server.baseUrl, '/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(denied.response.status, 401);

    const loggedIn = await jsonFetch(server.baseUrl, '/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'admin-pass' }),
    });
    assert.equal(loggedIn.response.status, 200);
    assert.ok(loggedIn.payload.token);

    const overview = await jsonFetch(server.baseUrl, '/api/admin/overview', {
      headers: { authorization: `Bearer ${loggedIn.payload.token}` },
    });
    assert.equal(overview.response.status, 200);
    assert.equal(overview.payload.summary.userCount, 1);
    assert.equal(overview.payload.summary.insuredCount, 1);
    assert.equal(overview.payload.summary.policyCount, 1);
    assert.equal(overview.payload.users[0].mobile, '13800000000');
    assert.equal(overview.payload.insureds[0].insured, '李四');
    assert.equal(overview.payload.policies[0].userMobile, '13800000000');
    assert.equal(overview.payload.policies[0].name, '平安福重大疾病保险');
    assert.equal(overview.payload.policies[0].sources[0].url, 'https://www.pingan.com/official/productSeo/pinganfu-demo');
    assert.equal(overview.payload.summary.sourceRecordCount, 1);
    assert.equal(overview.payload.sourceRecords[0].url, 'https://www.pingan.com/official/productSeo/pinganfu-demo');
  } finally {
    await server.close();
  }
});

test('policy list attaches local indicator records for matched policy plans', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [{ id: 1, mobile: '13800000000', createdAt: '2026-05-01T00:00:00.000Z' }],
      sessions: [{ token: 'user-token', userId: 1, createdAt: '2026-05-01T00:01:00.000Z' }],
      smsCodes: [],
      policies: [
        {
          id: 2,
          userId: 1,
          guestId: '',
          company: '新华保险',
          name: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
          applicant: '冯力',
          insured: '冯力',
          amount: 60000,
          firstPremium: 3296,
          plans: [
            {
              company: '新华保险',
              role: 'main',
              name: '畅行万里智赢版两全保险',
              matchedProductName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
              amount: 60000,
            },
          ],
          responsibilities: [
            {
              coverageType: '保险责任',
              scenario: '新华保险[2024]两全保险050号，按基本保险金额的15倍给付',
              payout: '以正式条款为准',
              note: '',
            },
          ],
          createdAt: '2026-05-01T00:03:00.000Z',
          updatedAt: '2026-05-01T00:03:00.000Z',
        },
      ],
      insuranceIndicatorRecords: [
        {
          id: 'ind-accident-1',
          company: '新华保险',
          productName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
          productType: '意外险、两全保险',
          salesStatus: '停售',
          coverageType: '意外保障',
          liability: '一般意外身故/全残',
          value: 10,
          valueText: '10',
          unit: '倍',
          basis: '基本保额',
          formulaText: '基本保额 × 10',
          sourceRecordId: '784',
        },
        {
          id: 'ind-accident-2',
          company: '新华保险',
          productName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
          productType: '意外险、两全保险',
          salesStatus: '停售',
          coverageType: '意外保障',
          liability: '步行/骑行交通意外',
          value: 15,
          valueText: '15',
          unit: '倍',
          basis: '基本保额',
          formulaText: '基本保额 × 15',
          sourceRecordId: '784',
        },
        {
          id: 'ind-accident-3',
          company: '新华保险',
          productName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
          productType: '意外险、两全保险',
          salesStatus: '停售',
          coverageType: '意外保障',
          liability: '驾乘意外',
          value: 20,
          valueText: '20',
          unit: '倍',
          basis: '基本保额',
          formulaText: '基本保额 × 20',
          sourceRecordId: '784',
        },
        {
          id: 'ind-accident-4',
          company: '新华保险',
          productName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
          productType: '意外险、两全保险',
          salesStatus: '停售',
          coverageType: '意外保障',
          liability: '高空坠物/抛物意外',
          value: 20,
          valueText: '20',
          unit: '倍',
          basis: '基本保额',
          formulaText: '基本保额 × 20',
          sourceRecordId: '784',
        },
        {
          id: 'ind-accident-5',
          company: '新华保险',
          productName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
          productType: '意外险、两全保险',
          salesStatus: '停售',
          coverageType: '意外保障',
          liability: '客运轮船/汽车意外',
          value: 30,
          valueText: '30',
          unit: '倍',
          basis: '基本保额',
          formulaText: '基本保额 × 30',
          sourceRecordId: '784',
        },
        {
          id: 'ind-accident-6',
          company: '新华保险',
          productName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
          productType: '意外险、两全保险',
          salesStatus: '停售',
          coverageType: '意外保障',
          liability: '电梯意外',
          value: 30,
          valueText: '30',
          unit: '倍',
          basis: '基本保额',
          formulaText: '基本保额 × 30',
          sourceRecordId: '784',
        },
        {
          id: 'ind-accident-7',
          company: '新华保险',
          productName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
          productType: '意外险、两全保险',
          salesStatus: '停售',
          coverageType: '意外保障',
          liability: '公共场所特定事故',
          value: 40,
          valueText: '40',
          unit: '倍',
          basis: '基本保额',
          formulaText: '基本保额 × 40',
          sourceRecordId: '784',
        },
        {
          id: 'ind-accident-8',
          company: '新华保险',
          productName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
          productType: '意外险、两全保险',
          salesStatus: '停售',
          coverageType: '意外保障',
          liability: '重大自然灾害',
          value: 40,
          valueText: '40',
          unit: '倍',
          basis: '基本保额',
          formulaText: '基本保额 × 40',
          sourceRecordId: '784',
        },
        {
          id: 'ind-accident-9',
          company: '新华保险',
          productName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
          productType: '意外险、两全保险',
          salesStatus: '停售',
          coverageType: '意外保障',
          liability: '客运列车/航空意外',
          value: 60,
          valueText: '60',
          unit: '倍',
          basis: '基本保额',
          formulaText: '基本保额 × 60',
          sourceRecordId: '784',
        },
        {
          id: 'ind-maturity',
          company: '新华保险',
          productName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
          productType: '意外险、两全保险',
          salesStatus: '停售',
          coverageType: '现金流',
          liability: '满期返还',
          value: null,
          valueText: '',
          unit: '公式',
          basis: '已交保费',
          formulaText: '满期返还 = 基本保险金额',
          sourceRecordId: '784',
        },
      ],
      nextId: 3,
    },
  });
  const server = await listen(app);

  try {
    const list = await jsonFetch(server.baseUrl, '/api/policies', {
      headers: { authorization: 'Bearer user-token' },
    });
    assert.equal(list.response.status, 200);
    assert.equal(list.payload.policies.length, 1);
    assert.deepEqual(
      list.payload.policies[0].coverageIndicators.map((row) => ({
        coverageType: row.coverageType,
        liability: row.liability,
        value: row.value,
        unit: row.unit,
        basis: row.basis,
        formulaText: row.formulaText,
        sourceRecordId: row.sourceRecordId,
      })),
      [
        {
          coverageType: '意外保障',
          liability: '一般意外身故/全残',
          value: 10,
          unit: '倍',
          basis: '基本保额',
          formulaText: '基本保额 × 10',
          sourceRecordId: '784',
        },
        {
          coverageType: '意外保障',
          liability: '步行/骑行交通意外',
          value: 15,
          unit: '倍',
          basis: '基本保额',
          formulaText: '基本保额 × 15',
          sourceRecordId: '784',
        },
        {
          coverageType: '意外保障',
          liability: '驾乘意外',
          value: 20,
          unit: '倍',
          basis: '基本保额',
          formulaText: '基本保额 × 20',
          sourceRecordId: '784',
        },
        {
          coverageType: '意外保障',
          liability: '高空坠物/抛物意外',
          value: 20,
          unit: '倍',
          basis: '基本保额',
          formulaText: '基本保额 × 20',
          sourceRecordId: '784',
        },
        {
          coverageType: '意外保障',
          liability: '客运轮船/汽车意外',
          value: 30,
          unit: '倍',
          basis: '基本保额',
          formulaText: '基本保额 × 30',
          sourceRecordId: '784',
        },
        {
          coverageType: '意外保障',
          liability: '电梯意外',
          value: 30,
          unit: '倍',
          basis: '基本保额',
          formulaText: '基本保额 × 30',
          sourceRecordId: '784',
        },
        {
          coverageType: '意外保障',
          liability: '公共场所特定事故',
          value: 40,
          unit: '倍',
          basis: '基本保额',
          formulaText: '基本保额 × 40',
          sourceRecordId: '784',
        },
        {
          coverageType: '意外保障',
          liability: '重大自然灾害',
          value: 40,
          unit: '倍',
          basis: '基本保额',
          formulaText: '基本保额 × 40',
          sourceRecordId: '784',
        },
        {
          coverageType: '意外保障',
          liability: '客运列车/航空意外',
          value: 60,
          unit: '倍',
          basis: '基本保额',
          formulaText: '基本保额 × 60',
          sourceRecordId: '784',
        },
        {
          coverageType: '现金流',
          liability: '满期返还',
          value: null,
          unit: '公式',
          basis: '已交保费',
          formulaText: '满期返还 = 基本保险金额',
          sourceRecordId: '784',
        },
      ],
    );
  } finally {
    await server.close();
  }
});

test('policy list returns persisted cash values so real family reports can draw wealth charts', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS policies (id INTEGER PRIMARY KEY)');
  db.prepare('INSERT INTO policies (id) VALUES (?)').run(500549);
  const cashflowStore = createCashflowStore(db);
  const cashValueStore = createCashValueStore(db);
  cashflowStore.replaceEntries(500549, [
    {
      year: 2030,
      age: 42,
      amount: 1465,
      cumulative: 1465,
      liability: '生存保险金',
      calcText: '基本保额 = 1,465元',
    },
  ]);
  cashValueStore.replaceValues(500549, [
    { policyYear: 1, age: null, cashValue: 282, source: 'ocr' },
    { policyYear: 2, age: null, cashValue: 663, source: 'ocr' },
    { policyYear: 3, age: null, cashValue: 1296, source: 'ocr' },
  ]);
  const app = createPolicyOcrApp({
    db,
    state: {
      users: [{ id: 1, mobile: '13800000000', createdAt: '2026-05-01T00:00:00.000Z' }],
      sessions: [{ token: 'user-token', userId: 1, createdAt: '2026-05-01T00:01:00.000Z' }],
      smsCodes: [],
      policies: [
        {
          id: 500549,
          userId: 1,
          guestId: '',
          company: '新华保险',
          name: '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）',
          applicant: '温舒萍',
          insured: '温舒萍',
          insuredBirthday: '1988-12-16',
          date: '2025-12-22',
          paymentPeriod: '2年交',
          coveragePeriod: '至85岁',
          amount: 1465,
          firstPremium: 19600,
          createdAt: '2026-05-28T17:06:56.018Z',
          updatedAt: '2026-05-28T19:49:53.416Z',
          responsibilities: [
            {
              coverageType: '现金流',
              liability: '生存保险金',
              value: 1465,
              unit: '元',
              basis: '固定金额',
            },
          ],
          reportStatus: 'ready',
        },
      ],
      pendingScans: [],
      insuranceIndicatorRecords: [],
      nextId: 500600,
    },
  });
  const server = await listen(app);

  try {
    const list = await jsonFetch(server.baseUrl, '/api/policies', {
      headers: { authorization: 'Bearer user-token' },
    });

    assert.equal(list.response.status, 200);
    assert.equal(list.payload.policies.length, 1);
    assert.deepEqual(
      list.payload.policies[0].cashValues.map((row) => ({
        policyYear: row.policyYear,
        age: row.age,
        cashValue: row.cashValue,
      })),
      [
        { policyYear: 1, age: null, cashValue: 282 },
        { policyYear: 2, age: null, cashValue: 663 },
        { policyYear: 3, age: null, cashValue: 1296 },
      ],
    );

    const report = buildFamilyReport(list.payload.policies);
    const wealthPolicy = report.wealth.memberReports
      .find((member) => member.member === '温舒萍')
      .policies.find((policy) => Number(policy.policyId) === 500549);
    assert.equal(wealthPolicy.cashValueRows.length, 3);
    assert.equal(wealthPolicy.cashValueRows[0].calendarYear, 2026);
    assert.equal(report.summary.cashValueTotal, 1296);
  } finally {
    await server.close();
    db.close();
  }
});

test('policy app recomputes cashflow cache on startup for persisted policies', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS policies (id INTEGER PRIMARY KEY)');
  db.prepare('INSERT INTO policies (id) VALUES (?)').run(500700);
  const app = createPolicyOcrApp({
    db,
    state: {
      users: [{ id: 1, mobile: '13800000000', createdAt: '2026-05-01T00:00:00.000Z' }],
      sessions: [{ token: 'user-token', userId: 1, createdAt: '2026-05-01T00:01:00.000Z' }],
      smsCodes: [],
      policies: [
        {
          id: 500700,
          userId: 1,
          guestId: '',
          company: '新华保险',
          name: '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）',
          applicant: '温舒萍',
          insured: '温舒萍',
          insuredBirthday: '1988-12-16',
          date: '2025-12-22',
          paymentPeriod: '2年交',
          coveragePeriod: '至85周岁',
          amount: 1465,
          firstPremium: 19600,
          createdAt: '2026-05-28T17:06:56.018Z',
          updatedAt: '2026-05-28T19:49:53.416Z',
          reportStatus: 'ready',
        },
      ],
      pendingScans: [],
      knowledgeRecords: [],
      insuranceIndicatorRecords: [
        {
          id: 'ind_cashflow_startup_1',
          company: '新华保险',
          productName: '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）',
          coverageType: '现金流',
          liability: '满期生存保险金',
          value: 100,
          unit: '%',
          basis: '基本保额',
          condition: '保障期满',
        },
      ],
      nextId: 500701,
    },
  });
  const server = await listen(app);

  try {
    const list = await jsonFetch(server.baseUrl, '/api/policies', {
      headers: { authorization: 'Bearer user-token' },
    });

    assert.equal(list.response.status, 200);
    assert.equal(list.payload.policies.length, 1);
    assert.deepEqual(
      list.payload.policies[0].cashflowEntries.map((entry) => ({
        year: entry.year,
        age: entry.age,
        amount: entry.amount,
        cumulative: entry.cumulative,
        liability: entry.liability,
      })),
      [
        {
          year: 2073,
          age: 85,
          amount: 1465,
          cumulative: 1465,
          liability: '满期生存保险金',
        },
      ],
    );

    const detail = await jsonFetch(server.baseUrl, '/api/policies/500700', {
      headers: { authorization: 'Bearer user-token' },
    });
    assert.equal(detail.response.status, 200);
    assert.equal(detail.payload.policy.cashflowEntries.length, 1);
    assert.equal(detail.payload.policy.totalCashflow, 1465);
    assert.deepEqual(
      detail.payload.policy.cashflowEntries.map((entry) => ({
        year: entry.year,
        age: entry.age,
        amount: entry.amount,
        cumulative: entry.cumulative,
        liability: entry.liability,
      })),
      list.payload.policies[0].cashflowEntries.map((entry) => ({
        year: entry.year,
        age: entry.age,
        amount: entry.amount,
        cumulative: entry.cumulative,
        liability: entry.liability,
      })),
    );
  } finally {
    await server.close();
    db.close();
  }
});

test('policy app startup cashflow recompute skips cache writes without a persisted policy parent', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS policies (id INTEGER PRIMARY KEY)');
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => {
    errors.push(args);
  };

  try {
    createPolicyOcrApp({
      db,
      state: {
        users: [{ id: 1, mobile: '13800000000', createdAt: '2026-05-01T00:00:00.000Z' }],
        sessions: [{ token: 'user-token', userId: 1, createdAt: '2026-05-01T00:01:00.000Z' }],
        smsCodes: [],
        policies: [
          {
            id: 500701,
            userId: 1,
            guestId: '',
            company: '新华保险',
            name: '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）',
            insured: '温舒萍',
            insuredBirthday: '1988-12-16',
            date: '2025-12-22',
            paymentPeriod: '2年交',
            coveragePeriod: '至85周岁',
            amount: 1465,
            firstPremium: 19600,
            createdAt: '2026-05-28T17:06:56.018Z',
            updatedAt: '2026-05-28T19:49:53.416Z',
            reportStatus: 'ready',
          },
        ],
        pendingScans: [],
        knowledgeRecords: [],
        insuranceIndicatorRecords: [
          {
            id: 'ind_cashflow_startup_2',
            company: '新华保险',
            productName: '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）',
            coverageType: '现金流',
            liability: '满期生存保险金',
            value: 100,
            unit: '%',
            basis: '基本保额',
            condition: '保障期满',
          },
        ],
        nextId: 500702,
      },
    });

    assert.deepEqual(errors, []);
  } finally {
    console.error = originalError;
    db.close();
  }
});

test('admin can maintain insurer official domain whitelist profiles', async () => {
  const persisted = [];
  const app = createPolicyOcrApp({
    adminPassword: 'admin-pass',
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      pendingScans: [],
      policies: [],
      sourceRecords: [],
      officialDomainProfiles: [],
      nextId: 1,
    },
    persist: async (state) => {
      persisted.push(JSON.parse(JSON.stringify(state.officialDomainProfiles || [])));
    },
  });
  const server = await listen(app);

  try {
    const loggedIn = await jsonFetch(server.baseUrl, '/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'admin-pass' }),
    });
    const headers = { authorization: `Bearer ${loggedIn.payload.token}` };

    const created = await jsonFetch(server.baseUrl, '/api/admin/official-domain-profiles', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        company: '测试保险',
        aliases: ['测试保险', '测试人寿'],
        officialDomains: ['https://official.example-life.test', 'static.example-life.test'],
        siteDomains: ['official.example-life.test'],
      }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.profile.company, '测试保险');
    assert.deepEqual(created.payload.profile.officialDomains, ['official.example-life.test', 'static.example-life.test']);
    assert.equal(app.locals.state.officialDomainProfiles.length, 1);

    const list = await jsonFetch(server.baseUrl, '/api/admin/official-domain-profiles', { headers });
    assert.equal(list.response.status, 200);
    assert.ok(list.payload.profiles.some((profile) => profile.id === created.payload.profile.id && profile.source === 'custom'));
    assert.ok(list.payload.profiles.some((profile) => profile.id === 'ping_an_life' && profile.source === 'system'));

    const updated = await jsonFetch(server.baseUrl, `/api/admin/official-domain-profiles/${created.payload.profile.id}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        company: '测试保险',
        aliases: ['测试保险'],
        officialDomains: ['official-updated.example-life.test'],
        siteDomains: ['official-updated.example-life.test'],
      }),
    });
    assert.equal(updated.response.status, 200);
    assert.deepEqual(updated.payload.profile.officialDomains, ['official-updated.example-life.test']);

    const deleted = await jsonFetch(server.baseUrl, `/api/admin/official-domain-profiles/${created.payload.profile.id}`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(deleted.response.status, 200);
    assert.equal(app.locals.state.officialDomainProfiles.length, 0);
    assert.ok(persisted.length >= 3);
  } finally {
    await server.close();
  }
});

test('admin can crawl official product materials into local knowledge base', async () => {
  const persisted = [];
  const calls = [];
  const app = createPolicyOcrApp({
    adminPassword: 'admin-pass',
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      pendingScans: [],
      policies: [],
      sourceRecords: [],
      knowledgeRecords: [],
      officialDomainProfiles: [
        {
          id: 'example_life',
          company: '测试保险',
          aliases: ['测试保险'],
          companyAliases: ['测试保险'],
          siteDomains: ['official.example-life.test'],
          officialDomains: ['official.example-life.test'],
        },
      ],
      nextId: 1,
    },
    knowledgeFetchImpl: async (url) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://official.example-life.test/') {
        return textResponse(`
          <main>
            <a href="/products/winying-one.html">稳赢一号保险条款</a>
          </main>
        `);
      }
      if (href === 'https://official.example-life.test/products/winying-one.html') {
        return textResponse(`
          <article>
            <h1>稳赢一号保险条款</h1>
            <p>稳赢一号保险责任包括身故保险金，达到合同约定条件后按基本保险金额给付。</p>
          </article>
        `);
      }
      return notFoundResponse();
    },
    persist: async (state) => {
      persisted.push(JSON.parse(JSON.stringify(state.knowledgeRecords || [])));
    },
  });
  const server = await listen(app);

  try {
    const loggedIn = await jsonFetch(server.baseUrl, '/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'admin-pass' }),
    });
    const headers = { authorization: `Bearer ${loggedIn.payload.token}` };

    const crawled = await jsonFetch(server.baseUrl, '/api/admin/knowledge-crawl', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        company: '测试保险',
        name: '稳赢一号',
      }),
    });
    assert.equal(crawled.response.status, 200);
    assert.equal(crawled.payload.savedCount, 1);
    assert.equal(app.locals.state.knowledgeRecords.length, 1);
    assert.equal(app.locals.state.knowledgeRecords[0].url, 'https://official.example-life.test/products/winying-one.html');
    assert.match(app.locals.state.knowledgeRecords[0].pageText, /身故保险金/u);
    assert.ok(calls.includes('https://official.example-life.test/'));

    const listed = await jsonFetch(server.baseUrl, '/api/admin/knowledge-records', { headers });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.payload.summary.count, 1);
    assert.equal(listed.payload.records[0].company, '测试保险');
    assert.ok(persisted.length >= 1);
  } finally {
    await server.close();
  }
});

test('admin overview lists optional responsibility quantification gaps and can mark one not quantifiable', async () => {
  const state = {
    users: [],
    adminSessions: [],
    sessions: [],
    smsCodes: [],
    policies: [
      {
        id: 1,
        userId: null,
        guestId: 'guest-gap',
        company: '新华保险',
        name: '测试重疾',
        insured: '妈妈',
        optionalResponsibilities: [
          {
            id: 'opt_gap',
            productName: '测试重疾',
            liability: '可选责任一',
            responsibilityScope: 'optional',
            selectionStatus: 'selected',
            quantificationStatus: 'pending_review',
            quantificationReason: '缺少可计算结构化指标',
          },
        ],
        createdAt: '2026-05-31T00:00:00.000Z',
      },
    ],
    pendingScans: [],
    sourceRecords: [],
    knowledgeRecords: [],
    insuranceIndicatorRecords: [],
    optionalResponsibilityRecords: [
      {
        id: 'opt_gap',
        company: '新华保险',
        productName: '测试重疾',
        liability: '可选责任一',
        quantificationStatus: 'pending_review',
        quantificationReason: '缺少可计算结构化指标',
        indicatorIds: [],
      },
    ],
    nextId: 2,
  };
  const app = createPolicyOcrApp({ state, adminPassword: 'admin123456' });
  const server = await listen(app);

  try {
    const login = await jsonFetch(server.baseUrl, '/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'admin123456' }),
    });
    const token = login.payload.token;

    const overview = await jsonFetch(server.baseUrl, '/api/admin/overview', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(overview.payload.optionalResponsibilityGaps.length, 1);
    assert.equal(overview.payload.optionalResponsibilityGaps[0].recentPolicyCount, 1);

    const updated = await jsonFetch(server.baseUrl, '/api/admin/optional-responsibilities/opt_gap/not-quantifiable', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason: '该责任仅提示权益，不进入金额计算' }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.record.quantificationStatus, 'not_quantifiable');
  } finally {
    await server.close();
  }
});

test('xinhua optional critical illness policy shows selected quantified optional responsibility', async () => {
  const productName = '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）';
  const state = {
    users: [],
    sessions: [],
    smsCodes: [],
    adminSessions: [],
    policies: [],
    pendingScans: [],
    sourceRecords: [],
    knowledgeRecords: [
      {
        id: 1,
        company: '新华保险',
        productName,
        pageText: '保险责任。3.可选责任一 （1）轻度疾病保险金 被保险人确诊轻度疾病，我们按基本保险金额的20%给付轻度疾病保险金。（2）中度疾病保险金 按基本保险金额的50%给付。',
      },
    ],
    insuranceIndicatorRecords: [],
    optionalResponsibilityRecords: [],
    nextId: 2,
  };
  Object.assign(state, rebuildOptionalResponsibilityGovernance(state));
  const app = createPolicyOcrApp({
    state,
    analyzer: async () => ({
      report: '测试报告',
      coverageTable: [],
      optionalResponsibilities: [],
    }),
  });
  const server = await listen(app);

  try {
    const analyzed = await jsonFetch(server.baseUrl, '/api/policies/analyze', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-xinhua-optional',
        scan: {
          ocrText: '备注:《多倍保障重大疾病保险（智赢版）》的保险责任包含基本责任和可选责任一。可选责任一经确定，在本合同保险期间内不得变更。',
          data: {
            company: '新华保险',
            name: productName,
            applicant: '温舒萍',
            insured: '温舒萍',
            date: '2024-11-01',
            paymentPeriod: '15年交',
            coveragePeriod: '终身',
            amount: 60000,
            firstPremium: 3030,
          },
        },
      }),
    });

    const optionalOne = analyzed.payload.analysis.optionalResponsibilities.find((item) => item.liability === '可选责任一');
    assert.equal(optionalOne.selectionStatus, 'selected');
    assert.equal(optionalOne.quantificationStatus, 'quantified');
    assert.ok(optionalOne.indicatorIds.length >= 1);
  } finally {
    await server.close();
  }
});

test('recognize persists optional responsibility governance records to sqlite table', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  const productName = '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）';
  const state = createInitialState();
  state.knowledgeRecords = [
    {
      id: 1,
      company: '新华保险',
      productName,
      title: productName,
      url: 'https://static-cdn.newchinalife.com/ncl/pdf/ying.pdf',
      pageText: [
        '保险责任 本合同的保险责任分为基本责任和可选责任。',
        '3.可选责任一 （1）轻度疾病保险金 被保险人确诊轻度疾病，我们按基本保险金额的20%给付轻度疾病保险金。',
        '（2）中度疾病保险金 被保险人确诊中度疾病，我们按基本保险金额的50%给付中度疾病保险金。',
      ].join('\n'),
      official: true,
      sourceType: 'pdf',
      materialType: 'terms',
    },
  ];
  await store.persist(state);
  const loadedState = await store.load();
  const app = createPolicyOcrApp({
    state: loadedState,
    persist: store.persist,
    db: store.db,
    scanner: async () => ({
      ocrText: `新华保险 ${productName} 已投保可选责任一`,
      data: {
        company: '新华保险',
        name: productName,
        applicant: '张三',
        insured: '张三',
        plans: [
          {
            company: '新华保险',
            role: 'main',
            name: '多倍保障重大疾病保险（智赢版）',
            matchedProductName: productName,
          },
        ],
      },
    }),
  });
  const server = await listen(app);

  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-persist-optional-governance',
        uploadItem: {
          name: 'policy.jpg',
          type: 'image/jpeg',
          size: 1,
          dataUrl: 'data:image/jpeg;base64,QQ==',
        },
      }),
    });

    assert.equal(recognized.response.status, 200);
    assert.ok(recognized.payload.analysis.optionalResponsibilities.some((item) => item.liability === '可选责任一'));

    const rows = store.db.prepare(`
      SELECT id, product_name, liability, payload
      FROM optional_responsibility_records
      WHERE product_name = ?
      ORDER BY liability ASC
    `).all(productName);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].liability, '可选责任一');
    const payload = JSON.parse(rows[0].payload);
    assert.match(payload.sourceExcerpt, /轻度疾病保险金/u);
    assert.equal(payload.quantificationStatus, 'quantified');
    assert.ok(Array.isArray(payload.indicatorIds) && payload.indicatorIds.length >= 1);
  } finally {
    await server.close();
    store.close();
  }
});

test('recognize endpoint returns exact local responsibility draft for matched New China product', async () => {
  const productName = '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）';
  const state = {
    users: [],
    sessions: [],
    smsCodes: [],
    adminSessions: [],
    policies: [],
    pendingScans: [],
    sourceRecords: [],
    knowledgeRecords: [
      {
        id: 1,
        company: '新华保险',
        productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）',
        title: '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）',
        url: 'https://static-cdn.newchinalife.com/ncl/pdf/ying.pdf',
        pageText: '保险责任 智赢版责任文本。',
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
        updatedAt: '2026-05-31T00:00:00.000Z',
      },
      {
        id: 2,
        company: '新华保险',
        productName,
        title: productName,
        url: 'https://static-cdn.newchinalife.com/ncl/pdf/xiang.pdf',
        pageText: '保险责任。3.可选责任一 （1）轻度疾病保险金 按基本保险金额的20%给付。4.可选责任二重度恶性肿瘤多次给付保险金 我们按基本保险金额给付重度恶性肿瘤多次给付保险金。',
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
    ],
    insuranceIndicatorRecords: [],
    optionalResponsibilityRecords: [],
    nextId: 2,
  };
  Object.assign(state, rebuildOptionalResponsibilityGovernance(state));
  const app = createPolicyOcrApp({
    state,
    scanner: async () => ({
      ocrText: `新华保险 ${productName}保险`,
      data: {
        company: '新华保险',
        name: `${productName}保险`,
        coveragePeriod: '终身',
        amount: 170000,
      },
    }),
  });
  const server = await listen(app);

  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-xinhua-recognize-local-responsibility',
        uploadItem: null,
        ocrText: `新华保险 ${productName}保险`,
      }),
    });

    assert.equal(recognized.response.status, 200);
    assert.equal(recognized.payload.analysis.coverageTable.length, 1);
    assert.equal(recognized.payload.analysis.coverageTable[0].sourceTitle, productName);
    assert.equal(recognized.payload.analysis.coverageTable[0].sourceUrl, 'https://static-cdn.newchinalife.com/ncl/pdf/xiang.pdf');
    assert.match(recognized.payload.analysis.coverageTable[0].scenario, /智享版|可选责任二/u);
    assert.doesNotMatch(recognized.payload.analysis.coverageTable[0].scenario, /智赢版责任文本/u);
    assert.ok(recognized.payload.analysis.optionalResponsibilities.some((item) => item.liability === '可选责任二'));
  } finally {
    await server.close();
  }
});

test('analyze keeps OCR rider match when stale manual rider name matches the main plan', async () => {
  const state = {
    users: [],
    sessions: [],
    smsCodes: [],
    adminSessions: [],
    policies: [],
    pendingScans: [],
    sourceRecords: [],
    knowledgeRecords: [
      {
        id: 1,
        company: '新华保险',
        productName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
        title: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
        url: 'https://example.com/main.pdf',
      },
      {
        id: 2,
        company: '新华保险',
        productName: '新华人寿保险股份有限公司i他男性特定疾病保险',
        title: '新华人寿保险股份有限公司i他男性特定疾病保险',
        url: 'https://example.com/rider.pdf',
      },
    ],
    insuranceIndicatorRecords: [],
    optionalResponsibilityRecords: [],
    officialDomainProfiles: [],
    familyProfiles: [],
    familyMembers: [],
    familyReportShares: [],
    nextId: 1,
  };
  const app = createPolicyOcrApp({
    state,
    scanner: async () => ({
      ocrText: '新华保险 畅行万里智赢版两全保险 i他男性特定疾病保险',
      data: {
        company: '新华保险',
        name: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
        plans: [
          {
            company: '新华保险',
            role: 'main',
            name: '畅行万里智赢版两全保险',
            matchedProductName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
            premium: 3156,
          },
          {
            company: '新华保险',
            role: 'rider',
            name: 'i他男性特定疾病保险',
            matchedProductName: '新华人寿保险股份有限公司i他男性特定疾病保险',
            premium: 140,
          },
        ],
      },
    }),
    analyzer: async () => ({
      report: '测试报告',
      coverageTable: [],
      optionalResponsibilities: [],
    }),
  });
  const server = await listen(app);

  try {
    const analyzed = await jsonFetch(server.baseUrl, '/api/policies/analyze', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-stale-rider-name',
        uploadItem: {
          name: 'policy.jpg',
          type: 'image/jpeg',
          size: 123,
          dataUrl: 'data:image/jpeg;base64,QQ==',
        },
        manualData: {
          company: '新华保险',
          name: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
          plans: [
            {
              company: '新华保险',
              role: 'main',
              name: '畅行万里智赢版两全保险',
              matchedProductName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
              premium: 3156,
            },
            {
              company: '新华保险',
              role: 'rider',
              name: '畅行万里智赢版两全保险',
              matchedProductName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
              premium: 140,
            },
          ],
        },
      }),
    });

    assert.equal(analyzed.response.status, 200);
    assert.equal(analyzed.payload.scan.data.plans[1].name, 'i他男性特定疾病保险');
    assert.equal(analyzed.payload.scan.data.plans[1].matchedProductName, '新华人寿保险股份有限公司i他男性特定疾病保险');
  } finally {
    await server.close();
  }
});

test('local responsibility draft endpoint returns optional responsibilities for entry form confirmation', async () => {
  const productName = '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）';
  const riderProductName = '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）';
  const state = createInitialState();
  state.knowledgeRecords = [
    {
      id: 1,
      company: '新华保险',
      productName,
      title: productName,
      url: 'https://static-cdn.newchinalife.com/ncl/pdf/xiang.pdf',
      pageText: '保险责任。3.可选责任一 （1）轻度疾病保险金 按基本保险金额的20%给付。4.可选责任二重度恶性肿瘤多次给付保险金 我们按基本保险金额给付重度恶性肿瘤多次给付保险金。',
      official: true,
      sourceType: 'pdf',
      materialType: 'terms',
    },
    {
      id: 2,
      company: '新华保险',
      productName: riderProductName,
      title: riderProductName,
      url: 'https://static-cdn.newchinalife.com/ncl/pdf/ying.pdf',
      pageText: '保险责任。3.可选责任一 智赢版轻度疾病保险金。',
      official: true,
      sourceType: 'pdf',
      materialType: 'terms',
    },
  ];
  Object.assign(state, rebuildOptionalResponsibilityGovernance(state));
  const app = createPolicyOcrApp({ state });
  const server = await listen(app);

  try {
    const drafted = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/local-draft', {
      method: 'POST',
      body: JSON.stringify({
        manualData: {
          company: '新华保险',
          name: `${productName}保险`,
          amount: 170000,
          coveragePeriod: '终身',
        },
      }),
    });

    assert.equal(drafted.response.status, 200);
    assert.ok(drafted.payload.analysis.optionalResponsibilities.some((item) => item.liability === '可选责任一'));
    assert.ok(drafted.payload.analysis.optionalResponsibilities.some((item) => item.liability === '可选责任二'));

    const optionOne = drafted.payload.analysis.optionalResponsibilities.find((item) => item.liability === '可选责任一');
    const redrafted = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/local-draft', {
      method: 'POST',
      body: JSON.stringify({
        manualData: {
          company: '新华保险',
          name: `${productName}保险`,
          amount: 170000,
          coveragePeriod: '终身',
          plans: [
            {
              company: '新华保险',
              role: 'main',
              name: `${productName}保险`,
              matchedProductName: productName,
            },
            {
              company: '新华保险',
              role: 'rider',
              name: riderProductName,
              matchedProductName: riderProductName,
            },
          ],
          optionalResponsibilities: [
            {
              ...optionOne,
              selectionStatus: 'selected',
              selectionEvidence: 'manual',
            },
            {
              id: 'rider-optional-one',
              company: '新华保险',
              productName: riderProductName,
              coverageType: '可选责任',
              liability: '可选责任一',
              responsibilityScope: 'optional',
              selectionStatus: 'selected',
              selectionEvidence: 'manual',
            },
          ],
        },
      }),
    });
    const redraftedMainOptionOne = redrafted.payload.analysis.optionalResponsibilities
      .find((item) => item.productName === productName && item.liability === '可选责任一');
    const redraftedRiderOptionOne = redrafted.payload.analysis.optionalResponsibilities
      .find((item) => item.productName === riderProductName && item.liability === '可选责任一');
    assert.equal(redraftedMainOptionOne.selectionStatus, 'selected');
    assert.equal(redraftedMainOptionOne.selectionEvidence, 'manual');
    assert.equal(redraftedRiderOptionOne.selectionStatus, 'selected');
    assert.equal(redraftedRiderOptionOne.selectionEvidence, 'manual');
    assert.ok(redrafted.payload.analysis.optionalResponsibilities.some((item) => item.productName === productName));
    assert.ok(redrafted.payload.analysis.optionalResponsibilities.some((item) => item.productName === riderProductName));
  } finally {
    await server.close();
  }
});

test('scan endpoint preserves confirmed optional responsibilities when draft has no coverage table', async () => {
  const state = createInitialState();
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
  });
  const server = await listen(app);

  try {
    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-optional-only-analysis',
        scan: {
          ocrText: '新华保险 可选责任测试产品',
          data: {
            company: '新华保险',
            name: '可选责任测试产品',
            applicant: '张三',
            insured: '张三',
          },
        },
        analysis: {
          report: '',
          coverageTable: [],
          optionalResponsibilities: [
            {
              id: 'opt_entry_confirm',
              company: '新华保险',
              productName: '可选责任测试产品',
              coverageType: '可选责任',
              liability: '可选责任一',
              responsibilityScope: 'optional',
              selectionStatus: 'selected',
              selectionEvidence: 'manual',
            },
          ],
        },
      }),
    });

    assert.equal(saved.response.status, 201);
    assert.equal(saved.payload.policy.responsibilities.length, 0);
    assert.equal(saved.payload.policy.optionalResponsibilities.length, 1);
    assert.equal(saved.payload.policy.optionalResponsibilities[0].selectionStatus, 'selected');
    assert.equal(saved.payload.policy.reportStatus, 'ready');
  } finally {
    await server.close();
  }
});

test('family APIs create family, set core member, and save policy with participant member ids', async () => {
  const state = createInitialState();
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async () => ({
      ocrText: '投保人:张三\n被保险人:李四',
      data: { company: '新华保险', name: '测试保单', applicant: '张三', insured: '李四' },
    }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
  });
  const server = await listen(app);
  try {
    const familyRes = await jsonFetch(server.baseUrl, '/api/family-profiles?guestId=guest-family', {
      method: 'POST',
      body: JSON.stringify({ familyName: '张三家庭' }),
    });
    assert.equal(familyRes.response.status, 201);
    const familyId = familyRes.payload.family.id;

    const coreRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members?guestId=guest-family`, {
      method: 'POST',
      body: JSON.stringify({ name: '张三', relationLabel: '本人', setAsCore: true }),
    });
    const insuredRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members?guestId=guest-family`, {
      method: 'POST',
      body: JSON.stringify({ name: '李四', relationLabel: '配偶' }),
    });

    const scanRes = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-family',
        scan: { ocrText: '投保人:张三\n被保险人:李四', data: { company: '新华保险', name: '测试保单', applicant: '张三', insured: '李四' } },
        analysis: { report: 'ok', coverageTable: [] },
        manualData: {
          familyId,
          applicantMemberId: coreRes.payload.member.id,
          insuredMemberId: insuredRes.payload.member.id,
        },
      }),
    });

    assert.equal(scanRes.response.status, 201);
    assert.equal(scanRes.payload.policy.familyId, familyId);
    assert.equal(scanRes.payload.policy.applicantMemberId, coreRes.payload.member.id);
    assert.equal(scanRes.payload.policy.insuredMemberName, '李四');
    assert.equal(scanRes.payload.policy.insuredRelationLabel, '配偶');
  } finally {
    await server.close();
  }
});

test('family profile creation uses family-only persistence and skips optional responsibility governance rebuild', async () => {
  const state = createInitialState();
  let persistCount = 0;
  const familyPersistCalls = [];
  let governanceRebuildCount = 0;
  const app = createPolicyOcrApp({
    state,
    persist: async () => {
      persistCount += 1;
    },
    persistFamilyState: async (input) => {
      familyPersistCalls.push(input);
    },
    optionalResponsibilityGovernanceRebuilder: () => {
      governanceRebuildCount += 1;
      return {};
    },
  });
  const server = await listen(app);
  try {
    const familyRes = await jsonFetch(server.baseUrl, '/api/family-profiles?guestId=guest-family-fast-create', {
      method: 'POST',
      body: JSON.stringify({ familyName: '快速家庭' }),
    });

    assert.equal(familyRes.response.status, 201);
    assert.equal(persistCount, 0);
    assert.deepEqual(familyPersistCalls.map((call) => call.includePolicies), [false]);
    assert.equal(governanceRebuildCount, 0);
  } finally {
    await server.close();
  }
});

test('family APIs rename and archive a family while clearing policy family bindings', async () => {
  const state = createInitialState();
  state.familyProfiles.push({
    id: 8,
    ownerUserId: null,
    ownerGuestId: 'guest-family-admin',
    familyName: '旧家庭名',
    coreMemberId: 9,
    status: 'active',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
  });
  state.familyMembers.push(
    {
      id: 9,
      familyId: 8,
      name: '张三',
      relationToCore: 'self',
      relationLabel: '本人',
      role: 'core',
      status: 'active',
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z',
    },
    {
      id: 10,
      familyId: 8,
      name: '李四',
      relationToCore: 'spouse',
      relationLabel: '配偶',
      role: 'adult',
      status: 'active',
      createdAt: '2026-06-08T00:01:00.000Z',
      updatedAt: '2026-06-08T00:01:00.000Z',
    },
  );
  state.familyReportShares.push({
    id: 11,
    familyId: 8,
    ownerGuestId: 'guest-family-admin',
    token: 'share-token-family-admin',
    status: 'active',
    createdAt: '2026-06-08T00:02:00.000Z',
    updatedAt: '2026-06-08T00:02:00.000Z',
  });
  state.policies.push(
    {
      id: 12,
      userId: null,
      guestId: 'guest-family-admin',
      company: '新华保险',
      name: '家庭保单A',
      applicant: '张三',
      insured: '李四',
      familyId: 8,
      familyBindingSource: 'explicit',
      applicantMemberId: 9,
      insuredMemberId: 10,
      applicantMemberName: '张三',
      insuredMemberName: '李四',
      applicantRelation: '本人',
      insuredRelation: '配偶',
      applicantRelationLabel: '本人',
      insuredRelationLabel: '配偶',
      participantReviewStatus: 'auto_matched',
      createdAt: '2026-06-08T00:03:00.000Z',
      updatedAt: '2026-06-08T00:03:00.000Z',
    },
    {
      id: 13,
      userId: null,
      guestId: 'guest-family-admin',
      company: '新华保险',
      name: '其他家庭保单',
      familyId: 99,
      applicantMemberId: 100,
      insuredMemberId: 101,
      createdAt: '2026-06-08T00:04:00.000Z',
      updatedAt: '2026-06-08T00:04:00.000Z',
    },
  );
  const familyPersistCalls = [];
  const app = createPolicyOcrApp({
    state,
    persistFamilyState: async (input) => {
      familyPersistCalls.push(input);
    },
  });
  const server = await listen(app);
  try {
    const renamed = await jsonFetch(server.baseUrl, '/api/family-profiles/8?guestId=guest-family-admin', {
      method: 'PATCH',
      body: JSON.stringify({ familyName: '新家庭名' }),
    });
    assert.equal(renamed.response.status, 200);
    assert.equal(renamed.payload.family.familyName, '新家庭名');
    assert.equal(renamed.payload.members.length, 2);

    const deleted = await jsonFetch(server.baseUrl, '/api/family-profiles/8?guestId=guest-family-admin', {
      method: 'DELETE',
    });
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.payload.family.status, 'archived');
    assert.equal(deleted.payload.archivedMemberCount, 2);
    assert.equal(deleted.payload.clearedPolicyCount, 1);
    assert.equal(state.familyMembers.every((member) => member.status === 'archived'), true);
    assert.equal(state.familyReportShares[0].status, 'archived');
    assert.equal(state.policies[0].familyId, null);
    assert.equal(state.policies[0].familyBindingSource, '');
    assert.equal(state.policies[0].applicantMemberId, null);
    assert.equal(state.policies[0].insuredMemberId, null);
    assert.equal(state.policies[0].applicantMemberName, '');
    assert.equal(state.policies[0].insuredMemberName, '');
    assert.equal(state.policies[0].applicantRelation, '');
    assert.equal(state.policies[0].insuredRelation, '');
    assert.equal(state.policies[0].applicantRelationLabel, '');
    assert.equal(state.policies[0].insuredRelationLabel, '');
    assert.equal(state.policies[0].participantReviewStatus, 'pending_review');
    assert.equal(state.policies[1].familyId, 99);
    assert.deepEqual(familyPersistCalls.map((call) => call.includePolicies), [false, true]);

    const listed = await jsonFetch(server.baseUrl, '/api/family-profiles?guestId=guest-family-admin');
    assert.equal(listed.response.status, 200);
    assert.equal(listed.payload.families.some((family) => Number(family.id) === 8), false);
  } finally {
    await server.close();
  }
});

test('policy save applies confirmed spouse relation before binding family snapshots', async () => {
  const state = createInitialState();
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async () => ({
      ocrText: '投保人:李四\n被保险人:李四',
      data: { company: '新华保险', name: '配偶保单', applicant: '李四', insured: '李四' },
    }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
  });
  const server = await listen(app);
  try {
    const familyRes = await jsonFetch(server.baseUrl, '/api/family-profiles?guestId=guest-family-spouse-save', {
      method: 'POST',
      body: JSON.stringify({ familyName: '张三家庭' }),
    });
    const familyId = familyRes.payload.family.id;

    await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members?guestId=guest-family-spouse-save`, {
      method: 'POST',
      body: JSON.stringify({ name: '张三', relationLabel: '本人', setAsCore: true }),
    });
    const spouseRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members?guestId=guest-family-spouse-save`, {
      method: 'POST',
      body: JSON.stringify({ name: '李四', relationLabel: '待确认' }),
    });

    const scanRes = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-family-spouse-save',
        scan: { ocrText: '投保人:李四\n被保险人:李四', data: { company: '新华保险', name: '配偶保单', applicant: '李四', insured: '李四' } },
        analysis: { report: 'ok', coverageTable: [] },
        manualData: {
          familyId,
          applicantMemberId: spouseRes.payload.member.id,
          insuredMemberId: spouseRes.payload.member.id,
          applicantRelationLabel: '配偶',
          insuredRelationLabel: '配偶',
        },
      }),
    });

    assert.equal(scanRes.response.status, 201);
    assert.equal(scanRes.payload.policy.applicantRelationLabel, '配偶');
    assert.equal(scanRes.payload.policy.insuredRelationLabel, '配偶');
    const savedSpouse = state.familyMembers.find((member) => Number(member.id) === Number(spouseRes.payload.member.id));
    assert.equal(savedSpouse.relationToCore, 'spouse');
    assert.equal(savedSpouse.relationLabel, '配偶');
  } finally {
    await server.close();
  }
});

test('policy save preserves every selectable family relation exactly', async () => {
  const state = createInitialState();
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async () => ({ ocrText: '', data: { company: '新华保险', name: '家庭关系保单' } }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
  });
  const server = await listen(app);
  try {
    const relations = ['配偶', '儿子', '女儿', '孙子', '孙女', '外孙', '外孙女', '父亲', '母亲', '外公', '外婆', '爷爷', '奶奶', '其他', '待确认'];
    for (const [index, relation] of relations.entries()) {
      const guestId = `guest-family-relations-${index}`;
      const familyRes = await jsonFetch(server.baseUrl, `/api/family-profiles?guestId=${guestId}`, {
        method: 'POST',
        body: JSON.stringify({ familyName: `全关系家庭-${relation}` }),
      });
      const familyId = familyRes.payload.family.id;
      await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members?guestId=${guestId}`, {
        method: 'POST',
        body: JSON.stringify({ name: '核心', relationLabel: '本人', setAsCore: true }),
      });
      const name = `${relation}成员`;
      const memberRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members?guestId=${guestId}`, {
        method: 'POST',
        body: JSON.stringify({ name, relationLabel: '待确认' }),
      });
      const scanRes = await jsonFetch(server.baseUrl, '/api/policies/scan', {
        method: 'POST',
        body: JSON.stringify({
          guestId,
          scan: { ocrText: `投保人:${name}\n被保险人:${name}`, data: { company: '新华保险', name: `${relation}保单`, applicant: name, insured: name } },
          analysis: { report: 'ok', coverageTable: [] },
          manualData: {
            familyId,
            applicantMemberId: memberRes.payload.member.id,
            insuredMemberId: memberRes.payload.member.id,
            applicantRelationLabel: relation,
            insuredRelationLabel: relation,
          },
        }),
      });

      assert.equal(scanRes.response.status, 201);
      assert.equal(scanRes.payload.policy.applicantRelation, relation);
      assert.equal(scanRes.payload.policy.insuredRelation, relation);
      assert.equal(scanRes.payload.policy.applicantRelationLabel, relation);
      assert.equal(scanRes.payload.policy.insuredRelationLabel, relation);
      assert.equal(scanRes.payload.policy.familyBindingSource, 'explicit');
      const savedMember = state.familyMembers.find((member) => Number(member.id) === Number(memberRes.payload.member.id));
      assert.equal(savedMember.relationLabel, relation);
    }
  } finally {
    await server.close();
  }
});

test('family API sets existing member as core before saving policy', async () => {
  const state = createInitialState();
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async () => ({
      ocrText: '投保人:张三\n被保险人:李四',
      data: { company: '新华保险', name: '测试保单', applicant: '张三', insured: '李四' },
    }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
  });
  const server = await listen(app);
  try {
    const familyRes = await jsonFetch(server.baseUrl, '/api/family-profiles?guestId=guest-family-core', {
      method: 'POST',
      body: JSON.stringify({ familyName: '无核心家庭' }),
    });
    assert.equal(familyRes.response.status, 201);
    const familyId = familyRes.payload.family.id;

    const applicantRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members?guestId=guest-family-core`, {
      method: 'POST',
      body: JSON.stringify({ name: '张三', relationLabel: '待确认' }),
    });
    assert.equal(applicantRes.response.status, 201);
    assert.equal(applicantRes.payload.family.coreMemberId, null);
    assert.notEqual(applicantRes.payload.member.role, 'core');

    const coreRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/core?guestId=guest-family-core`, {
      method: 'PATCH',
      body: JSON.stringify({ memberId: applicantRes.payload.member.id }),
    });
    assert.equal(coreRes.response.status, 200);
    assert.equal(coreRes.payload.family.coreMemberId, applicantRes.payload.member.id);
    assert.equal(coreRes.payload.member.relationToCore, 'self');
    assert.equal(coreRes.payload.member.relationLabel, '本人');
    assert.equal(coreRes.payload.member.role, 'core');

    const insuredRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members?guestId=guest-family-core`, {
      method: 'POST',
      body: JSON.stringify({ name: '李四', relationLabel: '配偶' }),
    });
    const scanRes = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-family-core',
        scan: { ocrText: '投保人:张三\n被保险人:李四', data: { company: '新华保险', name: '测试保单', applicant: '张三', insured: '李四' } },
        analysis: { report: 'ok', coverageTable: [] },
        manualData: {
          familyId,
          applicantMemberId: applicantRes.payload.member.id,
          insuredMemberId: insuredRes.payload.member.id,
        },
      }),
    });

    assert.equal(scanRes.response.status, 201);
    assert.equal(scanRes.payload.policy.applicantMemberId, applicantRes.payload.member.id);
    assert.equal(scanRes.payload.policy.applicantRelationLabel, '本人');
    assert.equal(state.familyMembers.filter((row) => row.familyId === familyId && row.name === '张三').length, 1);
  } finally {
    await server.close();
  }
});

test('policy save keeps explicit family binding even when the family has no core member yet', async () => {
  const state = createInitialState();
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async () => ({
      ocrText: '投保人:张三\n被保险人:李四',
      data: { company: '新华保险', name: '待补核心保单', applicant: '张三', insured: '李四' },
    }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
  });
  const server = await listen(app);
  try {
    const familyRes = await jsonFetch(server.baseUrl, '/api/family-profiles?guestId=guest-family-no-core-save', {
      method: 'POST',
      body: JSON.stringify({ familyName: '未设核心家庭' }),
    });
    assert.equal(familyRes.response.status, 201);
    const familyId = familyRes.payload.family.id;
    assert.equal(familyRes.payload.family.coreMemberId, null);

    const applicantRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members?guestId=guest-family-no-core-save`, {
      method: 'POST',
      body: JSON.stringify({ name: '张三', relationLabel: '待确认' }),
    });
    const insuredRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members?guestId=guest-family-no-core-save`, {
      method: 'POST',
      body: JSON.stringify({ name: '李四', relationLabel: '配偶' }),
    });

    const scanRes = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-family-no-core-save',
        scan: { ocrText: '投保人:张三\n被保险人:李四', data: { company: '新华保险', name: '待补核心保单', applicant: '张三', insured: '李四' } },
        analysis: { report: 'ok', coverageTable: [] },
        manualData: {
          familyId,
          applicantMemberId: applicantRes.payload.member.id,
          insuredMemberId: insuredRes.payload.member.id,
          applicantRelationLabel: '待确认',
          insuredRelationLabel: '配偶',
        },
      }),
    });

    assert.equal(scanRes.response.status, 201);
    assert.equal(scanRes.payload.policy.familyId, familyId);
    assert.equal(scanRes.payload.policy.applicantMemberId, applicantRes.payload.member.id);
    assert.equal(scanRes.payload.policy.insuredMemberId, insuredRes.payload.member.id);
    assert.equal(scanRes.payload.policy.applicantRelationLabel, '待确认');
    assert.equal(scanRes.payload.policy.insuredRelationLabel, '配偶');
    assert.equal(scanRes.payload.policy.participantReviewStatus, 'ok');
    assert.equal(state.familyProfiles.find((family) => Number(family.id) === Number(familyId))?.coreMemberId, null);
  } finally {
    await server.close();
  }
});

test('family API rebases relations on core switch and supports manual relation edits', async () => {
  const state = createInitialState();
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async () => ({ ocrText: '', data: { company: '新华保险', name: '测试保单' } }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
  });
  const server = await listen(app);
  try {
    const familyRes = await jsonFetch(server.baseUrl, '/api/family-profiles?guestId=guest-family-rebase', {
      method: 'POST',
      body: JSON.stringify({ familyName: '关系家庭' }),
    });
    const familyId = familyRes.payload.family.id;
    const coreRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members?guestId=guest-family-rebase`, {
      method: 'POST',
      body: JSON.stringify({ name: '张三', relationLabel: '本人', setAsCore: true }),
    });
    const spouseRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members?guestId=guest-family-rebase`, {
      method: 'POST',
      body: JSON.stringify({ name: '李四', relationLabel: '配偶' }),
    });
    const childRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members?guestId=guest-family-rebase`, {
      method: 'POST',
      body: JSON.stringify({ name: '小明', relationLabel: '儿子' }),
    });

    const nextCoreRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/core?guestId=guest-family-rebase`, {
      method: 'PATCH',
      body: JSON.stringify({ memberId: spouseRes.payload.member.id }),
    });
    const nextMembers = new Map(nextCoreRes.payload.members.map((member) => [member.id, member]));
    assert.equal(nextCoreRes.response.status, 200);
    assert.equal(nextMembers.get(spouseRes.payload.member.id).relationLabel, '本人');
    assert.equal(nextMembers.get(coreRes.payload.member.id).relationLabel, '配偶');
    assert.equal(nextMembers.get(childRes.payload.member.id).relationLabel, '待确认');

    const relationRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members/${childRes.payload.member.id}?guestId=guest-family-rebase`, {
      method: 'PATCH',
      body: JSON.stringify({ relationLabel: '儿子' }),
    });
    assert.equal(relationRes.response.status, 200);
    assert.equal(relationRes.payload.member.relationLabel, '儿子');
    assert.equal(relationRes.payload.family.coreMemberId, spouseRes.payload.member.id);
  } finally {
    await server.close();
  }
});

test('policy save rejects applicant and insured members from different families', async () => {
  const state = createInitialState();
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async () => ({ ocrText: '', data: { company: '新华保险', name: '测试保单' } }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
  });
  const server = await listen(app);
  try {
    const familyA = await jsonFetch(server.baseUrl, '/api/family-profiles?guestId=guest-family', {
      method: 'POST',
      body: JSON.stringify({ familyName: 'A家庭' }),
    });
    const familyB = await jsonFetch(server.baseUrl, '/api/family-profiles?guestId=guest-family', {
      method: 'POST',
      body: JSON.stringify({ familyName: 'B家庭' }),
    });
    const coreA = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyA.payload.family.id}/members?guestId=guest-family`, {
      method: 'POST',
      body: JSON.stringify({ name: '张三', relationLabel: '本人', setAsCore: true }),
    });
    const coreB = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyB.payload.family.id}/members?guestId=guest-family`, {
      method: 'POST',
      body: JSON.stringify({ name: '李四', relationLabel: '本人', setAsCore: true }),
    });

    const result = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-family',
        scan: { ocrText: '', data: { company: '新华保险', name: '测试保单', applicant: '张三', insured: '李四' } },
        analysis: { report: 'ok', coverageTable: [] },
        manualData: {
          familyId: familyA.payload.family.id,
          applicantMemberId: coreA.payload.member.id,
          insuredMemberId: coreB.payload.member.id,
        },
      }),
    });

    assert.equal(result.response.status, 400);
    assert.equal(result.payload.code, 'POLICY_FAMILY_MEMBER_MISMATCH');
  } finally {
    await server.close();
  }
});

test('policy scan without explicit family binding saves into a default family', async () => {
  const state = createInitialState();
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async () => ({
      ocrText: '投保人:张三\n被保险人:李四',
      data: { company: '新华保险', name: '测试保单', applicant: '张三', insured: '李四' },
    }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
  });
  const server = await listen(app);
  try {
    const result = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-default-family-save',
        scan: { ocrText: '投保人:张三\n被保险人:李四', data: { company: '新华保险', name: '测试保单', applicant: '张三', insured: '李四' } },
        analysis: { report: 'ok', coverageTable: [] },
      }),
    });

    assert.equal(result.response.status, 201);
    assert.ok(result.payload.policy.familyId);
    assert.ok(result.payload.policy.applicantMemberId);
    assert.ok(result.payload.policy.insuredMemberId);
    assert.equal(result.payload.policy.applicantMemberName, '张三');
    assert.equal(result.payload.policy.insuredMemberName, '李四');
    assert.equal(state.familyProfiles.length, 1);
    assert.equal(state.familyProfiles[0].ownerGuestId, 'guest-default-family-save');
    assert.equal(state.familyMembers.find((member) => member.id === state.familyProfiles[0].coreMemberId)?.name, '张三');
    assert.equal(state.familyMembers.some((member) => member.name === '李四'), true);
  } finally {
    await server.close();
  }
});

test('policy scan binds same applicant and insured name to one enriched family member', async () => {
  const state = createInitialState();
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async () => ({
      ocrText: '投保人:张三\n被保险人:张三',
      data: {
        company: '新华保险',
        name: '测试保单',
        applicant: '张三',
        insured: '张三',
        insuredBirthday: '1990-01-01',
        insuredIdNumber: '110101199001010033',
      },
    }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
  });
  const server = await listen(app);
  try {
    const result = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-same-person-family-save',
        scan: {
          ocrText: '投保人:张三\n被保险人:张三',
          data: {
            company: '新华保险',
            name: '测试保单',
            applicant: '张三',
            insured: '张三',
            insuredBirthday: '1990-01-01',
            insuredIdNumber: '110101199001010033',
          },
        },
        analysis: { report: 'ok', coverageTable: [] },
      }),
    });

    const zhangMembers = state.familyMembers.filter((member) => member.name === '张三');
    assert.equal(result.response.status, 201);
    assert.equal(zhangMembers.length, 1);
    assert.equal(result.payload.policy.applicantMemberId, result.payload.policy.insuredMemberId);
    assert.equal(zhangMembers[0]?.birthday, '1990-01-01');
    assert.equal(zhangMembers[0]?.idNumberTail, '0033');
  } finally {
    await server.close();
  }
});

test('family profile list migrates existing policies into a default family', async () => {
  const state = {
    ...createInitialState(),
    nextId: 20,
    policies: [
      {
        id: 1,
        userId: null,
        guestId: 'guest-existing-family',
        company: '新华保险',
        name: '老保单',
        applicant: '张三',
        insured: '李四',
        responsibilities: [],
        coverageIndicators: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async () => ({ ocrText: '', data: { company: '新华保险', name: '测试保单' } }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
  });
  const server = await listen(app);
  try {
    const result = await jsonFetch(server.baseUrl, '/api/family-profiles?guestId=guest-existing-family');

    assert.equal(result.response.status, 200);
    assert.equal(result.payload.families.length, 1);
    assert.equal(result.payload.families[0].familyName, '默认家庭');
    assert.equal(result.payload.families[0].members.map((member) => member.name).sort().join(','), '张三,李四');
    assert.equal(state.policies[0].familyId, result.payload.families[0].id);
    assert.ok(state.policies[0].applicantMemberId);
    assert.ok(state.policies[0].insuredMemberId);
  } finally {
    await server.close();
  }
});

test('registration saves pending recognized policy into a family profile', async () => {
  const state = createInitialState();
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async () => ({
      ocrText: '投保人:张三\n被保险人:李四',
      data: { company: '新华保险', name: '待注册保单', applicant: '张三', insured: '李四' },
    }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
    codeGenerator: () => '246810',
  });
  const server = await listen(app);
  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-pending-family',
        ocrText: '投保人:张三\n被保险人:李四',
      }),
    });
    assert.equal(recognized.response.status, 200);
    assert.equal(state.policies.length, 0);

    await jsonFetch(server.baseUrl, '/api/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ mobile: '13600000000' }),
    });
    const registered = await jsonFetch(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        mobile: '13600000000',
        code: '246810',
        guestId: 'guest-pending-family',
      }),
    });

    assert.equal(registered.response.status, 200);
    assert.equal(registered.payload.policies.length, 1);
    assert.ok(registered.payload.policies[0].familyId);
    assert.ok(registered.payload.policies[0].applicantMemberId);
    assert.ok(registered.payload.policies[0].insuredMemberId);
    assert.equal(registered.payload.policies[0].familyName, '默认家庭');
    assert.equal(state.familyProfiles[0].ownerUserId, registered.payload.user.id);
    assert.equal(state.familyMembers.some((member) => member.name === '张三'), true);
    assert.equal(state.familyMembers.some((member) => member.name === '李四'), true);
  } finally {
    await server.close();
  }
});

test('recognize drops stale participant member ids when OCR participant names change', async () => {
  const state = createInitialState();
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async () => ({
      ocrText: '投保人:温舒萍\n被保险人:温舒萍',
      data: { company: '新华保险', name: '新保单', applicant: '温舒萍', insured: '温舒萍' },
    }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
  });
  const server = await listen(app);
  try {
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-recognize-member-reset',
        manualData: {
          familyId: 500693,
          applicant: '冯力',
          insured: '冯力',
          applicantMemberId: 500714,
          insuredMemberId: 500714,
        },
      }),
    });

    assert.equal(recognized.response.status, 200);
    assert.equal(recognized.payload.scan.data.applicant, '温舒萍');
    assert.equal(recognized.payload.scan.data.insured, '温舒萍');
    assert.equal('applicantMemberId' in recognized.payload.scan.data, false);
    assert.equal('insuredMemberId' in recognized.payload.scan.data, false);
  } finally {
    await server.close();
  }
});

test('PATCH recomputes family participant snapshots when insured name changes', async () => {
  const state = createInitialState();
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async () => ({ ocrText: '', data: { company: '新华保险', name: '测试保单' } }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
  });
  const server = await listen(app);
  try {
    const familyRes = await jsonFetch(server.baseUrl, '/api/family-profiles?guestId=guest-family-patch', {
      method: 'POST',
      body: JSON.stringify({ familyName: '张三家庭' }),
    });
    const familyId = familyRes.payload.family.id;
    const applicantRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members?guestId=guest-family-patch`, {
      method: 'POST',
      body: JSON.stringify({ name: '张三', relationLabel: '本人', setAsCore: true }),
    });
    const insuredRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members?guestId=guest-family-patch`, {
      method: 'POST',
      body: JSON.stringify({ name: '李四', relationLabel: '配偶' }),
    });
    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-family-patch',
        scan: { ocrText: '', data: { company: '新华保险', name: '测试保单', applicant: '张三', insured: '李四' } },
        analysis: { report: 'ok', coverageTable: [] },
        manualData: {
          familyId,
          applicantMemberId: applicantRes.payload.member.id,
          insuredMemberId: insuredRes.payload.member.id,
        },
      }),
    });
    assert.equal(saved.response.status, 201);
    assert.equal(saved.payload.policy.participantReviewStatus, 'ok');

    const updated = await jsonFetch(server.baseUrl, `/api/policies/${saved.payload.policy.id}?guestId=guest-family-patch`, {
      method: 'PATCH',
      body: JSON.stringify({ insured: '李四OCR错字' }),
    });

    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.policy.insured, '李四OCR错字');
    assert.equal(updated.payload.policy.insuredMemberId, insuredRes.payload.member.id);
    assert.equal(updated.payload.policy.insuredMemberName, '李四');
    assert.equal(updated.payload.policy.insuredNameSnapshot, '李四OCR错字');
    assert.equal(updated.payload.policy.participantReviewStatus, 'name_mismatch');
  } finally {
    await server.close();
  }
});

test('registration migrates guest family ownership and lists family profiles for the user', async () => {
  const state = createInitialState();
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async () => ({ ocrText: '', data: { company: '新华保险', name: '测试保单' } }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
    codeGenerator: () => '975310',
  });
  const server = await listen(app);
  try {
    const familyRes = await jsonFetch(server.baseUrl, '/api/family-profiles?guestId=guest-register-family', {
      method: 'POST',
      body: JSON.stringify({ familyName: '注册迁移家庭' }),
    });
    const familyId = familyRes.payload.family.id;
    const memberRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members?guestId=guest-register-family`, {
      method: 'POST',
      body: JSON.stringify({ name: '张三', relationLabel: '本人', setAsCore: true }),
    });
    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-register-family',
        scan: { ocrText: '', data: { company: '新华保险', name: '测试保单', applicant: '张三', insured: '张三' } },
        analysis: { report: 'ok', coverageTable: [] },
        manualData: {
          familyId,
          applicantMemberId: memberRes.payload.member.id,
          insuredMemberId: memberRes.payload.member.id,
        },
      }),
    });
    assert.equal(saved.response.status, 201);

    await jsonFetch(server.baseUrl, '/api/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ mobile: '13700000000' }),
    });
    const registered = await jsonFetch(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        mobile: '13700000000',
        code: '975310',
        guestId: 'guest-register-family',
      }),
    });
    assert.equal(registered.response.status, 200);

    const families = await jsonFetch(server.baseUrl, '/api/family-profiles', {
      headers: { authorization: `Bearer ${registered.payload.token}` },
    });

    assert.equal(families.response.status, 200);
    assert.equal(families.payload.families.length, 1);
    assert.equal(families.payload.families[0].id, familyId);
    assert.equal(families.payload.families[0].familyName, '注册迁移家庭');
    assert.equal(families.payload.families[0].ownerUserId, registered.payload.user.id);
    assert.equal(families.payload.families[0].ownerGuestId, '');
    assert.equal(families.payload.families[0].members[0].name, '张三');
  } finally {
    await server.close();
  }
});

test('family owner routes hide and reject mutations from another guest owner', async () => {
  const state = createInitialState();
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async () => ({ ocrText: '', data: { company: '新华保险', name: '测试保单' } }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
  });
  const server = await listen(app);
  try {
    const familyRes = await jsonFetch(server.baseUrl, '/api/family-profiles?guestId=guest-owner-a', {
      method: 'POST',
      body: JSON.stringify({ familyName: 'A家庭' }),
    });
    assert.equal(familyRes.response.status, 201);

    const hidden = await jsonFetch(server.baseUrl, '/api/family-profiles?guestId=guest-owner-b');
    assert.equal(hidden.response.status, 200);
    assert.equal(hidden.payload.families.length, 0);

    const mutation = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyRes.payload.family.id}/members?guestId=guest-owner-b`, {
      method: 'POST',
      body: JSON.stringify({ name: '李四', relationLabel: '配偶' }),
    });
    assert.equal(mutation.response.status, 404);
    assert.equal(mutation.payload.code, 'FAMILY_NOT_FOUND');
  } finally {
    await server.close();
  }
});

test('share snapshots only selected family members and policies', async () => {
  const privateKeys = ['ownerGuestId', 'ownerUserId', 'guestId', 'userId'];
  function assertNoPrivateKeys(value, path = 'payload') {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertNoPrivateKeys(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const key of privateKeys) {
      assert.equal(Object.prototype.hasOwnProperty.call(value, key), false, `${path} should not expose ${key}`);
    }
    for (const [key, item] of Object.entries(value)) {
      assertNoPrivateKeys(item, `${path}.${key}`);
    }
  }

  const state = createInitialState();
  state.familyProfiles = [
    {
      id: 1,
      ownerUserId: null,
      ownerGuestId: 'guest-share',
      familyName: '一号家庭',
      coreMemberId: 11,
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 2,
      ownerUserId: null,
      ownerGuestId: 'guest-share',
      familyName: '二号家庭',
      coreMemberId: 21,
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  state.familyMembers = [
    { id: 11, userId: 99, guestId: 'member-secret', familyId: 1, name: '张一', relationToCore: 'self', relationLabel: '本人', role: 'core', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 12, userId: 99, guestId: 'member-secret', familyId: 1, name: '张二', relationToCore: 'spouse', relationLabel: '配偶', role: 'adult', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 21, familyId: 2, name: '李一', relationToCore: 'self', relationLabel: '本人', role: 'core', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 22, familyId: 2, name: '李二', relationToCore: 'child', relationLabel: '子女', role: 'child', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  ];
  state.policies = [
    { id: 101, userId: null, guestId: 'guest-share', familyId: 1, applicantMemberId: 11, insuredMemberId: 12, company: 'A保险', name: '一号保单', applicant: '张一', insured: '张二', responsibilities: [], coverageIndicators: [], createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 102, userId: null, guestId: 'guest-share', familyId: 2, applicantMemberId: 21, insuredMemberId: 22, company: 'B保险', name: '二号保单', applicant: '李一', insured: '李二', responsibilities: [], coverageIndicators: [], createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 103, userId: null, guestId: 'guest-other', familyId: 1, applicantMemberId: 11, insuredMemberId: 12, company: 'C保险', name: '串户保单', applicant: '张一', insured: '张二', responsibilities: [], coverageIndicators: [], createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  state.nextId = 200;
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async () => ({ ocrText: '', data: { company: '新华保险', name: '测试保单' } }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
  });
  const server = await listen(app);
  try {
    const created = await jsonFetch(server.baseUrl, '/api/family-profiles/1/share?guestId=guest-share', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    assert.equal(created.response.status, 201);
    assert.equal(created.payload.ok, true);
    assert.equal(created.payload.share.familyId, 1);
    assert.match(created.payload.share.token, /^[a-f0-9]{32}$/);

    const fetched = await jsonFetch(server.baseUrl, `/api/family-report-shares/${created.payload.share.token}`);
    assert.equal(fetched.response.status, 200);
    assert.equal(fetched.payload.ok, true);
    assert.equal(fetched.payload.family.id, 1);
    assert.equal(fetched.payload.family.familyName, '一号家庭');
    assertNoPrivateKeys(fetched.payload.family, 'family');
    assertNoPrivateKeys(fetched.payload.members, 'members');
    assertNoPrivateKeys(fetched.payload.policies, 'policies');
    assert.deepEqual(fetched.payload.members.map((member) => member.familyId), [1, 1]);
    assert.deepEqual(fetched.payload.members.map((member) => member.name), ['张一', '张二']);
    assert.deepEqual(fetched.payload.policies.map((policy) => policy.familyId), [1]);
    assert.deepEqual(fetched.payload.policies.map((policy) => policy.name), ['一号保单']);
    assert.ok(fetched.payload.snapshotAt);
    assert.equal(fetched.payload.members.some((member) => Number(member.familyId) === 2), false);
    assert.equal(fetched.payload.members.some((member) => member.name === '李一' || member.name === '李二'), false);
    assert.equal(fetched.payload.policies.some((policy) => Number(policy.familyId) === 2), false);
    assert.equal(fetched.payload.policies.some((policy) => policy.name === '串户保单'), false);
    assert.doesNotMatch(JSON.stringify(fetched.payload), /guest-share|guest-other|member-secret/);
  } finally {
    await server.close();
  }
});
