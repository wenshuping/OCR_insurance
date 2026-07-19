import { validateHermesDomainToolInput } from './hermes-domain-mcp-server.mjs';

const OPERATION_INTENTS = Object.freeze({
  ask_insurance_expert: Object.freeze({
    product_knowledge: 'insurance_product_knowledge',
    family_summary: 'family_summary',
    coverage_report: 'coverage_report',
  }),
  ask_sales_champion: Object.freeze({
    sales_report: 'sales_report',
    sales_coaching: 'sales_coaching',
  }),
});
function gatewayError(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

function toolMessageRef(claims) {
  return `${claims.messageRef}:tool:${claims.callCount}`.slice(0, 200);
}

function productEntity(value) {
  const officialName = typeof value?.officialName === 'string'
    ? value.officialName.trim().slice(0, 200)
    : '';
  if (!officialName) return null;
  const canonicalProductId = typeof value?.canonicalProductId === 'string'
    ? value.canonicalProductId.trim().slice(0, 200)
    : '';
  const company = typeof value?.company === 'string' ? value.company.trim().slice(0, 200) : '';
  return {
    ...(canonicalProductId ? { canonicalProductId } : {}),
    ...(company ? { company } : {}),
    officialName,
  };
}

function resolvedEntities(result) {
  const value = result?.semanticContext?.resolvedEntities;
  const product = productEntity(value?.product);
  const products = Array.isArray(value?.products) && value.products.length === 2
    ? value.products.map(productEntity)
    : [];
  return {
    ...(product ? { product } : {}),
    ...(products.length === 2 && products.every(Boolean) ? { products } : {}),
  };
}

function productMentions(names, question) {
  const mentions = [];
  const compactQuestion = String(question || '').replace(/\s+/gu, '');
  for (const name of names) {
    let split = null;
    let end = name.indexOf('保险');
    while (end >= 0) {
      end += '保险'.length;
      const insurer = name.slice(0, end).trim();
      const product = name.slice(end).trim().replace(/^的\s*/u, '').trim();
      const compactInsurer = insurer.replace(/\s+/gu, '');
      const compactProduct = product.replace(/\s+/gu, '');
      if (insurer && product && (
        compactQuestion.includes(`${compactInsurer}的${compactProduct}`)
        || compactQuestion.includes(`${compactInsurer}${compactProduct}`)
      )) {
        split = { insurer, product };
        break;
      }
      end = name.indexOf('保险', end);
    }
    if (split) {
      mentions.push({ type: 'insurer', rawText: split.insurer }, { type: 'product', rawText: split.product });
    } else if (compactQuestion.includes(String(name || '').replace(/\s+/gu, ''))) {
      mentions.push({ type: 'product', rawText: name });
    }
  }
  return mentions;
}

function candidateFor(tool, input, entities = {}) {
  const intent = OPERATION_INTENTS[tool]?.[input.operation];
  if (!intent) throw gatewayError('AGENT_DOMAIN_TOOL_OPERATION_FORBIDDEN');
  const refs = Array.isArray(input.contextRefs) ? input.contextRefs : [];
  if (input.operation !== 'product_knowledge') {
    const names = Array.isArray(input.names) ? input.names : [];
    if (names[0]) entities.familyName = names[0];
    if (refs[0]) entities.familyRef = refs[0];
  }
  return { candidate: {
    intent, question: input.question, confidence: 1, requestedOperation: 'read',
    ...(Object.keys(entities).length ? { entities } : {}),
  } };
}

function productResolutionMentions(name, question) {
  const structured = /^([^《》]+)《([^《》]+)》$/u.exec(String(name || '').trim());
  if (structured) {
    return [
      { type: 'insurer', rawText: structured[1].trim() },
      { type: 'product', rawText: structured[2].trim() },
    ];
  }
  const mentions = productMentions([name], question);
  if (mentions.length) {
    const hasInsurer = mentions.some((mention) => mention.type === 'insurer');
    if (hasInsurer) return mentions;
    const compactName = String(name || '').replace(/\s+/gu, '');
    const compactQuestion = String(question || '').replace(/\s+/gu, '');
    const productIndex = compactQuestion.lastIndexOf(compactName);
    const insurer = productIndex > 0
      ? compactQuestion.slice(0, productIndex)
        .replace(/^(?:请问|帮我查|查询|查一下)/u, '')
        .replace(/的$/u, '')
      : '';
    if (insurer && insurer.length <= 40 && /(?:保险|人寿|财险|养老|健康)$/u.test(insurer)) {
      return [{ type: 'insurer', rawText: insurer }, ...mentions];
    }
    return mentions;
  }
  return [{ type: 'product', rawText: name }];
}

function productClarification(resolutions, { onlineAttempted = false } = {}) {
  const candidates = resolutions.flatMap((resolution) => (
    Array.isArray(resolution?.candidates) ? resolution.candidates : []
  )).map(productEntity).filter(Boolean)
    .filter((candidate, index, values) => values.findIndex((value) => (
      value.canonicalProductId === candidate.canonicalProductId
      && value.company === candidate.company
      && value.officialName === candidate.officialName
    )) === index)
    .slice(0, onlineAttempted ? 10 : 9);
  return {
    status: 'needs_clarification',
    decision: 'clarify',
    interaction: {
      type: 'clarification',
      text: onlineAttempted
        ? candidates.length
          ? '联网找到以下可能的正式产品，请选择一项。'
          : '联网查询后仍未找到可确认的正式产品。请补充承保主体（保险公司），或保单、条款上的完整产品名称。'
        : candidates.length
          ? candidates.length === 1
            ? '你是不是想查询以下产品？请选择；如果不是，请选择“以上都不是，联网查询”。'
            : '找到多个可能的正式产品，请选择一项；如果都不是，请选择最后一项联网查询。'
          : '本地产品库暂未找到匹配项，可选择“以上都不是，联网查询”继续查找。',
      candidates: [
        ...candidates.map((candidate, index) => ({
          ref: `product_${index + 1}`,
          label: `${candidate.company ? `${candidate.company}` : ''}《${candidate.officialName}》`,
        })),
        ...(!onlineAttempted ? [{ ref: 'search_online', label: '以上都不是，联网查询' }] : []),
      ],
    },
  };
}

function salesProductClarification(resolutions) {
  const result = productClarification(resolutions);
  return {
    ...result,
    candidateType: 'product',
    interaction: {
      ...result.interaction,
      text: result.interaction.candidates?.length
        ? '我先确认一下客户购买的具体产品。请选择一项；如果都不是，请选择最后一项联网查询。确认后会由保险专家解析，再继续给出销冠跟进建议。'
        : result.interaction.text,
    },
  };
}

async function verifiedProductRouteInput(
  input,
  productResolver,
  confirmedProduct = null,
  { onlineSearchAllowed = false, rejectedProductCandidates = [] } = {},
) {
  const names = Array.isArray(input.names) ? input.names : [];
  const searchOnline = input.searchOnline === true && onlineSearchAllowed;
  if (!names.length) return candidateFor('ask_insurance_expert', input);
  if (names.length > 2 || typeof productResolver?.resolve !== 'function') {
    return { result: productClarification([], { onlineAttempted: searchOnline }) };
  }
  const resolutions = [];
  for (const name of names) {
    resolutions.push(await productResolver.resolve({
      mentions: productResolutionMentions(name, input.question),
      activeProduct: null,
      ...(searchOnline ? { allowOnline: true } : {}),
      ...(searchOnline && rejectedProductCandidates.length ? { rejectedProductCandidates } : {}),
      ...(name === confirmedProduct?.officialName ? { confirmedCandidate: confirmedProduct } : {}),
    }));
  }
  if (resolutions.some((resolution) => resolution?.status !== 'resolved')) {
    return { result: productClarification(resolutions, { onlineAttempted: searchOnline }) };
  }
  const products = resolutions.map((resolution) => productEntity(resolution.entity));
  if (products.some((product) => !product)
    || (products.length === 2 && products[0].canonicalProductId === products[1].canonicalProductId)) {
    return { result: productClarification(resolutions, { onlineAttempted: searchOnline }) };
  }
  const queryAspects = Array.isArray(input.queryAspects) ? input.queryAspects : [];
  if (products.length === 1) {
    const [product] = products;
    return {
      ...candidateFor('ask_insurance_expert', input, {
        productName: product.officialName,
        productCanonicalId: product.canonicalProductId,
        productCompany: product.company,
      }),
      semanticContext: { resolvedEntities: { product }, queryAspects },
      verifiedEntities: { product },
    };
  }
  const entities = {};
  products.forEach((product, index) => {
    const suffix = index + 1;
    entities[`product${suffix}Name`] = product.officialName;
    entities[`product${suffix}CanonicalId`] = product.canonicalProductId;
    entities[`product${suffix}Company`] = product.company;
  });
  return {
    ...candidateFor('ask_insurance_expert', input, entities),
    semanticContext: { resolvedEntities: { products }, queryAspects },
    verifiedEntities: { products },
  };
}

async function salesProductContext(input, productResolver, confirmedProduct = null) {
  const productMentions = Array.isArray(input.productMentions) ? input.productMentions : [];
  const officialFactNeeds = Array.isArray(input.officialFactNeeds) ? input.officialFactNeeds : [];
  if (!productMentions.length) {
    return officialFactNeeds.length ? { productMentions: [], officialFactNeeds, resolvedProducts: [] } : null;
  }
  const resolvedProducts = [];
  const unresolved = [];
  if (typeof productResolver?.resolve === 'function') {
    for (const name of productMentions) {
      try {
        const resolution = await productResolver.resolve({
          mentions: productResolutionMentions(name, input.question),
          activeProduct: null,
          ...(name === confirmedProduct?.officialName ? { confirmedCandidate: confirmedProduct } : {}),
        });
        const product = resolution?.status === 'resolved' ? productEntity(resolution.entity) : null;
        if (product && !resolvedProducts.some((candidate) => (
          candidate.canonicalProductId === product.canonicalProductId
            && candidate.company === product.company
            && candidate.officialName === product.officialName
        ))) resolvedProducts.push(product);
        if (!product && Array.isArray(resolution?.candidates) && resolution.candidates.length) {
          unresolved.push(resolution);
        }
      } catch {
        // An unresolved supporting product must not replace the primary sales task.
      }
    }
  }
  if (unresolved.length && officialFactNeeds.length) {
    return { result: salesProductClarification(unresolved) };
  }
  return {
    productMentions,
    officialFactNeeds,
    resolvedProducts,
  };
}

export function createAgentDomainToolGateway({
  questionRouter,
  resolveChannelIdentity,
  productResolver,
  conversationContext,
  productContextTtlMinutes = 30,
} = {}) {
  if (!questionRouter || typeof questionRouter.route !== 'function') {
    throw new TypeError('Agent domain tool questionRouter is required');
  }
  if (typeof resolveChannelIdentity !== 'function') {
    throw new TypeError('Agent domain tool identity resolver is required');
  }

  async function execute({ tool, input: rawInput, claims } = {}) {
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
      throw gatewayError('AGENT_DOMAIN_TOOL_AUTHORIZATION_REQUIRED', 401);
    }
    const input = validateHermesDomainToolInput(tool, rawInput);
    const identity = await resolveChannelIdentity({
      channel: claims.channel,
      channelUserId: claims.channelUserId,
      channelMobile: claims.channelMobile,
    });
    if (Number(identity?.internalUserId) !== Number(claims.internalUserId)) {
      return {
        status: 'forbidden',
        decision: 'deny',
        interaction: { type: 'denied', text: '当前账号已无权继续访问该数据。' },
      };
    }
    const hasProductTask = (tool === 'ask_insurance_expert' && input.operation === 'product_knowledge')
      || (tool === 'ask_sales_champion' && input.operation === 'sales_coaching'
        && Array.isArray(input.productMentions) && input.productMentions.length > 0);
    const isSalesCoaching = tool === 'ask_sales_champion' && input.operation === 'sales_coaching';
    let activeConversationContext = null;
    if ((hasProductTask || isSalesCoaching)
      && conversationContext && typeof conversationContext.loadContext === 'function') {
      try {
        activeConversationContext = await conversationContext.loadContext({
          tenantId: claims.tenant,
          channel: claims.channel,
          channelUserId: claims.channelUserId,
          channelConversationId: claims.conversationId,
          internalUserId: Number(claims.internalUserId),
          productContextTtlMinutes,
        });
      } catch {
        activeConversationContext = null;
      }
    }
    let confirmedProduct = hasProductTask ? productEntity(claims.confirmedProduct) : null;
    if (hasProductTask && !confirmedProduct) {
      confirmedProduct = productEntity({
        officialName: activeConversationContext?.product?.productName,
        company: activeConversationContext?.product?.company,
        canonicalProductId: activeConversationContext?.product?.canonicalProductId,
      });
    }
    const routed = tool === 'ask_insurance_expert' && input.operation === 'product_knowledge'
      ? await verifiedProductRouteInput(input, productResolver, confirmedProduct, {
        onlineSearchAllowed: claims.onlineProductSearchAllowed === true,
        rejectedProductCandidates: Array.isArray(claims.rejectedProductCandidates)
          ? claims.rejectedProductCandidates : [],
      })
      : candidateFor(tool, input);
    if (routed.result) return routed.result;
    const productSalesContext = isSalesCoaching
      ? await salesProductContext(input, productResolver, confirmedProduct)
      : null;
    const supportingSalesContext = isSalesCoaching ? {
      ...(productSalesContext || {}),
      ...(activeConversationContext?.factBlock?.salesKyc
        ? { salesKycState: activeConversationContext.factBlock.salesKyc }
        : {}),
    } : null;
    if (supportingSalesContext?.result) return supportingSalesContext.result;
    const verifiedEntities = routed.verifiedEntities || {};
    const result = await questionRouter.route({
      internalUserId: Number(claims.internalUserId),
      messageRef: toolMessageRef(claims),
      conversationId: claims.conversationId,
      candidate: routed.candidate,
      ...(isSalesCoaching
        ? { conversationHistory: activeConversationContext?.history || [] }
        : {}),
      ...(routed.semanticContext ? { semanticContext: routed.semanticContext } : {}),
      ...(supportingSalesContext ? { salesContext: supportingSalesContext } : {}),
    });
    const interaction = result?.interaction || { type: 'denied', text: '该请求当前不可用。' };
    const preserveExpertAnswer = tool === 'ask_insurance_expert'
      && result?.decision === 'execute'
      && interaction.type === 'answer';
    const entities = Object.keys(verifiedEntities).length ? verifiedEntities : resolvedEntities(result);
    return {
      status: result?.decision === 'deny' ? 'forbidden'
        : result?.decision === 'clarify' ? 'needs_clarification'
          : result?.decision === 'confirm' ? 'confirmation_required' : 'ok',
      decision: result?.decision || 'deny',
      interaction: preserveExpertAnswer ? { ...interaction, delivery: 'verbatim' } : interaction,
      ...(Object.keys(entities).length ? { resolvedEntities: entities } : {}),
      ...(tool === 'ask_sales_champion' && result?.agentContextUpdate?.salesKyc
        ? { agentContextUpdate: { salesKyc: result.agentContextUpdate.salesKyc } }
        : {}),
    };
  }

  return Object.freeze({ execute });
}
