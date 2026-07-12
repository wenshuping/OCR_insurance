import { isCurrentFamilySalesMemory } from './family-sales-memory.service.mjs';

const ACTIONS = new Set(['confirm', 'reject', 'supersede', 'complete', 'expire', 'restore']);
const REASONS = {
  confirm: new Set(['user_confirmation', 'advisor_confirmation']),
  reject: new Set(['advisor_rejection', 'user_correction']),
  supersede: new Set(['advisor_correction', 'user_correction']),
  complete: new Set(['todo_completed']),
  expire: new Set(['expired_by_date', 'system_expiration']),
  restore: new Set(['restored_after_review']),
};
const KINDS = new Set(['objection', 'preference', 'strategy', 'correction', 'todo']);
const STATUSES = new Set(['candidate', 'confirmed', 'conflicted', 'superseded', 'rejected', 'expired', 'completed', 'archived', 'active']);
const PRIVATE_TEXT = /(?:\b1[3-9]\d{9}\b|\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b)/gu;

function fail(code, status) {
  throw Object.assign(new Error(code), { code, status });
}

function ownerScope(owner = {}) {
  const ownerUserId = Number(owner.userId || owner.ownerUserId || 0) || null;
  const ownerGuestId = ownerUserId ? '' : String(owner.guestId || owner.ownerGuestId || '');
  if (!ownerUserId && !ownerGuestId) fail('UNAUTHORIZED', 401);
  return { ownerUserId, ownerGuestId };
}

function sameScope(memory, familyId, owner) {
  return Number(memory?.familyId) === Number(familyId)
    && Number(memory?.ownerUserId || 0) === Number(owner.ownerUserId || 0)
    && String(memory?.ownerGuestId || '') === String(owner.ownerGuestId || '');
}

function cleanText(value) {
  return String(value || '').replace(PRIVATE_TEXT, '敏感信息已脱敏').replace(/\{\{id_number_\d+\}\}/gu, '敏感信息已脱敏').replace(/\s+/gu, ' ').trim().slice(0, 220);
}

function publicMemory(memory) {
  return {
    id: memory.id,
    kind: memory.kind,
    status: memory.status === 'active' ? 'confirmed' : memory.status,
    content: cleanText(memory.content),
    ...(memory.normalizedValue ? { normalizedValue: cleanText(memory.normalizedValue) } : {}),
    version: Number(memory.version || 1),
    validFrom: memory.validFrom || null,
    validTo: memory.validTo || null,
    createdAt: memory.createdAt || '',
    updatedAt: memory.updatedAt || '',
  };
}

function parseCsvFilter(value, allowed, code) {
  if (value === undefined || value === null || value === '') return null;
  const values = String(value).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!values.length || values.some((item) => !allowed.has(item))) fail(code, 400);
  return new Set(values);
}

function pageCursor(value) {
  if (!value) return 0;
  try {
    const parsed = Number(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  } catch {}
  fail('INVALID_MEMORY_CURSOR', 400);
}

function sectioned(items, asOf) {
  return {
    current: items.filter((item) => item.kind !== 'todo' && isCurrentFamilySalesMemory(item, { asOf })),
    candidates: items.filter((item) => ['candidate', 'conflicted'].includes(String(item.status))),
    openTodos: items.filter((item) => item.kind === 'todo' && isCurrentFamilySalesMemory(item, { asOf })),
    history: items.filter((item) => ['superseded', 'rejected', 'expired', 'completed', 'archived'].includes(String(item.status))),
  };
}

export function createFamilySalesMemoryApi({ state, persistFamilySalesMemoryTransition, listFamilySalesMemoryEvents, nowIso = () => new Date().toISOString() } = {}) {
  function list({ familyId, owner, status, kind, cursor, limit = 50 } = {}) {
    const scope = ownerScope(owner);
    const statuses = parseCsvFilter(status, STATUSES, 'INVALID_MEMORY_STATUS');
    const kinds = parseCsvFilter(kind, KINDS, 'INVALID_MEMORY_KIND');
    const offset = pageCursor(cursor);
    const pageSize = Math.min(100, Math.max(1, Number(limit) || 50));
    if (!Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 100) fail('INVALID_MEMORY_LIMIT', 400);
    const all = (state.familySalesMemories || []).filter((memory) => sameScope(memory, familyId, scope))
      .filter((memory) => !statuses || statuses.has(String(memory.status || 'active')))
      .filter((memory) => !kinds || kinds.has(String(memory.kind || '')))
      .sort((left, right) => Number(right.id || 0) - Number(left.id || 0));
    const rawItems = all.slice(offset, offset + pageSize);
    const sections = sectioned(rawItems, nowIso());
    return {
      sections: Object.fromEntries(Object.entries(sections).map(([name, values]) => [name, values.map(publicMemory)])),
      nextCursor: offset + pageSize < all.length ? Buffer.from(String(offset + pageSize)).toString('base64url') : '',
    };
  }

  async function action({ familyId, memoryId, owner, action, input = {}, actorType = 'advisor' } = {}) {
    const scope = ownerScope(owner);
    if (!(state.familySalesMemories || []).some((memory) => String(memory.id) === String(memoryId) && sameScope(memory, familyId, scope))) fail('MEMORY_NOT_FOUND', 404);
    if (!ACTIONS.has(action)) fail('INVALID_MEMORY_ACTION', 400);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) fail('EXPECTED_VERSION_REQUIRED', 400);
    if (!REASONS[action].has(String(input.reasonCode || ''))) fail('INVALID_MEMORY_REASON', 400);
    const allowed = action === 'supersede' ? new Set(['expectedVersion', 'reasonCode', 'replacement']) : new Set(['expectedVersion', 'reasonCode']);
    if (Object.keys(input).some((key) => !allowed.has(key))) fail('INVALID_MEMORY_ACTION_INPUT', 400);
    let replacement = null;
    if (action === 'supersede') {
      if (!input.replacement || Array.isArray(input.replacement) || typeof input.replacement !== 'object'
        || Object.keys(input.replacement).some((key) => key !== 'content') || !cleanText(input.replacement.content)) fail('INVALID_MEMORY_REPLACEMENT', 400);
      replacement = { content: cleanText(input.replacement.content) };
    } else if (input.replacement !== undefined) fail('INVALID_MEMORY_ACTION_INPUT', 400);
    if (typeof persistFamilySalesMemoryTransition !== 'function') fail('MEMORY_PERSISTENCE_NOT_CONFIGURED', 503);
    try {
      const bundle = await persistFamilySalesMemoryTransition({
        memoryId: Number(memoryId), familyId: Number(familyId), owner: scope, action,
        reasonCode: input.reasonCode, replacement, expectedVersion: input.expectedVersion,
        actor: { type: actorType, id: scope.ownerUserId || `sha256:${'0'.repeat(64)}` }, now: nowIso(),
      });
      return { memories: bundle.memories.map(publicMemory) };
    } catch (error) {
      if (error?.code === 'STALE_INTERACTION') throw error;
      if (/cross-scope|not found/i.test(String(error?.message || ''))) fail('MEMORY_NOT_FOUND', 404);
      if (!error?.status) Object.assign(error, { code: error?.code || 'INVALID_MEMORY_TRANSITION', status: 400 });
      throw error;
    }
  }

  function history({ familyId, memoryId, owner, cursor, limit = 50 } = {}) {
    const scope = ownerScope(owner);
    if (!Number.isSafeInteger(Number(memoryId)) || Number(memoryId) < 1) fail('MEMORY_NOT_FOUND', 404);
    if (!Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 100) fail('INVALID_MEMORY_LIMIT', 400);
    const memory = (state.familySalesMemories || []).find((item) => String(item.id) === String(memoryId) && sameScope(item, familyId, scope));
    if (!memory) fail('MEMORY_NOT_FOUND', 404);
    if (typeof listFamilySalesMemoryEvents !== 'function') fail('MEMORY_HISTORY_NOT_CONFIGURED', 503);
    let page;
    try { page = listFamilySalesMemoryEvents({ familyId: Number(familyId), memoryId: Number(memoryId), owner: scope, cursor, limit: Number(limit) }); }
    catch (error) {
      if (/cursor/i.test(String(error?.message || ''))) fail('INVALID_MEMORY_CURSOR', 400);
      throw error;
    }
    return {
      items: page.items.map((event) => ({ action: event.action || event.eventType, previousStatus: event.previousStatus || event.previous?.status || null, nextStatus: event.nextStatus || event.next?.status || null, reasonCode: event.reasonCode || event.reason || '', createdAt: event.createdAt || event.time || '' })),
      nextCursor: page.nextCursor,
    };
  }

  return Object.freeze({ list, action, history });
}
