import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeInsurancePolicyResponsibilities } from '../server/c-policy-analysis.service.mjs';
import { createInsuranceExpertTool } from '../server/insurance-expert-tool.service.mjs';
import { createWukongMcpGateway } from '../server/wukong-mcp-gateway.service.mjs';

function fixture() {
  return {
    users: [{ id: 7, name: '张三', status: 'active' }],
    userDingtalkIdentities: [{ corpId: 'corp', dingUserId: 'ding', userId: 7, status: 'active' }],
    familyProfiles: [
      { id: 11, ownerUserId: 7, status: 'active' },
      { id: 12, ownerUserId: 8, status: 'active' },
    ],
    policies: [
      { id: 31, userId: 7, familyId: 11, company: '可信保险', name: '安心保', canonicalProductId: 'product-1', policyNumber: 'RAW-POLICY-7788' },
      { id: 32, userId: 8, familyId: 12, company: '他人保险', name: '他人保', canonicalProductId: 'product-2' },
    ],
    agentPolicyImportTasks: [{
      id: 51, familyId: 11, ownerUserId: 7, targetAgent: 'insurance_expert',
      draft: { company: '可信保险', name: '安心保', canonicalProductId: 'product-1', insured: '张小明', rawOcr: 'RAW_SCAN_SECRET' },
      rawOcr: 'RAW_SCAN_SECRET', storagePath: '/tmp/private.jpg', documents: [],
    }],
    officialDomainProfiles: [{ company: '可信保险', officialDomains: ['official.insurer.test'] }],
    knowledgeRecords: [{
      id: 71, canonicalProductId: 'product-1', company: '可信保险', productName: '安心保',
      title: '安心保正式条款', url: 'https://official.insurer.test/terms-v3.pdf', official: true,
      evidenceLabel: '保险公司官方条款', evidenceLevel: 'insurer_official', versionNo: 'v3', pageText: '身故保险金按基本保险金额给付。',
    }],
  };
}

function analysis(overrides = {}) {
  return {
    analysis: { coverageTable: [{ coverageType: '身故保险金', scenario: '身故', payout: '基本保险金额', note: '' }] },
    sources: [{
      title: '安心保正式条款', url: 'https://official.insurer.test/terms-v3.pdf',
      evidenceLabel: '保险公司官方条款', evidenceLevel: 'insurer_official', official: true,
    }],
    ...overrides,
  };
}

test('resolves only owned policies and insurance-expert tasks in the same family', async () => {
  const state = fixture();
  const ask = createInsuranceExpertTool({ state, analyze: async () => analysis() });
  await assert.rejects(ask({ owner: { userId: 7 }, policyRef: 32, question: '保障什么？' }), { code: 'POLICY_NOT_FOUND' });
  state.agentPolicyImportTasks.push({ id: 52, familyId: 12, ownerUserId: 7, targetAgent: 'insurance_expert', draft: state.agentPolicyImportTasks[0].draft });
  await assert.rejects(ask({ owner: { userId: 7 }, policyRef: 31, policyImportTaskId: 52, question: '保障什么？' }), { code: 'POLICY_IMPORT_NOT_FOUND' });
  state.agentPolicyImportTasks[0].targetAgent = 'sales_champion';
  await assert.rejects(ask({ owner: { userId: 7 }, policyImportTaskId: 51, question: '保障什么？' }), { code: 'POLICY_IMPORT_NOT_FOUND' });
});

test('passes a safe internal projection and never returns raw scan or policy data', async () => {
  const state = fixture();
  let input;
  const ask = createInsuranceExpertTool({ state, analyze: async (value) => { input = value; return analysis(); } });
  const result = await ask({ owner: { userId: 7 }, policyImportTaskId: 51, question: '保障什么？', requestId: 'req' });
  assert.deepEqual(Object.keys(input.policy).sort(), ['canonicalProductId', 'company', 'name']);
  assert.equal(input.ocrText, '');
  assert.equal(input.allowExternalReferences, false);
  const serialized = JSON.stringify({ input, result });
  for (const secret of ['RAW_SCAN_SECRET', 'RAW-POLICY-7788', '张小明', '/tmp/private.jpg', 'documents']) assert.doesNotMatch(serialized, new RegExp(secret));
});

test('preserves official evidence label, source reference, and current version', async () => {
  const ask = createInsuranceExpertTool({ state: fixture(), analyze: async () => analysis() });
  const result = await ask({ owner: { userId: 7 }, policyRef: 31, question: '保障什么？' });
  assert.deepEqual(result.evidence, [{
    label: '保险公司官方条款', sourceRef: 'knowledge:71', version: 'v3', url: 'https://official.insurer.test/terms-v3.pdf',
  }]);
  assert.match(result.answer, /身故保险金/u);
});

test('rejects superseded product-version evidence', async () => {
  const state = fixture();
  state.knowledgeRecords.push({
    ...state.knowledgeRecords[0], id: 70, versionNo: 'v2',
    url: 'https://official.insurer.test/terms-v2.pdf', title: '安心保旧版条款',
  });
  const oldAnalysis = analysis({ sources: [{
    title: '安心保旧版条款', url: 'https://official.insurer.test/terms-v2.pdf',
    evidenceLabel: '保险公司官方条款', evidenceLevel: 'insurer_official', official: true,
  }] });
  await assert.rejects(createInsuranceExpertTool({ state, analyze: async () => oldAnalysis })({
    owner: { userId: 7 }, policyRef: 31, question: '问题',
  }), { code: 'POLICY_EVIDENCE_NOT_FOUND' });
});

test('fails closed when product evidence is absent, mismatched, or analyzer omits official evidence', async () => {
  const state = fixture();
  const missing = structuredClone(state); missing.knowledgeRecords = [];
  await assert.rejects(createInsuranceExpertTool({ state: missing, analyze: async () => analysis() })({ owner: { userId: 7 }, policyRef: 31, question: '问题' }), { code: 'POLICY_EVIDENCE_NOT_FOUND' });
  const mismatch = structuredClone(state); mismatch.knowledgeRecords[0].canonicalProductId = 'different'; mismatch.knowledgeRecords[0].productName = '其他产品';
  await assert.rejects(createInsuranceExpertTool({ state: mismatch, analyze: async () => analysis() })({ owner: { userId: 7 }, policyRef: 31, question: '问题' }), { code: 'POLICY_EVIDENCE_NOT_FOUND' });
  await assert.rejects(createInsuranceExpertTool({ state, analyze: async () => analysis({ sources: [] }) })({ owner: { userId: 7 }, policyRef: 31, question: '问题' }), { code: 'POLICY_EVIDENCE_NOT_FOUND' });
});

test('reports missing analysis evidence and keeps high-risk cautions', async () => {
  const ask = createInsuranceExpertTool({ state: fixture(), analyze: async () => ({ ...analysis(), analysis: { coverageTable: [] } }) });
  const result = await ask({ owner: { userId: 7 }, policyRef: 31, question: '我要退保换保，理赔和核保会怎样？' });
  assert.ok(result.missingInformation.includes('官方证据未提供可确认的保险责任。'));
  assert.match(result.limitations.join(' '), /退保|换保/u);
  assert.match(result.limitations.join(' '), /核保/u);
  assert.match(result.limitations.join(' '), /理赔/u);
});

test('timeout aborts analyzer work and prevents abort-guarded late mutation', async () => {
  let signal;
  let lateMutation = false;
  const ask = createInsuranceExpertTool({
    state: fixture(), timeoutMs: 5,
    analyze: ({ signal: received }) => new Promise((resolve, reject) => {
      signal = received;
      const timer = setTimeout(() => { if (!received.aborted) lateMutation = true; resolve(analysis()); }, 25);
      received.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
    }),
  });
  await assert.rejects(ask({ owner: { userId: 7 }, policyRef: 31, question: '问题' }), { code: 'AGENT_TIMEOUT', status: 504 });
  assert.equal(signal.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(lateMutation, false);
});

test('analyzer propagates caller abort to the provider fetch signal', async () => {
  const previous = {
    apiKey: process.env.DEEPSEEK_API_KEY,
    smartSearch: process.env.POLICY_ANALYSIS_SMART_SEARCH_ENABLED,
  };
  process.env.DEEPSEEK_API_KEY = 'test-key';
  process.env.POLICY_ANALYSIS_SMART_SEARCH_ENABLED = 'false';
  const controller = new AbortController();
  let providerSignal;
  let releaseFirst;
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    providerSignal = options.signal;
    if (calls === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    return new Response(JSON.stringify({
      model: 'test-model',
      choices: [{ message: { content: calls === 1
        ? '{"documentType":"unknown","skills":[],"promptDirectives":[],"reason":"test"}'
        : '{"coverageTable":[{"coverageType":"身故保险金","scenario":"身故","payout":"基本保险金额","note":""}]}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const pending = analyzeInsurancePolicyResponsibilities({
    policy: { company: '可信保险', name: '安心保' }, fetchImpl, signal: controller.signal,
  });
  while (!providerSignal) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(providerSignal.aborted, true);
  } finally {
    releaseFirst();
    await pending.catch(() => {});
    if (previous.apiKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous.apiKey;
    if (previous.smartSearch === undefined) delete process.env.POLICY_ANALYSIS_SMART_SEARCH_ENABLED; else process.env.POLICY_ANALYSIS_SMART_SEARCH_ENABLED = previous.smartSearch;
  }
});

test('MCP schema is strict, derives owner, injects request id, and supports HTTP registry metadata', async () => {
  const state = fixture();
  let received;
  const gateway = createWukongMcpGateway({ state, insuranceExpert: async (input) => { received = input; return { answer: 'ok' }; } });
  assert.ok(gateway.toolNames.includes('ask_insurance_expert'));
  const metadata = gateway.toolMetadata.find((tool) => tool.name === 'ask_insurance_expert');
  assert.deepEqual(metadata.inputSchema.required, ['question']);
  assert.deepEqual(Object.keys(metadata.inputSchema.properties).sort(), ['policyImportTaskId', 'policyRef', 'question']);
  await gateway.invoke({ corpId: 'corp', dingUserId: 'ding', conversationType: 'direct', requestId: 'outer', tool: 'ask_insurance_expert', input: { policyRef: 31, question: '问题' } });
  assert.equal(received.owner.userId, 7);
  assert.equal(received.requestId, 'outer');
  await assert.rejects(gateway.invoke({ corpId: 'corp', dingUserId: 'ding', conversationType: 'direct', requestId: 'forged', tool: 'ask_insurance_expert', input: { policyRef: 31, question: '问题', rawPolicy: {} } }), { code: 'INVALID_TOOL_INPUT' });
});
