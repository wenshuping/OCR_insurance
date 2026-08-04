import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildFamilyPolicyAnalysisInput,
  buildFamilyPolicyAnalysisMessages,
  buildLocalFamilyPolicyAnalysisReport,
  generateFamilyPolicyAnalysisReport,
  hasLocalFamilyPolicyAnalysisEvidence,
  resolveFamilyPolicyAnalysisReportFreshness,
} from '../server/family-policy-analysis-report.service.mjs';
import {
  buildExpertPlanningProfile,
  computeExpertInputVersion,
  groupExpertCoverageIndicators,
  parseFamilyPolicyAnalysisEnvelope,
} from '../server/family-policy-analysis-contract.service.mjs';
import {
  createFamilyReportRecord,
  updateFamilyReportRecordReport,
} from '../server/family-report-record.service.mjs';
import { createFamilyPolicyAnalysisOrchestrator } from '../server/family-policy-analysis-orchestrator.service.mjs';

function makeFamilyReport(policyId) {
  return {
    summary: { memberCount: 0, policyCount: 1 },
    policyInventory: { rows: [{ policyId, productName: '重疾险' }] },
    criticalIllness: { members: [] },
    accident: { members: [] },
    wealth: { memberReports: [] },
    radar: { members: [], hiddenMembers: [] },
    appendix: { policies: [{ policyId, productName: '重疾险', ocrText: '' }] },
  };
}

function makeFamilyMembers(notes = '负责家庭收入') {
  return [{
    id: 1,
    familyId: 10,
    name: '张先生',
    relationToCore: 'self',
    relationLabel: '本人',
    role: 'core',
    birthday: '1988-01-01',
    idNumberTail: '1234',
    notes,
    status: 'active',
  }];
}

function createOrchestratorHarness({ owner = { userId: 7 }, version = 'sha256:v1', report = null } = {}) {
  const record = { id: 20, familyId: 10, status: 'active', report: report ? { familyPolicyAnalysisReport: report } : {} };
  const calls = [];
  let currentVersion = version;
  let release = null;
  const orchestrator = createFamilyPolicyAnalysisOrchestrator({
    getReportRecord: () => record,
    buildInput: () => ({ expertInputVersion: currentVersion }),
    generateReport: async ({ input }) => {
      calls.push(input.expertInputVersion);
      if (release) await new Promise((resolve) => { release.resolve = resolve; });
      return {
        status: 'complete',
        content: `report:${input.expertInputVersion}:${calls.length}`,
        structuredResult: { version: input.expertInputVersion },
        expertInputVersion: input.expertInputVersion,
        model: 'test-model',
        generatedAt: `2026-07-15T00:00:0${calls.length}.000Z`,
      };
    },
    persistReport: async () => {},
  });
  return {
    calls,
    family: { id: 10 },
    owner,
    orchestrator,
    record,
    setVersion(next) { currentVersion = next; },
    block() { release = {}; return release; },
  };
}

test('family policy analysis orchestrator reuses a fresh matching report', async () => {
  const harness = createOrchestratorHarness({
    report: {
      status: 'complete', content: 'cached', expertInputVersion: 'sha256:v1', generatedAt: '2026-07-15T00:00:00.000Z',
    },
  });
  const result = await harness.orchestrator.ensureFresh({ family: harness.family, owner: harness.owner });
  assert.equal(result.content, 'cached');
  assert.equal(harness.calls.length, 0);
});

test('family policy analysis orchestrator reports stored pending and legacy reports accurately', () => {
  const pending = createOrchestratorHarness({
    report: { status: 'pending', content: '', expertInputVersion: 'sha256:v1' },
  });
  assert.equal(pending.orchestrator.getStatus({ family: pending.family, owner: pending.owner }).status, 'pending');

  const legacy = createOrchestratorHarness({ report: { status: 'complete', content: 'legacy' } });
  assert.equal(legacy.orchestrator.getStatus({ family: legacy.family, owner: legacy.owner }).status, 'stale');
});

test('family policy analysis orchestrator generates missing and stale reports', async () => {
  const missing = createOrchestratorHarness();
  assert.equal((await missing.orchestrator.ensureFresh({ family: missing.family, owner: missing.owner })).content, 'report:sha256:v1:1');
  assert.equal(missing.calls.length, 1);

  const stale = createOrchestratorHarness({
    report: { status: 'complete', content: 'old', expertInputVersion: 'sha256:old', generatedAt: '2026-07-14T00:00:00.000Z' },
  });
  assert.equal((await stale.orchestrator.ensureFresh({ family: stale.family, owner: stale.owner })).content, 'report:sha256:v1:1');
  assert.equal(stale.calls.length, 1);
});

test('family policy analysis orchestrator shares concurrent work and explicit refresh generation', async () => {
  const harness = createOrchestratorHarness({
    report: { status: 'complete', content: 'cached', expertInputVersion: 'sha256:v1', generatedAt: '2026-07-15T00:00:00.000Z' },
  });
  const gate = harness.block();
  const first = harness.orchestrator.ensureFresh({ family: harness.family, owner: harness.owner, explicitRefresh: true });
  const second = harness.orchestrator.ensureFresh({ family: harness.family, owner: harness.owner, explicitRefresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.calls.length, 1);
  gate.resolve();
  assert.strictEqual(await first, await second);
  assert.equal(harness.calls.length, 1);
});

test('family policy analysis orchestrator does not save failures or let an old version replace current', async () => {
  const record = { id: 20, familyId: 10, status: 'active', report: {} };
  let version = 'sha256:old';
  let releaseOld;
  const orchestrator = createFamilyPolicyAnalysisOrchestrator({
    getReportRecord: () => record,
    buildInput: () => ({ expertInputVersion: version }),
    generateReport: async ({ input }) => {
      if (input.expertInputVersion === 'sha256:old') await new Promise((resolve) => { releaseOld = resolve; });
      return { status: 'complete', content: input.expertInputVersion, structuredResult: {}, expertInputVersion: input.expertInputVersion };
    },
    persistReport: async () => {},
  });
  const oldWork = orchestrator.ensureFresh({ family: { id: 10 }, owner: { userId: 7 } });
  await new Promise((resolve) => setImmediate(resolve));
  version = 'sha256:new';
  const current = await orchestrator.ensureFresh({ family: { id: 10 }, owner: { userId: 7 } });
  releaseOld();
  await oldWork;
  assert.equal(current.content, 'sha256:new');
  assert.equal(record.report.familyPolicyAnalysisReport.content, 'sha256:new');

  const failedRecord = { id: 21, familyId: 11, status: 'active', report: {} };
  const failed = createFamilyPolicyAnalysisOrchestrator({
    getReportRecord: () => failedRecord,
    buildInput: () => ({ expertInputVersion: 'sha256:fail' }),
    generateReport: async () => { throw new Error('generation failed'); },
    persistReport: async () => {},
  });
  await assert.rejects(failed.ensureFresh({ family: { id: 11 }, owner: { userId: 7 } }), /generation failed/u);
  assert.equal(failedRecord.report.familyPolicyAnalysisReport, undefined);

  const rejectedRecord = { id: 22, familyId: 12, status: 'active', report: {} };
  const rejected = createFamilyPolicyAnalysisOrchestrator({
    getReportRecord: () => rejectedRecord,
    buildInput: () => ({ expertInputVersion: 'sha256:rejected' }),
    generateReport: async () => ({ status: 'failed', content: '', expertInputVersion: 'sha256:rejected' }),
    persistReport: async () => {},
  });
  await assert.rejects(rejected.ensureFresh({ family: { id: 12 }, owner: { userId: 7 } }), /GENERATION_FAILED/u);
  assert.equal(rejectedRecord.report.familyPolicyAnalysisReport, undefined);
});

test('family policy analysis orchestrator isolates in-flight work by owner', async () => {
  const records = new Map();
  let calls = 0;
  const orchestrator = createFamilyPolicyAnalysisOrchestrator({
    getReportRecord: (_family, owner) => {
      const key = owner.userId;
      if (!records.has(key)) records.set(key, { familyId: 10, status: 'active', report: {} });
      return records.get(key);
    },
    buildInput: (_family, owner) => ({ expertInputVersion: `sha256:${owner.userId}` }),
    generateReport: async ({ input }) => ({ status: 'complete', content: input.expertInputVersion, expertInputVersion: input.expertInputVersion, call: ++calls }),
    persistReport: async () => {},
  });
  const [left, right] = await Promise.all([
    orchestrator.ensureFresh({ family: { id: 10 }, owner: { userId: 7 } }),
    orchestrator.ensureFresh({ family: { id: 10 }, owner: { userId: 8 } }),
  ]);
  assert.equal(calls, 2);
  assert.notEqual(left.content, right.content);
});

test('family policy analysis orchestrator retries the latest version after input drifts during generation', async () => {
  const record = { familyId: 10, status: 'active', report: {} };
  let version = 'sha256:old';
  let releaseOld;
  const calls = [];
  const orchestrator = createFamilyPolicyAnalysisOrchestrator({
    getReportRecord: () => record,
    buildInput: () => ({ expertInputVersion: version }),
    generateReport: async ({ input }) => {
      calls.push(input.expertInputVersion);
      if (input.expertInputVersion === 'sha256:old') await new Promise((resolve) => { releaseOld = resolve; });
      return { status: 'complete', content: input.expertInputVersion, expertInputVersion: input.expertInputVersion };
    },
    persistReport: async () => {},
  });
  const resultPromise = orchestrator.ensureFresh({ family: { id: 10 }, owner: { userId: 7 } });
  await new Promise((resolve) => setImmediate(resolve));
  version = 'sha256:new';
  releaseOld();
  const result = await resultPromise;
  assert.deepEqual(calls, ['sha256:old', 'sha256:new']);
  assert.equal(result.content, 'sha256:new');
  assert.equal(record.report.familyPolicyAnalysisReport.content, 'sha256:new');
});

test('late failed persistence cannot roll back a newer successfully persisted report', async () => {
  const record = { familyId: 10, status: 'active', report: {} };
  let version = 'sha256:old';
  let rejectOldPersist;
  let persisted = null;
  const orchestrator = createFamilyPolicyAnalysisOrchestrator({
    getReportRecord: () => record,
    buildInput: () => ({ expertInputVersion: version }),
    generateReport: async ({ input }) => ({
      status: 'complete', content: input.expertInputVersion, expertInputVersion: input.expertInputVersion,
      generatedAt: input.expertInputVersion === 'sha256:old' ? '2026-07-15T00:00:01.000Z' : '2026-07-15T00:00:02.000Z',
    }),
    persistReport: async ({ record: current }) => {
      const content = current.report.familyPolicyAnalysisReport.content;
      if (content === 'sha256:old') await new Promise((_resolve, reject) => { rejectOldPersist = reject; });
      else persisted = structuredClone(current.report.familyPolicyAnalysisReport);
    },
  });
  const oldWork = orchestrator.ensureFresh({ family: { id: 10 }, owner: { userId: 7 } });
  while (!rejectOldPersist) await new Promise((resolve) => setImmediate(resolve));
  version = 'sha256:new';
  const latest = await orchestrator.ensureFresh({ family: { id: 10 }, owner: { userId: 7 } });
  rejectOldPersist(new Error('old persist failed'));
  await assert.rejects(oldWork, /old persist failed/u);
  assert.equal(latest.content, 'sha256:new');
  assert.equal(record.report.familyPolicyAnalysisReport.content, 'sha256:new');
  assert.equal(persisted.content, 'sha256:new');
});

test('family policy analysis orchestrator rejects A-B-A version oscillation without leaving pending work', async () => {
  const record = { familyId: 10, status: 'active', report: {} };
  let version = 'sha256:A';
  let calls = 0;
  const orchestrator = createFamilyPolicyAnalysisOrchestrator({
    getReportRecord: () => record,
    buildInput: () => ({ expertInputVersion: version }),
    generateReport: async ({ input }) => {
      calls += 1;
      version = input.expertInputVersion === 'sha256:A' ? 'sha256:B' : 'sha256:A';
      return { status: 'complete', content: input.expertInputVersion, expertInputVersion: input.expertInputVersion };
    },
    persistReport: async () => {},
  });
  const result = await Promise.race([
    orchestrator.ensureFresh({ family: { id: 10 }, owner: { userId: 7 } })
      .then(() => ({ status: 'resolved' }), (error) => ({ status: 'rejected', error })),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout' }), 100)),
  ]);
  assert.equal(result.status, 'rejected');
  assert.equal(result.error.code, 'FAMILY_POLICY_ANALYSIS_INPUT_CHANGED');
  assert.equal(calls, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(orchestrator.getStatus({ family: { id: 10 }, owner: { userId: 7 } }).status, 'pending');
});

function allocateSequence(start = 100) {
  let value = start;
  return () => {
    value += 1;
    return value;
  };
}

test('expert planning profile distinguishes unknown values from confirmed zero', () => {
  const profile = buildExpertPlanningProfile({ debt: 0, annualIncome: '' });

  assert.deepEqual(profile, {
    annualIncome: { status: 'unknown', value: null },
    annualExpense: { status: 'unknown', value: null },
    debt: { status: 'confirmed', value: 0 },
    educationGoal: { status: 'unknown', value: null },
    parentSupportGoal: { status: 'unknown', value: null },
    availableAssets: { status: 'unknown', value: null },
    premiumBudget: { status: 'unknown', value: null },
  });
});

test('expert coverage groups retain all missing item names without empty technical fields', () => {
  const groups = groupExpertCoverageIndicators([
    { memberRef: 'member_1', category: 'medical', itemName: '住院医疗', status: 'not_identified', sourceUrl: '' },
    { memberRef: 'member_1', category: 'medical', itemName: '外购药', status: 'not_identified', sourceUrl: '' },
    { memberRef: 'member_1', category: 'medical', itemName: '住院医疗', status: 'not_identified', sourceUrl: '' },
    { memberRef: 'member_1', category: 'medical', itemName: '一般医疗', status: 'confirmed', value: 2_000_000, unit: '元', sourceUrl: '' },
    { memberRef: 'member_1', category: 'medical', itemName: '一般医疗', status: 'confirmed', value: 2_000_000, unit: '元' },
    { memberRef: 'member_1', category: 'medical', itemName: '', status: 'confirmed', value: 50_000 },
    { memberRef: 'member_1', category: 'medical', itemName: '门诊', status: 'not_found_in_recorded_policies' },
    { memberRef: 'member_1', category: 'medical', itemName: '免赔额', status: 'conflicted' },
    { memberRef: 'member_1', category: 'medical', itemName: '特药', status: 'missing_source' },
    { memberRef: 'member_1', category: 'medical', itemName: '生育', status: 'not_applicable' },
  ]);

  assert.deepEqual(groups, [{
    memberRef: 'member_1',
    category: 'medical',
    confirmedItems: [{ itemName: '一般医疗', value: 2_000_000, unit: '元' }],
    notFoundInRecordedPoliciesItems: ['门诊'],
    notIdentifiedItems: ['住院医疗', '外购药'],
    conflictedItems: ['免赔额'],
    missingSourceItems: ['特药'],
    notApplicableItems: ['生育'],
  }]);
});

test('expert input version is stable and tracks only expert business facts', () => {
  const input = {
    family: { id: 10, familyName: '张先生家庭', notes: '有房贷', ownerUserId: 99, updatedAt: 'yesterday' },
    members: [{ id: 1, name: '张先生', birthday: '1988-01-01', notes: '经济支柱', idNumber: 'secret', uiExpanded: true }],
    planningProfile: buildExpertPlanningProfile({ debt: 1_000_000 }),
    policies: [{
      id: 11,
      productName: '重疾险',
      applicant: '张先生',
      insured: '张先生',
      coverageAmount: 300_000,
      updatedAt: 'today',
      editing: false,
      responsibilities: [{ name: '重大疾病保险金', amount: 300_000, verifiedAt: 'today', idNumberMasked: '****1234' }],
      evidence: { knowledgeEvidence: [{ title: '保险条款', verificationStatus: 'verified', fetchedAt: 'today', activeTab: 'terms' }] },
    }],
    groupedCoverageIndicators: [{ memberRef: 'member_1', category: 'critical', confirmedItems: [], notIdentifiedItems: ['轻症'], activeTab: 'gap' }],
    evidenceReferences: [{ policyRef: 'policy_1', verificationStatus: 'verified', sourceKind: 'customer_policy_terms', fetchedAt: 'today', editing: false }],
    report: {
      summary: { memberCount: 1, policyCount: 1, annualPremium: 20_000, totalCoverage: 300_000, cashValueTotal: 10_000, futurePayoutTotal: 100_000, refreshedAt: 'today' },
      radar: { family: { scores: [{ key: 'critical', score: 60, effectiveAmount: 300_000, effectiveAmountText: '30万元', adequacyRate: 0.6, adequacyText: '偏低', gapText: '缺口20万元', targetSource: 'system_estimate', activeTab: 'detail' }] } },
      inventoryRows: [{ member: '张先生', productName: '重疾险', coverageText: '30万元', editing: false }],
      criticalIllness: { members: [{ member: '张先生', gap: 500_000, rows: [{ key: 'critical', countText: '1次', formulaText: '基本保额×1', liabilities: ['重大疾病保险金'] }] }] },
      accident: { members: [{ member: '张先生', gap: 1_000_000 }] },
      wealth: {
        memberReports: [{ member: '张先生', conclusion: '待完善', policies: [{ cashValueRows: [{ policyYear: 1, cashValue: 10_000 }], uncertaintyItems: [{ key: 'dividend', label: '分红不确定' }], uncertaintyNote: '分红不确定', hasUncertainWealthFactors: true }] }],
        excludedPolicies: [{ policyId: 11, productName: '重疾险', reasons: ['分红不确定'], note: '不纳入统计' }],
        statisticsScopeNote: '仅统计确定现金流',
        aggregateRows: [{ year: 2030, premiumOutflow: 20_000, netCashflow: -10_000, cumulativeNetCashflow: -30_000, details: [{ type: 'cashValue', increase: 10_000 }] }],
        keyPoints: ['2030年现金流为负'],
      },
    },
    salesMemory: { objection: '贵' },
    salesChat: [{ content: '换个说法' }],
  };
  const first = computeExpertInputVersion(input);

  assert.match(first, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(computeExpertInputVersion({ ...input, salesMemory: { objection: '不急' }, salesChat: [] }), first);
  assert.equal(computeExpertInputVersion({ ...input, family: { ...input.family, updatedAt: 'tomorrow' } }), first);
  assert.equal(computeExpertInputVersion({
    ...input,
    policies: [{
      ...input.policies[0],
      editing: true,
      responsibilities: [{ ...input.policies[0].responsibilities[0], verifiedAt: 'tomorrow', idNumberMasked: '****9999' }],
      evidence: { knowledgeEvidence: [{ ...input.policies[0].evidence.knowledgeEvidence[0], fetchedAt: 'tomorrow', activeTab: 'summary' }] },
    }],
    groupedCoverageIndicators: [{ ...input.groupedCoverageIndicators[0], activeTab: 'coverage' }],
    evidenceReferences: [{ ...input.evidenceReferences[0], fetchedAt: 'tomorrow', editing: true }],
    report: {
      ...input.report,
      summary: { ...input.report.summary, refreshedAt: 'tomorrow' },
      radar: { family: { scores: [{ ...input.report.radar.family.scores[0], activeTab: 'overview' }] } },
      inventoryRows: [{ ...input.report.inventoryRows[0], editing: true }],
    },
  }), first);
  assert.notEqual(computeExpertInputVersion({ ...input, family: { ...input.family, notes: '新增房贷' } }), first);
  assert.notEqual(computeExpertInputVersion({ ...input, members: [{ ...input.members[0], notes: '准备退休' }] }), first);
  assert.notEqual(computeExpertInputVersion({ ...input, members: [{ ...input.members[0], name: '李先生' }] }), first);
  assert.notEqual(computeExpertInputVersion({ ...input, members: [{ ...input.members[0], birthday: '1989-01-01' }] }), first);
  assert.notEqual(computeExpertInputVersion({ ...input, planningProfile: buildExpertPlanningProfile({ debt: 900_000 }) }), first);
  assert.notEqual(computeExpertInputVersion({ ...input, policies: [{ ...input.policies[0], coverageAmount: 500_000 }] }), first);
  assert.notEqual(computeExpertInputVersion({ ...input, policies: [{ ...input.policies[0], applicant: '李先生' }] }), first);
  assert.notEqual(computeExpertInputVersion({ ...input, policies: [{ ...input.policies[0], insured: '李先生' }] }), first);
  assert.notEqual(computeExpertInputVersion({ ...input, groupedCoverageIndicators: [{ ...input.groupedCoverageIndicators[0], notIdentifiedItems: ['轻症', '中症'] }] }), first);
  assert.notEqual(computeExpertInputVersion({ ...input, evidenceReferences: [{ ...input.evidenceReferences[0], verificationStatus: 'pending_review' }] }), first);
  for (const [section, changed] of [
    ['summary', { ...input.report.summary, futurePayoutTotal: 120_000 }],
    ['radar', { family: { scores: [{ key: 'critical', score: 80 }] } }],
    ['inventoryRows', [{ ...input.report.inventoryRows[0], coverageText: '50万元' }]],
    ['criticalIllness', { members: [{ member: '张先生', gap: 300_000 }] }],
    ['accident', { members: [{ member: '张先生', gap: 800_000 }] }],
    ['wealth', { memberReports: [{ member: '张先生', conclusion: '充足' }] }],
  ]) {
    assert.notEqual(computeExpertInputVersion({ ...input, report: { ...input.report, [section]: changed } }), first, section);
  }
  assert.notEqual(computeExpertInputVersion({ ...input, report: { ...input.report, summary: { ...input.report.summary, annualPremium: 30_000 } } }), first);
  assert.notEqual(computeExpertInputVersion({ ...input, report: { ...input.report, summary: { ...input.report.summary, totalCoverage: 500_000 } } }), first);
  for (const [label, report] of [
    ['countText', { ...input.report, criticalIllness: { members: [{ ...input.report.criticalIllness.members[0], rows: [{ key: 'critical', countText: '2次' }] }] } }],
    ['radar amounts', { ...input.report, radar: { family: { scores: [{ ...input.report.radar.family.scores[0], effectiveAmount: 500_000 }] } } }],
    ['radar text', { ...input.report, radar: { family: { scores: [{ ...input.report.radar.family.scores[0], effectiveAmountText: '50万元' }] } } }],
    ['radar adequacy rate', { ...input.report, radar: { family: { scores: [{ ...input.report.radar.family.scores[0], adequacyRate: 0.8 }] } } }],
    ['radar adequacy text', { ...input.report, radar: { family: { scores: [{ ...input.report.radar.family.scores[0], adequacyText: '一般' }] } } }],
    ['radar target source', { ...input.report, radar: { family: { scores: [{ ...input.report.radar.family.scores[0], targetSource: 'customer_input' }] } } }],
    ['radar gap text', { ...input.report, radar: { family: { scores: [{ ...input.report.radar.family.scores[0], gapText: '缺口10万元' }] } } }],
    ['wealth cash values', { ...input.report, wealth: { ...input.report.wealth, memberReports: [{ ...input.report.wealth.memberReports[0], policies: [{ ...input.report.wealth.memberReports[0].policies[0], cashValueRows: [{ policyYear: 1, cashValue: 20_000 }] }] }] } }],
    ['wealth aggregate', { ...input.report, wealth: { ...input.report.wealth, aggregateRows: [{ ...input.report.wealth.aggregateRows[0], premiumOutflow: 30_000 }] } }],
    ['wealth net cashflow', { ...input.report, wealth: { ...input.report.wealth, aggregateRows: [{ ...input.report.wealth.aggregateRows[0], netCashflow: -20_000 }] } }],
    ['wealth cumulative cashflow', { ...input.report, wealth: { ...input.report.wealth, aggregateRows: [{ ...input.report.wealth.aggregateRows[0], cumulativeNetCashflow: -40_000 }] } }],
    ['wealth detail increase', { ...input.report, wealth: { ...input.report.wealth, aggregateRows: [{ ...input.report.wealth.aggregateRows[0], details: [{ type: 'cashValue', increase: 20_000 }] }] } }],
    ['wealth key points', { ...input.report, wealth: { ...input.report.wealth, keyPoints: ['2031年现金流转正'] } }],
    ['wealth uncertainty', { ...input.report, wealth: { ...input.report.wealth, memberReports: [{ ...input.report.wealth.memberReports[0], policies: [{ ...input.report.wealth.memberReports[0].policies[0], uncertaintyItems: [{ key: 'universal_account', label: '万能账户不确定' }] }] }] } }],
    ['wealth uncertainty note', { ...input.report, wealth: { ...input.report.wealth, memberReports: [{ ...input.report.wealth.memberReports[0], policies: [{ ...input.report.wealth.memberReports[0].policies[0], uncertaintyNote: '万能账户不确定' }] }] } }],
    ['wealth uncertainty flag', { ...input.report, wealth: { ...input.report.wealth, memberReports: [{ ...input.report.wealth.memberReports[0], policies: [{ ...input.report.wealth.memberReports[0].policies[0], hasUncertainWealthFactors: false }] }] } }],
    ['wealth exclusions', { ...input.report, wealth: { ...input.report.wealth, excludedPolicies: [{ ...input.report.wealth.excludedPolicies[0], reasons: ['万能账户不确定'] }] } }],
    ['wealth scope', { ...input.report, wealth: { ...input.report.wealth, statisticsScopeNote: '包含全部现金流' } }],
    ['responsibility formula', { ...input.report, criticalIllness: { members: [{ ...input.report.criticalIllness.members[0], rows: [{ ...input.report.criticalIllness.members[0].rows[0], formulaText: '基本保额×2' }] }] } }],
    ['responsibility liabilities', { ...input.report, criticalIllness: { members: [{ ...input.report.criticalIllness.members[0], rows: [{ ...input.report.criticalIllness.members[0].rows[0], liabilities: ['重大疾病保险金', '额外给付'] }] }] } }],
  ]) assert.notEqual(computeExpertInputVersion({ ...input, report }), first, label);
});

test('expert input version is stable when business collections are reordered', () => {
  const input = {
    members: [{ id: 2, name: '乙' }, { id: 1, name: '甲' }],
    policies: [{ id: 2, productName: '乙险' }, { id: 1, productName: '甲险' }],
    groupedCoverageIndicators: [{ memberRef: 'm2', category: 'medical' }, { memberRef: 'm1', category: 'critical' }],
    evidenceReferences: [{ policyRef: 'p2', title: '乙' }, { policyRef: 'p1', title: '甲' }],
    report: { radar: { family: { scores: [{ key: 'medical', score: 2 }, { key: 'critical', score: 1 }] } }, inventoryRows: [{ policyId: 2 }, { policyId: 1 }] },
  };
  const reordered = { ...input, members: [...input.members].reverse(), policies: [...input.policies].reverse(), groupedCoverageIndicators: [...input.groupedCoverageIndicators].reverse(), evidenceReferences: [...input.evidenceReferences].reverse(), report: { ...input.report, radar: { family: { scores: [...input.report.radar.family.scores].reverse() } }, inventoryRows: [...input.report.inventoryRows].reverse() } };
  assert.equal(computeExpertInputVersion(reordered), computeExpertInputVersion(input));
  assert.notEqual(computeExpertInputVersion({ ...reordered, members: [{ id: 2, name: '丙' }, input.members[1]] }), computeExpertInputVersion(input));
});

test('expert input preserves unknown numeric values and confirms explicit zero', () => {
  const input = buildFamilyPolicyAnalysisInput({ family: { id: 1 }, policies: [{ id: 1, premium: null, amount: 0, responsibilities: [{ name: '责任', amount: null }] }], familyReport: { radar: { family: { scores: [{ key: 'critical', score: null, target: 0, gap: undefined }] } } } });
  assert.deepEqual([input.policies[0].annualPremium, input.policies[0].annualPremiumStatus], [null, 'unknown']);
  assert.deepEqual([input.policies[0].coverageAmount, input.policies[0].coverageAmountStatus], [0, 'confirmed']);
  assert.deepEqual([input.policies[0].responsibilities[0].amount, input.policies[0].responsibilities[0].amountStatus], [null, 'unknown']);
  const score = input.report.radar.family.scores[0];
  assert.deepEqual([score.score, score.scoreStatus], [null, 'unknown']);
  assert.deepEqual([score.target, score.targetStatus], [0, 'confirmed']);
});

test('policy analysis freshness follows nested report status and current source timestamp', () => {
  const record = {
    status: 'active',
    report: { familyPolicyAnalysisReport: { status: 'complete', generatedAt: '2026-07-11T00:00:00.000Z' } },
  };

  assert.equal(resolveFamilyPolicyAnalysisReportFreshness(record, { sourceUpdatedAt: '2026-07-10T00:00:00.000Z' }).status, 'fresh');
  assert.equal(resolveFamilyPolicyAnalysisReportFreshness(record, { sourceUpdatedAt: '2026-07-12T00:00:00.000Z' }).status, 'stale');
  assert.equal(resolveFamilyPolicyAnalysisReportFreshness(record, { sourceUpdatedAt: '2026-07-11T09:00:00+08:00' }).status, 'stale');
  assert.equal(resolveFamilyPolicyAnalysisReportFreshness({ status: 'active', report: {} }).status, 'missing');
  assert.equal(resolveFamilyPolicyAnalysisReportFreshness({
    status: 'active',
    report: { familyPolicyAnalysisReport: { status: 'pending' } },
  }).status, 'pending');
});

test('family policy analysis prompt asks for qualitative customer and structured expert conclusions', () => {
  const input = buildFamilyPolicyAnalysisInput({
    family: { id: 1, familyName: '张先生家庭' },
    planningProfile: {
      annualIncome: 300000,
      annualExpense: 180000,
      debt: 1200000,
      educationGoal: 500000,
      parentSupportGoal: 300000,
      availableAssets: 100000,
      premiumBudget: 30000,
    },
    members: [{ id: 1, name: '张先生', relationLabel: '本人', role: 'core' }],
    policies: [{ id: 11, company: '示例人寿', name: '重疾险', insured: '张先生', amount: 300000 }],
    knowledgeRecords: [{
      company: '示例人寿',
      productName: '重疾险',
      title: '重疾险官方条款',
      sourceKind: 'insurer_official',
      evidenceLevel: 'insurer_official',
      sourceExcerpt: '等待期后确诊重大疾病，按基本保险金额给付。',
    }, {
      company: '示例人寿',
      productName: '重疾险',
      title: '第三方网页线索',
      sourceKind: 'open_web_reference',
      evidenceLevel: 'external_legacy_reference',
      sourceExcerpt: '第三方网页提到额外责任，待核实。',
    }],
    indicatorRecords: [{
      company: '示例人寿',
      productName: '重疾险',
      coverageType: '重大疾病',
      liability: '重大疾病保险金',
      formulaText: '给付基本保险金额',
    }],
    familyReport: {
      summary: { memberCount: 1, policyCount: 1 },
      radar: {
        family: {
          scores: [{
            key: 'criticalIllness', label: '重疾', amount: 300000, effectiveAmount: 280000,
            effectiveAmountText: '28万元', adequacyRate: 0.35, adequacyText: '不足',
            target: 800000, targetSource: 'customer_input', gap: 500000,
          }],
        },
        members: [],
      },
      policyInventory: { rows: [] },
      criticalIllness: {},
      accident: {},
      wealth: {},
    },
  });

  assert.equal(input.family.familyName, '张先生家庭');
  assert.match(input.expertInputVersion, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(input.groupedCoverageIndicators, []);
  assert.deepEqual(input.planningProfile.annualIncome, { status: 'confirmed', value: 300000 });
  assert.deepEqual(input.planningProfile.parentSupportGoal, { status: 'confirmed', value: 300000 });
  assert.equal(input.policies[0].productName, '重疾险');
  assert.equal(input.policies[0].evidence.knowledgeEvidence.length, 2);
  assert.equal(input.policies[0].evidence.knowledgeEvidence[0].verificationStatus, 'verified');
  assert.equal(input.policies[0].evidence.knowledgeEvidence[1].referenceOnly, true);
  assert.equal(input.policies[0].evidence.knowledgeEvidence[1].verificationLabel, '非官方资料，待保险公司确认');
  assert.equal(input.policies[0].evidence.indicatorEvidence.length, 1);
  assert.equal(input.report.radar.family.scores[0].effectiveAmount, 280000);
  assert.equal(input.report.radar.family.scores[0].adequacyRate, 0.35);
  assert.equal(input.report.radar.family.scores[0].targetSource, 'customer_input');

  const messages = buildFamilyPolicyAnalysisMessages(input);
  const prompt = messages.map((message) => message.content).join('\n');
  assert.match(prompt, /家庭保单分析报告/u);
  assert.match(prompt, /保险分析师/u);
  assert.match(prompt, /保障规划师/u);
  assert.match(prompt, /逐张保单分析/u);
  assert.match(prompt, /planningProfile/u);
  assert.match(prompt, /家庭年收入/u);
  assert.match(prompt, /父母赡养责任/u);
  assert.match(prompt, /整个家庭保单结构/u);
  assert.match(prompt, /重点保障缺口分析/u);
  assert.match(prompt, /confirmed_gap/u);
  assert.match(prompt, /likely_insufficient/u);
  assert.match(prompt, /needs_verification/u);
  assert.match(prompt, /currently_reasonable/u);
  assert.match(prompt, /当前已录入保单中未发现/u);
  assert.match(prompt, /暂按未配置关注，需核对合同/u);
  assert.doesNotMatch(prompt, /缺口分析篇幅不少于全文 40%/u);
  assert.doesNotMatch(prompt, /年收入5-10倍/u);
  assert.doesNotMatch(prompt, /基础版、标准版、完善版/u);
  assert.match(prompt, /不能出现“AI”/u);
  assert.match(prompt, /referenceOnly=true/u);
  assert.match(prompt, /待核实参考/u);
});

test('local family policy analysis uses database evidence without model generation', () => {
  const input = buildFamilyPolicyAnalysisInput({
    family: { id: 1, familyName: '测试家庭' },
    members: [{ id: 1, name: '张先生', relationLabel: '本人', role: 'core' }],
    policies: [{
      id: 11,
      company: '新华保险',
      name: '成长阳光少儿两全保险(A款)（分红型）',
      insured: '张小明',
      responsibilities: [{ name: '大学教育金', amount: 10000 }],
    }],
    knowledgeRecords: [{
      company: '新华保险',
      productName: '成长阳光少儿两全保险(A款)（分红型）',
      sourceKind: 'insurer_official',
      evidenceLevel: 'insurer_official',
      sourceExcerpt: '官方保险责任摘要',
    }],
    familyReport: { radar: { family: { scores: [] } } },
  });

  assert.equal(hasLocalFamilyPolicyAnalysisEvidence(input), true);
  const report = buildLocalFamilyPolicyAnalysisReport(input, { generatedAt: '2026-07-27T00:00:00.000Z' });
  assert.equal(report.source, 'database');
  assert.equal(report.model, '');
  assert.match(report.content, /成长阳光少儿两全保险/u);
  assert.match(report.content, /本地库已命中/u);
});

test('local family policy analysis falls back when a policy has no local evidence', () => {
  const input = buildFamilyPolicyAnalysisInput({
    family: { id: 1 },
    policies: [{ id: 11, company: '未知公司', name: '未知产品' }],
    familyReport: { radar: { family: { scores: [] } } },
  });
  assert.equal(hasLocalFamilyPolicyAnalysisEvidence(input), false);
});

test('family policy analysis envelope validates version, assessments, and evidence references', () => {
  const expertInputVersion = 'sha256:expected';
  const envelope = {
    markdownContent: [
      '## 一、报告结论摘要', '结论', '## 二、家庭成员与保单全景', '全景',
      '## 三、现有保障结构评价', '评价', '## 四、重点保障缺口分析', '缺口',
      '## 五、风险场景影响', '影响', '## 六、配置优先级与预算建议', '建议',
      '## 七、需要补充核实的信息', '核实', '## 八、动态复盘建议', '复盘',
    ].join('\n'),
    expertInputVersion,
    structuredResult: {
      summary: '经济支柱保障需优先复核',
      priorityFindings: [{
        memberRef: 'member_1', category: 'critical', finding: '重疾保额偏低',
        assessment: 'likely_insufficient', confidence: 'high',
        confirmedFactRefs: ['fact_1'], indicatorRefs: [], policyRefs: ['policy_1'],
        missingInformation: ['家庭责任目标'], nextVerification: '核对附加责任',
      }],
      confirmedFacts: [{ id: 'fact_1', statement: '已录入30万元重疾保额' }],
      verificationItems: [], memberFindings: [],
      evidenceRefs: { facts: ['fact_1'], indicators: [], policies: ['policy_1'] },
      dataQualityWarnings: [],
    },
  };

  const allowedEvidenceRefs = { policies: ['policy_1'], indicators: [] };
  assert.deepEqual(parseFamilyPolicyAnalysisEnvelope(JSON.stringify(envelope), expertInputVersion, allowedEvidenceRefs), envelope);
  for (const invalid of [
    { ...envelope, expertInputVersion: 'sha256:stale' },
    { ...envelope, structuredResult: { ...envelope.structuredResult, summary: null } },
    { ...envelope, structuredResult: { ...envelope.structuredResult, summary: '  ' } },
    { ...envelope, structuredResult: { ...envelope.structuredResult, evidenceRefs: {} } },
    { ...envelope, structuredResult: { ...envelope.structuredResult, evidenceRefs: { facts: {}, indicators: [], policies: [] } } },
    { ...envelope, structuredResult: { ...envelope.structuredResult, priorityFindings: [{ ...envelope.structuredResult.priorityFindings[0], assessment: 'unknown' }] } },
    { ...envelope, structuredResult: { ...envelope.structuredResult, priorityFindings: [{ ...envelope.structuredResult.priorityFindings[0], confirmedFactRefs: ['missing'], policyRefs: [] }] } },
    { ...envelope, structuredResult: { ...envelope.structuredResult, memberFindings: [null] } },
    { ...envelope, structuredResult: { ...envelope.structuredResult, memberFindings: [{ memberRef: 'member_1', assessment: 'unknown' }] } },
    { ...envelope, structuredResult: { ...envelope.structuredResult, memberFindings: [{ ...envelope.structuredResult.priorityFindings[0], confirmedFactRefs: ['missing'], policyRefs: [] }] } },
    { ...envelope, structuredResult: { ...envelope.structuredResult, confirmedFacts: [null] } },
    { ...envelope, structuredResult: { ...envelope.structuredResult, verificationItems: [null] } },
    { ...envelope, structuredResult: { ...envelope.structuredResult, dataQualityWarnings: [null] } },
    { ...envelope, structuredResult: { ...envelope.structuredResult, confirmedFacts: [{ id: 'fact_1' }, { id: 'fact_1' }] } },
    { ...envelope, structuredResult: { ...envelope.structuredResult, evidenceRefs: { ...envelope.structuredResult.evidenceRefs, policies: ['ghost'] }, priorityFindings: [{ ...envelope.structuredResult.priorityFindings[0], policyRefs: ['ghost'] }] } },
  ]) {
    assert.throws(
      () => parseFamilyPolicyAnalysisEnvelope(JSON.stringify(invalid), expertInputVersion, allowedEvidenceRefs),
      (error) => error.code === 'FAMILY_POLICY_ANALYSIS_INVALID_RESULT',
    );
  }
});

test('expert semantic gate normalizes unsafe certainty and rejects unsupported likely insufficiency', () => {
  const version = 'sha256:semantic';
  const base = {
    markdownContent: '客户确认没有负债。客户确认没有医疗保障。', expertInputVersion: version,
    structuredResult: {
      summary: '客户确认没有吸烟史',
      priorityFindings: [{ memberRef: 'm1', category: 'medical', finding: '客户确认没有医疗保障', assessment: 'needs_verification', confidence: 'medium', confirmedFactRefs: [], indicatorRefs: [], policyRefs: [], missingInformation: ['医疗合同'], nextVerification: '核对合同' }],
      confirmedFacts: [{ id: 'health', statement: '客户确认没有既往症' }], verificationItems: [{ item: '客户确认没有负债' }], memberFindings: [], evidenceRefs: { facts: [], indicators: [], policies: [] }, dataQualityWarnings: [],
    },
  };
  const normalized = parseFamilyPolicyAnalysisEnvelope(JSON.stringify(base), version, { policies: [], indicators: [] });
  assert.match(normalized.markdownContent, /客户确认没有负债/u);
  assert.match(normalized.structuredResult.summary, /客户确认没有吸烟史/u);
  assert.match(normalized.structuredResult.confirmedFacts[0].statement, /客户确认没有既往症/u);
  assert.match(normalized.structuredResult.verificationItems[0].item, /客户确认没有负债/u);
  assert.match(normalized.structuredResult.priorityFindings[0].finding, /暂按未配置关注，需核对合同/u);
  assert.match(normalized.markdownContent, /暂按未配置关注，需核对合同/u);

  for (const summary of ['客户确认没有负债', '客户确认没有吸烟史', '客户确认没有既往症']) {
    const legal = structuredClone(base);
    legal.structuredResult.summary = summary;
    assert.equal(parseFamilyPolicyAnalysisEnvelope(JSON.stringify(legal), version, { policies: [], indicators: [] }).structuredResult.summary, summary);
  }
  const invalidSummary = structuredClone(base);
  invalidSummary.structuredResult.summary = '客户确认没有医疗保障';
  assert.throws(() => parseFamilyPolicyAnalysisEnvelope(JSON.stringify(invalidSummary), version, { policies: [], indicators: [] }), (error) => error.code === 'FAMILY_POLICY_ANALYSIS_INVALID_RESULT');
  const allowedSummary = parseFamilyPolicyAnalysisEnvelope(JSON.stringify(invalidSummary), version, { policies: [], indicators: [] }, {
    groupedCoverageIndicators: [{ category: 'medical', notFoundInRecordedPoliciesItems: ['住院医疗'] }],
  });
  assert.equal(allowedSummary.structuredResult.summary, '客户确认没有医疗保障');

  const mixedSummary = structuredClone(base);
  mixedSummary.structuredResult.summary = '客户确认没有医疗保障和意外保障';
  assert.throws(() => parseFamilyPolicyAnalysisEnvelope(JSON.stringify(mixedSummary), version, { policies: [], indicators: [] }, {
    groupedCoverageIndicators: [
      { category: 'medical', notFoundInRecordedPoliciesItems: ['住院医疗'] },
      { category: 'accident', notIdentifiedItems: ['意外身故'] },
    ],
  }), (error) => error.code === 'FAMILY_POLICY_ANALYSIS_INVALID_RESULT');

  const unrelatedSummary = structuredClone(base);
  unrelatedSummary.structuredResult.summary = '客户确认没有负债，医疗保障需核实';
  assert.equal(parseFamilyPolicyAnalysisEnvelope(JSON.stringify(unrelatedSummary), version, { policies: [], indicators: [] }).structuredResult.summary, unrelatedSummary.structuredResult.summary);

  const confirmedMulti = parseFamilyPolicyAnalysisEnvelope(JSON.stringify(mixedSummary), version, { policies: [], indicators: [] }, {
    groupedCoverageIndicators: [
      { category: 'medical', notFoundInRecordedPoliciesItems: ['住院医疗'] },
      { category: 'accident', notFoundInRecordedPoliciesItems: ['意外身故'] },
    ],
  });
  assert.equal(confirmedMulti.structuredResult.summary, mixedSummary.structuredResult.summary);

  const unsupported = structuredClone(base);
  unsupported.structuredResult.priorityFindings[0] = { ...unsupported.structuredResult.priorityFindings[0], assessment: 'likely_insufficient', missingInformation: [], confirmedFactRefs: [], policyRefs: [] };
  assert.throws(() => parseFamilyPolicyAnalysisEnvelope(JSON.stringify(unsupported), version, { policies: [], indicators: [] }), (error) => error.code === 'FAMILY_POLICY_ANALYSIS_INVALID_RESULT');
});

test('policy validity aliases are projected and each changes expert input version', () => {
  const aliases = ['status', 'policyStatus', 'policyState', 'contractStatus', 'validityStatus'];
  const basePolicy = { id: 1, status: 'active', policyStatus: 'issued', policyState: 'in_force', contractStatus: 'effective', validityStatus: 'valid' };
  const build = (policy) => buildFamilyPolicyAnalysisInput({ family: { id: 1 }, policies: [policy] });
  const base = build(basePolicy);
  assert.equal(base.policies[0].statusText, 'active | issued | in_force | effective | valid');
  assert.equal(base.policies[0].validityStatus, 'valid');
  for (const alias of aliases) {
    assert.notEqual(build({ ...basePolicy, [alias]: `${basePolicy[alias]}-changed` }).expertInputVersion, base.expertInputVersion, alias);
  }
});

test('expert semantic gate injects a confirmed planning gap into markdown and structured conclusions', () => {
  const version = 'sha256:gap';
  const envelope = {
    markdownContent: '## 四、重点保障缺口分析\n需要完善重疾保障', expertInputVersion: version,
    structuredResult: { summary: '需要完善', priorityFindings: [{ memberRef: 'm1', category: 'critical', finding: '需要完善', assessment: 'confirmed_gap', confidence: 'high', confirmedFactRefs: ['f1'], indicatorRefs: [], policyRefs: [], missingInformation: [], nextVerification: '' }], confirmedFacts: [{ id: 'f1', statement: '现有30万元' }], verificationItems: [], memberFindings: [], evidenceRefs: { facts: ['f1'], indicators: [], policies: [] }, dataQualityWarnings: [] },
  };
  const planningProfile = Object.fromEntries(['annualIncome', 'annualExpense', 'debt', 'educationGoal', 'parentSupportGoal', 'availableAssets', 'premiumBudget'].map((key) => [key, { status: 'confirmed', value: 1 }]));
  const result = parseFamilyPolicyAnalysisEnvelope(JSON.stringify(envelope), version, { policies: [], indicators: [] }, { planningProfile, report: { radar: { family: { scores: [{ key: 'critical', gap: 200000, gapStatus: 'confirmed' }] } } } });
  assert.match(result.markdownContent, /缺口20万元/u);
  assert.match(result.structuredResult.summary, /缺口20万元/u);
  assert.match(result.structuredResult.priorityFindings[0].finding, /缺口20万元/u);

  const unsafe = structuredClone(envelope);
  unsafe.markdownContent += '\n需增加20万元';
  assert.throws(() => parseFamilyPolicyAnalysisEnvelope(JSON.stringify(unsafe), version, { policies: [], indicators: [] }, { planningProfile: { annualIncome: { status: 'unknown', value: null } } }), (error) => error.code === 'FAMILY_POLICY_ANALYSIS_INVALID_RESULT');
});

test('family report refresh preserves only matching-version policy analysis report', () => {
  const record = {
    summary: { issueCount: 0 },
    report: {
      familyPolicyAnalysisReport: {
        status: 'complete',
        content: '已生成的家庭保单分析报告正文',
        model: 'deepseek-v4-pro',
        expertInputVersion: 'sha256:current',
        generatedAt: '2026-07-03T00:00:00.000Z',
      },
    },
  };

  updateFamilyReportRecordReport({
    record,
    report: {
      summary: { memberCount: 1, policyCount: 1 },
      criticalIllness: { members: [] },
      accident: { members: [] },
      wealth: { memberReports: [] },
      radar: { members: [], hiddenMembers: [] },
    },
    expertInputVersion: 'sha256:current',
  });

  assert.equal(record.report.familyPolicyAnalysisReport.content, '已生成的家庭保单分析报告正文');
  assert.equal(record.report.familyPolicyAnalysisReport.model, 'deepseek-v4-pro');
});

test('family report refresh drops legacy policy analysis report without an input version', () => {
  const record = { summary: {}, report: { familyPolicyAnalysisReport: { status: 'complete', content: 'legacy' } } };
  updateFamilyReportRecordReport({ record, report: makeFamilyReport(11) });
  assert.equal(record.report.familyPolicyAnalysisReport, undefined);
});

test('family report regeneration reuses policy analysis report when policy set is unchanged', () => {
  const state = {
    familyReports: [],
    familyReportIssues: [],
    familyReportCorrections: [],
  };
  const allocateId = allocateSequence();
  const family = { id: 10, familyName: '张先生家庭', coreMemberId: 1 };
  const members = makeFamilyMembers();
  const first = createFamilyReportRecord({
    state,
    family,
    owner: { userId: 7 },
    members,
    policies: [{ id: 11, name: '重疾险' }],
    report: makeFamilyReport(11),
    allocateId,
  }).record;
  first.report.familyPolicyAnalysisReport = {
    status: 'complete',
    content: '已生成的家庭保单分析报告正文',
    model: 'deepseek-v4-pro',
    expertInputVersion: 'sha256:current',
    generatedAt: '2026-07-03T00:00:00.000Z',
  };

  const { record } = createFamilyReportRecord({
    state,
    family,
    owner: { userId: 7 },
    members,
    policies: [{ id: 11, name: '重疾险' }],
    report: makeFamilyReport(11),
    expertInputVersion: 'sha256:current',
    allocateId,
  });

  assert.equal(state.familyReports[0].status, 'archived');
  assert.equal(record.report.familyPolicyAnalysisReport.content, '已生成的家庭保单分析报告正文');
  assert.equal(record.report.familyPolicyAnalysisReport.model, 'deepseek-v4-pro');
});

test('family report regeneration does not reuse policy analysis report when policy set changes', () => {
  const state = {
    familyReports: [],
    familyReportIssues: [],
    familyReportCorrections: [],
  };
  const allocateId = allocateSequence();
  const family = { id: 10, familyName: '张先生家庭', coreMemberId: 1 };
  const members = makeFamilyMembers();
  const first = createFamilyReportRecord({
    state,
    family,
    owner: { userId: 7 },
    members,
    policies: [{ id: 11, name: '重疾险' }],
    report: makeFamilyReport(11),
    allocateId,
  }).record;
  first.report.familyPolicyAnalysisReport = {
    status: 'complete',
    content: '旧保单集合的家庭保单分析报告正文',
    model: 'deepseek-v4-pro',
    generatedAt: '2026-07-03T00:00:00.000Z',
  };

  const { record } = createFamilyReportRecord({
    state,
    family,
    owner: { userId: 7 },
    members,
    policies: [{ id: 12, name: '医疗险' }],
    report: makeFamilyReport(12),
    allocateId,
  });

  assert.equal(record.report.familyPolicyAnalysisReport, undefined);
});

test('family report regeneration does not reuse policy analysis report when member notes change', () => {
  const state = {
    familyReports: [],
    familyReportIssues: [],
    familyReportCorrections: [],
  };
  const allocateId = allocateSequence();
  const family = { id: 10, familyName: '张先生家庭', coreMemberId: 1 };
  const first = createFamilyReportRecord({
    state,
    family,
    owner: { userId: 7 },
    members: makeFamilyMembers('负责家庭收入'),
    policies: [{ id: 11, name: '重疾险' }],
    report: makeFamilyReport(11),
    allocateId,
  }).record;
  first.report.familyPolicyAnalysisReport = {
    status: 'complete',
    content: '旧成员备注的家庭保单分析报告正文',
    model: 'deepseek-v4-pro',
    generatedAt: '2026-07-03T00:00:00.000Z',
  };

  const { record } = createFamilyReportRecord({
    state,
    family,
    owner: { userId: 7 },
    members: makeFamilyMembers('负责家庭收入，近期新增房贷'),
    policies: [{ id: 11, name: '重疾险' }],
    report: makeFamilyReport(11),
    allocateId,
  });

  assert.equal(record.report.familyPolicyAnalysisReport, undefined);
});

test('family report regeneration does not reuse legacy policy analysis report without member snapshot', () => {
  const state = {
    familyReports: [{
      id: 1,
      familyId: 10,
      ownerUserId: 7,
      status: 'active',
      report: {
        ...makeFamilyReport(11),
        familyPolicyAnalysisReport: {
          status: 'complete',
          content: '旧版本缓存的家庭保单分析报告正文',
          model: 'deepseek-v4-pro',
          generatedAt: '2026-07-03T00:00:00.000Z',
        },
      },
      generatedAt: '2026-07-03T00:00:00.000Z',
      createdAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z',
    }],
    familyReportIssues: [],
    familyReportCorrections: [],
  };

  const { record } = createFamilyReportRecord({
    state,
    family: { id: 10, familyName: '张先生家庭', coreMemberId: 1 },
    owner: { userId: 7 },
    members: makeFamilyMembers(),
    policies: [{ id: 11, name: '重疾险' }],
    report: makeFamilyReport(11),
    allocateId: allocateSequence(),
  });

  assert.equal(record.report.familyPolicyAnalysisReport, undefined);
});

test('family policy analysis retries pro model after empty and unsafe coverage summary responses', async () => {
  const requestedModels = [];
  const markdownContent = [
    '## 一、报告结论摘要',
    '本报告基于现有保单字段、责任指标和家庭责任信息形成。',
    '## 二、家庭成员与保单全景',
    '当前家庭已有保单需要逐张核实保障对象、责任、期限和保费。',
    '## 三、现有保障结构评价',
    '每张保单均需确认保障对象、主要责任、保额、保障期限、缴费压力和条款限制。',
    '## 四、重点保障缺口分析',
    '| 保障类型 | 建议额度/口径 | 已有保障 | 缺口判断 | 严重度 | 优先级 |',
    '| 医疗 | 定性核对 | 待补充核实 | 存在缺口 | 高 | 高 |',
    '| 意外 | 定性核对 | 待补充核实 | 存在缺口 | 中 | 中 |',
    '| 重疾 | 治疗费用+康复费用+收入补偿 | 待补充核实 | 存在缺口 | 高 | 高 |',
    '| 寿险/身故责任 | 负债+教育+赡养+支出 | 待补充核实 | 存在缺口 | 高 | 高 |',
    '| 收入中断/失能 | 3-5年家庭支出 | 待补充核实 | 存在缺口 | 中 | 中 |',
    '医疗、意外、重疾、寿险/身故责任、收入中断/失能均应结合家庭收入支出继续复核。',
    '## 五、风险场景影响',
    '若经济支柱发生重疾、身故、失能或长期住院，家庭现金流和负债偿还会受到影响。',
    '## 六、配置优先级与预算建议',
    '基础版先补医疗和意外，标准版增加重疾与寿险，完善版再考虑长期现金流安排。',
    '## 七、需要补充核实的信息',
    '需补充家庭年收入、必要支出、负债、子女教育和父母赡养责任。',
    '## 八、动态复盘建议',
    '每年复盘家庭责任和保单变化。本报告仅供家庭保障规划参考，具体投保、责任范围、等待期、除外责任、理赔和核保结果以保险合同条款及保险公司结论为准。',
    '以上内容用于补足长度。'.repeat(120),
  ].join('\n');
  const expertInputVersion = 'sha256:test';
  const completeReport = JSON.stringify({
    markdownContent,
    expertInputVersion,
    structuredResult: {
      summary: '需优先核实医疗责任',
      priorityFindings: [{
        memberRef: 'member_1', category: 'medical', finding: '暂按未配置关注，需核对合同',
        assessment: 'needs_verification', confidence: 'medium', confirmedFactRefs: [], indicatorRefs: [], policyRefs: [],
        missingInformation: ['医疗险合同'], nextVerification: '核对合同责任页',
      }],
      confirmedFacts: [], verificationItems: [], memberFindings: [],
      evidenceRefs: { facts: [], indicators: [], policies: [] }, dataQualityWarnings: [],
    },
  });
  const unsafeReport = JSON.stringify({
    ...JSON.parse(completeReport),
    structuredResult: { ...JSON.parse(completeReport).structuredResult, summary: '客户确认没有医疗保障' },
  });

  const result = await generateFamilyPolicyAnalysisReport({
    input: { expertInputVersion },
    env: { DEEPSEEK_API_KEY: 'test-key' },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      requestedModels.push(body.model);
      assert.deepEqual(body.response_format, { type: 'json_object' });
      return {
        ok: true,
        json: async () => ({
          model: body.model,
          choices: [{ message: { content: requestedModels.length === 1 ? '' : requestedModels.length === 2 ? unsafeReport : completeReport } }],
        }),
      };
    },
  });

  assert.deepEqual(requestedModels, ['deepseek-v4-pro', 'deepseek-v4-pro', 'deepseek-v4-pro']);
  assert.equal(result.status, 'complete');
  assert.equal(result.model, 'deepseek-v4-pro');
  assert.match(result.content, /重点保障缺口分析/u);
  assert.equal(result.content, result.markdownContent);
  assert.equal(result.expertInputVersion, expertInputVersion);
  assert.equal(result.structuredResult.priorityFindings[0].assessment, 'needs_verification');
});

test('family policy analysis rejects malformed structured output after pro retries', async () => {
  let attempts = 0;
  await assert.rejects(generateFamilyPolicyAnalysisReport({
    input: { expertInputVersion: 'sha256:test' },
    env: { DEEPSEEK_API_KEY: 'test-key', FAMILY_POLICY_ANALYSIS_RETRY_ATTEMPTS: '2' },
    fetchImpl: async () => {
      attempts += 1;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"markdownContent":"broken"}' } }] }) };
    },
  }), (error) => error.code === 'FAMILY_POLICY_ANALYSIS_INVALID_RESULT');
  assert.equal(attempts, 2);
});

test('family policy analysis retries transient upstream and JSON decode failures', async () => {
  const expertInputVersion = 'sha256:retry';
  const markdownContent = [
    '## 一、报告结论摘要', '结论', '## 二、家庭成员与保单全景', '全景',
    '## 三、现有保障结构评价', '评价', '## 四、重点保障缺口分析', '缺口',
    '## 五、风险场景影响', '影响', '## 六、配置优先级与预算建议', '建议',
    '## 七、需要补充核实的信息', '核实', '## 八、动态复盘建议', '复盘',
  ].join('\n');
  const validPayload = {
    choices: [{ message: { content: JSON.stringify({
      markdownContent, expertInputVersion,
      structuredResult: {
        summary: '结论', priorityFindings: [], confirmedFacts: [], verificationItems: [], memberFindings: [],
        evidenceRefs: { facts: [], indicators: [], policies: [] }, dataQualityWarnings: [],
      },
    }) } }],
  };

  for (const firstResponse of [
    { ok: false, status: 503, text: async () => 'busy' },
    { ok: true, json: async () => { throw new SyntaxError('bad json'); } },
  ]) {
    let attempts = 0;
    const result = await generateFamilyPolicyAnalysisReport({
      input: { expertInputVersion },
      env: { DEEPSEEK_API_KEY: 'test-key', FAMILY_POLICY_ANALYSIS_RETRY_ATTEMPTS: '2' },
      fetchImpl: async () => {
        attempts += 1;
        return attempts === 1 ? firstResponse : { ok: true, json: async () => validPayload };
      },
    });
    assert.equal(attempts, 2);
    assert.equal(result.status, 'complete');
  }
});

test('family policy analysis does not retry non-429 upstream 4xx responses', async () => {
  let attempts = 0;
  await assert.rejects(generateFamilyPolicyAnalysisReport({
    input: { expertInputVersion: 'sha256:client-error' },
    env: { DEEPSEEK_API_KEY: 'test-key', FAMILY_POLICY_ANALYSIS_RETRY_ATTEMPTS: '3' },
    fetchImpl: async () => {
      attempts += 1;
      return { ok: false, status: 400, text: async () => 'bad request' };
    },
  }), (error) => error.code === 'FAMILY_POLICY_ANALYSIS_UPSTREAM_FAILED');
  assert.equal(attempts, 1);
});

test('family policy analysis rejects incomplete or unordered markdown sections', async () => {
  const expertInputVersion = 'sha256:sections';
  for (const markdownContent of [
    ['## 一、报告结论摘要', '## 二、家庭成员与保单全景', '## 三、现有保障结构评价', '## 四、重点保障缺口分析', '## 五、风险场景影响', '## 六、配置优先级与预算建议', '## 七、需要补充核实的信息', '## 八、动态复盘建议'].join('\n'),
    ['## 二、家庭成员与保单全景', '正文', '## 一、报告结论摘要', '正文', '## 三、现有保障结构评价', '正文', '## 四、重点保障缺口分析', '正文', '## 五、风险场景影响', '正文', '## 六、配置优先级与预算建议', '正文', '## 七、需要补充核实的信息', '正文', '## 八、动态复盘建议', '正文'].join('\n'),
  ]) {
    await assert.rejects(generateFamilyPolicyAnalysisReport({
      input: { expertInputVersion },
      env: { DEEPSEEK_API_KEY: 'test-key', FAMILY_POLICY_ANALYSIS_RETRY_ATTEMPTS: '1' },
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        markdownContent, expertInputVersion,
        structuredResult: { summary: '结论', priorityFindings: [], confirmedFacts: [], verificationItems: [], memberFindings: [], evidenceRefs: { facts: [], indicators: [], policies: [] }, dataQualityWarnings: [] },
      }) } }] }) }),
    }), (error) => error.code === 'FAMILY_POLICY_ANALYSIS_INVALID_RESULT');
  }
});
