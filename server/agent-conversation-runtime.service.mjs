import { DEFAULT_AGENT_RUNTIME_SETTINGS, normalizeAgentRuntimeSettings } from './agent-question-policy.service.mjs';
import { guardAgentFinalReply } from './agent-final-response-guard.service.mjs';

const PRODUCT_COMPARISON_PATTERN = /对比|比较|区别|差异|哪款|哪个好|\bVS\.?\b/iu;
const COMPARISON_PRONOUN_PATTERN = /^(?:他|它|这个产品|该产品|上述产品)(?=\s*(?:和|与|对比|比较|VS\.?))/iu;
const COMPARISON_IMPERATIVE_PATTERN = /^(?:你\s*)?(?:帮我|给我)?\s*(?:对比|比较|分析|看看)(?:一下)?\s*/u;
const PRODUCT_QUESTION_ASPECT_PATTERN = /保险责任|保障责任|保什么|保哪些|怎么赔|赔什么|优势|亮点|卖点|在售|停售|还能买|等待期|免责/u;

function fallbackCandidateFromText(question) {
  const value = String(question || '').trim().slice(0, 1_000);
  let intent = 'chat';
  if (/(?:几|多少)(?:个|户)?家庭|家庭(?:总数|数量)/u.test(value)) intent = 'family_list';
  else if (/保障报告|保障分析|保障缺口/u.test(value)) intent = 'coverage_report';
  else if (/销售建议报告|销售报告/u.test(value)) intent = 'sales_report';
  else if (/上传|录入/u.test(value) && /保单|资料/u.test(value)) intent = 'upload_link';
  else if (/保险|产品|条款|等待期|免责|医疗|重疾|年金|寿险/iu.test(value)
    || PRODUCT_COMPARISON_PATTERN.test(value)) intent = 'insurance_product_knowledge';
  return { intent, question: value, confidence: 1, requestedOperation: 'read' };
}

function productNameFromReply(value) {
  return String(value || '').match(/《([^》\n]{2,200})》/u)?.[1]?.trim() || '';
}

function candidateProduct(value) {
  const label = String(value || '').trim();
  if (!label) return null;
  const productName = productNameFromReply(label) || label;
  const company = productNameFromReply(label) ? label.split('《', 1)[0].trim() : '';
  return { label, productName, company };
}

function recentFormalProductName(history) {
  const messages = Array.isArray(history) ? history : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'assistant') continue;
    const names = [...new Set([...String(messages[index]?.content || '').matchAll(/《([^》\n]{2,200})》/gu)]
      .map((match) => String(match[1] || '').trim())
      .filter(Boolean))];
    if (names.length) return names.length === 1 ? names[0] : '';
  }
  return '';
}

function bindActiveProductReference(proposal, question, activeProductName) {
  const references = Array.isArray(proposal?.references) ? proposal.references : [];
  const bindsActiveProduct = (reference) => reference?.type === 'current_product'
    || (['comparison_left', 'comparison_right'].includes(reference?.type)
      && !String(reference?.rawText || '').trim());
  const activeTypes = new Set(references
    .filter(bindsActiveProduct)
    .map((reference) => reference?.type)
    .filter(Boolean));
  if (!activeProductName || !activeTypes.size
    || (activeTypes.has('comparison_left') && activeTypes.has('comparison_right'))) {
    return { question, proposal };
  }
  const activeOnRight = activeTypes.has('comparison_right');
  const resolvedQuestion = activeOnRight
    ? `${question} ${activeProductName}`
    : `${activeProductName} ${question}`;
  if (resolvedQuestion.length > 1_000) return { question, proposal };
  const activeMention = { type: 'product', rawText: activeProductName };
  const mentions = Array.isArray(proposal?.mentions) ? proposal.mentions : [];
  return {
    question: resolvedQuestion,
    proposal: {
      ...proposal,
      mentions: activeOnRight ? [...mentions, activeMention] : [activeMention, ...mentions],
      references: references.filter((reference) => !bindsActiveProduct(reference)),
    },
  };
}

function authoritativeProductName(toolResults) {
  const names = [...new Set((Array.isArray(toolResults) ? toolResults : []).flatMap((item) => {
    const interaction = item?.result?.interaction;
    if (item?.tool !== 'ask_insurance_expert'
      || item?.result?.status !== 'ok'
      || item?.result?.decision !== 'execute'
      || interaction?.delivery !== 'verbatim') return [];
    const officialName = String(item?.result?.resolvedEntities?.product?.officialName || '').trim();
    return officialName ? [officialName] : [];
  }))];
  return names.length === 1 ? names[0] : '';
}

function hermesUnavailableResult() {
  return {
    decision: 'deny',
    interaction: { type: 'denied', text: '语义服务暂不可用，请稍后重试。' },
    runtime: 'hermes',
  };
}

function selectedCandidateIndex(value) {
  const match = String(value || '').trim().match(/^(?:选择|选|第)?\s*(\d{1,2})(?:\s*(?:个|项|款|号))?$/u);
  return match ? Number(match[1]) - 1 : -1;
}

function selectedCandidateProduct(value, products) {
  const candidates = Array.isArray(products) ? products : [];
  const selectedIndex = selectedCandidateIndex(value);
  if (selectedIndex >= 0) return candidateProduct(candidates[selectedIndex]);
  const reply = String(value || '').trim();
  const formalName = productNameFromReply(reply) || reply;
  const selected = candidates.find((product) => {
    const candidate = candidateProduct(product);
    return candidate?.label === reply || candidate?.productName === formalName;
  });
  return candidateProduct(selected);
}

function candidateProducts(interaction) {
  return (Array.isArray(interaction?.candidates) ? interaction.candidates : [])
    .map((item) => String(item?.label || '').trim())
    .filter(Boolean)
    .slice(0, 20);
}

function pendingProductClarification(question, context, activeProductName) {
  if (!Array.isArray(context?.productCandidates?.products)
    || !context.productCandidates.products.length) return null;
  const candidate = fallbackCandidateFromText(question);
  if (candidate.intent !== 'insurance_product_knowledge') return null;
  const originalQuestion = String(context.productCandidates.question || '').trim();
  if (activeProductName && PRODUCT_COMPARISON_PATTERN.test(originalQuestion)) {
    candidate.question = `${activeProductName} 对比 ${question}`;
    return candidate;
  }
  const aspect = originalQuestion.match(PRODUCT_QUESTION_ASPECT_PATTERN)?.[0] || '';
  candidate.question = aspect && !question.includes(aspect) ? `${question} ${aspect}` : question;
  return candidate;
}

function resolvePreviousProduct(candidate, question, context) {
  const refersToPrevious = candidate?.contextRefs?.includes('previous_product')
    || (PRODUCT_COMPARISON_PATTERN.test(question)
      && (COMPARISON_PRONOUN_PATTERN.test(question) || COMPARISON_IMPERATIVE_PATTERN.test(question)));
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
  const comparisonTarget = COMPARISON_IMPERATIVE_PATTERN.test(question)
    ? String(question).replace(COMPARISON_IMPERATIVE_PATTERN, '').trim()
    : '';
  const resolvedQuestion = productB
    ? `${previousProduct} 对比 ${productB}`
    : comparisonTarget
      ? `${previousProduct} 对比 ${comparisonTarget}`
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
  agentLoopClient,
  toolCapabilityService,
  toolGatewayUrl,
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

  async function processMessage({ verifiedIdentity, channelEnvelope, runtimeSettings, refreshVerifiedIdentity, toolCapability = '' } = {}) {
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
    if (runtimeMode === 'hermes'
      && typeof agentLoopClient?.runTurn !== 'function'
      && typeof hermesClient?.runTurn !== 'function') {
      reportError('HERMES_CLIENT_UNAVAILABLE');
      return hermesUnavailableResult();
    }
    const activeProductName = (
      String(context?.product?.productName || '').trim() || recentFormalProductName(history)
    ).slice(0, 200);
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
    async function commitAgentReply(replyText, agentLoopSessionId, toolResults = []) {
      const updatedAt = Number(now());
      const productName = authoritativeProductName(toolResults);
      const recoveredProduct = !context.product && activeProductName
        ? { productName: activeProductName, updatedAt }
        : null;
      try {
        await conversationContext.commitContext({
          ...identity,
          conversationRef: context.conversationId,
          expectedVersion: context.version,
          productContextTtlMinutes: settings.productContextTtlMinutes,
          updatedAt,
          hermesSessionId: context.hermesSessionId,
          agentLoopSessionId,
          history: [
            ...history,
            { role: 'user', content: question },
            ...(replyText ? [{ role: 'assistant', content: replyText }] : []),
          ].slice(-settings.fallbackHistoryMessageLimit),
          product: productName ? { productName, updatedAt } : (context.product || recoveredProduct),
          productCandidates: context.productCandidates,
          question: context.question,
        });
      } catch {
        reportError('AGENT_CONVERSATION_COMMIT_FAILED');
      }
    }
    let agentLoopFallbackReason = runtimeMode === 'hermes'
      && typeof agentLoopClient?.runTurn !== 'function'
      && typeof hermesClient?.runTurn !== 'function'
      ? 'hermes_unavailable'
      : '';
    let agentLoopCandidate;
    let agentLoopProposal;
    let agentLoopSessionId = String(context?.agentLoopSessionId || '');
    if (runtimeMode === 'hermes'
      && typeof hermesClient?.runTurn !== 'function'
      && agentLoopClient
      && typeof agentLoopClient.runTurn === 'function') {
      try {
        await ensureIdentityCurrent();
        const agentResult = await agentLoopClient.runTurn({
          sessionId: String(context?.agentLoopSessionId || ''),
          question,
          capability: toolCapability,
          gatewayUrl: toolGatewayUrl,
          safeRecentContext: {
            history,
            activeEntities: activeProductName
              ? { product: { officialName: activeProductName } }
              : {},
          },
          requestId: String(channelEnvelope?.messageRef || ''),
        });
        await ensureIdentityCurrent();
        const finalReply = String(agentResult?.finalReply || '').trim();
        if (!finalReply) throw Object.assign(new Error('HERMES_RESPONSE_INVALID'), { code: 'HERMES_RESPONSE_INVALID' });
        const usage = toolCapability && typeof toolCapabilityService?.inspect === 'function'
          ? toolCapabilityService.inspect(toolCapability)
          : null;
        agentLoopSessionId = String(agentResult.sessionId || agentLoopSessionId);
        if (Number(usage?.callCount || 0) > 0) {
          const replyText = guardAgentFinalReply({ finalReply, toolResults: usage?.toolResults }).reply;
          await commitAgentReply(replyText, agentLoopSessionId, usage?.toolResults);
          return {
            decision: 'execute',
            interaction: { type: 'answer', text: replyText },
            runtime: 'hermes',
          };
        }
        reportError('HERMES_RESPONSE_INVALID');
        return hermesUnavailableResult();
      } catch (error) {
        if (error?.code === 'AGENT_CONVERSATION_IDENTITY_CHANGED') throw error;
        reportError(String(error?.code || 'HERMES_PROVIDER_FAILED'));
        return hermesUnavailableResult();
      }
    }
    const selectedProduct = selectedCandidateProduct(question, context?.productCandidates?.products);
    let candidate = agentLoopCandidate;
    let proposal = agentLoopProposal;
    let semanticFallbackReason = agentLoopFallbackReason;
    let hermesSessionId = String(context?.hermesSessionId || '');
    let usedRuntime = 'direct';
    if (selectedProduct) {
      proposal = undefined;
      candidate = {
        intent: 'insurance_product_knowledge',
        question: context.productCandidates.question || question,
        confidence: 1,
        requestedOperation: 'read',
        entities: {
          productName: selectedProduct.productName,
          ...(selectedProduct.company ? { productCompany: selectedProduct.company } : {}),
        },
      };
    } else if (runtimeMode === 'hermes' && hermesClient && typeof hermesClient.runTurn === 'function') {
      usedRuntime = 'hermes';
      try {
        let interpreted;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            interpreted = await hermesClient.runTurn({
              sessionId: attempt === 0 ? hermesSessionId : '',
              question,
              safeRecentContext: { history },
              requestId: String(channelEnvelope?.messageRef || ''),
            });
            break;
          } catch (error) {
            const retryable = ['HERMES_SESSION_NOT_FOUND', 'HERMES_RESPONSE_INVALID', 'HERMES_PROVIDER_FAILED']
              .includes(String(error?.code || ''));
            if (attempt > 0 || !retryable) throw error;
            reportError(`HERMES_RETRY_${String(error.code)}`);
          }
        }
        candidate = interpreted.candidate;
        proposal = interpreted.proposal;
        hermesSessionId = interpreted.sessionId;
      } catch (error) {
        reportError(String(error?.code || 'HERMES_PROVIDER_FAILED'));
        return hermesUnavailableResult();
      }
    }
    if (!candidate && !proposal) {
      const direct = await directCandidate({ question, history, settings });
      if (direct?.semanticContractVersion === 1) proposal = direct;
      else candidate = direct;
      usedRuntime = 'direct';
    }
    const clarificationCandidate = pendingProductClarification(question, context, activeProductName);
    if (clarificationCandidate && (candidate?.intent === 'chat' || proposal?.intent === 'chat')) {
      candidate = clarificationCandidate;
      proposal = undefined;
      usedRuntime = 'direct';
    }
    const resolved = candidate ? resolvePreviousProduct(candidate, question, context) : { candidate: null };
    await ensureIdentityCurrent();
    let result;
    if (resolved.clarification) {
      result = resolved.clarification;
    } else if (proposal) {
      const bound = bindActiveProductReference(proposal, question, activeProductName);
      result = await questionRouter.route({
        internalUserId: identity.internalUserId,
        messageRef: String(channelEnvelope?.messageRef || ''),
        conversationHistory: history,
        ...(channelEnvelope?.conversationId ? { conversationId: identity.channelConversationId } : {}),
        question: bound.question,
        runtime: usedRuntime,
        proposal: bound.proposal,
        ...(usedRuntime === 'direct' && semanticFallbackReason
          ? { fallbackReason: semanticFallbackReason }
          : {}),
      });
    } else {
      candidate = resolved.candidate;
      result = await questionRouter.route({
        internalUserId: identity.internalUserId,
        messageRef: String(channelEnvelope?.messageRef || ''),
        conversationHistory: history,
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
        agentLoopSessionId,
        history: nextHistory,
        product: canonicalProduct
          ? { productName: canonicalProduct, updatedAt }
          : (context.product || (activeProductName ? { productName: activeProductName, updatedAt } : null)),
        productCandidates: products.length
          ? { products, question, updatedAt }
          : (selectedProduct || clarificationCandidate) ? null : context.productCandidates,
        question: candidate?.intent && candidate.intent !== 'chat' ? { candidate, updatedAt } : context.question,
      });
    } catch {
      reportError('AGENT_CONVERSATION_COMMIT_FAILED');
    }
    return { ...result, runtime: usedRuntime, ...(candidate ? { candidate } : {}) };
  }

  return { processMessage };
}
