const KNOWN_AGENTS = new Set(['sales_champion', 'insurance_expert']);
const MAX_ANSWER_LENGTH = 8_000;
const MAX_TASK_ID_LENGTH = 160;
const MAX_ARRAY_LENGTH = 20;
const MAX_ITEM_LENGTH = 500;
const MAX_EVIDENCE_FIELD_LENGTH = 300;

const SENSITIVE_LABELED_VALUE = /(?:raw[ _-]?ocr|ocr[ _-]?(?:text|content)|system[ _-]?prompt|hidden[ _-]?prompt|chain[ _-]?of[ _-]?thought|reasoning|private[ _-]?tool[ _-]?trace|tool[ _-]?trace|internal[ _-]?path|base64[ _-]?(?:image|data)|(?:access[ _-]?|refresh[ _-]?)?token|api[ _-]?key|secret|password)\s*[:=：][^\n；;]*/giu;
const CHINA_ID = /(?<!\d)\d{17}[\dXx](?!\d)/gu;
const CHINA_MOBILE = /(?<!\d)1[3-9]\d{9}(?!\d)/gu;
const DATA_URL = /data:(?:image|application)\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/giu;
const INTERNAL_PATH = /(?:(?:\/)?\.runtime(?:\/[\w.@~+(), -]+)+|\/(?:Users|home|srv|var|tmp|private|Volumes|opt|etc|root)(?:\/[\w.@~+(), -]+)+|[A-Za-z]:\\(?:Users|Windows|ProgramData|private|tmp)\\[^\s；;]*)/gu;
const PRIVATE_KEY = /-----BEGIN [^-\n]*(?:PRIVATE KEY|TOKEN)[\s\S]*?-----END [^-\n]+-----/gu;

function safeRead(value, key) {
  try {
    return value?.[key];
  } catch {
    return undefined;
  }
}

function sanitizeText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .replace(PRIVATE_KEY, '[REDACTED]')
    .replace(SENSITIVE_LABELED_VALUE, '[REDACTED]')
    .replace(DATA_URL, '[REDACTED]')
    .replace(INTERNAL_PATH, '[REDACTED]')
    .replace(CHINA_ID, '[REDACTED]')
    .replace(CHINA_MOBILE, '[REDACTED]')
    .trim()
    .slice(0, maxLength);
}

function requireBoundedString(input, key, maxLength) {
  const value = safeRead(input, key);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${key} must be a non-empty string`);
  }
  const sanitized = sanitizeText(value, maxLength);
  if (!sanitized || sanitized === '[REDACTED]') {
    throw new TypeError(`${key} does not contain safe text`);
  }
  return sanitized;
}

function projectStringArray(input) {
  if (!Array.isArray(input)) return [];
  const result = [];
  for (let index = 0; index < Math.min(input.length, MAX_ARRAY_LENGTH); index += 1) {
    let value;
    try {
      value = input[index];
    } catch {
      continue;
    }
    const sanitized = sanitizeText(value, MAX_ITEM_LENGTH);
    if (sanitized && sanitized !== '[REDACTED]') result.push(sanitized);
  }
  return result;
}

function sanitizePublicUrl(value) {
  if (typeof value !== 'string' || value.length > 2_000 || DATA_URL.test(value)) return '';
  DATA_URL.lastIndex = 0;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || host === 'localhost' || host.endsWith('.local') || host === '0.0.0.0'
      || /^127\./u.test(host) || /^10\./u.test(host) || /^192\.168\./u.test(host)
      || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host)) return '';
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|secret|password|key|signature|credential)/iu.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function projectEvidence(input) {
  if (!Array.isArray(input)) return [];
  const result = [];
  for (let index = 0; index < input.length && result.length < MAX_ARRAY_LENGTH; index += 1) {
    let item;
    try {
      item = input[index];
    } catch {
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const label = sanitizeText(safeRead(item, 'label'), MAX_EVIDENCE_FIELD_LENGTH);
    const sourceRef = sanitizeText(safeRead(item, 'sourceRef'), MAX_EVIDENCE_FIELD_LENGTH);
    const version = sanitizeText(safeRead(item, 'version'), MAX_EVIDENCE_FIELD_LENGTH);
    if (!label || !sourceRef || !version) continue;
    const projected = { label, sourceRef, version };
    if (safeRead(item, 'approvedPublicEvidence') === true) {
      const url = sanitizePublicUrl(safeRead(item, 'url'));
      if (url) projected.url = url;
    }
    result.push(projected);
  }
  return result;
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') deepFreeze(child);
  }
  return Object.freeze(value);
}

export function buildDomainAgentEnvelope(input) {
  if (!input || (typeof input !== 'object' && typeof input !== 'function')) {
    throw new TypeError('domain agent envelope must be an object');
  }
  const agent = safeRead(input, 'agent');
  if (!KNOWN_AGENTS.has(agent)) throw new TypeError('agent must be a known domain agent');

  const envelope = {
    agent,
    taskId: requireBoundedString(input, 'taskId', MAX_TASK_ID_LENGTH),
    answer: requireBoundedString(input, 'answer', MAX_ANSWER_LENGTH),
    evidence: projectEvidence(safeRead(input, 'evidence')),
    limitations: projectStringArray(safeRead(input, 'limitations')),
    missingInformation: projectStringArray(safeRead(input, 'missingInformation')),
  };
  return deepFreeze(envelope);
}
