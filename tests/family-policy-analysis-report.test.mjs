import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildFamilyPolicyAnalysisInput,
  buildFamilyPolicyAnalysisMessages,
  generateFamilyPolicyAnalysisReport,
  resolveFamilyPolicyAnalysisReportFreshness,
} from '../server/family-policy-analysis-report.service.mjs';
import {
  buildExpertPlanningProfile,
  computeExpertInputVersion,
  groupExpertCoverageIndicators,
} from '../server/family-policy-analysis-contract.service.mjs';
import {
  createFamilyReportRecord,
  updateFamilyReportRecordReport,
} from '../server/family-report-record.service.mjs';

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
    members: [{ id: 1, name: '张先生', notes: '经济支柱', idNumber: 'secret', uiExpanded: true }],
    planningProfile: buildExpertPlanningProfile({ debt: 1_000_000 }),
    policies: [{
      id: 11,
      productName: '重疾险',
      coverageAmount: 300_000,
      updatedAt: 'today',
      editing: false,
      responsibilities: [{ name: '重大疾病保险金', amount: 300_000, verifiedAt: 'today', idNumberMasked: '****1234' }],
      evidence: { knowledgeEvidence: [{ title: '保险条款', verificationStatus: 'verified', fetchedAt: 'today', activeTab: 'terms' }] },
    }],
    groupedCoverageIndicators: [{ memberRef: 'member_1', category: 'critical', confirmedItems: [], notIdentifiedItems: ['轻症'], activeTab: 'gap' }],
    evidenceReferences: [{ policyRef: 'policy_1', verificationStatus: 'verified', sourceKind: 'customer_policy_terms', fetchedAt: 'today', editing: false }],
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
  }), first);
  assert.notEqual(computeExpertInputVersion({ ...input, family: { ...input.family, notes: '新增房贷' } }), first);
  assert.notEqual(computeExpertInputVersion({ ...input, members: [{ ...input.members[0], notes: '准备退休' }] }), first);
  assert.notEqual(computeExpertInputVersion({ ...input, planningProfile: buildExpertPlanningProfile({ debt: 900_000 }) }), first);
  assert.notEqual(computeExpertInputVersion({ ...input, policies: [{ ...input.policies[0], coverageAmount: 500_000 }] }), first);
  assert.notEqual(computeExpertInputVersion({ ...input, groupedCoverageIndicators: [{ ...input.groupedCoverageIndicators[0], notIdentifiedItems: ['轻症', '中症'] }] }), first);
  assert.notEqual(computeExpertInputVersion({ ...input, evidenceReferences: [{ ...input.evidenceReferences[0], verificationStatus: 'pending_review' }] }), first);
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

test('family policy analysis prompt asks for full customer report with emphasized gap section', () => {
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
          scores: [{ key: 'criticalIllness', label: '重疾', amount: 300000, target: 800000, gap: 500000 }],
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
  assert.match(prompt, /医疗、意外、重疾、寿险\/身故责任、收入中断\/失能/u);
  assert.match(prompt, /不能出现“AI”/u);
  assert.match(prompt, /referenceOnly=true/u);
  assert.match(prompt, /待核实参考/u);
});

test('family report refresh preserves generated policy analysis report', () => {
  const record = {
    summary: { issueCount: 0 },
    report: {
      familyPolicyAnalysisReport: {
        status: 'complete',
        content: '已生成的家庭保单分析报告正文',
        model: 'deepseek-v4-pro',
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
  });

  assert.equal(record.report.familyPolicyAnalysisReport.content, '已生成的家庭保单分析报告正文');
  assert.equal(record.report.familyPolicyAnalysisReport.model, 'deepseek-v4-pro');
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
    generatedAt: '2026-07-03T00:00:00.000Z',
  };

  const { record } = createFamilyReportRecord({
    state,
    family,
    owner: { userId: 7 },
    members,
    policies: [{ id: 11, name: '重疾险' }],
    report: makeFamilyReport(11),
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

test('family policy analysis retries pro model after empty pro response', async () => {
  const requestedModels = [];
  const completeReport = [
    '## 一、报告结论摘要',
    '本报告基于现有保单字段、责任指标和家庭责任信息形成。',
    '## 二、家庭成员与保单全景',
    '当前家庭已有保单需要逐张核实保障对象、责任、期限和保费。',
    '## 三、现有保障结构评价',
    '每张保单均需确认保障对象、主要责任、保额、保障期限、缴费压力和条款限制。',
    '## 四、重点保障缺口分析',
    '| 保障类型 | 建议额度/口径 | 已有保障 | 缺口判断 | 严重度 | 优先级 |',
    '| 医疗 | 300-600万医疗额度 | 待补充核实 | 存在缺口 | 高 | 高 |',
    '| 意外 | 年收入5-10倍 | 待补充核实 | 存在缺口 | 中 | 中 |',
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

  const result = await generateFamilyPolicyAnalysisReport({
    input: {},
    env: { DEEPSEEK_API_KEY: 'test-key' },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      requestedModels.push(body.model);
      return {
        ok: true,
        json: async () => ({
          model: body.model,
          choices: [{ message: { content: requestedModels.length === 1 ? '' : completeReport } }],
        }),
      };
    },
  });

  assert.deepEqual(requestedModels, ['deepseek-v4-pro', 'deepseek-v4-pro']);
  assert.equal(result.status, 'complete');
  assert.equal(result.model, 'deepseek-v4-pro');
  assert.match(result.content, /重点保障缺口分析/u);
});
