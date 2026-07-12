import { createHash } from 'node:crypto';

import {
  AGENT_QUESTION_POLICIES,
  AGENT_QUESTION_POLICY_TOOLS,
  chooseAgentQuestionPolicy,
  validateAgentQuestionPolicy,
} from './agent-question-policy.service.mjs';

const DECISIONS = new Set(['execute', 'clarify', 'confirm', 'deny', 'open_web']);
const INTERACTIONS = new Set(['answer', 'clarification', 'confirmation', 'progress', 'secure_link', 'denied']);
const FAMILY_INTENTS = new Set(['family_summary', 'coverage_report', 'sales_report', 'sales_coaching']);
const AUDIT_ENTITY_KEYS = new Set(['familyName', 'familyRef', 'policyHint', 'sourceFamilyName', 'targetFamilyName']);
const PRONOUN_PATTERN = /(?:这个家庭|刚才那家)/u;
const CONTEXT_TTL_MS = 5 * 60 * 1000;

function boundedString(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function normalizeIntent(value) {
  return boundedString(value, 80).toLowerCase().replace(/[\s-]+/g, '_');
}

const AUDIT_INTENTS = new Set(AGENT_QUESTION_POLICIES.map((policy) => normalizeIntent(policy.intent)));

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

async function defaultFamilyResolver({ store, state, internalUserId }) {
  if (typeof store.listAuthorizedFamilyProfiles === 'function') {
    return store.listAuthorizedFamilyProfiles({ internalUserId });
  }
  const policyFamilyIds = new Set((Array.isArray(state?.policies) ? state.policies : [])
    .filter((policy) => Number(policy?.userId || 0) === internalUserId)
    .map((policy) => Number(policy?.familyId || 0))
    .filter(Boolean));
  return (Array.isArray(state?.familyProfiles) ? state.familyProfiles : []).filter((family) => (
    String(family?.status || 'active') === 'active' && (
      Number(family?.ownerUserId || 0) === internalUserId ||
      (!Number(family?.ownerUserId || 0) && policyFamilyIds.has(Number(family?.id || 0)))
    )
  ));
}

function isValidContext(context, now) {
  if (!context || (context.explicitlyConfirmed !== true && context.confirmed !== true)) return false;
  const expiresAt = context.expiresAt
    ? new Date(context.expiresAt).getTime()
    : new Date(context.confirmedAt || '').getTime() + CONTEXT_TTL_MS;
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

function opaqueFamilyRef(internalUserId, familyId) {
  return `family_${createHash('sha256').update(`${internalUserId}:${familyId}:agent-router`).digest('hex').slice(0, 16)}`;
}

function genericFamilyClarification(candidates = [], internalUserId = 0) {
  const interaction = {
    type: 'clarification',
    text: '请确认要查看哪个家庭。',
  };
  if (candidates.length > 0) {
    interaction.candidates = candidates.map((family) => {
      const discriminator = opaqueFamilyRef(internalUserId, family.id).slice(-4).toUpperCase();
      return {
        ref: opaqueFamilyRef(internalUserId, family.id),
        label: `候选家庭 ${discriminator}`,
      };
    });
  }
  return { decision: 'clarify', interaction };
}

function resolveFamily({ candidate, conversationContext, families, internalUserId, now }) {
  if (PRONOUN_PATTERN.test(candidate.question)) {
    if (!isValidContext(conversationContext, now)) return { result: genericFamilyClarification() };
    const family = families.find((item) => Number(item.id) === Number(conversationContext.familyId));
    return family ? { family } : { result: genericFamilyClarification() };
  }

  const requestedRef = candidate.entities.familyRef;
  if (requestedRef) {
    const family = families.find((item) => opaqueFamilyRef(internalUserId, item.id) === requestedRef);
    return family ? { family } : { result: genericFamilyClarification() };
  }
  const requestedName = normalizeFamilyName(candidate.entities.familyName);
  if (!requestedName) return { result: genericFamilyClarification() };
  const exactMatches = families.filter((family) => normalizeFamilyName(family.familyName) === requestedName);
  if (exactMatches.length === 1) return { family: exactMatches[0] };
  if (exactMatches.length > 1) return { result: genericFamilyClarification(exactMatches, internalUserId) };
  const matches = families.filter((family) => {
    const name = normalizeFamilyName(family.familyName);
    return requestedName.length >= 2 && Math.abs(name.length - requestedName.length) <= 4 && (
      name.startsWith(requestedName) || requestedName.startsWith(name) || name.endsWith(requestedName)
    );
  });
  return { result: genericFamilyClarification(matches, internalUserId) };
}

function safeFallback(operation) {
  return operation === 'write'
    ? AGENT_QUESTION_POLICIES.find((policy) => policy.key === 'unknown_write')
    : AGENT_QUESTION_POLICIES.find((policy) => policy.key === 'unknown_read');
}

function selectPolicy(candidate, published) {
  const policies = Array.isArray(published?.policies) ? published.policies : AGENT_QUESTION_POLICIES;
  const exact = published?.version
    ? policies.find((policy) => normalizeIntent(policy?.intent) === candidate.intent)
    : null;
  if (exact) {
    let valid = false;
    try {
      valid = validateAgentQuestionPolicy(exact);
    } catch {
      valid = false;
    }
    if (exact.enabled === false || !valid) {
      const operation = exact.operation === 'write' ? 'write' : 'read';
      return {
        policy: { ...safeFallback(operation) },
        policySource: 'built_in',
      };
    }
  }
  try {
    return {
      policy: chooseAgentQuestionPolicy(candidate, policies),
      policySource: published?.version ? 'published' : 'built_in',
    };
  } catch {
    const operation = exact?.operation === 'write' ? 'write' : candidate.requestedOperation;
    return {
      policy: { ...safeFallback(operation) },
      policySource: 'built_in',
    };
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

export function resolvePolicyExecutionDecision(policy = {}, candidate = {}, authResult = {}, mode = 'route') {
  const threshold = Math.min(1, Math.max(0, Number(policy.confidenceThreshold) || 0));
  if ((Number(candidate.confidence) || 0) < threshold) return { decision: 'clarify', result: 'low_confidence' };
  if (authResult.required === true && authResult.resolved !== true) return { decision: 'clarify', result: 'family_clarification' };
  if (policy.operation === 'write') return { decision: 'confirm', result: 'write_preview', previewOnly: true, mode };
  if (policy.decision === 'propose') return { decision: 'confirm', result: 'proposal_preview', previewOnly: true, mode };
  return { decision: 'execute', result: 'would_execute', previewOnly: mode === 'simulation', mode };
}

export async function simulateAgentQuestionDecision({ store, policyVersion, internalUserId = 1, candidate: rawCandidate, conversationContext, familyResolver, clock = () => new Date() } = {}) {
  if (!store || typeof store.load !== 'function') throw new TypeError('store with load() is required');
  const candidate = normalizeCandidate(rawCandidate);
  const published = policyVersion || (typeof store.getPublishedAgentQuestionPolicyVersion === 'function'
    ? await store.getPublishedAgentQuestionPolicyVersion()
    : null);
  const selected = selectPolicy(candidate, published);
  const policy = selected.policy;
  const policySource = policyVersion ? String(policyVersion.status) : selected.policySource === 'published' ? 'published' : 'built_in';
  const initialDecision = resolvePolicyExecutionDecision(policy, candidate, {}, 'simulation');
  if (initialDecision.result === 'low_confidence') {
    return { policy, policySource, ...initialDecision, explanation: `Confidence ${candidate.confidence} is below ${Number(policy?.confidenceThreshold) || 0}.` };
  }
  if (policy?.key === 'unknown_write' || policy?.decision === 'reject') {
    return { policy, policySource, decision: 'deny', result: policy?.key === 'unknown_write' ? 'unknown_write_denied' : 'policy_rejected', explanation: `${policy.key} would deny the request.` };
  }
  if (policy?.key === 'unknown_read') {
    return { policy, policySource, decision: 'open_web', result: 'unknown_read_fallback', explanation: `${policy.key} would use the secure web fallback.` };
  }
  if (policy?.unsafe || policy?.enabled === false || (policy?.tool && !AGENT_QUESTION_POLICY_TOOLS.includes(policy.tool))) {
    return { policy, policySource, decision: 'deny', result: 'unsafe_policy', explanation: `${policy.key} is unavailable.` };
  }
  let family = null;
  if (FAMILY_INTENTS.has(policy.intent) || ['family_summary', 'coverage_report', 'sales_report'].includes(policy.tool)) {
    const state = await store.load();
    const resolver = typeof familyResolver === 'function' ? familyResolver : defaultFamilyResolver;
    const families = await resolver({ store, state, internalUserId: Number(internalUserId), candidate });
    const resolved = resolveFamily({ candidate, conversationContext, families, internalUserId: Number(internalUserId), now: clock() });
    if (resolved.result) return { policy, policySource, decision: 'clarify', result: 'family_clarification', explanation: 'An authorized family could not be uniquely resolved.' };
    family = resolved.family;
  }
  const execution = resolvePolicyExecutionDecision(policy, candidate, { required: Boolean(family), resolved: Boolean(family) }, 'simulation');
  return {
    policy,
    policySource,
    ...execution,
    familyResolved: Boolean(family),
    explanation: execution.previewOnly ? `${policy.key} would require confirmation; no write was executed.` : `${policy.key} would execute.`,
  };
}

export function createAgentQuestionRouter({ store, handlers = {}, familyResolver, clock = () => new Date() } = {}) {
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
    const selected = selectPolicy(candidate, published);
    const policy = selected.policy;

    let authorizedResourceIds = [];
    const finish = async (result, resultCode = 'completed') => {
      const safe = publicResult(result, result?.decision || 'deny');
      const audit = {
        policyVersion: selected.policySource === 'published' ? published.version : null,
        policySource: selected.policySource,
        evaluatedPublishedVersion: published?.version || null,
        userId,
        messageRef: normalizedMessageRef,
        operation: policy?.operation || candidate.requestedOperation,
        candidate: {
          intent: AUDIT_INTENTS.has(candidate.intent) ? candidate.intent : 'unknown',
          entities: Object.fromEntries(Object.keys(candidate.entities)
            .filter((key) => AUDIT_ENTITY_KEYS.has(key))
            .map((key) => [key, '[redacted]'])),
          confidence: candidate.confidence,
        },
        policyKey: policy?.key || '',
        authorizedResourceIds,
        decision: safe.decision,
        fallback: policy?.key === 'unknown_read' || policy?.key === 'unknown_write',
        result: resultCode,
        actor: 'agent_question_router',
        createdAt: now.toISOString(),
      };
      if (typeof store.recordAgentRouteAudit === 'function') {
        await store.recordAgentRouteAudit(audit);
      } else if (published?.version && typeof store.appendAgentRouteAuditEvent === 'function') {
        await store.appendAgentRouteAuditEvent({
          policyVersion: audit.policyVersion,
          userId,
          messageRef: normalizedMessageRef,
          decision: safe.decision,
          actor: 'agent_question_router',
          createdAt: now.toISOString(),
          payload: audit,
        });
      } else {
        throw new Error('Agent route audit recorder is required for built-in policy routing');
      }
      return safe;
    };

    const initialDecision = resolvePolicyExecutionDecision(policy, candidate);
    if (initialDecision.result === 'low_confidence') {
      const familyRelated = FAMILY_INTENTS.has(policy?.intent) || ['family_summary', 'coverage_report', 'sales_report'].includes(policy?.tool);
      return finish(familyRelated
        ? genericFamilyClarification()
        : { decision: 'clarify', interaction: { type: 'clarification', text: '请更明确地说明想查询或办理的事项。' } }, 'low_confidence');
    }

    if (policy?.key === 'unknown_write') {
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
      return finish({ decision: 'deny', interaction: { type: 'denied', text: '该操作不能执行。' } }, 'unknown_write_denied');
    }

    if (policy?.decision === 'reject') {
      return finish({ decision: 'deny', interaction: { type: 'denied', text: '该请求不能执行。' } }, 'policy_rejected');
    }

    if (policy?.key === 'unknown_read') {
      return finish({ decision: 'open_web', interaction: { type: 'secure_link', text: '请通过安全页面继续查询。' } }, 'unknown_read_fallback');
    }

    if (policy?.unsafe || policy?.enabled === false || (policy?.tool && !AGENT_QUESTION_POLICY_TOOLS.includes(policy.tool))) {
      return finish({ decision: 'deny', interaction: { type: 'denied', text: '该请求当前不可用。' } }, 'unsafe_policy');
    }

    const state = await store.load();
    let family = null;
    if (FAMILY_INTENTS.has(policy.intent) || ['family_summary', 'coverage_report', 'sales_report'].includes(policy.tool)) {
      const resolver = typeof familyResolver === 'function' ? familyResolver : defaultFamilyResolver;
      const authorizedFamilies = await resolver({ store, state, internalUserId: userId });
      const resolved = resolveFamily({
        candidate,
        conversationContext,
        families: Array.isArray(authorizedFamilies) ? authorizedFamilies : [],
        internalUserId: userId,
        now,
      });
      if (resolved.result) return finish(resolved.result, 'family_clarification');
      family = resolved.family;
      authorizedResourceIds = [`family:${Number(family.id)}`];
    }

    const execution = resolvePolicyExecutionDecision(policy, candidate, { required: Boolean(family), resolved: Boolean(family) });
    if (execution.previewOnly && policy?.key !== 'transfer_preview') {
      return finish({ decision: execution.decision, interaction: { type: 'confirmation', text: '该操作需要确认后执行。' } }, execution.result);
    }

    const handler = handlers?.[policy.handler];
    if (typeof handler !== 'function') {
      return finish({ decision: 'deny', interaction: { type: 'denied', text: '该请求当前不可用。' } }, 'missing_handler');
    }

    const authorizedContext = {
      internalUserId: userId,
      intent: candidate.intent,
      question: candidate.question,
      ...(policy?.key === 'transfer_preview' ? { entities: candidate.entities } : {}),
      ...(family ? { familyId: Number(family.id) } : {}),
    };
    let handled;
    try {
      handled = await handler(authorizedContext);
    } catch {
      return finish({ decision: 'deny', interaction: { type: 'denied', text: '该请求当前不可用。' } }, 'handler_error');
    }
    return finish({ ...handled, decision: execution.decision }, 'handled');
  }

  return { route };
}
