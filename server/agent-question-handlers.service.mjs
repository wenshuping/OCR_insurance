const HANDLER_ACTIONS = Object.freeze({
  insurance_expert: Object.freeze(['family_policy_summary', 'family_summary', 'view_family_coverage_report', 'coverage_report', 'insurance_product_knowledge']),
  sales_champion: Object.freeze(['view_sales_advice_report', 'sales_report', 'sales_coaching', 'chat']),
  system: Object.freeze(['upload_link', 'system_help', 'unknown_read', 'unknown_write', 'transfer_preview', 'memory_proposal']),
});

const INACTIVE_POLICY_STATUS = /(失效|停效|中止|终止|退保|已退保|过期|作废|无效|inactive|expired|lapsed|terminated|surrendered|cancelled|canceled|void)/iu;
const SAFE_SUMMARY_FIELDS = new Set([
  'memberCount', 'activeMemberCount', 'policyCount', 'validPolicyCount',
  'membersWithoutPolicyCount', 'officialProductCount', 'issueCount', 'gapCount',
]);

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

function safeSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => (
    SAFE_SUMMARY_FIELDS.has(key) && typeof item === 'number' && Number.isFinite(item)
  )));
}

function policyStatusText(policy = {}) {
  return [
    policy.status,
    policy.policyStatus,
    policy.policyState,
    policy.contractStatus,
    policy.validityStatus,
  ].map(text).filter(Boolean).join(' ');
}

function policyIsValid(policy = {}, now = new Date()) {
  if (policy.expired === true || INACTIVE_POLICY_STATUS.test(policyStatusText(policy))) return false;
  return resolvePolicyValidityStatus(policy.coveragePeriod, {
    effectiveDate: policy.date || policy.effectiveDate,
    insuredBirthday: policy.insuredBirthday,
    now,
  }).tone !== 'expired';
}

function latestSourceUpdatedAt(state, familyId) {
  const records = [
    ...(Array.isArray(state.familyProfiles) ? state.familyProfiles : []).filter((row) => Number(row?.id) === familyId),
    ...(Array.isArray(state.familyMembers) ? state.familyMembers : []).filter((row) => Number(row?.familyId) === familyId),
    ...(Array.isArray(state.policies) ? state.policies : []).filter((row) => Number(row?.familyId) === familyId),
  ];
  return records.map((record) => recordTime(record, 'updatedAt', 'createdAt')).filter(Boolean).sort().at(-1) || '';
}

function stableResult(facts, provenance = {}, presentation = {}) {
  return { facts, provenance, presentation };
}

function safeSalesChatSources(sources = []) {
  const allowed = new Set(['kind', 'ref', 'title', 'url', 'provenance']);
  return (Array.isArray(sources) ? sources : []).slice(0, 12).map((source) => (
    Object.fromEntries(Object.entries(source || {}).flatMap(([key, value]) => (
      allowed.has(key) && ['string', 'number'].includes(typeof value)
        ? [[key, text(value).slice(0, 500)]]
        : []
    )))
  )).filter((source) => Object.keys(source).length);
}

function safeSalesChatHistory(history = []) {
  return (Array.isArray(history) ? history : []).slice(-12).flatMap((message) => {
    const role = text(message?.role);
    const content = text(message?.content).slice(0, 4_000);
    return ['user', 'assistant'].includes(role) && content ? [{ role, content }] : [];
  });
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
  authorizedFamilySalesDataLoader,
  buildFamilySalesChatContext = buildExistingFamilySalesChatContext,
  generateFamilySalesChatReply = generateExistingFamilySalesChatReply,
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
    const validPolicies = policies.filter((policy) => policyIsValid(policy, clock()));
    return stableResult(
      { familyId: id, activeMemberCount: members.length, policyCount: policies.length, validPolicyCount: validPolicies.length },
      {
        source: 'persistent_family_state',
        countedAt: clock().toISOString(),
        validPolicyDefinition: '综合保单状态、合同状态和效力状态排除失效、停效、中止、终止、退保、过期等业务状态，并按保障期间排除已到期保单。',
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
    let job = pendingReports.get(key);
    if (job) {
      job = await job;
      if (typeof reportQueue.getStatus === 'function') {
        const current = await reportQueue.getStatus({ familyId, jobType, dedupeKey: key, jobId: job?.jobId || job?.id || '' });
        const status = text(current?.status).toLowerCase();
        if (['completed', 'complete', 'failed', 'cancelled', 'canceled'].includes(status)) {
          pendingReports.delete(key);
          job = null;
        } else {
          job = { ...job, ...current };
          pendingReports.set(key, job);
        }
      }
    }
    if (!job) {
      const enqueue = typeof reportQueue.enqueueUnique === 'function'
        ? reportQueue.enqueueUnique.bind(reportQueue)
        : reportQueue.enqueue.bind(reportQueue);
      const queued = Promise.resolve(enqueue({ familyId, jobType, dedupeKey: key, reason }));
      pendingReports.set(key, queued);
      try {
        job = await queued;
        pendingReports.set(key, job);
      } catch (error) {
        pendingReports.delete(key);
        throw error;
      }
    }
    return stableResult(
      { status: 'processing', jobType, jobId: job?.jobId || job?.id || '', progress: Number(job?.progress) || 0 },
      { source: 'report_queue', reason, dedupeKey: key },
      { message: '报告正在生成，请稍后查看。' },
    );
  }

  async function viewReport(context, { collection, jobType, link }) {
    const { id, state } = await loadFamilyState(context?.familyId);
    const report = latestForFamily(state[collection], id);
    const sourceUpdatedAt = latestSourceUpdatedAt(state, id) || recordTime(report, 'sourceUpdatedAt', 'source_updated_at');
    const freshness = collection === 'familyReports'
      ? resolveFamilyPolicyAnalysisReportFreshness(report, { sourceUpdatedAt })
      : resolveFamilySalesReviewFreshness(report, { sourceUpdatedAt });
    if (freshness.status !== 'fresh') {
      return enqueueReport({ familyId: id, jobType, reason: freshness.status });
    }
    pendingReports.delete(`${jobType}:${id}`);
    const secureLink = typeof links[link] === 'function'
      ? links[link]({ familyId: id, internalUserId: context?.internalUserId })
      : '';
    return stableResult(
      {
        familyId: id,
        status: 'fresh',
        reportId: report.id ?? null,
        generatedAt: freshness.generatedAt,
        summary: safeSummary(report.summary || report.inputSummary || report.report?.summary),
      },
      { source: collection, sourceUpdatedAt },
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
    const familyId = positiveInteger(context?.familyId, 'familyId');
    const internalUserId = positiveInteger(context?.internalUserId, 'internalUserId');
    if (typeof authorizedFamilySalesDataLoader !== 'function') {
      return stableResult(
        { answer: '', status: 'unavailable' },
        { agent: 'existing_family_sales_chat', sources: [] },
        { message: '保险营销专家暂不可用，请稍后重试。' },
      );
    }
    const trusted = await authorizedFamilySalesDataLoader({ familyId, internalUserId });
    if (!trusted?.family || Number(trusted.family.id) !== familyId) return denial('AUTHORIZED_FAMILY_DATA_REQUIRED');
    const chatContext = buildFamilySalesChatContext({
      input: trusted.input || {},
      family: trusted.family,
      members: Array.isArray(trusted.members) ? trusted.members : [],
      policies: Array.isArray(trusted.policies) ? trusted.policies : [],
      familyReports: Array.isArray(trusted.familyReports) ? trusted.familyReports : [],
      familySalesReviews: Array.isArray(trusted.familySalesReviews) ? trusted.familySalesReviews : [],
      generatedAt: clock().toISOString(),
    });
    const result = await generateFamilySalesChatReply({
      context: chatContext,
      history: safeSalesChatHistory(trusted.history),
      question: text(context?.question).replace(/\s+/gu, ' ').slice(0, 2_000),
    });
    return stableResult(
      { answer: text(result?.content), generatedAt: text(result?.generatedAt) },
      {
        agent: 'existing_family_sales_chat',
        model: text(result?.model),
        sources: safeSalesChatSources(result?.sources),
      },
      { message: text(result?.content) },
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
import { resolveFamilyPolicyAnalysisReportFreshness } from './family-policy-analysis-report.service.mjs';
import { resolveFamilySalesReviewFreshness } from './family-sales-review.service.mjs';
import {
  buildFamilySalesChatContext as buildExistingFamilySalesChatContext,
  generateFamilySalesChatReply as generateExistingFamilySalesChatReply,
} from './family-sales-chat.service.mjs';
import { resolvePolicyValidityStatus } from '../src/policy-validity.mjs';
