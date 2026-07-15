import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFamilySalesReviewInput,
  buildFamilySalesReviewMessages,
  enforceVerifiedCashflowAmounts,
  reconcileVerifiedCashflowAmounts,
  generateFamilySalesReview,
  resolveFamilySalesReviewFreshness,
} from '../server/family-sales-review.service.mjs';
import {
  buildFamilySalesChatContext,
  buildFamilySalesChatMessages,
  buildLightweightSalesChatContext,
  deriveSalesConversationTargets,
  generateFamilySalesChatReply,
  resolveSalesTopicPack,
  selectSalesTopicPack,
} from '../server/family-sales-chat.service.mjs';
import {
  buildFamilySalesMemoryContext,
  normalizeExtractedFamilySalesMemories,
  upsertFamilySalesMemories,
} from '../server/family-sales-memory.service.mjs';
import { buildExpertBackedSalesReviewContext } from '../server/family-sales-context.service.mjs';
import { createFamilyReportRegenerationService } from '../server/family-report-regeneration.service.mjs';

test('expert-backed sales context contains findings and only referenced policy indexes', () => {
  const context = buildExpertBackedSalesReviewContext({
    family: { id: 1, coreMemberId: 10, notes: '稳健', planningProfile: { annualIncome: null, debt: 0 } },
    members: [{ id: 10, name: '张三', relationLabel: null, role: '', notes: null, age: 0, idNumber: '110101198606141234' }],
    policies: [
      { id: 101, company: '甲公司', name: '甲产品', insuredMemberId: 10, amount: 0, firstPremium: null, validityStatus: null, coverageIndicators: [{ liability: '不应传入' }] },
      { id: 102, company: '乙公司', name: '乙产品', insuredMemberId: 10, coverageIndicators: [{ liability: '不应传入' }] },
    ],
    expertReport: {
      id: 88,
      expertInputVersion: 'sha256:v1',
      structuredResult: {
        summary: '专家结论',
        priorityFindings: [{ title: '优先核实', policyRefs: ['policy:101'] }],
        memberFindings: [], verificationItems: [], confirmedFacts: [{ id: 'fact:1', label: '给付金额', amount: 5, unit: '万元' }],
        evidenceRefs: { policies: ['policy:101'], facts: [], indicators: [] }, dataQualityWarnings: [],
      },
    },
    generatedAt: '2026-07-15T00:00:00.000Z',
    salesMemoryContext: { preferences: ['简洁'] },
    salesChatContext: { messages: ['先讲养老'] },
  });
  assert.equal(context.expertReportId, 88);
  assert.equal(context.expertInputVersion, 'sha256:v1');
  assert.equal(context.family.planningSummary.annualIncome, null);
  assert.equal(context.family.planningSummary.debt, 0);
  assert.equal(context.members[0].age, 0);
  assert.equal(context.members[0].relationLabel, null);
  assert.equal(context.members[0].notes, null);
  assert.equal(context.policyIndex[0].coverageAmount, 0);
  assert.equal(context.policyIndex[0].annualPremium, null);
  assert.equal(context.policyIndex[0].validityStatus, null);
  assert.deepEqual(context.allowedAmountFacts.map((fact) => [fact.kind, fact.amount]), [['expertConfirmedAmount', 50000]]);
  assert.deepEqual(context.policyIndex.map((policy) => policy.policyRef), ['policy:101']);
  assert.equal(JSON.stringify(context).includes('officialEvidence'), false);
  assert.equal(JSON.stringify(context).includes('coverageIndicators'), false);
  assert.equal(JSON.stringify(context).includes('110101198606141234'), false);
});

test('expert-backed amount reconciliation corrects bounded facts and downgrades unsupported money claims', () => {
  const input = {
    expertFindings: { summary: '结论' },
    allowedAmountFacts: [
      { kind: 'coverageAmount', amount: 300000, label: '保额' },
      { kind: 'annualPremium', amount: 12000, label: '年交保费' },
      { kind: 'expertConfirmedAmount', amount: 50000, label: '给付金额', factRef: 'fact:1' },
    ],
  };
  const result = reconcileVerifiedCashflowAmounts('1. 保额 50万元，年交保费 2万元，给付金额 8万元。建议另备 9万元。第2步核实。', input);
  assert.equal(result.changed, true);
  assert.match(result.content, /保额 30万元/u);
  assert.match(result.content, /年交保费 1\.2万元/u);
  assert.match(result.content, /给付金额 5万元/u);
  assert.match(result.content, /建议另备 金额待核实/u);
  assert.match(result.content, /第2步/u);
});

test('expert-backed generation corrects money before returning without a second model call', async () => {
  let fetchCalls = 0;
  const review = await generateFamilySalesReview({
    input: {
      expertFindings: { summary: '结论' }, members: [], policyIndex: [],
      allowedAmountFacts: [{ kind: 'coverageAmount', amount: 300000, label: '保额' }],
    },
    env: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, json: async () => ({ model: 'test', choices: [{ message: { content: '## 一、销售结论摘要\n建议保额 50万元，另备 8万元。' } }] }) };
    },
  });
  assert.equal(fetchCalls, 1);
  assert.match(review.content, /保额 30万元/u);
  assert.match(review.content, /另备 金额待核实/u);
});

test('sales regeneration awaits fresh structured expert report and binds its version', async () => {
  const calls = [];
  const state = { familySalesReviews: [] };
  const expert = {
    id: 7, status: 'complete', content: '# full markdown must not be forwarded', expertInputVersion: 'sha256:fresh',
    structuredResult: { summary: '专家结论', priorityFindings: [], confirmedFacts: [], verificationItems: [], memberFindings: [], evidenceRefs: { facts: [], indicators: [], policies: ['policy:101'] }, dataQualityWarnings: [] },
  };
  const service = createFamilyReportRegenerationService({
    state, allocateId: () => 99, listFamilyMembers: () => [{ id: 10, name: '张三', relationLabel: '本人' }],
    policiesForFamilyReport: () => [], policiesForSalesReview: () => [{ id: 101, name: '保单', coverageIndicators: [{ liability: 'full' }] }],
    repairFamilyMembersBeforeReview: async () => {}, refreshFamilyCashflowsForAnalysis: () => {}, buildFamilyReport: () => ({ secret: true }),
    createFamilyReportRecord: () => ({}), appendDeepSeekReportIssues: async () => {}, refreshFamilyReportWithTrustedCorrections: () => {},
    buildFamilyPolicyAnalysisInput: () => ({ expertInputVersion: 'sha256:fresh' }),
    familyPolicyAnalysisOrchestrator: { ensureFresh: async (request) => { calls.push(['expert', request.explicitRefresh]); return expert; } },
    generateFamilySalesReview: async ({ input }) => {
      calls.push(['sales', input]);
      assert.equal(input.expertFindings.summary, '专家结论');
      assert.equal(JSON.stringify(input).includes('full markdown'), false);
      return {
        content: [
          '## 一、销售结论摘要', '结论',
          '## 二、必须先核实的数据风险', '- 核实A', '- 核实B', '- 核实C', '- 核实D',
          '## 三、保障关注点', '- 关注A', '- 关注B', '- 关注C', '- 关注D',
          '## 四、销售机会', '- 机会A', '- 机会B', '- 机会C', '- 机会D',
          '## 五、面谈目标', '核准优先事项',
          '## 六、下一步销售动作清单', '- 行动A', '- 行动B', '- 行动C', '- 行动D',
        ].join('\n'),
        structuredSummary: {
          conclusion: '候选结论', verificationItems: ['', '候选核实', '候选核实', '核实3', '核实4'],
          coverageConcerns: null, salesOpportunities: ['候选机会'], meetingObjective: '', nextActions: null,
          refs: { policies: ['policy:missing', 'policy:101', 'policy:101'], facts: ['fact:missing'] },
        },
        model: 'test', generatedAt: '2026-07-15T01:00:00.000Z',
      };
    },
    archiveSalesReviewForFamily: () => {}, ownerFields: () => ({ ownerUserId: 1, ownerGuestId: '' }),
    persistFamilyReportState: async () => {}, persistFamilyState: async () => {}, nowIso: () => '2026-07-15T01:00:00.000Z',
  });
  const record = await service.regenerateSalesReview({ family: { id: 1, coreMemberId: 10 }, owner: { userId: 1 } });
  assert.deepEqual(calls.map((call) => call[0]), ['expert', 'sales']);
  assert.equal(record.expertReportId, 7);
  assert.equal(record.expertInputVersion, 'sha256:fresh');
  assert.equal(record.structuredSummary.conclusion, '候选结论');
  assert.deepEqual(record.structuredSummary.verificationItems, ['候选核实', '核实3', '核实4']);
  assert.deepEqual(record.structuredSummary.coverageConcerns, ['关注A', '关注B', '关注C']);
  assert.deepEqual(record.structuredSummary.salesOpportunities, ['候选机会']);
  assert.equal(record.structuredSummary.meetingObjective, '核准优先事项');
  assert.deepEqual(record.structuredSummary.nextActions, ['行动A', '行动B', '行动C']);
  assert.deepEqual(record.structuredSummary.refs, { facts: [], indicators: [], policies: ['policy:101'] });
});

test('concurrent identical sales regeneration shares one model call and one saved review', async () => {
  let salesCalls = 0;
  const state = { familySalesReviews: [] };
  const expert = { id: 7, status: 'complete', content: '专家', expertInputVersion: 'v1', structuredResult: { summary: '结论', priorityFindings: [], confirmedFacts: [], verificationItems: [], memberFindings: [], evidenceRefs: { facts: [], indicators: [], policies: [] }, dataQualityWarnings: [] } };
  const service = createFamilyReportRegenerationService({
    state, allocateId: () => 10, listFamilyMembers: () => [], policiesForSalesReview: () => [],
    repairFamilyMembersBeforeReview: async () => {}, refreshFamilyCashflowsForAnalysis: () => {},
    familyPolicyAnalysisOrchestrator: { ensureFresh: async () => expert },
    generateFamilySalesReview: async () => { salesCalls += 1; await new Promise((resolve) => setImmediate(resolve)); return { content: '## 一、销售结论摘要\n结论' }; },
    archiveSalesReviewForFamily: () => {}, ownerFields: () => ({ ownerUserId: 1 }), persistFamilyState: async () => {},
  });
  const request = { family: { id: 1 }, owner: { userId: 1 }, salesChatContext: { selectedMessageIds: [6] } };
  const [left, right] = await Promise.all([service.regenerateSalesReview(request), service.regenerateSalesReview(request)]);
  assert.equal(left, right);
  assert.equal(salesCalls, 1);
  assert.equal(state.familySalesReviews.length, 1);
});

test('sales regeneration rolls back review mutations when persistence fails', async () => {
  const previous = { id: 1, familyId: 9, ownerGuestId: 'guest-a', status: 'active', updatedAt: 'before' };
  const other = { id: 2, familyId: 9, ownerGuestId: 'guest-b', status: 'active' };
  const state = { familySalesReviews: [previous, other] };
  const beforeFailure = structuredClone(state.familySalesReviews);
  const expert = { id: 7, status: 'complete', content: '专家', expertInputVersion: 'v1', structuredResult: { summary: '结论', priorityFindings: [], confirmedFacts: [], verificationItems: [], memberFindings: [], evidenceRefs: { facts: [], indicators: [], policies: [] }, dataQualityWarnings: [] } };
  let persistCalls = 0;
  const service = createFamilyReportRegenerationService({
    state, allocateId: () => 3, listFamilyMembers: () => [], policiesForSalesReview: () => [], repairFamilyMembersBeforeReview: async () => {}, refreshFamilyCashflowsForAnalysis: () => {},
    familyPolicyAnalysisOrchestrator: { ensureFresh: async () => expert }, generateFamilySalesReview: async () => ({ content: '## 一、销售结论摘要\n结论' }),
    archiveSalesReviewForFamily: () => { previous.status = 'archived'; previous.updatedAt = 'changed'; },
    ownerFields: () => ({ ownerGuestId: 'guest-a' }), persistFamilyState: async () => { persistCalls += 1; if (persistCalls === 1) throw new Error('disk failed'); },
  });
  const request = { family: { id: 9 }, owner: { guestId: 'guest-a' }, stateSnapshot: state };
  await assert.rejects(() => service.regenerateSalesReview(request), /disk failed/);
  assert.deepEqual(state.familySalesReviews, beforeFailure);
  assert.equal(previous.status, 'active');
  assert.equal(other.status, 'active');
  const record = await service.regenerateSalesReview(request);
  assert.equal(record.status, 'active');
  assert.equal(state.familySalesReviews.length, 3);
  assert.equal(previous.status, 'archived');
  assert.equal(other.status, 'active');
});

test('snapshot sales regeneration archives only the matching guest owner', async () => {
  const own = { id: 1, familyId: 9, ownerGuestId: 'guest-a', status: 'active' };
  const other = { id: 2, familyId: 9, ownerGuestId: 'guest-b', status: 'active' };
  const snapshot = { familySalesReviews: [own, other] };
  const expert = { id: 7, status: 'complete', content: '专家', expertInputVersion: 'v1', structuredResult: { summary: '结论', priorityFindings: [], confirmedFacts: [], verificationItems: [], memberFindings: [], evidenceRefs: { facts: [], indicators: [], policies: [] }, dataQualityWarnings: [] } };
  const service = createFamilyReportRegenerationService({
    state: { familySalesReviews: [] }, allocateId: () => 3, listFamilyMembers: () => [], policiesForSalesReview: () => [], repairFamilyMembersBeforeReview: async () => {}, refreshFamilyCashflowsForAnalysis: () => {},
    familyPolicyAnalysisOrchestrator: { ensureFresh: async () => expert }, generateFamilySalesReview: async () => ({ content: '## 一、销售结论摘要\n结论' }),
    ownerFields: () => ({ ownerGuestId: 'guest-a' }), persistFamilyState: async () => {},
  });
  await service.regenerateSalesReview({ family: { id: 9 }, owner: { guestId: 'guest-a' }, stateSnapshot: snapshot });
  assert.equal(own.status, 'archived');
  assert.equal(other.status, 'active');
});

test('sales regeneration serializes different inputs, cleans rejected work, and does not block another owner', async () => {
  const state = { familySalesReviews: [] };
  const expert = { id: 7, status: 'complete', content: '专家', expertInputVersion: 'v1', structuredResult: { summary: '结论', priorityFindings: [], confirmedFacts: [], verificationItems: [], memberFindings: [], evidenceRefs: { facts: [], indicators: [], policies: [] }, dataQualityWarnings: [] } };
  let calls = 0;
  let activeA = 0;
  let maxActiveA = 0;
  let releaseFirstA;
  const firstAGate = new Promise((resolve) => { releaseFirstA = resolve; });
  const service = createFamilyReportRegenerationService({
    state, allocateId: () => calls + 10, listFamilyMembers: () => [], policiesForSalesReview: () => [], repairFamilyMembersBeforeReview: async () => {}, refreshFamilyCashflowsForAnalysis: () => {},
    familyPolicyAnalysisOrchestrator: { ensureFresh: async () => expert },
    generateFamilySalesReview: async ({ input }) => {
      calls += 1;
      if (input.salesChatContext?.fail) throw new Error('first failed');
      if (input.salesChatContext?.owner === 'a') { activeA += 1; maxActiveA = Math.max(maxActiveA, activeA); }
      if (input.salesChatContext?.owner === 'a' && input.salesChatContext?.id === 1) await firstAGate;
      else await new Promise((resolve) => setImmediate(resolve));
      if (input.salesChatContext?.owner === 'a') activeA -= 1;
      return { content: `## 一、销售结论摘要\n${calls}` };
    },
    archiveSalesReviewForFamily: () => {}, ownerFields: (owner) => ({ ownerUserId: owner.userId }), persistFamilyState: async () => {},
  });
  await assert.rejects(() => service.regenerateSalesReview({ family: { id: 1 }, owner: { userId: 1 }, salesChatContext: { fail: true } }), /first failed/);
  const a1 = service.regenerateSalesReview({ family: { id: 1 }, owner: { userId: 1 }, salesChatContext: { owner: 'a', id: 1 } });
  const a2 = service.regenerateSalesReview({ family: { id: 1 }, owner: { userId: 1 }, salesChatContext: { owner: 'a', id: 2 } });
  const b = service.regenerateSalesReview({ family: { id: 1 }, owner: { userId: 2 }, salesChatContext: { owner: 'b' } });
  await b;
  assert.equal(activeA, 1, '另一 owner 在首个 owner 的任务仍阻塞时已经完成');
  releaseFirstA();
  await Promise.all([a1, a2]);
  assert.equal(calls, 4);
  assert.equal(maxActiveA, 1);
});

test('sales regeneration stops when expert report lacks structured result', async () => {
  let salesCalls = 0;
  const state = { familyReports: [], familySalesReviews: [], knowledgeRecords: [], insuranceIndicatorRecords: [], optionalResponsibilityRecords: [] };
  const service = createFamilyReportRegenerationService({
    state, allocateId: () => 8, listFamilyMembers: () => [], policiesForFamilyReport: () => [], policiesForSalesReview: () => [],
    repairFamilyMembersBeforeReview: async () => {}, buildFamilyReport: () => ({}),
    buildFamilyPolicyAnalysisInput: () => ({ expertInputVersion: 'v1' }),
    createFamilyReportRecord: () => { const record = { id: 8, report: {} }; state.familyReports.push(record); return { record }; },
    appendDeepSeekReportIssues: async () => {}, refreshFamilyReportWithTrustedCorrections: () => {},
    getExpertReportRecord: () => state.familyReports[0] || null, persistFamilyReportState: async () => {},
    refreshFamilyCashflowsForAnalysis: () => {}, familyPolicyAnalysisOrchestrator: { ensureFresh: async () => ({ status: 'complete', content: 'markdown', expertInputVersion: 'v1' }) },
    generateFamilySalesReview: async () => { salesCalls += 1; }, ownerFields: () => ({}), persistFamilyState: async () => {},
  });
  await assert.rejects(() => service.regenerateSalesReview({ family: { id: 1 }, owner: {} }), /STRUCTURED_RESULT/);
  assert.equal(salesCalls, 0);
  assert.equal(state.familySalesReviews.length, 0);
  assert.equal(state.familyReports.length, 1, '确定性基础家庭报告允许保存，但专家失败不得保存销售建议');
});

test('sales review freshness follows expert binding, active status, generatedAt, and current source timestamp', () => {
  const review = { status: 'active', generatedAt: '2026-07-11T00:00:00.000Z', expertInputVersion: 'sha256:v1' };
  assert.equal(resolveFamilySalesReviewFreshness(review, { sourceUpdatedAt: '2026-07-10T00:00:00.000Z' }).status, 'fresh');
  assert.equal(resolveFamilySalesReviewFreshness(review, { sourceUpdatedAt: '2026-07-12T00:00:00.000Z' }).status, 'stale');
  assert.equal(resolveFamilySalesReviewFreshness(review, { sourceUpdatedAt: '2026-07-11T09:00:00+08:00' }).status, 'stale');
  assert.equal(resolveFamilySalesReviewFreshness({ status: 'archived', generatedAt: '2026-07-11T00:00:00.000Z' }).status, 'missing');
  assert.equal(resolveFamilySalesReviewFreshness({ status: 'active', generatedAt: '2026-07-11T00:00:00.000Z' }).status, 'stale');
});

test('family sales review input keeps members without policies and official evidence', () => {
  const family = { id: 1, familyName: '张三家庭', coreMemberId: 10, status: 'active', notes: '家庭年收入约80万，偏好稳健方案，张三身份证110101198606141234仅本地核验' };
  const members = [
    { id: 10, familyId: 1, name: '张三', relationLabel: '本人', relationToCore: 'self', role: 'core', birthday: '1986-06-14', idNumber: '110101198606141234', idNumberTail: '123456', notes: '做企业管理，喜欢先看现金流表', status: 'active' },
    { id: 11, familyId: 1, name: '李四', relationLabel: '配偶', relationToCore: 'spouse', role: 'adult', birthday: '1988-12-01', identityNumber: '110101198812016543', idNumberTail: '654321', notes: '关注孩子教育金，沟通偏好简短结论', status: 'active' },
  ];
  const productName = '新华人寿保险股份有限公司盛世荣耀臻享版终身寿险（分红型）';
  const policies = [
    {
      id: 101,
      familyId: 1,
      company: '新华保险',
      name: productName,
      applicantMemberId: 10,
      applicantMemberName: '张三',
      insuredMemberId: 10,
      insuredMemberName: '张三',
      insuredIdNumber: '110101198606141234',
      amount: 300000,
      firstPremium: 20000,
      coveragePeriod: '终身',
      paymentPeriod: '10年',
    },
  ];
  const input = buildFamilySalesReviewInput({
    family,
    members,
    policies,
    generatedAt: '2026-06-15T00:00:00.000Z',
    familyReport: {
      summary: { policyCount: 1 },
      policyInventory: { insuredGroups: [{ member: '张三', memberId: 10, policies: [] }] },
      criticalIllness: { memberScores: [{ member: '张三', gap: 300000 }] },
    },
    knowledgeRecords: [{
      id: 7,
      company: '新华保险',
      productName,
      productType: '终身寿险',
      official: true,
      sourceKind: 'insurer_official',
      evidenceLevel: 'insurer_official',
      url: 'https://official.example-life.test/ssry.pdf',
    }, {
      id: 8,
      company: '新华保险',
      productName,
      productType: '终身寿险',
      title: '第三方网页线索',
      official: false,
      sourceKind: 'open_web_reference',
      evidenceLevel: 'external_legacy_reference',
      url: 'https://reference.example.test/ssry',
    }],
    indicatorRecords: [{
      id: 'indicator-1',
      company: '新华保险',
      productName,
      coverageType: '身故或身体全残',
      liability: '身故或身体全残保险金',
      formulaText: '按现金价值、已交保费乘以比例、基本保额对应金额三者较大者给付',
    }],
  });

  assert.equal(input.members.length, 2);
  assert.equal(input.members.find((member) => member.relationLabel === '配偶')?.memberRef, '{{member_2}}');
  assert.equal(input.members.find((member) => member.relationLabel === '配偶')?.hasPolicy, false);
  assert.equal(input.members.find((member) => member.relationLabel === '本人')?.age, 40);
  assert.equal(input.family.topPillarMemberRef, '{{member_1}}');
  assert.equal(input.family.notes, family.notes);
  assert.equal(input.members.find((member) => member.relationLabel === '本人')?.notes, '做企业管理，喜欢先看现金流表');
  assert.equal(input.members.find((member) => member.relationLabel === '配偶')?.notes, '关注孩子教育金，沟通偏好简短结论');
  assert.deepEqual(input.dataQuality.membersWithoutPolicy.map((member) => member.memberRef), ['{{member_2}}']);
  assert.equal(input.policies[0].applicantMemberRef, '{{member_1}}');
  assert.equal(input.policies[0].applicantAge, 40);
  assert.equal(input.policies[0].insuredMemberRef, '{{member_1}}');
  assert.equal(input.policies[0].insuredAge, 40);
  assert.equal(input.officialEvidence.length, 1);
  assert.equal(input.officialEvidence[0].officialSources[0].url, 'https://official.example-life.test/ssry.pdf');
  assert.equal(input.officialEvidence[0].referenceSources[0].url, 'https://reference.example.test/ssry');
  assert.equal(input.officialEvidence[0].referenceSources[0].referenceOnly, true);
  assert.equal(input.officialEvidence[0].officialIndicators[0].coverageType, '身故或身体全残');

  const prompt = buildFamilySalesReviewMessages(input).map((message) => message.content).join('\n');
  assert.match(prompt, /成员级保障缺口/);
  assert.match(prompt, /理财险\/财富传承销售机会/);
  assert.match(prompt, /销售方案展开/);
  assert.match(prompt, /邀约面谈与销售话术/);
  assert.match(prompt, /适合对象、客户痛点、推荐方向、预算\/保额口径、销售话术、需补资料、下一步动作/);
  assert.match(prompt, /见面开场、风险洞察提问、保障缺口切入、理财险\/养老教育金切入、促成面谈\/二次沟通/);
  assert.match(prompt, /已经买过很多保险/);
  assert.match(prompt, /暂时不想增加预算/);
  assert.match(prompt, /理财险收益不确定/);
  assert.match(prompt, /不要直接输出输入 JSON 的英文内部字段名/);
  assert.match(prompt, /family\.notes 是整个家庭层面的备注，不属于某个具体成员/u);
  assert.match(prompt, /members\[\]\.notes 才是成员个人备注/u);
  assert.match(prompt, /family\.topPillarMemberRef 明确表示家庭顶梁柱/u);
  assert.match(prompt, /"topPillarMemberRef": "\{\{member_1\}\}"/u);
  assert.match(prompt, /家庭年收入约80万/);
  assert.match(prompt, /\{\{member_1\}\}身份证\{\{id_number_1\}\}仅本地核验/);
  assert.match(prompt, /\{\{id_number_1\}\}/);
  assert.match(prompt, /喜欢先看现金流表/);
  assert.match(prompt, /沟通偏好简短结论/);
  assert.match(prompt, /配偶/);
  assert.match(prompt, /\{\{member_1\}\}/);
  assert.match(prompt, /\{\{member_2\}\}/);
  assert.match(prompt, /"applicantAge": 40/);
  assert.doesNotMatch(prompt, /张三|李四|张三家庭|110101198606141234|110101198812016543|123456|654321/);
  assert.match(prompt, /https:\/\/official\.example-life\.test\/ssry\.pdf/);
  assert.match(prompt, /referenceOnly=true/u);
  assert.match(prompt, /待核实参考/u);
});

test('family sales review prompt combines sales skills into executable advisor workflow', () => {
  const input = buildFamilySalesReviewInput({
    family: {
      id: 1,
      familyName: '张三家庭',
      coreMemberId: 10,
      status: 'active',
      notes: '客户偏好先看结论，再看预算方案',
      planningProfile: {
        annualIncome: 800000,
        annualExpense: 360000,
        debt: 1200000,
        educationGoal: 500000,
        parentSupportGoal: 300000,
        availableAssets: 200000,
        premiumBudget: 60000,
      },
    },
    members: [
      { id: 10, familyId: 1, name: '张三', relationLabel: '本人', relationToCore: 'self', role: 'core', birthday: '1986-06-14', status: 'active' },
      { id: 11, familyId: 1, name: '李四', relationLabel: '配偶', relationToCore: 'spouse', role: 'adult', birthday: '1988-12-01', status: 'active' },
    ],
    policies: [{
      id: 101,
      familyId: 1,
      company: '新华保险',
      name: '测试终身寿险',
      applicantMemberId: 10,
      applicantMemberName: '张三',
      insuredMemberId: 10,
      insuredMemberName: '张三',
      amount: 300000,
      firstPremium: 20000,
      coveragePeriod: '终身',
      paymentPeriod: '10年',
    }],
    familyReport: {
      summary: { policyCount: 1, annualPremium: 20000 },
      radar: { family: { scores: [] }, members: [] },
      policyInventory: { insuredGroups: [] },
    },
    generatedAt: '2026-06-15T00:00:00.000Z',
  });

  const prompt = buildFamilySalesReviewMessages(input).map((message) => message.content).join('\n');
  assert.match(prompt, /交叉销售机会/u);
  assert.match(prompt, /客户复盘会议策略/u);
  assert.match(prompt, /年金、寿险、养老\/教育金机会/u);
  assert.match(prompt, /家庭财务规划视角/u);
  assert.match(prompt, /保险重整|保险重整建议|保单重整/u);
  assert.match(prompt, /会前.*会中.*会后|会前准备|会后跟进/u);
  assert.match(prompt, /P1|P2|P3/u);
  assert.match(prompt, /成功概率|机会优先级/u);
  assert.match(prompt, /基础方案.*标准方案.*完善方案/us);
  assert.match(prompt, /收入、支出、负债、现金储备和保费预算/u);
  assert.match(prompt, /不得承诺收益/u);
  assert.match(prompt, /"annualIncome": 800000/u);
  assert.match(prompt, /"premiumBudget": 60000/u);
});

test('family sales review requests DeepSeek pro by default with thinking enabled', async () => {
  let requestBody = null;
  const input = buildFamilySalesReviewInput({
    family: { id: 1, familyName: '张三家庭', coreMemberId: 10, status: 'active' },
    members: [
      { id: 10, familyId: 1, name: '张三', relationLabel: '本人', relationToCore: 'self', role: 'core', birthday: '1986-06-14', idNumber: '110101198606141234', status: 'active' },
      { id: 11, familyId: 1, name: '李四', relationLabel: '配偶', relationToCore: 'spouse', role: 'adult', birthday: '1988-12-01', identityNumber: '110101198812016543', status: 'active' },
    ],
    policies: [{
      id: 101,
      familyId: 1,
      company: '新华保险',
      name: '测试保单',
      applicantMemberId: 10,
      applicantMemberName: '张三',
      insuredMemberId: 11,
      insuredMemberName: '李四',
      insuredIdNumber: '110101198812016543',
    }],
    generatedAt: '2026-06-15T00:00:00.000Z',
  });
  const review = await generateFamilySalesReview({
    input,
    env: {
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: 'https://deepseek.test',
    },
    fetchImpl: async (_url, options = {}) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          model: 'deepseek-v4-pro',
          choices: [{ message: { content: '## 一、销售结论摘要\n建议先联系{{member_1}}，再补充{{member_2}}资料。证件号{{id_number_1}}不应展示。' } }],
        }),
      };
    },
  });

  assert.equal(requestBody.model, 'deepseek-v4-pro');
  assert.deepEqual(requestBody.thinking, { type: 'enabled' });
  assert.equal(requestBody.reasoning_effort, 'high');
  assert.doesNotMatch(JSON.stringify(requestBody), /张三|李四|张三家庭|110101198606141234|110101198812016543/);
  assert.match(review.content, /销售结论摘要/);
  assert.match(review.content, /张三/);
  assert.match(review.content, /李四/);
  assert.match(review.content, /身份证号已脱敏/);
  assert.doesNotMatch(review.content, /110101198606141234|110101198812016543|\{\{id_number_1\}\}/);
  assert.equal(review.inputSummary.familyId, null);
});

test('family sales review keeps yearly deterministic cashflow amounts instead of model-rewritten units', async () => {
  const input = buildFamilySalesReviewInput({
    family: { id: 1, status: 'active' },
    members: [],
    policies: [{
      id: 101,
      company: '测试保险',
      name: '测试两全险',
      amount: 200000,
      cashflowEntries: [{ year: 2052, amount: 200000, liability: '满期保险金', calcText: '满期给付基本保险金额' }],
    }],
  });

  assert.deepEqual(input.policies[0].verifiedCashflow, [{
    year: 2052,
    amount: 200000,
    liability: '满期保险金',
    calcText: '满期给付基本保险金额',
  }]);
  assert.deepEqual(input.financialFacts, [{
    policyId: 101,
    productName: '测试两全险',
    entries: [{
      year: 2052,
      liability: '满期保险金',
      amount: 200000,
      amountText: '20万元',
      calculationText: '满期给付基本保险金额',
    }],
  }]);
  assert.match(buildFamilySalesReviewMessages(input).map((message) => message.content).join('\n'), /不得除以10/u);
  assert.match(enforceVerifiedCashflowAmounts('2052年确定给付 2 万元。', input), /2052年确定给付 20万元/u);
  assert.match(enforceVerifiedCashflowAmounts('2053年确定给付 2 万元。', input), /2053年确定给付 金额待核实/u);
  assert.equal(reconcileVerifiedCashflowAmounts('2052年确定给付 2 万元。', input).changed, true);

  let reportRequestCount = 0;
  const review = await generateFamilySalesReview({
    input,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async (_url, options = {}) => {
      reportRequestCount += 1;
      const body = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          model: 'deepseek-v4-pro',
          choices: [{ message: { content: reportRequestCount === 1
            ? '## 一、销售结论摘要\n- 现有两全险满期金（2052年确定给付 2 万元），仅具象征性规划意义。'
            : '## 一、销售结论摘要\n- 现有两全险在2052年确定给付20万元，是否足以支持养老目标仍需结合家庭财务目标核实。' } }],
        }),
      };
    },
  });
  assert.equal(reportRequestCount, 2);
  assert.match(review.content, /2052年确定给付\s*20万元/u);
  assert.doesNotMatch(review.content, /2052年确定给付\s*2 万元/u);
  assert.doesNotMatch(review.content, /仅具象征性规划意义/u);
});

test('family sales review excludes conflicting cached cashflow data before analysis', () => {
  const input = buildFamilySalesReviewInput({
    family: { id: 1, status: 'active' },
    policies: [{
      id: 102,
      name: '金额待核实两全险',
      amount: 200000,
      cashflowEntries: [{
        year: 2052,
        amount: 20000,
        liability: '满期保险金',
        calcText: '基本保险金额200,000元 × 100% = 200,000元',
      }],
    }],
  });

  assert.deepEqual(input.policies[0].verifiedCashflow, []);
  assert.match(input.dataQuality.financialDataWarnings[0], /金额与计算公式不一致/u);
  assert.deepEqual(input.financialFacts, []);
  const prompt = buildFamilySalesReviewMessages(input).map((message) => message.content).join('\n');
  assert.match(prompt, /金额异常/u);
  assert.match(prompt, /不能据此判断产品价值/u);
});

test('family sales chat prompt uses privacy-safe context and restores display names', async () => {
  const requestBodies = [];
  const input = buildFamilySalesReviewInput({
    family: { id: 1, familyName: '张三家庭', coreMemberId: 10, status: 'active', notes: '张三身份证110101198606141234仅本地核验' },
    members: [
      { id: 10, familyId: 1, name: '张三', relationLabel: '本人', relationToCore: 'self', role: 'core', birthday: '1986-06-14', idNumber: '110101198606141234', status: 'active' },
      { id: 11, familyId: 1, name: '李四', relationLabel: '配偶', relationToCore: 'spouse', role: 'adult', birthday: '1988-12-01', identityNumber: '110101198812016543', status: 'active' },
    ],
    policies: [{
      id: 101,
      familyId: 1,
      company: '新华保险',
      name: '测试保单',
      applicantMemberId: 10,
      applicantMemberName: '张三',
      insuredMemberId: 11,
      insuredMemberName: '李四',
      insuredIdNumber: '110101198812016543',
    }],
    generatedAt: '2026-06-15T00:00:00.000Z',
  });
  const context = {
    sourceUpdated: true,
    familyInput: input,
    latestSalesReview: {
      id: 9,
      content: '建议先联系{{member_1}}，再补充{{member_2}}资料。',
    },
  };
  const prompt = buildFamilySalesChatMessages({
    context,
    history: [{ role: 'user', content: '客户说预算不够怎么办？', createdAt: '2026-06-15T00:01:00.000Z' }],
    question: '帮我改成微信话术',
  }).map((message) => message.content).join('\n');

  assert.match(prompt, /你是一名保险营销专家/u);
  assert.match(prompt, /只能回答“我是保险营销专家/u);
  assert.match(prompt, /sourceUpdated=true/);
  assert.match(prompt, /客户说预算不够怎么办/);
  assert.match(prompt, /帮我改成微信话术/);
  assert.doesNotMatch(prompt, /张三|李四|张三家庭|110101198606141234|110101198812016543/);
  assert.match(prompt, /\{\{member_1\}\}/);
  assert.match(prompt, /\{\{id_number_1\}\}/);

  const reply = await generateFamilySalesChatReply({
    context,
    history: [{ role: 'user', content: '客户说预算不够怎么办？', createdAt: '2026-06-15T00:01:00.000Z' }],
    question: '帮我改成微信话术',
    env: {
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: 'https://deepseek.test',
    },
    fetchImpl: async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      requestBodies.push(body);
      return {
        ok: true,
        json: async () => ({
          model: body.max_tokens === 300 ? 'deepseek-v4-flash' : 'deepseek-v4-pro',
          choices: [{
            message: {
              content: body.max_tokens === 300
                ? JSON.stringify({ intent: 'sales_script', skills: ['sales_script', 'objection_handling'], reason: '微信话术' })
                : '我是DeepSeek大模型，可以对{{member_1}}说：“我们先核实预算，再拆基础方案。” {{id_number_1}}',
            },
          }],
        }),
      };
    },
  });

  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0].model, 'deepseek-v4-flash');
  assert.match(JSON.stringify(requestBodies[0]), /sales_script/);
  assert.equal(requestBodies[1].model, 'deepseek-v4-pro');
  assert.deepEqual(requestBodies[1].thinking, { type: 'enabled' });
  assert.match(JSON.stringify(requestBodies[1]), /智能 skill router 选择/);
  assert.match(JSON.stringify(requestBodies[1]), /客户异议处理/);
  assert.doesNotMatch(JSON.stringify(requestBodies[1]), /张三|李四|张三家庭|110101198606141234|110101198812016543/);
  assert.match(reply.content, /保险营销专家/);
  assert.match(reply.content, /张三/);
  assert.match(reply.content, /身份证号已脱敏/);
  assert.doesNotMatch(reply.content, /DeepSeek|deepseek|大模型/u);
  assert.doesNotMatch(reply.content, /\{\{member_1\}\}|\{\{id_number_1\}\}|110101198606141234/);
});

test('sales topic selection keeps generic script requests free of insurance detail', () => {
  assert.equal(selectSalesTopicPack('帮我改成微信话术', {
    members: [{ id: 11, name: '孩子', relationLabel: '女儿' }],
    policies: [{ id: 21, insuredMemberId: 11, name: '少儿意外险', category: '意外险' }],
  }), null);
});

test('sales topic selection scopes child accident question to matching member coverage', () => {
  const topicPack = selectSalesTopicPack('孩子的意外险怎么聊', {
    members: [{ id: 10, name: '爸爸', relationLabel: '本人' }, { id: 11, name: '孩子', relationLabel: '女儿' }],
    policies: [
      { id: 20, insuredMemberId: 10, name: '成人重疾险', category: '重疾险' },
      { id: 21, insuredMemberId: 11, name: '少儿意外险', category: '意外险' },
    ],
  });
  assert.deepEqual(topicPack, { type: 'member_coverage', memberRefs: ['member:11'], policyRefs: ['policy:21'], category: '意外险' });
});

test('sales topic selection uses recent explicit policy for renewal indicators', () => {
  const topicPack = selectSalesTopicPack('这张医疗险续保怎么样', {
    members: [{ id: 11, name: '孩子', relationLabel: '女儿' }],
    policies: [{ id: 21, insuredMemberId: 11, name: '安心医疗险', category: '医疗险' }],
    lastExplicitTarget: { policyRef: 'policy:21' },
  });
  assert.deepEqual(topicPack, { type: 'policy_indicators', memberRefs: ['member:11'], policyRefs: ['policy:21'], category: '医疗险' });
});

test('sales topic selection does not expand an ambiguous category to multiple policies', () => {
  const topicPack = selectSalesTopicPack('医疗险续保怎么样', {
    members: [{ id: 10, relationLabel: '本人' }, { id: 11, relationLabel: '女儿' }],
    policies: [
      { id: 20, insuredMemberId: 10, name: '成人医疗险', category: '医疗险' },
      { id: 21, insuredMemberId: 11, name: '少儿医疗险', category: '医疗险' },
    ],
  });
  assert.equal(topicPack, null);
});

test('explicit member rejects a conflicting fallback policy', () => {
  const topicPack = selectSalesTopicPack('孩子的医疗险怎么聊', {
    members: [{ id: 10, relationLabel: '爸爸' }, { id: 11, relationLabel: '孩子' }],
    policies: [{ id: 20, insuredMemberId: 10, name: '爸爸医疗险', category: '医疗险' }, { id: 21, insuredMemberId: 11, name: '孩子医疗险', category: '医疗险' }],
    lastExplicitTarget: { policyRef: 'policy:20' },
  });
  assert.deepEqual(topicPack, { type: 'member_coverage', memberRefs: ['member:11'], policyRefs: ['policy:21'], category: '医疗险' });
});

test('explicit product overrides a conflicting fallback policy', () => {
  const topicPack = selectSalesTopicPack('爸爸医疗险续保情况', {
    members: [{ id: 10, relationLabel: '爸爸' }, { id: 11, relationLabel: '孩子' }],
    policies: [{ id: 20, insuredMemberId: 10, name: '爸爸医疗险', category: '医疗险' }, { id: 21, insuredMemberId: 11, name: '孩子医疗险', category: '医疗险' }],
    lastExplicitTarget: { policyRef: 'policy:21' },
  });
  assert.deepEqual(topicPack, { type: 'policy_indicators', memberRefs: ['member:10'], policyRefs: ['policy:20'], category: '医疗险' });
});

test('category matching prefers增额终身寿险 over generic寿险', () => {
  const topicPack = selectSalesTopicPack('这张增额终身寿险现金价值怎么样', {
    members: [{ id: 10, relationLabel: '本人' }],
    policies: [{ id: 20, insuredMemberId: 10, name: '增额终身寿险', category: '增额终身寿险' }],
  });
  assert.equal(topicPack.category, '增额终身寿险');
});

test('duplicate child relations are ambiguous and short labels do not substring match', () => {
  const duplicate = resolveSalesTopicPack('孩子的意外险', {
    members: [{ id: 11, relationLabel: '孩子' }, { id: 12, relationLabel: '孩子' }],
    policies: [{ id: 21, insuredMemberId: 11, name: '大宝意外险' }, { id: 22, insuredMemberId: 12, name: '二宝意外险' }],
  });
  assert.equal(duplicate.ambiguous, true);
  assert.equal(duplicate.topicPack, null);
  assert.equal(selectSalesTopicPack('意外险怎么聊', { members: [{ id: 11, relationLabel: '女' }, { id: 12, relationLabel: '本人' }], policies: [{ id: 21, insuredMemberId: 11, name: '意外险A' }, { id: 22, insuredMemberId: 12, name: '意外险B' }] }), null);
});

test('ambiguous category resolution forces clarification without relying on question wording', () => {
  const resolution = resolveSalesTopicPack('医疗险续保情况', {
    members: [{ id: 10, relationLabel: '爸爸' }, { id: 11, relationLabel: '孩子' }],
    policies: [{ id: 20, insuredMemberId: 10, name: '爸爸医疗险', category: '医疗险' }, { id: 21, insuredMemberId: 11, name: '孩子医疗险', category: '医疗险' }],
  });
  assert.equal(resolution.topicPack, null);
  assert.equal(resolution.ambiguous, true);
  const context = buildLightweightSalesChatContext({ question: '医疗险续保情况', topicPack: resolution.topicPack, topicResolution: resolution });
  assert.equal(context.clarificationNeeded, true);
});

test('topic packs project bounded indicators and responsibility evidence', () => {
  const policies = [{ id: 21, insuredMemberId: 11, name: '少儿医疗险', category: '医疗险', validityStatus: '有效', renewalType: '保证续保20年', waitingPeriod: '30天', evidence: '全文不得带入' }];
  const expertReport = { structuredResult: {
    summary: '摘要',
    priorityFindings: [], memberFindings: [], confirmedFacts: [], verificationItems: [],
    policyIndicators: [{ policyRef: 'policy:21', indicator: '保证续保', status: 'confirmed', source: '条款第3页' }, { policyRef: 'policy:99', indicator: '无关' }],
    responsibilityFindings: [{ policyRef: 'policy:21', responsibility: '住院医疗', evidenceStatus: 'identified', evidenceRef: 'evidence:1' }],
  } };
  const indicatorContext = buildLightweightSalesChatContext({ question: '这张医疗险续保怎么样', topicPack: { type: 'policy_indicators', memberRefs: ['member:11'], policyRefs: ['policy:21'], category: '医疗险' }, policies, expertReport });
  assert.ok(indicatorContext.topicData.policyIndicators.length <= 8);
  assert.equal(indicatorContext.topicData.absenceMessage, null);
  assert.match(JSON.stringify(indicatorContext.topicData), /保证续保20年|条款第3页/u);
  assert.doesNotMatch(JSON.stringify(indicatorContext), /全文不得带入|policy:99/u);
  const evidenceContext = buildLightweightSalesChatContext({ question: '这张医疗险住院责任怎么赔', topicPack: { type: 'responsibility_evidence', memberRefs: ['member:11'], policyRefs: ['policy:21'], category: '医疗险' }, policies, expertReport });
  assert.equal(evidenceContext.topicData.responsibilityEvidence.length, 1);
  assert.equal(evidenceContext.topicData.responsibilityEvidence[0].evidenceStatus, 'identified');
  const missingEvidence = buildLightweightSalesChatContext({ question: '责任呢', topicPack: { type: 'responsibility_evidence', memberRefs: ['member:11'], policyRefs: ['policy:21'], category: '医疗险' }, policies });
  assert.equal(missingEvidence.topicData.absenceMessage, '暂按未配置关注，需核对合同');
  const financeContext = buildLightweightSalesChatContext({ question: '预算怎么安排', topicPack: { type: 'family_finance', memberRefs: [], policyRefs: [], category: null }, financeSummary: { annualIncome: 300000, annualExpense: 150000, debt: 500000, privateNote: '不得带入' } });
  assert.deepEqual(financeContext.topicData.finance, { annualIncome: 300000, annualExpense: 150000, debt: 500000 });
  assert.doesNotMatch(JSON.stringify(financeContext), /不得带入|privateNote/u);
});

test('expert indicator projection drops unknown evidence PII and long fields', () => {
  const context = buildLightweightSalesChatContext({
    question: '这张医疗险续保怎么样',
    topicPack: { type: 'policy_indicators', memberRefs: ['member:11'], policyRefs: ['policy:21'], category: '医疗险' },
    policies: [{ id: 21, insuredMemberId: 11, name: '少儿医疗险', category: '医疗险' }],
    expertReport: { structuredResult: { policyIndicators: [{
      id: 'indicator:1', policyRef: 'policy:21', label: '保证续保', status: 'confirmed', sourceKind: 'policy_clause',
      evidence: '完整证据不得进入', sourceExcerpt: '条款全文不得进入', markdown: '# 报告不得进入', phone: '13800138000', unknown: '未知字段', method: '合同核对'.repeat(200),
    }] } },
  });
  const json = JSON.stringify(context);
  assert.match(json, /indicator:1|保证续保|policy_clause/u);
  assert.doesNotMatch(json, /完整证据|条款全文|报告不得|13800138000|未知字段|unknown|sourceExcerpt|markdown/u);
  assert.ok(context.topicData.policyIndicators.find((item) => item.id === 'indicator:1').method.length <= 120);
});

test('sales summary and expert findings are projected, PII-safe, and context is hard bounded', () => {
  const malicious = '13800138000 '.repeat(1000);
  const history = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `历史${index}${'很长'.repeat(500)}`, createdAt: `2026-07-01T00:${String(index).padStart(2, '0')}:00.000Z` }));
  const context = buildLightweightSalesChatContext({
    question: '孩子的意外险怎么聊',
    topicPack: { type: 'member_coverage', memberRefs: ['member:11'], policyRefs: ['policy:21'], category: '意外险' },
    salesReview: { structuredSummary: { conclusion: `关键结论${'结论'.repeat(5000)}`, phone: '13800138000', unknownDetail: malicious, nextActions: Array(30).fill('行动'.repeat(300)), refs: { policies: Array(30).fill('policy:21'), secret: malicious } } },
    expertReport: { structuredResult: { summary: `专家摘要${'摘要'.repeat(5000)}`, memberFindings: Array(30).fill({ memberRef: 'member:11', label: '意外缺口', detail: malicious, phone: '13800138000' }) } },
    memories: { memories: Array(30).fill({ status: 'confirmed', isCurrent: true, content: '记忆'.repeat(500) }) },
    history,
  });
  const json = JSON.stringify(context);
  assert.ok(json.length <= 12_000, `context length ${json.length}`);
  assert.match(json, /关键结论/u);
  assert.doesNotMatch(json, /13800138000|unknownDetail|phone|secret/u);
  assert.ok(context.telemetry.truncatedSections.length > 0);
});

test('finance indexes targets and topic descriptor cannot bypass the context limit', () => {
  const huge = '超长恶意字段'.repeat(10_000);
  const context = buildLightweightSalesChatContext({
    question: `预算安排${huge}`,
    topicPack: { type: 'family_finance', memberRefs: Array(100).fill(`member:${huge}`), policyRefs: Array(100).fill(`policy:${huge}`), category: huge, unknown: huge },
    financeSummary: { annualIncome: 300000, cashflowConclusion: huge, availableAssets: Array(100).fill(huge), unknown: huge },
    members: Array.from({ length: 100 }, (_, id) => ({ id, relationLabel: huge, role: huge, age: huge })),
    policies: Array.from({ length: 100 }, (_, id) => ({ id, insuredMemberId: id, name: huge, category: huge, validityStatus: huge })),
    conversationTargets: { lastExplicitTarget: { policyRef: huge, memberRef: huge, category: huge, label: huge, unknown: huge }, activeOpportunity: { policyRef: huge, unknown: huge }, unknown: huge },
  });
  const json = JSON.stringify(context);
  assert.ok(json.length <= 12_000, `context length ${json.length}`);
  assert.doesNotMatch(json, /unknown/u);
  assert.ok(context.question.length <= 2_000);
  assert.ok(context.telemetry.truncatedSections.length > 0);
});

test('lightweight context excludes candidate and completed memories but preserves current status', () => {
  const context = buildLightweightSalesChatContext({
    question: '怎么继续聊',
    memories: { memories: [
      { content: '已确认预算', status: 'confirmed', isCurrent: true },
      { content: '候选偏好', status: 'candidate', isCurrent: false },
      { content: '已拒绝偏好', status: 'rejected', isCurrent: false },
      { content: '已过期偏好', status: 'expired', isCurrent: false },
      { content: '已完成待办', status: 'completed', isCurrent: false },
      { content: '过期确认', status: 'confirmed', isCurrent: true, validTo: '2020-01-01T00:00:00.000Z' },
      { content: '空状态', status: '', isCurrent: true },
    ] },
  });
  assert.deepEqual(context.salesMemoryContext.map((item) => item.content), ['已确认预算']);
  assert.equal(context.salesMemoryContext[0].status, 'confirmed');
  assert.equal(context.salesMemoryContext[0].isCurrent, true);
});

test('conversation targets prefer recent explicit target and retain structured active opportunity', () => {
  const targets = deriveSalesConversationTargets({
    salesReview: { structuredSummary: { refs: { policies: ['policy:21'] } } },
    history: [{ role: 'user', content: '先聊孩子的少儿意外险', createdAt: '2026-07-01T00:00:00.000Z' }],
    members: [{ id: 11, relationLabel: '孩子' }],
    policies: [{ id: 21, insuredMemberId: 11, name: '少儿意外险', category: '意外险' }],
  });
  assert.deepEqual(targets.lastExplicitTarget, { policyRef: 'policy:21', memberRef: 'member:11', category: '意外险' });
  assert.deepEqual(targets.activeOpportunity, { policyRef: 'policy:21' });
});

test('sales chat prompt states the two evidence absence levels', () => {
  const prompt = buildFamilySalesChatMessages({ context: { clarificationNeeded: true }, question: '责任怎么样' }).map((message) => message.content).join('\n');
  assert.match(prompt, /当前已录入保单中未发现/u);
  assert.match(prompt, /暂按未配置关注，需核对合同/u);
  assert.match(prompt, /禁止写.*客户确认没有/u);
});

test('lightweight sales context asks for clarification without falling back to family detail', () => {
  const context = buildLightweightSalesChatContext({
    salesReview: { structuredSummary: { conclusion: '先补齐医疗保障' }, content: '完整销售 Markdown 不应出现' },
    expertReport: { structuredResult: { summary: '专家摘要', memberFindings: [{ memberRef: 'member:11', detail: '孩子细节' }] }, markdownContent: '完整专家 Markdown 不应出现' },
    question: '这份方案怎么样',
    topicPack: null,
  });
  assert.equal(context.clarificationNeeded, true);
  assert.equal(context.topicPack, null);
  const json = JSON.stringify(context);
  assert.doesNotMatch(json, /孩子细节|完整销售 Markdown|完整专家 Markdown/u);
});

test('lightweight sales context is at least sixty percent smaller and excludes unrelated member detail', () => {
  const members = [{ id: 10, name: '爸爸', relationLabel: '本人', notes: '爸爸'.repeat(800) }, { id: 11, name: '孩子', relationLabel: '女儿', notes: '孩子'.repeat(800) }];
  const policies = [{ id: 20, insuredMemberId: 10, name: '成人重疾险', category: '重疾险', evidence: '无关'.repeat(1200) }, { id: 21, insuredMemberId: 11, name: '少儿意外险', category: '意外险', evidence: '相关'.repeat(1200) }];
  const fullContext = buildFamilySalesChatContext({
    input: { members, policies }, family: { id: 1 }, members, policies,
    familySalesReviews: [{ id: 1, familyId: 1, status: 'active', content: '完整报告'.repeat(1500), generatedAt: '2026-07-01T00:00:00.000Z' }],
  });
  const topicPack = selectSalesTopicPack('孩子的意外险怎么聊', { members, policies });
  const context = buildLightweightSalesChatContext({ salesReview: { structuredSummary: { conclusion: '先聊意外保障' } }, question: '孩子的意外险怎么聊', topicPack, members, policies });
  const json = JSON.stringify(context);
  assert.ok(json.length <= JSON.stringify(fullContext).length * 0.4);
  assert.doesNotMatch(json, /成人重疾险|爸爸爸爸|无关无关/u);
  assert.equal(context.minimalIndexes.members.length, 1);
  assert.equal(context.minimalIndexes.policies.length, 1);
});

test('family sales chat answers identity questions as insurance marketing expert without upstream model', async () => {
  let fetchCalled = false;
  const reply = await generateFamilySalesChatReply({
    question: '你是谁？你是什么大模型，是DeepSeek吗？',
    env: {},
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called');
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(reply.model, 'identity_guard');
  assert.match(reply.content, /^我是保险营销专家/u);
  assert.doesNotMatch(reply.content, /DeepSeek|deepseek|大模型/u);
});

test('family sales chat corrects a product comparison cashflow amount from the verified ledger', async () => {
  const familyInput = buildFamilySalesReviewInput({
    family: { id: 1, status: 'active' },
    policies: [{
      id: 101,
      name: '测试两全险',
      cashflowEntries: [{ year: 2052, amount: 200000, liability: '满期保险金' }],
    }],
  });
  let callCount = 0;
  const reply = await generateFamilySalesChatReply({
    context: { familyInput },
    question: '帮我对比这份计划书和现有保单',
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async () => {
      callCount += 1;
      return {
        ok: true,
        json: async () => ({
          model: callCount === 1 ? 'deepseek-v4-flash' : 'deepseek-v4-pro',
          choices: [{ message: { content: callCount === 1
            ? JSON.stringify({ intent: 'product_comparison', skills: ['product_comparison', 'policy_evidence'], reason: '产品对比' })
            : '现有保单在2052年确定给付 2 万元。' } }],
        }),
      };
    },
  });

  assert.match(reply.content, /2052年确定给付 20万元/u);
  assert.doesNotMatch(reply.content, /2052年确定给付 2 万元/u);
});

test('family sales memory context is sanitized, deduplicated, and available to chat and review prompts', () => {
  const normalized = normalizeExtractedFamilySalesMemories({
    memories: [
      { kind: 'objection', memoryKey: 'budget_objection', content: '客户担心预算压力，手机号 13800138000 不要保存', confidence: 0.91 },
      { kind: 'objection', memoryKey: 'budget_objection', content: '客户担心预算压力，手机号 13800138000 不要保存', confidence: 0.9 },
      { kind: 'strategy', content: '先讲基础方案，再约二次面谈', confidence: 0.83 },
      { kind: 'noise', content: '无效类型', confidence: 1 },
      { kind: 'todo', content: '置信度太低的不保存', confidence: 0.3 },
    ],
  });
  assert.deepEqual(normalized.map((memory) => memory.kind), ['objection', 'strategy']);
  assert.match(normalized[0].content, /手机号已脱敏/u);
  assert.doesNotMatch(normalized[0].content, /13800138000/u);

  const state = { familySalesMemories: [], nextId: 100 };
  const result = upsertFamilySalesMemories({
    state,
    familyId: 8,
    owner: { ownerGuestId: 'guest-memory' },
    sourceThreadId: 30,
    userMessage: { id: 31 },
    assistantMessage: { id: 32 },
    extractedMemories: normalized,
    allocateId: (target) => {
      const id = target.nextId;
      target.nextId += 1;
      return id;
    },
    nowIso: () => '2026-06-15T08:00:00.000Z',
  });
  assert.equal(result.changed, true);
  assert.equal(state.familySalesMemories.length, 2);
  assert.deepEqual(state.familySalesMemories[0].evidenceMessageIds, [31]);
  assert.equal(state.familySalesMemories[0].status, 'confirmed');
  assert.equal(state.familySalesMemories[1].status, 'candidate');

  const salesMemoryContext = buildFamilySalesMemoryContext(state.familySalesMemories);
  const chatPrompt = buildFamilySalesChatMessages({
    context: {
      familyInput: {},
      salesMemoryContext,
    },
    question: '继续生成微信话术',
  }).map((message) => message.content).join('\n');
  assert.match(chatPrompt, /salesMemoryContext/u);
  assert.match(chatPrompt, /客户担心预算压力/u);
  assert.match(chatPrompt, /保单事实、责任条款、金额、收益仍以当前家庭数据和官网证据为准/u);

  const reviewPrompt = buildFamilySalesReviewMessages({
    family: {},
    members: [],
    policies: [],
    report: {},
    officialEvidence: [],
    dataQuality: {},
    salesMemoryContext,
    salesChatContext: { selectedMessageCount: 1, recentMessages: [{ role: 'user', content: '本次勾选优先' }] },
  }).map((message) => message.content).join('\n');
  assert.match(reviewPrompt, /salesMemoryContext/u);
  assert.match(reviewPrompt, /salesChatContext 与 salesMemoryContext 同时存在，顾问本次勾选的 salesChatContext 优先/u);
});

test('family sales memory marks same-slot changes as conflicts and excludes them from context', () => {
  const state = { familySalesMemories: [], nextId: 200 };
  const allocateId = (target) => target.nextId++;
  upsertFamilySalesMemories({
    state,
    familyId: 8,
    owner: { ownerGuestId: 'guest-memory' },
    sourceThreadId: 30,
    userMessage: { id: 41 },
    assistantMessage: { id: 42 },
    extractedMemories: [{
      kind: 'preference',
      memoryKey: 'plan_display_order',
      content: '客户希望先看基础方案',
      normalizedValue: '基础方案优先',
      confidence: 0.92,
    }],
    allocateId,
    nowIso: () => '2026-07-10T08:00:00.000Z',
  });
  upsertFamilySalesMemories({
    state,
    familyId: 8,
    owner: { ownerGuestId: 'guest-memory' },
    sourceThreadId: 30,
    userMessage: { id: 43 },
    assistantMessage: { id: 44 },
    extractedMemories: [{
      kind: 'preference',
      memoryKey: 'plan_display_order',
      content: '客户改为先比较标准方案和完善方案',
      normalizedValue: '标准与完善方案优先',
      confidence: 0.95,
    }],
    allocateId,
    nowIso: () => '2026-07-11T08:00:00.000Z',
  });

  assert.deepEqual(state.familySalesMemories.map((memory) => memory.status), ['conflicted', 'conflicted']);
  assert.deepEqual(state.familySalesMemories.map((memory) => memory.evidenceMessageIds), [[41], [43]]);
  assert.equal(buildFamilySalesMemoryContext(state.familySalesMemories), null);
});

test('family sales memory context accepts legacy active rows but filters invalidated and future memories', () => {
  const context = buildFamilySalesMemoryContext([
    { id: 1, kind: 'objection', content: '旧数据仍可使用', status: 'active', createdAt: '2026-07-01T00:00:00.000Z' },
    { id: 2, kind: 'todo', content: '已经失效', status: 'confirmed', invalidatedAt: '2026-07-05T00:00:00.000Z' },
    { id: 3, kind: 'preference', content: '未来才生效', status: 'confirmed', validFrom: '2026-08-01T00:00:00.000Z' },
  ], { asOf: '2026-07-11T00:00:00.000Z' });

  assert.equal(context.memoryCount, 1);
  assert.equal(context.memories[0].content, '旧数据仍可使用');
  assert.equal(context.memories[0].status, 'active');
  assert.equal(context.memories[0].isCurrent, true);
});

test('family sales review appends expanded plans and scripts when the model compresses them', async () => {
  const input = buildFamilySalesReviewInput({
    family: { id: 1, familyName: '张三家庭', coreMemberId: 10, status: 'active' },
    members: [
      { id: 10, familyId: 1, name: '张三', relationLabel: '本人', relationToCore: 'self', role: 'core', birthday: '1986-06-14', status: 'active' },
      { id: 11, familyId: 1, name: '李四', relationLabel: '配偶', relationToCore: 'spouse', role: 'adult', birthday: '1988-12-01', status: 'active' },
    ],
    policies: [{
      id: 101,
      familyId: 1,
      company: '新华保险',
      name: '增额终身寿示例',
      applicantMemberId: 10,
      insuredMemberId: 10,
      amount: 300000,
      firstPremium: 20000,
      coveragePeriod: '终身',
      paymentPeriod: '10年',
    }],
    generatedAt: '2026-06-15T00:00:00.000Z',
  });
  const review = await generateFamilySalesReview({
    input,
    env: {
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: 'https://deepseek.test',
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        model: 'deepseek-v4-pro',
        choices: [{
          message: {
            content: [
              '## 六、下一步销售动作清单',
              '- 方案一：先做百万医疗险。',
              '- 方案二：给{{member_1}}补重疾险。',
              '- 3.【邀约面谈 - 切入点顺序】',
              '- 见面开场：总结已有保单。',
            ].join('\n'),
          },
        }],
      }),
    }),
  });

  assert.match(review.content, /销售方案展开/);
  assert.match(review.content, /适合对象/);
  assert.match(review.content, /客户痛点/);
  assert.match(review.content, /预算\/保额口径/);
  assert.match(review.content, /需补资料/);
  assert.match(review.content, /邀约面谈与销售话术/);
  assert.match(review.content, /“我这次不是来推某一款产品/);
  assert.match(review.content, /已经买过很多保险/);
  assert.match(review.content, /暂时不想增加预算/);
  assert.match(review.content, /理财险收益不确定/);
  assert.match(review.content, /张三/);
  assert.match(review.content, /李四/);
  assert.doesNotMatch(review.content, /\{\{member_1\}\}|\{\{member_2\}\}/);
});

test('family sales review backfills empty member gap and product sections', async () => {
  const input = buildFamilySalesReviewInput({
    family: { id: 1, familyName: '张三家庭', coreMemberId: 10, status: 'active' },
    members: [
      { id: 10, familyId: 1, name: '张三', relationLabel: '本人', relationToCore: 'self', role: 'core', birthday: '1986-06-14', status: 'active' },
      { id: 11, familyId: 1, name: '李四', relationLabel: '配偶', relationToCore: 'spouse', role: 'adult', birthday: '1988-12-01', status: 'active' },
    ],
    policies: [{
      id: 101,
      familyId: 1,
      company: '新华保险',
      name: '重疾险示例',
      applicantMemberId: 10,
      insuredMemberId: 10,
      amount: 300000,
      firstPremium: 12000,
      coveragePeriod: '终身',
      coverageIndicators: [{ coverageType: '重大疾病', liability: '重大疾病保险金' }],
    }],
    generatedAt: '2026-06-15T00:00:00.000Z',
  });

  const review = await generateFamilySalesReview({
    input,
    env: {
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: 'https://deepseek.test',
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        model: 'deepseek-v4-pro',
        choices: [{
          message: {
            content: [
              '## 一、销售结论摘要',
              '- 先核实家庭资料。',
              '## 三、成员级保障缺口',
              '-',
              '## 五、已有产品逐项切入建议',
              '暂无明确结论',
            ].join('\n'),
          },
        }],
      }),
    }),
  });

  assert.match(review.content, /成员级保障缺口/);
  assert.match(review.content, /李四（配偶）.*系统内暂未关联保单/u);
  assert.match(review.content, /已有产品逐项切入建议/);
  assert.match(review.content, /新华保险 重疾险示例/);
  assert.match(review.content, /重大疾病/);
  assert.doesNotMatch(review.content, /\{\{member_1\}\}|\{\{member_2\}\}/);
});
