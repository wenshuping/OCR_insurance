const RADAR_DIMENSIONS = [
  { key: 'critical', label: '重疾' },
  { key: 'accident', label: '意外' },
  { key: 'medical', label: '医疗' },
  { key: 'life', label: '寿险' },
  { key: 'wealth', label: '财富' },
];
const TRUSTED_CORRECTION_STATUSES = new Set(['auto_applied', 'accepted']);
const AUTO_APPLY_ACTIONS = new Set(['exclude_amount', 'mark_unquantifiable', 'replace_amount', 'override_cashflow']);
const AUTO_APPLY_DIMENSIONS = new Set(['critical', 'accident', 'medical', 'life', 'wealth']);
export const FAMILY_REPORT_ENGINE_VERSION = 4;

const CRITICAL_ROWS = [
  { key: 'critical_multiple', label: '重疾多次给付' },
  { key: 'critical_first', label: '重疾首次给付' },
  { key: 'moderate', label: '中症给付' },
  { key: 'mild', label: '轻症给付' },
  { key: 'specific_disease', label: '特定疾病/少儿特疾/癌症' },
  { key: 'terminal', label: '疾病终末期' },
  { key: 'death_disability', label: '身故/全残' },
  { key: 'waiver', label: '保费豁免' },
];

const ACCIDENT_ROWS = [
  { key: 'general_accident', label: '一般意外身故/全残' },
  { key: 'accident_disability', label: '意外伤残' },
  { key: 'accident_medical', label: '意外医疗' },
  { key: 'traffic', label: '交通意外' },
  { key: 'driving', label: '自驾/驾乘' },
  { key: 'public_transport', label: '公共交通' },
  { key: 'aviation', label: '航空意外' },
  { key: 'rail_ship', label: '轨道/轮船' },
  { key: 'sudden_death', label: '猝死' },
  { key: 'hospital_allowance', label: '住院津贴' },
];

function trim(value) {
  return String(value || '').trim();
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function finiteNumber(value) {
  if (value === null || value === undefined || trim(value) === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteNumberAllowZero(value) {
  if (value === null || value === undefined || trim(value) === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampConfidence(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.max(0, Math.min(1, number));
}

function activeRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter((row) => String(row?.status || 'active') === 'active');
}

function memberKey(member = {}) {
  const id = Number(member.id || 0);
  return id > 0 ? `member:${id}` : `name:${trim(member.name) || '未命名成员'}`;
}

function memberDisplay(member = {}) {
  return {
    memberKey: memberKey(member),
    memberId: Number(member.id || 0) || null,
    member: trim(member.name) || '未命名成员',
    relationLabel: trim(member.relationLabel) || '待确认',
  };
}

function roleFromMember(member = {}) {
  const role = trim(member.role);
  if (['adult', 'child', 'elder'].includes(role)) return role;
  const relation = `${trim(member.relationToCore)} ${trim(member.relationLabel)}`;
  if (/(儿子|女儿|子女|孩子|孙|外孙|child|son|daughter)/iu.test(relation)) return 'child';
  if (/(父|母|爷|奶|外公|外婆|grand|parent|elder)/iu.test(relation)) return 'elder';
  return 'adult';
}

function roleLabel(role) {
  if (role === 'child') return '子女';
  if (role === 'elder') return '长辈';
  return '成人';
}

function emptyProtectionRow(definition) {
  return {
    key: definition.key,
    label: definition.label,
    amount: 0,
    amountText: '未识别',
    countText: '-',
    status: 'missing',
    conditionText: '未识别到该责任',
    sourcePolicies: [],
  };
}

function emptyProtectionMember(member, definitions, attentionItems) {
  return {
    ...memberDisplay(member),
    rows: definitions.map(emptyProtectionRow),
    attentionItems,
  };
}

function emptyRadarScore(dimension) {
  return {
    key: dimension.key,
    label: dimension.label,
    amount: 0,
    effectiveAmount: 0,
    coveragePresent: false,
    score: 0,
    amountText: '0元',
    effectiveAmountText: '0元',
    policyCount: 0,
    note: `无${dimension.label}保障`,
    amountDetails: [],
  };
}

function emptyRadarMember(member) {
  const role = roleFromMember(member);
  return {
    memberKey: memberKey(member),
    memberId: Number(member.id || 0) || null,
    name: trim(member.name) || '未命名成员',
    relationLabel: trim(member.relationLabel) || '待确认',
    role,
    roleLabel: roleLabel(role),
    scores: RADAR_DIMENSIONS.map(emptyRadarScore),
    totalAmount: 0,
    notes: ['全维度保障缺失'],
  };
}

function addMissingMemberReports(report, members = [], policies = []) {
  const activeMembers = activeRows(members);
  if (!activeMembers.length) return report;

  const policyMemberIds = new Set((Array.isArray(policies) ? policies : [])
    .map((policy) => Number(policy?.insuredMemberId || 0))
    .filter((id) => id > 0));
  const existingMemberKeys = new Set([
    ...(report.criticalIllness?.members || []).map((member) => member.memberKey || (member.memberId ? `member:${member.memberId}` : `name:${member.member}`)),
    ...(report.radar?.members || []).map((member) => member.memberKey || (member.memberId ? `member:${member.memberId}` : `name:${member.name}`)),
    ...(report.radar?.hiddenMembers || []).map((member) => member.memberKey || (member.memberId ? `member:${member.memberId}` : `name:${member.name}`)),
  ]);

  const missingMembers = activeMembers.filter((member) => !existingMemberKeys.has(memberKey(member)));
  if (!missingMembers.length) {
    report.summary = {
      ...(report.summary || {}),
      memberCount: activeMembers.length,
    };
    return report;
  }

  report.summary = {
    ...(report.summary || {}),
    memberCount: activeMembers.length,
  };

  report.criticalIllness = {
    ...(report.criticalIllness || {}),
    members: [
      ...(report.criticalIllness?.members || []),
      ...missingMembers.map((member) => emptyProtectionMember(member, CRITICAL_ROWS, ['无任何重疾保障'])),
    ],
  };
  report.accident = {
    ...(report.accident || {}),
    members: [
      ...(report.accident?.members || []),
      ...missingMembers.map((member) => emptyProtectionMember(member, ACCIDENT_ROWS, ['无任何意外保障'])),
    ],
  };
  report.wealth = {
    ...(report.wealth || {}),
    memberReports: [
      ...(report.wealth?.memberReports || []),
      ...missingMembers.map((member) => ({
        ...memberDisplay(member),
        policies: [],
        attentionItems: ['无储蓄/理财型保单，未形成确定现金流'],
      })),
    ],
  };

  const radarMembers = [...(report.radar?.members || [])];
  const hiddenMembers = [...(report.radar?.hiddenMembers || [])];
  for (const member of missingMembers) {
    const series = emptyRadarMember(member);
    if (radarMembers.length < 4 || policyMemberIds.has(Number(member.id || 0))) {
      radarMembers.push(series);
    } else {
      hiddenMembers.push(series);
    }
  }
  report.radar = {
    ...(report.radar || {}),
    dimensions: report.radar?.dimensions || RADAR_DIMENSIONS,
    members: radarMembers,
    hiddenMembers,
  };

  return report;
}

function pushIssue(issues, input) {
  issues.push({
    severity: input.severity || 'warning',
    category: input.category || 'report_quality',
    title: trim(input.title),
    detail: trim(input.detail),
    suggestion: trim(input.suggestion),
    source: input.source || 'rule',
    memberId: input.memberId ?? null,
    memberName: trim(input.memberName),
    policyId: input.policyId ?? null,
    productName: trim(input.productName),
    dimension: trim(input.dimension),
  });
}

function buildReportIssues({ family, members = [], policies = [], report = {} } = {}) {
  const issues = [];
  const policyMemberIds = new Set((Array.isArray(policies) ? policies : [])
    .map((policy) => Number(policy?.insuredMemberId || 0))
    .filter((id) => id > 0));

  for (const member of activeRows(members)) {
    if (policyMemberIds.has(Number(member.id || 0))) continue;
    pushIssue(issues, {
      severity: 'warning',
      category: 'coverage_gap',
      title: '家庭成员未绑定保单',
      detail: `${trim(member.name) || '未命名成员'}在${trim(family?.familyName) || '当前家庭'}中暂无保单，家庭报告已按缺口展示。`,
      suggestion: '核实该成员是否确实没有保单；如有保单，请上传或绑定到该家庭成员。',
      memberId: Number(member.id || 0) || null,
      memberName: member.name,
    });
  }

  for (const member of [...(report.radar?.members || []), ...(report.radar?.hiddenMembers || [])]) {
    for (const score of Array.isArray(member.scores) ? member.scores : []) {
      if (score.coveragePresent !== false) continue;
      pushIssue(issues, {
        severity: 'warning',
        category: 'coverage_gap',
        title: `${score.label}保障缺失`,
        detail: `${member.name || member.member || '家庭成员'}当前未识别到${score.label}保障。`,
        suggestion: '请在后台确认是否为真实缺口；若保单已上传，检查产品责任指标和家庭成员绑定。',
        memberId: member.memberId ?? null,
        memberName: member.name || member.member,
        dimension: score.key,
      });
    }
  }

  for (const gap of Array.isArray(report.optionalResponsibilityGaps) ? report.optionalResponsibilityGaps : []) {
    pushIssue(issues, {
      severity: 'warning',
      category: 'unquantified_optional_responsibility',
      title: '已投保可选责任未量化',
      detail: `${gap.productName || '保单'}的${gap.liability || '可选责任'}未进入量化计算：${gap.quantificationReason || '缺少可计算结构化指标'}`,
      suggestion: '补充官网指标或在后台标记为不可量化，避免报告金额口径误导。',
      policyId: gap.policyId ?? null,
      productName: gap.productName,
    });
  }

  for (const member of Array.isArray(report.wealth?.memberReports) ? report.wealth.memberReports : []) {
    for (const item of Array.isArray(member.attentionItems) ? member.attentionItems : []) {
      pushIssue(issues, {
        severity: 'info',
        category: 'wealth_data_gap',
        title: '财富数据待核实',
        detail: item,
        suggestion: '如需展示现金价值或确定领取现金流，请补充现金价值表或现金流责任指标。',
        memberId: member.memberId ?? null,
        memberName: member.member,
      });
    }
  }

  for (const member of Array.isArray(report.criticalIllness?.members) ? report.criticalIllness.members : []) {
    const criticalFirst = (member.rows || []).find((row) => row.key === 'critical_first');
    if (!criticalFirst || asNumber(criticalFirst.amount) <= 0) continue;
    const sourceAmounts = (criticalFirst.sourcePolicies || []).map((source) => asNumber(source.amount));
    if (!sourceAmounts.length || sourceAmounts.some((amount) => amount > 0)) continue;
    pushIssue(issues, {
      severity: 'error',
      category: 'amount_calculation',
      title: '重疾首次给付金额需复核',
      detail: `${member.member || member.name || '成员'}的重疾首次给付显示为${criticalFirst.amountText || criticalFirst.amount}，但来源责任金额为0或缺少可复核计算结果。`,
      suggestion: '核对官网条款中重疾基础给付与癌症额外给付是否被混算；必要时用 DeepSeek 质检结果修正指标。',
      memberId: member.memberId ?? null,
      memberName: member.member || member.name,
      dimension: 'critical',
    });
  }

  return issues;
}

function comparableRuleIssue(issue = {}) {
  return {
    severity: trim(issue.severity) || 'warning',
    category: trim(issue.category) || 'report_quality',
    title: trim(issue.title),
    detail: trim(issue.detail),
    suggestion: trim(issue.suggestion),
    memberId: Number(issue.memberId || 0) || null,
    memberName: trim(issue.memberName),
    policyId: Number(issue.policyId || 0) || null,
    productName: trim(issue.productName),
    dimension: trim(issue.dimension),
    source: 'rule',
  };
}

function comparableRuleIssueList(issues = []) {
  return (Array.isArray(issues) ? issues : [])
    .map(comparableRuleIssue)
    .filter((issue) => issue.title && issue.detail)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function openIssueCountForReport(state = {}, reportId) {
  const id = Number(reportId || 0);
  return (Array.isArray(state.familyReportIssues) ? state.familyReportIssues : [])
    .filter((issue) => Number(issue.reportId || 0) === id)
    .filter((issue) => String(issue.status || 'open') === 'open')
    .length;
}

export function syncFamilyReportRuleIssues({
  state,
  record,
  family,
  members = [],
  policies = [],
  allocateId,
} = {}) {
  if (!state || !record) return false;
  const reportId = Number(record.id || 0);
  if (!reportId) return false;
  state.familyReportIssues = Array.isArray(state.familyReportIssues) ? state.familyReportIssues : [];
  const nextInputs = buildReportIssues({ family, members, policies, report: record.report || {} })
    .filter((issue) => trim(issue.title) && trim(issue.detail));
  const activeRuleIssues = state.familyReportIssues.filter((issue) => (
    Number(issue.reportId || 0) === reportId &&
    String(issue.source || 'rule') === 'rule' &&
    String(issue.status || 'open') !== 'archived'
  ));
  if (JSON.stringify(comparableRuleIssueList(activeRuleIssues)) === JSON.stringify(comparableRuleIssueList(nextInputs))) {
    return false;
  }

  const now = new Date().toISOString();
  for (const issue of activeRuleIssues) {
    issue.status = 'archived';
    issue.updatedAt = now;
  }

  const nextId = typeof allocateId === 'function'
    ? () => allocateId(state)
    : () => Date.now();
  const ownerUserId = Number(record.ownerUserId || 0) || null;
  const ownerGuestId = ownerUserId ? '' : trim(record.ownerGuestId);
  const rows = nextInputs.map((issue) => ({
    id: nextId(),
    reportId,
    familyId: Number(record.familyId),
    ownerUserId,
    ownerGuestId,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    ...issue,
    source: 'rule',
  }));
  state.familyReportIssues.push(...rows);
  record.summary = {
    ...(record.summary || {}),
    issueCount: openIssueCountForReport(state, reportId),
  };
  record.updatedAt = now;
  return true;
}

function archiveActiveFamilyReportRecords(state, familyId, now) {
  const targetFamilyId = Number(familyId || 0);
  if (!targetFamilyId) return;
  for (const report of Array.isArray(state.familyReports) ? state.familyReports : []) {
    if (Number(report.familyId || 0) !== targetFamilyId) continue;
    if (String(report.status || 'active') === 'archived') continue;
    report.status = 'archived';
    report.updatedAt = now;
  }
  for (const issue of Array.isArray(state.familyReportIssues) ? state.familyReportIssues : []) {
    if (Number(issue.familyId || 0) !== targetFamilyId) continue;
    if (String(issue.status || 'open') === 'archived') continue;
    issue.status = 'archived';
    issue.updatedAt = now;
  }
  for (const correction of Array.isArray(state.familyReportCorrections) ? state.familyReportCorrections : []) {
    if (Number(correction.familyId || 0) !== targetFamilyId) continue;
    if (String(correction.status || 'pending_review') === 'archived') continue;
    correction.status = 'archived';
    correction.updatedAt = now;
  }
}

function ownerIdentity(owner = {}) {
  const ownerUserId = Number(owner.userId || owner.ownerUserId || 0) || null;
  const ownerGuestId = ownerUserId ? '' : trim(owner.guestId || owner.ownerGuestId);
  return { ownerUserId, ownerGuestId };
}

function familyReportRecordMatchesOwner(record = {}, owner = {}) {
  const ownerInfo = ownerIdentity(owner);
  if (ownerInfo.ownerUserId) return Number(record.ownerUserId || 0) === ownerInfo.ownerUserId;
  return !Number(record.ownerUserId || 0) && trim(record.ownerGuestId) === ownerInfo.ownerGuestId;
}

function sortedPolicyIds(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => Number(row?.policyId || row?.id || 0))
    .filter((id) => id > 0)
    .sort((left, right) => left - right);
}

function reportPolicyIds(report = {}) {
  const appendixPolicies = report?.appendix?.policies || [];
  const inventoryRows = report?.policyInventory?.rows || [];
  return sortedPolicyIds(appendixPolicies.length ? appendixPolicies : inventoryRows);
}

function samePolicyIds(left = [], right = []) {
  if (!left.length || left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

function familyMemberSnapshot({ family = {}, members = [] } = {}) {
  return {
    coreMemberId: Number(family?.coreMemberId || 0) || null,
    members: (Array.isArray(members) ? members : [])
      .filter((member) => String(member?.status || 'active') === 'active')
      .map((member) => ({
        id: Number(member?.id || 0) || null,
        name: trim(member?.name),
        relationToCore: trim(member?.relationToCore),
        relationLabel: trim(member?.relationLabel),
        role: trim(member?.role),
        gender: trim(member?.gender),
        birthday: trim(member?.birthday),
        idNumberTail: trim(member?.idNumberTail),
        mobile: trim(member?.mobile),
        notes: trim(member?.notes),
      }))
      .sort((left, right) => Number(left.id || 0) - Number(right.id || 0)),
  };
}

function sameFamilyMemberSnapshot(left = null, right = null) {
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function reusableFamilyPolicyAnalysisReport({ state, familyId, owner, policies = [], memberSnapshot = null } = {}) {
  const targetFamilyId = Number(familyId || 0);
  const nextPolicyIds = sortedPolicyIds(policies);
  if (!targetFamilyId || !nextPolicyIds.length) return null;
  const activeReports = (Array.isArray(state?.familyReports) ? state.familyReports : [])
    .filter((record) => (
      Number(record?.familyId || 0) === targetFamilyId &&
      String(record?.status || 'active') === 'active' &&
      familyReportRecordMatchesOwner(record, owner)
    ))
    .sort((left, right) => (
      String(right.generatedAt || right.createdAt || '').localeCompare(String(left.generatedAt || left.createdAt || '')) ||
      Number(right.id || 0) - Number(left.id || 0)
    ));
  for (const record of activeReports) {
    const analysisReport = record?.report?.familyPolicyAnalysisReport;
    if (!analysisReport || String(analysisReport.status || 'complete') === 'failed' || !trim(analysisReport.content)) continue;
    if (!samePolicyIds(nextPolicyIds, reportPolicyIds(record.report))) continue;
    if (!sameFamilyMemberSnapshot(memberSnapshot, record.memberSnapshot)) continue;
    return structuredClone(analysisReport);
  }
  return null;
}

export function createFamilyReportRecord({
  state,
  family,
  owner = {},
  members = [],
  policies = [],
  report,
  planningProfile = null,
  allocateId,
  allowEmptyPolicies = false,
} = {}) {
  if (!family || !report) throw new Error('FAMILY_REPORT_INPUT_REQUIRED');
  const policyRows = Array.isArray(policies) ? policies : [];
  if (!policyRows.length && !allowEmptyPolicies) {
    const error = new Error('家庭暂无保单，上传并绑定保单后再生成报告');
    error.code = 'FAMILY_REPORT_NO_POLICIES';
    error.status = 400;
    throw error;
  }
  const now = new Date().toISOString();
  const nextId = typeof allocateId === 'function'
    ? () => allocateId(state)
    : () => Date.now();
  const finalReport = addMissingMemberReports(structuredClone(report), members, policyRows);
  const nextMemberSnapshot = familyMemberSnapshot({ family, members });
  const previousPolicyAnalysisReport = reusableFamilyPolicyAnalysisReport({
    state,
    familyId: family.id,
    owner,
    policies: policyRows,
    memberSnapshot: nextMemberSnapshot,
  });
  if (previousPolicyAnalysisReport && !finalReport.familyPolicyAnalysisReport) {
    finalReport.familyPolicyAnalysisReport = previousPolicyAnalysisReport;
  }
  const issueInputs = buildReportIssues({ family, members, policies: policyRows, report: finalReport });
  const reportId = nextId();
  archiveActiveFamilyReportRecords(state, family.id, now);

  const { ownerUserId, ownerGuestId } = ownerIdentity(owner);
  const record = {
    id: reportId,
    familyId: Number(family.id),
    ownerUserId,
    ownerGuestId,
    status: 'active',
    source: 'code',
    report: finalReport,
    memberSnapshot: nextMemberSnapshot,
    planningProfile: planningProfile || null,
    engineVersion: FAMILY_REPORT_ENGINE_VERSION,
    generatedAt: now,
    createdAt: now,
    updatedAt: now,
    summary: {
      ...(finalReport.summary || {}),
      issueCount: issueInputs.length,
    },
  };

  state.familyReports = Array.isArray(state.familyReports) ? state.familyReports : [];
  state.familyReportIssues = Array.isArray(state.familyReportIssues) ? state.familyReportIssues : [];
  state.familyReportCorrections = Array.isArray(state.familyReportCorrections) ? state.familyReportCorrections : [];
  state.familyReports.push(record);

  const issues = issueInputs.map((issue) => ({
    id: nextId(),
    reportId,
    familyId: Number(family.id),
    ownerUserId,
    ownerGuestId,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    ...issue,
  }));
  state.familyReportIssues.push(...issues);

  return { record, issues };
}

function correctionNonAppliedReason(correction = {}) {
  const action = trim(correction.action);
  if (!Number(correction.policyId || 0)) return '未定位到保单';
  if (!AUTO_APPLY_ACTIONS.has(action)) return '动作暂不支持';
  if (action === 'override_cashflow' && !Array.isArray(correction.cashflowRows)) return '缺少现金流年度表';
  if (action === 'override_cashflow' && !correction.cashflowRows.length) return '缺少现金流年度表';
  if (!AUTO_APPLY_DIMENSIONS.has(trim(correction.dimension))) return '维度暂不支持';
  return '';
}

function initialCorrectionStatus(correction = {}) {
  if (!Number(correction.policyId || 0)) return 'not_applicable';
  if (trim(correction.action) === 'override_cashflow' && (!Array.isArray(correction.cashflowRows) || !correction.cashflowRows.length)) {
    return 'not_applicable';
  }
  if (
    AUTO_APPLY_DIMENSIONS.has(trim(correction.dimension)) &&
    AUTO_APPLY_ACTIONS.has(trim(correction.action))
  ) {
    return 'auto_applied';
  }
  return 'not_applicable';
}

function effectiveCorrectionStatus(correction = {}) {
  const status = String(correction.status || '');
  if (status === 'pending_review' && initialCorrectionStatus(correction) === 'auto_applied') {
    return 'auto_applied';
  }
  return status || initialCorrectionStatus(correction);
}

function correctionOrderValue(correction = {}) {
  const timestamp = Date.parse(correction.updatedAt || correction.createdAt || '');
  if (Number.isFinite(timestamp)) return timestamp;
  return Number(correction.id || 0) || 0;
}

function inferredCashflowAge(policy = {}, year, explicitAge) {
  if (explicitAge !== null && explicitAge >= 0) return explicitAge;
  const birthYear = new Date(policy.insuredBirthday || policy.birthday || '').getFullYear();
  if (!Number.isFinite(birthYear) || birthYear <= 0) return null;
  return year >= birthYear ? year - birthYear : null;
}

function cashflowEntriesFromCorrection(correction = {}, policy = {}) {
  let cumulative = 0;
  return (Array.isArray(correction.cashflowRows) ? correction.cashflowRows : [])
    .map((row) => {
      const year = finiteNumber(row?.year);
      const amount = finiteNumber(row?.amount);
      if (!Number.isInteger(year) || year <= 0 || amount === null || amount <= 0) return null;
      const explicitAge = finiteNumberAllowZero(row?.age);
      return {
        year,
        age: inferredCashflowAge(policy, year, explicitAge),
        amount,
        cumulative: 0,
        liability: trim(row?.liability) || '现金流',
        calculationText: trim(row?.calculationText || row?.calcText),
        evidence: trim(row?.evidence),
        source: 'deepseek',
        correctionId: correction.id ?? null,
        policyId: policy.id ?? correction.policyId ?? null,
        productName: trim(policy.name || correction.productName),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.year - right.year || String(left.liability).localeCompare(String(right.liability)))
    .map((row) => {
      cumulative += row.amount;
      return { ...row, cumulative };
    });
}

export function applyFamilyReportPolicyCorrections(policies = [], corrections = []) {
  const overrideByPolicyId = new Map();
  for (const correction of Array.isArray(corrections) ? corrections : []) {
    if (effectiveCorrectionStatus(correction) !== 'auto_applied' && effectiveCorrectionStatus(correction) !== 'accepted') continue;
    if (trim(correction.action) !== 'override_cashflow') continue;
    const policyId = Number(correction.policyId || 0);
    if (!policyId || !Array.isArray(correction.cashflowRows) || !correction.cashflowRows.length) continue;
    const existing = overrideByPolicyId.get(policyId);
    if (!existing || correctionOrderValue(correction) >= correctionOrderValue(existing)) {
      overrideByPolicyId.set(policyId, correction);
    }
  }
  if (!overrideByPolicyId.size) return policies;

  return (Array.isArray(policies) ? policies : []).map((policy) => {
    const correction = overrideByPolicyId.get(Number(policy?.id || 0));
    if (!correction) return policy;
    const cashflowEntries = cashflowEntriesFromCorrection(correction, policy);
    if (!cashflowEntries.length) return policy;
    return {
      ...policy,
      cashflowEntries,
      familyReportCashflowOverride: {
        correctionId: correction.id ?? null,
        source: correction.source || 'deepseek',
        reason: correction.reason || '',
      },
    };
  });
}

export function appendFamilyReportIssues({
  state,
  record,
  issues = [],
  allocateId,
} = {}) {
  if (!state || !record || !Array.isArray(issues) || !issues.length) return [];
  const now = new Date().toISOString();
  const nextId = typeof allocateId === 'function'
    ? () => allocateId(state)
    : () => Date.now();
  const ownerUserId = Number(record.ownerUserId || 0) || null;
  const ownerGuestId = ownerUserId ? '' : trim(record.ownerGuestId);
  const rows = issues.map((issue) => ({
    id: nextId(),
    reportId: Number(record.id),
    familyId: Number(record.familyId),
    ownerUserId,
    ownerGuestId,
    severity: trim(issue.severity) || 'warning',
    category: trim(issue.category) || 'report_quality',
    status: 'open',
    source: trim(issue.source) || 'rule',
    title: trim(issue.title),
    detail: trim(issue.detail),
    suggestion: trim(issue.suggestion),
    memberId: issue.memberId ?? null,
    memberName: trim(issue.memberName),
    policyId: issue.policyId ?? null,
    productName: trim(issue.productName),
    dimension: trim(issue.dimension),
    model: trim(issue.model),
    confidence: issue.confidence ?? null,
    correctionStatus: trim(issue.correctionStatus),
    correctionLabel: trim(issue.correctionLabel),
    correctionReason: trim(issue.correctionReason),
    correctionId: issue.correctionId ?? null,
    createdAt: now,
    updatedAt: now,
  })).filter((issue) => issue.title && issue.detail);
  if (!rows.length) return [];
  state.familyReportIssues = Array.isArray(state.familyReportIssues) ? state.familyReportIssues : [];
  state.familyReportIssues.push(...rows);
  record.summary = {
    ...(record.summary || {}),
    issueCount: state.familyReportIssues.filter((issue) => (
      Number(issue.reportId || 0) === Number(record.id) &&
      String(issue.status || 'open') === 'open'
    )).length,
  };
  if (rows.some((issue) => issue.source === 'deepseek') && !String(record.source || '').includes('deepseek')) {
    record.source = record.source ? `${record.source}+deepseek` : 'deepseek';
  }
  record.updatedAt = now;
  return rows;
}

export function appendFamilyReportCorrections({
  state,
  record,
  corrections = [],
  issueRows = [],
  allocateId,
} = {}) {
  if (!state || !record || !Array.isArray(corrections) || !corrections.length) return [];
  const now = new Date().toISOString();
  const nextId = typeof allocateId === 'function'
    ? () => allocateId(state)
    : () => Date.now();
  const ownerUserId = Number(record.ownerUserId || 0) || null;
  const ownerGuestId = ownerUserId ? '' : trim(record.ownerGuestId);
  const issueByIndex = new Map((Array.isArray(issueRows) ? issueRows : []).map((issue, index) => [index, issue]));
  const rows = corrections.map((correction) => {
    const status = initialCorrectionStatus(correction);
    const linkedIssue = issueByIndex.get(Number(correction.issueIndex));
    return {
      id: nextId(),
      reportId: Number(record.id),
      familyId: Number(record.familyId),
      ownerUserId,
      ownerGuestId,
      policyId: Number(correction.policyId || 0) || null,
      memberId: Number(correction.memberId || 0) || null,
      dimension: trim(correction.dimension) || 'other',
      action: trim(correction.action),
      targetPath: trim(correction.targetPath),
      originalValue: correction.originalValue ?? null,
      correctedValue: correction.correctedValue ?? null,
      cashflowRows: Array.isArray(correction.cashflowRows) ? correction.cashflowRows : [],
      reason: trim(correction.reason),
      evidence: trim(correction.evidence),
      confidence: clampConfidence(correction.confidence),
      riskLevel: trim(correction.riskLevel) || 'medium',
      status,
      source: trim(correction.source) || 'deepseek',
      issueId: Number(linkedIssue?.id || 0) || null,
      memberName: trim(correction.memberName),
      productName: trim(correction.productName),
      model: trim(correction.model),
      notAppliedReason: status === 'auto_applied' ? '' : correctionNonAppliedReason(correction),
      createdAt: now,
      updatedAt: now,
    };
  }).filter((correction) => correction.action && correction.reason);
  if (!rows.length) return [];
  state.familyReportCorrections = Array.isArray(state.familyReportCorrections) ? state.familyReportCorrections : [];
  state.familyReportCorrections.push(...rows);
  record.summary = {
    ...(record.summary || {}),
    correctionCount: (state.familyReportCorrections || []).filter((correction) => (
      Number(correction.reportId || 0) === Number(record.id) &&
      String(correction.status || 'pending_review') !== 'archived'
    )).length,
    autoAppliedCorrectionCount: (state.familyReportCorrections || []).filter((correction) => (
      Number(correction.reportId || 0) === Number(record.id) &&
      String(correction.status || '') === 'auto_applied'
    )).length,
  };
  if (rows.length && !String(record.source || '').includes('deepseek')) {
    record.source = record.source ? `${record.source}+deepseek` : 'deepseek';
  }
  record.updatedAt = now;
  return rows;
}

export function trustedFamilyReportCorrections(state = {}, { familyId = null, reportId = null } = {}) {
  const targetFamilyId = Number(familyId || 0);
  const targetReportId = Number(reportId || 0);
  return (Array.isArray(state.familyReportCorrections) ? state.familyReportCorrections : [])
    .filter((correction) => TRUSTED_CORRECTION_STATUSES.has(effectiveCorrectionStatus(correction)))
    .filter((correction) => !targetFamilyId || Number(correction.familyId || 0) === targetFamilyId)
    .filter((correction) => (
      !targetReportId ||
      Number(correction.reportId || 0) === targetReportId ||
      String(correction.status || '') === 'accepted'
    ))
    .map((correction) => ({
      ...correction,
      status: effectiveCorrectionStatus(correction),
    }));
}

export function updateFamilyReportCorrectionStatus(state = {}, correctionId, status) {
  const id = Number(correctionId || 0);
  const nextStatus = trim(status);
  if (!id || !['accepted', 'rejected', 'pending_review'].includes(nextStatus)) {
    const error = new Error('REPORT_CORRECTION_STATUS_INVALID');
    error.status = 400;
    throw error;
  }
  state.familyReportCorrections = Array.isArray(state.familyReportCorrections) ? state.familyReportCorrections : [];
  const correction = state.familyReportCorrections.find((row) => Number(row.id || 0) === id) || null;
  if (!correction || String(correction.status || 'pending_review') === 'archived') {
    const error = new Error('报告修正不存在');
    error.code = 'REPORT_CORRECTION_NOT_FOUND';
    error.status = 404;
    throw error;
  }
  correction.status = nextStatus;
  correction.notAppliedReason = nextStatus === 'accepted' ? '' : (correction.notAppliedReason || '人工忽略');
  correction.updatedAt = new Date().toISOString();
  return correction;
}

export function updateFamilyReportRecordReport({ record, report, members = [], policies = [] } = {}) {
  if (!record || !report) return null;
  const familyPolicyAnalysisReport = record.report?.familyPolicyAnalysisReport;
  const finalReport = addMissingMemberReports(structuredClone(report), members, policies);
  if (familyPolicyAnalysisReport && !finalReport.familyPolicyAnalysisReport) {
    finalReport.familyPolicyAnalysisReport = familyPolicyAnalysisReport;
  }
  const openIssueCount = Number(record.summary?.issueCount || 0);
  const correctionCount = Number(record.summary?.correctionCount || 0);
  const autoAppliedCorrectionCount = Number(record.summary?.autoAppliedCorrectionCount || 0);
  record.report = finalReport;
  record.engineVersion = FAMILY_REPORT_ENGINE_VERSION;
  record.summary = {
    ...(finalReport.summary || {}),
    issueCount: openIssueCount,
    correctionCount,
    autoAppliedCorrectionCount,
  };
  record.updatedAt = new Date().toISOString();
  return record;
}

function correctionStateForIssue(issue = {}, corrections = []) {
  const linked = corrections.filter((correction) => Number(correction.issueId || 0) === Number(issue.id || 0));
  const preferred = linked.find((correction) => effectiveCorrectionStatus(correction) === 'auto_applied')
    || linked.find((correction) => effectiveCorrectionStatus(correction) === 'accepted')
    || linked.find((correction) => effectiveCorrectionStatus(correction) === 'pending_review')
    || linked.find((correction) => effectiveCorrectionStatus(correction) === 'rejected')
    || linked[0];
  if (preferred) {
    const status = effectiveCorrectionStatus(preferred);
    if (status === 'auto_applied') {
      return { correctionStatus: 'corrected', correctionLabel: '已用 DeepSeek 修正', correctionReason: preferred.reason || '', correctionId: preferred.id };
    }
    if (status === 'accepted') {
      return { correctionStatus: 'corrected', correctionLabel: '已用 DeepSeek 修正', correctionReason: preferred.reason || '', correctionId: preferred.id };
    }
    if (status === 'pending_review') {
      const reason = preferred.notAppliedReason || correctionNonAppliedReason(preferred) || preferred.reason || '无法应用';
      return { correctionStatus: 'not_corrected', correctionLabel: `未修正：${reason}`, correctionReason: reason, correctionId: preferred.id };
    }
    if (status === 'rejected') {
      return { correctionStatus: 'rejected', correctionLabel: '已忽略', correctionReason: preferred.notAppliedReason || preferred.reason || '', correctionId: preferred.id };
    }
    return { correctionStatus: 'not_corrected', correctionLabel: `未修正：${preferred.notAppliedReason || '无法应用'}`, correctionReason: preferred.notAppliedReason || preferred.reason || '', correctionId: preferred.id };
  }
  if (String(issue.source || '') !== 'deepseek') {
    return { correctionStatus: 'not_applicable', correctionLabel: '规则问题', correctionReason: '代码规则生成的问题，不属于 DeepSeek 修正项', correctionId: null };
  }
  const reason = !Number(issue.policyId || 0)
    ? '未定位到保单'
    : (['official_evidence_gap', 'product_classification', 'coverage_gap', 'report_quality'].includes(String(issue.category || ''))
      ? '仅提示，不影响报告计算'
      : '无可应用修正');
  return { correctionStatus: 'not_corrected', correctionLabel: `未修正：${reason}`, correctionReason: reason, correctionId: null };
}

export function clientFamilyReportRecord(record = null) {
  if (!record) return null;
  return {
    id: record.id,
    familyId: record.familyId,
    status: record.status || 'active',
    source: record.source || 'code',
    generatedAt: record.generatedAt || record.createdAt || '',
    createdAt: record.createdAt || '',
    updatedAt: record.updatedAt || '',
    engineVersion: record.engineVersion || null,
    summary: record.summary || record.report?.summary || {},
    report: record.report || null,
  };
}

export function buildAdminReportIssueSummaries(state = {}) {
  const familiesById = new Map((state.familyProfiles || []).map((family) => [Number(family.id), family]));
  const usersById = new Map((state.users || []).map((user) => [Number(user.id), user]));
  const issuesByReportId = new Map();
  const correctionsByReportId = new Map();
  for (const issue of state.familyReportIssues || []) {
    if (String(issue.status || 'open') !== 'open') continue;
    const key = Number(issue.reportId || 0);
    const list = issuesByReportId.get(key) || [];
    list.push(issue);
    issuesByReportId.set(key, list);
  }
  for (const correction of state.familyReportCorrections || []) {
    if (String(correction.status || 'pending_review') === 'archived') continue;
    const key = Number(correction.reportId || 0);
    const list = correctionsByReportId.get(key) || [];
    list.push(correction);
    correctionsByReportId.set(key, list);
  }
  return (state.familyReports || [])
    .filter((record) => String(record.status || 'active') === 'active')
    .map((record) => {
      const issues = issuesByReportId.get(Number(record.id || 0)) || [];
      const corrections = correctionsByReportId.get(Number(record.id || 0)) || [];
      const family = familiesById.get(Number(record.familyId || 0)) || {};
      const user = usersById.get(Number(record.ownerUserId || 0)) || {};
      const errorCount = issues.filter((issue) => issue.severity === 'error').length;
      const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
      const autoAppliedCorrectionCount = corrections.filter((correction) => effectiveCorrectionStatus(correction) === 'auto_applied').length;
      const pendingCorrectionCount = corrections.filter((correction) => effectiveCorrectionStatus(correction) === 'pending_review').length;
      const acceptedCorrectionCount = corrections.filter((correction) => effectiveCorrectionStatus(correction) === 'accepted').length;
      return {
        id: record.id,
        familyId: record.familyId,
        familyName: family.familyName || '未命名家庭',
        ownerMobile: user.mobile || '',
        ownerGuestId: record.ownerGuestId || '',
        generatedAt: record.generatedAt || record.createdAt || '',
        policyCount: record.summary?.policyCount ?? record.report?.summary?.policyCount ?? 0,
        memberCount: record.summary?.memberCount ?? record.report?.summary?.memberCount ?? 0,
        issueCount: issues.length,
        errorCount,
        warningCount,
        correctionCount: corrections.length,
        autoAppliedCorrectionCount,
        acceptedCorrectionCount,
        pendingCorrectionCount,
        source: record.source || 'code',
      };
    })
    .filter((row) => row.issueCount > 0)
    .sort((left, right) => (
      Number(right.errorCount) - Number(left.errorCount) ||
      Number(right.warningCount) - Number(left.warningCount) ||
      String(right.generatedAt).localeCompare(String(left.generatedAt))
    ));
}

export function buildAdminReportIssueDetail(state = {}, reportId) {
  const id = Number(reportId || 0);
  const record = (state.familyReports || []).find((row) => Number(row.id || 0) === id) || null;
  if (!record) return null;
  const summary = buildAdminReportIssueSummaries(state).find((row) => Number(row.id) === id) || {
    id: record.id,
    familyId: record.familyId,
    familyName: '未命名家庭',
    issueCount: 0,
    errorCount: 0,
    warningCount: 0,
    generatedAt: record.generatedAt || record.createdAt || '',
    policyCount: record.summary?.policyCount ?? 0,
    memberCount: record.summary?.memberCount ?? 0,
    source: record.source || 'code',
  };
  const issues = (state.familyReportIssues || [])
    .filter((issue) => Number(issue.reportId || 0) === id && String(issue.status || 'open') !== 'archived')
    .sort((left, right) => {
      const severityOrder = { error: 0, warning: 1, info: 2 };
      return (severityOrder[left.severity] ?? 9) - (severityOrder[right.severity] ?? 9)
        || String(left.category || '').localeCompare(String(right.category || ''));
    });
  const corrections = (state.familyReportCorrections || [])
    .filter((correction) => Number(correction.reportId || 0) === id && String(correction.status || 'pending_review') !== 'archived')
    .map((correction) => ({
      ...correction,
      status: effectiveCorrectionStatus(correction),
    }))
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
  const issuesWithCorrectionState = issues.map((issue) => ({
    ...issue,
    ...correctionStateForIssue(issue, corrections),
  }));
  return { report: summary, issues: issuesWithCorrectionState, corrections };
}
