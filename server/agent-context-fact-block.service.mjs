import { redactDeepSeekDirectIdentifiers } from './deepseek-privacy-gateway.mjs';

const TASK_STATUSES = new Set(['active', 'completed', 'needs_clarification']);
const TASK_OWNERS = new Set(['hermes', 'insurance_expert', 'sales_champion', 'system']);
const FACT_SOURCES = new Set(['domain_agent', 'controlled_catalog', 'conversation_context']);

function text(value, limit) {
  return typeof value === 'string'
    ? redactDeepSeekDirectIdentifiers(value).trim().slice(0, limit)
    : '';
}

function finiteTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function normalizedProduct(value) {
  const officialName = text(value?.officialName || value?.productName, 300);
  if (!officialName) return null;
  const source = FACT_SOURCES.has(value?.source) ? value.source : 'conversation_context';
  const verifiedAt = finiteTimestamp(value?.verifiedAt || value?.updatedAt);
  return { officialName, source, ...(verifiedAt ? { verifiedAt } : {}) };
}

function normalizedConflicts(value) {
  return (Array.isArray(value) ? value : []).slice(0, 10).flatMap((item) => {
    const topic = text(item?.topic, 200);
    const sources = (Array.isArray(item?.sources) ? item.sources : []).slice(0, 6).flatMap((source) => {
      const sourceName = text(source?.source, 300);
      const conclusion = text(source?.conclusion, 1_000);
      return sourceName && conclusion ? [{ source: sourceName, conclusion }] : [];
    });
    return topic && sources.length >= 2 ? [{ topic, sources }] : [];
  });
}

export function normalizeAgentContextFactBlock(value = {}) {
  const goalQuestion = text(value?.goal?.question, 1_000);
  const status = TASK_STATUSES.has(value?.goal?.status) ? value.goal.status : 'active';
  const owner = TASK_OWNERS.has(value?.goal?.owner) ? value.goal.owner : 'hermes';
  const product = normalizedProduct(value?.verifiedEntities?.product);
  const candidates = (Array.isArray(value?.pendingClarification?.candidates)
    ? value.pendingClarification.candidates : [])
    .map((item) => text(item?.label || item, 300)).filter(Boolean).slice(0, 10);
  const pendingQuestion = text(value?.pendingClarification?.question, 1_000);
  return {
    version: 1,
    goal: { question: goalQuestion, status, owner },
    verifiedEntities: product ? { product } : {},
    ...(candidates.length ? {
      pendingClarification: { question: pendingQuestion, candidates },
    } : {}),
    conflicts: normalizedConflicts(value?.conflicts),
  };
}

export function compileAgentContextFactBlock({
  previous = null,
  currentQuestion = '',
  taskStatus = 'active',
  owner = 'hermes',
  product = null,
  productSource = 'conversation_context',
  productCandidates,
  updatedAt,
} = {}) {
  const prior = normalizeAgentContextFactBlock(previous || {});
  const currentProduct = normalizedProduct(product
    ? { ...product, source: productSource }
    : prior.verifiedEntities.product);
  const candidates = productCandidates === undefined
    ? prior.pendingClarification?.candidates || []
    : (Array.isArray(productCandidates?.products) ? productCandidates.products : []);
  const pendingQuestion = productCandidates === undefined
    ? prior.pendingClarification?.question || ''
    : productCandidates?.question || '';
  return normalizeAgentContextFactBlock({
    goal: {
      question: currentQuestion || prior.goal.question,
      status: taskStatus,
      owner,
    },
    verifiedEntities: currentProduct ? {
      product: {
        ...currentProduct,
        verifiedAt: currentProduct.verifiedAt || finiteTimestamp(updatedAt),
      },
    } : {},
    ...(candidates.length ? {
      pendingClarification: { question: pendingQuestion, candidates },
    } : {}),
    conflicts: prior.conflicts,
  });
}
