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
const DIRECT_RESPONSIBILITY_TEXT_FIELDS = [
  'responsibilityText',
  'responsibility_text',
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
const RESPONSIBILITY_TITLE_SUFFIX_PATTERN = /(?:保险金|给付金|年金|养老金|生存金|祝寿金|满期金|豁免保险费|豁免保费)/u;
const RESPONSIBILITY_ITEM_HEADING_PATTERN = /(?:^|\n|[。；;：:])\s*(?:\d+[.．、]|[（(][一二三四五六七八九十]+[）)]|[一二三四五六七八九十]+[、.．])?\s*([^。；;，,：:\n]{2,60}?(?:保险金|给付金|年金|养老金|生存金|祝寿金|满期金|豁免保险费|豁免保费))(?=\s|[，,、:：]|$)/gu;
const NUMBERED_BENEFIT_ITEM_HEADING_PATTERN = /(?:^|\n|\s)(?:\d+[.．、]|[（(][一二三四五六七八九十]+[）)]|[一二三四五六七八九十]+[、.．])\s*([^。；;，,：:\n]{2,70}?(?:保险金|给付金|年金|养老金|生存金|祝寿金|满期金|豁免保险费|豁免保费))(?=被保险人|投保人|如|若|除|自|于|按|在|\s|[，,、:：]|$)/gu;

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
    .replace(/第\s*([一二三四五六七八九十百千万零〇两\d]+)\s*条/gu, '第$1条')
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

function normalizeResponsibilityTitle(value) {
  return text(value)
    .replace(/^第[一二三四五六七八九十百千万零〇两\d]+条\s*保险责任/u, '')
    .replace(/^保险责任(?:包括|含|为|是)?/u, '')
    .replace(/^[\s\d一二三四五六七八九十().（）．.、:：;；-]+/u, '')
    .replace(/\s+/gu, '')
    .trim();
}

function isUsefulResponsibilityTitle(value) {
  const title = normalizeResponsibilityTitle(value);
  return title.length >= 4
    && title.length <= 42
    && RESPONSIBILITY_TITLE_SUFFIX_PATTERN.test(title)
    && !/^(?:保险金|给付金|年金)$/u.test(title)
    && !/^(?:若|则|其|被保险人|本公司|我们|发生上述|减去)/u.test(title)
    && !/(?:处于|二者之较大|三者之最大|金额为|根据以下不同情形|合同终止|累计已给付|条规定|赔付方式)/u.test(title)
    && !/(?:责任免除|保险金申请|释义|保单贷款|现金价值权益|受益人|争议处理)/u.test(title);
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

function sourceTypeFor(record = {}, title = titleFor(record), url = firstUrl(record)) {
  const explicitType = text(record.sourceType || record.source_type || record.type);
  if (explicitType) return explicitType;
  const content = `${title} ${url} ${record.snippet || ''}`;
  if (/产品说明|说明书|brochure|product\s*brochure/iu.test(content)) return 'product_brochure';
  if (/条款|保险合同|terms|policy/iu.test(content)) return 'terms_pdf';
  if (/\.pdf(?:$|[?#])/iu.test(url)) return 'terms_pdf';
  return url ? 'official_webpage' : 'text';
}

function officialFlagFor(record = {}, url = firstUrl(record)) {
  if (record.official === false || record.official === 'false') return false;
  if (record.official === true || record.official === 'true') return true;
  const evidence = text(record.evidenceLevel || record.evidence_level || record.sourceTrust || record.source_trust);
  if (/official|insurer|官方/u.test(evidence)) return true;
  return /newchinalife\.com|static-cdn\.newchinalife\.com|保险公司|官方/u.test(url);
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

function hasRefilledResponsibilityText(record = {}) {
  return /valid_responsibility_refilled/u.test(text(record.qualityStatus || record.quality_status))
    || /responsibility_refill/u.test(text(record.parser))
    || /(?:已重新抽取|重新抽取|已抽取).{0,12}保险责任正文段/u.test(text(record.snippet || record.qualityReason || record.quality_reason));
}

function directResponsibilityTextFor(record = {}) {
  for (const field of DIRECT_RESPONSIBILITY_TEXT_FIELDS) {
    const normalized = normalizeText(record[field]);
    if (normalized) return normalized;
  }
  if (!hasRefilledResponsibilityText(record)) return '';
  return normalizeText(record.pageText || record.text || record.content || record.sourceExcerpt || record.source_excerpt || record.excerpt);
}

function buildRecordSources(records) {
  return normalizeArray(records)
    .map((record, index) => {
      const title = titleFor(record);
      const url = firstUrl(record);
      return {
        sourceId: text(record.sourceId || record.source_id) || `src_${index + 1}`,
        title,
        url,
        sourceType: sourceTypeFor(record, title, url),
        official: officialFlagFor(record, url),
        directResponsibilityText: directResponsibilityTextFor(record),
        text: textParts(record).join('\n\n'),
      };
    })
    .filter((record) => record.text);
}

function sourceInventoryFrom(recordSources) {
  return normalizeArray(recordSources).map((record) => ({
    sourceId: record.sourceId,
    title: record.title,
    url: record.url,
    sourceType: record.sourceType,
    official: Boolean(record.official),
  }));
}

function pageHintFor(value) {
  const match = text(value).match(/第\s*\d+\s*页/u);
  return match ? match[0].replace(/\s+/gu, '') : '';
}

function sourceRefFor(record = {}, quote = '', sectionTitle = '', itemId = '') {
  const cleanedQuote = compact(quote).replace(/\s+/gu, ' ').slice(0, 260);
  return {
    sourceRefId: [record.sourceId, itemId || sectionTitle].map(text).filter(Boolean).join('#'),
    sourceId: text(record.sourceId),
    sourceTitle: text(record.title),
    sourceUrl: text(record.url),
    sourceType: text(record.sourceType),
    sectionTitle: text(sectionTitle),
    itemId: text(itemId),
    pageHint: pageHintFor(quote),
    quote: cleanedQuote,
  };
}

function sourceRefForText(recordSources, value, sectionTitle = '') {
  const needle = compact(value).slice(0, 80);
  const record = normalizeArray(recordSources).find((candidate) =>
    needle && compact(candidate.text).includes(needle),
  ) || normalizeArray(recordSources)[0];
  return record ? sourceRefFor(record, value, sectionTitle) : null;
}

function headingRegex(title) {
  const escapedTitle = escapeRegExp(title);
  return new RegExp(`(^|\\n)\\s*(?:${LINE_HEADING_PREFIX})${HEADING_JOINER}${escapedTitle}(?!的)\\s*(?:[:：]?\\s*)(?=\\n|$|[^。；;，,]{0,40})`, 'u');
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

function findInlineBareResponsibilityHeading(source, from = 0) {
  const slice = source.slice(from);
  const regex = /(^|\n)\s*保险责任(?=(?:\s+|[:：]|在\s*(?:本\s*)?(?:合同|保险合同)|[（(]?[一二三四五六七八九十\d]+[）)、.．]\s*|本合同))/gu;
  for (const match of slice.matchAll(regex)) {
    const start = from + match.index + match[0].search(/保险责任/u);
    const candidate = boundedSection(source, start, 3000);
    if (responsibilityItemTitleCount(candidate) >= 1
      || /(?:承担|给付|赔付|豁免)[^。\n]{0,40}(?:保险责任|保险金|年金|生存金|满期金|保费)/u.test(candidate)
      || /(?:投保人|保障计划|基本部分|可选部分|等待期)[^。\n]{0,180}(?:保险责任|保险金|年金|给付|豁免)/u.test(candidate)) {
      return start;
    }
  }
  return -1;
}

function responsibilityItemTitleCount(value) {
  const titles = new Set();
  const content = compact(value);
  for (const pattern of [RESPONSIBILITY_ITEM_HEADING_PATTERN, NUMBERED_BENEFIT_ITEM_HEADING_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const title = normalizeResponsibilityTitle(match[1]);
      if (isUsefulResponsibilityTitle(title)) titles.add(title);
      if (titles.size >= 2) return titles.size;
    }
  }
  return titles.size;
}

function findBenefitResponsibilityHeading(source, from = 0) {
  const slice = source.slice(from);
  const regex = /(^|\n)\s*(?:(?:本|该)(?:保险|产品|合同))?[^。\n]{0,16}(?:提供的)?(?:利益保障|保障利益|保险利益(?!表))\s*[:：]?\s*/gu;
  for (const match of slice.matchAll(regex)) {
    const start = from + match.index + match[0].search(/[^\s\n]/u);
    const candidate = boundedSection(source, start, 5000);
    if (responsibilityItemTitleCount(candidate) >= 2) return start;
  }
  return -1;
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

function inferDecimalParentToken(source, from) {
  const match = /(^|\n)\s*(\d+(?:\.\d+)+)\s+/u.exec(source.slice(from));
  const token = match?.[2] || '';
  if (!token) return '';
  const parts = token.split('.');
  if (parts.length <= 2) return token;
  return parts.slice(0, -1).join('.');
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
  const bareHeadingRegex = new RegExp(`\\n[ \\t]*(?:${titleAlternation})[ \\t]*(?:[:：][ \\t]*)?(?=\\n|$)`, 'u');
  const bareMatch = bareHeadingRegex.exec(source.slice(from));
  if (bareMatch) return from + bareMatch.index + bareMatch[0].search(new RegExp(`(?:${titleAlternation})`, 'u'));
  const regex = new RegExp(`[。；;]\\s*(?:${titleAlternation})\\s*[:：]`, 'u');
  const slice = source.slice(from);
  const match = regex.exec(slice);
  if (!match) return -1;
  return from + match.index + match[0].search(new RegExp(`(?:${titleAlternation})`, 'u'));
}

function boundedSection(source, start, maxLength = 3000) {
  if (start < 0) return '';
  const parentToken = headingTokenAt(source, start) || inferDecimalParentToken(source, start + 4);
  const nextHeading = findNextHeading(source, start + 4, parentToken);
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

  const inlineBareStart = findInlineBareResponsibilityHeading(normalized);
  if (inlineBareStart >= 0) return boundedSection(normalized, inlineBareStart, 3000);

  const looseStart = findLooseHeading(normalized, '保险责任');
  if (looseStart >= 0) return boundedSection(normalized, looseStart, 3000);

  const benefitStart = findBenefitResponsibilityHeading(normalized);
  if (benefitStart >= 0) return boundedSection(normalized, benefitStart, 5000);

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

function addSupplement(supplementSections, type, value, recordSources = []) {
  const cleaned = compact(value);
  if (!cleaned) return;
  if (supplementSections.some((section) => section.type === type && section.text === cleaned)) return;
  const sourceRef = sourceRefForText(recordSources, cleaned, type);
  supplementSections.push({
    type,
    text: cleaned,
    sourceRefs: sourceRef ? [sourceRef] : [],
  });
}

function normalizedComparableText(value) {
  return compact(value).replace(/\s+/gu, ' ');
}

function isDuplicateSupplementSection(supplement = {}, mainSection = '') {
  const supplementText = normalizedComparableText(supplement.text);
  const mainText = normalizedComparableText(mainSection);
  if (!supplementText || !mainText) return false;
  if (mainText.includes(supplementText)) return true;
  if (supplementText.includes(mainText)) return true;
  const sample = supplementText.slice(0, 240);
  return sample.length >= 80 && mainText.includes(sample);
}

function keyFactsFromResponsibilityText(value) {
  const content = compact(value).replace(/\s+/gu, ' ');
  const facts = [];
  const patterns = [
    /(?:基本保险金额|基本保额)\s*[×xX*]\s*(?:[（(]\s*1\s*[+＋]\s*\d+(?:\.\d+)?\s*%\s*[）)]|1\.\d+)\s*(?:\^|的第?)?\s*(?:[（(]?\s*n\s*[-－]\s*1\s*[）)]?|n-1)?/gu,
    /(?:给付系数|赔付比例|给付比例)[^。；;]{0,180}?(?:\d+(?:\.\d+)?|[一二三四五六七八九十]+(?:\.\d+)?)/gu,
    /(?:特定公共交通工具|民航班机|客运轮船|客运汽车|客运列车|航空意外|交通工具意外)[^。；;]{0,120}/gu,
    /(?:\d+(?:\.\d+)?\s*倍|[一二三四五六七八九十]+倍)/gu,
    /(?:等待期|生效之日起)\s*\d+\s*日(?:[（(]含[）)])?/gu,
    /(?:\d+|[一二三四五六七八九十百]+)\s*周岁(?:保单周年日|保单生效对应日)?(?:[（(]含[）)]|[（(]不含[）)])?/gu,
    /(?:已交保险费|实际交纳的保险费|现金价值|基本保险金额|有效保险金额|累积红利保险金额)/gu,
    /(?:二者之较大者|三者之最大者|最大者|较大者)/gu,
    /\d+(?:\.\d+)?\s*%/gu,
    /(?:轻度疾病|中度疾病|重度疾病|重大疾病)[^。；;]{0,80}(?:\d+|[一二三四五六七八九十百]+)\s*项/gu,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const fact = text(match[0]);
      if (fact && !facts.includes(fact)) facts.push(fact);
      if (facts.length >= 12) return facts;
    }
  }
  return facts;
}

function extractResponsibilityItems(section, sourceRecord = {}) {
  const content = compact(section);
  if (!content) return [];
  const matches = [...content.matchAll(RESPONSIBILITY_ITEM_HEADING_PATTERN)]
    .map((match) => {
      const title = normalizeResponsibilityTitle(match[1]);
      const titleStart = match.index + match[0].lastIndexOf(match[1]);
      return { title, index: titleStart };
    })
    .filter((item) => isUsefulResponsibilityTitle(item.title));
  const titleTokenPattern = /[^。；;，,、:：\s]{2,40}?(?:保险金|给付金|年金|养老金|生存金|祝寿金|满期金|豁免保险费|豁免保费)/gu;
  for (const lineMatch of content.matchAll(/(?:^|\n)([^。；;\n]{4,160})[。；;]?/gu)) {
    const line = lineMatch[1];
    if (/(?:被保险人|本公司|我们|按|给付|领取|确诊|发生|期间|合同约定)/u.test(line)) continue;
    const lineStart = lineMatch.index + lineMatch[0].indexOf(line);
    const titles = [...line.matchAll(titleTokenPattern)]
      .map((match) => ({
        title: normalizeResponsibilityTitle(match[0]),
        index: lineStart + match.index,
        excerpt: compact(line),
      }))
      .filter((item) => isUsefulResponsibilityTitle(item.title));
    if (titles.length >= 2) matches.push(...titles);
  }
  matches.sort((left, right) => left.index - right.index || left.title.localeCompare(right.title));
  const byTitle = new Map();
  matches.forEach((item, index) => {
    const end = matches[index + 1]?.index ?? content.length;
    const excerpt = compact(item.excerpt || content.slice(item.index, end)).slice(0, 2200);
    if (!excerpt) return;
    const current = byTitle.get(item.title);
    if (!current || excerpt.length > current.excerpt.length) {
      byTitle.set(item.title, {
        title: item.title,
        excerpt,
        keyFacts: keyFactsFromResponsibilityText(excerpt),
      });
    }
  });
  return [...byTitle.values()].map((item, index) => {
    const itemId = `resp_${index + 1}`;
    return {
      itemId,
      ...item,
      sourceRefs: sourceRecord?.sourceId ? [sourceRefFor(sourceRecord, item.excerpt, '保险责任', itemId)] : [],
    };
  });
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

function addGap(gaps, type, message, sourceRef = null) {
  if (gaps.some((gap) => gap.type === type && gap.message === message)) return;
  gaps.push({
    type,
    message,
    sourceRefs: sourceRef ? [sourceRef] : [],
  });
}

function buildCoverageSections(main) {
  if (!main?.section) return [];
  return [{
    sectionId: 'coverage_responsibility',
    title: '保险责任',
    text: main.section,
    sourceRefs: main.record?.sourceId ? [sourceRefFor(main.record, main.section, '保险责任')] : [],
  }];
}

function buildGaps({
  normalizedCategory = '',
  mainSection = '',
  allSourceText = '',
  supplementSections = [],
  recordSources = [],
} = {}) {
  const gaps = [];
  if (!mainSection) {
    addGap(gaps, 'responsibility_chapter_missing', '未从官方资料中稳定识别保险责任章节。');
    return gaps;
  }
  if (/现金价值/u.test(mainSection)) {
    addGap(gaps, 'cash_value_table_needed', '责任给付涉及现金价值，具体金额需结合现金价值表或保单数据核验。', sourceRefForText(recordSources, mainSection, '现金价值'));
  }
  if (normalizedCategory === 'critical_illness'
    && /(?:疾病列表|轻度疾病|中度疾病|重度疾病|重大疾病)/u.test(allSourceText)
    && !supplementSections.some((section) => section.type === 'disease_list_overview')) {
    addGap(gaps, 'disease_list_needed', '疾病责任涉及疾病列表或病种数量，完整病种范围需结合疾病列表核验。', sourceRefForText(recordSources, allSourceText, '疾病列表'));
  }
  if (/伤残等级|伤残评定|伤残比例/u.test(allSourceText)) {
    addGap(gaps, 'disability_table_needed', '伤残责任涉及伤残等级或给付比例，具体比例需结合伤残评定表核验。', sourceRefForText(recordSources, allSourceText, '伤残等级'));
  }
  return gaps;
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
    .map((record) => ({ record, section: record.directResponsibilityText || extractResponsibilityChapter(record.text) }))
    .filter((item) => item.section)
    .sort((left, right) => right.section.length - left.section.length)[0];

  const supplementSections = [];
  if (normalizedCategory === 'critical_illness') {
    addSupplement(supplementSections, 'disease_list_overview', extractDiseaseListOverview(allSourceText), recordSources);
  }

  if (normalizedCategory === 'annuity' || /年金|可选责任/u.test(allSourceText)) {
    addSupplement(supplementSections, 'optional_responsibility', extractOptionalResponsibility(allSourceText), recordSources);
  }

  if (hasParticipatingSignal(normalizedCategory, allSourceText)) {
    addSupplement(supplementSections, 'dividend', extractDividendSection(allSourceText), recordSources);
  }

  if (hasAccountSignal(normalizedCategory, allSourceText)) {
    addSupplement(supplementSections, 'account_value', extractAccountSection(allSourceText), recordSources);
  }

  const filteredSupplementSections = supplementSections
    .filter((section) => !isDuplicateSupplementSection(section, main?.section || ''));

  if (!main?.section) warnings.push('responsibility_chapter_missing');
  const responsibilityItems = [];
  const gaps = buildGaps({
    normalizedCategory,
    mainSection: main?.section || '',
    allSourceText,
    supplementSections: filteredSupplementSections,
    recordSources,
  });

  const output = {
    sourceInventory: sourceInventoryFrom(recordSources),
    coverageSections: buildCoverageSections(main),
    mainResponsibilityText: main?.section || '',
    sourceUrl: main?.record?.url || recordSources[0]?.url || '',
    sourceTitle: main?.record?.title || recordSources[0]?.title || '',
    responsibilityItems,
    supplementSections: filteredSupplementSections,
    gaps,
    quality: {
      status: main?.section ? 'complete' : 'needs_extraction_review',
      warnings,
    },
  };

  return {
    ...output,
    sourceSectionsDigest: digest({
      mainResponsibilityText: output.mainResponsibilityText,
      sourceInventory: output.sourceInventory,
      coverageSections: output.coverageSections,
      responsibilityItems: output.responsibilityItems,
      supplementSections: output.supplementSections,
      gaps: output.gaps,
      sourceUrl: output.sourceUrl,
      sourceTitle: output.sourceTitle,
    }),
  };
}
