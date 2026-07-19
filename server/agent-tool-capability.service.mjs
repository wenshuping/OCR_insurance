import { randomBytes } from 'node:crypto';

import { normalizeSalesKycState } from './agent-context-fact-block.service.mjs';

const ALLOWED_TOOLS = new Set(['ask_insurance_expert', 'ask_sales_champion']);
const ISSUE_FIELDS = new Set([
  'tenant', 'channel', 'channelUserId', 'channelMobile', 'internalUserId',
  'conversationId', 'messageRef', 'allowedTools', 'maxCalls', 'ttlMs',
]);
const MAX_TTL_MS = 24 * 60 * 60 * 1_000;

function capabilityError(code) {
  return Object.assign(new Error(code), { code });
}

function record(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw capabilityError(code);
  return value;
}

function requiredText(value, name, maxLength = 200) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > maxLength) {
    throw capabilityError(`AGENT_TOOL_CAPABILITY_${name.toUpperCase()}_INVALID`);
  }
  return value;
}

function positiveSafeInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw capabilityError(`AGENT_TOOL_CAPABILITY_${name.toUpperCase()}_INVALID`);
  }
  return value;
}

function timestamp(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw capabilityError('AGENT_TOOL_CAPABILITY_CLOCK_INVALID');
  }
  return value;
}

function normalizedTools(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > ALLOWED_TOOLS.size) {
    throw capabilityError('AGENT_TOOL_CAPABILITY_ALLOWED_TOOLS_INVALID');
  }
  if (value.some((tool) => typeof tool !== 'string' || !ALLOWED_TOOLS.has(tool))) {
    throw capabilityError('AGENT_TOOL_CAPABILITY_ALLOWED_TOOLS_INVALID');
  }
  const tools = [...new Set(value)];
  if (tools.length !== value.length) {
    throw capabilityError('AGENT_TOOL_CAPABILITY_ALLOWED_TOOLS_INVALID');
  }
  return tools;
}

function resolvedEntities(value) {
  const productName = typeof value?.product?.officialName === 'string'
    ? value.product.officialName.trim().slice(0, 200)
    : '';
  const products = Array.isArray(value?.products) && value.products.length === 2
    ? value.products.map((product) => ({
      officialName: typeof product?.officialName === 'string'
        ? product.officialName.trim().slice(0, 200)
        : '',
    })).filter((product) => product.officialName)
    : [];
  return {
    ...(productName ? { product: { officialName: productName } } : {}),
    ...(products.length === 2 ? { products } : {}),
  };
}

function publicProductCandidates(value, tool, candidateType) {
  const productCandidatesAllowed = tool === 'ask_insurance_expert'
    || (tool === 'ask_sales_champion' && candidateType === 'product');
  if (!productCandidatesAllowed || !Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((candidate) => {
    const ref = typeof candidate?.ref === 'string' ? candidate.ref.trim().slice(0, 200) : '';
    const label = typeof candidate?.label === 'string' ? candidate.label.trim().slice(0, 200) : '';
    return ref && label ? [{ ref, label }] : [];
  });
}

function copyClaims(claims) {
  return {
    ...claims,
    allowedTools: [...claims.allowedTools],
    ...(claims.confirmedProduct ? { confirmedProduct: { ...claims.confirmedProduct } } : {}),
    ...(Array.isArray(claims.rejectedProductCandidates)
      ? { rejectedProductCandidates: claims.rejectedProductCandidates.map((candidate) => ({ ...candidate })) }
      : {}),
    toolResults: (Array.isArray(claims.toolResults) ? claims.toolResults : []).map((item) => structuredClone(item)),
  };
}

function rejectedProductCandidates(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) {
    throw capabilityError('AGENT_TOOL_CAPABILITY_REJECTED_PRODUCT_CANDIDATES_INVALID');
  }
  return value.flatMap((candidate) => {
    const item = record(candidate, 'AGENT_TOOL_CAPABILITY_REJECTED_PRODUCT_CANDIDATE_INVALID');
    if (Object.keys(item).some((key) => !['canonicalProductId', 'company', 'officialName'].includes(key))) {
      throw capabilityError('AGENT_TOOL_CAPABILITY_REJECTED_PRODUCT_CANDIDATE_INVALID');
    }
    const company = requiredText(item.company, 'rejected_product_company');
    const officialName = requiredText(item.officialName, 'rejected_product_official_name');
    const canonicalProductId = typeof item.canonicalProductId === 'string' && item.canonicalProductId.trim()
      ? requiredText(item.canonicalProductId, 'rejected_product_canonical_id')
      : '';
    return [{ ...(canonicalProductId ? { canonicalProductId } : {}), company, officialName }];
  });
}

export function createAgentToolCapabilityService({
  clock = Date.now,
  createToken = () => randomBytes(32).toString('base64url'),
  cleanupIntervalMs = 60_000,
} = {}) {
  if (typeof clock !== 'function' || typeof createToken !== 'function') {
    throw new TypeError('Agent tool capability dependencies are required');
  }
  positiveSafeInteger(cleanupIntervalMs, 'cleanup_interval_ms', MAX_TTL_MS);
  const capabilities = new Map();
  const resultWaiters = new Map();
  let lastCleanupAt = 0;

  function notifyResultWaiters(token, claims) {
    const waiters = resultWaiters.get(token);
    if (!waiters) return;
    resultWaiters.delete(token);
    for (const waiter of waiters) waiter(copyClaims(claims));
  }

  function cleanup(now) {
    if (now - lastCleanupAt < cleanupIntervalMs) return;
    for (const [token, claims] of capabilities) {
      if (claims.expiresAt <= now) capabilities.delete(token);
    }
    lastCleanupAt = now;
  }

  function issue(input = {}) {
    const value = record(input, 'AGENT_TOOL_CAPABILITY_ISSUE_INVALID');
    if (Object.keys(value).some((key) => !ISSUE_FIELDS.has(key))) {
      throw capabilityError('AGENT_TOOL_CAPABILITY_ISSUE_INVALID');
    }
    const now = timestamp(clock);
    cleanup(now);
    const ttlMs = positiveSafeInteger(value.ttlMs, 'ttl_ms', MAX_TTL_MS);
    const claims = {
      tenant: requiredText(value.tenant, 'tenant', 100),
      channel: requiredText(value.channel, 'channel', 20),
      channelUserId: requiredText(value.channelUserId, 'channel_user_id'),
      channelMobile: requiredText(value.channelMobile, 'channel_mobile', 40),
      internalUserId: positiveSafeInteger(value.internalUserId, 'internal_user_id'),
      conversationId: requiredText(value.conversationId, 'conversation_id'),
      messageRef: requiredText(value.messageRef, 'message_ref'),
      allowedTools: normalizedTools(value.allowedTools),
      maxCalls: positiveSafeInteger(value.maxCalls, 'max_calls', 100),
      callCount: 0,
      toolResults: [],
      issuedAt: now,
      expiresAt: now + ttlMs,
    };
    if (!Number.isSafeInteger(claims.expiresAt)) {
      throw capabilityError('AGENT_TOOL_CAPABILITY_TTL_MS_INVALID');
    }
    const token = requiredText(createToken(), 'token', 500);
    if (capabilities.has(token)) throw capabilityError('AGENT_TOOL_CAPABILITY_TOKEN_COLLISION');
    capabilities.set(token, claims);
    return { token, claims: copyClaims(claims) };
  }

  function consume(input = {}) {
    const value = record(input, 'AGENT_TOOL_CAPABILITY_CONSUME_INVALID');
    if (Object.keys(value).some((key) => !['token', 'tool'].includes(key))) {
      throw capabilityError('AGENT_TOOL_CAPABILITY_CONSUME_INVALID');
    }
    const token = requiredText(value.token, 'token', 500);
    const tool = requiredText(value.tool, 'tool', 100);
    const now = timestamp(clock);
    const claims = capabilities.get(token);
    cleanup(now);
    if (!claims) throw capabilityError('AGENT_TOOL_CAPABILITY_NOT_FOUND');
    if (claims.expiresAt <= now) {
      capabilities.delete(token);
      throw capabilityError('AGENT_TOOL_CAPABILITY_EXPIRED');
    }
    if (!claims.allowedTools.includes(tool)) throw capabilityError('AGENT_TOOL_CAPABILITY_TOOL_FORBIDDEN');
    if (claims.callCount >= claims.maxCalls) throw capabilityError('AGENT_TOOL_CAPABILITY_BUDGET_EXHAUSTED');
    claims.callCount += 1;
    return copyClaims(claims);
  }

  function bindConfirmedProduct(tokenValue, productValue) {
    const token = requiredText(tokenValue, 'token', 500);
    const product = record(productValue, 'AGENT_TOOL_CAPABILITY_CONFIRMED_PRODUCT_INVALID');
    if (Object.keys(product).some((key) => !['canonicalProductId', 'company', 'officialName'].includes(key))) {
      throw capabilityError('AGENT_TOOL_CAPABILITY_CONFIRMED_PRODUCT_INVALID');
    }
    const now = timestamp(clock);
    cleanup(now);
    const claims = capabilities.get(token);
    if (!claims) throw capabilityError('AGENT_TOOL_CAPABILITY_NOT_FOUND');
    if (claims.expiresAt <= now) {
      capabilities.delete(token);
      throw capabilityError('AGENT_TOOL_CAPABILITY_EXPIRED');
    }
    claims.confirmedProduct = {
      canonicalProductId: requiredText(product.canonicalProductId, 'confirmed_product_canonical_id'),
      company: requiredText(product.company, 'confirmed_product_company'),
      officialName: requiredText(product.officialName, 'confirmed_product_official_name'),
    };
    return copyClaims(claims);
  }

  function authorizeOnlineProductSearch(tokenValue, rejectedCandidatesValue) {
    const token = requiredText(tokenValue, 'token', 500);
    const now = timestamp(clock);
    cleanup(now);
    const claims = capabilities.get(token);
    if (!claims) throw capabilityError('AGENT_TOOL_CAPABILITY_NOT_FOUND');
    if (claims.expiresAt <= now) {
      capabilities.delete(token);
      throw capabilityError('AGENT_TOOL_CAPABILITY_EXPIRED');
    }
    claims.onlineProductSearchAllowed = true;
    claims.rejectedProductCandidates = rejectedProductCandidates(rejectedCandidatesValue);
    return copyClaims(claims);
  }

  function revoke(tokenValue) {
    const token = requiredText(tokenValue, 'token', 500);
    const now = timestamp(clock);
    cleanup(now);
    return capabilities.delete(token);
  }

  function recordResult({ token: tokenValue, tool, result } = {}) {
    const token = requiredText(tokenValue, 'token', 500);
    const toolName = requiredText(tool, 'tool', 100);
    const claims = capabilities.get(token);
    if (!claims || !claims.allowedTools.includes(toolName)) {
      throw capabilityError('AGENT_TOOL_CAPABILITY_NOT_FOUND');
    }
    const interaction = result?.interaction;
    const interactionText = typeof interaction?.text === 'string' ? interaction.text.trim().slice(0, 48_000) : '';
    const candidates = publicProductCandidates(interaction?.candidates, toolName, result?.candidateType);
    const preservesProductCandidates = Array.isArray(interaction?.candidates)
      && (toolName === 'ask_insurance_expert'
        || (toolName === 'ask_sales_champion' && result?.candidateType === 'product'));
    const entities = resolvedEntities(result?.resolvedEntities);
    const salesKyc = toolName === 'ask_sales_champion'
      ? normalizeSalesKycState(result?.agentContextUpdate?.salesKyc)
      : null;
    claims.toolResults.push({
      tool: toolName,
      result: {
        status: typeof result?.status === 'string' ? result.status.slice(0, 40) : 'failed',
        decision: typeof result?.decision === 'string' ? result.decision.slice(0, 40) : 'deny',
        interaction: {
          type: typeof interaction?.type === 'string' ? interaction.type.slice(0, 40) : 'denied',
          ...(interactionText ? { text: interactionText } : {}),
          ...(interaction?.delivery === 'verbatim' ? { delivery: 'verbatim' } : {}),
          ...(preservesProductCandidates ? { candidates } : {}),
        },
        ...(Object.keys(entities).length ? { resolvedEntities: entities } : {}),
        ...(salesKyc ? { agentContextUpdate: { salesKyc } } : {}),
      },
    });
    notifyResultWaiters(token, claims);
    return copyClaims(claims);
  }

  function waitForResult(tokenValue, { signal } = {}) {
    const token = requiredText(tokenValue, 'token', 500);
    const claims = capabilities.get(token);
    if (!claims) return Promise.reject(capabilityError('AGENT_TOOL_CAPABILITY_NOT_FOUND'));
    if (claims.toolResults.length > 0) return Promise.resolve(copyClaims(claims));
    if (signal?.aborted) return Promise.reject(capabilityError('AGENT_TOOL_CAPABILITY_WAIT_ABORTED'));
    return new Promise((resolve, reject) => {
      const waiters = resultWaiters.get(token) || new Set();
      const finish = (value) => {
        signal?.removeEventListener?.('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => {
        waiters.delete(finish);
        if (waiters.size === 0) resultWaiters.delete(token);
        reject(capabilityError('AGENT_TOOL_CAPABILITY_WAIT_ABORTED'));
      };
      waiters.add(finish);
      resultWaiters.set(token, waiters);
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  function inspect(tokenValue) {
    const token = requiredText(tokenValue, 'token', 500);
    const now = timestamp(clock);
    const claims = capabilities.get(token);
    cleanup(now);
    if (!claims || claims.expiresAt <= now) return null;
    return copyClaims(claims);
  }

  return Object.freeze({
    issue, bindConfirmedProduct, authorizeOnlineProductSearch,
    consume, inspect, recordResult, waitForResult, revoke,
  });
}
