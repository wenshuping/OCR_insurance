import { readFileSync } from 'node:fs';

const IDENTITY_FIELDS = ['productKey', 'canonicalProductId'];
const SOURCE_FIELDS = ['sourceDigest', 'sourceUrl', 'version', 'productVersionId', 'publisherVersion'];

function text(value) {
  return String(value ?? '').trim();
}

function exactProductName(value) {
  return text(value).normalize('NFKC').replace(/\s+/gu, '');
}

function valueFor(record, field) {
  return text(record?.[field] ?? record?.[field.replace(/[A-Z]/gu, (match) => `_${match.toLowerCase()}`)]);
}

function sameCompanyAndName(left, right) {
  return exactProductName(left?.company) === exactProductName(right?.company)
    && exactProductName(left?.productName ?? left?.product_name ?? left?.name)
      === exactProductName(right?.productName ?? right?.product_name ?? right?.name);
}

/**
 * Harness contract for every product/coverage/indicator/source matcher.
 * A populated key is authoritative; legacy fallback is allowed only when
 * neither side has a key and an exact official source/version identity exists.
 */
export function matchProductIdentity(candidate = {}, target = {}) {
  for (const field of IDENTITY_FIELDS) {
    const left = valueFor(candidate, field);
    const right = valueFor(target, field);
    if (left || right) return left && right && left === right;
  }

  if (!sameCompanyAndName(candidate, target)) return false;

  const candidateDigest = valueFor(candidate, 'sourceDigest');
  const targetDigest = valueFor(target, 'sourceDigest');
  if (candidateDigest || targetDigest) return Boolean(candidateDigest && targetDigest && candidateDigest === targetDigest);

  const candidateUrl = valueFor(candidate, 'sourceUrl');
  const targetUrl = valueFor(target, 'sourceUrl');
  if (candidateUrl || targetUrl) return Boolean(candidateUrl && targetUrl && candidateUrl === targetUrl);

  const candidateVersion = SOURCE_FIELDS.slice(2).map((field) => valueFor(candidate, field)).find(Boolean) || '';
  const targetVersion = SOURCE_FIELDS.slice(2).map((field) => valueFor(target, field)).find(Boolean) || '';
  return Boolean(candidateVersion && targetVersion && candidateVersion === targetVersion);
}

const PRODUCT_MATCHING_PATH_RE = /^(?:server|ocr-service|scripts|src)\//u;
const PRODUCT_MATCHING_CONTENT_RE = /(?:product|responsibil|indicator|source|保险|责任|指标|来源)/iu;
const NAME_ONLY_SQL_RE = /\bWHERE\s+company\s*=\s*\?\s+AND\s+product_name\s*=\s*\?/iu;
const NAME_ONLY_JS_RE = /(?:company\s*===?[^\n]{0,160}(?:productName|product_name)|(?:productName|product_name)\s*===?[^\n]{0,160}company)/iu;

function isExcludedPath(filePath) {
  return filePath.startsWith('tests/')
    || filePath.startsWith('scripts/harness-')
    || filePath === 'scripts/product-identity-harness.mjs';
}

/**
 * Static changed-file gate. It is intentionally conservative: a suspicious
 * name-only matcher must show the key-first/strict-legacy contract in the
 * same file before it can pass review.
 */
export function auditProductIdentityMatching({ changedFiles = [], projectRoot = process.cwd(), readFile = null } = {}) {
  const failures = [];
  const reader = readFile || ((filePath) => requireFile(filePath));
  for (const rawPath of changedFiles) {
    const filePath = String(rawPath || '').replace(/^\.\//u, '');
    if (!PRODUCT_MATCHING_PATH_RE.test(filePath) || isExcludedPath(filePath)) continue;
    const content = reader(`${projectRoot}/${filePath}`);
    if (!PRODUCT_MATCHING_CONTENT_RE.test(content)) continue;
    const suspicious = NAME_ONLY_SQL_RE.test(content) || NAME_ONLY_JS_RE.test(content);
    if (!suspicious) continue;
    const hasKeyFirst = /(?:productKey|canonicalProductId)/u.test(content)
      && /(?:sourceDigest|sourceUrl|productVersionId|publisherVersion)/u.test(content);
    const hasLegacyGuard = /legacy/iu.test(content) && /(?:missing|absent|without|缺少|缺失)/iu.test(content);
    if (!hasKeyFirst || !hasLegacyGuard) {
      failures.push(`${filePath}: product matching must be key-first; name fallback requires a legacy-missing-key guard and exact source/version evidence`);
    }
  }
  return { ok: failures.length === 0, failures };
}

function requireFile(filePath) {
  // Kept behind the injectable reader so unit tests stay filesystem-free.
  return readFileSync(filePath, 'utf8');
}
