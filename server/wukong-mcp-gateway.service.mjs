import { listFamilyProfilesForOwner } from './family-profile.domain.mjs';
import { createInsuranceExpertTool } from './insurance-expert-tool.service.mjs';
import { createSalesChampionTool } from './sales-champion-tool.service.mjs';

const DEFAULT_REPLAY_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REPLAY_MAX_ENTRIES = 2_000;
const DEFAULT_RATE_LIMIT = 60;
const DEFAULT_RATE_WINDOW_MS = 60 * 1000;
const DEFAULT_RATE_MAX_PRINCIPALS = 2_000;
const WUKONG_CONVERSATION_TYPES = new Set(['direct']);
const WUKONG_REQUEST_KEYS = new Set([
  'corpId', 'dingUserId', 'requestId', 'conversationType', 'tool', 'input',
]);
const WUKONG_PUBLIC_TOOL_NAMES = Object.freeze([
  'resolve_advisor_identity',
  'list_accessible_families',
  'start_policy_import',
  'append_policy_import_files',
  'get_policy_import',
  'apply_policy_import_action',
  'finalize_policy_import',
  'ask_sales_champion',
  'ask_insurance_expert',
  'get_sales_memories',
  'apply_memory_action',
]);

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

function isPlainRecord(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateInputSchema(schema, input) {
  if (schema.type !== 'object' || !isPlainRecord(input)) {
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
    const property = properties[key];
    const expectedType = property?.type;
    if (expectedType === 'array') {
      if (!Array.isArray(value)) fail('INVALID_TOOL_INPUT', 400);
      for (const item of value) validateInputSchema(property.items, item);
    } else if (expectedType === 'object') {
      validateInputSchema(property, value);
    } else if (expectedType === 'integer') {
      if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_TOOL_INPUT', 400);
    } else if (expectedType && typeof value !== expectedType) fail('INVALID_TOOL_INPUT', 400);
    if (property?.enum && !property.enum.includes(value)) fail('INVALID_TOOL_INPUT', 400);
    if (typeof value === 'string' && Number.isSafeInteger(property?.maxLength) && value.length > property.maxLength) {
      fail('INVALID_TOOL_INPUT', 400);
    }
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

function createRegistry(state, policyImports, salesChampion, insuranceExpert, familySalesMemoryApi) {
  const emptyObjectSchema = Object.freeze({
    type: 'object', properties: Object.freeze({}), required: Object.freeze([]), additionalProperties: false,
  });
  const familySchema = (properties, required) => Object.freeze({ type: 'object', properties: Object.freeze(properties), required: Object.freeze(required), additionalProperties: false });
  const resolveFamily = (context, familyRef) => {
    const family = listFamilyProfilesForOwner(state, context).find((candidate) => Number(candidate.id) === Number(familyRef) && String(candidate.status || 'active') === 'active');
    if (!family) fail('FAMILY_NOT_FOUND', 404);
    return family;
  };
  const entries = [
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
    ['start_policy_import', {
      name: 'start_policy_import', inputSchema: familySchema({ familyRef: { type: 'integer' } }, ['familyRef']), authorize: () => true,
      execute: (context, input) => policyImports.start({ family: resolveFamily(context, input.familyRef), owner: context, channel: 'wukong' }),
    }],
    ['append_policy_import_files', {
      name: 'append_policy_import_files', inputSchema: familySchema({ familyRef: { type: 'integer' }, taskId: { type: 'integer' }, stateVersion: { type: 'integer' }, files: { type: 'array', items: { type: 'object', properties: { uploadItem: { type: 'string' }, name: { type: 'string' }, mediaType: { type: 'string' } }, required: ['uploadItem'], additionalProperties: false } } }, ['familyRef', 'taskId', 'stateVersion', 'files']), authorize: () => true,
      execute: (context, input) => policyImports.append({ familyId: resolveFamily(context, input.familyRef).id, taskId: input.taskId, owner: context, stateVersion: input.stateVersion, files: input.files }),
    }],
    ['get_policy_import', {
      name: 'get_policy_import', inputSchema: familySchema({ familyRef: { type: 'integer' }, taskId: { type: 'integer' } }, ['familyRef', 'taskId']), authorize: () => true,
      execute: (context, input) => policyImports.get({ familyId: resolveFamily(context, input.familyRef).id, taskId: input.taskId, owner: context }),
    }],
    ['apply_policy_import_action', {
      name: 'apply_policy_import_action', inputSchema: familySchema({ familyRef: { type: 'integer' }, taskId: { type: 'integer' }, stateVersion: { type: 'integer' }, action: { type: 'string' }, field: { type: 'string' }, value: { type: 'string' }, optionId: { type: 'string' }, role: { type: 'string' } }, ['familyRef', 'taskId', 'stateVersion', 'action']), authorize: () => true,
      execute: (context, input) => {
        const { familyRef, taskId, ...action } = input;
        return policyImports.action({ familyId: resolveFamily(context, familyRef).id, taskId, owner: context, input: action });
      },
    }],
    ['finalize_policy_import', {
      name: 'finalize_policy_import', inputSchema: familySchema({ familyRef: { type: 'integer' }, taskId: { type: 'integer' }, stateVersion: { type: 'integer' }, requestId: { type: 'string' } }, ['familyRef', 'taskId', 'stateVersion', 'requestId']), authorize: () => true,
      execute: (context, input) => policyImports.finalize({ family: resolveFamily(context, input.familyRef), taskId: input.taskId, owner: context, stateVersion: input.stateVersion, requestId: input.requestId }),
    }],
    ['ask_sales_champion', {
      name: 'ask_sales_champion',
      inputSchema: familySchema({ question: { type: 'string', maxLength: 4_000 }, familyRef: { type: 'integer' }, policyImportTaskId: { type: 'integer' } }, ['question', 'familyRef']),
      authorize: () => true,
      execute: (context, input, request) => salesChampion({ owner: context, ...input, requestId: request.requestId }),
    }],
    ['ask_insurance_expert', {
      name: 'ask_insurance_expert',
      inputSchema: familySchema({ question: { type: 'string', maxLength: 4_000 }, policyRef: { type: 'integer' }, policyImportTaskId: { type: 'integer' } }, ['question']),
      authorize: () => true,
      execute: (context, input, request) => insuranceExpert({ owner: context, ...input, requestId: request.requestId }),
    }],
    ['get_sales_memories', {
      name: 'get_sales_memories',
      inputSchema: familySchema({ familyRef: { type: 'integer' }, status: { type: 'string', maxLength: 80 }, kind: { type: 'string', maxLength: 80 }, cursor: { type: 'string', maxLength: 200 }, limit: { type: 'integer' } }, ['familyRef']),
      authorize: () => true,
      execute: (context, input) => {
        const { familyRef, ...query } = input;
        const result = familySalesMemoryApi.list({ familyId: resolveFamily(context, familyRef).id, owner: context, ...query });
        const minimal = (memory) => ({ id: memory.id, kind: memory.kind, status: memory.status, content: memory.content, version: memory.version });
        return { sections: Object.fromEntries(Object.entries(result.sections).map(([name, items]) => [name, items.map(minimal)])), nextCursor: result.nextCursor };
      },
    }],
    ['apply_memory_action', {
      name: 'apply_memory_action',
      inputSchema: familySchema({ familyRef: { type: 'integer' }, memoryId: { type: 'integer' }, action: { type: 'string', enum: ['confirm', 'reject', 'supersede', 'complete', 'expire', 'restore'] }, expectedVersion: { type: 'integer' }, reasonCode: { type: 'string', maxLength: 80 }, replacement: { type: 'object', properties: { content: { type: 'string', maxLength: 220 } }, required: ['content'], additionalProperties: false } }, ['familyRef', 'memoryId', 'action', 'expectedVersion', 'reasonCode']),
      authorize: () => true,
      execute: async (context, input) => {
        const { familyRef, memoryId, action, ...actionInput } = input;
        const result = await familySalesMemoryApi.action({ familyId: resolveFamily(context, familyRef).id, memoryId, owner: context, action, input: actionInput });
        return { memories: result.memories.map((memory) => ({ id: memory.id, kind: memory.kind, status: memory.status, content: memory.content, version: memory.version })) };
      },
    }],
  ];
  const registry = new Map(entries);
  if (registry.size !== WUKONG_PUBLIC_TOOL_NAMES.length
    || WUKONG_PUBLIC_TOOL_NAMES.some((name) => !registry.has(name))) {
    throw new Error('INVALID_WUKONG_TOOL_REGISTRY');
  }
  return registry;
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
  policyImports,
  salesChampion,
  salesChampionOptions,
  insuranceExpert,
  insuranceExpertOptions,
  familySalesMemoryApi,
} = {}) {
  const resolvedState = state || {};
  const registry = createRegistry(
    resolvedState,
    policyImports || { start: () => fail('TOOL_NOT_CONFIGURED', 503), append: () => fail('TOOL_NOT_CONFIGURED', 503), get: () => fail('TOOL_NOT_CONFIGURED', 503), action: () => fail('TOOL_NOT_CONFIGURED', 503) },
    salesChampion || createSalesChampionTool({ state: resolvedState, ...salesChampionOptions }),
    insuranceExpert || createInsuranceExpertTool({ state: resolvedState, ...insuranceExpertOptions }),
    familySalesMemoryApi || { list: () => fail('TOOL_NOT_CONFIGURED', 503), action: () => fail('TOOL_NOT_CONFIGURED', 503) },
  );
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

  function purgeExpiredReplay(timestamp) {
    for (const [key, expiresAt] of replay) {
      if (expiresAt <= timestamp) replay.delete(key);
    }
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
    toolNames: WUKONG_PUBLIC_TOOL_NAMES,
    toolMetadata,
    get replaySize() { return replay.size; },
    get ratePrincipalCount() { return rates.size; },
    async invoke(request) {
      if (!isPlainRecord(request)
        || Object.keys(request).some((key) => !WUKONG_REQUEST_KEYS.has(key))
        || !nonEmptyString(request?.corpId)
        || !nonEmptyString(request?.dingUserId)
        || !nonEmptyString(request?.requestId)
        || !nonEmptyString(request?.conversationType)
        || !nonEmptyString(request?.tool)
        || request.requestId.length > 160) fail('INVALID_TOOL_INPUT', 400);
      if (!WUKONG_CONVERSATION_TYPES.has(request.conversationType)) fail('GROUP_CHAT_FORBIDDEN', 403);
      const entry = registry.get(request.tool);
      if (!entry) fail('TOOL_NOT_ALLOWED', 403);
      validateInputSchema(entry.inputSchema, request.input);

      const timestamp = Number(now());
      if (!Number.isFinite(timestamp)) fail('RATE_LIMITED', 429);
      const ownerContext = resolveOwnerContext(state || {}, request);
      purgeExpiredReplay(timestamp);
      const replayKey = `user:${ownerContext.userId}\u0000${request.requestId}`;
      if (replay.has(replayKey)) fail('REQUEST_REPLAYED', 409);
      if (replay.size >= replayMax) fail('REPLAY_CACHE_CAPACITY', 503);

      if (!entry.authorize(ownerContext, request.input)) fail('TOOL_NOT_ALLOWED', 403);
      // Internal user ids are stable across multiple DingTalk identities, so aliases share one quota.
      takeRate(`user:${ownerContext.userId}`, timestamp);
      // Reservations intentionally survive execution failures to prevent unsafe retries for future write tools.
      replay.set(replayKey, timestamp + replayTtl);
      onExecute?.(entry.name);
      return entry.execute(ownerContext, request.input, request);
    },
  };
}
