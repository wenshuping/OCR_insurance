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

function routeInputFor(tool, input) {
  const intent = OPERATION_INTENTS[tool]?.[input.operation];
  if (!intent) throw gatewayError('AGENT_DOMAIN_TOOL_OPERATION_FORBIDDEN');
  const names = Array.isArray(input.names) ? input.names : [];
  const refs = Array.isArray(input.contextRefs) ? input.contextRefs : [];
  if (!refs.length) {
    const mentionType = input.operation === 'product_knowledge' ? 'product' : 'family';
    const mentions = names.filter((name) => input.question.includes(name))
      .map((rawText) => ({ type: mentionType, rawText }));
    return {
      question: input.question,
      runtime: 'hermes',
      proposal: {
        semanticContractVersion: 1,
        intent,
        operation: 'read',
        queryAspects: input.operation === 'product_knowledge'
          ? (input.queryAspects || [])
          : input.operation === 'family_summary' ? ['family_overview']
            : input.operation === 'coverage_report' ? ['coverage_gap']
              : input.operation === 'sales_report' ? ['report_status'] : ['sales_guidance'],
        mentions,
        references: [],
        requestedSteps: [input.operation === 'product_knowledge' && names.length > 1 ? 'compare'
          : input.operation.startsWith('sales_') ? 'generate' : 'lookup'],
        confidence: { intent: 1, mentions: 1, references: 1 },
      },
    };
  }
  const entities = {};
  if (input.operation === 'product_knowledge') {
    if (names[0]) entities.productName = names[0];
    if (names[1]) entities.productBText = names[1];
  } else {
    if (names[0]) entities.familyName = names[0];
    if (refs[0]) entities.familyRef = refs[0];
  }
  return { candidate: {
    intent, question: input.question, confidence: 1, requestedOperation: 'read',
    ...(Object.keys(entities).length ? { entities } : {}),
  } };
}

export function createAgentDomainToolGateway({ questionRouter, resolveChannelIdentity } = {}) {
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
    const result = await questionRouter.route({
      internalUserId: Number(claims.internalUserId),
      messageRef: toolMessageRef(claims),
      conversationId: claims.conversationId,
      ...routeInputFor(tool, input),
    });
    const interaction = result?.interaction || { type: 'denied', text: '该请求当前不可用。' };
    const preserveProductAnswer = tool === 'ask_insurance_expert'
      && input.operation === 'product_knowledge'
      && result?.decision === 'execute'
      && interaction.type === 'answer';
    const entities = resolvedEntities(result);
    return {
      status: result?.decision === 'deny' ? 'forbidden'
        : result?.decision === 'clarify' ? 'needs_clarification'
          : result?.decision === 'confirm' ? 'confirmation_required' : 'ok',
      decision: result?.decision || 'deny',
      interaction: preserveProductAnswer ? { ...interaction, delivery: 'verbatim' } : interaction,
      ...(Object.keys(entities).length ? { resolvedEntities: entities } : {}),
    };
  }

  return Object.freeze({ execute });
}
