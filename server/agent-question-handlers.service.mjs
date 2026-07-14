const HANDLER_ACTIONS = Object.freeze({
  insurance_expert: Object.freeze(['family_policy_summary', 'family_summary', 'view_family_coverage_report', 'coverage_report', 'insurance_product_knowledge']),
  sales_champion: Object.freeze(['view_sales_advice_report', 'sales_report', 'sales_coaching', 'chat']),
  system: Object.freeze(['family_list', 'upload_link', 'system_help', 'unknown_read', 'unknown_write', 'transfer_preview', 'memory_proposal']),
});

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

function policyIsValid(policy = {}, now = new Date()) {
  return resolvePolicyRecordValidity(policy, { now }).valid;
}

function validTime(value) {
  const milliseconds = Date.parse(text(value));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function latestSourceUpdatedAt(state, familyId) {
  const records = [
    ...(Array.isArray(state.familyProfiles) ? state.familyProfiles : []).filter((row) => Number(row?.id) === familyId),
    ...(Array.isArray(state.familyMembers) ? state.familyMembers : []).filter((row) => Number(row?.familyId) === familyId),
    ...(Array.isArray(state.policies) ? state.policies : []).filter((row) => Number(row?.familyId) === familyId),
  ];
  const values = records.flatMap((record) => [record?.sourceUpdatedAt, record?.updatedAt, record?.createdAt])
    .map(validTime).filter((value) => value !== null);
  return values.length ? new Date(Math.max(...values)).toISOString() : '';
}

function stableResult(facts, provenance = {}, presentation = {}) {
  const message = text(presentation.message);
  const status = text(facts?.status).toLowerCase();
  let interaction;
  if (['processing', 'syncing'].includes(status)) {
    interaction = {
      type: 'progress',
      jobId: text(facts?.jobId),
      status,
      message,
      progress: Math.min(100, Math.max(0, Number(facts?.progress) || 0)),
    };
  } else if (text(presentation.secureLink)) {
    interaction = { type: 'secure_link', text: message, url: text(presentation.secureLink), action: 'open_web' };
  } else {
    interaction = { type: facts?.denied === true ? 'denied' : 'answer', text: message };
  }
  return { facts, provenance, presentation, interaction };
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

function safeLink(value, allowedOrigins = []) {
  const link = text(value);
  if (link.startsWith('/') && !link.startsWith('//')) return link;
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return allowedOrigins.includes(url.origin) ? url.toString() : '';
  } catch {
    return '';
  }
}

export function createAgentQuestionHandlers({
  store,
  reportQueue,
  productKnowledge,
  authorizedFamilyDataLoader,
  reloadAuthorizedFamilyData,
  authorizedFamilySalesDataLoader,
  buildFamilySalesChatContext = buildExistingFamilySalesChatContext,
  generateFamilySalesChatReply = generateExistingFamilySalesChatReply,
  links = {},
  allowedLinkOrigins = [],
  allowedKnowledgeOrigins = [],
  pendingJobTtlMs = 300_000,
  clock = () => new Date(),
} = {}) {
  if (!store || typeof store.load !== 'function') throw new TypeError('store with load() is required');
  const pendingReports = new Map();

  async function loadFamilyState(context) {
    const id = positiveInteger(context?.familyId, 'familyId');
    const internalUserId = positiveInteger(context?.internalUserId, 'internalUserId');
    if (typeof authorizedFamilyDataLoader !== 'function') return null;
    const data = await authorizedFamilyDataLoader({ familyId: id, internalUserId });
    if (!data || Number(data.family?.id || data.familyId) !== id) return null;
    return { id, state: data.state || data, data };
  }

  async function familySummary(context) {
    const loaded = await loadFamilyState(context);
    if (!loaded) return denial('AUTHORIZED_FAMILY_DATA_REQUIRED');
    const { id, state } = loaded;
    const members = (Array.isArray(state.familyMembers) ? state.familyMembers : [])
      .filter((member) => Number(member?.familyId) === id && text(member?.status || 'active') === 'active');
    const policies = (Array.isArray(state.policies) ? state.policies : [])
      .filter((policy) => Number(policy?.familyId) === id);
    const validity = policies.map((policy) => resolvePolicyRecordValidity(policy, { now: clock() }));
    const validPolicies = validity.filter((item) => item.valid);
    const asksWhy = /(?:为什(?:么)?|为啥|原因|怎么会)/u.test(text(context?.question));
    const reasonLabels = {
      business_status: '业务状态已标记为失效、停效、终止或退保等非有效状态',
      status_unconfirmed: '系统尚未确认有效状态',
      not_effective: '尚未到生效日期',
      coverage_ended: '保障期间已经结束',
    };
    const reasonCounts = validity.filter((item) => !item.valid).reduce((counts, item) => {
      counts[item.reason] = (counts[item.reason] || 0) + 1;
      return counts;
    }, {});
    const reasonText = Object.entries(reasonCounts)
      .map(([reason, count]) => `${count} 份${reasonLabels[reason] || '状态待核实'}`)
      .join('；');
    const message = asksWhy && policies.length
      ? `系统按保单业务状态、生效日期和保障期间判断：${reasonText || '当前状态仍需核实'}。如果记录与实际不符，请到网页修改保单状态或日期。`
      : `该家庭共有 ${policies.length} 份保单，其中 ${validPolicies.length} 份当前有效。`;
    return stableResult(
      { familyId: id, activeMemberCount: members.length, policyCount: policies.length, validPolicyCount: validPolicies.length },
      {
        source: 'persistent_family_state',
        countedAt: clock().toISOString(),
        validPolicyDefinition: '综合保单状态、合同状态和效力状态排除失效、停效、中止、终止、退保、过期等业务状态，并按保障期间排除已到期保单。',
      },
      { message },
    );
  }

  async function familyList(context) {
    const internalUserId = positiveInteger(context?.internalUserId, 'internalUserId');
    let families;
    if (typeof store.listAuthorizedFamilyProfiles === 'function') {
      families = await store.listAuthorizedFamilyProfiles({ internalUserId });
    } else {
      const state = await store.load();
      const policyFamilyIds = new Set((Array.isArray(state?.policies) ? state.policies : [])
        .filter((policy) => Number(policy?.userId || 0) === internalUserId)
        .map((policy) => Number(policy?.familyId || 0))
        .filter(Boolean));
      families = (Array.isArray(state?.familyProfiles) ? state.familyProfiles : []).filter((family) => (
        text(family?.status || 'active') === 'active' && (
          Number(family?.ownerUserId || 0) === internalUserId
          || (!Number(family?.ownerUserId || 0) && policyFamilyIds.has(Number(family?.id || 0)))
        )
      ));
    }
    const count = Array.isArray(families) ? families.length : 0;
    return stableResult(
      { familyCount: count },
      { source: 'authorized_family_profiles', countedAt: clock().toISOString() },
      { message: `当前共有 ${count} 个可访问家庭。` },
    );
  }

  async function enqueueReport({ familyId, internalUserId, jobType, reason }) {
    if (!reportQueue || (typeof reportQueue.enqueueUnique !== 'function' && typeof reportQueue.enqueue !== 'function')) {
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
      if (text(job?.status).toLowerCase() === 'completed') {
        if (clock().getTime() - Number(job?._cachedAt || 0) < Math.max(1, Number(pendingJobTtlMs) || 300_000)) {
          return stableResult(
            { status: 'syncing', jobType, jobId: job?.jobId || job?.id || '', progress: 100 },
            { source: 'report_queue', reason: 'awaiting_report_persistence', dedupeKey: key },
            { message: '报告已生成，正在同步，请稍后查看。' },
          );
        }
        pendingReports.delete(key);
        job = null;
      }
      if (job && typeof reportQueue.getStatus === 'function') {
        const current = await reportQueue.getStatus({ familyId, jobType, dedupeKey: key, jobId: job?.jobId || job?.id || '' });
        const status = text(current?.status).toLowerCase();
        if (['completed', 'complete'].includes(status)) {
          pendingReports.set(key, {
            ...job,
            ...current,
            status: 'completed',
            _cachedAt: clock().getTime(),
          });
          return stableResult(
            { status: 'syncing', jobType, jobId: current?.jobId || job?.jobId || job?.id || '', progress: 100 },
            { source: 'report_queue', reason: 'awaiting_report_persistence', dedupeKey: key },
            { message: '报告已生成，正在同步，请稍后查看。' },
          );
        }
        if (['failed', 'cancelled', 'canceled'].includes(status)) {
          pendingReports.delete(key);
          job = null;
        } else {
          job = { ...job, ...current, _cachedAt: job?._cachedAt || clock().getTime() };
          pendingReports.set(key, job);
        }
      } else if (job && clock().getTime() - Number(job?._cachedAt || 0) >= Math.max(1, Number(pendingJobTtlMs) || 300_000)) {
        pendingReports.delete(key);
        job = null;
      }
    }
    if (!job) {
      const enqueue = typeof reportQueue.enqueueUnique === 'function'
        ? reportQueue.enqueueUnique.bind(reportQueue)
        : reportQueue.enqueue.bind(reportQueue);
      const queueType = jobType === 'family_policy_analysis' ? 'family_report' : jobType;
      const queued = Promise.resolve(enqueue({ familyId, userId: internalUserId, jobType, type: queueType, dedupeKey: key, reason }))
        .then((result) => ({ ...result, _cachedAt: clock().getTime() }));
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

  async function viewReport(context, { collection, jobType, link }, reloaded = null) {
    const loaded = reloaded || await loadFamilyState(context);
    if (!loaded) return denial('AUTHORIZED_FAMILY_DATA_REQUIRED');
    const { id, state } = loaded;
    const report = latestForFamily(state[collection], id);
    const sourceTimes = [latestSourceUpdatedAt(state, id), report?.sourceUpdatedAt, report?.source_updated_at]
      .map(validTime).filter((value) => value !== null);
    const sourceUpdatedAt = sourceTimes.length ? new Date(Math.max(...sourceTimes)).toISOString() : '';
    const freshness = collection === 'familyReports'
      ? resolveFamilyPolicyAnalysisReportFreshness(report, { sourceUpdatedAt })
      : resolveFamilySalesReviewFreshness(report, { sourceUpdatedAt });
    if (freshness.status !== 'fresh') {
      const queued = await enqueueReport({ familyId: id, internalUserId: context?.internalUserId, jobType, reason: freshness.status });
      if (queued?.facts?.status === 'syncing' && typeof reloadAuthorizedFamilyData === 'function') {
        const data = await reloadAuthorizedFamilyData({ familyId: id, internalUserId: context?.internalUserId });
        if (data && Number(data.family?.id || data.familyId) === id) {
          const next = { id, state: data.state || data, data };
          const nextReport = latestForFamily(next.state[collection], id);
          const nextSourceAt = latestSourceUpdatedAt(next.state, id);
          const nextFreshness = collection === 'familyReports'
            ? resolveFamilyPolicyAnalysisReportFreshness(nextReport, { sourceUpdatedAt: nextSourceAt })
            : resolveFamilySalesReviewFreshness(nextReport, { sourceUpdatedAt: nextSourceAt });
          if (nextFreshness.status === 'fresh') return viewReport(context, { collection, jobType, link }, next);
        }
      }
      return queued;
    }
    pendingReports.delete(`${jobType}:${id}`);
    const secureLink = safeLink(typeof links[link] === 'function'
      ? links[link]({ familyId: id, internalUserId: context?.internalUserId })
      : '', allowedLinkOrigins);
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
    const productName = text(context?.productName).slice(0, 200);
    const result = productKnowledge && typeof productKnowledge.search === 'function'
      ? await productKnowledge.search({ question, productName, scope: 'public_read_only' })
      : null;
    const candidates = (Array.isArray(result?.candidates) ? result.candidates : []).slice(0, 10).flatMap((candidate) => {
      const ref = text(candidate?.ref).slice(0, 200);
      const label = text(candidate?.label).slice(0, 200);
      return ref && label ? [{ ref, label }] : [];
    });
    if (candidates.length) {
      const possibleCorrection = candidates.length === 1;
      return {
        facts: { certainty: possibleCorrection ? 'possible_match' : 'ambiguous', candidateCount: candidates.length },
        provenance: { source: 'public_product_knowledge', sources: [] },
        presentation: { message: possibleCorrection ? '没有找到完全一致的产品，请确认相近产品。' : '查到多个相似产品，请选择要查询的一款。' },
        interaction: {
          type: 'clarification',
          text: possibleCorrection
            ? '没有找到完全一致的产品，是否想查询下面这款？回复 1 确认：'
            : '查到多个相似产品，请选择要查询的一款：',
          candidates,
        },
      };
    }
    const sources = (Array.isArray(result?.sources) ? result.sources : [])
      .filter((source) => source?.verified === true)
      .map((source) => ({
        title: text(source.title),
        url: safeLink(source.url, allowedKnowledgeOrigins),
        provenance: text(source.provenance || source.sourceKind),
      }))
      .filter((source) => source.url && source.title.length <= 500 && source.provenance.length <= 200);
    if (!sources.length) {
      const guidance = result?.guidance === true ? text(result?.answer) : '';
      return stableResult(
        { certainty: 'unverified', answer: '' },
        { source: 'public_product_knowledge', sources: [] },
        { message: guidance || '当前没有可核验来源。请补充保险公司全称、保单上的正式险种名称、产品版本，或发送条款 PDF/官方投保链接后继续核验。' },
      );
    }
    const sourceLines = sources.slice(0, 3).map((source, index) => (
      `${index + 1}. [${source.title.replace(/[\[\]\n]/gu, '').slice(0, 100) || `官方来源 ${index + 1}`}](${source.url})`
    ));
    const answer = text(result?.answer);
    const publicAnswer = [answer, '#### 核验来源', ...sourceLines].filter(Boolean).join('\n\n');
    return stableResult(
      { certainty: 'supported', answer },
      { source: 'public_product_knowledge', sources },
      { message: publicAnswer },
    );
  }

  async function coach(context) {
    if (!await loadFamilyState(context)) return denial('AUTHORIZED_FAMILY_DATA_REQUIRED');
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
      case 'family_list': return familyList(context);
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
        const secureLink = safeLink(typeof links.upload === 'function' ? links.upload({ internalUserId }) : '', allowedLinkOrigins);
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
import { resolvePolicyRecordValidity } from '../src/policy-validity.mjs';
