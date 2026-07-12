import assert from 'node:assert/strict';
import test from 'node:test';

import { createPolicyOcrApp } from '../server/app.mjs';
import { createInitialState } from '../server/policy-ocr.domain.mjs';

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

function stateWithUser() {
  const state = createInitialState();
  state.users.push({
    id: 1,
    mobile: '13900000001',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
  });
  state.sessions.push({
    token: 'policy-plan-amount-sync-token',
    userId: 1,
    createdAt: '2026-07-04T00:00:00.000Z',
  });
  return state;
}

async function jsonFetch(baseUrl, path, { method = 'POST', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: 'Bearer policy-plan-amount-sync-token',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

function baseSavedPolicy(overrides = {}) {
  const scan = pingAnScanWithWrongPlanAmount();
  return {
    id: 10,
    userId: 1,
    guestId: '',
    ...scan.data,
    amount: 1000,
    firstPremium: 32958,
    plans: [
      {
        ...scan.data.plans[0],
        amount: 1000,
      },
      {
        company: '中国平安',
        role: 'rider',
        name: '旧附加险',
        matchedProductName: '旧附加险',
        amount: 2000,
        coveragePeriod: '20年',
        paymentMode: '年交',
        paymentPeriod: '3年交',
        premium: 20,
      },
    ],
    ocrText: scan.ocrText,
    responsibilities: [],
    optionalResponsibilities: [],
    report: '',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

function pingAnScanWithWrongPlanAmount() {
  const plan = {
    company: '中国平安',
    role: 'main',
    name: '平安尊御人生两全保险（分红型）',
    matchedProductName: '平安尊御人生两全保险（分红型）',
    amount: 3,
    coveragePeriod: '终身',
    paymentMode: '年交',
    paymentPeriod: '3年交',
    premium: 32958,
  };
  return {
    ocrText: 'OCR 将交费期间 3 年误识别到主险保额。',
    data: {
      company: '中国平安',
      name: '平安尊御人生两全保险（分红型）',
      applicant: '秦国英',
      applicantBirthday: '1970-01-06',
      beneficiary: '秦国英',
      insured: '秦国英',
      insuredBirthday: '1970-01-06',
      date: '2026-07-04',
      paymentPeriod: '3年交',
      coveragePeriod: '终身',
      amount: 3,
      firstPremium: 32958,
      plans: [plan],
    },
  };
}

test('saving a policy syncs submitted top-level amount into the main plan', async () => {
  const app = createPolicyOcrApp({ state: stateWithUser() });
  const server = await listen(app);

  try {
    const scan = pingAnScanWithWrongPlanAmount();
    const { response, payload } = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      body: {
        guestId: '',
        scan,
        manualData: {
          ...scan.data,
          amount: 1000,
          firstPremium: 12345,
          coveragePeriod: '至70岁',
          paymentPeriod: '10年交',
        },
        analysis: {
          report: '已生成责任。',
          coverageTable: [],
        },
      },
    });

    assert.equal(response.status, 201);
    assert.equal(payload.policy.amount, 1000);
    assert.equal(payload.policy.firstPremium, 12345);
    assert.equal(payload.policy.plans[0].amount, 1000);
    assert.equal(payload.policy.plans[0].premium, 12345);
    assert.equal(payload.policy.plans[0].coveragePeriod, '至70岁');
    assert.equal(payload.policy.plans[0].paymentPeriod, '10年交');
  } finally {
    await server.close();
  }
});

test('updating a policy syncs submitted top-level amount into the main plan', async () => {
  const state = stateWithUser();
  const scan = pingAnScanWithWrongPlanAmount();
  state.policies.push(baseSavedPolicy({ plans: scan.data.plans }));
  const app = createPolicyOcrApp({ state });
  const server = await listen(app);

  try {
    const { response, payload } = await jsonFetch(server.baseUrl, '/api/policies/10', {
      method: 'PATCH',
      body: {
        ...scan.data,
        amount: 1000,
      },
    });

    assert.ok([200, 202].includes(response.status));
    assert.equal(payload.policy.amount, 1000);
    assert.equal(payload.policy.plans[0].amount, 1000);
    assert.equal(payload.policy.plans[0].paymentPeriod, '3年交');
  } finally {
    await server.close();
  }
});

test('updating top-level policy fields without plans syncs the existing main plan', async () => {
  const state = stateWithUser();
  state.policies.push(baseSavedPolicy({
    amount: 3,
    firstPremium: 2,
    paymentPeriod: '旧缴费',
    coveragePeriod: '旧期间',
    plans: [
      {
        company: '中国平安',
        role: 'main',
        name: '平安尊御人生两全保险（分红型）',
        matchedProductName: '平安尊御人生两全保险（分红型）',
        amount: 3,
        coveragePeriod: '旧期间',
        paymentMode: '年交',
        paymentPeriod: '旧缴费',
        premium: 2,
      },
    ],
  }));
  const app = createPolicyOcrApp({ state });
  const server = await listen(app);

  try {
    const { response, payload } = await jsonFetch(server.baseUrl, '/api/policies/10', {
      method: 'PATCH',
      body: {
        amount: 7777,
        firstPremium: 555,
        paymentPeriod: '2年交',
        coveragePeriod: '30年',
      },
    });

    assert.equal(response.status, 200);
    assert.equal(payload.policy.amount, 7777);
    assert.equal(payload.policy.firstPremium, 555);
    assert.equal(payload.policy.plans[0].amount, 7777);
    assert.equal(payload.policy.plans[0].premium, 555);
    assert.equal(payload.policy.plans[0].coveragePeriod, '30年');
    assert.equal(payload.policy.plans[0].paymentPeriod, '2年交');
  } finally {
    await server.close();
  }
});

test('updating a policy persists every editable scalar and rider field', async () => {
  const state = stateWithUser();
  state.policies.push(baseSavedPolicy());
  const app = createPolicyOcrApp({ state });
  const server = await listen(app);

  try {
    const update = {
      company: '新华保险',
      name: '新版产品',
      applicant: '李四',
      applicantBirthday: '1981-02-03',
      beneficiary: '王五',
      beneficiaryRelation: '配偶',
      beneficiaryBirthday: '1982-04-05',
      applicantRelation: '父亲',
      insured: '赵六',
      insuredRelation: '儿子',
      insuredIdNumber: '330106201103042419',
      insuredBirthday: '2011-03-04',
      date: '2020-06-07',
      paymentPeriod: '5年交',
      coveragePeriod: '至70岁',
      amount: 8888,
      firstPremium: 999,
      plans: [
        {
          company: '新华保险',
          role: 'main',
          name: '新版产品',
          matchedProductName: '新版产品',
          amount: 1,
          coveragePeriod: '旧主险期间',
          paymentMode: '年交',
          paymentPeriod: '旧主险缴费',
          premium: 2,
        },
        {
          company: '新华保险',
          role: 'rider',
          name: '新版附加险',
          matchedProductName: '新版附加险',
          amount: 3333,
          coveragePeriod: '30年',
          paymentMode: '月交',
          paymentPeriod: '5年交',
          premium: 44,
        },
      ],
    };

    const { response, payload } = await jsonFetch(server.baseUrl, '/api/policies/10', {
      method: 'PATCH',
      body: update,
    });
    const loaded = await jsonFetch(server.baseUrl, '/api/policies/10', {
      method: 'GET',
    });

    assert.ok([200, 202].includes(response.status));
    assert.equal(loaded.response.status, 200);
    const policy = loaded.payload.policy;
    for (const key of [
      'company',
      'name',
      'applicant',
      'applicantBirthday',
      'beneficiary',
      'beneficiaryRelation',
      'beneficiaryBirthday',
      'applicantRelation',
      'insured',
      'insuredRelation',
      'insuredIdNumber',
      'insuredBirthday',
      'date',
      'paymentPeriod',
      'coveragePeriod',
    ]) {
      assert.equal(policy[key], update[key], key);
      assert.equal(payload.policy[key], update[key], `response ${key}`);
    }
    assert.equal(policy.amount, 8888);
    assert.equal(policy.firstPremium, 999);
    assert.equal(policy.plans[0].amount, 8888);
    assert.equal(policy.plans[0].premium, 999);
    assert.equal(policy.plans[0].coveragePeriod, '至70岁');
    assert.equal(policy.plans[0].paymentPeriod, '5年交');
    assert.equal(policy.plans[1].name, '新版附加险');
    assert.equal(policy.plans[1].amount, 3333);
    assert.equal(policy.plans[1].premium, 44);
    assert.equal(policy.plans[1].coveragePeriod, '30年');
    assert.equal(policy.plans[1].paymentPeriod, '5年交');
  } finally {
    await server.close();
  }
});
