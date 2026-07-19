import { DEFAULT_AGENT_RUNTIME_SETTINGS, normalizeAgentRuntimeSettings } from './agent-question-policy.service.mjs';
import { guardAgentFinalReply } from './agent-final-response-guard.service.mjs';
import { compileAgentContextFactBlock } from './agent-context-fact-block.service.mjs';
import { canonicalProductIdFromOfficialProduct } from './canonical-product-id.mjs';
import { preparseAgentMessage } from './agent-semantic-preparser.mjs';

const PRODUCT_COMPARISON_PATTERN = /对比|比较|区别|差异|哪款|哪个好|\bVS\.?\b/iu;
const COMPARISON_PRONOUN_PATTERN = /^(?:他|它|这个产品|该产品|上述产品)(?=\s*(?:和|与|对比|比较|VS\.?))/iu;
const COMPARISON_IMPERATIVE_PATTERN = /^(?:你\s*)?(?:帮我|给我)?\s*(?:对比|比较|分析|看看)(?:一下)?\s*/u;
const PRODUCT_QUESTION_ASPECT_PATTERN = /产品责任|保险责任|保障责任|保什么|保哪些|怎么赔|赔什么|优势|亮点|卖点|在售|停售|还能买|等待期|免责/u;
const QUESTION_CONTENT_PATTERN = /(?:计划|方案|分别|各自|每个|是啥|是什么|有哪些|有什么|包含|包括|怎么|多少|吗|呢|\?)/u;
const ONLINE_SEARCH_CANDIDATE_LABEL = '以上都不是，联网查询';

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
  const stored = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const label = String(stored.label || value || '').trim();
  if (stored.ref === 'search_online' || label === ONLINE_SEARCH_CANDIDATE_LABEL) return null;
  if (!label) return null;
  const productName = String(stored.officialName || stored.productName || productNameFromReply(label) || label).trim();
  const company = String(stored.company || (productNameFromReply(label) ? label.split('《', 1)[0].trim() : '')).trim();
  const canonicalProductId = String(stored.canonicalProductId
    || canonicalProductIdFromOfficialProduct({ company, productName })).trim();
  return { ...stored, label, productName, company, canonicalProductId };
}

function recentFormalProduct(history) {
  const messages = Array.isArray(history) ? history : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'assistant') continue;
    const content = String(messages[index]?.content || '');
    const formalNames = [...new Set([...content.matchAll(/《([^》\n]{2,200})》/gu)]
      .map((match) => String(match[1] || '').trim()).filter(Boolean))];
    const match = content.match(/^\s*(?:#{1,6}\s*)?([^《》\n]{1,100}?)\s*《([^》\n]{2,200})》/u);
    if (!match || formalNames.length !== 1) continue;
    const company = String(match[1] || '').trim();
    const productName = String(match[2] || '').trim();
    if (!company || company.length > 50 || /^\d+[.、)]/u.test(company) || /[，。！？：:；]/u.test(company)) continue;
    return candidateProduct({
      label: `${company}《${productName}》`,
      company,
      officialName: productName,
    });
  }
  return null;
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

function authoritativeProduct(toolResults) {
  const products = (Array.isArray(toolResults) ? toolResults : []).flatMap((item) => {
    const interaction = item?.result?.interaction;
    if (item?.tool !== 'ask_insurance_expert'
      || item?.result?.status !== 'ok'
      || item?.result?.decision !== 'execute'
      || interaction?.delivery !== 'verbatim') return [];
    const product = candidateProduct(item?.result?.resolvedEntities?.product);
    return product ? [product] : [];
  });
  const unique = products.filter((product, index) => products.findIndex((candidate) => (
    candidate.canonicalProductId === product.canonicalProductId
      && candidate.company === product.company
      && candidate.productName === product.productName
  )) === index);
  return unique.length === 1 ? unique[0] : null;
}

function rememberedProduct(product, updatedAt) {
  const candidate = candidateProduct(product);
  if (!candidate) return null;
  return {
    productName: candidate.productName,
    ...(candidate.company ? { company: candidate.company } : {}),
    ...(candidate.canonicalProductId ? { canonicalProductId: candidate.canonicalProductId } : {}),
    updatedAt,
  };
}

function authoritativeToolInteraction(toolResults) {
  const results = Array.isArray(toolResults) ? toolResults : [];
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index]?.result;
    const interaction = result?.interaction;
    const text = String(interaction?.text || '').trim();
    if (!text || !['ok', 'needs_clarification', 'confirmation_required', 'forbidden'].includes(result?.status)) continue;
    return {
      decision: result?.decision || (result.status === 'needs_clarification' ? 'clarify' : 'execute'),
      interaction: { ...interaction, text },
    };
  }
  return null;
}

function hermesUnavailableResult(errorCode = 'HERMES_PROVIDER_FAILED') {
  const retryable = [
    'HERMES_PROVIDER_FAILED', 'HERMES_TIMEOUT', 'HERMES_RESPONSE_INVALID',
    'HERMES_SESSION_NOT_FOUND', 'HERMES_CIRCUIT_OPEN',
  ].includes(errorCode);
  return {
    decision: 'deny',
    interaction: { type: 'denied', text: '语义服务暂不可用，请稍后重试。' },
    runtime: 'hermes',
    recovery: {
      status: 'failed', errorCode, retryable,
      nextAction: retryable ? 'retry_same_request' : 'check_service_configuration',
    },
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

function selectedOnlineSearch(value, products) {
  const candidates = Array.isArray(products) ? products : [];
  const selectedIndex = selectedCandidateIndex(value);
  const selected = selectedIndex >= 0
    ? candidates[selectedIndex]
    : candidates.find((candidate) => String(candidate?.label || candidate || '').trim() === String(value || '').trim());
  const label = String(selected?.label || selected || '').trim();
  return selected?.ref === 'search_online' || label === ONLINE_SEARCH_CANDIDATE_LABEL;
}

function candidateProducts(interaction) {
  return (Array.isArray(interaction?.candidates) ? interaction.candidates : [])
    .map((item) => {
      const label = String(item?.label || '').trim();
      if (item?.ref === 'search_online' || label === ONLINE_SEARCH_CANDIDATE_LABEL) {
        return { ref: 'search_online', label: ONLINE_SEARCH_CANDIDATE_LABEL };
      }
      const product = candidateProduct(item);
      if (!product) return null;
      return {
        ...(String(item?.ref || '').trim() ? { ref: String(item.ref).trim() } : {}),
        label: product.label,
        company: product.company,
        officialName: product.productName,
        canonicalProductId: product.canonicalProductId,
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

function selectedProductQuestion(originalQuestion, selectedProduct) {
  const original = String(originalQuestion || '').trim().slice(0, 1_000);
  const product = String(selectedProduct?.productName || selectedProduct || '').trim();
  if (!product) return original;
  const aspect = original.match(PRODUCT_QUESTION_ASPECT_PATTERN)?.[0] || '';
  if (!original || original === product || product.includes(original)) return product;
  if (original.includes(product)) return original;
  if (!aspect && QUESTION_CONTENT_PATTERN.test(original)) return `${product} ${original}`;
  if (!aspect) return product;
  return `${product}${aspect}`;
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
    const conversationSalesKyc = context?.factBlock?.salesKyc || null;
    const agentLoopMode = runtimeMode === 'agent_loop'
      || (runtimeMode === 'hermes' && typeof agentLoopClient?.runTurn === 'function'
        && typeof hermesClient?.runTurn !== 'function');
    const semanticMode = runtimeMode === 'semantic'
      || (runtimeMode === 'hermes' && !agentLoopMode);
    if ((agentLoopMode && typeof agentLoopClient?.runTurn !== 'function')
      || (semanticMode && typeof hermesClient?.runTurn !== 'function')) {
      reportError('HERMES_CLIENT_UNAVAILABLE');
      return hermesUnavailableResult('HERMES_CLIENT_UNAVAILABLE');
    }
    const storedProduct = candidateProduct(context?.product);
    const recentProduct = recentFormalProduct(history);
    const activeProductName = String(storedProduct?.productName || recentProduct?.productName || '').trim().slice(0, 200);
    const hasStoredProductIdentity = String(context?.product?.company || '').trim()
      && String(context?.product?.canonicalProductId || '').trim();
    const confirmedActiveProduct = hasStoredProductIdentity && storedProduct
      ? {
        canonicalProductId: storedProduct.canonicalProductId,
        company: storedProduct.company,
        officialName: storedProduct.productName,
      }
      : recentProduct?.productName === activeProductName && recentProduct.company && recentProduct.canonicalProductId
        ? {
          canonicalProductId: recentProduct.canonicalProductId,
          company: recentProduct.company,
          officialName: recentProduct.productName,
        }
        : null;
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
      const product = authoritativeProduct(toolResults);
      const candidateToolResult = [...toolResults].reverse()
        .find((item) => Array.isArray(item?.result?.interaction?.candidates));
      const salesToolResult = [...toolResults].reverse()
        .find((item) => item?.tool === 'ask_sales_champion');
      const toolInteraction = candidateToolResult?.result?.interaction;
      const products = candidateProducts(toolInteraction);
      const candidateQuestion = rejectsProductCandidates
        ? String(context?.productCandidates?.question || question).trim().slice(0, 1_000)
        : question;
      const pendingSalesQuestion = products.length && candidateToolResult?.tool === 'ask_sales_champion'
        ? {
          candidate: {
            intent: 'sales_coaching',
            question: candidateQuestion,
            confidence: 1,
            requestedOperation: 'read',
          },
          updatedAt,
        }
        : null;
      const recoveredProduct = !context.product && confirmedActiveProduct
        ? rememberedProduct(confirmedActiveProduct, updatedAt)
        : !context.product && activeProductName
          ? { productName: activeProductName, updatedAt }
        : null;
      const committedProduct = product ? rememberedProduct(product, updatedAt) : (context.product || recoveredProduct);
      const owner = toolResults.some((item) => item?.tool === 'ask_insurance_expert')
        ? 'insurance_expert'
        : toolResults.some((item) => item?.tool === 'ask_sales_champion') ? 'sales_champion' : 'hermes';
      const committedCandidates = products.length
        ? { products, question: candidateQuestion, updatedAt }
        : (product || candidateToolResult) ? null : context.productCandidates;
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
          product: committedProduct,
          productCandidates: committedCandidates,
          question: pendingSalesQuestion || context.question,
          factBlock: compileAgentContextFactBlock({
            previous: context.factBlock,
            currentQuestion: products.length ? candidateQuestion : question,
            taskStatus: products.length ? 'needs_clarification' : 'completed',
            owner,
            product: committedProduct,
            productSource: product ? 'domain_agent' : 'conversation_context',
            productCandidates: committedCandidates,
            salesKyc: salesToolResult?.result?.agentContextUpdate?.salesKyc,
            updatedAt,
          }),
        });
      } catch {
        reportError('AGENT_CONVERSATION_COMMIT_FAILED');
      }
    }
    let agentLoopFallbackReason = '';
    let agentLoopCandidate;
    let agentLoopProposal;
    let agentLoopSessionId = String(context?.agentLoopSessionId || '');
    let mustUseToolAfterContextRetry = false;
    let retryAfterContextCollision = false;
    const selectedProduct = selectedCandidateProduct(question, context?.productCandidates?.products);
    const selectsOnlineSearch = selectedOnlineSearch(question, context?.productCandidates?.products);
    const rejectsProductCandidates = Boolean(
      context?.productCandidates?.products?.length
      && (preparseAgentMessage(question).candidateRejection || selectsOnlineSearch),
    );
    const pendingSalesCandidate = context?.question?.candidate?.intent === 'sales_coaching'
      ? context.question.candidate
      : null;
    const resumesSalesCoaching = Boolean(selectedProduct && pendingSalesCandidate);
    const controlledCandidateSelection = Boolean((agentLoopMode || semanticMode)
      && !selectsOnlineSearch
      && (selectedProduct || selectedCandidateIndex(question) >= 0));
    if (agentLoopMode && toolCapability && confirmedActiveProduct
      && typeof toolCapabilityService?.bindConfirmedProduct === 'function') {
      try {
        toolCapabilityService.bindConfirmedProduct(toolCapability, confirmedActiveProduct);
      } catch {
        reportError('AGENT_TOOL_CONTEXT_BIND_FAILED');
      }
    }
    if (agentLoopMode && toolCapability && rejectsProductCandidates
      && typeof toolCapabilityService?.authorizeOnlineProductSearch === 'function') {
      try {
        const rejectedProductCandidates = (Array.isArray(context?.productCandidates?.products)
          ? context.productCandidates.products : []).flatMap((candidate) => (
          candidate?.ref === 'search_online' || !candidate?.company || !candidate?.officialName
            ? []
            : [{
                ...(candidate.canonicalProductId ? { canonicalProductId: candidate.canonicalProductId } : {}),
                company: candidate.company,
                officialName: candidate.officialName,
              }]
        ));
        toolCapabilityService.authorizeOnlineProductSearch(toolCapability, rejectedProductCandidates);
      } catch {
        reportError('AGENT_TOOL_ONLINE_SEARCH_BIND_FAILED');
      }
    }
    if (agentLoopMode && !controlledCandidateSelection) {
      try {
        let agentResult;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await ensureIdentityCurrent();
            const contextualFactBlock = compileAgentContextFactBlock({
              previous: context.factBlock,
              currentQuestion: question,
              taskStatus: 'active',
              owner: 'hermes',
              product: context.product,
              productSource: 'conversation_context',
              productCandidates: context.productCandidates,
              updatedAt: Number(now()),
            });
            const agentController = new AbortController();
            const waitController = new AbortController();
            const agentPromise = agentLoopClient.runTurn({
              sessionId: attempt === 0 ? String(context?.agentLoopSessionId || '') : '',
              question,
              capability: toolCapability,
              gatewayUrl: toolGatewayUrl,
              safeRecentContext: {
                history: retryAfterContextCollision ? [] : history,
                activeEntities: activeProductName
                  ? retryAfterContextCollision
                    ? { previousProduct: { officialName: activeProductName } }
                    : { product: { officialName: activeProductName } }
                  : {},
                factBlock: retryAfterContextCollision
                  ? { ...contextualFactBlock, verifiedEntities: {} }
                  : contextualFactBlock,
              },
              requestId: String(channelEnvelope?.messageRef || ''),
              signal: agentController.signal,
            }).then(
              (value) => ({ kind: 'agent', value }),
              (error) => ({ kind: 'agent_error', error }),
            );
            const toolPromise = toolCapability
              && typeof toolCapabilityService?.waitForResult === 'function'
              ? toolCapabilityService.waitForResult(toolCapability, { signal: waitController.signal }).then(
                (claims) => ({ kind: 'tool', claims }),
                () => new Promise(() => {}),
              )
              : new Promise(() => {});
            let winner = await Promise.race([agentPromise, toolPromise]);
            if (winner.kind === 'tool') {
              const authoritative = authoritativeToolInteraction(winner.claims?.toolResults);
              if (authoritative) {
                agentController.abort();
                waitController.abort();
                await commitAgentReply(authoritative.interaction.text, '', winner.claims.toolResults);
                return { ...authoritative, runtime: 'hermes' };
              }
              winner = await agentPromise;
            }
            waitController.abort();
            if (winner.kind === 'agent_error') throw winner.error;
            agentResult = winner.value;
            const attemptUsage = toolCapability && typeof toolCapabilityService?.inspect === 'function'
              ? toolCapabilityService.inspect(toolCapability)
              : null;
            const attemptReply = String(agentResult?.finalReply || '').trim();
            if (attempt === 0
              && Number(attemptUsage?.callCount || 0) === 0
              && activeProductName
              && attemptReply.includes(activeProductName)) {
              mustUseToolAfterContextRetry = true;
              retryAfterContextCollision = true;
              reportError('HERMES_RETRY_CONTEXT_COLLISION');
              continue;
            }
            break;
          } catch (error) {
            const usage = toolCapability && typeof toolCapabilityService?.inspect === 'function'
              ? toolCapabilityService.inspect(toolCapability)
              : null;
            const authoritative = authoritativeToolInteraction(usage?.toolResults);
            if (authoritative) {
              await commitAgentReply(authoritative.interaction.text, agentLoopSessionId, usage?.toolResults);
              return { ...authoritative, runtime: 'hermes' };
            }
            const retryable = ['HERMES_SESSION_NOT_FOUND', 'HERMES_RESPONSE_INVALID', 'HERMES_PROVIDER_FAILED', 'HERMES_TIMEOUT']
              .includes(String(error?.code || ''));
            if (attempt > 0 || !retryable || Number(usage?.callCount || 0) > 0) throw error;
            reportError(`HERMES_RETRY_${String(error.code)}`);
          }
        }
        await ensureIdentityCurrent();
        const finalReply = String(agentResult?.finalReply || '').trim();
        if (!finalReply) throw Object.assign(new Error('HERMES_RESPONSE_INVALID'), { code: 'HERMES_RESPONSE_INVALID' });
        const usage = toolCapability && typeof toolCapabilityService?.inspect === 'function'
          ? toolCapabilityService.inspect(toolCapability)
          : null;
        agentLoopSessionId = String(agentResult.sessionId || agentLoopSessionId);
        if (Number(usage?.callCount || 0) > 0) {
          const authoritative = authoritativeToolInteraction(usage?.toolResults);
          const replyText = authoritative?.interaction?.text
            || guardAgentFinalReply({ finalReply, toolResults: usage?.toolResults }).reply;
          await commitAgentReply(replyText, agentLoopSessionId, usage?.toolResults);
          return {
            decision: authoritative?.decision || 'execute',
            interaction: authoritative?.interaction || { type: 'answer', text: replyText },
            runtime: 'hermes',
          };
        }
        if (!mustUseToolAfterContextRetry
          && !rejectsProductCandidates
          && fallbackCandidateFromText(question).intent === 'chat') {
          await commitAgentReply(finalReply, agentLoopSessionId, []);
          return { decision: 'execute', interaction: { type: 'answer', text: finalReply }, runtime: 'hermes' };
        }
        reportError('HERMES_RESPONSE_INVALID');
        return hermesUnavailableResult('HERMES_RESPONSE_INVALID');
      } catch (error) {
        if (error?.code === 'AGENT_CONVERSATION_IDENTITY_CHANGED') throw error;
        reportError(String(error?.code || 'HERMES_PROVIDER_FAILED'));
        return hermesUnavailableResult(String(error?.code || 'HERMES_PROVIDER_FAILED'));
      }
    }
    const semanticCandidateSelection = controlledCandidateSelection && !selectedProduct;
    let candidate = agentLoopCandidate;
    let proposal = agentLoopProposal;
    let semanticFallbackReason = agentLoopFallbackReason;
    let hermesSessionId = String(context?.hermesSessionId || '');
    let usedRuntime = 'direct';
    let selectedSalesContext;
    if (selectedProduct && !semanticCandidateSelection) {
      proposal = undefined;
      if (resumesSalesCoaching) {
        candidate = {
          intent: 'sales_coaching',
          question: String(pendingSalesCandidate.question || context.productCandidates.question || '').trim().slice(0, 1_000),
          confidence: 1,
          requestedOperation: 'read',
        };
        selectedSalesContext = {
          productMentions: [selectedProduct.productName],
          officialFactNeeds: ['main_responsibilities', 'product_advantages'],
          resolvedProducts: [{
            canonicalProductId: selectedProduct.canonicalProductId,
            company: selectedProduct.company,
            officialName: selectedProduct.productName,
          }],
        };
      } else {
        candidate = {
          intent: 'insurance_product_knowledge',
          question: selectedProductQuestion(context.productCandidates.question || '', selectedProduct),
          confidence: 1,
          requestedOperation: 'read',
          entities: {
            productName: selectedProduct.productName,
            ...(selectedProduct.company ? { productCompany: selectedProduct.company } : {}),
            ...(selectedProduct.canonicalProductId ? { productCanonicalId: selectedProduct.canonicalProductId } : {}),
          },
        };
      }
    } else if (!semanticCandidateSelection
      && semanticMode && hermesClient && typeof hermesClient.runTurn === 'function') {
      usedRuntime = 'hermes';
      try {
        let interpreted;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            interpreted = await hermesClient.runTurn({
              sessionId: attempt === 0 ? hermesSessionId : '',
              question,
              safeRecentContext: {
                history,
                factBlock: compileAgentContextFactBlock({
                  previous: context.factBlock,
                  currentQuestion: question,
                  taskStatus: 'active',
                  owner: 'hermes',
                  product: context.product,
                  productSource: 'conversation_context',
                  productCandidates: context.productCandidates,
                  updatedAt: Number(now()),
                }),
              },
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
        return hermesUnavailableResult(String(error?.code || 'HERMES_PROVIDER_FAILED'));
      }
    }
    if (!candidate && !proposal && !semanticCandidateSelection) {
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
    } else if (semanticCandidateSelection) {
      usedRuntime = 'hermes';
      result = await questionRouter.route({
        internalUserId: identity.internalUserId,
        messageRef: String(channelEnvelope?.messageRef || ''),
        conversationHistory: history,
        ...(channelEnvelope?.conversationId ? { conversationId: identity.channelConversationId } : {}),
        question,
        runtime: usedRuntime,
        salesContext: { salesKycState: conversationSalesKyc },
      });
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
        salesContext: { salesKycState: conversationSalesKyc },
        ...(usedRuntime === 'direct' && semanticFallbackReason
          ? { fallbackReason: semanticFallbackReason }
          : {}),
      });
    } else {
      candidate = resolved.candidate;
      const selectedSemanticContext = !resumesSalesCoaching
        && selectedProduct?.canonicalProductId && selectedProduct?.company
        ? {
          resolvedEntities: { product: {
            canonicalProductId: selectedProduct.canonicalProductId,
            company: selectedProduct.company,
            officialName: selectedProduct.productName,
          } },
          queryAspects: [],
        }
        : undefined;
      result = await questionRouter.route({
        internalUserId: identity.internalUserId,
        messageRef: String(channelEnvelope?.messageRef || ''),
        conversationHistory: history,
        ...(channelEnvelope?.conversationId ? { conversationId: identity.channelConversationId } : {}),
        candidate,
        ...(selectedSemanticContext ? { semanticContext: selectedSemanticContext } : {}),
        salesContext: {
          ...(selectedSalesContext || {}),
          ...(conversationSalesKyc ? { salesKycState: conversationSalesKyc } : {}),
        },
      });
    }
    await ensureIdentityCurrent();
    const replyText = String(result?.interaction?.text || '').trim();
    const products = candidateProducts(result?.interaction);
    const isComparison = PRODUCT_COMPARISON_PATTERN.test(candidate?.question || question);
    const explicitProduct = !isComparison ? String(candidate?.entities?.productName || '').trim() : '';
    const canonicalProduct = !isComparison ? (productNameFromReply(replyText) || explicitProduct) : '';
    const updatedAt = Number(now());
    const explicitProductContext = explicitProduct ? rememberedProduct({
      officialName: explicitProduct,
      company: candidate?.entities?.productCompany,
      canonicalProductId: candidate?.entities?.productCanonicalId,
    }, updatedAt) : null;
    const selectedProductContext = selectedProduct ? rememberedProduct(selectedProduct, updatedAt) : null;
    const committedProduct = canonicalProduct
      ? {
        productName: canonicalProduct,
        ...(explicitProductContext?.productName === canonicalProduct && explicitProductContext.company
          ? { company: explicitProductContext.company }
          : {}),
        ...(explicitProductContext?.productName === canonicalProduct && explicitProductContext.canonicalProductId
          ? { canonicalProductId: explicitProductContext.canonicalProductId }
          : {}),
        updatedAt,
      }
      : (selectedProductContext || context.product || (confirmedActiveProduct
        ? rememberedProduct(confirmedActiveProduct, updatedAt)
        : activeProductName ? { productName: activeProductName, updatedAt } : null));
    const committedCandidates = products.length
      ? { products, question, updatedAt }
      : (selectedProduct || clarificationCandidate || Array.isArray(result?.interaction?.candidates))
        ? null
        : context.productCandidates;
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
        product: committedProduct,
        productCandidates: committedCandidates,
        question: candidate?.intent && candidate.intent !== 'chat' ? { candidate, updatedAt } : context.question,
        factBlock: compileAgentContextFactBlock({
          previous: context.factBlock,
          currentQuestion: question,
          taskStatus: products.length || result?.decision === 'clarify' ? 'needs_clarification' : 'completed',
          owner: result?.provenance?.domainAgent || 'hermes',
          product: committedProduct,
          productSource: result?.provenance?.domainAgent ? 'domain_agent' : 'conversation_context',
          productCandidates: committedCandidates,
          salesKyc: result?.agentContextUpdate?.salesKyc,
          updatedAt,
        }),
      });
    } catch {
      reportError('AGENT_CONVERSATION_COMMIT_FAILED');
    }
    return { ...result, runtime: usedRuntime, ...(candidate ? { candidate } : {}) };
  }

  return { processMessage };
}
