import { DEFAULT_AGENT_RUNTIME_SETTINGS, normalizeAgentRuntimeSettings } from './agent-question-policy.service.mjs';

const PRODUCT_COMPARISON_PATTERN = /对比|比较|区别|差异|哪款|哪个好|\bVS\.?\b/iu;
const COMPARISON_PRONOUN_PATTERN = /^(?:他|它|这个产品|该产品|上述产品)(?=\s*(?:和|与|对比|比较|VS\.?))/iu;

function fallbackCandidateFromText(question) {
  const value = String(question || '').trim().slice(0, 1_000);
  let intent = 'chat';
  if (/(?:几|多少)(?:个|户)?家庭|家庭(?:总数|数量)/u.test(value)) intent = 'family_list';
  else if (/保障报告|保障分析|保障缺口/u.test(value)) intent = 'coverage_report';
  else if (/销售建议报告|销售报告/u.test(value)) intent = 'sales_report';
  else if (/上传|录入/u.test(value) && /保单|资料/u.test(value)) intent = 'upload_link';
  else if (/产品|条款|保险责任|等待期|免责|医疗|重疾|年金|寿险/iu.test(value)
    || PRODUCT_COMPARISON_PATTERN.test(value)) intent = 'insurance_product_knowledge';
  return { intent, question: value, confidence: 1, requestedOperation: 'read' };
}

function productNameFromReply(value) {
  return String(value || '').match(/《([^》\n]{2,200})》/u)?.[1]?.trim() || '';
}

function selectedCandidateIndex(value) {
  const match = String(value || '').trim().match(/^(?:选择|选|第)?\s*(\d{1,2})(?:\s*(?:个|项|款|号))?$/u);
  return match ? Number(match[1]) - 1 : -1;
}

function candidateProducts(interaction) {
  return (Array.isArray(interaction?.candidates) ? interaction.candidates : [])
    .map((item) => productNameFromReply(item?.label))
    .filter(Boolean)
    .slice(0, 20);
}

function resolvePreviousProduct(candidate, question, context) {
  const refersToPrevious = candidate?.contextRefs?.includes('previous_product')
    || (PRODUCT_COMPARISON_PATTERN.test(question) && COMPARISON_PRONOUN_PATTERN.test(question));
  if (!refersToPrevious) return { candidate };
  const previousProduct = String(context?.product?.productName || '').trim();
  if (!previousProduct) {
    return {
      clarification: {
        decision: 'clarify',
        interaction: {
          type: 'clarification',
          text: '我知道你想做产品对比，但当前会话里还没有可用的上一款产品。请先发第一款产品名称，或直接发送“产品A 对比 产品B”。',
        },
      },
    };
  }
  const productB = String(candidate?.entities?.productBText || '').trim();
  const resolvedQuestion = productB
    ? `${previousProduct} 对比 ${productB}`
    : String(question).replace(COMPARISON_PRONOUN_PATTERN, previousProduct);
  return {
    candidate: {
      ...candidate,
      intent: 'insurance_product_knowledge',
      question: resolvedQuestion,
      requestedOperation: 'read',
      entities: Object.fromEntries(Object.entries(candidate?.entities || {}).filter(([key]) => key !== 'productBText')),
      contextRefs: ['previous_product'],
    },
  };
}

export function createAgentConversationRuntime({
  conversationContext,
  hermesClient,
  directInterpreter,
  questionRouter,
  runtimeMode = 'hermes',
  now = Date.now,
  reportError = () => {},
} = {}) {
  if (!conversationContext || typeof conversationContext.loadContext !== 'function'
    || typeof conversationContext.commitContext !== 'function') {
    throw new TypeError('Agent conversation context is required');
  }
  if (!questionRouter || typeof questionRouter.route !== 'function') {
    throw new TypeError('Agent question router is required');
  }

  async function directCandidate({ question, history, settings }) {
    if (typeof directInterpreter === 'function') {
      try {
        return await directInterpreter({
          question,
          history,
          recentMessageLimit: settings.fallbackHistoryMessageLimit,
        });
      } catch {
        reportError('AGENT_DIRECT_INTERPRETER_FALLBACK');
      }
    }
    return fallbackCandidateFromText(question);
  }

  async function processMessage({ verifiedIdentity, channelEnvelope, runtimeSettings, refreshVerifiedIdentity } = {}) {
    const settings = normalizeAgentRuntimeSettings(runtimeSettings || DEFAULT_AGENT_RUNTIME_SETTINGS);
    const question = String(channelEnvelope?.message?.text || '').trim().slice(0, 1_000);
    if (!question) throw new TypeError('Agent message text is required');
    const identity = {
      tenantId: String(verifiedIdentity?.tenantId || 'default'),
      channel: String(channelEnvelope?.channel || ''),
      channelUserId: String(channelEnvelope?.channelUserId || ''),
      channelConversationId: String(channelEnvelope?.conversationId || 'direct'),
      internalUserId: Number(verifiedIdentity?.internalUserId),
    };
    const context = await conversationContext.loadContext({
      ...identity,
      productContextTtlMinutes: settings.productContextTtlMinutes,
    });
    const history = Array.isArray(context?.history) ? context.history : [];
    const selectedIndex = selectedCandidateIndex(question);
    const selectedProduct = selectedIndex >= 0 ? context?.productCandidates?.products?.[selectedIndex] : '';
    let candidate;
    let proposal;
    let semanticFallbackReason = '';
    let hermesUnavailable = false;
    let hermesSessionId = String(context?.hermesSessionId || '');
    let usedRuntime = 'direct';
    if (selectedProduct) {
      candidate = {
        intent: 'insurance_product_knowledge',
        question: context.productCandidates.question || question,
        confidence: 1,
        requestedOperation: 'read',
        entities: { productName: selectedProduct },
      };
    } else if (runtimeMode === 'hermes' && hermesClient && typeof hermesClient.runTurn === 'function') {
      usedRuntime = 'hermes';
      for (let attempt = 0; attempt < 2 && !candidate && !proposal; attempt += 1) {
        try {
          const interpreted = await hermesClient.runTurn({
            sessionId: hermesSessionId,
            question,
            safeRecentContext: { history },
            requestId: String(channelEnvelope?.messageRef || ''),
          });
          candidate = interpreted.candidate;
          proposal = interpreted.proposal;
          hermesSessionId = interpreted.sessionId;
        } catch (error) {
          reportError(String(error?.code || 'HERMES_PROVIDER_FAILED'));
          semanticFallbackReason = error?.code === 'HERMES_RESPONSE_INVALID'
            ? 'hermes_invalid_output'
            : 'hermes_unavailable';
        }
      }
      hermesUnavailable = !candidate && !proposal;
    }
    if (!selectedProduct && runtimeMode === 'hermes' && !candidate && !proposal) {
      usedRuntime = 'hermes';
      hermesUnavailable = true;
    }
    if (!candidate && !proposal && runtimeMode !== 'hermes') {
      const direct = await directCandidate({ question, history, settings });
      if (direct?.semanticContractVersion === 1) proposal = direct;
      else candidate = direct;
    }
    const resolved = candidate ? resolvePreviousProduct(candidate, question, context) : { candidate: null };
    async function ensureIdentityCurrent() {
      if (typeof refreshVerifiedIdentity !== 'function') return;
      const currentIdentity = await refreshVerifiedIdentity();
      if (Number(currentIdentity?.internalUserId) !== identity.internalUserId) {
        const error = new Error('AGENT_CONVERSATION_IDENTITY_CHANGED');
        error.code = 'AGENT_CONVERSATION_IDENTITY_CHANGED';
        error.status = 409;
        throw error;
      }
    }
    await ensureIdentityCurrent();
    let result;
    if (hermesUnavailable) {
      result = {
        decision: 'clarify',
        interaction: { type: 'clarification', text: 'Hermes 暂不可用，请稍后重试。' },
      };
    } else if (resolved.clarification) {
      result = resolved.clarification;
    } else if (proposal) {
      result = await questionRouter.route({
        internalUserId: identity.internalUserId,
        messageRef: String(channelEnvelope?.messageRef || ''),
        ...(channelEnvelope?.conversationId ? { conversationId: identity.channelConversationId } : {}),
        question,
        runtime: usedRuntime,
        proposal,
        ...(usedRuntime === 'direct' && semanticFallbackReason
          ? { fallbackReason: semanticFallbackReason }
          : {}),
      });
    } else {
      candidate = resolved.candidate;
      result = await questionRouter.route({
        internalUserId: identity.internalUserId,
        messageRef: String(channelEnvelope?.messageRef || ''),
        ...(channelEnvelope?.conversationId ? { conversationId: identity.channelConversationId } : {}),
        candidate,
      });
    }
    await ensureIdentityCurrent();
    const replyText = String(result?.interaction?.text || '').trim();
    const products = candidateProducts(result?.interaction);
    const isComparison = PRODUCT_COMPARISON_PATTERN.test(candidate?.question || question);
    const explicitProduct = !isComparison ? String(candidate?.entities?.productName || '').trim() : '';
    const canonicalProduct = !isComparison ? (productNameFromReply(replyText) || explicitProduct) : '';
    const updatedAt = Number(now());
    const nextHistory = [
      ...history,
      { role: 'user', content: question },
      ...(replyText ? [{ role: 'assistant', content: replyText }] : []),
    ].slice(-settings.fallbackHistoryMessageLimit);
    try {
      await conversationContext.commitContext({
        ...identity,
        conversationRef: context.conversationId,
        expectedVersion: context.version,
        productContextTtlMinutes: settings.productContextTtlMinutes,
        updatedAt,
        hermesSessionId,
        history: nextHistory,
        product: canonicalProduct
          ? { productName: canonicalProduct, updatedAt }
          : context.product,
        productCandidates: products.length
          ? { products, question, updatedAt }
          : context.productCandidates,
        question: candidate?.intent && candidate.intent !== 'chat' ? { candidate, updatedAt } : context.question,
      });
    } catch {
      reportError('AGENT_CONVERSATION_COMMIT_FAILED');
    }
    return { ...result, runtime: usedRuntime, ...(candidate ? { candidate } : {}) };
  }

  return { processMessage };
}
