import { isIP } from 'node:net';
import { types } from 'node:util';

const KNOWN_AGENTS = new Set(['sales_champion', 'insurance_expert']);
const MAX_ANSWER_LENGTH = 8_000;
const MAX_TASK_ID_LENGTH = 160;
const MAX_ARRAY_LENGTH = 20;
const MAX_ITEM_LENGTH = 500;
const MAX_EVIDENCE_FIELD_LENGTH = 300;
const MAX_INPUT_MULTIPLIER = 4;

const SENSITIVE_LABEL = /(?:raw[ _-]?ocr|ocr[ _-]?(?:text|content)|system[ _-]?prompt|hidden[ _-]?prompt|chain[ _-]?of[ _-]?thought|reasoning|private[ _-]?tool[ _-]?trace|tool[ _-]?trace|internal[ _-]?path|base64[ _-]?(?:image|data)|(?:access[ _-]?|refresh[ _-]?)?token|api[ _-]?key|secret|password)["']?\s*[:=：]/iu;
const CHINA_ID = /(?<!\d)\d{17}[\dXx](?!\d)/gu;
const CHINA_MOBILE = /(?<!\d)1[3-9]\d{9}(?!\d)/gu;
const DATA_URL = /data:(?:image|application)\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/giu;
const DATA_URL_TEST = /data:(?:image|application)\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/iu;
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

function requireSafeString(value, field, maxLength) {
  if (typeof value !== 'string') {
    throw contractError(field, 'must be a non-empty string');
  }
  if (value.length > maxLength * MAX_INPUT_MULTIPLIER) {
    throw contractError(field, 'exceeds the maximum input length');
  }
  if (value.trim() === '') {
    throw contractError(field, 'must be a non-empty string');
  }
  const sanitized = sanitizeText(value, maxLength);
  if (!sanitized || sanitized === '[REDACTED]') {
    throw contractError(field, 'does not contain safe text');
  }
  return sanitized;
}

function requireBoundedString(input, key, maxLength) {
  return requireSafeString(contractRead(input, key, key), key, maxLength);
}

function requireRealArray(input, field) {
  if (input === undefined) return null;
  if (types.isProxy(input)) throw contractError(field, 'must be a real array');
  let isArray;
  try {
    isArray = Array.isArray(input);
  } catch {
    throw contractError(field, 'must be a readable array');
  }
  if (!isArray) throw contractError(field, 'must be an array');
  const length = contractRead(input, 'length', field);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARRAY_LENGTH) {
    throw contractError(field, `must contain at most ${MAX_ARRAY_LENGTH} entries`);
  }
  return length;
}

function projectStringArray(input, field) {
  const length = requireRealArray(input, field);
  if (length === null) return [];
  const result = [];
  for (let index = 0; index < Math.min(length, MAX_ARRAY_LENGTH); index += 1) {
    const value = contractRead(input, index, field);
    result.push(requireSafeString(value, field, MAX_ITEM_LENGTH));
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
  if (typeof value !== 'string' || value.length > 2_000 || DATA_URL_TEST.test(value)) return '';
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
  const length = requireRealArray(input, 'evidence');
  if (length === null) return [];
  const result = [];
  for (let index = 0; index < Math.min(length, MAX_ARRAY_LENGTH); index += 1) {
    const item = contractRead(input, index, 'evidence');
    if (!item || typeof item !== 'object' || types.isProxy(item) || Array.isArray(item)) {
      throw contractError('evidence', 'entries must be objects');
    }
    const label = requireSafeString(contractRead(item, 'label', 'evidence'), 'evidence', MAX_EVIDENCE_FIELD_LENGTH);
    const sourceRef = requireSafeString(contractRead(item, 'sourceRef', 'evidence'), 'evidence', MAX_EVIDENCE_FIELD_LENGTH);
    const version = requireSafeString(contractRead(item, 'version', 'evidence'), 'evidence', MAX_EVIDENCE_FIELD_LENGTH);
    const projected = { label, sourceRef, version };
    const url = sanitizePublicUrl(contractRead(item, 'url', 'evidence'), item, options);
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
  const agent = contractRead(input, 'agent', 'agent');
  if (!KNOWN_AGENTS.has(agent)) throw contractError('agent', 'must be a known domain agent');

  const envelope = {
    agent,
    taskId: requireBoundedString(input, 'taskId', MAX_TASK_ID_LENGTH),
    answer: requireBoundedString(input, 'answer', MAX_ANSWER_LENGTH),
    evidence: projectEvidence(contractRead(input, 'evidence', 'evidence'), options && typeof options === 'object' ? options : {}),
    limitations: projectStringArray(contractRead(input, 'limitations', 'limitations'), 'limitations'),
    missingInformation: projectStringArray(contractRead(input, 'missingInformation', 'missingInformation'), 'missingInformation'),
  };
  return deepFreeze(envelope);
}
