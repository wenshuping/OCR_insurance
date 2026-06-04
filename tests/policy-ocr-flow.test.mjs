import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createPolicyOcrApp } from '../server/app.mjs';
import { createCashflowStore, createCashValueStore } from '../server/cashflow-store.mjs';
import { createInitialState, latestValidSmsCode } from '../server/policy-ocr.domain.mjs';
import { rebuildOptionalResponsibilityGovernance } from '../server/optional-responsibility-governance.mjs';
import { scanPolicyWithConfiguredRuntime } from '../server/ocr-runtime.mjs';
import { extractPaddleOcrText, extractPolicyFieldsFromText, normalizeExtractedPolicyFields } from '../ocr-service/insurance-ocr.service.mjs';
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
    const suggested = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/company-suggestions?q=测试人寿');
    assert.equal(suggested.response.status, 200);
    assert.equal(suggested.payload.ok, true);
    assert.ok(
      suggested.payload.suggestions.some(
        (item) =>
          item.company === '测试人寿保险股份有限公司'
          && ['prefix', 'generic', 'contains', 'exact'].includes(item.matchType),
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
    const redraftedOptionOne = redrafted.payload.analysis.optionalResponsibilities.find((item) => item.liability === '可选责任一');
    assert.equal(redraftedOptionOne.selectionStatus, 'selected');
    assert.equal(redraftedOptionOne.selectionEvidence, 'manual');
    assert.ok(redrafted.payload.analysis.optionalResponsibilities.every((item) => item.productName === productName));
    assert.equal(redrafted.payload.analysis.optionalResponsibilities.some((item) => item.productName === riderProductName), false);
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
    const relations = ['配偶', '儿子', '女儿', '父亲', '母亲', '其他', '待确认'];
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
