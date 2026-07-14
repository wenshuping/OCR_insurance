import { SEMANTIC_QUERY_ASPECTS } from './agent-semantic-contract.mjs';

const QUERY_ASPECTS = new Set(SEMANTIC_QUERY_ASPECTS);

function clean(value, limit = 200) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && normalized.length <= limit ? normalized : '';
}

function stableRetry() {
  return {
    decision: 'clarify',
    interaction: { type: 'clarification', text: '语义解析暂不可用，请稍后重试。' },
  };
}

function productCandidates(result) {
  const candidates = Array.isArray(result?.nextTaskState?.candidateSets?.product)
    ? result.nextTaskState.candidateSets.product.slice(0, 10)
    : [];
  return candidates.map((candidate, index) => ({
    ref: `choice_${index + 1}`,
    label: clean(candidate?.officialName) || `候选产品 ${index + 1}`,
  })).filter((candidate) => candidate.label);
}

function familyCandidates(result) {
  const candidates = Array.isArray(result?.nextTaskState?.candidateSets?.family)
    ? result.nextTaskState.candidateSets.family.slice(0, 10)
    : [];
  return candidates.map((_candidate, index) => ({
    ref: `choice_${index + 1}`,
    label: `候选家庭 ${index + 1}`,
  }));
}

function clarification(result, hasConversation) {
  const reason = clean(result?.decisionReason, 100);
  if (reason === 'entity_ambiguous' && result?.ambiguities?.includes('product')) {
    const candidates = productCandidates(result);
    return {
      decision: 'clarify',
      interaction: {
        type: 'clarification',
        text: hasConversation
          ? '找到多个可能的正式产品，请选择一项。'
          : '找到多个可能的正式产品，请回复完整名称。',
        ...(candidates.length ? { candidates } : {}),
      },
    };
  }
  if (reason === 'entity_ambiguous' && result?.ambiguities?.includes('family')) {
    const candidates = familyCandidates(result);
    return {
      decision: 'clarify',
      interaction: {
        type: 'clarification',
        text: hasConversation
          ? '找到多个已授权家庭，请选择一项。'
          : '找到多个已授权家庭，请回复完整名称。',
        ...(candidates.length ? { candidates } : {}),
      },
    };
  }
  if (reason === 'candidate_selection_expired') {
    return {
      decision: 'clarify',
      interaction: { type: 'clarification', text: '之前的候选已过期，请重新说明要查询的对象。' },
    };
  }
  if (result?.missingFields?.includes('product') || reason === 'product_required') {
    return {
      decision: 'clarify',
      interaction: { type: 'clarification', text: '请补充保险公司和保险产品的正式名称。' },
    };
  }
  if (result?.missingFields?.includes('family') || reason === 'family_required') {
    return {
      decision: 'clarify',
      interaction: { type: 'clarification', text: '请说明要查看哪个家庭。' },
    };
  }
  return {
    decision: 'clarify',
    interaction: { type: 'clarification', text: '请更明确地说明要查询的事项。' },
  };
}

function projectProduct(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const officialName = clean(value.officialName);
  const company = clean(value.company);
  const canonicalProductId = clean(value.canonicalProductId);
  if (!officialName || !company) return null;
  return { canonicalProductId, company, officialName };
}

function semanticContext(result) {
  const product = projectProduct(result?.resolvedEntities?.product);
  const queryAspects = (Array.isArray(result?.proposal?.queryAspects)
    ? result.proposal.queryAspects : [])
    .filter((value) => typeof value === 'string' && QUERY_ASPECTS.has(value));
  return {
    resolvedEntities: { ...(product ? { product } : {}) },
    queryAspects: [...new Set(queryAspects)].slice(0, 8),
  };
}

function stateChanged(previous, next) {
  return JSON.stringify(previous || {}) !== JSON.stringify(next || {});
}

export function createAgentSemanticQuestionRouter({
  legacyRouter,
  semanticResolver,
  conversationService,
} = {}) {
  if (typeof legacyRouter?.route !== 'function') throw new TypeError('legacyRouter.route is required');
  if (typeof semanticResolver?.resolve !== 'function') throw new TypeError('semanticResolver.resolve is required');
  if (typeof conversationService?.load !== 'function'
    || typeof conversationService?.save !== 'function') {
    throw new TypeError('conversationService load/save is required');
  }

  return {
    async route(input = {}) {
      if (input.candidate) return legacyRouter.route(input);

      let conversation;
      try {
        conversation = await conversationService.load({
          internalUserId: input.internalUserId,
          channel: 'dingtalk',
          conversationId: input.conversationId,
        });
      } catch {
        return stableRetry();
      }

      let resolved;
      try {
        resolved = await semanticResolver.resolve({
          internalUserId: input.internalUserId,
          question: input.question,
          runtime: input.runtime,
          proposal: input.proposal,
          context: { taskState: conversation.taskState },
        });
      } catch {
        return stableRetry();
      }

      const shouldSave = stateChanged(conversation.taskState, resolved?.nextTaskState);
      if (resolved?.decision !== 'execute') {
        if (shouldSave) {
          try {
            await conversationService.save({
              internalUserId: input.internalUserId,
              channel: 'dingtalk',
              conversationId: input.conversationId,
              expectedVersion: conversation.version,
              taskState: resolved.nextTaskState,
            });
          } catch {
            return stableRetry();
          }
        }
        if (resolved?.decision === 'retry_later') return stableRetry();
        if (resolved?.decision === 'reject') {
          return { decision: 'deny', interaction: { type: 'denied', text: '该请求不能执行。' } };
        }
        return clarification(resolved, Boolean(clean(input.conversationId, 200)));
      }

      if (!resolved.candidate) return stableRetry();
      const result = await legacyRouter.route({
        internalUserId: input.internalUserId,
        messageRef: input.messageRef,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        candidate: resolved.candidate,
        semanticContext: semanticContext(resolved),
      });
      if (shouldSave) {
        try {
          await conversationService.save({
            internalUserId: input.internalUserId,
            channel: 'dingtalk',
            conversationId: input.conversationId,
            expectedVersion: conversation.version,
            taskState: resolved.nextTaskState,
          });
        } catch {
          // A read may already have completed. Do not turn a successful answer into a false failure.
        }
      }
      return result;
    },
  };
}
