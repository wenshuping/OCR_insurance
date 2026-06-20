import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractPolicyFieldsWithDeepSeekOcrVisualSemantic,
  extractPolicyFieldsWithDeepSeekOcrSemantic,
  recognizeDeepSeekOcrUpload,
  scanInsurancePolicyLocal,
} from '../ocr-service/insurance-ocr.service.mjs';

const deepSeekPolicyMarkdown = `
<|ref|>title<|/ref|><|det|>[[150, 78, 784, 106]]<|/det|>
# 中国平安人寿保险股份有限公司

<|ref|>text<|/ref|><|det|>[[29, 165, 884, 195]]<|/det|>
保险合同号码：P120300006043908 保险合同成立及生效日：2010年12月20日 00:00

<|ref|>text<|/ref|><|det|>[[28, 190, 904, 219]]<|/det|>
投保人：张三 性别：女 生日：1970年01月06日 证件号码：330000197001010000

<|ref|>text<|/ref|><|det|>[[28, 213, 875, 240]]<|/det|>
被保险人：李四 性别：男 生日：1967年01月19日 证件号码：330000196701010000

<|ref|>table<|/ref|><|det|>[[19, 350, 950, 404]]<|/det|>
<table><tr><td>保险项目</td><td>保险期间</td><td>交费年限</td><td>基本保险金额／份数／档次</td><td>保险费</td></tr><tr><td>投保主险：逸享人生（825）</td><td>42年</td><td>10年</td><td>120,000元</td><td>12,000.00元</td></tr></table>
`;

const incompleteDeepSeekPolicyMarkdown = `
# 新华保险

保险单

保险合同号：886622461459
投保人：翟卿
被保险人：顾晨妍
合同生效日期：2014年01月01日
险种名称：住院费用医疗保险（2007）
`;

const appPolicyOcrText = `
保单详情
保单生效日期 2017-09-22
险种信息
险种名称标准保费基本保额交费期间保险期间
915 附加随意领年金保险（万能型） 0.00 元 0.00 元一次交清终身
694 V2.5 美利金生终身年金保险（分红型） 40,320.00 元 30000.00 元 10 年终身
847 附加住院安心医疗保险（费率可调） 263.00 元 10000.00 元一次交清 1 年
投保人详细信息
投保人姓名陈聿敏女
手机号码 13857191122
`;

function fakeUploadItem() {
  return {
    name: 'policy.png',
    type: 'image/png',
    size: 10,
    dataUrl: `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`,
  };
}

test('recognizeDeepSeekOcrUpload calls vLLM and normalizes markdown OCR output', async () => {
  let requestUrl = '';
  let requestBody = null;
  const result = await recognizeDeepSeekOcrUpload(fakeUploadItem(), {
    env: {
      POLICY_OCR_DEEPSEEK_OCR_BASE_URL: 'http://127.0.0.1:6008/v1',
      POLICY_OCR_DEEPSEEK_OCR_MODEL: 'deepseek-ai/DeepSeek-OCR',
    },
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: deepSeekPolicyMarkdown } }],
          usage: { prompt_tokens: 12, completion_tokens: 34 },
        }),
      };
    },
  });

  assert.equal(requestUrl, 'http://127.0.0.1:6008/v1/chat/completions');
  assert.equal(requestBody.model, 'deepseek-ai/DeepSeek-OCR');
  assert.equal(requestBody.max_tokens, 4096);
  assert.equal(requestBody.skip_special_tokens, false);
  assert.deepEqual(requestBody.vllm_xargs.whitelist_token_ids, [128821, 128822]);
  assert.match(requestBody.messages[0].content[0].text, /Convert the document to markdown/u);
  assert.match(requestBody.messages[0].content[1].image_url.url, /^data:image\/png;base64,/u);
  assert.match(result.ocrText, /保险合同号码:P120300006043908/u);
  assert.match(result.ocrText, /投保主险:逸享人生（825） 42年 10年 120,000元 12,000.00元/u);
  assert.equal(result.tables.length, 1);
  assert.ok(result.boxes.some((box) => box.text === '保险项目'));
  assert.ok(result.boxes.some((box) => box.text === '120,000元'));
});

test('DeepSeek-OCR semantic extraction maps variant premium and amount labels into plans', async () => {
  let requestBody = null;
  const result = await extractPolicyFieldsWithDeepSeekOcrSemantic(appPolicyOcrText, {
    env: {
      POLICY_OCR_DEEPSEEK_OCR_BASE_URL: 'http://127.0.0.1:6008',
      POLICY_OCR_DEEPSEEK_OCR_MODEL: 'deepseek-ai/DeepSeek-OCR',
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:6008/v1/chat/completions');
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                date: '2017-09-22',
                applicant: '陈聿敏',
                name: '美利金生终身年金保险（分红型）',
                amount: '30000.00',
                firstPremium: '40583.00',
                paymentPeriod: '10年交',
                coveragePeriod: '终身',
                fieldEvidence: {
                  applicant: '投保人姓名陈聿敏女',
                  amount: '694 V2.5 美利金生终身年金保险（分红型） 40,320.00 元 30000.00 元 10 年终身',
                  firstPremium: '险种名称标准保费基本保额交费期间保险期间',
                },
                plans: [
                  { role: 'linked_account', name: '附加随意领年金保险（万能型）', amount: '0.00', coveragePeriod: '终身', paymentMode: '一次交清', paymentPeriod: '一次交清', premium: '0.00' },
                  { role: 'main', name: '美利金生终身年金保险（分红型）', amount: '30000.00', coveragePeriod: '终身', paymentMode: '年交', paymentPeriod: '10年', premium: '40320.00' },
                  { role: 'rider', name: '附加住院安心医疗保险（费率可调）', amount: '10000.00', coveragePeriod: '1年', paymentMode: '一次交清', paymentPeriod: '一次交清', premium: '263.00' },
                ],
              }),
            },
          }],
        }),
      };
    },
  });

  assert.equal(requestBody.max_tokens, 2048);
  assert.match(requestBody.messages[0].content, /标准保费\/保险费\/首期保费/u);
  assert.match(requestBody.messages[0].content, /每个非空顶层字段都在 fieldEvidence/u);
  assert.equal(result.data.applicant, '陈聿敏');
  assert.equal(result.data.name, '美利金生终身年金保险（分红型）');
  assert.equal(result.data.amount, '30000');
  assert.equal(result.data.paymentPeriod, '10年交');
  assert.match(result.data.fieldEvidence.applicant, /投保人姓名陈聿敏/u);
  assert.equal(result.data.plans.length, 3);
  assert.equal(result.data.plans[1].premium, '40320');
  assert.equal(result.data.plans[1].amount, '30000');
  assert.equal(result.data.plans[2].premium, '263');
  assert.equal(result.data.plans[2].amount, '10000');
});

test('DeepSeek-OCR visual semantic extraction sends image and OCR text for generic field mapping', async () => {
  let requestBody = null;
  const result = await extractPolicyFieldsWithDeepSeekOcrVisualSemantic(fakeUploadItem(), {
    ocrText: appPolicyOcrText,
    markdown: appPolicyOcrText,
    env: {
      POLICY_OCR_DEEPSEEK_OCR_BASE_URL: 'http://127.0.0.1:6008',
      POLICY_OCR_DEEPSEEK_OCR_MODEL: 'deepseek-ai/DeepSeek-OCR',
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:6008/v1/chat/completions');
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                applicant: '陈聿敏',
                name: '美利金生终身年金保险（分红型）',
                firstPremium: '40583.00',
                plans: [
                  { role: 'linked_account', name: '附加随意领年金保险（万能型）', amount: '0.00', coveragePeriod: '终身', paymentMode: '一次交清', paymentPeriod: '一次交清', premium: '0.00' },
                  { role: 'main', name: '美利金生终身年金保险（分红型）', amount: '30000.00', coveragePeriod: '终身', paymentMode: '年交', paymentPeriod: '10年', premium: '40320.00' },
                  { role: 'rider', name: '附加住院安心医疗保险（费率可调）', amount: '10000.00', coveragePeriod: '1年', paymentMode: '一次交清', paymentPeriod: '一次交清', premium: '263.00' },
                ],
                fieldEvidence: {
                  applicant: '投保人姓名陈聿敏女',
                },
              }),
            },
          }],
        }),
      };
    },
  });

  assert.equal(requestBody.model, 'deepseek-ai/DeepSeek-OCR');
  assert.equal(requestBody.max_tokens, 2048);
  assert.match(requestBody.messages[0].content[0].text, /同时参考图片和下方 OCR 文本/u);
  assert.match(requestBody.messages[0].content[0].text, /标准保费\/保险费\/首期保费/u);
  assert.match(requestBody.messages[0].content[1].image_url.url, /^data:image\/png;base64,/u);
  assert.equal(result.source, 'visual');
  assert.equal(result.data.applicant, '陈聿敏');
  assert.equal(result.data.plans.length, 3);
  assert.equal(result.data.plans[1].amount, '30000');
  assert.equal(result.data.plans[2].premium, '263');
});

test('scanInsurancePolicyLocal can use DeepSeek-OCR vLLM provider before existing field matching', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  const previousBaseUrl = process.env.POLICY_OCR_DEEPSEEK_OCR_BASE_URL;
  const previousModel = process.env.POLICY_OCR_DEEPSEEK_OCR_MODEL;
  const previousFallback = process.env.POLICY_OCR_FALLBACK_PADDLE;
  const previousFieldExtraction = process.env.POLICY_OCR_DEEPSEEK_OCR_FIELD_EXTRACTION;
  const previousFetch = globalThis.fetch;
  process.env.POLICY_OCR_PROVIDER = 'deepseek_ocr_vllm';
  process.env.POLICY_OCR_DEEPSEEK_OCR_BASE_URL = 'http://127.0.0.1:6008';
  process.env.POLICY_OCR_DEEPSEEK_OCR_MODEL = 'deepseek-ai/DeepSeek-OCR';
  process.env.POLICY_OCR_FALLBACK_PADDLE = 'false';
  delete process.env.POLICY_OCR_DEEPSEEK_OCR_FIELD_EXTRACTION;

  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: deepSeekPolicyMarkdown } }],
      }),
    };
  };

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: fakeUploadItem(),
      ocrText: '',
    });

    assert.equal(scan.ok, true);
    assert.equal(scan.data.policyNumber, 'P120300006043908');
    assert.equal(scan.data.applicant, '张三');
    assert.equal(scan.data.insured, '李四');
    assert.equal(scan.data.name, '逸享人生（825）');
    assert.equal(scan.data.coveragePeriod, '42年');
    assert.equal(scan.data.paymentPeriod, '10年交');
    assert.equal(scan.data.amount, '120000');
    assert.equal(scan.data.firstPremium, '12000');
    assert.equal(scan.fieldConfidence.name, 'visual-table');
    assert.equal(scan.fieldConfidence.amount, 'visual-table');
    assert.equal(scan.visionDebug.deepSeekOcr.semanticFieldMode, 'auto');
    assert.equal(scan.visionDebug.deepSeekOcr.semanticFieldExtraction, false);
    assert.equal(fetchCount, 1);
    assert.match(scan.ocrText, /中国平安人寿保险股份有限公司/u);
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
    if (previousBaseUrl === undefined) delete process.env.POLICY_OCR_DEEPSEEK_OCR_BASE_URL;
    else process.env.POLICY_OCR_DEEPSEEK_OCR_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.POLICY_OCR_DEEPSEEK_OCR_MODEL;
    else process.env.POLICY_OCR_DEEPSEEK_OCR_MODEL = previousModel;
    if (previousFallback === undefined) delete process.env.POLICY_OCR_FALLBACK_PADDLE;
    else process.env.POLICY_OCR_FALLBACK_PADDLE = previousFallback;
    if (previousFieldExtraction === undefined) delete process.env.POLICY_OCR_DEEPSEEK_OCR_FIELD_EXTRACTION;
    else process.env.POLICY_OCR_DEEPSEEK_OCR_FIELD_EXTRACTION = previousFieldExtraction;
    globalThis.fetch = previousFetch;
  }
});

test('scanInsurancePolicyLocal auto-runs DeepSeek-OCR semantic mapping when plan values are incomplete', async () => {
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  const previousBaseUrl = process.env.POLICY_OCR_DEEPSEEK_OCR_BASE_URL;
  const previousModel = process.env.POLICY_OCR_DEEPSEEK_OCR_MODEL;
  const previousFallback = process.env.POLICY_OCR_FALLBACK_PADDLE;
  const previousFieldExtraction = process.env.POLICY_OCR_DEEPSEEK_OCR_FIELD_EXTRACTION;
  const previousFetch = globalThis.fetch;
  process.env.POLICY_OCR_PROVIDER = 'deepseek_ocr_vllm';
  process.env.POLICY_OCR_DEEPSEEK_OCR_BASE_URL = 'http://127.0.0.1:6008';
  process.env.POLICY_OCR_DEEPSEEK_OCR_MODEL = 'deepseek-ai/DeepSeek-OCR';
  process.env.POLICY_OCR_FALLBACK_PADDLE = 'false';
  delete process.env.POLICY_OCR_DEEPSEEK_OCR_FIELD_EXTRACTION;

  const requestBodies = [];
  globalThis.fetch = async (url, options) => {
    requestBodies.push(JSON.parse(options.body));
    if (requestBodies.length === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: incompleteDeepSeekPolicyMarkdown } }],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              company: '新华保险',
              policyNumber: '886622461459',
              applicant: '翟卿',
              insured: '顾晨妍',
              date: '2014-01-01',
              name: '住院费用医疗保险（2007）',
              amount: '10000.00',
              firstPremium: '234.00',
              coveragePeriod: '1年',
              paymentPeriod: '趸交',
              plans: [
                {
                  role: 'rider',
                  name: '住院费用医疗保险（2007）',
                  amount: '10000.00',
                  coveragePeriod: '1年',
                  paymentMode: '趸交',
                  paymentPeriod: '趸交',
                  premium: '234.00',
                  sourceColumn: '险种名称',
                  evidence: '保险金额：10000.00元 保险费：234.00元',
                },
              ],
            }),
          },
        }],
      }),
    };
  };

  try {
    const scan = await scanInsurancePolicyLocal({
      uploadItem: fakeUploadItem(),
      ocrText: '',
    });

    assert.equal(scan.ok, true);
    assert.equal(requestBodies.length, 2);
    assert.equal(Array.isArray(requestBodies[1].messages[0].content), true);
    assert.equal(scan.visionDebug.deepSeekOcr.semanticFieldMode, 'auto');
    assert.equal(scan.visionDebug.deepSeekOcr.semanticFieldExtraction, true);
    assert.equal(scan.visionDebug.deepSeekOcr.semanticFieldSource, 'visual');
    assert.equal(scan.data.name, '住院费用医疗保险（2007）');
    assert.equal(scan.data.amount, '10000');
    assert.equal(scan.data.firstPremium, '234');
    assert.equal(scan.data.plans[0].amount, '10000');
    assert.equal(scan.data.plans[0].premium, '234');
  } finally {
    if (previousProvider === undefined) delete process.env.POLICY_OCR_PROVIDER;
    else process.env.POLICY_OCR_PROVIDER = previousProvider;
    if (previousBaseUrl === undefined) delete process.env.POLICY_OCR_DEEPSEEK_OCR_BASE_URL;
    else process.env.POLICY_OCR_DEEPSEEK_OCR_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.POLICY_OCR_DEEPSEEK_OCR_MODEL;
    else process.env.POLICY_OCR_DEEPSEEK_OCR_MODEL = previousModel;
    if (previousFallback === undefined) delete process.env.POLICY_OCR_FALLBACK_PADDLE;
    else process.env.POLICY_OCR_FALLBACK_PADDLE = previousFallback;
    if (previousFieldExtraction === undefined) delete process.env.POLICY_OCR_DEEPSEEK_OCR_FIELD_EXTRACTION;
    else process.env.POLICY_OCR_DEEPSEEK_OCR_FIELD_EXTRACTION = previousFieldExtraction;
    globalThis.fetch = previousFetch;
  }
});
