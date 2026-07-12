import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentQuestionHandlers } from '../server/agent-question-handlers.service.mjs';
import { buildFamilySalesChatContext } from '../server/family-sales-chat.service.mjs';

const NOW = '2026-07-12T08:00:00.000Z';

function harness(state = {}, overrides = {}) {
  const calls = { enqueued: [], knowledge: [], salesChat: [], upload: [] };
  const deps = {
    store: { async load() { return state; } },
    authorizedFamilyDataLoader: async ({ familyId }) => ({
      family: (state.familyProfiles || []).find((row) => Number(row.id) === familyId) || { id: familyId },
      state,
    }),
    clock: () => new Date(NOW),
    links: {
      familyReport: ({ familyId }) => `/customer/families/${familyId}/report`,
      salesReview: ({ familyId }) => `/customer/families/${familyId}/sales-review`,
      upload: ({ internalUserId }) => `/customer/upload?user=${internalUserId}`,
    },
    allowedKnowledgeOrigins: ['https://example.test'],
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
    authorizedFamilySalesDataLoader: async ({ familyId }) => ({
      input: { dataQuality: { pendingFields: ['budget'] } },
      family: (state.familyProfiles || []).find((row) => Number(row.id) === familyId) || { id: familyId },
      members: (state.familyMembers || []).filter((row) => Number(row.familyId) === familyId),
      policies: (state.policies || []).filter((row) => Number(row.familyId) === familyId),
      familyReports: state.familyReports || [],
      familySalesReviews: state.familySalesReviews || [],
      history: [],
    }),
    buildFamilySalesChatContext: (input) => ({ builtByExistingService: true, familyId: input.family?.id }),
    generateFamilySalesChatReply: async (input) => {
      calls.salesChat.push(input);
      return {
        content: '先确认客户预算。',
        model: 'existing-family-sales-agent',
        sources: [{ kind: 'family_sales_chat', ref: 'thread-1', secret: 'internal' }],
        generatedAt: NOW,
      };
    },
    ...overrides,
  };
  return { handlers: createAgentQuestionHandlers(deps), calls };
}

test('family summary counts only active members and currently valid family policies', async () => {
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
  assert.match(result.provenance.validPolicyDefinition, /业务状态.*保障期间/);
  assert.doesNotMatch(JSON.stringify(result), /张三|P-SECRET/);
});

test('family summary excludes business-inactive and expired policies even when outer status is active', async () => {
  const { handlers } = harness({ policies: [
    { id: 1, familyId: 7, status: 'active', policyState: '失效', coveragePeriod: '终身' },
    { id: 2, familyId: 7, status: 'active', contractStatus: '有效', coveragePeriod: '至2026年07月11日' },
    { id: 3, familyId: 7, status: 'active', validityStatus: '有效', coveragePeriod: '终身' },
  ] });

  const result = await handlers.execute('family_policy_summary', { familyId: 7, internalUserId: 9 });

  assert.equal(result.facts.policyCount, 3);
  assert.equal(result.facts.validPolicyCount, 1);
});

test('fresh family coverage report returns a safe summary and login link', async () => {
  const { handlers, calls } = harness({ familyReports: [{
    id: 21,
    familyId: 7,
    status: 'active',
    sourceUpdatedAt: '2026-07-10T00:00:00.000Z',
    generatedAt: '2026-07-11T00:00:00.000Z',
    summary: { policyCount: 2, note: '张三 13800138000 保单 P123456' },
    report: { familyPolicyAnalysisReport: { status: 'complete', generatedAt: '2026-07-11T00:00:00.000Z' } },
  }] });

  const result = await handlers.execute('view_family_coverage_report', { familyId: 7, internalUserId: 9 });

  assert.equal(result.facts.status, 'fresh');
  assert.equal(result.presentation.secureLink, '/customer/families/7/report');
  assert.equal(calls.enqueued.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /张三|13800138000|P123456/);
});

test('coverage report requires a complete nested policy analysis report', async () => {
  const missing = harness({ familyReports: [{ familyId: 7, status: 'active', generatedAt: '2026-07-11T00:00:00.000Z', report: {} }] });
  const pending = harness({ familyReports: [{
    familyId: 7,
    status: 'active',
    generatedAt: '2026-07-11T00:00:00.000Z',
    report: { familyPolicyAnalysisReport: { status: 'pending', generatedAt: '2026-07-11T00:00:00.000Z' } },
  }] });

  const missingResult = await missing.handlers.execute('view_family_coverage_report', { familyId: 7, internalUserId: 9 });
  const pendingResult = await pending.handlers.execute('view_family_coverage_report', { familyId: 7, internalUserId: 9 });

  assert.equal(missingResult.provenance.reason, 'missing');
  assert.equal(pendingResult.provenance.reason, 'pending');
});

test('stale and missing reports enqueue once per family and job type while in flight', async () => {
  const { handlers, calls } = harness({
    familyReports: [{
      familyId: 7,
      status: 'active',
      sourceUpdatedAt: '2026-07-12T01:00:00.000Z',
      report: { familyPolicyAnalysisReport: { status: 'complete', generatedAt: '2026-07-11T00:00:00.000Z' } },
    }],
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
    return { answer: '等待期为90天', sources: [{ title: '官方条款', url: 'https://example.test/terms', provenance: 'official', verified: true }] };
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

test('sales coaching adapts authorized context to the existing family sales chat agent', async () => {
  const { handlers, calls } = harness({
    familyMembers: [{ familyId: 7, name: '张三', status: 'active' }],
    policies: [{ familyId: 7, status: 'active', coveragePeriod: '终身' }],
    familySalesMemories: [{ familyId: 7, content: 'Hermes secret', status: 'confirmed' }],
  });

  const result = await handlers.sales_champion({
    intent: 'sales_coaching',
    familyId: 7,
    internalUserId: 9,
    question: '  怎么沟通\n',
    hermesMemory: 'do not pass',
    permission: 'admin',
    attachment: { bytes: 'raw' },
  });

  assert.deepEqual(Object.keys(calls.salesChat[0]).sort(), ['context', 'history', 'question']);
  assert.deepEqual(calls.salesChat[0], {
    question: '怎么沟通',
    history: [],
    context: { builtByExistingService: true, familyId: 7 },
  });
  assert.doesNotMatch(JSON.stringify(calls.salesChat[0]), /Hermes|permission|memory|attachment|raw/i);
  assert.equal(result.facts.answer, '先确认客户预算。');
  assert.equal(result.provenance.agent, 'existing_family_sales_chat');
  assert.deepEqual(result.provenance.sources, [{ kind: 'family_sales_chat', ref: 'thread-1' }]);
});

test('sales coaching uses trusted thread history and the real context-builder signature', async () => {
  const state = {
    familyProfiles: [{ id: 7, ownerUserId: 9 }],
    familyMembers: [{ familyId: 7, status: 'active' }],
    policies: [{ familyId: 7, status: 'active' }],
    familyReports: [{ familyId: 7, status: 'active' }],
    familySalesReviews: [{ familyId: 7, status: 'active' }],
  };
  let buildInput;
  let generateInput;
  const { handlers } = harness(state, {
    authorizedFamilySalesDataLoader: async ({ internalUserId, familyId }) => ({
      input: { confirmed: true },
      family: state.familyProfiles[0],
      members: state.familyMembers,
      policies: state.policies,
      familyReports: state.familyReports,
      familySalesReviews: state.familySalesReviews,
      history: [{ role: 'user', content: '网站线程中的上一问' }],
      authorizedBy: { internalUserId, familyId },
    }),
    buildFamilySalesChatContext(input) { buildInput = input; return { safe: true }; },
    async generateFamilySalesChatReply(input) { generateInput = input; return { content: '沿用现有续聊回答' }; },
  });

  await handlers.sales_champion({ intent: 'sales_coaching', familyId: 7, internalUserId: 9, question: '继续' });

  assert.deepEqual(Object.keys(buildInput).sort(), ['family', 'familyReports', 'familySalesReviews', 'generatedAt', 'input', 'members', 'policies']);
  assert.deepEqual(generateInput, {
    context: { safe: true },
    history: [{ role: 'user', content: '网站线程中的上一问' }],
    question: '继续',
  });
});

test('sales coaching can use the production family sales chat context builder unchanged', async () => {
  let generateInput;
  const { handlers } = harness({
    familyProfiles: [{ id: 7, ownerUserId: 9 }],
    familyMembers: [{ id: 1, familyId: 7, status: 'active' }],
    policies: [{ id: 2, familyId: 7, status: 'active' }],
    familyReports: [],
    familySalesReviews: [],
  }, {
    buildFamilySalesChatContext,
    async generateFamilySalesChatReply(input) { generateInput = input; return { content: '现有服务回答' }; },
  });

  await handlers.sales_champion({ intent: 'sales_coaching', familyId: 7, internalUserId: 9, question: '继续分析' });

  assert.equal(generateInput.context.familyInput.dataQuality.pendingFields[0], 'budget');
  assert.equal(generateInput.context.latestSalesReview, null);
  assert.equal(generateInput.context.latestFamilyReport, null);
  assert.equal(generateInput.question, '继续分析');
});

test('safe summaries do not copy numeric phone, identity, or account fields', async () => {
  const { handlers } = harness({ familySalesReviews: [{
    id: 31,
    familyId: 7,
    status: 'active',
    generatedAt: '2026-07-11T00:00:00.000Z',
    inputSummary: {
      policyCount: 2,
      mobile: 13800138000,
      identityNumber: 110101199001011234,
      accountNumber: 6222021234567890,
    },
  }] });

  const result = await handlers.execute('view_sales_advice_report', { familyId: 7, internalUserId: 9 });
  const serialized = JSON.stringify(result);

  assert.equal(result.facts.summary.policyCount, 2);
  assert.doesNotMatch(serialized, /13800138000|110101199001011234|6222021234567890/);
});

test('queued report job remains deduplicated after enqueue resolves until completion', async () => {
  let status = 'running';
  const base = harness({ familyReports: [] });
  base.handlers = createAgentQuestionHandlers({
    store: { async load() { return { familyReports: [] }; } },
    authorizedFamilyDataLoader: async ({ familyId }) => ({ family: { id: familyId }, state: { familyReports: [] } }),
    links: {},
    reportQueue: {
      async enqueue(input) { base.calls.enqueued.push(input); return { jobId: 'persistent-job', status: 'queued', progress: 0 }; },
      async getStatus() { return { jobId: 'persistent-job', status, progress: 20 }; },
    },
  });

  const first = await base.handlers.execute('view_family_coverage_report', { familyId: 7, internalUserId: 9 });
  const second = await base.handlers.execute('view_family_coverage_report', { familyId: 7, internalUserId: 9 });

  assert.equal(first.facts.jobId, 'persistent-job');
  assert.equal(second.facts.progress, 20);
  assert.equal(base.calls.enqueued.length, 1);
  status = 'failed';
  await base.handlers.execute('view_family_coverage_report', { familyId: 7, internalUserId: 9 });
  assert.equal(base.calls.enqueued.length, 2);
});

test('report queue may provide enqueueUnique without enqueue', async () => {
  let calls = 0;
  const { handlers } = harness({ familyReports: [] }, {
    reportQueue: {
      async enqueueUnique(input) { calls += 1; return { jobId: input.dedupeKey, status: 'queued' }; },
    },
  });

  const result = await handlers.execute('view_family_coverage_report', { familyId: 7, internalUserId: 9 });

  assert.equal(result.facts.status, 'processing');
  assert.equal(calls, 1);
});

test('completed job stays syncing until report persistence or TTL without re-enqueue', async () => {
  let enqueueCount = 0;
  const { handlers } = harness({ familyReports: [] }, {
    reportQueue: {
      async enqueue() { enqueueCount += 1; return { jobId: 'job-complete', status: 'queued' }; },
      async getStatus() { return { jobId: 'job-complete', status: 'completed', progress: 100 }; },
    },
    reloadAuthorizedFamilyData: async ({ familyId }) => ({ family: { id: familyId }, state: { familyReports: [] } }),
  });

  await handlers.execute('view_family_coverage_report', { familyId: 7, internalUserId: 9 });
  const completed = await handlers.execute('view_family_coverage_report', { familyId: 7, internalUserId: 9 });
  const stillSyncing = await handlers.execute('view_family_coverage_report', { familyId: 7, internalUserId: 9 });

  assert.equal(completed.facts.status, 'syncing');
  assert.equal(stillSyncing.facts.status, 'syncing');
  assert.equal(enqueueCount, 1);
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

test('family handlers deny direct execution when the authorized loader rejects the family', async () => {
  const { handlers, calls } = harness({}, {
    authorizedFamilyDataLoader: async () => null,
    authorizedFamilySalesDataLoader: async () => { throw new Error('must not be called'); },
  });

  const summary = await handlers.execute('family_summary', { familyId: 99, internalUserId: 9 });
  const report = await handlers.execute('coverage_report', { familyId: 99, internalUserId: 9 });
  const coaching = await handlers.execute('sales_coaching', { familyId: 99, internalUserId: 9, question: '继续' });

  assert.equal(summary.facts.denied, true);
  assert.equal(report.facts.denied, true);
  assert.equal(coaching.facts.denied, true);
  assert.equal(calls.salesChat.length, 0);
});

test('links and knowledge sources reject external, userinfo, and unverified URLs', async () => {
  const { handlers } = harness({}, {
    links: {
      upload: () => '//evil.test/upload',
      familyReport: () => 'https://user:pass@example.test/report',
    },
    allowedLinkOrigins: ['https://example.test'],
    allowedKnowledgeOrigins: ['https://example.test'],
    productKnowledge: { async search() { return {
      answer: '不应成为确定事实',
      sources: [
        { verified: false, title: '未验证', url: 'https://example.test/a' },
        { verified: true, title: '恶意', url: 'javascript:alert(1)' },
        { verified: true, title: '用户信息', url: 'https://user@example.test/a' },
      ],
    }; } },
  });

  const upload = await handlers.execute('upload_link', { internalUserId: 9 });
  const knowledge = await handlers.execute('insurance_product_knowledge', { internalUserId: 9, question: '产品事实' });

  assert.equal(upload.presentation.secureLink, '');
  assert.equal(knowledge.facts.certainty, 'unverified');
  assert.deepEqual(knowledge.provenance.sources, []);
});
