import { isIP } from 'node:net';
import { types } from 'node:util';

const KNOWN_AGENTS = new Set(['sales_champion', 'insurance_expert']);
const MAX_ANSWER_LENGTH = 8_000;
const MAX_TASK_ID_LENGTH = 160;
const MAX_ARRAY_LENGTH = 20;
const MAX_ITEM_LENGTH = 500;
const MAX_EVIDENCE_FIELD_LENGTH = 300;

const SENSITIVE_LABEL = /(?:raw[ _-]?ocr|ocr[ _-]?(?:text|content)|system[ _-]?prompt|hidden[ _-]?prompt|chain[ _-]?of[ _-]?thought|reasoning|private[ _-]?tool[ _-]?trace|tool[ _-]?trace|internal[ _-]?path|base64[ _-]?(?:image|data)|(?:access[ _-]?|refresh[ _-]?)?token|api[ _-]?key|secret|password)["']?\s*[:=：]/iu;
const CHINA_ID = /(?<!\d)\d{17}[\dXx](?!\d)/gu;
const CHINA_MOBILE = /(?<!\d)1[3-9]\d{9}(?!\d)/gu;
const DATA_URL = /data:(?:image|application)\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/giu;
const INTERNAL_PATH = /(?:(?:\/)?\.runtime(?:\/[\w.@~+(), -]+)+|\/(?:Users|home|srv|var|tmp|private|Volumes|opt|etc|root)(?:\/[\w.@~+(), -]+)+|[A-Za-z]:\\(?:Users|Windows|ProgramData|private|tmp)\\[^\s；;]*)/gu;
const PRIVATE_KEY = /-----BEGIN [^-\n]*(?:PRIVATE KEY|TOKEN)[\s\S]*?-----END [^-\n]+-----/gu;

export class DomainAgentEnvelopeContractError extends TypeError {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = 'DomainAgentEnvelopeContractError';
    this.code = 'INVALID_DOMAIN_AGENT_ENVELOPE';
    this.field = field;
  }
}

function contractError(field, message) {
  return new DomainAgentEnvelopeContractError(field, message);
}

function safeRead(value, key) {
  try {
    return value?.[key];
  } catch {
    return undefined;
  }
}

function contractRead(value, key, field) {
  try {
    return value?.[key];
  } catch {
    throw contractError(field, 'contains an unreadable value');
  }
}

function sanitizeText(value, maxLength) {
  if (typeof value !== 'string') return '';
  if (SENSITIVE_LABEL.test(value)) return '[REDACTED]';
  return value
    .replace(PRIVATE_KEY, '[REDACTED]')
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
    throw contractError(key, 'must be a non-empty string');
  }
  const sanitized = sanitizeText(value, maxLength);
  if (!sanitized || sanitized === '[REDACTED]') {
    throw contractError(key, 'does not contain safe text');
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

function normalizeHostname(value) {
  if (typeof value !== 'string') return '';
  const hostname = value.trim().toLowerCase().replace(/\.$/u, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') || isIP(hostname)
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname)) return '';
  return hostname;
}

function normalizeHostPolicies(input) {
  if (!Array.isArray(input)) return [];
  const result = [];
  for (const entry of input) {
    const rawHost = typeof entry === 'string' ? entry : safeRead(entry, 'host');
    const host = normalizeHostname(rawHost);
    if (!host) continue;
    const rawPorts = typeof entry === 'object' && entry ? safeRead(entry, 'ports') : undefined;
    const ports = new Set(Array.isArray(rawPorts)
      ? rawPorts.map(Number).filter((port) => Number.isInteger(port) && port >= 1 && port <= 65_535)
      : []);
    result.push({ host, allowSubdomains: safeRead(entry, 'allowSubdomains') === true, ports });
  }
  return result;
}

function policyAllowsUrl(url, policies) {
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) return false;
  const port = url.port ? Number(url.port) : 443;
  return policies.some((policy) => {
    const hostMatches = hostname === policy.host
      || (policy.allowSubdomains && hostname.endsWith(`.${policy.host}`));
    return hostMatches && (port === 443 || policy.ports.has(port));
  });
}

function resolverAllowsUrl(url, evidence, resolver) {
  if (typeof resolver !== 'function' || url.port) return false;
  try {
    return resolver({ url: url.toString(), hostname: url.hostname, evidence }) === true;
  } catch {
    return false;
  }
}

function sanitizePublicUrl(value, evidence, options) {
  if (typeof value !== 'string' || value.length > 2_000 || DATA_URL.test(value)) return '';
  DATA_URL.lastIndex = 0;
  try {
    const url = new URL(value);
    const policies = normalizeHostPolicies(options.allowedEvidenceHosts);
    if (url.protocol !== 'https:' || url.username || url.password || !normalizeHostname(url.hostname)
      || (!policyAllowsUrl(url, policies)
        && !resolverAllowsUrl(url, evidence, options.approveEvidenceUrl))) return '';
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|secret|password|key|signature|credential)/iu.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function projectEvidence(input, options) {
  if (input === undefined) return [];
  if (types.isProxy(input)) throw contractError('evidence', 'must be a real array');
  let isArray;
  try {
    isArray = Array.isArray(input);
  } catch {
    throw contractError('evidence', 'must be a readable array');
  }
  if (!isArray) throw contractError('evidence', 'must be an array');
  const length = contractRead(input, 'length', 'evidence');
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARRAY_LENGTH) {
    throw contractError('evidence', `must contain at most ${MAX_ARRAY_LENGTH} entries`);
  }
  const result = [];
  for (let index = 0; index < Math.min(length, MAX_ARRAY_LENGTH); index += 1) {
    let item;
    try {
      item = input[index];
    } catch {
      throw contractError('evidence', 'contains an unreadable entry');
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw contractError('evidence', 'entries must be objects');
    }
    const label = sanitizeText(safeRead(item, 'label'), MAX_EVIDENCE_FIELD_LENGTH);
    const sourceRef = sanitizeText(safeRead(item, 'sourceRef'), MAX_EVIDENCE_FIELD_LENGTH);
    const version = sanitizeText(safeRead(item, 'version'), MAX_EVIDENCE_FIELD_LENGTH);
    if (!label || label === '[REDACTED]' || !sourceRef || sourceRef === '[REDACTED]'
      || !version || version === '[REDACTED]') {
      throw contractError('evidence', 'entries require safe non-empty string label, sourceRef, and version');
    }
    const projected = { label, sourceRef, version };
    const url = sanitizePublicUrl(safeRead(item, 'url'), item, options);
    if (url) projected.url = url;
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

export function buildDomainAgentEnvelope(input, options = {}) {
  if (!input || typeof input !== 'object' || types.isProxy(input)) {
    throw contractError('envelope', 'must be a plain object');
  }
  let prototype;
  try {
    prototype = Object.getPrototypeOf(input);
  } catch {
    throw contractError('envelope', 'must be a plain object');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw contractError('envelope', 'must be a plain object');
  }
  const agent = safeRead(input, 'agent');
  if (!KNOWN_AGENTS.has(agent)) throw contractError('agent', 'must be a known domain agent');

  const envelope = {
    agent,
    taskId: requireBoundedString(input, 'taskId', MAX_TASK_ID_LENGTH),
    answer: requireBoundedString(input, 'answer', MAX_ANSWER_LENGTH),
    evidence: projectEvidence(contractRead(input, 'evidence', 'evidence'), options && typeof options === 'object' ? options : {}),
    limitations: projectStringArray(safeRead(input, 'limitations')),
    missingInformation: projectStringArray(safeRead(input, 'missingInformation')),
  };
  return deepFreeze(envelope);
}
