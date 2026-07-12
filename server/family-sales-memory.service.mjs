import { jsonrepair } from 'jsonrepair';

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MEMORY_MODEL = 'deepseek-v4-flash';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 1_200;
const FAMILY_SALES_MEMORY_LIMIT = 20;
const MEMORY_KINDS = new Set(['objection', 'preference', 'strategy', 'correction', 'todo']);
const MEMORY_STATUSES = new Set(['candidate', 'confirmed', 'conflicted', 'superseded', 'rejected', 'expired', 'completed', 'archived']);
const MEMORY_ACTIONS = new Set(['confirm', 'reject', 'supersede', 'complete', 'expire', 'restore']);
const ACTION_REASON_CODES = {
  confirm: new Set(['user_confirmation', 'advisor_confirmation']),
  reject: new Set(['advisor_rejection', 'user_correction']),
  supersede: new Set(['advisor_correction', 'user_correction']),
  complete: new Set(['todo_completed']),
  expire: new Set(['expired_by_date', 'system_expiration']),
  restore: new Set(['restored_after_review']),
};
const MAX_EXTRACTED_MEMORY_ITEMS = 32;
const MAX_MODEL_RESPONSE_CHARS = 100_000;
const MAX_MEMORY_GRAPH_SIZE = 1_000;
const CURRENT_MEMORY_STATUSES = new Set(['confirmed', 'active']);
const DEEPSEEK_V4_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);
const CHINA_ID_NUMBER_PATTERN = /\b(?:[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]|[1-9]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3})\b/gu;
const MOBILE_PATTERN = /\b1[3-9]\d{9}\b/gu;
const ISO_DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const ISO_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|([+-])(\d{2}):(\d{2}))$/u;

function trim(value) {
  return String(value || '').trim();
}

export function parseFamilySalesMemoryInstant(value = '') {
  const text = trim(value);
  const dateOnly = ISO_DATE_ONLY_PATTERN.exec(text);
  if (dateOnly) {
    const [, year, month, day] = dateOnly.map(Number);
    const timestamp = Date.UTC(year, month - 1, day);
    const date = new Date(timestamp);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      ? timestamp : Number.NaN;
  }
  const match = ISO_DATETIME_PATTERN.exec(text);
  if (!match) return Number.NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number(match[7] || 0);
  const localTimestamp = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const localDate = new Date(localTimestamp);
  if (localDate.getUTCFullYear() !== year || localDate.getUTCMonth() !== month - 1 || localDate.getUTCDate() !== day
    || localDate.getUTCHours() !== hour || localDate.getUTCMinutes() !== minute || localDate.getUTCSeconds() !== second) return Number.NaN;
  let offsetMinutes = 0;
  if (match[8] !== 'Z') {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 23 || offsetMinute > 59) return Number.NaN;
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (match[9] === '+' ? 1 : -1);
  }
  const timestamp = localTimestamp - offsetMinutes * 60_000;
  return Number.isFinite(timestamp) && Number.isFinite(Date.parse(text)) ? timestamp : Number.NaN;
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function boundedNumber(value, fallback, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, numberOrDefault(value, fallback)));
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.75;
  return Math.max(0, Math.min(1, number));
}

function normalizeKind(value = '') {
  const kind = trim(value).toLowerCase();
  return MEMORY_KINDS.has(kind) ? kind : '';
}

function sanitizeMemoryContent(value = '') {
  return trim(value)
    .replace(CHINA_ID_NUMBER_PATTERN, '身份证号已脱敏')
    .replace(MOBILE_PATTERN, '手机号已脱敏')
    .replace(/\{\{id_number_\d+\}\}/gu, '身份证号已脱敏')
    .replace(/\s+/gu, ' ')
    .slice(0, 220)
    .trim();
}

function sanitizeMemorySourceText(value = '', limit = 1_600) {
  return trim(value)
    .replace(CHINA_ID_NUMBER_PATTERN, '身份证号已脱敏')
    .replace(MOBILE_PATTERN, '手机号已脱敏')
    .replace(/\{\{id_number_\d+\}\}/gu, '身份证号已脱敏')
    .replace(/\s+/gu, ' ')
    .slice(0, limit)
    .trim();
}

function isAutoConfirmableMemory(memory = {}) {
  const content = sanitizeMemoryContent(memory.content).toLowerCase();
  if (normalizeKind(memory.kind) !== 'preference' || !content) return false;
  if (/(预算|保费|收入|负债|债务|健康|病|家庭责任|赡养|意向|购买|投保|异议|纠正|策略|方案|保额|收益)/u.test(content)) return false;
  return /(称呼|显示|展示|联系格式|联系方式格式|电话格式|手机号格式|微信格式|日期格式|时间格式|简短|简洁|详细|先看结论|文字|语音)/u.test(content);
}

function normalizedStatus(value = '') {
  const status = trim(value).toLowerCase();
  return status === 'active' ? 'confirmed' : status;
}

function requireVersion(value, name = 'version') {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function canonicalMemoryId(value, name = 'memory id') {
  if (Number.isSafeInteger(value) && value > 0) return value;
  const opaque = typeof value === 'string' ? value.trim() : '';
  if (/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/u.test(opaque)) return opaque;
  throw new TypeError(`${name} must be a positive safe integer or bounded opaque id`);
}

function sameMemoryId(left, right) {
  return String(canonicalMemoryId(left)) === String(canonicalMemoryId(right));
}

function memoryScope(memory = {}) {
  return [Number(memory.familyId || 0) || 0, Number(memory.ownerUserId || 0) || 0, trim(memory.ownerGuestId)].join(':');
}

function validateSupersessionGraph({ memory, replacementId, existingMemories }) {
  if (!Array.isArray(existingMemories)) throw new TypeError('existingMemories authoritative collection is required');
  if (existingMemories.length > MAX_MEMORY_GRAPH_SIZE) throw new Error('memory supersession graph exceeds limit');
  const nodes = new Map();
  for (const item of existingMemories) {
    const key = String(canonicalMemoryId(item?.id));
    if (nodes.has(key)) throw new Error('duplicate memory id in supersession graph');
    nodes.set(key, item);
  }
  if (nodes.has(String(replacementId))) throw new Error('replacement id already exists');
  const authoritativeMemory = nodes.get(String(memory.id));
  if (authoritativeMemory && memoryScope(authoritativeMemory) !== memoryScope(memory)) throw new Error('cross-scope authoritative memory');
  if (!authoritativeMemory) nodes.set(String(memory.id), memory);
  const edges = new Map();
  const addEdge = (from, to) => {
    const fromKey = String(canonicalMemoryId(from));
    const toKey = String(canonicalMemoryId(to));
    const fromNode = nodes.get(fromKey);
    const toNode = nodes.get(toKey);
    if (fromNode && toNode && memoryScope(fromNode) !== memoryScope(toNode)) throw new Error('cross-scope memory supersession chain');
    if (!edges.has(fromKey)) edges.set(fromKey, new Set());
    edges.get(fromKey).add(toKey);
  };
  for (const item of nodes.values()) {
    if (item.supersededByMemoryId !== undefined && item.supersededByMemoryId !== null) addEdge(item.id, item.supersededByMemoryId);
    if (item.supersedesMemoryId !== undefined && item.supersedesMemoryId !== null) addEdge(item.supersedesMemoryId, item.id);
  }
  addEdge(memory.id, replacementId);
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error('memory supersession cycle detected');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of edges.get(id) || []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of edges.keys()) visit(id);
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) throw new TypeError('actor must be server-owned type/id');
  const type = trim(actor.type).toLowerCase();
  const id = actor.id;
  const safeId = (Number.isSafeInteger(id) && id > 0) || /^sha256:[a-f0-9]{64}$/u.test(String(id));
  if (!/^(system|advisor|service)$/u.test(type) || !safeId) throw new TypeError('actor must be server-owned type/id');
  return { type, id };
}

function transitionEvent({ memoryId, previousStatus, nextStatus, action, actor, reason, time, version }) {
  return {
    memoryId,
    previous: { status: previousStatus, version: version - 1 },
    next: { status: nextStatus, version },
    action,
    actor,
    reason,
    source: 'family_sales_memory',
    time,
    version,
  };
}

export function applyFamilySalesMemoryAction({
  memory,
  action,
  actor,
  reasonCode = '',
  note: _note = '',
  replacement = null,
  existingMemories = [],
  expectedVersion,
  now = new Date().toISOString(),
} = {}) {
  if (!memory || typeof memory !== 'object' || Array.isArray(memory)) throw new TypeError('memory is required');
  const memoryId = canonicalMemoryId(memory.id);
  const rawStatus = trim(memory.status || 'active').toLowerCase();
  const status = normalizedStatus(rawStatus);
  const normalizedAction = trim(action).toLowerCase();
  if (!MEMORY_STATUSES.has(status) || !MEMORY_ACTIONS.has(normalizedAction)) throw new Error('illegal memory transition');
  const version = requireVersion(memory.version ?? (rawStatus === 'active' ? 1 : undefined));
  requireVersion(expectedVersion, 'expectedVersion');
  if (expectedVersion !== version) throw new Error('stale memory version');
  const nowInstant = parseFamilySalesMemoryInstant(now);
  if (!Number.isFinite(nowInstant)) throw new TypeError('now must be a valid zoned ISO instant or UTC date');
  const time = new Date(nowInstant).toISOString();
  const safeActor = normalizeActor(actor);
  const safeReason = trim(reasonCode).toLowerCase();
  if (!ACTION_REASON_CODES[normalizedAction]?.has(safeReason)) throw new TypeError('reasonCode is not allowed for action');

  const legalFrom = {
    confirm: new Set(['candidate', 'conflicted']),
    reject: new Set(['candidate', 'conflicted']),
    supersede: new Set(['confirmed']),
    complete: new Set(['confirmed']),
    expire: new Set(['candidate', 'confirmed', 'conflicted']),
    restore: new Set(['rejected', 'expired', 'completed', 'archived']),
  };
  if (!legalFrom[normalizedAction].has(status)) throw new Error('illegal memory transition');
  if (normalizedAction === 'complete' && normalizeKind(memory.kind) !== 'todo') throw new Error('only todo memory can be completed');
  if (normalizedAction === 'supersede' && (!replacement || typeof replacement !== 'object' || Array.isArray(replacement))) {
    throw new TypeError('replacement is required');
  }

  const nextStatus = ({ confirm: 'confirmed', reject: 'rejected', supersede: 'superseded', complete: 'completed', expire: 'expired', restore: 'candidate' })[normalizedAction];
  const nextVersion = version + 1;
  const nextMemory = { ...memory, status: nextStatus, version: nextVersion, updatedAt: time };
  if (normalizedAction === 'confirm') {
    nextMemory.confirmedAt = time;
    nextMemory.validFrom = trim(nextMemory.validFrom) || time;
    nextMemory.invalidatedAt = null;
    nextMemory.validTo = null;
  } else if (normalizedAction === 'restore') {
    nextMemory.invalidatedAt = null;
    nextMemory.validTo = null;
  } else if (['reject', 'supersede', 'complete', 'expire'].includes(normalizedAction)) {
    nextMemory.invalidatedAt = time;
    nextMemory.validTo = time;
  }

  let replacementMemory = null;
  let replacementEvent = null;
  if (normalizedAction === 'supersede') {
    const replacementId = canonicalMemoryId(replacement.id, 'replacement id');
    if (sameMemoryId(replacementId, memoryId)) throw new Error('replacement id must differ from memory id');
    if (memory.supersedesMemoryId !== undefined && memory.supersedesMemoryId !== null
      && sameMemoryId(memory.supersedesMemoryId, replacementId)) throw new Error('memory supersession cycle detected');
    if (replacement.supersedesMemoryId !== undefined && replacement.supersedesMemoryId !== null
      && !sameMemoryId(replacement.supersedesMemoryId, memoryId)) throw new Error('replacement supersedes chain is invalid');
    validateSupersessionGraph({ memory, replacementId, existingMemories });
    const kind = normalizeKind(replacement.kind || memory.kind);
    const content = sanitizeMemoryContent(replacement.content);
    if (!kind || kind !== normalizeKind(memory.kind) || !content) throw new TypeError('replacement must keep kind and provide content');
    const normalizedValue = Object.hasOwn(replacement, 'normalizedValue')
      ? sanitizeMemoryContent(replacement.normalizedValue)
      : undefined;
    const memoryKey = Object.hasOwn(replacement, 'memoryKey')
      ? trim(replacement.memoryKey).slice(0, 120)
      : undefined;
    const replacementValidFrom = replacement.validFrom === undefined ? time : (() => {
      const instant = parseFamilySalesMemoryInstant(replacement.validFrom);
      if (!Number.isFinite(instant)) throw new TypeError('replacement validFrom must be a valid zoned ISO instant or UTC date');
      return new Date(instant).toISOString();
    })();
    if (parseFamilySalesMemoryInstant(replacementValidFrom) > nowInstant) {
      const error = new Error('scheduled supersede is unsupported');
      error.code = 'SCHEDULED_SUPERSEDE_UNSUPPORTED';
      throw error;
    }
    const priorValidFrom = trim(memory.validFrom);
    if (priorValidFrom) {
      const priorInstant = parseFamilySalesMemoryInstant(priorValidFrom);
      if (!Number.isFinite(priorInstant)) throw new TypeError('memory validFrom must be a valid zoned ISO instant or UTC date');
      if (parseFamilySalesMemoryInstant(replacementValidFrom) < priorInstant) throw new Error('replacement validFrom cannot precede memory validFrom');
    }
    nextMemory.supersededByMemoryId = replacementId;
    nextMemory.validTo = replacementValidFrom;
    replacementMemory = {
      ...memory,
      id: replacementId,
      kind,
      content,
      ...(normalizedValue !== undefined ? { normalizedValue } : {}),
      ...(memoryKey !== undefined ? { memoryKey } : {}),
      status: 'confirmed',
      version: 1,
      supersedesMemoryId: memoryId,
      supersededByMemoryId: null,
      validFrom: replacementValidFrom,
      validTo: null,
      invalidatedAt: null,
      confirmedAt: time,
      createdAt: time,
      updatedAt: time,
    };
    replacementEvent = transitionEvent({
      memoryId: replacementId,
      previousStatus: 'candidate',
      nextStatus: 'confirmed',
      action: 'confirm',
      actor: safeActor,
      reason: safeReason,
      time,
      version: 1,
    });
  }
  const event = transitionEvent({
    memoryId,
    previousStatus: status,
    nextStatus,
    action: normalizedAction,
    actor: safeActor,
    reason: safeReason,
    time,
    version: nextVersion,
  });
  return { memory: nextMemory, replacement: replacementMemory, event, events: replacementEvent ? [event, replacementEvent] : [event] };
}

export function buildFamilySalesMemoryTransitionBundle(options = {}) {
  const result = applyFamilySalesMemoryAction(options);
  return {
    memories: result.replacement ? [result.memory, result.replacement] : [result.memory],
    events: result.events,
  };
}

function normalizeMemoryKey(kind = '', content = '') {
  return `${normalizeKind(kind)}:${sanitizeMemoryContent(content)
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(/[，。；、,.!?！？:："'“”‘’（）()[\]{}<>《》]/gu, '')
    .toLowerCase()}`;
}

function parseJsonContent(content = '') {
  const text = trim(content)
    .replace(/^```json\s*/iu, '')
    .replace(/^```\s*/u, '')
    .replace(/```$/u, '')
    .trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(jsonrepair(text));
  }
}

export function normalizeExtractedFamilySalesMemories(value = {}) {
  const source = Array.isArray(value) ? value : value?.memories;
  if (Array.isArray(source) && source.length > MAX_EXTRACTED_MEMORY_ITEMS) return [];
  const seen = new Set();
  return (Array.isArray(source) ? source : [])
    .map((item) => {
      let raw;
      try {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        raw = {};
        for (const [key, limit] of [['kind', 32], ['key', 120], ['memoryKey', 120], ['content', 2_000], ['text', 2_000], ['summary', 2_000], ['normalizedValue', 500], ['validFrom', 64]]) {
          const field = item[key];
          if (field !== undefined && field !== null && !['string', 'number', 'boolean'].includes(typeof field)) return null;
          if (field !== undefined && field !== null && String(field).length > limit) return null;
          raw[key] = field;
        }
        raw.confidence = item.confidence;
      } catch {
        return null;
      }
      const kind = normalizeKind(raw.kind);
      const content = sanitizeMemoryContent(raw.content || raw.text || raw.summary);
      const confidence = clampConfidence(raw.confidence);
      return { kind, content, confidence };
    })
    .filter(Boolean)
    .filter((item) => item.kind && item.content && item.confidence >= 0.7)
    .filter((item) => {
      const key = normalizeMemoryKey(item.kind, item.content);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function resolveFamilySalesMemoryConfig(env = process.env) {
  return {
    apiKey: trim(env.FAMILY_SALES_MEMORY_API_KEY || env.DEEPSEEK_API_KEY || env.FAMILY_SALES_CHAT_API_KEY),
    baseUrl: trim(env.FAMILY_SALES_MEMORY_BASE_URL || env.DEEPSEEK_BASE_URL || env.FAMILY_SALES_CHAT_BASE_URL) || DEFAULT_DEEPSEEK_BASE_URL,
    model: trim(env.FAMILY_SALES_MEMORY_MODEL) || DEFAULT_MEMORY_MODEL,
    timeoutMs: boundedNumber(env.FAMILY_SALES_MEMORY_TIMEOUT_MS || env.DEEPSEEK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 120_000),
    maxTokens: boundedNumber(env.FAMILY_SALES_MEMORY_MAX_TOKENS, DEFAULT_MAX_TOKENS, 100, 4_000),
  };
}

async function readBoundedModelResponse(response, controller) {
  const contentLengthText = response?.headers?.get?.('content-length');
  if (contentLengthText && /^\d+$/u.test(contentLengthText.trim()) && Number(contentLengthText) > MAX_MODEL_RESPONSE_CHARS) {
    await response?.body?.cancel?.().catch(() => {});
    controller.abort();
    return null;
  }
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let byteCount = 0;
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new TypeError('model response chunk must be bytes');
        byteCount += value.byteLength;
        if (byteCount > MAX_MODEL_RESPONSE_CHARS) {
          await reader.cancel('model response exceeds limit');
          controller.abort();
          return null;
        }
        text += decoder.decode(value, { stream: true });
        if (text.length > MAX_MODEL_RESPONSE_CHARS) {
          await reader.cancel('model response exceeds limit');
          controller.abort();
          return null;
        }
      }
      text += decoder.decode();
      return text.length <= MAX_MODEL_RESPONSE_CHARS ? text : null;
    } finally {
      reader.releaseLock?.();
    }
  }
  // Test doubles and legacy fetch shims may omit a readable body; cap their text before parsing.
  const text = await response.text();
  if (text.length > MAX_MODEL_RESPONSE_CHARS) {
    controller.abort();
    return null;
  }
  return text;
}

export async function extractFamilySalesMemories({
  userMessage = null,
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const config = resolveFamilySalesMemoryConfig(env);
  if (!config.apiKey) return [];
  const userContent = sanitizeMemorySourceText(userMessage?.content || '', 800);
  if (!userContent) return [];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const body = {
      model: config.model,
      max_tokens: config.maxTokens,
      messages: [
        {
          role: 'system',
          content: [
            '你是保险销售续聊 memory 提炼器，只输出 JSON。',
            '目标：只从顾问本轮输入中提炼可复用的家庭跟进记忆。',
            '助手回复和已有记忆都不是本次事实来源，不得补充、推断或固化其中的信息。',
            '只保留明确、长期可复用、属于当前家庭的信息；不要保存完整原文。',
            '不要保存手机号、身份证号、证件号或任何可直接识别身份的号码。',
            '不要把保单金额、责任条款、收益、分红或理赔结论当成已确认事实；这类内容只能在需要补证据时写成 todo/correction。',
            '可选 kind：objection, preference, strategy, correction, todo。',
            'JSON 格式：{"memories":[{"kind":"objection","content":"不超过80字","confidence":0.9}]}',
            '如果没有值得记住的内容，返回 {"memories":[]}',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            '本轮顾问输入（唯一事实来源）：',
            userContent,
          ].join('\n'),
        },
      ],
    };
    if (DEEPSEEK_V4_MODELS.has(config.model)) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = 'low';
    } else {
      body.temperature = 0;
    }
    const response = await fetchImpl(new URL('/chat/completions', config.baseUrl), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) return [];
    if (!response.body && typeof response.text !== 'function') return [];
    const responseText = await readBoundedModelResponse(response, controller);
    if (responseText === null || responseText.length > MAX_MODEL_RESPONSE_CHARS) return [];
    const payload = JSON.parse(responseText);
    const parsed = parseJsonContent(payload?.choices?.[0]?.message?.content);
    return normalizeExtractedFamilySalesMemories(parsed || {});
  } catch {
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

function ownerKey(owner = {}) {
  return `${Number(owner.ownerUserId || 0) || 0}:${trim(owner.ownerGuestId)}`;
}

function memoryOwnerKey(memory = {}) {
  return ownerKey({
    ownerUserId: memory.ownerUserId,
    ownerGuestId: memory.ownerGuestId,
  });
}

function mergeEvidenceMessageIds(current = [], next = []) {
  const ids = [...(Array.isArray(current) ? current : []), ...(Array.isArray(next) ? next : [])]
    .map((id) => Number(id || 0))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  return Array.from(new Set(ids)).slice(0, 12);
}

export function upsertFamilySalesMemories({
  state,
  familyId,
  owner = {},
  sourceThreadId = 0,
  userMessage = null,
  extractedMemories = [],
  allocateId,
  nowIso = () => new Date().toISOString(),
} = {}) {
  const targetFamilyId = Number(familyId || 0);
  if (!state || !targetFamilyId || typeof allocateId !== 'function') return { changed: false, memories: [], changes: [] };
  const normalizedOwner = {
    ownerUserId: Number(owner.ownerUserId || 0) || null,
    ownerGuestId: Number(owner.ownerUserId || 0) ? '' : trim(owner.ownerGuestId),
  };
  const targetOwnerKey = ownerKey(normalizedOwner);
  const now = nowIso();
  const eventSourceMessageId = Number(userMessage?.id || 0);
  const evidenceMessageIds = mergeEvidenceMessageIds([], [userMessage?.id]);
  const normalized = normalizeExtractedFamilySalesMemories(extractedMemories);
  if (!normalized.length) return { changed: false, memories: [], changes: [] };

  state.familySalesMemories = Array.isArray(state.familySalesMemories) ? state.familySalesMemories : [];
  const changedMemories = [];
  const changes = [];
  for (const item of normalized) {
    const key = normalizeMemoryKey(item.kind, item.content);
    const existing = state.familySalesMemories.find((memory) => (
      Number(memory?.familyId || 0) === targetFamilyId &&
      ['candidate', 'confirmed', 'active'].includes(String(memory?.status || 'active')) &&
      memoryOwnerKey(memory) === targetOwnerKey &&
      normalizeMemoryKey(memory?.kind, memory?.content) === key
    ));
    if (existing) {
      const previousVersion = Number(existing.version || 1);
      const previousEvidenceMessageIds = [...(existing.evidenceMessageIds || [])];
      const confidence = Math.max(clampConfidence(existing.confidence), item.confidence);
      const mergedEvidence = mergeEvidenceMessageIds(existing.evidenceMessageIds, evidenceMessageIds);
      const nextSourceThreadId = Number(sourceThreadId || existing.sourceThreadId || 0);
      if (confidence === clampConfidence(existing.confidence)
        && JSON.stringify(mergedEvidence) === JSON.stringify(existing.evidenceMessageIds || [])
        && nextSourceThreadId === Number(existing.sourceThreadId || 0)) continue;
      existing.confidence = confidence;
      existing.evidenceMessageIds = mergedEvidence;
      existing.sourceMessageIds = mergedEvidence;
      existing.sourceMessageId = mergedEvidence[0] || null;
      existing.sourceThreadId = nextSourceThreadId;
      existing.version = previousVersion + 1;
      existing.updatedAt = now;
      changedMemories.push(existing);
      changes.push({ kind: 'reinforced', memory: { ...existing, evidenceMessageIds: [...existing.evidenceMessageIds], sourceMessageIds: [...existing.sourceMessageIds] }, expectedVersion: previousVersion, previousEvidenceMessageIds, addedEvidenceMessageIds: mergedEvidence.filter((id) => !previousEvidenceMessageIds.includes(id)), eventSourceMessageId: Number.isSafeInteger(eventSourceMessageId) && eventSourceMessageId > 0 ? eventSourceMessageId : null });
      continue;
    }
    const autoConfirmed = isAutoConfirmableMemory(item);
    const memory = {
      id: allocateId(state),
      familyId: targetFamilyId,
      ownerUserId: normalizedOwner.ownerUserId,
      ownerGuestId: normalizedOwner.ownerGuestId,
      kind: item.kind,
      content: item.content,
      evidenceMessageIds,
      sourceMessageIds: evidenceMessageIds,
      sourceMessageId: evidenceMessageIds[0] || null,
      sourceType: 'user_statement',
      recordedAt: now,
      extractorVersion: 'family_sales_memory_v1',
      sourceThreadId: Number(sourceThreadId || 0) || null,
      status: autoConfirmed ? 'confirmed' : 'candidate',
      confirmationType: autoConfirmed ? 'automatic_low_risk' : 'pending_advisor_review',
      confirmedBy: autoConfirmed ? 'system:memory_extractor' : '',
      confidence: item.confidence,
      version: 1,
      validFrom: autoConfirmed ? now : null,
      confirmedAt: autoConfirmed ? now : null,
      createdAt: now,
      updatedAt: now,
    };
    state.familySalesMemories.push(memory);
    changedMemories.push(memory);
    changes.push({ kind: 'new', memory: { ...memory }, expectedVersion: 0 });
  }

  const active = state.familySalesMemories
    .filter((memory) => (
      Number(memory?.familyId || 0) === targetFamilyId &&
      ['candidate', 'confirmed', 'active'].includes(String(memory?.status || 'active')) &&
      memoryOwnerKey(memory) === targetOwnerKey
    ))
    .sort((left, right) => (
      String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')) ||
      Number(right.id || 0) - Number(left.id || 0)
    ));
  for (const memory of active.slice(FAMILY_SALES_MEMORY_LIMIT)) {
    if (memory.status === 'archived') continue;
    const previousVersion = Number(memory.version || 1);
    const previousStatus = String(memory.status || 'candidate') === 'active' ? 'confirmed' : String(memory.status || 'candidate');
    memory.status = 'archived';
    memory.version = previousVersion + 1;
    memory.updatedAt = now;
    changedMemories.push(memory);
    changes.push({ kind: 'archived', memory: { ...memory }, expectedVersion: previousVersion, previousStatus });
  }

  return { changed: changes.length > 0, memories: changedMemories, changes };
}

export function isCurrentFamilySalesMemory(memory = {}, { asOf = new Date().toISOString() } = {}) {
  if (!CURRENT_MEMORY_STATUSES.has(trim(memory?.status || 'active').toLowerCase())) return false;
  if (trim(memory?.invalidatedAt)) return false;
  const point = parseFamilySalesMemoryInstant(asOf);
  if (!Number.isFinite(point)) return false;
  const validFromText = trim(memory?.validFrom);
  const validToText = trim(memory?.validTo);
  const validFrom = validFromText ? parseFamilySalesMemoryInstant(validFromText) : Number.NEGATIVE_INFINITY;
  const validTo = validToText ? parseFamilySalesMemoryInstant(validToText) : Number.POSITIVE_INFINITY;
  if (validFromText && !Number.isFinite(validFrom)) return false;
  if (validToText && !Number.isFinite(validTo)) return false;
  return validFrom <= point && validTo > point;
}

export function buildFamilySalesMemoryContext(memories = [], { asOf = new Date().toISOString() } = {}) {
  const active = (Array.isArray(memories) ? memories : [])
    .filter((memory) => isCurrentFamilySalesMemory(memory, { asOf }))
    .sort((left, right) => (
      String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')) ||
      Number(right.id || 0) - Number(left.id || 0)
    ))
    .slice(0, FAMILY_SALES_MEMORY_LIMIT)
    .map((memory) => ({
      kind: normalizeKind(memory?.kind),
      content: sanitizeMemoryContent(memory?.content),
      confidence: clampConfidence(memory?.confidence),
      evidenceMessageIds: mergeEvidenceMessageIds(memory?.evidenceMessageIds, []),
      sourceThreadId: Number(memory?.sourceThreadId || 0) || null,
      updatedAt: memory?.updatedAt || memory?.createdAt || '',
    }))
    .filter((memory) => memory.kind && memory.content);
  if (!active.length) return null;
  return {
    memoryCount: active.length,
    memories: active,
    usageHint: '这些是当前家庭历史续聊自动提炼的跟进记忆，只能用于沟通风格、客户异议、策略偏好和待办；保单事实、责任条款、金额、收益仍以当前家庭数据和官网证据为准。',
  };
}
