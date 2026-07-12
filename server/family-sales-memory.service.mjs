import { jsonrepair } from 'jsonrepair';

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MEMORY_MODEL = 'deepseek-v4-flash';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 1_200;
const FAMILY_SALES_MEMORY_LIMIT = 20;
const MEMORY_KINDS = new Set(['objection', 'preference', 'strategy', 'correction', 'todo']);
const CURRENT_MEMORY_STATUSES = new Set(['confirmed', 'active']);
const DEEPSEEK_V4_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);
const CHINA_ID_NUMBER_PATTERN = /\b(?:[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]|[1-9]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3})\b/gu;
const MOBILE_PATTERN = /\b1[3-9]\d{9}\b/gu;

function trim(value) {
  return String(value || '').trim();
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
  assistantMessage = null,
  existingMemories = [],
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const config = resolveFamilySalesMemoryConfig(env);
  if (!config.apiKey) return [];
  const userContent = sanitizeMemorySourceText(userMessage?.content || '', 800);
  const assistantContent = sanitizeMemorySourceText(assistantMessage?.content || '', 1_600);
  if (!userContent || !assistantContent) return [];

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
            '目标：从顾问本轮追问和助手回复中提炼可复用的家庭跟进记忆。',
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
            '已有 memory 摘要：',
            JSON.stringify(buildFamilySalesMemoryContext(existingMemories)?.memories || [], null, 2),
            '',
            '本轮顾问追问：',
            userContent,
            '',
            '本轮助手回复：',
            assistantContent,
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
  assistantMessage = null,
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
  const evidenceMessageIds = mergeEvidenceMessageIds([], [userMessage?.id, assistantMessage?.id]);
  const normalized = normalizeExtractedFamilySalesMemories(extractedMemories);
  if (!normalized.length) return { changed: false, memories: [] };

  state.familySalesMemories = Array.isArray(state.familySalesMemories) ? state.familySalesMemories : [];
  const changedMemories = [];
  for (const item of normalized) {
    const key = normalizeMemoryKey(item.kind, item.content);
    const existing = state.familySalesMemories.find((memory) => (
      Number(memory?.familyId || 0) === targetFamilyId &&
      String(memory?.status || 'active') === 'active' &&
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
    const memory = {
      id: allocateId(state),
      familyId: targetFamilyId,
      ownerUserId: normalizedOwner.ownerUserId,
      ownerGuestId: normalizedOwner.ownerGuestId,
      kind: item.kind,
      content: item.content,
      evidenceMessageIds,
      sourceThreadId: Number(sourceThreadId || 0) || null,
      status: 'active',
      confidence: item.confidence,
      createdAt: now,
      updatedAt: now,
    };
    state.familySalesMemories.push(memory);
    changedMemories.push(memory);
  }

  const active = state.familySalesMemories
    .filter((memory) => (
      Number(memory?.familyId || 0) === targetFamilyId &&
      String(memory?.status || 'active') === 'active' &&
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
  const point = Date.parse(asOf);
  if (!Number.isFinite(point)) return false;
  const validFromText = trim(memory?.validFrom);
  const validToText = trim(memory?.validTo);
  const validFrom = validFromText ? Date.parse(validFromText) : Number.NEGATIVE_INFINITY;
  const validTo = validToText ? Date.parse(validToText) : Number.POSITIVE_INFINITY;
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
