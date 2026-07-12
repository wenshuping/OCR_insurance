const PATTERNS = [
  /\b1[3-9]\d{9}\b/gu,
  /\b[1-9]\d{5}(?:\d{8}[\dXx]|(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])\b/gu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  /\b(?:\d[ -]?){12,19}\b/gu,
  /\b(?:护照|passport|保单号|合同号|账号|账户|account)\s*[:：#]?\s*[A-Z0-9][A-Z0-9_-]{5,30}\b/giu,
  /\b(?:微信|wechat|wx)\s*[:：号]?\s*[A-Z][-_A-Z0-9]{5,19}\b/giu,
  /(?:住址|地址|居住于|居住在)\s*[:：]?\s*[^，。；;\n]{6,80}/gu,
  /\{\{(?:id_number|mobile|email|account|address)_\d+\}\}/gu,
];
const INSTRUCTION_MARKERS = /(?:system\s*prompt|assistant\s*:|developer\s*:|ignore\s+(?:all\s+)?previous|忽略(?:以上|此前|所有)指令|系统提示|开发者消息|<\/?(?:system|assistant|tool)>)/giu;

export function sanitizePublicContent(value, { limit = 220 } = {}) {
  let content = String(value || '');
  for (const pattern of PATTERNS) content = content.replace(pattern, '敏感信息已脱敏');
  content = content.replace(INSTRUCTION_MARKERS, '不可信指令已移除').replace(/\s+/gu, ' ').trim().slice(0, limit);
  return { content, untrustedData: true };
}

export function sanitizeMemoryForPublic(memory = {}) {
  const content = sanitizePublicContent(memory.content);
  const normalized = memory.normalizedValue ? sanitizePublicContent(memory.normalizedValue) : null;
  return {
    id: memory.id, kind: memory.kind, status: memory.status === 'active' ? 'confirmed' : memory.status,
    content: content.content, untrustedData: true,
    ...(normalized ? { normalizedValue: normalized.content } : {}),
    version: Number(memory.version || 1), validFrom: memory.validFrom || null, validTo: memory.validTo || null,
    createdAt: memory.createdAt || '', updatedAt: memory.updatedAt || '',
  };
}
