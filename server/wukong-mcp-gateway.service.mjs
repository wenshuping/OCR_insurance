import { listFamilyProfilesForOwner } from './family-profile.domain.mjs';

const DEFAULT_REPLAY_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REPLAY_MAX_ENTRIES = 2_000;
const DEFAULT_RATE_LIMIT = 60;
const DEFAULT_RATE_WINDOW_MS = 60 * 1000;
const DEFAULT_RATE_MAX_PRINCIPALS = 2_000;

export class WukongMcpError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'WukongMcpError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) {
  throw new WukongMcpError(code, status);
}

function nonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function validateInputSchema(schema, input) {
  if (schema.type !== 'object' || !input || Array.isArray(input) || typeof input !== 'object') {
    fail('INVALID_TOOL_INPUT', 400);
  }
  const properties = schema.properties || {};
  if (schema.additionalProperties === false
    && Object.keys(input).some((key) => !Object.hasOwn(properties, key))) {
    fail('INVALID_TOOL_INPUT', 400);
  }
  if ((schema.required || []).some((key) => !Object.hasOwn(input, key))) {
    fail('INVALID_TOOL_INPUT', 400);
  }
  for (const [key, value] of Object.entries(input)) {
    const expectedType = properties[key]?.type;
    if (expectedType && typeof value !== expectedType) fail('INVALID_TOOL_INPUT', 400);
  }
  return input;
}

function maskDisplay(value) {
  const characters = [...String(value || '').trim()];
  if (!characters.length) return '顾问';
  if (characters.length === 1) return '*';
  return `${characters[0]}**${characters.length > 2 ? characters.at(-1) : ''}`;
}

function resolveOwnerContext(state, principal) {
  const identities = (state.userDingtalkIdentities || []).filter((identity) => (
    identity.corpId === principal.corpId && identity.dingUserId === principal.dingUserId
  ));
  if (identities.length > 1) fail('IDENTITY_AMBIGUOUS', 409);
  if (!identities.length) fail('IDENTITY_NOT_BOUND', 403);
  const identity = identities[0];
  if (identity.status === 'revoked') fail('IDENTITY_REVOKED', 403);
  if (identity.status !== 'active') fail('IDENTITY_NOT_BOUND', 403);
  const user = (state.users || []).find((candidate) => Number(candidate.id) === Number(identity.userId));
  if (!user || user.status !== 'active') fail('ADVISOR_ACCOUNT_INACTIVE', 403);
  return { userId: user.id, displayLabel: maskDisplay(user.name || '顾问') };
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') deepFreeze(child);
  }
  return Object.freeze(value);
}

function createRegistry(state) {
  const emptyObjectSchema = Object.freeze({
    type: 'object', properties: Object.freeze({}), required: Object.freeze([]), additionalProperties: false,
  });
  return new Map([
    ['resolve_advisor_identity', {
      name: 'resolve_advisor_identity',
      inputSchema: emptyObjectSchema,
      authorize: () => true,
      execute: (context) => ({ status: 'active', displayLabel: context.displayLabel }),
    }],
    ['list_accessible_families', {
      name: 'list_accessible_families',
      inputSchema: emptyObjectSchema,
      authorize: () => true,
      execute: (context) => ({
        families: listFamilyProfilesForOwner(state, context)
          .map((family) => ({
            id: family.id,
            displayLabel: maskDisplay(family.name || '家庭'),
            memberCount: (state.familyMembers || []).filter((member) => (
              Number(member.familyId) === Number(family.id) && member.status !== 'archived'
            )).length,
          })),
      }),
    }],
  ]);
}

export function createWukongMcpGateway({
  state,
  now = Date.now,
  replayTtlMs = DEFAULT_REPLAY_TTL_MS,
  replayMaxEntries = DEFAULT_REPLAY_MAX_ENTRIES,
  rateLimit = DEFAULT_RATE_LIMIT,
  rateWindowMs = DEFAULT_RATE_WINDOW_MS,
  rateMaxPrincipals = DEFAULT_RATE_MAX_PRINCIPALS,
  onExecute,
} = {}) {
  const registry = createRegistry(state || {});
  const toolMetadata = deepFreeze([...registry.values()].map((entry) => ({
    name: entry.name,
    inputSchema: structuredClone(entry.inputSchema),
  })));
  const replay = new Map();
  const rates = new Map();
  const replayTtl = positiveInteger(replayTtlMs, DEFAULT_REPLAY_TTL_MS);
  const replayMax = positiveInteger(replayMaxEntries, DEFAULT_REPLAY_MAX_ENTRIES);
  const windowMs = positiveInteger(rateWindowMs, DEFAULT_RATE_WINDOW_MS);
  const maxPrincipals = positiveInteger(rateMaxPrincipals, DEFAULT_RATE_MAX_PRINCIPALS);
  const limit = Number.isSafeInteger(rateLimit) ? rateLimit : DEFAULT_RATE_LIMIT;

  function cleanReplay(timestamp) {
    for (const [key, expiresAt] of replay) {
      if (expiresAt <= timestamp) replay.delete(key);
    }
    while (replay.size >= replayMax) replay.delete(replay.keys().next().value);
  }

  function takeRate(principalKey, timestamp) {
    if (limit <= 0) fail('RATE_LIMITED', 429);
    for (const [key, bucket] of rates) {
      if (timestamp >= bucket.resetAt) rates.delete(key);
    }
    if (!rates.has(principalKey) && rates.size >= maxPrincipals) fail('RATE_LIMITED', 429);
    const existing = rates.get(principalKey);
    const bucket = !existing || timestamp >= existing.resetAt
      ? { count: 0, resetAt: timestamp + windowMs }
      : existing;
    if (bucket.count >= limit) fail('RATE_LIMITED', 429);
    bucket.count += 1;
    rates.set(principalKey, bucket);
  }

  return {
    toolNames: [...registry.keys()],
    toolMetadata,
    get replaySize() { return replay.size; },
    get ratePrincipalCount() { return rates.size; },
    async invoke(request) {
      if (!nonEmptyString(request?.corpId)
        || !nonEmptyString(request?.dingUserId)
        || !nonEmptyString(request?.requestId)
        || !nonEmptyString(request?.conversationType)
        || !nonEmptyString(request?.tool)) fail('INVALID_TOOL_INPUT', 400);
      if (request.conversationType !== 'direct') fail('GROUP_CHAT_FORBIDDEN', 403);
      const entry = registry.get(request.tool);
      if (!entry) fail('TOOL_NOT_ALLOWED', 403);
      validateInputSchema(entry.inputSchema, request.input);

      const timestamp = Number(now());
      if (!Number.isFinite(timestamp)) fail('RATE_LIMITED', 429);
      const principalKey = `${request.corpId}\u0000${request.dingUserId}`;
      cleanReplay(timestamp);
      const replayKey = `${principalKey}\u0000${request.requestId}`;
      if (replay.has(replayKey)) fail('REQUEST_REPLAYED', 409);
      takeRate(principalKey, timestamp);

      const ownerContext = resolveOwnerContext(state || {}, request);
      if (!entry.authorize(ownerContext, request.input)) fail('TOOL_NOT_ALLOWED', 403);
      replay.set(replayKey, timestamp + replayTtl);
      onExecute?.(entry.name);
      return entry.execute(ownerContext, request.input);
    },
  };
}
