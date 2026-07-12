import { jsonrepair } from 'jsonrepair';

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MEMORY_MODEL = 'deepseek-v4-flash';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 1_200;
const FAMILY_SALES_MEMORY_LIMIT = 20;
const MEMORY_KINDS = new Set(['objection', 'preference', 'strategy', 'correction', 'todo']);
const MEMORY_STATUSES = new Set(['candidate', 'confirmed', 'conflicted', 'superseded', 'rejected', 'expired', 'completed', 'archived']);
const MEMORY_ACTIONS = new Set(['confirm', 'reject', 'supersede', 'complete', 'expire', 'restore']);
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

function sanitizeEventText(value = '', limit = 120) {
  return sanitizeMemorySourceText(value, limit)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '邮箱已脱敏')
    .replace(/\b(?=[A-Z0-9_-]{8,}\b)(?=[A-Z0-9_-]*[A-Z])(?=[A-Z0-9_-]*\d)[A-Z0-9_-]+\b/giu, '编号已脱敏')
    .replace(/\b\d{4,}\b/gu, '编号已脱敏')
    .slice(0, limit)
    .trim();
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
  reason = '',
  replacement = null,
  expectedVersion,
  now = new Date().toISOString(),
} = {}) {
  if (!memory || typeof memory !== 'object' || Array.isArray(memory)) throw new TypeError('memory is required');
  const rawStatus = trim(memory.status || 'active').toLowerCase();
  const status = normalizedStatus(rawStatus);
  const normalizedAction = trim(action).toLowerCase();
  if (!MEMORY_STATUSES.has(status) || !MEMORY_ACTIONS.has(normalizedAction)) throw new Error('illegal memory transition');
  const version = requireVersion(memory.version);
  requireVersion(expectedVersion, 'expectedVersion');
  if (expectedVersion !== version) throw new Error('stale memory version');
  const nowInstant = parseFamilySalesMemoryInstant(now);
  if (!Number.isFinite(nowInstant)) throw new TypeError('now must be a valid zoned ISO instant or UTC date');
  const time = new Date(nowInstant).toISOString();
  const safeActor = normalizeActor(actor);
  const safeReason = sanitizeEventText(reason);
  if (['reject', 'supersede', 'expire', 'restore'].includes(normalizedAction) && !safeReason) throw new TypeError('reason is required');

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
    const replacementId = replacement.id;
    if (!(typeof replacementId === 'string' && trim(replacementId)) && !(Number.isSafeInteger(replacementId) && replacementId > 0)) {
      throw new TypeError('replacement id is required');
    }
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
      supersedesMemoryId: memory.id,
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
    memoryId: memory.id,
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
  const seen = new Set();
  return (Array.isArray(source) ? source : [])
    .map((item) => {
      const kind = normalizeKind(item?.kind);
      const content = sanitizeMemoryContent(item?.content || item?.text || item?.summary);
      const confidence = clampConfidence(item?.confidence);
      return { kind, content, confidence };
    })
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
    timeoutMs: numberOrDefault(env.FAMILY_SALES_MEMORY_TIMEOUT_MS || env.DEEPSEEK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxTokens: numberOrDefault(env.FAMILY_SALES_MEMORY_MAX_TOKENS, DEFAULT_MAX_TOKENS),
  };
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
    const payload = await response.json();
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
  if (!state || !targetFamilyId || typeof allocateId !== 'function') return { changed: false, memories: [] };
  const normalizedOwner = {
    ownerUserId: Number(owner.ownerUserId || 0) || null,
    ownerGuestId: Number(owner.ownerUserId || 0) ? '' : trim(owner.ownerGuestId),
  };
  const targetOwnerKey = ownerKey(normalizedOwner);
  const now = nowIso();
  const evidenceMessageIds = mergeEvidenceMessageIds([], [userMessage?.id]);
  const normalized = normalizeExtractedFamilySalesMemories(extractedMemories);
  if (!normalized.length) return { changed: false, memories: [] };

  state.familySalesMemories = Array.isArray(state.familySalesMemories) ? state.familySalesMemories : [];
  const changedMemories = [];
  for (const item of normalized) {
    const key = normalizeMemoryKey(item.kind, item.content);
    const existing = state.familySalesMemories.find((memory) => (
      Number(memory?.familyId || 0) === targetFamilyId &&
      ['candidate', 'confirmed', 'active'].includes(String(memory?.status || 'active')) &&
      memoryOwnerKey(memory) === targetOwnerKey &&
      normalizeMemoryKey(memory?.kind, memory?.content) === key
    ));
    if (existing) {
      existing.confidence = Math.max(clampConfidence(existing.confidence), item.confidence);
      existing.evidenceMessageIds = mergeEvidenceMessageIds(existing.evidenceMessageIds, evidenceMessageIds);
      existing.sourceThreadId = Number(sourceThreadId || existing.sourceThreadId || 0);
      existing.updatedAt = now;
      changedMemories.push(existing);
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
      sourceThreadId: Number(sourceThreadId || 0) || null,
      status: autoConfirmed ? 'confirmed' : 'candidate',
      confidence: item.confidence,
      version: 1,
      validFrom: autoConfirmed ? now : null,
      confirmedAt: autoConfirmed ? now : null,
      createdAt: now,
      updatedAt: now,
    };
    state.familySalesMemories.push(memory);
    changedMemories.push(memory);
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
    memory.status = 'archived';
    memory.updatedAt = now;
    changedMemories.push(memory);
  }

  return { changed: true, memories: changedMemories };
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
