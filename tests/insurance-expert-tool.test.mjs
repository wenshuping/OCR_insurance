import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeInsurancePolicyResponsibilities, extractPdfTextWithPython } from '../server/c-policy-analysis.service.mjs';
import { createAgentPolicyImportTask } from '../server/agent-policy-import.service.mjs';
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
      { id: 31, userId: 7, familyId: 11, company: '可信保险', name: '安心保', canonicalProductId: 'product-1', versionNo: 'v3', effectiveDate: '2026-01-01', policyNumber: 'RAW-POLICY-7788' },
      { id: 32, userId: 8, familyId: 12, company: '他人保险', name: '他人保', canonicalProductId: 'product-2' },
    ],
    agentPolicyImportTasks: [{
      id: 51, familyId: 11, ownerUserId: 7, targetAgent: 'insurance_expert',
      status: 'final_confirmation', productResolution: 'trusted_match',
      draft: { company: '可信保险', name: '安心保', canonicalProductId: 'product-1', versionNo: 'v3', effectiveDate: '2026-01-01', insured: '张小明', rawOcr: 'RAW_SCAN_SECRET' },
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

test('canonical policy import task retains trusted product version fields', () => {
  const task = createAgentPolicyImportTask({
    id: 1, familyId: 11, owner: { userId: 7 }, targetAgent: 'insurance_expert',
    draft: { company: '可信保险', name: '安心保', insured: '张三', versionNo: 'v3', effectiveDate: '2026-01-01' },
  });
  assert.equal(task.draft.versionNo, 'v3');
  assert.equal(task.draft.effectiveDate, '2026-01-01');
});

test('resolves only owned policies and insurance-expert tasks in the same family', async () => {
  const state = fixture();
  const ask = createInsuranceExpertTool({ state, analyze: async () => analysis() });
  await assert.rejects(ask({ owner: { userId: 7 }, policyRef: 32, question: '保障什么？' }), { code: 'POLICY_NOT_FOUND' });
  state.agentPolicyImportTasks.push({ id: 52, familyId: 12, ownerUserId: 7, targetAgent: 'insurance_expert', draft: state.agentPolicyImportTasks[0].draft });
  await assert.rejects(ask({ owner: { userId: 7 }, policyRef: 31, policyImportTaskId: 52, question: '保障什么？' }), { code: 'POLICY_IMPORT_NOT_FOUND' });
  state.agentPolicyImportTasks[0].targetAgent = 'sales_champion';
  await assert.rejects(ask({ owner: { userId: 7 }, policyImportTaskId: 51, question: '保障什么？' }), { code: 'POLICY_IMPORT_NOT_FOUND' });
});

test('rejects same-family policy and task references for different products before analysis', async () => {
  const state = fixture();
  state.agentPolicyImportTasks[0].draft = { company: '可信保险', name: '另一款', canonicalProductId: 'product-other' };
  let calls = 0;
  const ask = createInsuranceExpertTool({ state, analyze: async () => { calls += 1; return analysis(); } });
  await assert.rejects(ask({ owner: { userId: 7 }, policyRef: 31, policyImportTaskId: 51, question: '问题' }), { code: 'POLICY_TASK_MISMATCH' });
  assert.equal(calls, 0);
});

test('completed task must reference the exact formal policy', async () => {
  const state = fixture();
  state.agentPolicyImportTasks[0].status = 'completed';
  state.agentPolicyImportTasks[0].formalPolicyId = 999;
  await assert.rejects(createInsuranceExpertTool({ state, analyze: async () => analysis() })({
    owner: { userId: 7 }, policyRef: 31, policyImportTaskId: 51, question: '问题',
  }), { code: 'POLICY_TASK_MISMATCH' });
});

test('canonical product match still rejects a different product version', async () => {
  const state = fixture();
  state.agentPolicyImportTasks[0].draft.versionNo = 'v2';
  await assert.rejects(createInsuranceExpertTool({ state, analyze: async () => analysis() })({
    owner: { userId: 7 }, policyRef: 31, policyImportTaskId: 51, question: '问题',
  }), { code: 'POLICY_TASK_MISMATCH' });
});

test('task eligibility rejects processing and terminal failures before analysis', async () => {
  for (const status of ['uploading', 'recognizing', 'saving', 'cancelled', 'failed']) {
    const state = fixture();
    state.agentPolicyImportTasks[0].status = status;
    await assert.rejects(createInsuranceExpertTool({ state, analyze: async () => analysis() })({
      owner: { userId: 7 }, policyImportTaskId: 51, question: '问题',
    }), { code: 'POLICY_IMPORT_NOT_READY' });
  }
});

test('review tasks require resolved products and expose missing fields', async () => {
  const state = fixture();
  state.agentPolicyImportTasks[0].status = 'field_completion';
  state.agentPolicyImportTasks[0].productResolution = 'trusted_match';
  delete state.agentPolicyImportTasks[0].draft.insured;
  const result = await createInsuranceExpertTool({ state, analyze: async () => analysis() })({
    owner: { userId: 7 }, policyImportTaskId: 51, question: '问题',
  });
  assert.ok(result.missingInformation.some((item) => /被保险人/u.test(item)));
  state.agentPolicyImportTasks[0].productResolution = '';
  await assert.rejects(createInsuranceExpertTool({ state, analyze: async () => analysis() })({
    owner: { userId: 7 }, policyImportTaskId: 51, question: '问题',
  }), { code: 'POLICY_IMPORT_NOT_READY' });
});

test('passes a safe internal projection and never returns raw scan or policy data', async () => {
  const state = fixture();
  let input;
  const ask = createInsuranceExpertTool({ state, analyze: async (value) => { input = value; return analysis(); } });
  const result = await ask({ owner: { userId: 7 }, policyImportTaskId: 51, question: '保障什么？', requestId: 'req' });
  assert.deepEqual(Object.keys(input.policy).sort(), ['canonicalProductId', 'company', 'effectiveDate', 'name', 'versionNo']);
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

test('binds evidence to the selected policy version and effective interval', async () => {
  const state = fixture();
  state.knowledgeRecords.push({
    ...state.knowledgeRecords[0], id: 72, versionNo: 'v2', validTo: '2025-01-01',
    url: 'https://official.insurer.test/terms-v2.pdf',
  });
  let received;
  await createInsuranceExpertTool({ state, analyze: async (input) => { received = input; return analysis(); } })({
    owner: { userId: 7 }, policyRef: 31, question: '问题',
  });
  assert.deepEqual(received.knowledgeRecords.map((record) => record.versionNo), ['v3']);
  const unknown = structuredClone(state); delete unknown.policies[0].versionNo;
  const gap = await createInsuranceExpertTool({ state: unknown, analyze: async () => { throw new Error('must not run'); } })({ owner: { userId: 7 }, policyRef: 31, question: '问题' });
  assert.deepEqual(gap.evidence, []);
  assert.match(gap.missingInformation.join(' '), /版本/u);
});

test('rejects https evidence outside configured official domains before analyzer invocation', async () => {
  const state = fixture();
  state.knowledgeRecords[0].url = 'https://evil.example/terms.pdf';
  let calls = 0;
  const result = await createInsuranceExpertTool({ state, analyze: async () => { calls += 1; return analysis(); } })({ owner: { userId: 7 }, policyRef: 31, question: '问题' });
  assert.equal(calls, 0);
  assert.deepEqual(result.evidence, []);
});

test('rejects unsafe official evidence URL variants before analyzer invocation', async () => {
  const urls = [
    'http://official.insurer.test/terms.pdf',
    'ftp://official.insurer.test/terms.pdf',
    'https://user:password@official.insurer.test/terms.pdf',
    'https://official.insurer.test:8443/terms.pdf',
    'https://child.official.insurer.test/terms.pdf',
    'https://127.0.0.1/terms.pdf',
    'https://localhost/terms.pdf',
  ];
  for (const url of urls) {
    const state = fixture();
    state.knowledgeRecords[0].url = url;
    let calls = 0;
    const result = await createInsuranceExpertTool({ state, analyze: async () => { calls += 1; return analysis(); } })({ owner: { userId: 7 }, policyRef: 31, question: '问题' });
    assert.equal(calls, 0, url);
    assert.deepEqual(result.evidence, [], url);
  }
});

test('does not expose superseded product-version evidence', async () => {
  const state = fixture();
  state.knowledgeRecords.push({
    ...state.knowledgeRecords[0], id: 70, versionNo: 'v2',
    url: 'https://official.insurer.test/terms-v2.pdf', title: '安心保旧版条款',
  });
  const oldAnalysis = analysis({ sources: [{
    title: '安心保旧版条款', url: 'https://official.insurer.test/terms-v2.pdf',
    evidenceLabel: '保险公司官方条款', evidenceLevel: 'insurer_official', official: true,
  }] });
  const result = await createInsuranceExpertTool({ state, analyze: async () => oldAnalysis })({
    owner: { userId: 7 }, policyRef: 31, question: '问题',
  });
  assert.deepEqual(result.evidence, []);
  assert.match(result.answer, /证据不足/u);
});

test('excludes explicitly stale and expired evidence without falling back to it', async () => {
  const state = fixture();
  state.knowledgeRecords[0].isCurrent = false;
  state.knowledgeRecords.push({
    ...state.knowledgeRecords[0], id: 72, isCurrent: undefined, versionNo: 'v4',
    validFrom: '2020-01-01T00:00:00.000Z', validTo: '2021-01-01T00:00:00.000Z',
    url: 'https://official.insurer.test/terms-v4.pdf',
  });
  let calls = 0;
  const result = await createInsuranceExpertTool({ state, analyze: async () => { calls += 1; return analysis(); } })({
    owner: { userId: 7 }, policyRef: 31, question: '问题',
  });
  assert.equal(calls, 0);
  assert.deepEqual(result.evidence, []);
  assert.match(result.answer, /证据不足/u);
  assert.ok(result.missingInformation.length > 0);
});

test('returns a safe missing-evidence envelope for absent or mismatched current evidence', async () => {
  const state = fixture();
  const missing = structuredClone(state); missing.knowledgeRecords = [];
  const missingResult = await createInsuranceExpertTool({ state: missing, analyze: async () => { throw new Error('must not run'); } })({ owner: { userId: 7 }, policyRef: 31, question: '问题' });
  assert.deepEqual(missingResult.evidence, []);
  assert.match(missingResult.answer, /证据不足/u);
  assert.ok(missingResult.missingInformation.length > 0);
  const mismatch = structuredClone(state); mismatch.knowledgeRecords[0].canonicalProductId = 'different'; mismatch.knowledgeRecords[0].productName = '其他产品';
  const mismatchResult = await createInsuranceExpertTool({ state: mismatch, analyze: async () => { throw new Error('must not run'); } })({ owner: { userId: 7 }, policyRef: 31, question: '问题' });
  assert.deepEqual(mismatchResult.evidence, []);
  const analyzerGap = await createInsuranceExpertTool({ state, analyze: async () => analysis({ sources: [] }) })({ owner: { userId: 7 }, policyRef: 31, question: '问题' });
  assert.deepEqual(analyzerGap.evidence, []);
  assert.ok(analyzerGap.missingInformation.length > 0);
});

test('reports missing analysis evidence and keeps high-risk cautions', async () => {
  const ask = createInsuranceExpertTool({ state: fixture(), analyze: async () => ({ ...analysis(), analysis: { coverageTable: [] } }) });
  const result = await ask({ owner: { userId: 7 }, policyRef: 31, question: '我要退保换保，理赔和核保会怎样？' });
  assert.ok(result.missingInformation.includes('官方证据未提供可确认的保险责任。'));
  assert.match(result.limitations.join(' '), /退保|换保/u);
  assert.match(result.limitations.join(' '), /核保/u);
  assert.match(result.limitations.join(' '), /理赔/u);
});

test('passes the bounded question and returns only question-relevant analysis', async () => {
  const state = fixture();
  let receivedQuestion;
  const ask = createInsuranceExpertTool({ state, analyze: async ({ question }) => {
    receivedQuestion = question;
    return analysis({ analysis: { coverageTable: [
      { coverageType: '住院医疗保险金', scenario: '住院治疗', payout: '按约定比例报销', note: '' },
      { coverageType: '身故保险金', scenario: '身故', payout: '基本保险金额', note: '' },
    ] } });
  } });
  const result = await ask({ owner: { userId: 7 }, policyRef: 31, question: '住院 claim 能理赔吗？' });
  assert.equal(receivedQuestion, '住院 claim 能理赔吗？');
  assert.match(result.answer, /住院/u);
  assert.doesNotMatch(result.answer, /身故/u);
});

test('ignores analyzer prose while retaining multilingual high-risk cautions', async () => {
  const ask = createInsuranceExpertTool({ state: fixture(), analyze: async () => ({
    ...analysis(), answer: '退保金额必须向保险公司申请当期现金价值试算。',
  }) });
  const result = await ask({ owner: { userId: 7 }, policyRef: 31, question: 'Can I surrender / replace this policy and make a claim?' });
  assert.match(result.answer, /不足|核验/u);
  assert.doesNotMatch(result.answer, /退保金额必须/u);
  assert.match(result.limitations.join(' '), /退保/u);
  assert.match(result.limitations.join(' '), /换保/u);
  assert.match(result.limitations.join(' '), /理赔/u);
});

test('adds limitations for exact Chinese high-risk triggers', async () => {
  for (const trigger of ['解除合同', '撤单', '拒赔', '健康告知']) {
    const result = await createInsuranceExpertTool({ state: fixture(), analyze: async () => analysis() })({
      owner: { userId: 7 }, policyRef: 31, question: trigger,
    });
    assert.ok(result.limitations.length >= 2, trigger);
  }
});

test('Chinese ngram relevance selects hospitalization and rejects unsupported model prose', async () => {
  const rows = [
    { coverageType: '住院医疗保险金', scenario: '住院治疗', payout: '按约定比例报销', note: '' },
    { coverageType: '身故保险金', scenario: '身故', payout: '基本保险金额', note: '' },
  ];
  const ask = createInsuranceExpertTool({ state: fixture(), analyze: async () => analysis({
    answer: '模型说所有情况都能赔，包括身故。', analysis: { coverageTable: rows },
  }) });
  const result = await ask({ owner: { userId: 7 }, policyRef: 31, question: '住院能理赔吗' });
  assert.match(result.answer, /住院/u);
  assert.doesNotMatch(result.answer, /身故/u);

  const unsupported = await ask({ owner: { userId: 7 }, policyRef: 31, question: '牙科能理赔吗' });
  assert.match(unsupported.answer, /不足|核验/u);
  assert.doesNotMatch(unsupported.answer, /模型说/u);
});

test('narrow answer ignores model guarantee language and uses the grounded payout row', async () => {
  const result = await createInsuranceExpertTool({ state: fixture(), analyze: async () => analysis({
    answer: '住院一定能赔。',
    analysis: { coverageTable: [{ coverageType: '住院医疗保险金', scenario: '住院治疗', payout: '按约定比例报销', note: '以合同审核为准' }] },
  }) })({ owner: { userId: 7 }, policyRef: 31, question: '住院能理赔吗' });
  assert.doesNotMatch(result.answer, /一定能赔/u);
  assert.match(result.answer, /住院医疗保险金/u);
  assert.match(result.answer, /按约定比例报销/u);
});

test('broad answer ignores arbitrary model promises and summarizes grounded rows', async () => {
  const result = await createInsuranceExpertTool({ state: fixture(), analyze: async () => analysis({
    answer: '本产品保证所有情况都赔付。',
  }) })({ owner: { userId: 7 }, policyRef: 31, question: '保障什么？' });
  assert.doesNotMatch(result.answer, /保证所有情况|都赔付/u);
  assert.match(result.answer, /身故保险金/u);
  assert.match(result.answer, /基本保险金额/u);
});

test('broad English coverage question may return the supported summary', async () => {
  const result = await createInsuranceExpertTool({ state: fixture(), analyze: async () => analysis() })({
    owner: { userId: 7 }, policyRef: 31, question: 'What is covered?',
  });
  assert.match(result.answer, /身故保险金/u);
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

test('analyzer treats provider abort as terminal without model fallback or search continuation', async () => {
  const previous = {
    apiKey: process.env.DEEPSEEK_API_KEY,
    smartSearch: process.env.POLICY_ANALYSIS_SMART_SEARCH_ENABLED,
    model: process.env.DEEPSEEK_MODEL,
    fallback: process.env.DEEPSEEK_FALLBACK_MODEL,
  };
  process.env.DEEPSEEK_API_KEY = 'test-key';
  process.env.POLICY_ANALYSIS_SMART_SEARCH_ENABLED = 'true';
  process.env.DEEPSEEK_MODEL = 'first-model';
  process.env.DEEPSEEK_FALLBACK_MODEL = 'fallback-model';
  const controller = new AbortController();
  let providerCalls = 0;
  let searchCalls = 0;
  let observedSignal;
  const fetchImpl = async (url, options) => {
    if (!String(url).includes('/chat/completions')) { searchCalls += 1; throw new Error('search must not run'); }
    providerCalls += 1;
    observedSignal = options.signal;
    controller.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  try {
    await assert.rejects(analyzeInsurancePolicyResponsibilities({
      policy: { company: '可信保险', name: '安心保' },
      knowledgeRecords: fixture().knowledgeRecords,
      officialDomainProfiles: fixture().officialDomainProfiles,
      fetchImpl,
      signal: controller.signal,
    }), { code: 'POLICY_ANALYSIS_TIMEOUT' });
    assert.equal(observedSignal.aborted, true);
    assert.equal(providerCalls, 1);
    assert.equal(searchCalls, 0);
  } finally {
    for (const [key, value] of Object.entries({
      DEEPSEEK_API_KEY: previous.apiKey,
      POLICY_ANALYSIS_SMART_SEARCH_ENABLED: previous.smartSearch,
      DEEPSEEK_MODEL: previous.model,
      DEEPSEEK_FALLBACK_MODEL: previous.fallback,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('PDF extraction abort kills the child and rejects immediately', async () => {
  const events = [];
  const listeners = new Map();
  const child = {
    stdout: { on: () => {} },
    stdin: { end: () => {} },
    on: (name, listener) => { listeners.set(name, listener); },
    off: (name) => { listeners.delete(name); },
    kill: (signal) => { events.push(signal); return true; },
  };
  const controller = new AbortController();
  const pending = extractPdfTextWithPython(Buffer.from('pdf'), {
    signal: controller.signal,
    spawnImpl: () => child,
    killGraceMs: 5,
  });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(events[0], 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(events.includes('SIGKILL'));
  assert.equal(listeners.has('close'), false);
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
