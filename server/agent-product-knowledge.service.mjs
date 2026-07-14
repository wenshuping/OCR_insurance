import { listProductCatalogCompanies, searchProductCatalog } from './product-catalog-search.mjs';
import { sanitizeDeepSeekRequestBody } from './deepseek-privacy-gateway.mjs';
import { chunkProductDocument } from './product-chunker.service.mjs';
import { parseProductDocument } from './product-document-parser.service.mjs';

const RESPONSIBILITY_QUESTION_PATTERN = /(?:保险|保障)?责任|保什么|保哪些|赔什么|怎么赔/u;
const SALES_STATUS_QUESTION_PATTERN = /在售|停售|销售中|还(?:在)?卖|还能买|可以买/u;
const PRODUCT_COMPARISON_SEPARATOR = /\s*(?:对比|比较|区别于|相比(?:于)?|与|和|VS\.?)\s*/iu;
const MAX_OFFICIAL_DOCUMENT_BYTES = 8 * 1024 * 1024;

function text(value) {
  return String(value || '').trim();
}

function safeOrigins(rows = []) {
  const origins = new Set();
  for (const row of rows) {
    let urls = [];
    try { urls = JSON.parse(row.source_urls_json || '[]'); } catch { urls = []; }
    for (const value of Array.isArray(urls) ? urls : []) {
      try {
        const url = new URL(value);
        if (url.protocol === 'https:' && !url.username && !url.password) origins.add(url.origin);
      } catch { /* Ignore malformed stored sources. */ }
    }
  }
  return [...origins];
}

function searchText(question, company = '') {
  return text(question)
    .replace(company, '')
    .replace(/(?:这个|那个|请问|帮我|查一下|查询|看看|介绍一下|是什么|有哪些|啥|啊|呀|呢)/gu, '')
    .replace(/(?:产品|保险责任|保障责任|责任|条款|保险)/gu, '')
    .replace(/[\s，。？！,.?!]/gu, '')
    .slice(0, 100);
}

function catalogIdentity(value) {
  return text(value).normalize('NFKC')
    .replace(/[\s《》（）()]/gu, '')
    .replace(/^[\p{Script=Han}]{2,24}?保险(?:股份)?有限公司/gu, '')
    .toLowerCase();
}

function companyFromQuery(query, companies = [], officialDomainProfiles = []) {
  const direct = companies
    .map((item) => text(item.company))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .find((company) => query.includes(company));
  if (direct) return direct;
  for (const profile of officialDomainProfiles) {
    const aliases = [profile?.company, ...(profile?.aliases || []), ...(profile?.companyAliases || [])]
      .map(text).filter((alias) => alias.length >= 2)
      .sort((left, right) => right.length - left.length);
    if (!aliases.some((alias) => query.includes(alias))) continue;
    const company = companies.find((item) => aliases.includes(text(item.company)))?.company;
    if (company) return company;
  }
  return '';
}

function missingProductEvidenceGuidance({ productName, question } = {}) {
  const requestedName = text(productName) || text(question) || '这款产品';
  if (/国寿(?:财险)?惠享保/u.test(requestedName)) {
    return {
      guidance: true,
      answer: [
        '### 已识别到的产品线索',
        '- **销售名称**：国寿惠享保（免健告）百万医疗险',
        '- **承保主体线索**：中国人寿财产保险股份有限公司，不是中国人寿保险股份有限公司的寿险产品',
        '- **备案名称线索**：个人住院医疗保险E（互联网专属，Z款）',
        '',
        '### 还差什么才能确认保险责任',
        '- **保障计划**：精选版还是尊享版，两者保额、免赔额和赔付比例可能不同',
        '- **正式资料**：条款 PDF、投保须知、特别约定或保单首页任意一项',
        '',
        '你可以直接发送保单首页截图、条款 PDF 或官方投保链接。我拿到其中任意一项后，就能按一般医疗、重疾医疗、院外特药、质子重离子、免赔额和赔付比例逐项拆解。',
        '',
        '> 上述承保主体和备案名称目前属于公开资料线索，未取得保险公司官网材料前不作为最终条款结论。',
      ].join('\n'),
    };
  }
  return {
    guidance: true,
    answer: [
      `### 暂时无法确认《${requestedName.replace(/[《》\n]/gu, '').slice(0, 100)}》的正式条款`,
      '当前名称尚未匹配到保险公司官网的正式产品或备案名称。',
      '',
      '### 补充以下任意一项即可继续',
      '- 保险公司全称',
      '- 保单上的正式险种名称、备案名称或条款编号',
      '- 产品版本或保障计划',
      '- 保单首页截图、条款 PDF 或官方投保链接',
      '',
      '拿到其中任意一项后，我会继续核对保险责任、免责、等待期、免赔额、赔付比例和续保条件。',
    ].join('\n'),
  };
}

function answerFromSummary(summary = {}) {
  const responsibilities = Array.isArray(summary.mainResponsibilities) ? summary.mainResponsibilities : [];
  const lines = responsibilities.map((item, index) => {
    const detail = text(item?.plainText || item?.howItPays).slice(0, 260);
    return `${index + 1}. ${text(item?.title) || '保险责任'}${detail ? `：${detail}` : ''}`;
  });
  if (!lines.length) return text(summary.headline);
  return [text(summary.headline), ...lines].filter(Boolean).join('\n');
}

function comparisonProductQueries(question) {
  const value = text(question);
  if (!/(?:对比|比较|区别|相比|哪款|哪个好|\bVS\.?\b)/iu.test(value)) return [];
  const parts = value.split(PRODUCT_COMPARISON_SEPARATOR).map((item) => item
    .replace(/^(?:请|帮我|帮忙|看看|分析一下)/u, '')
    .replace(/(?:有什么)?(?:区别|差异|哪个好|哪款好)[？?]?$/u, '')
    .trim()).filter(Boolean);
  return parts.length === 2 ? parts : [];
}

function verifiedSources(urls = [], product = {}, allowedOrigins = []) {
  return (Array.isArray(urls) ? urls : []).slice(0, 3).flatMap((value) => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || !allowedOrigins.includes(url.origin)) return [];
      return [{
        title: `${product.productName}官方资料`, url: url.href, provenance: 'insurer_official', verified: true,
      }];
    } catch {
      return [];
    }
  });
}

function officialKnowledgeEvidence(rows = [], product = {}, allowedOrigins = []) {
  const evidence = [];
  const urls = [];
  for (const row of rows) {
    let payload;
    try { payload = JSON.parse(row.payload || '{}'); } catch { payload = {}; }
    if (text(payload.evidenceLevel) !== 'insurer_official') continue;
    const pageText = text(payload.pageText);
    if (pageText.length < 40) continue;
    try {
      const url = new URL(row.url);
      if (url.protocol !== 'https:' || url.username || url.password) continue;
      evidence.push(pageText.slice(0, 8_000));
      urls.push(url.href);
    } catch { /* Ignore malformed stored sources. */ }
  }
  if (!evidence.length) return null;
  for (const url of urls) {
    const origin = new URL(url).origin;
    if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin);
  }
  const sources = verifiedSources(urls, product, allowedOrigins);
  if (!sources.length) return null;
  return {
    summary: {
      headline: `${product.productName}官方保险责任`,
      mainResponsibilities: evidence.map((plainText) => ({ title: '官方条款保险责任', plainText })),
    },
    sources,
  };
}

function onSaleProductEvidence(rows = [], product = {}, allowedOrigins = []) {
  const sources = [];
  const seen = new Set();
  const checkedAtValues = [];
  for (const row of rows) {
    let payload;
    try { payload = JSON.parse(row.payload || '{}'); } catch { payload = {}; }
    if (text(payload.evidenceLevel) !== 'insurer_official' || !/^(?:在售|销售中|active|on_sale)$/iu.test(text(payload.salesStatus))) continue;
    const checkedAt = text(payload.lastFetchedAt || payload.updatedAt);
    if (checkedAt) checkedAtValues.push(checkedAt);
    try {
      const url = new URL(row.url);
      if (url.protocol !== 'https:' || url.username || url.password || seen.has(url.href)) continue;
      seen.add(url.href);
      if (!allowedOrigins.includes(url.origin)) allowedOrigins.push(url.origin);
      sources.push({
        title: text(payload.title) || `${product.productName}官方资料`,
        url: url.href,
        provenance: 'insurer_official',
        verified: true,
      });
    } catch {
      // Ignore malformed stored sources.
    }
  }
  return sources.length ? { product, sources, checkedAt: checkedAtValues.sort().at(-1) || '' } : null;
}

function responsibilityAssistantEvidence(result = {}, product = {}, allowedOrigins = [], question = '') {
  const analysis = result?.analysis || result;
  const cards = Array.isArray(analysis?.responsibilityCards) ? analysis.responsibilityCards : [];
  const coverageRows = Array.isArray(analysis?.coverageTable) ? analysis.coverageTable : [];
  const selectedRows = (cards.length ? cards : coverageRows).slice(0, 12);
  const mainResponsibilities = selectedRows.flatMap((item) => {
    const title = text(item?.title || item?.coverageType);
    const plainText = [item?.triggerCondition, item?.scenario, item?.payoutSummary, item?.payout, item?.note, item?.sourceExcerpt]
      .map(text).filter(Boolean).join('；').slice(0, 2_000);
    return title && plainText ? [{ title, plainText }] : [];
  });
  if (!mainResponsibilities.length) return null;
  const candidates = [
    ...(Array.isArray(analysis?.sources) ? analysis.sources : []),
    ...cards.map((card) => ({
      title: card?.sourceTitle || card?.title,
      url: card?.sourceUrl,
      evidenceLevel: card?.evidenceLevel,
      official: card?.official,
      referenceOnly: card?.referenceOnly,
    })),
  ];
  const seen = new Set();
  const sources = candidates.flatMap((source) => {
    if (source?.referenceOnly === true || source?.official === false) return [];
    if (source?.official !== true && text(source?.evidenceLevel) !== 'insurer_official') return [];
    try {
      const url = new URL(source?.url);
      if (url.protocol !== 'https:' || url.username || url.password || seen.has(url.href)) return [];
      seen.add(url.href);
      if (!allowedOrigins.includes(url.origin)) allowedOrigins.push(url.origin);
      return [{
        title: text(source?.title) || `${product.productName}官方资料`,
        url: url.href,
        provenance: 'insurer_official',
        verified: true,
      }];
    } catch {
      return [];
    }
  }).slice(0, 5);
  if (!sources.length) return null;
  const coreAdvantageTitles = [
    '一般医疗费用保险金',
    '重度疾病医疗费用保险金',
    '外购药械医疗费用保险金',
    '康护医疗费用保险金',
    '特定先进医疗费用保险金',
    '重度疾病特需医疗费用保险金',
    '小额医疗费用保险金',
  ];
  const eligibleCards = cards
    .filter((card) => (
      text(card?.indicatorCheckStatus) !== 'needs_indicator_review'
      && !(Array.isArray(card?.indicatorCheckIssues) && card.indicatorCheckIssues.includes('missing_structured_indicator'))
    ));
  if (/优势|亮点|卖点|好在哪里/u.test(text(question))) {
    eligibleCards.sort((left, right) => {
      const leftRank = coreAdvantageTitles.indexOf(text(left?.title));
      const rightRank = coreAdvantageTitles.indexOf(text(right?.title));
      return (leftRank < 0 ? 999 : leftRank) - (rightRank < 0 ? 999 : rightRank);
    });
  }
  const responsibilityCardEvidence = eligibleCards
    .slice(0, 6)
    .map((card, index) => {
      const indicatorText = (Array.isArray(card?.indicators) ? card.indicators : [])
        .slice(0, 3)
        .map((indicator) => [indicator?.liability, indicator?.formulaText].map(text).filter(Boolean).join('：'))
        .filter(Boolean)
        .join('；');
      const structuredContent = [card?.triggerCondition, card?.payoutSummary, card?.payout, indicatorText]
        .map(text).filter(Boolean);
      return {
        evidenceId: `R${index + 1}`,
        title: text(card?.title),
        category: text(card?.category),
        calculationStatus: text(card?.calculationStatus),
        indicatorCheckStatus: text(card?.indicatorCheckStatus),
        content: (structuredContent.length ? structuredContent.join('；') : text(card?.sourceExcerpt).slice(0, 300)),
        sourceUrl: text(card?.sourceUrl),
      };
    })
    .filter((card) => card.title && card.content);
  return {
    summary: {
      headline: text(analysis?.report) || `${product.productName}保险责任`,
      mainResponsibilities,
    },
    sources,
    responsibilityCardEvidence,
    directAnswer: mainResponsibilities.map((item, index) => (
      `${index + 1}. ${item.title}：${item.plainText}`
    )).join('\n') || text(analysis?.report),
  };
}

function customerResponsibilitySummaryEvidence(result = {}, product = {}, allowedOrigins = []) {
  const summary = result?.summary;
  if (!summary || typeof summary !== 'object') return null;
  const responsibilities = (Array.isArray(summary.mainResponsibilities) ? summary.mainResponsibilities : [])
    .filter((item) => text(item?.title) || text(item?.plainText) || text(item?.howItPays));
  const contentBlocks = (Array.isArray(summary.contentBlocks) ? summary.contentBlocks : [])
    .map((block) => ({
      blockKey: text(block?.blockKey),
      title: text(block?.title),
      enabled: block?.enabled !== false,
      editable: block?.editable !== false,
      order: Number.isFinite(Number(block?.order)) ? Number(block.order) : 0,
      content: text(block?.content),
    }))
    .filter((block) => block.blockKey || block.title || block.content);
  if (!responsibilities.length && !contentBlocks.length && !text(summary.headline)) return null;
  const normalizedSummary = {
    company: text(summary.company) || text(product.company),
    productName: text(summary.productName) || text(product.productName),
    headline: text(summary.headline),
    contentBlocks,
    mainResponsibilities: responsibilities.map((item) => ({
      title: text(item?.title),
      plainText: text(item?.plainText),
      triggerCondition: text(item?.triggerCondition),
      howItPays: text(item?.howItPays),
      calculationStatus: text(item?.calculationStatus),
      requiredPolicyFields: (Array.isArray(item?.requiredPolicyFields) ? item.requiredPolicyFields : []).map(text).filter(Boolean),
      sourceRefs: (Array.isArray(item?.sourceRefs) ? item.sourceRefs : []).map(text).filter(Boolean),
    })),
    notices: (Array.isArray(summary.notices) ? summary.notices : []).map(text).filter(Boolean),
    requiredPolicyFields: (Array.isArray(summary.requiredPolicyFields) ? summary.requiredPolicyFields : []).map(text).filter(Boolean),
    sourceUrls: (Array.isArray(summary.sourceUrls) ? summary.sourceUrls : []).map(text).filter(Boolean),
  };
  return {
    directAnswer: answerFromCustomerResponsibilitySummary(normalizedSummary),
    sources: verifiedSources(summary.sourceUrls, product, allowedOrigins),
    summary: normalizedSummary,
  };
}

function answerFromCustomerResponsibilitySummary(summary = {}) {
  const lines = [];
  const blocks = (Array.isArray(summary.contentBlocks) ? summary.contentBlocks : [])
    .filter((block) => block?.enabled !== false && (text(block?.title) || text(block?.content)))
    .sort((left, right) => Number(left?.order || 0) - Number(right?.order || 0));
  if (blocks.length) {
    for (const block of blocks) {
      if (text(block?.title)) lines.push(`### ${text(block.title)}`);
      if (text(block?.content)) lines.push(text(block.content));
      lines.push('');
    }
  } else if (text(summary.headline)) {
    lines.push(text(summary.headline), '');
  }
  const responsibilities = Array.isArray(summary.mainResponsibilities) ? summary.mainResponsibilities : [];
  if (responsibilities.length) {
    lines.push(`### 责任明细（${responsibilities.length}项）`);
    responsibilities.forEach((item, index) => {
      lines.push(`${index + 1}. **${text(item?.title) || '保险责任'}**`);
      if (text(item?.plainText)) lines.push(text(item.plainText));
      if (text(item?.triggerCondition)) lines.push(`触发条件：${text(item.triggerCondition)}`);
      if (text(item?.howItPays)) lines.push(text(item.howItPays));
      if (text(item?.calculationStatus)) lines.push(`calculationStatus: ${text(item.calculationStatus)}`);
      const sourceRefs = (Array.isArray(item?.sourceRefs) ? item.sourceRefs : []).map(text).filter(Boolean);
      if (sourceRefs.length) lines.push(`来源：${sourceRefs.join('、')}`);
      const requiredFields = (Array.isArray(item?.requiredPolicyFields) ? item.requiredPolicyFields : []).map(text).filter(Boolean);
      if (requiredFields.length) lines.push(`计算所需保单信息：${requiredFields.join('、')}`);
      lines.push('');
    });
  }
  const requiredPolicyFields = (Array.isArray(summary.requiredPolicyFields) ? summary.requiredPolicyFields : []).map(text).filter(Boolean);
  if (requiredPolicyFields.length) {
    lines.push('### 计算金额需要这些保单信息', requiredPolicyFields.join('、'), '');
  }
  const notices = (Array.isArray(summary.notices) ? summary.notices : []).map(text).filter(Boolean);
  if (notices.length) {
    lines.push('### 注意事项', ...notices.map((notice, index) => `${index + 1}. ${notice}`));
  }
  return lines.join('\n').trim();
}

function approvedMaterialEvidence(result = {}) {
  const evidenceLimit = text(result?.queryType) === 'product_advantage' ? 4 : 10;
  const evidenceChunks = (Array.isArray(result?.evidenceChunks) ? result.evidenceChunks : [])
    .filter((chunk) => text(chunk?.content)
      && text(chunk?.reviewStatus) === 'published'
      && ['company_material', 'approved_company_material', 'expert_training'].includes(text(chunk?.sourceAuthority)))
    .slice(0, evidenceLimit);
  const evidence = evidenceChunks.map((chunk, index) => ({
    evidenceId: text(chunk.evidenceId) || `M${index + 1}`,
    documentId: text(chunk.documentId),
    fileName: text(chunk?.citation?.fileName) || '已审核产品资料',
    pageStart: Number(chunk.pageStart || chunk?.citation?.pageStart || 0),
    pageEnd: Number(chunk.pageEnd || chunk?.citation?.pageEnd || chunk.pageStart || 0),
    topics: text(chunk.contextualPrefix).match(/切片主题：([^\n]+)/u)?.[1] || '',
    content: text(chunk.content).slice(0, 2_000),
    sourceAuthority: text(chunk.sourceAuthority) || 'company_material',
  }));
  const sourcesByDocument = new Map();
  for (const item of evidence) {
    const key = item.documentId || item.fileName;
    const current = sourcesByDocument.get(key) || { fileName: item.fileName, pages: new Set(), evidenceIds: [] };
    if (item.pageStart) current.pages.add(item.pageStart);
    if (item.pageEnd && item.pageEnd !== item.pageStart) current.pages.add(item.pageEnd);
    current.evidenceIds.push(item.evidenceId);
    sourcesByDocument.set(key, current);
  }
  const sources = [...sourcesByDocument.values()].slice(0, 2).map((source) => ({
    title: `${source.fileName}${source.pages.size ? `（第${[...source.pages].sort((a, b) => a - b).join('、')}页，公司培训资料）` : '（公司培训资料）'}`,
    url: '/admin',
    provenance: 'company_material',
    verified: true,
    evidenceIds: source.evidenceIds,
  }));
  return { evidence, sources };
}

const OFFICIAL_EVIDENCE_TERMS = [
  '等待期', '续保', '投保年龄', '免赔额', '赔付比例', '一般医疗', '重度疾病',
  '外购药械', '特定先进医疗', '特需医疗', '健康管理', '责任免除',
];

function officialSummaryText(summary = {}) {
  const parts = [text(summary?.headline)];
  for (const item of Array.isArray(summary?.mainResponsibilities) ? summary.mainResponsibilities : []) {
    parts.push(text(item?.title), text(item?.plainText), text(item?.howItPays));
  }
  for (const notice of Array.isArray(summary?.notices) ? summary.notices : []) parts.push(text(notice));
  return parts.filter(Boolean).join('\n');
}

function officialPages(content) {
  const pages = [];
  const marker = /(?:\d{4,}\s*)?第\s*(\d+)\s*页/gu;
  let pageNo = 1;
  let start = 0;
  for (const match of content.matchAll(marker)) {
    const rawText = text(content.slice(start, match.index));
    if (rawText) pages.push({ pageNo, rawText, tables: [], headings: [], sourceLabel: `第${pageNo}页` });
    pageNo = Number(match[1]) || pageNo + 1;
    start = Number(match.index) + match[0].length;
  }
  const tail = text(content.slice(start));
  if (tail) pages.push({ pageNo, rawText: tail, tables: [], headings: [], sourceLabel: `第${pageNo}页` });
  return pages.length ? pages : [{ pageNo: 1, rawText: content, tables: [], headings: [], sourceLabel: '第1页' }];
}

function officialChunkScore(chunk, question, materialEvidence) {
  const content = text(chunk?.content);
  const materialText = materialEvidence.map((item) => text(item?.content)).join('\n');
  let score = 0;
  for (const term of OFFICIAL_EVIDENCE_TERMS) {
    if (!content.includes(term)) continue;
    if (text(question).includes(term)) score += 5;
    if (materialText.includes(term)) score += 3;
    score += 1;
  }
  const topics = Array.isArray(chunk?.payload?.businessTopicLabels) ? chunk.payload.businessTopicLabels : [];
  if (/优势|亮点|卖点|好在哪里/u.test(text(question))) {
    if (topics.includes('保障责任')) score += 3;
    if (topics.includes('投保规则')) score += 2;
    if (topics.includes('责任免除') || topics.includes('计划与价格')) score += 1;
  }
  const materialNumbers = new Set(materialText.match(/\d+(?:\.\d+)?\s*(?:万元|万|元|%|天|周岁|年)/gu) || []);
  for (const value of materialNumbers) if (content.includes(value)) score += 2;
  return score;
}

function officialEvidenceFromSummary({ summary, sources, product, question, materialEvidence }) {
  const content = officialSummaryText(summary);
  const sourceTitle = text(sources[0]?.title) || `${product.productName}官方资料`;
  if (!content) return [];
  const chunks = chunkProductDocument({
    document: {
      id: `official_${text(product.company)}_${text(product.productName)}`,
      fileName: sourceTitle,
      documentType: 'terms',
      sourceAuthority: 'insurer_official',
      payload: {},
    },
    product: { company: product.company, productName: product.productName },
    pages: officialPages(content),
  }).filter((chunk) => chunk.chunkType === 'child' && text(chunk.content));
  return chunks
    .map((chunk, index) => ({ chunk, index, score: officialChunkScore(chunk, question, materialEvidence) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 4)
    .map(({ chunk }, index) => ({
      evidenceId: `O${index + 1}`,
      sourceAuthority: 'insurer_official',
      sourceTitle,
      sourceUrl: text(sources[0]?.url),
      pageStart: Number(chunk.pageStart || 0),
      pageEnd: Number(chunk.pageEnd || chunk.pageStart || 0),
      topics: Array.isArray(chunk?.payload?.businessTopicLabels) ? chunk.payload.businessTopicLabels.join('、') : '',
      content: text(chunk.content),
    }));
}

function questionNeedsOfficialDocument(question, summary) {
  const value = text(question);
  const summaryText = officialSummaryText(summary);
  for (const rule of CRITICAL_FACT_RULES) {
    const asksField = rule.field === '给付或报销比例'
      ? /(?:给付|赔付|报销)比例/u.test(value)
      : value.includes(rule.field);
    if (!asksField) continue;
    return !(criticalFacts(summaryText).get(rule.field) || []).length;
  }
  return false;
}

function officialKnowledgeRows(rows = []) {
  return rows.flatMap((row) => {
    let payload;
    try { payload = JSON.parse(row.payload || '{}'); } catch { payload = {}; }
    if (text(payload.evidenceLevel) !== 'insurer_official') return [];
    try {
      const url = new URL(row.url);
      if (url.protocol !== 'https:' || url.username || url.password) return [];
      return [{ row, payload, url }];
    } catch {
      return [];
    }
  });
}

function responseContentType(response) {
  return text(response?.headers?.get?.('content-type')).toLowerCase();
}

async function fetchedOfficialPages({ response, url }) {
  const contentType = responseContentType(response);
  const contentLength = Number(response?.headers?.get?.('content-length') || 0);
  if (contentLength > MAX_OFFICIAL_DOCUMENT_BYTES) return [];
  const isPdf = contentType.includes('application/pdf')
    || (!contentType && /\.pdf(?:$|[?#])/iu.test(url.pathname));
  if (!isPdf) {
    const rawText = text(await response.text());
    return rawText ? officialPages(rawText.replace(/<[^>]+>/gu, ' ')) : [];
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_OFFICIAL_DOCUMENT_BYTES) return [];
  const parsed = await parseProductDocument({ bytes, extension: 'pdf' });
  return parsed.pages;
}

async function officialEvidenceFromFullDocuments({
  rows,
  product,
  question,
  materialEvidence,
  fetchImpl,
  timeoutMs,
}) {
  const candidates = officialKnowledgeRows(rows).slice(0, 3);
  for (const { payload, url } of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/pdf,text/plain,text/html' },
      });
      if (!response.ok) continue;
      const pages = await fetchedOfficialPages({ response, url });
      if (!pages.length) continue;
      const sourceTitle = text(payload.title) || `${product.productName}官方资料`;
      const chunks = chunkProductDocument({
        document: {
          id: `official_full_${text(product.company)}_${text(product.productName)}`,
          fileName: sourceTitle,
          documentType: 'terms',
          sourceAuthority: 'insurer_official',
          payload: {},
        },
        product: { company: product.company, productName: product.productName },
        pages,
      }).filter((chunk) => chunk.chunkType === 'child' && text(chunk.content));
      const evidence = chunks
        .map((chunk, index) => ({ chunk, index, score: officialChunkScore(chunk, question, materialEvidence) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, 4)
        .map(({ chunk }, index) => ({
          evidenceId: `O${index + 1}`,
          sourceAuthority: 'insurer_official',
          sourceTitle,
          sourceUrl: url.href,
          pageStart: Number(chunk.pageStart || 0),
          pageEnd: Number(chunk.pageEnd || chunk.pageStart || 0),
          topics: Array.isArray(chunk?.payload?.businessTopicLabels) ? chunk.payload.businessTopicLabels.join('、') : '',
          content: text(chunk.content),
        }));
      const fetchedSummary = { headline: evidence.map((item) => item.content).join('\n') };
      if (evidence.length && !questionNeedsOfficialDocument(question, fetchedSummary)) {
        return {
          evidence,
          sources: [{
            title: sourceTitle,
            url: url.href,
            provenance: 'insurer_official',
            verified: true,
          }],
        };
      }
    } catch {
      // Continue with the next official document or the persisted excerpt.
    } finally {
      clearTimeout(timeout);
    }
  }
  return { evidence: [], sources: [] };
}

const CRITICAL_FACT_RULES = [
  { field: '等待期', pattern: /等待期.{0,12}?(\d+)\s*(天|日|个月|月)/gu },
  { field: '最高续保年龄', pattern: /(?:最高)?(?:可续保|续保).{0,12}?(\d+)\s*周?岁/gu },
  { field: '免赔额', pattern: /免赔额.{0,12}?(\d+(?:\.\d+)?)\s*(万元|万|元)/gu },
  { field: '给付或报销比例', pattern: /(?:给付|赔付|报销)(?:比例)?.{0,12}?(\d+(?:\.\d+)?)\s*%/gu },
];

function normalizedCriticalValue(match) {
  const unit = match[2] === '日' ? '天' : match[2] === '月' ? '个月' : match[2];
  return `${match[1]}${unit}`;
}

function criticalFacts(value) {
  const content = typeof value === 'string' ? value : JSON.stringify(value || {});
  const facts = new Map();
  for (const rule of CRITICAL_FACT_RULES) {
    const values = [...content.matchAll(rule.pattern)].map(normalizedCriticalValue);
    if (values.length) facts.set(rule.field, [...new Set(values)]);
  }
  return facts;
}

function evidenceConflicts(officialEvidence, materialEvidence) {
  const officialFacts = criticalFacts(officialEvidence);
  const materialFacts = criticalFacts(materialEvidence.map((item) => item.content).join('\n'));
  const conflicts = [];
  for (const [field, officialValues] of officialFacts) {
    const materialValues = materialFacts.get(field) || [];
    if (!materialValues.length || materialValues.some((value) => officialValues.includes(value))) continue;
    conflicts.push({
      field,
      officialValues,
      companyMaterialValues: materialValues,
      resolution: '采用官方资料，并提示培训资料存在差异',
    });
  }
  return conflicts;
}

function removeUnknownEvidenceReferences(answer, validEvidenceIds) {
  return text(answer).replace(
    /【(?:责任卡|官方资料|培训资料)([ROM]\d+)(?:·第[\d、,，-]+页)?】/gu,
    (reference, evidenceId) => validEvidenceIds.has(evidenceId) ? reference : '',
  );
}

async function settleWithin(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timeout = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function createAgentProductKnowledgeSearch({
  db,
  env = process.env,
  fetchImpl = fetch,
  officialDocumentFetchImpl = fetch,
  responsibilityQuery,
  responsibilitySummaryQuery,
  productRagRetrieve,
  salesStatusLookup,
  officialDomainProfiles = [],
} = {}) {
  if (!db) return null;
  const hasSummaryTable = Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'product_customer_responsibility_summaries'
    LIMIT 1
  `).get());
  if (!hasSummaryTable) return null;
  const hasKnowledgeTable = Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'knowledge_records'
    LIMIT 1
  `).get());
  const hasProductTable = Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'insurance_products'
    LIMIT 1
  `).get());
  const productIdentityStatement = hasProductTable ? db.prepare(`
    SELECT canonical_product_id
    FROM insurance_products
    WHERE company = ? AND official_name = ?
    LIMIT 1
  `) : null;
  const summarySources = db.prepare("SELECT source_urls_json FROM product_customer_responsibility_summaries WHERE status = 'ready'").all();
  const allowedOrigins = safeOrigins(summarySources);
  const apiKey = text(env.DEEPSEEK_API_KEY);
  const baseUrl = text(env.DEEPSEEK_BASE_URL) || 'https://api.deepseek.com';
  const model = text(env.DINGTALK_PRODUCT_EXPERT_MODEL || env.DEEPSEEK_MODEL) || 'deepseek-v4-flash';
  const timeoutMs = Math.max(1_000, Number(env.DINGTALK_PRODUCT_EXPERT_TIMEOUT_MS) || 20_000);
  const responsibilitySummaryTimeoutMs = Math.max(
    10,
    Number(env.DINGTALK_RESPONSIBILITY_SUMMARY_TIMEOUT_MS) || 5_000,
  );
  const officialDocumentTimeoutMs = Math.max(
    1_000,
    Number(env.DINGTALK_OFFICIAL_DOCUMENT_TIMEOUT_MS) || 8_000,
  );

  async function answerQuestion({ question, product, summary, sources, customerResponsibilitySummary = null, responsibilityCardEvidence = [], officialEvidence = [], materialEvidence = [], fallback }) {
    if (!apiKey) return fallback;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const conflicts = evidenceConflicts(summary, materialEvidence);
      const response = await fetchImpl(new URL('/chat/completions', baseUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(sanitizeDeepSeekRequestBody({
          model,
          temperature: 0.1,
          max_tokens: 1_200,
          messages: [
            {
              role: 'system',
              content: [
                '你是 OCR Insurance 的保险产品专家。只依据用户提供的 VERIFIED_EVIDENCE 回答当前问题，不得使用模型记忆补充产品事实。',
                'VERIFIED_EVIDENCE 同时包含官方证据和已审核公司资料时，必须围绕用户问题融合为一份连贯答案，不得分别输出“官网答案”和“资料答案”。',
                '保险责任、免责、等待期、金额、比例和续保等合同事实以官方证据为准；公司资料只用于补充产品定位、优势、适用场景、服务和销售说明，不得覆盖或扩大正式条款。',
                '结构化责任卡用于定位责任名称、触发条件、限额和计算规则；责任卡要求结合计划或保单数据时，不得直接承诺最终赔付结果。',
                'CUSTOMER_RESPONSIBILITY_SUMMARY 是 C 端保险责任助手已经确认的结构化责任结果；回答保险责任时必须以它为主口径，不得用责任卡、官网切片或上传资料另行改写、合并或新增责任。',
                '已审核上传资料只可补充产品说明、客户场景和责任解释；若与 CUSTOMER_RESPONSIBILITY_SUMMARY 不一致，不采用上传资料的冲突内容。',
                '责任卡与官网原文冲突时以官网原文为准；每项责任卡结论写作【责任卡R1】，并在涉及合同数字时同时引用对应官网证据。',
                '两类证据冲突时采用官方证据，并简短提示公司资料与正式条款存在差异。',
                '必须直接回答用户实际询问的维度；问优势时提炼3至5项有证据的客户价值、适合场景和必要限制，不能只重复保险责任。',
                '问保险责任时只输出一段概述、核心责任和必要限制；不要再输出“产品主要做什么”“主要保险责任”“责任明细”等内容重复的章节。',
                '每项结论后必须引用真实 evidenceId：官方证据写作【官方资料O1·第2页】，公司资料写作【培训资料M1·第14页】；不得创造证据编号或页码。',
                '金额、比例、等待期、续保、投保年龄、责任和免责等合同事实必须引用官方证据；只有培训资料支持时必须明确说是培训资料介绍。',
                '不得承诺收益、分红、理赔或核保结果；分红、万能结算、演示利益等非保证内容必须明确提示不保证。',
                '证据不足的部分写“现有资料无法确认”，不要编造。输出简洁中文，不提模型、接口、数据库或内部字段。',
              ].join('\n'),
            },
            {
              role: 'user',
              content: JSON.stringify({
                question: text(question).slice(0, 1_000),
                product: { company: product.company, productName: product.productName },
                verifiedEvidence: {
                  customerResponsibilitySummary,
                  responsibilityCardEvidence,
                  officialEvidence,
                  approvedCompanyMaterialEvidence: materialEvidence,
                  conflicts,
                },
                verifiedSourceUrls: sources.map((source) => source.url),
              }),
            },
          ],
        })),
      });
      if (!response.ok) return fallback;
      const payload = await response.json();
      const validEvidenceIds = new Set([
        ...responsibilityCardEvidence.map((item) => text(item.evidenceId)).filter(Boolean),
        ...officialEvidence.map((item) => text(item.evidenceId)).filter(Boolean),
        ...materialEvidence.map((item) => text(item.evidenceId)).filter(Boolean),
      ]);
      return removeUnknownEvidenceReferences(payload?.choices?.[0]?.message?.content, validEvidenceIds) || fallback;
    } catch {
      return fallback;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function answerMaterialSupplement({ question, product, customerResponsibilitySummary, materialEvidence }) {
    if (!apiKey || !materialEvidence.length) return '';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL('/chat/completions', baseUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(sanitizeDeepSeekRequestBody({
          model,
          temperature: 0.1,
          max_tokens: 600,
          messages: [
            {
              role: 'system',
              content: [
                '你只负责给保险责任助手的完整答案补充已审核公司资料中的额外说明。',
                '只可补充产品定位、适用场景、客户理解、健康服务或销售说明，不得重复、改写、合并或新增任何保险责任，不得补充合同金额、比例、等待期、免责或续保结论。',
                '如果公司资料没有真正新增的非合同说明，只输出 NO_SUPPLEMENT。',
                '每项补充必须引用真实培训资料 evidenceId，格式如【培训资料M1·第3页】；不得创造编号或页码。',
                '输出简洁中文，不要标题，不提模型、接口、数据库或内部字段。',
              ].join('\n'),
            },
            {
              role: 'user',
              content: JSON.stringify({
                question: text(question).slice(0, 1_000),
                product: { company: product.company, productName: product.productName },
                allowedResponsibilityTitles: (Array.isArray(customerResponsibilitySummary?.mainResponsibilities)
                  ? customerResponsibilitySummary.mainResponsibilities
                  : []).map((item) => text(item?.title)).filter(Boolean),
                approvedCompanyMaterialEvidence: materialEvidence,
              }),
            },
          ],
        })),
      });
      if (!response.ok) return '';
      const payload = await response.json();
      const validEvidenceIds = new Set(materialEvidence.map((item) => text(item.evidenceId)).filter(Boolean));
      const supplement = removeUnknownEvidenceReferences(payload?.choices?.[0]?.message?.content, validEvidenceIds);
      if (!supplement || supplement === 'NO_SUPPLEMENT' || /(?:责任|保险金)/u.test(supplement)) return '';
      return supplement;
    } catch {
      return '';
    } finally {
      clearTimeout(timeout);
    }
  }

  async function answerComparison({ question, compared }) {
    const fallback = compared.map((item) => item.answer).filter(Boolean).join('\n\n');
    if (!apiKey) return fallback;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL('/chat/completions', baseUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(sanitizeDeepSeekRequestBody({
          model,
          temperature: 0.1,
          max_tokens: 1_500,
          messages: [
            {
              role: 'system',
              content: [
                '你是 OCR Insurance 的保险产品对比专家。只依据 VERIFIED_PRODUCT_RESULTS 比较，不得使用模型记忆补充产品事实。',
                '先确认两款产品是否同类型，再按已有证据比较保障期限、责任、等待期、续保或费率机制、主要限制和适合场景。',
                '证据没有覆盖的维度明确写“现有资料无法确认”；不得直接断言哪款更好，不得承诺理赔、核保或续保结果。',
                '输出简洁中文，优先使用对比表或分点结论，不提模型、接口、数据库或内部字段。',
              ].join('\n'),
            },
            {
              role: 'user',
              content: JSON.stringify({
                question: text(question).slice(0, 1_000),
                verifiedProductResults: compared.map((item) => ({ answer: item.answer, sourceUrls: item.sources.map((source) => source.url) })),
              }),
            },
          ],
        })),
      });
      if (!response.ok) return fallback;
      const payload = await response.json();
      return text(payload?.choices?.[0]?.message?.content) || fallback;
    } catch {
      return fallback;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function searchSingle({ question, productName } = {}) {
    const query = [text(productName), text(question)].filter(Boolean).join(' ');
    const companies = listProductCatalogCompanies({ db, visibility: 'public' });
    const company = companyFromQuery(query, companies, officialDomainProfiles);
    const productQuery = text(productName) || query;
    const catalogQuery = searchText(productQuery, company);
    const requestedProductName = text(productName);
    const explicitProductQuery = requestedProductName.replace(company, '').trim().replace(/^的/u, '').trim();
    const summaryStatement = db.prepare(`
      SELECT summary_json, source_urls_json
      FROM product_customer_responsibility_summaries
      WHERE company = ? AND product_name = ? AND status = 'ready'
      ORDER BY updated_at DESC LIMIT 1
    `);
    const knowledgeStatement = hasKnowledgeTable ? db.prepare(`
      SELECT url, payload
      FROM knowledge_records
      WHERE company = ? AND product_name = ?
      ORDER BY id
    `) : null;
    const exactProducts = explicitProductQuery ? [
      ...db.prepare(`
        SELECT DISTINCT company, product_name AS productName
        FROM product_customer_responsibility_summaries
        WHERE status = 'ready' AND product_name = ?
      `).all(requestedProductName),
      ...(hasKnowledgeTable ? db.prepare(`
        SELECT DISTINCT company, product_name AS productName
        FROM knowledge_records
        WHERE product_name = ?
          AND json_valid(payload) = 1
          AND json_extract(payload, '$.evidenceLevel') = 'insurer_official'
      `).all(requestedProductName) : []),
    ].map((product) => ({ ...product, score: 1_000 })) : [];
    const rankedProducts = exactProducts.length
      ? exactProducts
      : explicitProductQuery
        ? searchProductCatalog({ db, company, query: explicitProductQuery, limit: 20, visibility: 'public' })
        .filter((product) => product.score >= 100)
        : searchProductCatalog({ db, company, query: catalogQuery, limit: 5, visibility: 'public' });
    const productsByIdentity = new Map();
    for (const product of rankedProducts) {
      const key = catalogIdentity(product.productName);
      const current = productsByIdentity.get(key);
      if (!current || (!summaryStatement.get(current.company, current.productName)
        && summaryStatement.get(product.company, product.productName))) {
        productsByIdentity.set(key, product);
      }
    }
    const products = [...productsByIdentity.values()];
    const topScore = Number(products[0]?.score || 0);
    const ambiguous = products.filter((product) => Number(product.score || 0) >= topScore - 20);
    const requestedIdentity = catalogIdentity(explicitProductQuery);
    const topIdentity = catalogIdentity(products[0]?.productName);
    if (company && explicitProductQuery && products.length && topScore < 500) {
      return { ...missingProductEvidenceGuidance({ productName: requestedProductName, question }), sources: [] };
    }
    if (
      !exactProducts.length
      && requestedIdentity.length >= 4
      && topScore >= 700
      && topIdentity
      && !topIdentity.includes(requestedIdentity)
    ) {
      return {
        answer: '',
        sources: [],
        candidates: [{ ref: 'product_1', label: `${products[0].company}《${products[0].productName}》` }],
      };
    }
    if (SALES_STATUS_QUESTION_PATTERN.test(text(question)) && knowledgeStatement) {
      let discoveredPending = [];
      if (typeof salesStatusLookup === 'function') {
        try {
          const liveStatuses = await salesStatusLookup({
            company: company || products[0]?.company,
            productNames: products.map((product) => product.productName),
            discoveryQuery: catalogQuery,
          });
          discoveredPending = (Array.isArray(liveStatuses) ? liveStatuses : []).filter((item) => (
            text(item?.status) === '待核验' && text(item?.productName)
          ));
          const verifiedStatuses = (Array.isArray(liveStatuses) ? liveStatuses : []).flatMap((item) => {
            try {
              const url = new URL(item?.source?.url);
              const status = text(item?.status);
              const evidenceLevel = text(item?.evidenceLevel);
              if (url.protocol !== 'https:' || url.username || url.password || (evidenceLevel && evidenceLevel !== 'insurer_official') || !/^(?:在售|销售中|active|on_sale|停售|已停售|stopped|off_sale)$/iu.test(status)) return [];
              if (!allowedOrigins.includes(url.origin)) allowedOrigins.push(url.origin);
              return [{ ...item, status, sourceUrl: url.href }];
            } catch {
              return [];
            }
          });
          const confirmed = verifiedStatuses.filter((item) => /^(?:在售|销售中|active|on_sale)$/iu.test(item.status));
          const stopped = verifiedStatuses.filter((item) => /^(?:停售|已停售|stopped|off_sale)$/iu.test(item.status));
          const checkedNames = new Set(verifiedStatuses.map((item) => text(item.productName)));
          const pending = [
            ...products.filter((product) => !checkedNames.has(text(product.productName))),
            ...discoveredPending,
          ].filter((item, index, rows) => rows.findIndex((row) => text(row.productName) === text(item.productName)) === index);
          const sources = verifiedStatuses.map((item) => ({
            title: text(item?.source?.title) || `${text(item?.productName)}官方资料`,
            url: item.sourceUrl,
            provenance: 'insurer_official',
            verified: true,
          }));
          if (verifiedStatuses.length && sources.length) {
            return {
              answer: [
                `已核验 ${products.length} 款候选产品：官网确认在售 ${confirmed.length} 款，明确停售 ${stopped.length} 款，待核验 ${pending.length} 款。`,
                confirmed.length ? '\n### 官网确认在售' : '\n### 官网确认在售\n- 暂未发现官网明确标注为在售的产品',
                ...confirmed.map((item) => `- 🟢 **${text(item.productName)}**`),
                ...(stopped.length ? ['\n### 已明确停售', ...stopped.map((item) => `- 🔴 **${text(item.productName)}**`)] : []),
                ...(pending.length ? ['\n### 待官网核验', ...pending.map((item) => `- 🟡 **${text(item.productName)}**`)] : []),
                '\n> 销售状态可能随时变化，最终以保险公司当前投保渠道为准。',
                '\n回复产品名称可查看详细责任；也可以发送“产品A 对比 产品B”。',
              ].join('\n'),
              sources,
            };
          }
        } catch {
          // Use the dated local official record when the live check is unavailable.
        }
      }
      const onSaleProducts = products.flatMap((product) => {
        const evidence = onSaleProductEvidence(knowledgeStatement.all(product.company, product.productName), product, allowedOrigins);
        return evidence ? [evidence] : [];
      });
      const sources = onSaleProducts.flatMap((item) => item.sources).slice(0, 10);
      if (onSaleProducts.length && sources.length) {
        const checkedAt = onSaleProducts.map((item) => text(item.checkedAt)).filter(Boolean).sort().at(-1);
        return {
          answer: [
            `已检查 ${products.length + discoveredPending.length} 款候选产品；本次联网未找到官网明确标注的当前销售状态。`,
            ...(discoveredPending.length ? [
              '\n### 全网发现 · 待官网核验',
              ...discoveredPending.map((item) => `- 🟠 **${text(item.productName)}**${text(item.evidenceLevel) === 'insurer_official' ? ' · 官方资料已发现' : ' · 第三方线索'}`),
            ] : []),
            `\n### 官方资料曾标记为在售${checkedAt ? ` · 最近抓取 ${checkedAt.slice(0, 10)}` : ''}`,
            ...onSaleProducts.map((item) => `- 🟡 **${item.product.productName}**`),
            '\n> 以上是历史官方记录，不等同于当前官网确认在售，最终以保险公司当前销售渠道为准。',
            '\n回复产品名称可查看详细责任；也可以发送“产品A 对比 产品B”。',
          ].join('\n'),
          sources,
        };
      }
    }
    if (ambiguous.length > 1) {
      return {
        answer: '',
        sources: [],
        candidates: ambiguous.map((product, index) => ({
          ref: `product_${index + 1}`,
          label: `${product.company}《${product.productName}》`,
        })),
      };
    }
    const eligible = [];
    for (const product of products) {
      if (Number(product.score || 0) <= 0) continue;
      if (typeof responsibilityQuery === 'function') {
        try {
          const result = await responsibilityQuery({ company: product.company, name: product.productName });
          const assistant = responsibilityAssistantEvidence(result, product, allowedOrigins, question);
          if (assistant) {
            if (RESPONSIBILITY_QUESTION_PATTERN.test(text(question)) && typeof responsibilitySummaryQuery === 'function') {
              try {
                const summaryResult = await settleWithin(
                  responsibilitySummaryQuery({ company: product.company, name: product.productName }),
                  responsibilitySummaryTimeoutMs,
                );
                const customerSummary = customerResponsibilitySummaryEvidence(summaryResult, product, allowedOrigins);
                if (customerSummary) {
                  assistant.directAnswer = customerSummary.directAnswer;
                  assistant.sources = customerSummary.sources.length ? customerSummary.sources : assistant.sources;
                  assistant.customerResponsibilitySummary = customerSummary.summary;
                }
              } catch {
                // Keep the responsibility rows returned by the shared query.
              }
            }
            eligible.push({ product, ...assistant });
          }
        } catch {
          // Fall back to the same product's persisted verified evidence.
        }
      }
      const row = summaryStatement.get(product.company, product.productName);
      if (!eligible.some((item) => item.product === product) && row) {
        try {
          const summary = JSON.parse(row.summary_json || '{}');
          const sources = verifiedSources(JSON.parse(row.source_urls_json || '[]'), product, allowedOrigins);
          if (sources.length) eligible.push({ product, summary, sources });
        } catch {
          // Try official knowledge evidence for this exact product.
        }
      }
      if (!eligible.some((item) => item.product === product) && knowledgeStatement) {
        const official = officialKnowledgeEvidence(knowledgeStatement.all(product.company, product.productName), product, allowedOrigins);
        if (official) eligible.push({ product, ...official });
      }
      if (eligible.length) break;
    }
    const selected = eligible[0] || null;
    if (!selected) return { ...missingProductEvidenceGuidance({ productName: requestedProductName, question }), sources: [] };
    const { product, summary, sources, customerResponsibilitySummary = null, responsibilityCardEvidence = [] } = selected;
    const responsibilityQuestion = RESPONSIBILITY_QUESTION_PATTERN.test(text(question));
    let material = { evidence: [], sources: [] };
    const canonicalProductId = text(product.canonicalProductId)
      || text(productIdentityStatement?.get(product.company, product.productName)?.canonical_product_id);
    if (canonicalProductId && typeof productRagRetrieve === 'function') {
      try {
        material = approvedMaterialEvidence(await productRagRetrieve({
          tenantId: 'default',
          query: question,
          canonicalProductId,
          sourceAuthorities: ['company_material', 'approved_company_material', 'expert_training'],
          products: [{ company: product.company, productName: product.productName }],
          tokenBudget: 3_000,
        }));
      } catch {
        material = { evidence: [], sources: [] };
      }
    }
    if (responsibilityQuestion && customerResponsibilitySummary) {
      const directAnswer = answerFromCustomerResponsibilitySummary(customerResponsibilitySummary);
      const supplement = await answerMaterialSupplement({
        question,
        product,
        customerResponsibilitySummary,
        materialEvidence: material.evidence,
      });
      const answer = [
        directAnswer,
        supplement ? `### 已审核产品资料补充\n${supplement}` : '',
      ].filter(Boolean).join('\n\n');
      return {
        answer: answer ? `${product.company}《${product.productName}》：\n${answer}` : '',
        sources: [...sources, ...material.sources],
      };
    }
    const fallback = answerFromSummary(summary);
    const customerResponsibilityFallback = customerResponsibilitySummary
      ? answerFromSummary(customerResponsibilitySummary)
      : '';
    const responsibilityFallback = responsibilityQuestion && customerResponsibilityFallback
      ? customerResponsibilityFallback
      : text(selected.directAnswer) || fallback;
    let answerFallback = responsibilityFallback;
    let officialSummary = summary;
    let officialSources = sources;
    if (knowledgeStatement) {
      const rawOfficial = officialKnowledgeEvidence(
        knowledgeStatement.all(product.company, product.productName),
        product,
        allowedOrigins,
      );
      if (rawOfficial) {
        officialSummary = rawOfficial.summary;
        officialSources = rawOfficial.sources;
      }
    }
    let officialEvidence = officialEvidenceFromSummary({
      summary: officialSummary,
      sources: officialSources,
      product,
      question,
      materialEvidence: material.evidence,
    });
    if (knowledgeStatement && questionNeedsOfficialDocument(question, officialSummary)) {
      const fullDocument = await officialEvidenceFromFullDocuments({
        rows: knowledgeStatement.all(product.company, product.productName),
        product,
        question,
        materialEvidence: material.evidence,
        fetchImpl: officialDocumentFetchImpl,
        timeoutMs: officialDocumentTimeoutMs,
      });
      if (fullDocument.evidence.length) {
        officialEvidence = fullDocument.evidence;
        officialSources = fullDocument.sources;
        answerFallback = fullDocument.evidence.map((item) => item.content).join('\n');
        for (const source of fullDocument.sources) {
          const origin = new URL(source.url).origin;
          if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin);
        }
      }
    }
    const answer = await answerQuestion({
      question,
      product,
      summary,
      sources,
      customerResponsibilitySummary,
      responsibilityCardEvidence,
      officialEvidence,
      materialEvidence: material.evidence,
      fallback: answerFallback,
    });
    return {
      answer: answer ? `${product.company}《${product.productName}》：\n${answer}` : '',
      sources: [
        ...[...new Map([...sources, ...officialSources].map((source) => [source.url, source])).values()]
          .map((source) => ({
            ...source,
            evidenceIds: [
              ...responsibilityCardEvidence.map((item) => item.evidenceId),
              ...officialEvidence.map((item) => item.evidenceId),
            ],
          })),
        ...material.sources,
      ],
    };
  }

  async function search({ question, productName } = {}) {
    const productQueries = comparisonProductQueries(question);
    if (productQueries.length !== 2) return searchSingle({ question, productName });
    const compared = await Promise.all(productQueries.map((query) => searchSingle({
      question: `${query}的保险责任、保障期限、等待期、续保和费率机制`,
      productName: query,
    })));
    const clarification = compared.find((result) => Array.isArray(result.candidates) && result.candidates.length);
    if (clarification) return clarification;
    if (compared.some((result) => !text(result.answer) || !Array.isArray(result.sources) || !result.sources.length)) {
      return { answer: '', sources: [] };
    }
    const sources = [...new Map(compared.flatMap((result) => result.sources).map((source) => [source.url, source])).values()];
    return {
      answer: await answerComparison({ question, compared }),
      sources,
    };
  }

  return { search, allowedOrigins };
}
