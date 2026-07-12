import crypto from 'node:crypto';
import { isCurrentFamilySalesMemory } from './family-sales-memory.service.mjs';
import { sanitizeMemoryForPublic, sanitizePublicContent } from './privacy/public-content.service.mjs';

const ACTIONS = new Set(['confirm', 'reject', 'supersede', 'complete', 'expire', 'restore']);
const REASONS = {
  confirm: new Set(['user_confirmation', 'advisor_confirmation']), reject: new Set(['advisor_rejection', 'user_correction']),
  supersede: new Set(['advisor_correction', 'user_correction']), complete: new Set(['todo_completed']),
  expire: new Set(['expired_by_date', 'system_expiration']), restore: new Set(['restored_after_review']),
};
const KINDS = new Set(['objection', 'preference', 'strategy', 'correction', 'todo']);
const STATUSES = new Set(['candidate', 'confirmed', 'conflicted', 'superseded', 'rejected', 'expired', 'completed', 'archived', 'active']);
const SECTIONS = new Set(['current', 'pending', 'todos', 'history']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ERRORS = {
  UNAUTHORIZED: [401, '请先登录'], MEMORY_NOT_FOUND: [404, '销售记忆不存在'], INVALID_MEMORY_ACTION: [400, '记忆操作无效'],
  EXPECTED_VERSION_REQUIRED: [400, '缺少有效版本号'], INVALID_MEMORY_REASON: [400, '操作原因无效'], INVALID_MEMORY_ACTION_INPUT: [400, '操作参数无效'],
  INVALID_MEMORY_REPLACEMENT: [400, '替换内容无效'], INVALID_MEMORY_CURSOR: [400, '分页游标无效'], INVALID_MEMORY_LIMIT: [400, '分页数量无效'],
  INVALID_MEMORY_SECTION: [400, '记忆分区无效'], INVALID_MEMORY_STATUS: [400, '记忆状态筛选无效'], INVALID_MEMORY_KIND: [400, '记忆类型筛选无效'],
  INVALID_MEMORY_REQUEST_ID: [400, '请求标识无效'], STALE_INTERACTION: [409, '记忆已更新，请刷新后重试'],
  ADVISOR_CONFIRMATION_REQUIRED: [403, '需要顾问确认'], ADVISOR_CONFIRMATION_INVALID: [403, '顾问确认无效或已过期'],
  CONFIRMATION_TOKEN_REPLAYED: [409, '顾问确认已使用'], MEMORY_PERSISTENCE_NOT_CONFIGURED: [503, '记忆服务暂不可用'],
  REQUEST_ID_CONFLICT: [409, '请求标识已用于其他操作'], MEMORY_ACTION_PENDING: [409, '记忆操作处理中，请稍后重试'],
  INVALID_MEMORY_TRANSITION: [400, '当前状态不允许此操作'],
  MEMORY_HISTORY_NOT_CONFIGURED: [503, '记忆历史暂不可用'], MEMORY_ACTION_FAILED: [500, '记忆操作失败，请稍后重试'],
};

function fail(code) {
  const [status, message] = SAFE_ERRORS[code] || SAFE_ERRORS.MEMORY_ACTION_FAILED;
  throw Object.assign(new Error(message), { code, status });
}

function safeError(error, requestId, logger) {
  const code = String(error?.code || '');
  if (SAFE_ERRORS[code]) fail(code);
  logger?.warn?.('[family-sales-memory] action failed', { requestId: String(requestId || '').slice(0, 160), code: 'MEMORY_ACTION_FAILED' });
  fail('MEMORY_ACTION_FAILED');
}

function ownerScope(owner = {}) {
  const ownerUserId = Number(owner.userId || owner.ownerUserId || 0) || null;
  const ownerGuestId = ownerUserId ? '' : String(owner.guestId || owner.ownerGuestId || '');
  if (!ownerUserId && !ownerGuestId) fail('UNAUTHORIZED');
  return { ownerUserId, ownerGuestId };
}

function scopeKey(owner) { return owner.ownerUserId ? `u:${owner.ownerUserId}` : `g:${owner.ownerGuestId}`; }
function sameScope(memory, familyId, owner) {
  return Number(memory?.familyId) === Number(familyId) && Number(memory?.ownerUserId || 0) === Number(owner.ownerUserId || 0)
    && String(memory?.ownerGuestId || '') === String(owner.ownerGuestId || '');
}
function parseCsv(value, allowed, code) {
  if (value === undefined || value === null || value === '') return [];
  const values = String(value).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!values.length || values.some((item) => !allowed.has(item))) fail(code);
  return [...new Set(values)].sort();
}
function sectionMatches(memory, section, asOf) {
  if (section === 'current') return memory.kind !== 'todo' && isCurrentFamilySalesMemory(memory, { asOf });
  if (section === 'pending') return ['candidate', 'conflicted'].includes(String(memory.status));
  if (section === 'todos') return memory.kind === 'todo' && isCurrentFamilySalesMemory(memory, { asOf });
  return ['superseded', 'rejected', 'expired', 'completed', 'archived'].includes(String(memory.status));
}
function canonical(value) { return JSON.stringify(value, Object.keys(value).sort()); }

export function createFamilySalesMemoryApi({ state, persistFamilySalesMemoryTransition, listFamilySalesMemoryEvents, nowIso = () => new Date().toISOString(), cursorKey, verifyAdvisorConfirmation, logger = console } = {}) {
  if (!cursorKey || String(cursorKey).length < 32) throw new Error('family sales memory cursor key must be at least 32 characters');
  const key = String(cursorKey);
  const sign = (payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');
  const encode = (value) => { const payload = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${payload}.${sign(payload)}`; };
  const decode = (cursor, expected = {}) => {
    if (!cursor) return null;
    try {
      const [payload, signature, extra] = String(cursor).split('.');
      const actual = Buffer.from(signature || '');
      const expectedSignature = Buffer.from(payload ? sign(payload) : '');
      if (!payload || !signature || extra || actual.length !== expectedSignature.length || !crypto.timingSafeEqual(actual, expectedSignature)) fail('INVALID_MEMORY_CURSOR');
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      for (const [name, expectedValue] of Object.entries(expected)) if (canonical(value[name]) !== canonical(expectedValue)) fail('INVALID_MEMORY_CURSOR');
      return value;
    } catch (error) { if (error?.code) throw error; fail('INVALID_MEMORY_CURSOR'); }
  };

  function pageFor({ familyId, scope, section, statuses, kinds, cursor, limit, asOf }) {
    const binding = { v: 1, scope: scopeKey(scope), familyId: Number(familyId), section, statuses, kinds, asOf };
    const parsed = decode(cursor, binding);
    const all = (state.familySalesMemories || []).filter((memory) => sameScope(memory, familyId, scope) && sectionMatches(memory, section, asOf))
      .filter((memory) => !statuses.length || statuses.includes(String(memory.status || 'active')))
      .filter((memory) => !kinds.length || kinds.includes(String(memory.kind || '')))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')) || Number(right.id) - Number(left.id));
    const eligible = parsed ? all.filter((memory) => String(memory.updatedAt || '') < parsed.time || (String(memory.updatedAt || '') === parsed.time && Number(memory.id) < parsed.id)) : all;
    const rows = eligible.slice(0, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { items: page.map(sanitizeMemoryForPublic), count: all.length, nextCursor: rows.length > limit && last ? encode({ ...binding, time: String(last.updatedAt || ''), id: Number(last.id) }) : '' };
  }

  function list({ familyId, owner, status, kind, section, cursor, limit = 50, asOf } = {}) {
    const scope = ownerScope(owner);
    const statuses = parseCsv(status, STATUSES, 'INVALID_MEMORY_STATUS');
    const kinds = parseCsv(kind, KINDS, 'INVALID_MEMORY_KIND');
    const pageSize = Number(limit);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('INVALID_MEMORY_LIMIT');
    const point = String(asOf || (cursor ? decode(cursor).asOf : nowIso()));
    if (section && !SECTIONS.has(String(section))) fail('INVALID_MEMORY_SECTION');
    if (!section && cursor) fail('INVALID_MEMORY_CURSOR');
    if (section) return { section, ...pageFor({ familyId, scope, section, statuses, kinds, cursor, limit: pageSize, asOf: point }) };
    const sections = Object.fromEntries([...SECTIONS].map((name) => [name, pageFor({ familyId, scope, section: name, statuses, kinds, cursor: '', limit: pageSize, asOf: point })]));
    return { sections };
  }

  async function action({ familyId, memoryId, owner, action, input = {}, actorType = 'advisor', channel = 'web', outerRequestId = '', confirmationToken = '', interactionId = '' } = {}) {
    const scope = ownerScope(owner);
    if (!(state.familySalesMemories || []).some((memory) => String(memory.id) === String(memoryId) && sameScope(memory, familyId, scope))) fail('MEMORY_NOT_FOUND');
    if (!ACTIONS.has(action)) fail('INVALID_MEMORY_ACTION');
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) fail('EXPECTED_VERSION_REQUIRED');
    if (!REASONS[action].has(String(input.reasonCode || ''))) fail('INVALID_MEMORY_REASON');
    const requestId = channel === 'mcp' ? String(outerRequestId || '') : String(input.requestId || '');
    if (channel === 'web' ? !UUID.test(requestId) : !requestId || requestId.length > 160) fail('INVALID_MEMORY_REQUEST_ID');
    const allowed = action === 'supersede' ? new Set(['expectedVersion', 'reasonCode', 'requestId', 'replacement']) : new Set(['expectedVersion', 'reasonCode', 'requestId']);
    if (Object.keys(input).some((name) => !allowed.has(name))) fail('INVALID_MEMORY_ACTION_INPUT');
    let replacement = null;
    if (action === 'supersede') {
      if (!input.replacement || Array.isArray(input.replacement) || typeof input.replacement !== 'object' || Object.keys(input.replacement).some((name) => name !== 'content')) fail('INVALID_MEMORY_REPLACEMENT');
      const sanitized = sanitizePublicContent(input.replacement.content);
      if (!sanitized.content) fail('INVALID_MEMORY_REPLACEMENT');
      replacement = { content: sanitized.content };
    }
    let confirmationTokenHash = '';
    if (channel === 'mcp') {
      if (typeof verifyAdvisorConfirmation !== 'function') fail('ADVISOR_CONFIRMATION_REQUIRED');
      try {
        const expectedClaims = { interactionId, ownerScopeKey: scopeKey(scope), familyId: Number(familyId), memoryId: Number(memoryId), expectedVersion: input.expectedVersion,
          action, reasonCode: input.reasonCode, replacementHash: crypto.createHash('sha256').update(JSON.stringify(replacement)).digest('hex') };
        const claims = await verifyAdvisorConfirmation({ token: confirmationToken, ...expectedClaims });
        if (!claims?.valid || Object.entries(expectedClaims).some(([name, value]) => claims[name] !== value)) fail('ADVISOR_CONFIRMATION_INVALID');
        confirmationTokenHash = crypto.createHash('sha256').update(String(confirmationToken)).digest('hex');
      } catch (error) { if (error?.code) throw error; fail('ADVISOR_CONFIRMATION_INVALID'); }
    }
    if (typeof persistFamilySalesMemoryTransition !== 'function') fail('MEMORY_PERSISTENCE_NOT_CONFIGURED');
    try {
      const bundle = await persistFamilySalesMemoryTransition({ memoryId: Number(memoryId), familyId: Number(familyId), owner: scope, action, reasonCode: input.reasonCode, replacement,
        expectedVersion: input.expectedVersion, actor: { type: actorType, id: scope.ownerUserId || `sha256:${'0'.repeat(64)}` }, now: nowIso(), requestId, confirmationTokenHash });
      return { memories: bundle.memories.map(sanitizeMemoryForPublic), idempotent: bundle.idempotent === true };
    } catch (error) { safeError(error, requestId, logger); }
  }

  function history({ familyId, memoryId, owner, cursor, limit = 50 } = {}) {
    const scope = ownerScope(owner);
    if (!Number.isSafeInteger(Number(memoryId)) || !(state.familySalesMemories || []).some((item) => String(item.id) === String(memoryId) && sameScope(item, familyId, scope))) fail('MEMORY_NOT_FOUND');
    const pageSize = Number(limit);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('INVALID_MEMORY_LIMIT');
    if (typeof listFamilySalesMemoryEvents !== 'function') fail('MEMORY_HISTORY_NOT_CONFIGURED');
    const binding = { v: 1, scope: scopeKey(scope), familyId: Number(familyId), memoryId: Number(memoryId), section: 'event_history' };
    const parsed = decode(cursor, binding);
    let page;
    try { page = listFamilySalesMemoryEvents({ familyId: Number(familyId), memoryId: Number(memoryId), owner: scope, cursor: parsed?.storeCursor || '', limit: pageSize }); }
    catch (error) {
      if (/cursor/i.test(String(error?.message || ''))) fail('INVALID_MEMORY_CURSOR');
      logger?.warn?.('[family-sales-memory] history failed', { code: 'MEMORY_ACTION_FAILED' });
      fail('MEMORY_ACTION_FAILED');
    }
    return { items: page.items.map((event) => ({ action: event.action || event.eventType, previousStatus: event.previousStatus || event.previous?.status || null, nextStatus: event.nextStatus || event.next?.status || null, reasonCode: event.reasonCode || event.reason || '', createdAt: event.createdAt || event.time || '' })), nextCursor: page.nextCursor ? encode({ ...binding, storeCursor: page.nextCursor }) : '' };
  }
  return Object.freeze({ list, action, history });
}
