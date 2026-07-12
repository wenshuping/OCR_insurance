import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentQuestionHandlers } from '../server/agent-question-handlers.service.mjs';

const NOW = '2026-07-12T08:00:00.000Z';

function harness(state = {}, overrides = {}) {
  const calls = { enqueued: [], knowledge: [], coaching: [], upload: [] };
  const deps = {
    store: { async load() { return state; } },
    clock: () => new Date(NOW),
    links: {
      familyReport: ({ familyId }) => `/customer/families/${familyId}/report`,
      salesReview: ({ familyId }) => `/customer/families/${familyId}/sales-review`,
      upload: ({ internalUserId }) => `/customer/upload?user=${internalUserId}`,
    },
    reportQueue: {
      async enqueue(input) {
        calls.enqueued.push(input);
        return { jobId: `job-${calls.enqueued.length}`, progress: 0 };
      },
    },
    productKnowledge: {
      async search(input) {
        calls.knowledge.push(input);
        return { answer: '等待测试覆盖', sources: [] };
      },
    },
    salesCoaching: {
      async answer(input) {
        calls.coaching.push(input);
        return { guidance: ['先确认预算'] };
      },
    },
    ...overrides,
  };
  return { handlers: createAgentQuestionHandlers(deps), calls };
}

test('family summary counts only active members and explicitly valid family policies', async () => {
  const { handlers } = harness({
    familyMembers: [
      { id: 1, familyId: 7, name: '张三', status: 'active' },
      { id: 2, familyId: 7, name: '李四', status: 'archived' },
      { id: 3, familyId: 8, name: '王五', status: 'active' },
    ],
    policies: [
      { id: 10, familyId: 7, policyNo: 'P-SECRET-1', status: '有效' },
      { id: 11, familyId: 7, status: '失效' },
      { id: 12, familyId: 7, status: 'active' },
      { id: 13, familyId: 8, status: 'active' },
    ],
  });

  const result = await handlers.execute('family_policy_summary', { familyId: 7, internalUserId: 9 });

  assert.deepEqual(result.facts, { familyId: 7, activeMemberCount: 1, policyCount: 3, validPolicyCount: 2 });
  assert.match(result.provenance.validPolicyDefinition, /有效|active/);
  assert.doesNotMatch(JSON.stringify(result), /张三|P-SECRET/);
});

test('fresh family coverage report returns a safe summary and login link', async () => {
  const { handlers, calls } = harness({ familyReports: [{
    id: 21,
    familyId: 7,
    status: 'complete',
    sourceUpdatedAt: '2026-07-10T00:00:00.000Z',
    generatedAt: '2026-07-11T00:00:00.000Z',
    summary: { policyCount: 2, note: '张三 13800138000 保单 P123456' },
  }] });

  const result = await handlers.execute('view_family_coverage_report', { familyId: 7, internalUserId: 9 });

  assert.equal(result.facts.status, 'fresh');
  assert.equal(result.presentation.secureLink, '/customer/families/7/report');
  assert.equal(calls.enqueued.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /张三|13800138000|P123456/);
});

test('stale and missing reports enqueue once per family and job type while in flight', async () => {
  const { handlers, calls } = harness({
    familyReports: [{ familyId: 7, status: 'complete', sourceUpdatedAt: '2026-07-12T01:00:00.000Z', generatedAt: '2026-07-11T00:00:00.000Z' }],
    familySalesReviews: [],
  });

  const [first, second] = await Promise.all([
    handlers.execute('view_family_coverage_report', { familyId: 7, internalUserId: 9 }),
    handlers.execute('view_family_coverage_report', { familyId: 7, internalUserId: 9 }),
  ]);
  const missing = await handlers.execute('view_sales_advice_report', { familyId: 7, internalUserId: 9 });

  assert.equal(calls.enqueued.length, 2);
  assert.equal(first.facts.status, 'processing');
  assert.equal(second.facts.jobId, first.facts.jobId);
  assert.equal(first.facts.jobType, 'family_policy_analysis');
  assert.equal(missing.facts.jobType, 'family_sales_review');
});

test('sales advice freshness uses the same generated-versus-source boundary', async () => {
  const fresh = harness({ familySalesReviews: [{
    id: 31,
    familyId: 7,
    status: 'active',
    sourceUpdatedAt: '2026-07-10T00:00:00.000Z',
    generatedAt: '2026-07-11T00:00:00.000Z',
    inputSummary: { policyCount: 4 },
  }] });
  const stale = harness({ familySalesReviews: [{
    id: 32,
    familyId: 7,
    status: 'active',
    sourceUpdatedAt: '2026-07-12T00:00:00.000Z',
    generatedAt: '2026-07-11T00:00:00.000Z',
  }] });

  const ready = await fresh.handlers.execute('view_sales_advice_report', { familyId: 7, internalUserId: 9 });
  const queued = await stale.handlers.execute('view_sales_advice_report', { familyId: 7, internalUserId: 9 });

  assert.equal(ready.facts.status, 'fresh');
  assert.deepEqual(ready.facts.summary, { policyCount: 4 });
  assert.equal(ready.presentation.secureLink, '/customer/families/7/sales-review');
  assert.equal(queued.facts.status, 'processing');
  assert.equal(stale.calls.enqueued.length, 1);
});

test('product knowledge requires public sources for definite facts', async () => {
  const sourced = harness({}, { productKnowledge: { async search(input) {
    sourced.calls.knowledge.push(input);
    return { answer: '等待期为90天', sources: [{ title: '官方条款', url: 'https://example.test/terms', provenance: 'official' }] };
  } } });
  const noSource = harness();

  const certain = await sourced.handlers.execute('insurance_product_knowledge', { question: '等待期多久', internalUserId: 9 });
  const uncertain = await noSource.handlers.execute('insurance_product_knowledge', { question: '等待期多久', internalUserId: 9 });

  assert.equal(certain.facts.certainty, 'supported');
  assert.equal(certain.provenance.sources.length, 1);
  assert.equal(sourced.calls.knowledge[0].scope, 'public_read_only');
  assert.equal(uncertain.facts.certainty, 'unverified');
  assert.doesNotMatch(JSON.stringify(uncertain), /等待测试覆盖/);
});

test('sales coaching receives only confirmed minimal facts and marks pending fields', async () => {
  const { handlers, calls } = harness({
    familyMembers: [{ familyId: 7, name: '张三', status: 'active' }],
    familySalesMemories: [{ familyId: 7, content: 'Hermes secret', status: 'confirmed' }],
  });

  const result = await handlers.execute('sales_coaching', {
    familyId: 7,
    internalUserId: 9,
    question: '怎么沟通',
    confirmedFacts: { policyCount: 2, annualPremium: 10000 },
    pendingFields: ['budget'],
    hermesMemory: 'do not pass',
  });

  assert.deepEqual(Object.keys(calls.coaching[0]).sort(), ['confirmedFacts', 'pendingFields', 'question']);
  assert.equal(JSON.stringify(calls.coaching[0]).includes('Hermes'), false);
  assert.deepEqual(result.facts.pendingConfirmation, ['budget']);
});

test('upload link ignores attachments and unknown actions are denied', async () => {
  const { handlers, calls } = harness();

  const upload = await handlers.execute('upload_link', {
    internalUserId: 9,
    attachment: { bytes: 'raw' },
    image: 'base64',
  });
  const unknown = await handlers.execute('destroy_database', { internalUserId: 9 });
  const write = await handlers.execute('transfer_preview', { internalUserId: 9 });

  assert.equal(upload.presentation.secureLink, '/customer/upload?user=9');
  assert.equal(calls.upload.length, 0);
  assert.equal(JSON.stringify(upload).includes('raw'), false);
  assert.equal(unknown.facts.denied, true);
  assert.equal(write.facts.confirmationRequired, true);
  assert.equal(Object.isFrozen(handlers), true);
  assert.equal(Object.isFrozen(handlers.registry), true);
});
