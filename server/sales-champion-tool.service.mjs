import { attachDomainAgentProvenance } from './domain-agent-tool-contract.service.mjs';
import { normalizeSalesKycState } from './agent-context-fact-block.service.mjs';
import { SEMANTIC_QUERY_ASPECTS } from './agent-semantic-contract.mjs';
import { redactDeepSeekDirectIdentifiers } from './deepseek-privacy-gateway.mjs';
import { evaluateSalesChampionRoute } from './sales-champion-router.service.mjs';
import { executeSalesChampionAtomicSkill } from './sales-champion-skill-executor.service.mjs';

const ALLOWED_INTENTS = new Set([
  'view_sales_advice_report', 'sales_report', 'sales_coaching', 'chat',
]);
const ALLOWED_CONTEXT_KEYS = new Set([
  'internalUserId', 'intent', 'question', 'familyId', 'tool', 'history',
  'productMentions', 'officialFactNeeds', 'insuranceExpertEvidence', 'resolvedProducts',
  'salesKycState',
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

function normalizeResolvedProducts(value) {
  return (Array.isArray(value) ? value : []).slice(0, 5).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const canonicalProductId = safeText(item.canonicalProductId, 200);
    const company = safeText(item.company, 200);
    const officialName = safeText(item.officialName, 200);
    return canonicalProductId && company && officialName
      ? [{ canonicalProductId, company, officialName }]
      : [];
  });
}

function mergeKycFacts(previous = [], current = []) {
  const groundedCurrent = (Array.isArray(current) ? current : [])
    .filter((fact) => !['advisor_estimate', 'advisor_inference'].includes(fact?.source));
  const replacedKeys = new Set(groundedCurrent.map((fact) => fact.key));
  return [...previous.filter((fact) => !replacedKeys.has(fact.key)), ...groundedCurrent]
    .slice(-24)
    .map(({ key, value, source }) => ({ key, value, source }));
}

function mergeKycLabels(previous = [], current = []) {
  const groundedCurrent = (Array.isArray(current) ? current : [])
    .filter((label) => label?.status === 'confirmed');
  const replacedDimensions = new Set(groundedCurrent.map((label) => label.dimension));
  return [...previous.filter((label) => !replacedDimensions.has(label.dimension)), ...groundedCurrent]
    .slice(-24)
    .map(({ dimension, value, status }) => ({ dimension, value, status }));
}

function insuranceEvidence(result, products = []) {
  const answer = safeText(result?.interaction?.text, 12_000);
  const certainty = safeText(result?.facts?.certainty, 40);
  if (result?.provenance?.domainAgent !== 'insurance_expert'
    || result?.interaction?.type !== 'answer' || !answer
    || (certainty && certainty !== 'supported')) return null;
  return {
    status: 'verified',
    products: products.map((product) => ({ company: product.company, officialName: product.officialName })),
    answer,
  };
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
  trusted.question = safeText(value.question, 2_000);
  trusted.history = (Array.isArray(value.history) ? value.history : []).slice(-20).flatMap((message) => {
    const role = String(message?.role || '').trim();
    const content = safeText(message?.content, 4_000);
    return ['user', 'assistant'].includes(role) && content ? [{ role, content }] : [];
  });
  trusted.productMentions = normalizeProductMentions(value.productMentions);
  trusted.officialFactNeeds = [...new Set((Array.isArray(value.officialFactNeeds) ? value.officialFactNeeds : [])
    .filter((item) => typeof item === 'string' && QUERY_ASPECTS.has(item)))].slice(0, 8);
  trusted.insuranceExpertEvidence = normalizeInsuranceEvidence(value.insuranceExpertEvidence);
  trusted.resolvedProducts = normalizeResolvedProducts(value.resolvedProducts);
  trusted.salesKycState = normalizeSalesKycState(value.salesKycState)
    || { caseVersion: 1, knownSlots: [], unknownSlots: [], facts: [], labels: [] };
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

export function createSalesChampionTool({
  execute,
  interpretTurn,
  askInsuranceExpert,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof execute !== 'function') throw new TypeError('sales champion execute is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError('sales champion timeoutMs is invalid');
  }

  async function askSalesChampionTool({ context } = {}) {
    const trustedContext = validateContext(context);
    let salesKycUpdate = trustedContext.salesKycState;
    const result = await withTimeout(
      async () => {
        if (trustedContext.intent !== 'sales_coaching' || typeof interpretTurn !== 'function') {
          return execute(trustedContext.tool || trustedContext.intent, trustedContext);
        }
        let proposal;
        try {
          proposal = await interpretTurn({
            question: trustedContext.question,
            history: trustedContext.history,
            activeCustomerKyc: trustedContext.salesKycState,
          });
        } catch (error) {
          if (!String(error?.code || '').startsWith('SALES_CHAMPION_INTERPRETER_')) throw error;
          console.warn('[sales-champion-tool] semantic interpretation unavailable; using full conversation', {
            code: String(error.code).slice(0, 100),
          });
          return execute(trustedContext.tool || trustedContext.intent, trustedContext);
        }
        const startsNewCustomerCase = proposal?.customerCase?.relation === 'new_customer';
        const activeCaseContext = startsNewCustomerCase
          ? { ...trustedContext, history: [] }
          : trustedContext;
        const baseKycState = startsNewCustomerCase
          ? { caseVersion: trustedContext.salesKycState.caseVersion + 1, knownSlots: [], unknownSlots: [], facts: [], labels: [] }
          : trustedContext.salesKycState;
        salesKycUpdate = {
          ...baseKycState,
          facts: mergeKycFacts(baseKycState.facts, proposal.kycFacts),
          labels: mergeKycLabels(baseKycState.labels, proposal.customerLabels),
        };
        const route = evaluateSalesChampionRoute({
          proposal,
          sourceTexts: [trustedContext.question, ...trustedContext.history.map((message) => message.content)],
          knownSlots: baseKycState.knownSlots,
          unknownSlots: baseKycState.unknownSlots,
          historicalFacts: baseKycState.facts,
          historicalLabels: baseKycState.labels,
          hasActiveCustomerContext: baseKycState.facts.length > 0 || baseKycState.labels.length > 0,
        });
        if (route.status === 'invalid_proposal') {
          salesKycUpdate = trustedContext.salesKycState;
          console.warn('[sales-champion-tool] semantic route invalid; using full conversation', {
            code: 'SALES_CHAMPION_INTERPRETER_INVALID_RESPONSE',
          });
          return execute(trustedContext.tool || trustedContext.intent, trustedContext);
        }
        if (route.navigation) {
          salesKycUpdate = {
            caseVersion: baseKycState.caseVersion,
            knownSlots: route.navigation.knownSlots || baseKycState.knownSlots,
            unknownSlots: route.navigation.unknownSlots || baseKycState.unknownSlots,
            facts: salesKycUpdate.facts,
            labels: salesKycUpdate.labels,
          };
        }

        const expertEvidence = [...trustedContext.insuranceExpertEvidence];
        const insuranceNeedResults = [];
        if (route.status === 'routed'
          && route.readiness?.insuranceExpertRequired
          && typeof askInsuranceExpert === 'function') {
          for (const need of proposal.insuranceNeeds) {
            if (need.type === 'coverage_gap') {
              if (!trustedContext.familyId) {
                insuranceNeedResults.push({ type: need.type, status: 'needs_family_or_policy_evidence' });
                continue;
              }
              const expertResult = await askInsuranceExpert({ context: {
                internalUserId: trustedContext.internalUserId,
                intent: 'coverage_report',
                tool: 'coverage_report',
                familyId: trustedContext.familyId,
                question: trustedContext.question,
              } });
              const evidence = insuranceEvidence(expertResult);
              if (evidence) expertEvidence.push(evidence);
              insuranceNeedResults.push({ type: need.type, status: evidence ? 'verified' : 'unavailable' });
              continue;
            }

            const products = trustedContext.resolvedProducts.slice(0, 2);
            if (!products.length) {
              insuranceNeedResults.push({ type: need.type, status: 'needs_resolved_product' });
              continue;
            }
            let verified = 0;
            for (const product of products) {
              const expertResult = await askInsuranceExpert({ context: {
                internalUserId: trustedContext.internalUserId,
                intent: 'insurance_product_knowledge',
                question: trustedContext.question,
                resolvedProduct: product,
                queryAspects: need.queryAspects.length
                  ? need.queryAspects
                  : trustedContext.officialFactNeeds,
              } });
              const evidence = insuranceEvidence(expertResult, [product]);
              if (evidence) {
                expertEvidence.push(evidence);
                verified += 1;
              }
            }
            insuranceNeedResults.push({
              type: need.type,
              status: verified === products.length ? 'verified' : 'unavailable',
            });
          }
        }

        const skillReferences = (route.trainingPacks || []).slice(0, 7);
        const salesTurn = {
          proposal,
          readiness: route.readiness,
          selection: route.selection,
          trainingPacks: skillReferences,
          skillReferences,
          executionPlan: route.executionPlan,
          informationFollowUp: route.informationFollowUp || { maxQuestions: 2, questions: [] },
          boundaryCandidates: route.boundaryCandidates || [],
          navigation: route.navigation || null,
          insuranceNeedResults,
        };
        const atomicResult = executeSalesChampionAtomicSkill({
          context: activeCaseContext,
          salesTurn,
        });
        if (atomicResult) return atomicResult;

        return execute(activeCaseContext.tool || activeCaseContext.intent, {
          ...activeCaseContext,
          insuranceExpertEvidence: expertEvidence,
          salesTurn,
        });
      },
      timeoutMs,
    );
    const nextResult = result && typeof result === 'object' ? {
      ...result,
      agentContextUpdate: {
        ...(result.agentContextUpdate || {}),
        salesKyc: salesKycUpdate,
      },
    } : result;
    return attachDomainAgentProvenance(nextResult, 'sales_champion');
  }

  return Object.freeze({ askSalesChampionTool });
}
