import {
  AGENT_QUESTION_POLICIES,
  AGENT_QUESTION_POLICY_TOOLS,
  chooseAgentQuestionPolicy,
} from './agent-question-policy.service.mjs';

const DECISIONS = new Set(['execute', 'clarify', 'confirm', 'deny', 'open_web']);
const INTERACTIONS = new Set(['answer', 'clarification', 'confirmation', 'progress', 'secure_link', 'denied']);
const FAMILY_INTENTS = new Set(['family_summary', 'coverage_report', 'sales_report']);
const PRONOUN_PATTERN = /(?:这个家庭|刚才那家)/u;
const CONTEXT_TTL_MS = 5 * 60 * 1000;

function boundedString(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function normalizeIntent(value) {
  return boundedString(value, 80).toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeCandidate(candidate = {}) {
  const rawEntities = candidate?.entities && typeof candidate.entities === 'object' && !Array.isArray(candidate.entities)
    ? candidate.entities
    : {};
  const entities = {};
  for (const [key, value] of Object.entries(rawEntities).slice(0, 12)) {
    const normalizedKey = boundedString(key, 40);
    if (!normalizedKey || typeof value !== 'string') continue;
    entities[normalizedKey] = boundedString(value, 200);
  }
  return {
    intent: normalizeIntent(candidate?.intent),
    entities,
    contextRefs: (Array.isArray(candidate?.contextRefs) ? candidate.contextRefs : [])
      .filter((value) => typeof value === 'string')
      .map((value) => boundedString(value, 100))
      .filter(Boolean)
      .slice(0, 10),
    confidence: Math.min(1, Math.max(0, Number(candidate?.confidence) || 0)),
    requestedOperation: normalizeIntent(candidate?.requestedOperation) === 'write' ? 'write' : 'read',
    question: boundedString(candidate?.question, 1000),
  };
}

function normalizeFamilyName(value) {
  return boundedString(value, 200)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(/家庭$/u, '');
}

function ownedFamilies(state, internalUserId) {
  return (Array.isArray(state?.familyProfiles) ? state.familyProfiles : []).filter((family) => (
    Number(family?.ownerUserId || 0) === internalUserId &&
    String(family?.status || 'active') === 'active'
  ));
}

function isValidContext(context, now) {
  if (!context || (context.explicitlyConfirmed !== true && context.confirmed !== true)) return false;
  const expiresAt = context.expiresAt
    ? new Date(context.expiresAt).getTime()
    : new Date(context.confirmedAt || '').getTime() + CONTEXT_TTL_MS;
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

function genericFamilyClarification(candidates = []) {
  const interaction = {
    type: 'clarification',
    text: '请确认要查看哪个家庭。',
  };
  if (candidates.length > 1) {
    interaction.candidates = candidates.map((family, index) => ({
      ref: `family_${index + 1}`,
      label: `${boundedString(family.familyName, 40).slice(0, 1) || '同'}***`,
    }));
  }
  return { decision: 'clarify', interaction };
}

function resolveFamily({ candidate, conversationContext, families, now }) {
  if (PRONOUN_PATTERN.test(candidate.question)) {
    if (!isValidContext(conversationContext, now)) return { result: genericFamilyClarification() };
    const family = families.find((item) => Number(item.id) === Number(conversationContext.familyId));
    return family ? { family } : { result: genericFamilyClarification() };
  }

  const requestedName = normalizeFamilyName(candidate.entities.familyName);
  if (!requestedName) return { result: genericFamilyClarification() };
  const matches = families.filter((family) => normalizeFamilyName(family.familyName) === requestedName);
  if (matches.length === 1) return { family: matches[0] };
  return { result: genericFamilyClarification(matches) };
}

function safeFallback(operation) {
  return operation === 'write'
    ? AGENT_QUESTION_POLICIES.find((policy) => policy.key === 'unknown_write')
    : AGENT_QUESTION_POLICIES.find((policy) => policy.key === 'unknown_read');
}

function selectPolicy(candidate, published) {
  const policies = Array.isArray(published?.policies) ? published.policies : AGENT_QUESTION_POLICIES;
  try {
    return chooseAgentQuestionPolicy(candidate, policies);
  } catch {
    const exact = policies.find((policy) => (
      policy?.enabled !== false && normalizeIntent(policy?.intent) === candidate.intent
    ));
    if (exact) return { ...exact, unsafe: true };
    return { ...safeFallback(candidate.requestedOperation) };
  }
}

function publicResult(result, fallbackDecision = 'execute') {
  const decision = DECISIONS.has(result?.decision) ? result.decision : fallbackDecision;
  const requestedType = result?.interaction?.type;
  const type = INTERACTIONS.has(requestedType) ? requestedType : 'answer';
  return {
    decision,
    interaction: {
      ...(result?.interaction && typeof result.interaction === 'object' ? result.interaction : {}),
      type,
    },
  };
}

export function createAgentQuestionRouter({ store, handlers = {}, clock = () => new Date() } = {}) {
  if (!store || typeof store.load !== 'function') throw new TypeError('store with load() is required');

  async function route({ internalUserId, candidate: rawCandidate, messageRef, conversationContext } = {}) {
    const userId = Number(internalUserId);
    if (!Number.isInteger(userId) || userId <= 0) throw new TypeError('internalUserId is required');
    const normalizedMessageRef = boundedString(messageRef, 200);
    if (!normalizedMessageRef) throw new TypeError('messageRef is required');

    const candidate = normalizeCandidate(rawCandidate);
    const now = clock();
    const published = typeof store.getPublishedAgentQuestionPolicyVersion === 'function'
      ? await store.getPublishedAgentQuestionPolicyVersion()
      : null;
    const policy = selectPolicy(candidate, published);

    const finish = async (result) => {
      const safe = publicResult(result, result?.decision || 'deny');
      if (published?.version && typeof store.appendAgentRouteAuditEvent === 'function') {
        await store.appendAgentRouteAuditEvent({
          policyVersion: published.version,
          userId,
          messageRef: normalizedMessageRef,
          decision: safe.decision,
          actor: 'agent_question_router',
          createdAt: now.toISOString(),
          payload: { intent: candidate.intent, policyKey: policy?.key || '' },
        });
      }
      return safe;
    };

    const threshold = Math.min(1, Math.max(0, Number(policy?.confidenceThreshold) || 0));
    if (candidate.confidence < threshold) return finish(genericFamilyClarification());

    if (policy?.key === 'unknown_write' || policy?.decision === 'reject') {
      if (typeof store.appendAgentUnknownQuestion === 'function') {
        await store.appendAgentUnknownQuestion({
          userId,
          messageRef: normalizedMessageRef,
          question: candidate.question || '未提供问题',
          actor: 'agent_question_router',
          createdAt: now.toISOString(),
          payload: { intent: candidate.intent, requestedOperation: 'write' },
        });
      }
      return finish({ decision: 'deny', interaction: { type: 'denied', text: '该操作不能执行。' } });
    }

    if (policy?.key === 'unknown_read') {
      return finish({ decision: 'open_web', interaction: { type: 'secure_link', text: '请通过安全页面继续查询。' } });
    }

    if (policy?.unsafe || policy?.enabled === false || (policy?.tool && !AGENT_QUESTION_POLICY_TOOLS.includes(policy.tool))) {
      return finish({ decision: 'deny', interaction: { type: 'denied', text: '该请求当前不可用。' } });
    }

    const state = await store.load();
    let family = null;
    if (FAMILY_INTENTS.has(policy.intent) || ['family_summary', 'coverage_report', 'sales_report'].includes(policy.tool)) {
      const resolved = resolveFamily({
        candidate,
        conversationContext,
        families: ownedFamilies(state, userId),
        now,
      });
      if (resolved.result) return finish(resolved.result);
      family = resolved.family;
    }

    const handler = handlers?.[policy.handler];
    if (typeof handler !== 'function') {
      return finish({ decision: 'deny', interaction: { type: 'denied', text: '该请求当前不可用。' } });
    }

    const authorizedContext = {
      internalUserId: userId,
      ...(family ? { familyId: Number(family.id), family } : {}),
    };
    const handled = await handler({ candidate, policy, authorizedContext });
    const decision = policy.decision === 'propose' ? 'confirm' : 'execute';
    const interactionType = decision === 'confirm' ? 'confirmation' : 'answer';
    return finish(publicResult(handled, decision).interaction.type === 'answer'
      ? { ...handled, decision, interaction: { ...handled?.interaction, type: interactionType } }
      : { ...handled, decision });
  }

  return { route };
}
