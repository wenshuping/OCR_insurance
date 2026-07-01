import crypto from 'node:crypto';

const TEXT_FIELDS = [
  'fullText',
  'pageText',
  'responsibilityText',
  'responsibility_text',
  'text',
  'content',
  'sourceText',
  'source_text',
  'sourceExcerpt',
  'source_excerpt',
  'excerpt',
  'summary',
];

const URL_FIELDS = [
  'url',
  'officialUrl',
  'official_url',
  'sourceUrl',
  'source_url',
  'fileUrl',
  'file_url',
];

const ARTICLE_NUMBER = '第[一二三四五六七八九十百千万零〇两\\d]+条';
const DECIMAL_NUMBER = '\\d+(?:\\.\\d+)+';
const LINE_HEADING_PREFIX = `(?:${ARTICLE_NUMBER}|${DECIMAL_NUMBER})`;
const HEADING_JOINER = '\\s*[、:：.]?\\s*';
const NEXT_HEADING_TITLES = [
  '责任免除',
  '本合同保障的疾病列表',
  '疾病列表',
  '保险金申请',
  '释义',
  '合同解除',
  '现金价值',
  '保单分红',
  '红利',
  '账户价值',
  '费用',
  '投资风险',
  '可选责任',
  '其他权益',
  '宽限期',
  '合同效力',
];

function text(value) {
  return String(value ?? '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function escapeRegExp(value) {
  return text(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizeText(value) {
  return text(value)
    .normalize('NFKC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u00a0\u3000]+/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .replace(new RegExp(`([。；;])\\s*(${LINE_HEADING_PREFIX}${HEADING_JOINER}(?:保险责任|${NEXT_HEADING_TITLES.join('|')}))`, 'gu'), '$1\n$2')
    .replace(/\n[ \t]+/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function compact(value) {
  return normalizeText(value).replace(/[ \t]*\n[ \t]*/gu, '\n').trim();
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function firstUrl(record = {}) {
  return URL_FIELDS.map((field) => text(record[field])).find(Boolean) || '';
}

function titleFor(record = {}) {
  return text(record.title || record.sourceTitle || record.source_title || record.productName || record.product_name);
}

function textParts(record = {}) {
  const parts = [];
  for (const field of TEXT_FIELDS) {
    const normalized = normalizeText(record[field]);
    if (!normalized) continue;
    if (parts.some((part) => part === normalized || part.includes(normalized))) continue;
    parts.push(normalized);
  }
  return parts;
}

function buildRecordSources(records) {
  return normalizeArray(records)
    .map((record) => ({
      title: titleFor(record),
      url: firstUrl(record),
      text: textParts(record).join('\n\n'),
    }))
    .filter((record) => record.text);
}

function headingRegex(title) {
  const escapedTitle = escapeRegExp(title);
  return new RegExp(`(^|\\n)\\s*(?:${LINE_HEADING_PREFIX})${HEADING_JOINER}${escapedTitle}\\s*(?:[:：]?\\s*)(?=\\n|$|[^。；;，,]{0,40})`, 'u');
}

function looseHeadingRegex(title) {
  const escapedTitle = escapeRegExp(title);
  return new RegExp(`(?:^|\\n|[。；;])\\s*${escapedTitle}\\s*[:：]\\s*`, 'u');
}

function bareLineHeadingRegex(title) {
  const escapedTitle = escapeRegExp(title);
  return new RegExp(`(^|\\n)\\s*${escapedTitle}\\s*$`, 'mu');
}

function findHeading(source, title, from = 0) {
  const slice = source.slice(from);
  const match = headingRegex(title).exec(slice);
  if (!match) return -1;
  return from + match.index + match[0].search(new RegExp(`${LINE_HEADING_PREFIX}`, 'u'));
}

function findLooseHeading(source, title, from = 0) {
  const slice = source.slice(from);
  const match = looseHeadingRegex(title).exec(slice);
  if (!match) return -1;
  return from + match.index + match[0].search(new RegExp(escapeRegExp(title), 'u'));
}

function findBareLineHeading(source, title, from = 0) {
  const slice = source.slice(from);
  const match = bareLineHeadingRegex(title).exec(slice);
  if (!match) return -1;
  return from + match.index + match[0].search(new RegExp(escapeRegExp(title), 'u'));
}

function headingStartFromMatch(matchText) {
  const articleStart = matchText.search(new RegExp(`${LINE_HEADING_PREFIX}`, 'u'));
  if (articleStart >= 0) return articleStart;
  return matchText.search(/[^\s\n]/u);
}

function headingTokenAt(source, start) {
  const match = new RegExp(`^\\s*(${LINE_HEADING_PREFIX})`, 'u').exec(source.slice(start));
  return match?.[1] || '';
}

function isDecimalChildHeading(parentToken, candidateToken) {
  return /^\d+(?:\.\d+)+$/u.test(parentToken)
    && /^\d+(?:\.\d+)+$/u.test(candidateToken)
    && candidateToken.startsWith(`${parentToken}.`);
}

function findNextHeading(source, from, parentToken = '') {
  const titleAlternation = NEXT_HEADING_TITLES.map(escapeRegExp).join('|');
  const regex = new RegExp(`(^|\\n)\\s*(?:(?:${LINE_HEADING_PREFIX})(?:${HEADING_JOINER})(?:[^\\n]{1,30})|(?:${titleAlternation})\\s*[:：])`, 'gu');
  const slice = source.slice(from);
  for (const match of slice.matchAll(regex)) {
    const candidateStart = from + match.index + headingStartFromMatch(match[0]);
    const candidateToken = headingTokenAt(source, candidateStart);
    if (isDecimalChildHeading(parentToken, candidateToken)) continue;
    return candidateStart;
  }
  return -1;
}

function findLooseBoundary(source, from) {
  const titleAlternation = NEXT_HEADING_TITLES.map(escapeRegExp).join('|');
  const regex = new RegExp(`[。；;]\\s*(?:${titleAlternation})\\s*[:：]`, 'u');
  const slice = source.slice(from);
  const match = regex.exec(slice);
  if (!match) return -1;
  return from + match.index + match[0].search(new RegExp(`(?:${titleAlternation})`, 'u'));
}

function boundedSection(source, start, maxLength = 3000) {
  if (start < 0) return '';
  const nextHeading = findNextHeading(source, start + 4, headingTokenAt(source, start));
  const looseBoundary = findLooseBoundary(source, start + 4);
  const candidates = [nextHeading, looseBoundary].filter((index) => index > start);
  const end = candidates.length ? Math.min(...candidates) : -1;
  return compact(end > start ? source.slice(start, end) : source.slice(start, start + maxLength));
}

function extractResponsibilityChapter(source) {
  const normalized = normalizeText(source);
  if (!normalized) return '';

  const formalStart = findHeading(normalized, '保险责任');
  if (formalStart >= 0) return boundedSection(normalized, formalStart, 6000);

  const bareStart = findBareLineHeading(normalized, '保险责任');
  if (bareStart >= 0) return boundedSection(normalized, bareStart, 3000);

  const looseStart = findLooseHeading(normalized, '保险责任');
  if (looseStart >= 0) return boundedSection(normalized, looseStart, 3000);

  return '';
}

function extractNamedSection(source, titles, maxLength = 1800) {
  const normalized = normalizeText(source);
  for (const title of titles) {
    const start = findHeading(normalized, title);
    if (start >= 0) return boundedSection(normalized, start, maxLength);

    const looseStart = findLooseHeading(normalized, title);
    if (looseStart >= 0) return boundedSection(normalized, looseStart, maxLength);
  }
  return '';
}

function extractNamedSections(source, titles, maxLength = 1800) {
  const sections = [];
  const normalized = normalizeText(source);
  for (const title of titles) {
    const section = extractNamedSection(normalized, [title], maxLength);
    if (!section) continue;
    if (sections.some((existing) => existing === section || existing.includes(section))) continue;
    sections.push(section);
  }
  return sections;
}

function extractKeywordWindow(source, pattern, maxLength = 1200) {
  const normalized = normalizeText(source);
  const match = pattern.exec(normalized);
  if (!match) return '';

  const before = normalized.lastIndexOf('\n', Math.max(0, match.index - 300));
  const after = normalized.indexOf('\n', match.index + maxLength);
  const start = before >= 0 ? before + 1 : Math.max(0, match.index - 120);
  const end = after >= 0 ? after : Math.min(normalized.length, match.index + maxLength);
  return compact(normalized.slice(start, end));
}

function trimDiseaseDefinitions(section) {
  const definitionStart = section.search(/(?:以下疾病名称|疾病定义|定义如下[:：]?|1[.．、]\s*轻度疾病|一[、.．]\s*轻度疾病|第一组)/u);
  if (definitionStart > 20) return compact(section.slice(0, definitionStart));
  return compact(section.slice(0, 1200));
}

function extractDiseaseListOverview(source) {
  const section = extractNamedSection(source, ['本合同保障的疾病列表', '疾病列表'], 2500);
  if (section) return trimDiseaseDefinitions(section);

  const countWindow = extractKeywordWindow(
    source,
    /(?:轻度疾病|中度疾病|重度疾病|重大疾病).{0,80}(?:\d+|[一二三四五六七八九十百]+)\s*项|分为\s*(?:\d+|[一二三四五六七八九十百]+)\s*组/u,
    1200,
  );
  return trimDiseaseDefinitions(countWindow);
}

function extractOptionalResponsibility(source) {
  return extractNamedSection(source, ['可选责任', '选择责任', '附加责任'], 2200)
    || extractKeywordWindow(source, /可选责任|选择责任|附加责任/u, 1600);
}

function extractDividendSection(source) {
  return extractNamedSection(source, ['保单分红', '红利'], 2200)
    || extractKeywordWindow(source, /保单分红|分红保险|累积红利保险金额|红利不保证|红利分配.{0,20}不确定/u, 1800);
}

function extractAccountSection(source) {
  const sections = extractNamedSections(
    source,
    ['账户价值', '投资账户价值', '保单账户价值', '结算利率', '最低保证利率', '保证利率', '费用', '投资风险', '风险'],
    1600,
  );
  if (sections.length) return sections.join('\n\n');
  return extractKeywordWindow(source, /账户价值|结算利率|最低保证利率|保证利率|初始费用|保单管理费|风险/u, 2200);
}

function addSupplement(supplementSections, type, value) {
  const cleaned = compact(value);
  if (!cleaned) return;
  if (supplementSections.some((section) => section.type === type && section.text === cleaned)) return;
  supplementSections.push({ type, text: cleaned });
}

function hasParticipatingSignal(category, source) {
  return category === 'participating_life'
    || category === 'participating'
    || /分红型|分红保险|保单分红|累积红利保险金额|红利不保证/u.test(source);
}

function hasAccountSignal(category, source) {
  return category === 'universal_life'
    || category === 'investment_linked'
    || category === 'universal'
    || category === 'investment-linked'
    || /万能|投资连结|账户价值|结算利率|最低保证利率|初始费用|保单管理费/u.test(source);
}

export function extractStructuredResponsibilitySections({
  productCategory = '',
  records = [],
} = {}) {
  const normalizedCategory = text(productCategory);
  const warnings = [];
  const recordSources = buildRecordSources(records);
  const allSourceText = recordSources.map((record) => record.text).join('\n\n');

  const main = recordSources
    .map((record) => ({ record, section: extractResponsibilityChapter(record.text) }))
    .filter((item) => item.section)
    .sort((left, right) => right.section.length - left.section.length)[0];

  const supplementSections = [];
  if (normalizedCategory === 'critical_illness') {
    addSupplement(supplementSections, 'disease_list_overview', extractDiseaseListOverview(allSourceText));
  }

  if (normalizedCategory === 'annuity' || /年金|可选责任/u.test(allSourceText)) {
    addSupplement(supplementSections, 'optional_responsibility', extractOptionalResponsibility(allSourceText));
  }

  if (hasParticipatingSignal(normalizedCategory, allSourceText)) {
    addSupplement(supplementSections, 'dividend', extractDividendSection(allSourceText));
  }

  if (hasAccountSignal(normalizedCategory, allSourceText)) {
    addSupplement(supplementSections, 'account_value', extractAccountSection(allSourceText));
  }

  if (!main?.section) warnings.push('responsibility_chapter_missing');

  const output = {
    mainResponsibilityText: main?.section || '',
    sourceUrl: main?.record?.url || recordSources[0]?.url || '',
    sourceTitle: main?.record?.title || recordSources[0]?.title || '',
    supplementSections,
    quality: {
      status: main?.section ? 'complete' : 'needs_extraction_review',
      warnings,
    },
  };

  return {
    ...output,
    sourceSectionsDigest: digest({
      mainResponsibilityText: output.mainResponsibilityText,
      supplementSections: output.supplementSections,
      sourceUrl: output.sourceUrl,
      sourceTitle: output.sourceTitle,
    }),
  };
}
