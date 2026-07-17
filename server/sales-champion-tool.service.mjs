import { attachDomainAgentProvenance } from './domain-agent-tool-contract.service.mjs';
import { SEMANTIC_QUERY_ASPECTS } from './agent-semantic-contract.mjs';
import { redactDeepSeekDirectIdentifiers } from './deepseek-privacy-gateway.mjs';

const ALLOWED_INTENTS = new Set([
  'view_sales_advice_report', 'sales_report', 'sales_coaching', 'chat',
]);
const ALLOWED_CONTEXT_KEYS = new Set([
  'internalUserId', 'intent', 'question', 'familyId', 'tool', 'history',
  'productMentions', 'officialFactNeeds', 'insuranceExpertEvidence',
]);
const ALLOWED_TOOLS = new Set(['sales_report']);
const QUERY_ASPECTS = new Set(SEMANTIC_QUERY_ASPECTS);
const EVIDENCE_STATUSES = new Set(['verified', 'unavailable', 'unresolved']);
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

function safeText(value, limit) {
  return typeof value === 'string'
    ? redactDeepSeekDirectIdentifiers(value).trim().slice(0, limit)
    : '';
}

function normalizeProductMentions(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => safeText(item, 200))
    .filter(Boolean))].slice(0, 5);
}

function normalizeInsuranceEvidence(value) {
  return (Array.isArray(value) ? value : []).slice(0, 2).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const status = safeText(item.status, 40);
    if (!EVIDENCE_STATUSES.has(status)) return [];
    const products = (Array.isArray(item.products) ? item.products : []).slice(0, 5).flatMap((product) => {
      if (!product || typeof product !== 'object' || Array.isArray(product)) return [];
      const company = safeText(product.company, 200);
      const officialName = safeText(product.officialName, 200);
      return company && officialName ? [{ company, officialName }] : [];
    });
    const answer = status === 'verified' ? safeText(item.answer, 12_000) : '';
    return [{ status, products, ...(answer ? { answer } : {}) }];
  });
}

function validateContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('sales champion context is required');
  }
  if (!Number.isSafeInteger(value.internalUserId) || value.internalUserId <= 0) {
    throw new TypeError('sales champion internalUserId is required');
  }
  if (!ALLOWED_INTENTS.has(value.intent)) {
    throw new TypeError('sales champion intent is not allowed');
  }
  if (value.tool != null && !ALLOWED_TOOLS.has(value.tool)) {
    throw new TypeError('sales champion tool is not allowed for intent');
  }
  const trusted = Object.fromEntries(Object.entries(value).filter(([key]) => ALLOWED_CONTEXT_KEYS.has(key)));
  trusted.history = (Array.isArray(value.history) ? value.history : []).slice(-12).flatMap((message) => {
    const role = String(message?.role || '').trim();
    const content = String(message?.content || '').trim().slice(0, 4_000);
    return ['user', 'assistant'].includes(role) && content ? [{ role, content }] : [];
  });
  trusted.productMentions = normalizeProductMentions(value.productMentions);
  trusted.officialFactNeeds = [...new Set((Array.isArray(value.officialFactNeeds) ? value.officialFactNeeds : [])
    .filter((item) => typeof item === 'string' && QUERY_ASPECTS.has(item)))].slice(0, 8);
  trusted.insuranceExpertEvidence = normalizeInsuranceEvidence(value.insuranceExpertEvidence);
  return trusted;
}

async function withTimeout(operation, timeoutMs) {
  let timeoutId;
  try {
    return await Promise.race([
      operation(),
      new Promise((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(Object.assign(new Error('AGENT_TIMEOUT'), { code: 'AGENT_TIMEOUT', status: 504 }));
        }, timeoutMs);
        timeoutId.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createSalesChampionTool({ execute, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof execute !== 'function') throw new TypeError('sales champion execute is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError('sales champion timeoutMs is invalid');
  }

  async function askSalesChampionTool({ context } = {}) {
    const trustedContext = validateContext(context);
    const result = await withTimeout(
      () => execute(trustedContext.tool || trustedContext.intent, trustedContext),
      timeoutMs,
    );
    return attachDomainAgentProvenance(result, 'sales_champion');
  }

  return Object.freeze({ askSalesChampionTool });
}
