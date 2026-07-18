import { attachDomainAgentProvenance } from './domain-agent-tool-contract.service.mjs';
import { createInsuranceExpertAgentLoop } from './insurance-expert-agent-loop.service.mjs';
import { insuranceExpertSkillsForIntent } from './insurance-expert-agent-planner.service.mjs';

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
const RECOVERABLE_PLANNER_ERRORS = new Set([
  'INSURANCE_EXPERT_PLANNER_UNAVAILABLE',
  'INSURANCE_EXPERT_PLANNER_FAILED',
  'INSURANCE_EXPERT_PLANNER_TIMEOUT',
  'INSURANCE_EXPERT_PLAN_INVALID',
]);

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

export function createInsuranceExpertTool({
  execute,
  planner,
  timeoutMs = 30_000,
  skillRegistry = null,
} = {}) {
  if (typeof execute !== 'function') throw new TypeError('insurance expert execute is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TypeError('insurance expert timeoutMs is invalid');
  }

  async function askInsuranceExpertTool({ context } = {}) {
    const trustedContext = validateContext(context);
    const result = await withTimeout(
      async () => {
        let expertPlan = null;
        if (planner && typeof planner.plan === 'function') {
          try {
            expertPlan = await planner.plan(trustedContext);
          } catch (error) {
            if (!RECOVERABLE_PLANNER_ERRORS.has(error?.code)) throw error;
          }
        }
        if (!expertPlan) return execute(trustedContext.tool || trustedContext.intent, trustedContext);
        const roundResults = new Map();
        const executeRound = (round) => {
          if (!roundResults.has(round)) {
            roundResults.set(round, execute(trustedContext.tool || trustedContext.intent, {
              ...trustedContext,
              expertPlan: { ...expertPlan, maxRetrievalRounds: round },
            }));
          }
          return roundResults.get(round);
        };
        const loop = createInsuranceExpertAgentLoop({
          allowedSkills: insuranceExpertSkillsForIntent(trustedContext.intent, trustedContext, skillRegistry),
          async executeSkill({ skill, round }) {
            const domainResult = await executeRound(round);
            if (skill !== 'evidence_validation') return { executed: true };
            const completeness = domainResult?.retrieval?.completeness;
            const missingEvidence = Array.isArray(domainResult?.retrieval?.missingEvidence)
              ? domainResult.retrieval.missingEvidence : [];
            return {
              complete: completeness ? completeness === 'complete' : true,
              missingEvidence,
            };
          },
          async composeAnswer({ rounds }) {
            return executeRound(rounds);
          },
        });
        return loop.run({ context: trustedContext, plan: expertPlan });
      },
      timeoutMs,
    );
    return attachDomainAgentProvenance(result, 'insurance_expert');
  }

  return Object.freeze({ askInsuranceExpertTool });
}
