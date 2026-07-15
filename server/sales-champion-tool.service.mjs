import { attachDomainAgentProvenance } from './domain-agent-tool-contract.service.mjs';

const ALLOWED_INTENTS = new Set([
  'view_sales_advice_report', 'sales_report', 'sales_coaching', 'chat',
]);
const ALLOWED_CONTEXT_KEYS = new Set([
  'internalUserId', 'intent', 'question', 'familyId', 'tool', 'history',
]);
const ALLOWED_TOOLS = new Set(['sales_report']);
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

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
