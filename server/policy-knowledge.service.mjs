import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NEW_CHINA_PRODUCT_DISCLOSURE_URLS = [
  'https://www.newchinalife.com/info/4596',
  'https://www.newchinalife.com/info/3279_23',
];
const MAX_KNOWLEDGE_PAGE_TEXT_CHARS = 2600;
const MAX_KNOWLEDGE_PDF_BYTES = 1_500_000;
const DEFAULT_MAX_KNOWLEDGE_RESULTS = 5;
const RESPONSIBILITY_MATERIAL_LABEL_PATTERN = /^(?:条款|保险条款|利益条款|产品说明书|产品说明)$/u;
const EXCLUDED_MATERIAL_LABEL_PATTERN = /近三年|通知|费率表|现金价值表|账户价值|利益演示/u;
const MATERIAL_KEYWORD_PATTERN = /保险条款|利益条款|产品说明书|产品说明|保险责任|责任免除|给付规则/u;
const GENERIC_ENTRY_PATHS = ['', 'products', 'product', 'product-center', 'productService', 'info', 'public', 'disclosure'];
const DEFAULT_SCRAPLING_PROJECT_DIR = '/Users/wenshuping/Documents/Scrapling';
const DEFAULT_SCRAPLING_PYTHON_BIN = '/Users/wenshuping/Documents/Scrapling/.venv/bin/python';
const SCRAPLING_OUTPUT_MARKER = '__POLICY_KNOWLEDGE_JSON__';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRAPLING_CRAWLER_SCRIPT = path.join(__dirname, 'scrapling-policy-crawler.py');

function trimString(value) {
  return String(value || '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>');
}

function stripHtml(value) {
  return decodeHtmlEntities(
    String(value || '')
      .replace(/<script\b[\s\S]*?<\/script>/giu, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/giu, ' ')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/gu, ' '),
  ).trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeComparableFact(value) {
  return trimString(value)
    .replace(/[（(][^）)]*[）)]/gu, '')
    .replace(/\s+/gu, '')
    .replace(/[：:]/gu, '')
    .replace(/[^\p{Script=Han}\p{Letter}\p{Number}]/gu, '')
    .trim();
}

function normalizeOfficialDomain(value = '') {
  const raw = trimString(value)
    .replace(/^https?:\/\//iu, '')
    .replace(/\/.*$/u, '')
    .replace(/^www\./iu, '')
    .toLowerCase();
  return raw;
}

function normalizeOfficialDomains(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [values]).map(normalizeOfficialDomain).filter(Boolean)));
}

function resolveUrlHostname(url = '') {
  try {
    return new URL(trimString(url)).hostname.replace(/^www\./iu, '').toLowerCase();
  } catch {
    return '';
  }
}

function domainMatches(hostname = '', domain = '') {
  const host = normalizeOfficialDomain(hostname);
  const normalizedDomain = normalizeOfficialDomain(domain);
  if (!host || !normalizedDomain) return false;
  return host === normalizedDomain || host.endsWith(`.${normalizedDomain}`);
}

function resolveOfficialProfile(policy = {}, officialDomainProfiles = []) {
  const target = `${trimString(policy.company)} ${trimString(policy.name || policy.productName)}`;
  if (!target.trim()) return null;
  return (
    (officialDomainProfiles || []).find((profile) => {
      const aliases = Array.isArray(profile?.aliases) ? profile.aliases : [];
      return aliases.some((alias) => alias && target.includes(alias));
    }) || null
  );
}

function isOfficialUrl(url = '', policy = {}, officialDomainProfiles = []) {
  const hostname = resolveUrlHostname(url);
  if (!hostname) return false;
  const profile = resolveOfficialProfile(policy, officialDomainProfiles);
  const domains = normalizeOfficialDomains([
    ...(profile?.officialDomains || []),
    ...(profile?.siteDomains || []),
  ]);
  return domains.some((domain) => domainMatches(hostname, domain));
}

function resolveOfficialDomain(url = '', officialDomainProfiles = []) {
  const hostname = resolveUrlHostname(url);
  const allDomains = normalizeOfficialDomains(
    (officialDomainProfiles || []).flatMap((profile) => [...(profile?.officialDomains || []), ...(profile?.siteDomains || [])]),
  );
  return allDomains.find((domain) => domainMatches(hostname, domain)) || normalizeOfficialDomain(hostname);
}

function resolveAbsoluteUrl(href = '', baseUrl = '') {
  const decoded = decodeHtmlEntities(href);
  if (!decoded) return '';
  try {
    return new URL(decoded, baseUrl).toString();
  } catch {
    return '';
  }
}

function extractHtmlRows(html = '') {
  return Array.from(String(html || '').matchAll(/<tr\b[\s\S]*?<\/tr>/giu)).map((match) => match[0]);
}

function extractHtmlLinks(html = '', baseUrl = '') {
  return Array.from(String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu))
    .map((match) => {
      const url = resolveAbsoluteUrl(match[1], baseUrl);
      return {
        href: decodeHtmlEntities(match[1]),
        url,
        label: stripHtml(match[2]),
      };
    })
    .filter((link) => link.url && link.label);
}

function productMatchesText(productName = '', text = '') {
  const product = normalizeComparableFact(productName);
  const target = normalizeComparableFact(text);
  if (!product || !target) return false;
  return target.includes(product) || product.includes(target);
}

function normalizeProductMatchText(value = '', company = '') {
  const normalizedCompany = normalizeComparableFact(company);
  let text = normalizeComparableFact(value);
  if (!text) return '';
  if (normalizedCompany) text = text.replaceAll(normalizedCompany, '');
  return text
    .replace(/^[\p{Script=Han}]{2,14}(?:人寿|财产|养老|健康)?保险股份有限公司/gu, '')
    .replace(/^[\p{Script=Han}]{2,14}(?:人寿|财产|养老|健康)?保险有限责任公司/gu, '')
    .replace(/保险股份有限公司|保险有限责任公司|股份有限公司|有限责任公司|产品说明书|产品说明|保险条款|利益条款|条款/gu, '')
    .replace(/保险/gu, '')
    .trim();
}

function toCharSet(value = '') {
  return new Set(Array.from(value).filter(Boolean));
}

function ngrams(value = '', size = 2) {
  const chars = Array.from(value).filter(Boolean);
  if (chars.length <= size) return chars.length ? [chars.join('')] : [];
  const result = [];
  for (let index = 0; index <= chars.length - size; index += 1) {
    result.push(chars.slice(index, index + size).join(''));
  }
  return result;
}

function jaccardScore(leftValues = [], rightValues = []) {
  const left = new Set(leftValues);
  const right = new Set(rightValues);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const value of left) {
    if (right.has(value)) overlap += 1;
  }
  return overlap / (left.size + right.size - overlap);
}

function longestCommonSubstringLength(left = '', right = '') {
  const a = Array.from(left);
  const b = Array.from(right);
  if (!a.length || !b.length) return 0;
  let best = 0;
  const previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] !== b[j - 1]) continue;
      current[j] = previous[j - 1] + 1;
      if (current[j] > best) best = current[j];
    }
    for (let j = 0; j < current.length; j += 1) previous[j] = current[j];
  }
  return best;
}

function productTypeTerms(value = '') {
  const text = normalizeComparableFact(value);
  return ['两全', '年金', '终身寿', '重大疾病', '医疗', '护理', '意外', '万能', '投连', '投资连结', '增额', '分红', '养老', '寿险'].filter(
    (term) => text.includes(term),
  );
}

function scoreProductNameMatch(queryName = '', candidateName = '', company = '') {
  const query = normalizeProductMatchText(queryName, company);
  const candidate = normalizeProductMatchText(candidateName, company);
  if (!query || !candidate) return 0;
  if (query === candidate) return 1;
  const containsScore = candidate.includes(query) || query.includes(candidate) ? 0.92 : 0;
  const charScore = jaccardScore(toCharSet(query), toCharSet(candidate));
  const bigramScore = jaccardScore(ngrams(query, 2), ngrams(candidate, 2));
  const trigramScore = jaccardScore(ngrams(query, 3), ngrams(candidate, 3));
  const lcsScore = longestCommonSubstringLength(query, candidate) / Math.min(Array.from(query).length, Array.from(candidate).length);
  const queryTypes = productTypeTerms(queryName);
  const candidateTypes = productTypeTerms(candidateName);
  const hasTypeOverlap = queryTypes.some((term) => candidateTypes.includes(term));
  const hasTypeConflict = queryTypes.length && candidateTypes.length && !hasTypeOverlap;
  let score = Math.max(containsScore, trigramScore * 0.35 + bigramScore * 0.25 + charScore * 0.2 + lcsScore * 0.2);
  if (hasTypeOverlap) score += 0.08;
  if (hasTypeConflict && lcsScore < 0.75) score -= 0.06;
  return Math.max(0, Math.min(1, score));
}

function knowledgeMatchReason(score) {
  if (score >= 0.92) return '产品名称高度匹配';
  if (score >= 0.7) return '产品名称相近';
  return '产品名称部分相同';
}

function isNewChinaPolicy(policy = {}) {
  return /新华/u.test(trimString(policy.company)) || /新华/u.test(trimString(policy.name || policy.productName));
}

function extractNewChinaProductTitle(rowHtml = '', policy = {}) {
  const cells = Array.from(String(rowHtml || '').matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu))
    .map((match) => stripHtml(match[1]))
    .filter(Boolean);
  return cells.find((cell) => productMatchesText(policy.name || policy.productName, cell)) || trimString(policy.name || policy.productName);
}

function isNewChinaProductRow(rowHtml = '', policy = {}) {
  return productMatchesText(policy.name || policy.productName, stripHtml(rowHtml));
}

function classifyMaterialType(value = '') {
  const text = trimString(value);
  if (/现金价值表/u.test(text)) return 'cash_value_table';
  if (/费率表/u.test(text)) return 'rate_table';
  if (/产品说明书|产品说明/u.test(text)) return 'product_manual';
  if (/责任免除/u.test(text)) return 'exclusion';
  if (/保险条款|利益条款|条款/u.test(text)) return 'terms';
  if (/保险责任/u.test(text)) return 'responsibility';
  return /\.pdf(?:$|[?#])/iu.test(text) ? 'pdf' : 'html';
}

function resolveSourceType(url = '', contentType = '') {
  if (/application\/pdf/iu.test(contentType) || /\.pdf(?:$|[?#])/iu.test(trimString(url))) return 'pdf';
  return 'html';
}

function extractRelevantText(text = '', policy = {}) {
  const normalizedText = trimString(text);
  if (!normalizedText) return '';
  const productName = trimString(policy.name || policy.productName);
  const keywords = [
    '保险责任',
    '身故',
    '全残',
    '给付',
    '赔付',
    '报销',
    '现金价值',
    '红利',
    '责任免除',
    '投保年龄',
    '保险期间',
    '交费',
    '缴费',
    '等待期',
    '给付系数',
    '有效保险金额',
    '基本保险金额',
    '减保',
    '保单贷款',
  ];
  const sentences = normalizedText
    .split(/[。！？!?；;\n\r]+/u)
    .map((item) => trimString(item))
    .filter((item) => item.length >= 8 && item.length <= 420);
  const relevant = [];
  for (const sentence of sentences) {
    const hasProduct = productName && sentence.includes(productName);
    const hasKeyword = keywords.some((keyword) => sentence.includes(keyword));
    if (!hasProduct && !hasKeyword) continue;
    if (!relevant.includes(sentence)) relevant.push(sentence);
    if (relevant.join('。').length >= MAX_KNOWLEDGE_PAGE_TEXT_CHARS) break;
  }
  const fallbackStart = productName ? normalizedText.indexOf(productName) : -1;
  if (fallbackStart >= 0) {
    const nearby = normalizedText.slice(Math.max(0, fallbackStart - 240), fallbackStart + MAX_KNOWLEDGE_PAGE_TEXT_CHARS);
    if (!relevant.length) return nearby;
    return `${nearby}。${relevant.join('。')}`.slice(0, MAX_KNOWLEDGE_PAGE_TEXT_CHARS);
  }
  return relevant.join('。').slice(0, MAX_KNOWLEDGE_PAGE_TEXT_CHARS);
}

function extractFocusedResponsibilityText(text = '') {
  const normalizedText = trimString(text).replace(/\s+/gu, ' ');
  if (!normalizedText) return '';
  const preferred = normalizedText.search(/保险责任\s*在本合同保险期间内/u);
  const start = preferred >= 0 ? preferred : normalizedText.indexOf('保险责任');
  if (start < 0) return '';
  const early = normalizedText.slice(start, start + 700);
  const before = normalizedText.slice(Math.max(0, start - 180), start);
  const headingCount = (early.match(/保险期间|犹豫期|宽限期|合同效力|责任免除|不保什么|其他免责条款|如何申请|如何领取|保险金申请|受益人|释义|保单红利|现金价值|保险费|退保/gu) || []).length;
  const tocLike = /目\s*录|条款目录|阅读指引|阅\s*读\s*指\s*引|\.{3,}|…{2,}|……/u.test(`${before} ${early}`);
  const hasPositiveNear = /(?:我们|本公司).{0,100}(?:承担|给付|赔付|赔偿|报销)|(?:按|按照).{0,100}(?:给付|赔付|赔偿|报销)|(?:承担下列|承担以下|承担如下).{0,80}保险责任/u.test(early);
  if (tocLike && headingCount >= 2 && !hasPositiveNear) return '';
  const tail = normalizedText.slice(start);
  const endMatch = tail
    .slice(40)
    .match(/第[一二三四五六七八九十]+条\s*(?:责任免除|保单红利|保险金申请|释义|其他事项|合同内容变更)|责任免除|保单红利|保险金申请/u);
  const excerpt = endMatch ? tail.slice(0, 40 + endMatch.index) : tail.slice(0, MAX_KNOWLEDGE_PAGE_TEXT_CHARS);
  const sentences = excerpt
    .split(/(?<=[。；;])/u)
    .map((item) => trimString(item))
    .filter(Boolean);
  const keywords = [
    '保险责任',
    '身故',
    '全残',
    '身体全残',
    '给付',
    '赔付',
    '报销',
    '保险金',
    '意外伤害',
    '交通工具',
    '重大疾病',
    '医疗',
    '等待期',
    '给付系数',
    '基本保险金额',
    '有效保险金额',
    '已交保险费',
    '现金价值',
  ];
  const focused = sentences.filter((sentence) => keywords.some((keyword) => sentence.includes(keyword))).join('\n');
  const candidate = focused || excerpt;
  const hasPositiveResponsibility = /(?:我们|本公司).{0,100}(?:承担|给付|赔付|赔偿|报销).{0,100}(?:保险责任|保险金|医疗费用|津贴|保险费)|(?:按|按照).{0,100}(?:给付|赔付|赔偿|报销).{0,100}(?:保险金|医疗费用|津贴|保险费)|(?:承担下列|承担以下|承担如下).{0,80}保险责任|被保险人.{0,220}(?:身故|全残|伤残|残疾|疾病|医疗|住院|意外伤害|烧伤|达到|生存).{0,220}(?:保险金|给付|赔付|赔偿|报销|豁免)|豁免保险费/u.test(candidate);
  if (!hasPositiveResponsibility) return '';
  return candidate.slice(0, MAX_KNOWLEDGE_PAGE_TEXT_CHARS);
}

function decodePdfHexText(value = '') {
  const normalized = String(value || '').replace(/\s+/gu, '');
  if (!normalized) return '';
  const bytes = Buffer.from(normalized, 'hex');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let output = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      output += String.fromCharCode(bytes.readUInt16BE(index));
    }
    return output;
  }
  return bytes.toString('utf8');
}

function decodePdfLiteralText(value = '') {
  return String(value || '').replace(/\\([nrtbf()\\])/gu, (_match, token) => {
    const replacements = {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      '(': '(',
      ')': ')',
      '\\': '\\',
    };
    return replacements[token] || token;
  });
}

function extractPdfActualText(buffer) {
  const raw = Buffer.from(buffer || []).toString('latin1');
  if (!raw) return '';
  const values = [];
  const pattern = /\/ActualText\s*(?:\((.*?)\)|<([0-9A-Fa-f\s]+)>)/gsu;
  for (const match of raw.matchAll(pattern)) {
    const decoded = match[1] !== undefined ? decodePdfLiteralText(match[1]) : decodePdfHexText(match[2]);
    const text = trimString(decoded);
    if (text) values.push(text);
  }
  return values.join('');
}

async function extractPdfTextWithPython(buffer) {
  const raw = Buffer.from(buffer || []);
  if (!raw.length) return '';
  return new Promise((resolve) => {
    const child = spawn(
      'python3',
      [
        '-c',
        [
          'import base64, io, sys',
          'try:',
          '    from pypdf import PdfReader',
          '    data = base64.b64decode(sys.stdin.read())',
          '    reader = PdfReader(io.BytesIO(data))',
          "    print('\\n'.join((page.extract_text() or '') for page in reader.pages))",
          'except Exception:',
          '    sys.exit(0)',
        ].join('\n'),
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let output = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      resolve('');
    }, 8000);
    child.stdout.on('data', (chunk) => {
      output += String(chunk || '');
      if (output.length > 20_000) child.kill('SIGTERM');
    });
    child.on('close', () => {
      clearTimeout(timeout);
      resolve(trimString(output));
    });
    child.on('error', () => {
      clearTimeout(timeout);
      resolve('');
    });
    child.stdin.end(raw.toString('base64'));
  });
}

async function extractRelevantPdfText(buffer, policy = {}) {
  const actualText = extractPdfActualText(buffer);
  const rawText = actualText || (await extractPdfTextWithPython(buffer));
  return extractFocusedResponsibilityText(rawText) || extractRelevantText(rawText, policy);
}

async function fetchMaterialPageText({ url, policy, fetchImpl, signal } = {}) {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/html,application/xhtml+xml,application/pdf',
      },
    });
    if (!response.ok) return { pageText: '', sourceType: resolveSourceType(url), contentType: '' };
    const contentType = String(response.headers?.get?.('content-type') || '');
    const sourceType = resolveSourceType(url, contentType);
    const contentLength = Number(response.headers?.get?.('content-length') || 0);
    if (sourceType === 'pdf' && (!contentLength || contentLength <= MAX_KNOWLEDGE_PDF_BYTES)) {
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        pageText: buffer.length <= MAX_KNOWLEDGE_PDF_BYTES ? await extractRelevantPdfText(buffer, policy) : '',
        sourceType,
        contentType,
      };
    }
    if (!/(application\/msword|officedocument)/iu.test(contentType)) {
      return {
        pageText: extractRelevantText(stripHtml(await response.text()), policy),
        sourceType,
        contentType,
      };
    }
    return { pageText: '', sourceType, contentType };
  } catch {
    return { pageText: '', sourceType: resolveSourceType(url), contentType: '' };
  }
}

function buildKnowledgeRecord({ policy, title, url, snippet = '', pageText = '', parser, officialDomainProfiles = [], sourceType = '', materialType = '' }) {
  const now = nowIso();
  return {
    company: trimString(policy.company),
    productName: trimString(policy.name || policy.productName),
    title: trimString(title) || trimString(url),
    url: trimString(url),
    snippet: trimString(snippet),
    pageText: trimString(pageText),
    sourceType: sourceType || resolveSourceType(url),
    materialType: materialType || classifyMaterialType(`${title} ${url}`),
    official: isOfficialUrl(url, policy, officialDomainProfiles),
    evidenceLabel: '本地知识库官方资料',
    evidenceLevel: 'insurer_official',
    officialDomain: resolveOfficialDomain(url, officialDomainProfiles),
    parser: trimString(parser),
    discoveredAt: now,
    lastFetchedAt: now,
    updatedAt: now,
    useCount: 0,
  };
}

function runScraplingPolicyCrawler({ policy, officialDomainProfiles = [], timeoutMs = 45_000 } = {}) {
  if (!isNewChinaPolicy(policy)) return Promise.resolve([]);
  const pythonBin = trimString(process.env.SCRAPLING_PYTHON_BIN) || DEFAULT_SCRAPLING_PYTHON_BIN;
  const scraplingProjectDir = trimString(process.env.SCRAPLING_PROJECT_DIR) || DEFAULT_SCRAPLING_PROJECT_DIR;
  return new Promise((resolve) => {
    const child = spawn(pythonBin, [SCRAPLING_CRAWLER_SCRIPT], {
      cwd: scraplingProjectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (records = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(Array.isArray(records) ? records : []);
    };
    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM');
      finish([]);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on('error', () => finish([]));
    child.on('close', () => {
      const line = stdout
        .split(/\r?\n/u)
        .reverse()
        .find((item) => item.includes(SCRAPLING_OUTPUT_MARKER));
      if (!line) return finish([]);
      try {
        const payload = JSON.parse(line.slice(line.indexOf(SCRAPLING_OUTPUT_MARKER) + SCRAPLING_OUTPUT_MARKER.length));
        const records = (Array.isArray(payload?.records) ? payload.records : [])
          .map((record) =>
            normalizeKnowledgeRecord(
              {
                ...record,
                parser: trimString(record.parser) || 'scrapling',
              },
              { officialDomainProfiles },
            ),
          )
          .filter(Boolean);
        finish(records);
      } catch {
        finish([]);
      }
    });
    child.stdin.end(
      JSON.stringify({
        company: policy.company,
        name: policy.name || policy.productName,
      }),
    );
  });
}

async function parseNewChinaKnowledge({ policy, officialDomainProfiles, fetchImpl, signal } = {}) {
  if (!isNewChinaPolicy(policy)) return [];
  const productName = trimString(policy.name || policy.productName);
  if (!productName) return [];
  const records = [];
  const seenUrls = new Set();
  for (const disclosureUrlValue of NEW_CHINA_PRODUCT_DISCLOSURE_URLS) {
    const disclosureUrl = new URL(disclosureUrlValue);
    disclosureUrl.searchParams.set('productName', productName);
    try {
      const response = await fetchImpl(disclosureUrl, {
        method: 'GET',
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      if (!response.ok) continue;
      const html = await response.text();
      const productRows = extractHtmlRows(html).filter((row) => isNewChinaProductRow(row, policy));
      for (const row of productRows) {
        const productTitle = extractNewChinaProductTitle(row, policy);
        const materialLinks = extractHtmlLinks(row, disclosureUrl.toString()).filter(
          (link) => RESPONSIBILITY_MATERIAL_LABEL_PATTERN.test(link.label) && !EXCLUDED_MATERIAL_LABEL_PATTERN.test(link.label),
        );
        for (const link of materialLinks) {
          const materialUrl = link.url;
          const candidates = /\.pdf(?:$|[?#])/iu.test(materialUrl)
            ? [{ ...link, url: materialUrl, label: link.label }]
            : extractHtmlLinks(
                await fetchImpl(materialUrl, {
                  method: 'GET',
                  signal,
                  headers: {
                    'User-Agent': 'Mozilla/5.0',
                    Accept: 'text/html,application/xhtml+xml',
                  },
                }).then((materialResponse) => (materialResponse.ok ? materialResponse.text() : ''))
                  .catch(() => ''),
                materialUrl,
              ).filter(
                (nestedLink) =>
                  /\.pdf(?:$|[?#])/iu.test(nestedLink.url)
                  && productMatchesText(productName, nestedLink.label)
                  && !EXCLUDED_MATERIAL_LABEL_PATTERN.test(nestedLink.label),
              );
          for (const candidate of candidates) {
            if (!candidate.url || seenUrls.has(candidate.url)) continue;
            seenUrls.add(candidate.url);
            const { pageText, sourceType } = await fetchMaterialPageText({
              url: candidate.url,
              policy,
              fetchImpl,
              signal,
            });
            if (!pageText) continue;
            records.push(
              buildKnowledgeRecord({
                policy: { ...policy, name: productName },
                title: trimString(`${productTitle}${candidate.label && !productTitle.includes(candidate.label) ? candidate.label : ''}`),
                url: candidate.url,
                snippet: `新华保险官网产品基本信息披露材料：${candidate.label || link.label || '披露材料'}`,
                pageText,
                sourceType,
                materialType: classifyMaterialType(`${candidate.label} ${link.label}`),
                parser: 'new_china_disclosure',
                officialDomainProfiles,
              }),
            );
          }
        }
      }
    } catch {
      continue;
    }
  }
  return records;
}

function buildGenericEntryUrls(policy = {}, officialDomainProfiles = []) {
  const profile = resolveOfficialProfile(policy, officialDomainProfiles);
  const domains = normalizeOfficialDomains(profile?.siteDomains?.length ? profile.siteDomains : profile?.officialDomains || []);
  const urls = [];
  for (const domain of domains) {
    for (const path of GENERIC_ENTRY_PATHS) {
      urls.push(`https://${domain}/${path}`.replace(/\/$/u, '/'));
      if (!domain.startsWith('www.')) urls.push(`https://www.${domain}/${path}`.replace(/\/$/u, '/'));
    }
  }
  return Array.from(new Set(urls));
}

async function parseGenericOfficialKnowledge({ policy, officialDomainProfiles, fetchImpl, signal } = {}) {
  const productName = trimString(policy.name || policy.productName);
  if (!trimString(policy.company) || !productName) return [];
  const records = [];
  const seenUrls = new Set();
  for (const entryUrl of buildGenericEntryUrls(policy, officialDomainProfiles)) {
    try {
      const response = await fetchImpl(entryUrl, {
        method: 'GET',
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      if (!response.ok) continue;
      const html = await response.text();
      const links = extractHtmlLinks(html, entryUrl).filter((link) => {
        const text = `${link.label} ${link.url}`;
        return isOfficialUrl(link.url, policy, officialDomainProfiles)
          && productMatchesText(productName, text)
          && !EXCLUDED_MATERIAL_LABEL_PATTERN.test(text)
          && (MATERIAL_KEYWORD_PATTERN.test(text) || /\.pdf(?:$|[?#])/iu.test(link.url));
      });
      for (const link of links) {
        if (seenUrls.has(link.url)) continue;
        seenUrls.add(link.url);
        const { pageText, sourceType } = await fetchMaterialPageText({
          url: link.url,
          policy,
          fetchImpl,
          signal,
        });
        if (!pageText) continue;
        records.push(
          buildKnowledgeRecord({
            policy,
            title: link.label,
            url: link.url,
            snippet: `${trimString(policy.company)}官网页面发现的产品资料`,
            pageText,
            sourceType,
            materialType: classifyMaterialType(`${link.label} ${link.url}`),
            parser: 'generic_official_links',
            officialDomainProfiles,
          }),
        );
      }
    } catch {
      continue;
    }
  }
  return records;
}

export function normalizeKnowledgeRecord(record = {}, { officialDomainProfiles = [] } = {}) {
  const url = trimString(record.url);
  const company = trimString(record.company);
  const productName = trimString(record.productName || record.name);
  if (!url || !company || !productName) return null;
  const now = nowIso();
  const policy = { company, name: productName };
  return {
    id: record.id,
    company,
    productName,
    productType: trimString(record.productType),
    salesStatus: trimString(record.salesStatus),
    title: trimString(record.title) || url,
    url,
    snippet: trimString(record.snippet),
    pageText: trimString(record.pageText),
    sourceType: trimString(record.sourceType) || resolveSourceType(url),
    materialType: trimString(record.materialType) || classifyMaterialType(`${record.title} ${url}`),
    official: record.official === undefined ? isOfficialUrl(url, policy, officialDomainProfiles) : Boolean(record.official),
    evidenceLabel: trimString(record.evidenceLabel) || '本地知识库官方资料',
    evidenceLevel: trimString(record.evidenceLevel) || 'insurer_official',
    officialDomain: trimString(record.officialDomain) || resolveOfficialDomain(url, officialDomainProfiles),
    parser: trimString(record.parser),
    qualityStatus: trimString(record.qualityStatus),
    qualityReason: trimString(record.qualityReason),
    discoveredAt: trimString(record.discoveredAt) || now,
    lastFetchedAt: trimString(record.lastFetchedAt) || now,
    updatedAt: trimString(record.updatedAt) || now,
    lastUsedAt: trimString(record.lastUsedAt),
    useCount: Number(record.useCount || 0) || 0,
  };
}

export function upsertKnowledgeRecords(state, records = [], { allocateId, officialDomainProfiles = [] } = {}) {
  if (!state) return [];
  if (!Array.isArray(state.knowledgeRecords)) state.knowledgeRecords = [];
  const saved = [];
  for (const rawRecord of Array.isArray(records) ? records : []) {
    const record = normalizeKnowledgeRecord(rawRecord, { officialDomainProfiles });
    if (!record) continue;
    const existing = state.knowledgeRecords.find((row) => String(row.url || '') === record.url) || null;
    if (existing) {
      existing.company = record.company || existing.company;
      existing.productName = record.productName || existing.productName;
      existing.productType = record.productType || existing.productType;
      existing.salesStatus = record.salesStatus || existing.salesStatus;
      existing.title = record.title || existing.title;
      existing.snippet = record.snippet || existing.snippet;
      existing.pageText = record.pageText || existing.pageText;
      existing.sourceType = record.sourceType || existing.sourceType;
      existing.materialType = record.materialType || existing.materialType;
      existing.official = Boolean(record.official);
      existing.evidenceLabel = record.evidenceLabel || existing.evidenceLabel;
      existing.evidenceLevel = record.evidenceLevel || existing.evidenceLevel;
      existing.officialDomain = record.officialDomain || existing.officialDomain;
      existing.parser = record.parser || existing.parser;
      existing.qualityStatus = record.qualityStatus || existing.qualityStatus;
      existing.qualityReason = record.qualityReason || existing.qualityReason;
      existing.lastFetchedAt = record.lastFetchedAt || existing.lastFetchedAt;
      existing.updatedAt = nowIso();
      saved.push(existing);
      continue;
    }
    const next = {
      ...record,
      id: record.id || (typeof allocateId === 'function' ? allocateId(state) : undefined),
    };
    state.knowledgeRecords.push(next);
    saved.push(next);
  }
  return saved;
}

export function findKnowledgeRecordsForPolicy({ policy = {}, records = [], officialDomainProfiles = [], maxResults = DEFAULT_MAX_KNOWLEDGE_RESULTS } = {}) {
  const productName = trimString(policy.name || policy.productName);
  const company = trimString(policy.company);
  if (!company || !productName) return [];
  return (Array.isArray(records) ? records : [])
    .map((record) => normalizeKnowledgeRecord(record, { officialDomainProfiles }))
    .filter(Boolean)
    .filter(
      (record) =>
        record.official &&
        record.pageText &&
        record.qualityStatus !== 'invalid_responsibility' &&
        (isOfficialUrl(record.url, policy, officialDomainProfiles) ||
          domainMatches(resolveUrlHostname(record.url), record.officialDomain)),
    )
    .filter((record) => {
      const companyMatch = !record.company || company.includes(record.company) || record.company.includes(company);
      return companyMatch && productMatchesText(productName, record.productName || record.title || record.url);
    })
    .sort((left, right) => {
      const leftScore = Number(Boolean(left.pageText)) * 20 + Number(left.sourceType === 'pdf') * 10 + Number(left.materialType === 'terms') * 5;
      const rightScore = Number(Boolean(right.pageText)) * 20 + Number(right.sourceType === 'pdf') * 10 + Number(right.materialType === 'terms') * 5;
      return rightScore - leftScore || String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
    })
    .slice(0, maxResults);
}

export function findKnowledgeProductCandidates({
  policy = {},
  records = [],
  officialDomainProfiles = [],
  maxResults = 8,
  minScore = 0.32,
} = {}) {
  const productName = trimString(policy.name || policy.productName);
  const company = trimString(policy.company);
  if (!company || !productName) return [];
  const grouped = new Map();
  for (const rawRecord of Array.isArray(records) ? records : []) {
    const record = normalizeKnowledgeRecord(rawRecord, { officialDomainProfiles });
    if (!record) continue;
    if (!record.official || !record.pageText || record.qualityStatus === 'invalid_responsibility') continue;
    if (
      !(
        isOfficialUrl(record.url, { company: record.company, name: record.productName }, officialDomainProfiles) ||
        domainMatches(resolveUrlHostname(record.url), record.officialDomain)
      )
    ) {
      continue;
    }
    const companyMatch = !record.company || company.includes(record.company) || record.company.includes(company);
    if (!companyMatch) continue;
    const productScore = scoreProductNameMatch(productName, record.productName, company);
    const titleScore = scoreProductNameMatch(productName, record.title, company) * 0.96;
    const score = Math.max(productScore, titleScore);
    if (score < minScore) continue;
    const key = `${record.company}\n${record.productName}`;
    const existing = grouped.get(key);
    const sourceWeight = Number(record.sourceType === 'pdf') * 0.03 + Number(record.materialType === 'terms') * 0.02;
    const rankingScore = score + sourceWeight;
    if (!existing) {
      grouped.set(key, {
        company: record.company,
        productName: record.productName,
        title: record.title,
        score,
        matchReason: knowledgeMatchReason(score),
        evidenceLabel: record.evidenceLabel || '本地知识库官方资料',
        sourceCount: 1,
        bestSource: {
          title: record.title,
          url: record.url,
          sourceType: record.sourceType,
          materialType: record.materialType,
        },
        rankingScore,
      });
      continue;
    }
    existing.sourceCount += 1;
    if (rankingScore > existing.rankingScore) {
      existing.title = record.title;
      existing.score = score;
      existing.matchReason = knowledgeMatchReason(score);
      existing.evidenceLabel = record.evidenceLabel || existing.evidenceLabel;
      existing.bestSource = {
        title: record.title,
        url: record.url,
        sourceType: record.sourceType,
        materialType: record.materialType,
      };
      existing.rankingScore = rankingScore;
    }
  }
  return [...grouped.values()]
    .sort((left, right) => right.rankingScore - left.rankingScore || right.sourceCount - left.sourceCount || left.productName.localeCompare(right.productName))
    .slice(0, maxResults)
    .map(({ rankingScore, ...item }) => ({
      ...item,
      score: Number(item.score.toFixed(3)),
    }));
}

export function buildKnowledgeSearchArtifacts({ policy = {}, records = [], officialDomainProfiles = [], maxResults = DEFAULT_MAX_KNOWLEDGE_RESULTS } = {}) {
  const matched = findKnowledgeRecordsForPolicy({ policy, records, officialDomainProfiles, maxResults });
  if (!matched.length) return { context: '', sources: [], records: [] };
  const sources = matched.map((record) => ({
    title: record.title || record.url,
    url: record.url,
    snippet: record.snippet,
    evidenceLabel: record.evidenceLabel || '本地知识库官方资料',
    evidenceLevel: 'insurer_official',
    official: true,
    sourceType: record.sourceType,
  }));
  const context = matched
    .map((record, index) =>
      [
        `【资料${index + 1}】${record.title || record.url}`,
        `证据等级：${record.evidenceLabel || '本地知识库官方资料'}`,
        record.snippet ? `摘要：${record.snippet}` : '',
        record.pageText ? `正文：${record.pageText}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
  return { context, sources, records: matched };
}

export async function crawlOfficialKnowledge({ policy = {}, officialDomainProfiles = [], fetchImpl = fetch, timeoutMs = 25_000 } = {}) {
  const normalizedPolicy = {
    company: trimString(policy.company),
    name: trimString(policy.name || policy.productName),
  };
  if (!normalizedPolicy.company || !normalizedPolicy.name) {
    const error = new Error('请填写保险公司和产品名称');
    error.code = 'KNOWLEDGE_CRAWL_POLICY_REQUIRED';
    error.status = 400;
    throw error;
  }
  const scraplingRecords = await runScraplingPolicyCrawler({
    policy: normalizedPolicy,
    officialDomainProfiles,
    timeoutMs: Math.max(timeoutMs, 45_000),
  });
  if (scraplingRecords.length) return scraplingRecords;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const parsers = [
      () => parseNewChinaKnowledge({ policy: normalizedPolicy, officialDomainProfiles, fetchImpl, signal: controller.signal }),
      () => parseGenericOfficialKnowledge({ policy: normalizedPolicy, officialDomainProfiles, fetchImpl, signal: controller.signal }),
    ];
    const recordsByUrl = new Map();
    for (const parser of parsers) {
      const records = await parser();
      for (const record of records) {
        if (record.url && !recordsByUrl.has(record.url)) recordsByUrl.set(record.url, record);
      }
    }
    return [...recordsByUrl.values()].filter((record) => record.official);
  } finally {
    clearTimeout(timeoutId);
  }
}
