const HANDLER_ACTIONS = Object.freeze({
  insurance_expert: Object.freeze(['family_policy_summary', 'family_summary', 'view_family_coverage_report', 'coverage_report', 'insurance_product_knowledge']),
  sales_champion: Object.freeze(['view_sales_advice_report', 'sales_report', 'sales_coaching', 'chat']),
  system: Object.freeze(['upload_link', 'system_help', 'unknown_read', 'unknown_write', 'transfer_preview', 'memory_proposal']),
});

const INVALID_POLICY_STATUS = /(失效|停效|中止|终止|退保|过期|inactive|expired|lapsed|terminated|cancelled|canceled)/iu;
const VALID_POLICY_STATUS = /^(有效|生效|承保|正常|active|valid|in_force|in force)$/iu;
const COMPLETE_REPORT_STATUS = new Set(['active', 'complete', 'completed', 'ready', 'success']);

function text(value) {
  return String(value ?? '').trim();
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new TypeError(`${label} is required`);
  return number;
}

function recordTime(record, ...keys) {
  for (const key of keys) {
    const value = text(record?.[key]);
    if (value) return value;
  }
  return '';
}

function latestForFamily(records, familyId) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => Number(record?.familyId) === familyId && text(record?.status || 'active') !== 'archived')
    .sort((left, right) => (
      recordTime(right, 'generatedAt', 'updatedAt', 'createdAt').localeCompare(recordTime(left, 'generatedAt', 'updatedAt', 'createdAt')) ||
      Number(right?.id || 0) - Number(left?.id || 0)
    ))[0] || null;
}

export function isAgentReportFresh(report) {
  if (!report || !COMPLETE_REPORT_STATUS.has(text(report.status || 'active').toLowerCase())) return false;
  const generatedAt = recordTime(report, 'generatedAt', 'updatedAt', 'createdAt');
  if (!generatedAt) return false;
  const sourceUpdatedAt = recordTime(report, 'sourceUpdatedAt', 'source_updated_at');
  return !sourceUpdatedAt || sourceUpdatedAt <= generatedAt;
}

function numericSummary(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (typeof item === 'number' && Number.isFinite(item)) return [[key, item]];
    if (typeof item === 'boolean') return [[key, item]];
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const nested = numericSummary(item, depth + 1);
      return Object.keys(nested).length ? [[key, nested]] : [];
    }
    return [];
  }));
}

function stableResult(facts, provenance = {}, presentation = {}) {
  return { facts, provenance, presentation };
}

function denial(reason = 'ACTION_NOT_ALLOWED') {
  return stableResult(
    { denied: true, reason },
    { source: 'agent_question_handler_allowlist' },
    { message: '该操作不可用。' },
  );
}

export function createAgentQuestionHandlers({
  store,
  reportQueue,
  productKnowledge,
  salesCoaching,
  links = {},
  clock = () => new Date(),
} = {}) {
  if (!store || typeof store.load !== 'function') throw new TypeError('store with load() is required');
  const pendingReports = new Map();

  async function loadFamilyState(familyId) {
    const id = positiveInteger(familyId, 'familyId');
    return { id, state: await store.load() };
  }

  async function familySummary(context) {
    const { id, state } = await loadFamilyState(context?.familyId);
    const members = (Array.isArray(state.familyMembers) ? state.familyMembers : [])
      .filter((member) => Number(member?.familyId) === id && text(member?.status || 'active') === 'active');
    const policies = (Array.isArray(state.policies) ? state.policies : [])
      .filter((policy) => Number(policy?.familyId) === id);
    const validPolicies = policies.filter((policy) => {
      const status = text(policy?.status || policy?.policyStatus);
      return Boolean(status && !INVALID_POLICY_STATUS.test(status) && VALID_POLICY_STATUS.test(status));
    });
    return stableResult(
      { familyId: id, activeMemberCount: members.length, policyCount: policies.length, validPolicyCount: validPolicies.length },
      {
        source: 'persistent_family_state',
        countedAt: clock().toISOString(),
        validPolicyDefinition: '状态明确为“有效/生效/承保/正常”或 active/valid/in_force，且不含失效、停效、中止、终止、退保、过期状态。',
      },
      { message: '家庭保单统计已按持久化记录计算。' },
    );
  }

  async function enqueueReport({ familyId, jobType, reason }) {
    if (!reportQueue || typeof reportQueue.enqueue !== 'function') {
      return stableResult(
        { status: 'unavailable', jobType, progress: 0 },
        { source: 'report_queue', reason },
        { message: '报告暂不可用，请稍后重试。' },
      );
    }
    const key = `${jobType}:${familyId}`;
    if (!pendingReports.has(key)) {
      const queued = Promise.resolve(reportQueue.enqueue({ familyId, jobType, dedupeKey: key, reason }));
      pendingReports.set(key, queued);
      queued.then(
        () => pendingReports.delete(key),
        () => pendingReports.delete(key),
      );
    }
    const job = await pendingReports.get(key);
    return stableResult(
      { status: 'processing', jobType, jobId: job?.jobId || job?.id || '', progress: Number(job?.progress) || 0 },
      { source: 'report_queue', reason, dedupeKey: key },
      { message: '报告正在生成，请稍后查看。' },
    );
  }

  async function viewReport(context, { collection, jobType, link }) {
    const { id, state } = await loadFamilyState(context?.familyId);
    const report = latestForFamily(state[collection], id);
    if (!isAgentReportFresh(report)) {
      return enqueueReport({ familyId: id, jobType, reason: report ? 'stale' : 'missing' });
    }
    const secureLink = typeof links[link] === 'function'
      ? links[link]({ familyId: id, internalUserId: context?.internalUserId })
      : '';
    return stableResult(
      {
        familyId: id,
        status: 'fresh',
        reportId: report.id ?? null,
        generatedAt: recordTime(report, 'generatedAt', 'createdAt'),
        summary: numericSummary(report.summary || report.inputSummary || report.report?.summary),
      },
      { source: collection, sourceUpdatedAt: recordTime(report, 'sourceUpdatedAt', 'source_updated_at') },
      { secureLink, requiresLogin: true, message: '报告已生成，请登录安全页面查看完整内容。' },
    );
  }

  async function answerProductKnowledge(context) {
    const question = text(context?.question).slice(0, 2_000);
    const result = productKnowledge && typeof productKnowledge.search === 'function'
      ? await productKnowledge.search({ question, scope: 'public_read_only' })
      : null;
    const sources = (Array.isArray(result?.sources) ? result.sources : [])
      .filter((source) => source && (text(source.url) || text(source.provenance)))
      .map((source) => ({
        title: text(source.title),
        url: text(source.url),
        provenance: text(source.provenance || source.sourceKind),
      }));
    if (!sources.length) {
      return stableResult(
        { certainty: 'unverified', answer: '' },
        { source: 'public_product_knowledge', sources: [] },
        { message: '当前没有可核验来源，无法给出确定的产品事实。' },
      );
    }
    return stableResult(
      { certainty: 'supported', answer: text(result?.answer) },
      { source: 'public_product_knowledge', sources },
      { message: text(result?.answer) },
    );
  }

  async function coach(context) {
    const confirmedFacts = context?.confirmedFacts && typeof context.confirmedFacts === 'object' && !Array.isArray(context.confirmedFacts)
      ? numericSummary(context.confirmedFacts)
      : {};
    const pendingFields = (Array.isArray(context?.pendingFields) ? context.pendingFields : [])
      .map(text).filter(Boolean).slice(0, 20);
    const input = { question: text(context?.question).slice(0, 2_000), confirmedFacts, pendingFields };
    const result = salesCoaching && typeof salesCoaching.answer === 'function'
      ? await salesCoaching.answer(input)
      : {};
    return stableResult(
      { guidance: Array.isArray(result?.guidance) ? result.guidance.map(text).filter(Boolean) : [], pendingConfirmation: pendingFields },
      { source: 'confirmed_request_facts', hermesMemoryUsed: false },
      { message: text(result?.message) },
    );
  }

  async function execute(action, context = {}) {
    switch (text(action)) {
      case 'family_policy_summary':
      case 'family_summary': return familySummary(context);
      case 'view_family_coverage_report':
      case 'coverage_report': return viewReport(context, { collection: 'familyReports', jobType: 'family_policy_analysis', link: 'familyReport' });
      case 'view_sales_advice_report':
      case 'sales_report': return viewReport(context, { collection: 'familySalesReviews', jobType: 'family_sales_review', link: 'salesReview' });
      case 'insurance_product_knowledge': return answerProductKnowledge(context);
      case 'sales_coaching': return coach(context);
      case 'upload_link': {
        const internalUserId = positiveInteger(context?.internalUserId, 'internalUserId');
        const secureLink = typeof links.upload === 'function' ? links.upload({ internalUserId }) : '';
        return stableResult(
          { acceptedAttachments: false },
          { source: 'customer_upload_entry' },
          { secureLink, requiresLogin: true, message: '请通过安全上传页面提交保单资料。' },
        );
      }
      case 'system_help':
      case 'chat':
      case 'unknown_read': return stableResult(
        { readOnly: true },
        { source: 'built_in_safe_response' },
        { message: '我可以协助查询家庭保单摘要、保障报告、销售建议和公开产品知识。' },
      );
      case 'unknown_write': return denial('UNKNOWN_WRITE_DENIED');
      case 'transfer_preview':
      case 'memory_proposal': return stableResult(
        { denied: true, confirmationRequired: true },
        { source: 'agent_question_handler_allowlist' },
        { message: '该操作需要在安全页面明确确认后才能继续。' },
      );
      default: return denial();
    }
  }

  const registry = Object.freeze(Object.fromEntries(Object.entries(HANDLER_ACTIONS).map(([handler, actions]) => [
    handler,
    Object.freeze(async (context = {}) => execute(actions.includes(text(context.intent)) ? text(context.intent) : '', context)),
  ])));
  return Object.freeze({ ...registry, registry, execute });
}
