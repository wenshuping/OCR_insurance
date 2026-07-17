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
  for (const name of names) {
    let split = null;
    let end = name.indexOf('保险');
    while (end >= 0) {
      end += '保险'.length;
      const insurer = name.slice(0, end).trim();
      const product = name.slice(end).trim();
      if (insurer && product && question.includes(`${insurer}的${product}`)) {
        split = { insurer, product };
        break;
      }
      end = name.indexOf('保险', end);
    }
    if (split) {
      mentions.push({ type: 'insurer', rawText: split.insurer }, { type: 'product', rawText: split.product });
    } else if (question.includes(name)) {
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
  const mentions = productMentions([name], question);
  return mentions.length ? mentions : [{ type: 'product', rawText: name }];
}

function productClarification(resolutions) {
  const candidates = resolutions.flatMap((resolution) => (
    Array.isArray(resolution?.candidates) ? resolution.candidates : []
  )).map(productEntity).filter(Boolean)
    .filter((candidate, index, values) => values.findIndex((value) => (
      value.canonicalProductId === candidate.canonicalProductId
      && value.company === candidate.company
      && value.officialName === candidate.officialName
    )) === index)
    .slice(0, 10);
  return {
    status: 'needs_clarification',
    decision: 'clarify',
    interaction: {
      type: 'clarification',
      text: candidates.length
        ? candidates.length === 1
          ? '你是不是想查询以下产品？请回复 1 确认。'
          : '找到多个可能的正式产品，请选择一项。'
        : '我暂时没能确认你说的是哪款产品。请补充保险公司，以及保单或条款上的完整产品名称。',
      ...(candidates.length ? { candidates: candidates.map((candidate, index) => ({
        ref: `product_${index + 1}`,
        label: `${candidate.company ? `${candidate.company}` : ''}《${candidate.officialName}》`,
      })) } : {}),
    },
  };
}

async function verifiedProductRouteInput(input, productResolver) {
  const names = Array.isArray(input.names) ? input.names : [];
  if (!names.length) return candidateFor('ask_insurance_expert', input);
  if (names.length > 2 || typeof productResolver?.resolve !== 'function') {
    return { result: productClarification([]) };
  }
  const resolutions = [];
  for (const name of names) {
    resolutions.push(await productResolver.resolve({
      mentions: productResolutionMentions(name, input.question),
      activeProduct: null,
    }));
  }
  if (resolutions.some((resolution) => resolution?.status !== 'resolved')) {
    return { result: productClarification(resolutions) };
  }
  const products = resolutions.map((resolution) => productEntity(resolution.entity));
  if (products.some((product) => !product)
    || (products.length === 2 && products[0].canonicalProductId === products[1].canonicalProductId)) {
    return { result: productClarification(resolutions) };
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

export function createAgentDomainToolGateway({ questionRouter, resolveChannelIdentity, productResolver } = {}) {
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
    const routed = tool === 'ask_insurance_expert' && input.operation === 'product_knowledge'
      ? await verifiedProductRouteInput(input, productResolver)
      : candidateFor(tool, input);
    if (routed.result) return routed.result;
    const verifiedEntities = routed.verifiedEntities || {};
    const result = await questionRouter.route({
      internalUserId: Number(claims.internalUserId),
      messageRef: toolMessageRef(claims),
      conversationId: claims.conversationId,
      candidate: routed.candidate,
      ...(routed.semanticContext ? { semanticContext: routed.semanticContext } : {}),
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
    };
  }

  return Object.freeze({ execute });
}
