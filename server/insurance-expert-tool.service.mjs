import { attachDomainAgentProvenance } from './domain-agent-tool-contract.service.mjs';

const ALLOWED_INTENTS = new Set([
  'family_policy_summary',
  'family_summary',
  'view_family_coverage_report',
  'coverage_report',
  'insurance_product_knowledge',
]);
const ALLOWED_CONTEXT_KEYS = new Set([
  'internalUserId', 'intent', 'question', 'familyId',
  'resolvedProduct', 'resolvedProducts', 'queryAspects', 'tool',
]);
const ALLOWED_TOOLS = new Set(['family_summary', 'coverage_report', 'product_knowledge_search']);

function validateContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('insurance expert context is required');
  }
  if (!Number.isSafeInteger(value.internalUserId) || value.internalUserId <= 0) {
    throw new TypeError('insurance expert internalUserId is required');
  }
  if (!ALLOWED_INTENTS.has(value.intent)) {
    throw new TypeError('insurance expert intent is not allowed');
  }
  if (value.tool != null && !ALLOWED_TOOLS.has(value.tool)) {
    throw new TypeError('insurance expert tool is not allowed for intent');
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) => ALLOWED_CONTEXT_KEYS.has(key)));
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

export function createInsuranceExpertTool({ execute, timeoutMs = 30_000 } = {}) {
  if (typeof execute !== 'function') throw new TypeError('insurance expert execute is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TypeError('insurance expert timeoutMs is invalid');
  }

  async function askInsuranceExpertTool({ context } = {}) {
    const trustedContext = validateContext(context);
    const result = await withTimeout(
      () => execute(trustedContext.tool || trustedContext.intent, trustedContext),
      timeoutMs,
    );
    return attachDomainAgentProvenance(result, 'insurance_expert');
  }

  return Object.freeze({ askInsuranceExpertTool });
}
