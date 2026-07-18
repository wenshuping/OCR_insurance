import { listProductCatalogCompanies, searchProductCatalog } from './product-catalog-search.mjs';
import { sanitizeDeepSeekRequestBody } from './deepseek-privacy-gateway.mjs';
import { chunkProductDocument } from './product-chunker.service.mjs';
import { parseProductDocument } from './product-document-parser.service.mjs';
import {
  assessProductEvidenceCompleteness,
  createProductRetrievalPlan,
  isResponsibilityOutlineOnly,
  validateProductRetrievalPlan,
} from './agent-product-retrieval-plan.service.mjs';

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
    .replace(/^(?:请|你|帮我|帮忙|看看|分析一下)/u, '')
    .replace(/(?:有什么)?(?:区别|差异|哪个好|哪款好)[？?]?$/u, '')
    .replace(/[啊呀呢哦吧嘛啦了]+[？?]?$/u, '')
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

function responsibilityAssistantEvidence(
  result = {},
  product = {},
  allowedOrigins = [],
  question = '',
  { allowExternalReferences = false } = {},
) {
  const analysis = result?.analysis || result;
  const cards = Array.isArray(analysis?.responsibilityCards) ? analysis.responsibilityCards : [];
  const coverageRows = Array.isArray(analysis?.coverageTable) ? analysis.coverageTable : [];
  const selectedRows = (cards.length ? cards : coverageRows).slice(0, 20);
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
    const referenceOnly = source?.referenceOnly === true || source?.official === false;
    if (referenceOnly && !allowExternalReferences) return [];
    if (!referenceOnly && source?.official !== true && text(source?.evidenceLevel) !== 'insurer_official') return [];
    try {
      const url = new URL(source?.url);
      const allowedProtocol = url.protocol === 'https:' || (referenceOnly && url.protocol === 'http:');
      if (!allowedProtocol || url.username || url.password || seen.has(url.href)) return [];
      seen.add(url.href);
      if (!allowedOrigins.includes(url.origin)) allowedOrigins.push(url.origin);
      return [{
        title: text(source?.title) || `${product.productName}${referenceOnly ? '公开资料' : '官方资料'}`,
        url: url.href,
        provenance: referenceOnly ? 'open_web_reference' : 'insurer_official',
        verified: !referenceOnly,
        referenceOnly,
      }];
    } catch {
      return [];
    }
  }).slice(0, 8);
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
  const referenceOnly = allowExternalReferences && sources.every((source) => source.referenceOnly === true);
  const disclaimer = text(analysis?.disclaimer)
    || (Array.isArray(analysis?.notes) ? analysis.notes.map(text).find((note) => /非官方|仅供.*参考|待.*确认/u.test(note)) : '')
    || '本结果基于非官方公开资料线索，仅供沟通参考，需以保险公司确认或补发合同条款为准。';
  const directAnswer = mainResponsibilities.map((item, index) => (
    `${index + 1}. ${item.title}：${item.plainText}`
  )).join('\n') || text(analysis?.report);
  const externalDirectAnswer = referenceOnly
    ? externalResponsibilitySummary(
      selectedRows,
      disclaimer,
      text(analysis?.rawAnalysis?.productCategory),
      sources,
      {
        multiSourceSynthesis: text(analysis?.rawAnalysis?.generatedBy) === 'multi_source_external_analysis',
        productOverview: analysis?.productOverview,
        generalRules: analysis?.generalRules,
        exclusions: analysis?.exclusions,
        valueAddedServices: analysis?.valueAddedServices,
      },
    )
    : '';
  return {
    summary: {
      headline: text(analysis?.report) || `${product.productName}保险责任`,
      mainResponsibilities,
    },
    sources,
    responsibilityCardEvidence,
    directAnswer: externalDirectAnswer || directAnswer,
    referenceOnly,
  };
}

function conciseExternalResponsibilityText(value, maxLength = 260) {
  const normalized = text(value)
    .replace(/\s+/gu, ' ')
    .split(/(?:相关推荐|上一篇|下一篇|当前位置|当前所在位置|所在位置|首页\s*\||免费注册|登录|客服热线|保险问答|产品测评|扫码下载)/u)[0]
    .trim();
  if (!normalized) return '';
  const sentences = normalized.split(/(?<=[。；])/u).map(text).filter(Boolean);
  let result = '';
  for (const sentence of sentences) {
    if (result && result.length + sentence.length > maxLength) break;
    result += sentence;
    if (result.length >= maxLength) break;
  }
  return (result || normalized).slice(0, maxLength).replace(/[，、；：\s]+$/u, '');
}

function externalResponsibilityLabels(productCategory = '') {
  if (productCategory === 'medical') {
    return { description: '保障范围', trigger: '适用条件', payout: '起付线/报销比例/限额' };
  }
  if (productCategory === 'critical_illness') {
    return { description: '疾病/状态范围', trigger: '给付条件', payout: '给付比例/次数/限额' };
  }
  if (productCategory === 'annuity') {
    return { description: '领取责任', trigger: '领取时间/条件', payout: '领取金额/频率' };
  }
  if (['incremental_whole_life', 'ordinary_whole_life', 'term_life', 'endowment', 'participating_life'].includes(productCategory)) {
    return { description: '责任内容', trigger: '给付触发', payout: '给付金额/计算方式' };
  }
  if (productCategory === 'accident') {
    return { description: '事故/保障场景', trigger: '给付条件', payout: '给付比例/限额' };
  }
  if (productCategory === 'long_term_care') {
    return { description: '护理状态/责任范围', trigger: '给付条件', payout: '给付金额/周期' };
  }
  if (['universal_life', 'investment_linked'].includes(productCategory)) {
    return { description: '保障/账户权益', trigger: '适用条件', payout: '给付或账户规则' };
  }
  return { description: '责任内容', trigger: '触发条件', payout: '给付规则' };
}

function compactDedupeText(value) {
  return text(value).replace(/[\s，,。；;：:、“”"'（）()【】\[\]]+/gu, '');
}

function externalResponsibilitySummary(
  rows = [],
  disclaimer = '',
  productCategory = '',
  sources = [],
  {
    multiSourceSynthesis = false,
    productOverview = {},
    generalRules = [],
    exclusions = [],
    valueAddedServices = [],
  } = {},
) {
  const labels = externalResponsibilityLabels(productCategory);
  const citationSources = (Array.isArray(sources) ? sources : []).slice(0, 8).flatMap((source) => {
    try {
      const url = new URL(source?.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
      return [{ title: text(source?.title).replace(/[\[\]\n]/gu, '').slice(0, 100) || '公开资料', url: url.href }];
    } catch {
      return [];
    }
  });
  const citationIndexByUrl = new Map(citationSources.map((source, index) => [source.url, index + 1]));
  const citedIndicesFrom = (sourceExcerpt = '', sourceUrl = '') => {
    const citedIndices = [...new Set(Array.from(text(sourceExcerpt).matchAll(/资料\s*(\d+)/gu))
      .map((match) => Number(match[1]))
      .filter((index) => index > 0 && index <= citationSources.length))];
    const sourceIndex = citationIndexByUrl.get(text(sourceUrl))
      || (citationSources.length === 1 ? 1 : 0);
    if (!citedIndices.length && sourceIndex) citedIndices.push(sourceIndex);
    return citedIndices;
  };
  const responsibilities = (Array.isArray(rows) ? rows : []).slice(0, 20).flatMap((row) => {
    const title = text(row?.title || row?.coverageType)
      .replace(/（待核实）/gu, '')
      .replace(/^待核实保险责任线索$/u, '保险责任线索');
    const trigger = conciseExternalResponsibilityText(row?.triggerCondition, 220);
    const description = conciseExternalResponsibilityText(
      row?.scenario || row?.sourceExcerpt,
      240,
    );
    let payout = conciseExternalResponsibilityText(
      row?.payoutSummary || row?.payout,
      260,
    );
    const normalizedDescription = compactDedupeText(description);
    const normalizedPayout = compactDedupeText(payout);
    if (normalizedDescription && normalizedPayout
      && (normalizedDescription.includes(normalizedPayout) || normalizedPayout.includes(normalizedDescription))) {
      payout = '';
    }
    const sourceUrl = text(row?.sourceUrl);
    const citedIndices = citedIndicesFrom(row?.sourceExcerpt, sourceUrl);
    return title && (trigger || description || payout)
      ? [{
          title,
          trigger,
          description,
          payout,
          responsibilityNumber: text(row?.responsibilityNumber),
          introducedInPlan: text(row?.introducedInPlan),
          citedIndices,
        }]
      : [];
  });
  if (!responsibilities.length) return '';
  const overview = productOverview && typeof productOverview === 'object' ? productOverview : {};
  const overviewLines = [
    text(overview.productType) ? `- 产品类型：${conciseExternalResponsibilityText(overview.productType, 180)}` : '',
    text(overview.purpose) ? `- 主要作用：${conciseExternalResponsibilityText(overview.purpose, 260)}` : '',
    text(overview.positioning) ? `- 保障定位：${conciseExternalResponsibilityText(overview.positioning, 260)}` : '',
  ].filter(Boolean);
  const overviewCitations = citedIndicesFrom(overview.sourceExcerpt);
  const planOptions = (Array.isArray(overview.planOptions) ? overview.planOptions : []).slice(0, 8).flatMap((plan) => {
    const name = conciseExternalResponsibilityText(plan?.name, 80);
    if (!name) return [];
    return [{
      name,
      premium: conciseExternalResponsibilityText(plan?.premium, 140),
      totalCoverage: conciseExternalResponsibilityText(plan?.totalCoverage, 140),
      relationship: conciseExternalResponsibilityText(plan?.relationship, 220),
      citedIndices: citedIndicesFrom(plan?.sourceExcerpt),
    }];
  });
  const normalizedRules = (Array.isArray(generalRules) ? generalRules : []).slice(0, 12).flatMap((rule) => {
    const title = conciseExternalResponsibilityText(rule?.title, 100);
    const detail = conciseExternalResponsibilityText(rule?.detail, 320);
    return title && detail ? [{ title, detail, citedIndices: citedIndicesFrom(rule?.sourceExcerpt) }] : [];
  });
  const normalizeSupplementalItems = (items) => (Array.isArray(items) ? items : []).slice(0, 12).flatMap((item) => {
    const title = conciseExternalResponsibilityText(item?.title, 100);
    const detail = conciseExternalResponsibilityText(item?.detail, 320);
    return title && detail ? [{ title, detail, citedIndices: citedIndicesFrom(item?.sourceExcerpt) }] : [];
  });
  const normalizedExclusions = normalizeSupplementalItems(exclusions);
  const normalizedServices = normalizeSupplementalItems(valueAddedServices);
  const responsibilityLines = (items) => items.flatMap((item, index) => [
    `${index + 1}. **${item.responsibilityNumber ? `责任${item.responsibilityNumber}：` : ''}${item.title}**`,
    ...(item.description ? [`${labels.description}：${item.description}`] : []),
    ...(item.trigger ? [`${labels.trigger}：${item.trigger}`] : []),
    ...(item.payout ? [`${labels.payout}：${item.payout}`] : []),
    ...(item.citedIndices.length ? [`引用：${item.citedIndices.map((index) => `〔${index}〕`).join('')}`] : []),
    '',
  ]);
  const shouldGroupPlans = planOptions.length > 1 && responsibilities.some((item) => item.introducedInPlan);
  const groupedResponsibilities = shouldGroupPlans
    ? planOptions.flatMap((plan) => {
        const items = responsibilities.filter((item) => item.introducedInPlan === plan.name);
        return items.length ? [`### ${plan.name}责任`, ...responsibilityLines(items)] : [];
      }).concat((() => {
        const items = responsibilities.filter((item) => !planOptions.some((plan) => plan.name === item.introducedInPlan));
        return items.length ? ['### 其他责任', ...responsibilityLines(items)] : [];
      })())
    : responsibilityLines(responsibilities);
  const warning = text(disclaimer)
    || '本结果基于非官方公开资料，仅供沟通参考，具体以保险公司确认或正式合同条款为准。';
  return [
    `> ⚠️ ${warning}`,
    '',
    ...(overviewLines.length ? [
      '### 产品概览',
      ...overviewLines,
      ...(overviewCitations.length ? [`引用：${overviewCitations.map((index) => `〔${index}〕`).join('')}`] : []),
      '',
    ] : []),
    ...(planOptions.length ? [
      '### 方案概览',
      ...planOptions.flatMap((plan) => [
        `- **${plan.name}**${plan.premium ? `：${plan.premium}` : ''}${plan.totalCoverage ? `；总保额：${plan.totalCoverage}` : ''}`,
        ...(plan.relationship ? [`  ${plan.relationship}`] : []),
        ...(plan.citedIndices.length ? [`  引用：${plan.citedIndices.map((index) => `〔${index}〕`).join('')}`] : []),
      ]),
      '',
    ] : []),
    multiSourceSynthesis
      ? `### 多来源责任汇总（${responsibilities.length}条明细，含子项，待核实）`
      : `### 公开资料责任线索（${responsibilities.length}项，非完整责任）`,
    ...groupedResponsibilities,
    ...(normalizedRules.length ? [
      '### 通用重要规则',
      ...normalizedRules.flatMap((rule, index) => [
        `${index + 1}. **${rule.title}**：${rule.detail}`,
        ...(rule.citedIndices.length ? [`引用：${rule.citedIndices.map((sourceIndex) => `〔${sourceIndex}〕`).join('')}`] : []),
      ]),
      '',
    ] : []),
    ...(normalizedExclusions.length ? [
      '### 免责简要',
      ...normalizedExclusions.flatMap((item, index) => [
        `${index + 1}. **${item.title}**：${item.detail}`,
        ...(item.citedIndices.length ? [`引用：${item.citedIndices.map((sourceIndex) => `〔${sourceIndex}〕`).join('')}`] : []),
      ]),
      '',
    ] : []),
    ...(normalizedServices.length ? [
      '### 增值服务',
      ...normalizedServices.flatMap((item, index) => [
        `${index + 1}. **${item.title}**：${item.detail}`,
        ...(item.citedIndices.length ? [`引用：${item.citedIndices.map((sourceIndex) => `〔${sourceIndex}〕`).join('')}`] : []),
      ]),
      '',
    ] : []),
    ...(citationSources.length ? [
      '### 公开资料来源（非官方）',
      ...citationSources.map((source, index) => (
        source.url.startsWith('https:')
          ? `${index + 1}. [${source.title}](${source.url})`
          : `${index + 1}. ${source.title}：${source.url}`
      )),
    ] : []),
  ].join('\n').trim();
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
      sourceRefs: (Array.isArray(block?.sourceRefs) ? block.sourceRefs : []).map(text).filter(Boolean),
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
    materialSources: (Array.isArray(summary.materialSources) ? summary.materialSources : []).map((source) => ({
      evidenceId: text(source?.evidenceId),
      fileName: text(source?.fileName),
      pageStart: Number(source?.pageStart || 0),
      pageEnd: Number(source?.pageEnd || source?.pageStart || 0),
    })).filter((source) => source.evidenceId || source.fileName),
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
      const sourceRefs = (Array.isArray(block?.sourceRefs) ? block.sourceRefs : []).map(text).filter(Boolean);
      if (sourceRefs.length) lines.push(`来源：${sourceRefs.join('、')}`);
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
  const materialSources = Array.isArray(summary.materialSources) ? summary.materialSources : [];
  if (materialSources.length) {
    lines.push('', '### 上传资料来源');
    materialSources.forEach((source) => {
      const pageStart = Number(source?.pageStart || 0);
      const pageEnd = Number(source?.pageEnd || pageStart || 0);
      const pages = pageStart ? `（第${pageStart}${pageEnd && pageEnd !== pageStart ? `-${pageEnd}` : ''}页）` : '';
      lines.push(`- ${text(source?.evidenceId)}：${text(source?.fileName) || '已审核上传资料'}${pages}`);
    });
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
    evidenceId: `M${index + 1}`,
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

function mergedApprovedMaterialEvidence(results = []) {
  const chunks = [];
  const seen = new Set();
  let queryType = '';
  for (const result of Array.isArray(results) ? results : []) {
    if (text(result?.queryType) === 'product_advantage') queryType = 'product_advantage';
    for (const chunk of Array.isArray(result?.evidenceChunks) ? result.evidenceChunks : []) {
      const key = [
        text(chunk?.documentId),
        Number(chunk?.pageStart || chunk?.citation?.pageStart || 0),
        text(chunk?.content).slice(0, 500),
      ].join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      chunks.push(chunk);
    }
  }
  return approvedMaterialEvidence({ queryType, evidenceChunks: chunks });
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
  const customerQuestion = text(question);
  const materialText = materialEvidence.map((item) => text(item?.content)).join('\n');
  let score = 0;
  for (const term of OFFICIAL_EVIDENCE_TERMS) {
    if (!content.includes(term)) continue;
    if (text(question).includes(term)) score += 5;
    if (materialText.includes(term)) score += 3;
    score += 1;
  }
  const topics = Array.isArray(chunk?.payload?.businessTopicLabels) ? chunk.payload.businessTopicLabels : [];
  if (/(?:计划|方案|保险责任|保障责任|保什么|分别|各自)/u.test(customerQuestion)
    && /(?:保险金|保险责任|保障计划)/u.test(content)) score += 6;
  const requestedPlans = customerQuestion.match(/(?:计划|方案)[一二三四五六七八九十百\dA-Za-z]+/gu) || [];
  for (const plan of new Set(requestedPlans)) if (content.includes(plan)) score += 2;
  if (/优势|亮点|卖点|好在哪里/u.test(text(question))) {
    if (topics.includes('保障责任')) score += 3;
    if (topics.includes('投保规则')) score += 2;
    if (topics.includes('责任免除') || topics.includes('计划与价格')) score += 1;
  }
  const materialNumbers = new Set(materialText.match(/\d+(?:\.\d+)?\s*(?:万元|万|元|%|天|周岁|年)/gu) || []);
  for (const value of materialNumbers) if (content.includes(value)) score += 2;
  return score;
}

function clauseNumber(value) {
  const normalized = text(value).replace(/\s+/gu, '');
  if (/^\d+$/u.test(normalized)) return Number(normalized);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (normalized === '十') return 10;
  const tenIndex = normalized.indexOf('十');
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : digits[normalized[tenIndex - 1]];
    const units = tenIndex === normalized.length - 1 ? 0 : digits[normalized[tenIndex + 1]];
    if (Number.isInteger(tens) && Number.isInteger(units)) return tens * 10 + units;
  }
  return Number.NaN;
}

function responsibilityRanges(value) {
  const ranges = [];
  for (const match of String(value || '').matchAll(
    /第\s*([一二三四五六七八九十零〇两\d]+)\s*款\s*至\s*第\s*([一二三四五六七八九十零〇两\d]+)\s*款/gu,
  )) {
    const from = clauseNumber(match[1]);
    const to = clauseNumber(match[2]);
    if (Number.isInteger(from) && Number.isInteger(to) && from > 0 && to >= from) ranges.push({ from, to });
  }
  return ranges;
}

function responsibilityHeadingNumbers(value) {
  const numbers = new Set();
  for (const match of String(value || '').matchAll(
    /(?:^|\n)\s*([一二三四五六七八九十零〇两\d]+)\s*[.．、]\s*[^\n。；]{2,100}?(?:保险金|医疗费用|救援费用)/gu,
  )) {
    const number = clauseNumber(match[1]);
    if (Number.isInteger(number) && number > 0) numbers.add(number);
  }
  return numbers;
}

function completeResponsibilityChunkWindow(chunks) {
  const values = Array.isArray(chunks) ? chunks : [];
  const ranges = values.flatMap((chunk, index) => responsibilityRanges(chunk?.content)
    .map((range) => ({ ...range, index })));
  const widest = ranges.sort((left, right) => (
    (right.to - right.from) - (left.to - left.from) || left.index - right.index
  ))[0];
  if (!widest) return [];
  const expected = new Set();
  for (let number = widest.from; number <= widest.to; number += 1) expected.add(number);
  const covered = new Set();
  const selectedIndexes = new Set([widest.index]);
  values.forEach((chunk, index) => {
    const headings = responsibilityHeadingNumbers(chunk?.content);
    for (const number of headings) {
      if (!expected.has(number)) continue;
      covered.add(number);
      selectedIndexes.add(index);
    }
  });
  if ([...expected].some((number) => !covered.has(number)) || selectedIndexes.size > 12) return [];
  return [...selectedIndexes].sort((left, right) => left - right).map((index) => values[index]);
}

function selectOfficialChunks({ chunks, question, materialEvidence, requireCompleteResponsibilities }) {
  if (requireCompleteResponsibilities) {
    const completeWindow = completeResponsibilityChunkWindow(chunks);
    if (completeWindow.length) return completeWindow;
  }
  return chunks
    .map((chunk, index) => ({ chunk, index, score: officialChunkScore(chunk, question, materialEvidence) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 4)
    .map(({ chunk }) => chunk);
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
  if (isResponsibilityOutlineOnly(summaryText)
    && /分别|各自|具体|明细|第\s*[一二三四五六七八九十百\d]+\s*款|保什么|保险责任|保障责任/u.test(value)) {
    return true;
  }
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
  requireCompleteResponsibilities = false,
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
      const evidence = selectOfficialChunks({
        chunks, question, materialEvidence, requireCompleteResponsibilities,
      }).map((chunk, index) => ({
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

function productLookupName(product) {
  const officialName = text(product?.productName);
  const company = text(product?.company);
  const withoutKnownCompany = company && officialName.startsWith(company)
    ? officialName.slice(company.length).trim()
    : officialName;
  return withoutKnownCompany.replace(
    /^[\p{Script=Han}A-Za-z0-9（）()·]{2,40}?(?:人寿保险股份有限公司|保险股份有限公司|人寿保险有限公司|保险有限公司)/u,
    '',
  ).trim() || officialName;
}

function officialEvidenceFromReferenceRecords({
  records, product, question, materialEvidence, requireCompleteResponsibilities = false,
}) {
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.official !== true || text(record?.evidenceLevel) !== 'insurer_official') continue;
    let url;
    try {
      url = new URL(record.url);
      if (url.protocol !== 'https:' || url.username || url.password) continue;
    } catch {
      continue;
    }
    const pageText = text(record.pageText);
    if (pageText.length < 40) continue;
    const sourceTitle = text(record.title) || `${product.productName}官方资料`;
    const chunks = chunkProductDocument({
      document: {
        id: `official_reference_${text(product.company)}_${text(product.productName)}`,
        fileName: sourceTitle,
        documentType: 'terms',
        sourceAuthority: 'insurer_official',
        payload: {},
      },
      product: { company: product.company, productName: product.productName },
      pages: officialPages(pageText),
    }).filter((chunk) => chunk.chunkType === 'child' && text(chunk.content));
    const evidence = selectOfficialChunks({
      chunks, question, materialEvidence, requireCompleteResponsibilities,
    }).map((chunk, index) => ({
        evidenceId: `O${index + 1}`,
        sourceAuthority: 'insurer_official',
        sourceTitle,
        sourceUrl: url.href,
        pageStart: Number(chunk.pageStart || 0),
        pageEnd: Number(chunk.pageEnd || chunk.pageStart || 0),
        topics: Array.isArray(chunk?.payload?.businessTopicLabels)
          ? chunk.payload.businessTopicLabels.join('、') : '',
        content: text(chunk.content),
      }));
    if (evidence.length) {
      return {
        evidence,
        sources: [{ title: sourceTitle, url: url.href, provenance: 'insurer_official', verified: true }],
      };
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

export function createAgentProductKnowledgeSearch({
  db,
  env = process.env,
  fetchImpl = fetch,
  officialDocumentFetchImpl = fetch,
  responsibilityQuery,
  responsibilitySummaryQuery,
  productRagRetrieve,
  salesStatusLookup,
  officialReferenceLookup,
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
  const officialDocumentTimeoutMs = Math.max(
    1_000,
    Number(env.DINGTALK_OFFICIAL_DOCUMENT_TIMEOUT_MS) || 8_000,
  );

  async function answerQuestion({ question, product, summary, sources, customerResponsibilitySummary = null, responsibilityCardEvidence = [], officialEvidence = [], materialEvidence = [], expertPlan = null, fallback }) {
    if (!apiKey) return fallback;
    const plannedSkills = new Set(Array.isArray(expertPlan?.skills) ? expertPlan.skills.map(text).filter(Boolean) : []);
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
                '所有保险专家 Skills 都必须使用完整语义包回答：保留用户原问题、已确认产品、上下文、官方证据、责任摘要、责任卡和已审核资料，综合输出“官方明确事实 + 基于证据的专业解读 + 不确定边界”。不得把问题降级成字段查找，也不得因为没有同名字段就忽略其他相关证据。',
                '专业解读必须从证据推导：可以把投保年龄、健康告知、保障范围、等待期、续保、免赔、报销比例、服务权益和已审核产品资料综合成客户能理解的场景说明；不能新增证据没有支持的产品事实。',
                '必须直接回答用户实际询问的维度；问优势时提炼3至5项有证据的客户价值、适合场景和必要限制，不能只重复保险责任。',
                '若用户问适合人群、适合谁、产品亮点、怎么样、注意事项等，不能因为资料没有“适用人群”标题就整段拒答。应先列官方明确事实（如投保年龄、等待期、续保、保障范围、责任限制），再基于已审核资料和官方事实给出“更适合关注哪些需求的人群/场景”的谨慎专业解读，并明确健康告知、职业、既往症、核保、预算和销售状态等仍需以投保时审核为准。',
                '比较同一产品的多个保障计划时，先用责任名称说明共同保障，再说明较高计划比下一计划具体多出的责任；不得只复述“第几款至第几款”、责任数量或条款编号。',
                '用户没有询问推荐或选择建议时，不得追加“适合谁”或购买建议；没有保费证据时不得推断某计划保费更高或更低。',
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
                expertPlan: expertPlan ? {
                  skills: Array.isArray(expertPlan.skills) ? expertPlan.skills : [],
                  evidenceGoals: Array.isArray(expertPlan.evidenceGoals) ? expertPlan.evidenceGoals : [],
                } : null,
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
      const answer = removeUnknownEvidenceReferences(payload?.choices?.[0]?.message?.content, validEvidenceIds);
      if (RESPONSIBILITY_QUESTION_PATTERN.test(text(question))) {
        const responsibilitySummary = customerResponsibilitySummary || summary;
        const titles = (Array.isArray(responsibilitySummary?.mainResponsibilities)
          ? responsibilitySummary.mainResponsibilities : [])
          .map((item) => text(item?.title)).filter(Boolean).slice(0, 12);
        if (titles.some((title) => !answer.includes(title))) return fallback;
      }
      return answer || fallback;
    } catch {
      return fallback;
    } finally {
      clearTimeout(timeout);
    }
  }

  function comparisonProfile(answer) {
    const value = text(answer);
    if (/医疗费用|住院医疗|门急诊|外购药|报销|免赔额/u.test(value)) return {
      type: '医疗费用补偿型保障',
      payment: '按符合约定的实际医疗费用、限额和比例报销',
      advantage: '覆盖就医费用场景，适合转移大额医疗支出风险',
      fit: '更关注住院、重疾治疗和院外药械费用的人群',
      limit: '需重点核对免赔额、赔付比例、医院范围、医保结算和续保条件',
    };
    if (/满期生存保险金|两全保险|生存至保险期间届满/u.test(value)) return {
      type: '两全保险定额给付保障',
      payment: '满足满期生存或身故条件后按合同约定金额给付',
      advantage: '同时安排满期生存与身故给付，并可与明确附加的疾病险组合',
      fit: '更关注长期定额保障、身故责任及满期安排的人群',
      limit: '不是医疗费用报销；具体金额依赖基本保额、已交保费、保险期间及附加险配置',
    };
    if (/重大疾病保险金|轻症疾病保险金|中症疾病保险金/u.test(value)) return {
      type: '疾病定额给付保障',
      payment: '达到合同约定疾病定义和触发条件后按基本保额或保费倍数给付',
      advantage: '确诊达到条件后提供定额资金支持，不以实际医疗费用为给付上限',
      fit: '更关注重大疾病发生后的收入损失和康复资金安排的人群',
      limit: '需核对疾病定义、等待期、给付次数、分组和责任终止条件',
    };
    return {
      type: '现有证据未能归入同一保障类型',
      payment: '以对应条款列明的给付方式为准',
      advantage: '应结合完整责任和限制逐项判断',
      fit: '现有资料无法确认',
      limit: '不能只按责任数量判断优劣',
    };
  }

  function deterministicComparison(compared, products = [], question = '') {
    const names = compared.map((item, index) => text(products[index]?.officialName || products[index]?.productName) || `产品${index + 1}`);
    const profiles = compared.map((item) => comparisonProfile(item.answer));
    const asksForRecommendation = /推荐|怎么选|选哪个|选哪款|哪个好|更适合|客户|配置/u.test(text(question));
    const mentionsHealth = /基础病|慢性病|既往症|健康异常|疾病|用药|住院|手术/u.test(text(question));
    const clientGuidance = asksForRecommendation ? [
      '',
      '## 做出推荐前还需要确认',
      '- 产品责任只能说明“保什么、怎么赔”，不能单独决定哪款更适合客户。还需确认客户的保障目标、预算、期望保障期限、已有保障和风险优先级。',
      '- 还需核验候选产品当前是否在售，以及客户是否符合投保年龄、职业和其他投保条件。',
      ...(mentionsHealth ? [
        '- 你提到了健康情况，请补充正式诊断、确诊时间、当前指标、用药、近年住院或手术及并发症；健康告知不完整时不能判断承保、除外、加费或拒保结果。',
      ] : []),
      '- 补齐上述信息后，才能给出“优先考虑、备选或不适合”的条件式建议；不能仅凭产品名称直接推荐购买。',
    ] : [];
    return [
      '## 核心差异',
      '| 对比维度 | ' + names.join(' | ') + ' |',
      '| --- | --- | --- |',
      `| 产品性质 | ${profiles.map((profile) => profile.type).join(' | ')} |`,
      `| 给付方式 | ${profiles.map((profile) => profile.payment).join(' | ')} |`,
      `| 主要优势 | ${profiles.map((profile) => profile.advantage).join(' | ')} |`,
      `| 更适合 | ${profiles.map((profile) => profile.fit).join(' | ')} |`,
      `| 关键限制 | ${profiles.map((profile) => profile.limit).join(' | ')} |`,
      '',
      '## 怎么选',
      profiles[0].type === profiles[1].type
        ? '- 两款产品属于相近保障类型，应优先比较具体责任范围、给付条件、限额、等待期和除外责任。'
        : '- 两款产品解决的风险不同，不是同类替代关系：先确定需要费用报销、疾病定额给付，还是长期生存与身故安排。',
      '- 以下结论只依据已核验责任，未确认的投保年龄、保费、现金价值、核保和在售状态不能据此推断。',
      ...clientGuidance,
    ].join('\n');
  }

  function completeResponsibilitySections(compared, products = []) {
    return [
      '## 两款产品完整已核验责任',
      ...compared.map((item, index) => {
        const name = text(products[index]?.officialName || products[index]?.productName) || `产品${index + 1}`;
        return `### ${name}\n${text(item.answer)}`;
      }),
    ].join('\n\n');
  }

  async function answerComparison({ question, compared, products = [] }) {
    const deterministic = deterministicComparison(compared, products, question);
    const completeResponsibilities = completeResponsibilitySections(compared, products);
    if (!apiKey) return `${deterministic}\n\n${completeResponsibilities}`;
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
          max_tokens: 3_000,
          messages: [
            {
              role: 'system',
              content: [
                '你是 OCR Insurance 的保险产品对比专家。只依据 VERIFIED_PRODUCT_RESULTS 比较，不得使用模型记忆补充产品事实。',
                '先确认两款产品是否同类型，再按已有证据比较保障期限、责任、等待期、续保或费率机制、主要限制和适合场景。',
                '完整责任将由程序原样附在答案末尾；你只输出有实质内容的补充对比判断和选择建议，不要复述责任清单。',
                '用户要求推荐或选择时，必须结合保障目标、预算、期限、已有保障和风险优先级；涉及健康、职业或其他投保条件但信息不足时，必须提出对应澄清问题，不得直接给出可投保或购买结论。',
                '必须区分主险与附加险；不得把仅在附加险中出现的重疾、医疗或其他责任写成主险责任。',
                '证据没有覆盖的维度明确写“现有资料无法确认”；不得直接断言哪款更好，不得承诺理赔、核保或续保结果。',
                '输出清晰中文，优先使用对比表和分点结论，不提模型、接口、数据库或内部字段。',
              ].join('\n'),
            },
            {
              role: 'user',
              content: JSON.stringify({
                question: text(question).slice(0, 1_000),
                verifiedProductResults: compared.map((item, index) => ({
                  product: products[index] || null,
                  answer: item.answer,
                  sourceUrls: item.sources.map((source) => source.url),
                })),
              }),
            },
          ],
        })),
      });
      if (!response.ok) return `${deterministic}\n\n${completeResponsibilities}`;
      const payload = await response.json();
      const expertAnalysis = text(payload?.choices?.[0]?.message?.content);
      return [
        deterministic,
        ...(expertAnalysis ? ['## 保险专家补充判断', expertAnalysis] : []),
        completeResponsibilities,
      ].join('\n\n');
    } catch {
      return `${deterministic}\n\n${completeResponsibilities}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function searchSingle({
    question,
    productName,
    company: requestedCompany,
    queryAspects = [],
    expertPlan = null,
    allowExternalReferences = false,
  } = {}) {
    const query = [text(requestedCompany), text(productName), text(question)].filter(Boolean).join(' ');
    const companies = listProductCatalogCompanies({ db, visibility: 'public' });
    const verifiedCompany = text(requestedCompany);
    const company = companies.some((item) => text(item.company) === verifiedCompany)
      ? verifiedCompany
      : companyFromQuery(query, companies, officialDomainProfiles);
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
          AND (
            json_extract(payload, '$.evidenceLevel') = 'insurer_official'
            OR (? = 1 AND (
              json_extract(payload, '$.referenceOnly') = 1
              OR json_extract(payload, '$.evidenceLevel') = 'external_reference'
            ))
          )
      `).all(requestedProductName, allowExternalReferences ? 1 : 0) : []),
    ].filter((product) => !company || text(product.company) === company)
      .map((product) => ({ ...product, score: 1_000 })) : [];
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
      const productKnowledgeRows = knowledgeStatement
        ? knowledgeStatement.all(product.company, product.productName)
        : [];
      const useExternalReferences = allowExternalReferences && productKnowledgeRows.some((row) => {
        try {
          const payload = JSON.parse(row.payload || '{}');
          return payload?.referenceOnly === true
            || ['external_reference', 'external_legacy_reference'].includes(text(payload?.evidenceLevel));
        } catch {
          return false;
        }
      });
      if (typeof responsibilityQuery === 'function') {
        try {
          const result = await responsibilityQuery({
            company: product.company,
            name: product.productName,
            ...(useExternalReferences ? {
              preferLocalKnowledgeAnswer: false,
              allowExternalReferences: true,
            } : {}),
          });
          const assistant = responsibilityAssistantEvidence(
            result,
            product,
            allowedOrigins,
            question,
            { allowExternalReferences: useExternalReferences },
          );
          if (assistant) {
            if (!assistant.referenceOnly
              && RESPONSIBILITY_QUESTION_PATTERN.test(text(question))
              && typeof responsibilitySummaryQuery === 'function') {
              try {
                const summaryResult = await responsibilitySummaryQuery({
                  company: product.company,
                  name: product.productName,
                });
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
    if (selected.referenceOnly === true) {
      return {
        answer: `${product.company}《${product.productName}》：\n${text(selected.directAnswer)}`,
        sources,
        referenceOnly: true,
        retrieval: {
          mode: 'external_reference_review',
          rounds: 1,
          queryCount: 1,
          completeness: 'unverified',
          missingEvidence: ['insurer_official_source'],
        },
      };
    }
    const responsibilityQuestion = RESPONSIBILITY_QUESTION_PATTERN.test(text(question));
    const canonicalProductId = text(product.canonicalProductId)
      || text(productIdentityStatement?.get(product.company, product.productName)?.canonical_product_id);
    const retrievalProduct = {
      canonicalProductId,
      company: product.company,
      officialName: product.productName,
    };
    const retrievalPlan = createProductRetrievalPlan({ question, product: retrievalProduct, queryAspects });
    const safeRetrievalPlan = validateProductRetrievalPlan(retrievalPlan, retrievalProduct)
      ? retrievalPlan
      : null;
    const materialRetrievals = [];
    let queryCount = 0;
    let retrievalRounds = 0;
    const retrieveMaterials = async (queries) => {
      if (!canonicalProductId || typeof productRagRetrieve !== 'function') return [];
      const boundedQueries = [...new Set((Array.isArray(queries) ? queries : []).map(text).filter(Boolean))].slice(0, 2);
      if (!boundedQueries.length) return [];
      queryCount += boundedQueries.length;
      const retrieved = await Promise.all(boundedQueries.map(async (retrievalQuery) => {
        try {
          return await productRagRetrieve({
            tenantId: 'default',
            query: retrievalQuery,
            canonicalProductId,
            sourceAuthorities: ['company_material', 'approved_company_material', 'expert_training'],
            products: [{ company: product.company, productName: product.productName }],
            tokenBudget: 3_000,
          });
        } catch {
          return null;
        }
      }));
      return retrieved.filter(Boolean);
    };
    const plannedSkills = new Set(Array.isArray(expertPlan?.skills) ? expertPlan.skills : []);
    const hasAgentPlan = plannedSkills.size > 0;
    const allowsMaterialRetrieval = !hasAgentPlan || plannedSkills.has('approved_material_retrieval');
    const allowsOfficialRetrieval = !hasAgentPlan || plannedSkills.has('official_terms_retrieval');
    const maxRetrievalRounds = hasAgentPlan
      ? Math.max(1, Math.min(2, Number(expertPlan?.maxRetrievalRounds) || 1))
      : 2;
    if (safeRetrievalPlan && allowsMaterialRetrieval) {
      retrievalRounds = 1;
      materialRetrievals.push(...await retrieveMaterials(safeRetrievalPlan.queries));
    }
    let material = mergedApprovedMaterialEvidence(materialRetrievals);
    const fallback = answerFromSummary(summary);
    const customerResponsibilityFallback = customerResponsibilitySummary
      ? answerFromCustomerResponsibilitySummary(customerResponsibilitySummary)
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
    let completeness = assessProductEvidenceCompleteness({
      queryAspects,
      expertPlan,
      customerResponsibilitySummary,
      officialEvidence,
      materialEvidence: material.evidence,
      verifiedSources: [...sources, ...officialSources, ...material.sources],
      retrievalRound: 1,
    });
    const needsOfficialSupplement = allowsOfficialRetrieval && knowledgeStatement && (hasAgentPlan
      ? plannedSkills.has('official_terms_retrieval')
      : questionNeedsOfficialDocument(question, officialSummary)
        || completeness.missingEvidence.includes('complete_responsibility_summary')
        || completeness.missingEvidence.some((item) => item.startsWith('official_')));
    const needsMaterialSupplement = allowsMaterialRetrieval && completeness.shouldRetry
      && safeRetrievalPlan?.supplementalQuery
      && !safeRetrievalPlan.queries.includes(safeRetrievalPlan.supplementalQuery);
    const requireCompleteResponsibilities = plannedSkills.has('responsibility_detail')
      || plannedSkills.has('plan_comparison')
      || completeness.missingEvidence.includes('complete_responsibility_summary');
    if (maxRetrievalRounds >= 2 && (needsOfficialSupplement || needsMaterialSupplement)) {
      retrievalRounds = Math.max(2, retrievalRounds);
      const [persistedDocument, referenceResult, supplementalMaterials] = await Promise.all([
        needsOfficialSupplement
          ? officialEvidenceFromFullDocuments({
            rows: knowledgeStatement.all(product.company, product.productName),
            product,
            question: safeRetrievalPlan?.standaloneQuestion || question,
            materialEvidence: material.evidence,
            fetchImpl: officialDocumentFetchImpl,
            timeoutMs: officialDocumentTimeoutMs,
            requireCompleteResponsibilities,
          })
          : Promise.resolve({ evidence: [], sources: [] }),
        needsOfficialSupplement && typeof officialReferenceLookup === 'function'
          ? Promise.resolve(officialReferenceLookup({
            company: product.company,
            productName: productLookupName(product),
            question: safeRetrievalPlan?.standaloneQuestion || question,
          })).catch(() => ({ records: [] }))
          : Promise.resolve({ records: [] }),
        needsMaterialSupplement
          ? retrieveMaterials([safeRetrievalPlan.supplementalQuery])
          : Promise.resolve([]),
      ]);
      const discoveredDocument = officialEvidenceFromReferenceRecords({
        records: referenceResult?.records,
        product,
        question: safeRetrievalPlan?.standaloneQuestion || question,
        materialEvidence: material.evidence,
        requireCompleteResponsibilities,
      });
      const fullDocument = persistedDocument.evidence.length ? persistedDocument : discoveredDocument;
      materialRetrievals.push(...supplementalMaterials);
      material = mergedApprovedMaterialEvidence(materialRetrievals);
      if (fullDocument.evidence.length) {
        officialEvidence = fullDocument.evidence;
        officialSources = fullDocument.sources;
        answerFallback = fullDocument.evidence.map((item) => item.content).join('\n');
        for (const source of fullDocument.sources) {
          const origin = new URL(source.url).origin;
          if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin);
        }
      } else if (supplementalMaterials.length) {
        officialEvidence = officialEvidenceFromSummary({
          summary: officialSummary,
          sources: officialSources,
          product,
          question,
          materialEvidence: material.evidence,
        });
      }
      completeness = assessProductEvidenceCompleteness({
        queryAspects,
        expertPlan,
        customerResponsibilitySummary,
        officialEvidence,
        materialEvidence: material.evidence,
        verifiedSources: [...sources, ...officialSources, ...material.sources],
        retrievalRound: 2,
      });
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
      expertPlan,
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
      retrieval: {
        mode: 'bounded_agentic_retrieval',
        rounds: retrievalRounds,
        queryCount,
        completeness: completeness.status,
        missingEvidence: completeness.missingEvidence,
      },
    };
  }

  async function compare({ question, results, products = [] } = {}) {
    const compared = Array.isArray(results) ? results.slice(0, 2) : [];
    if (compared.length !== 2
      || compared.some((result) => !text(result?.answer)
        || !Array.isArray(result?.sources) || !result.sources.length)) return '';
    return answerComparison({ question, compared, products });
  }

  async function search({ question, productName, company, product, queryAspects = [], expertPlan = null } = {}) {
    const resolvedProductName = text(product?.officialName);
    if (resolvedProductName) {
      return searchSingle({
        question,
        productName: resolvedProductName,
        company: text(product?.company),
        queryAspects,
        expertPlan,
        allowExternalReferences: true,
      });
    }
    if (text(productName)) return searchSingle({ question, productName, company, queryAspects, expertPlan });
    const productQueries = comparisonProductQueries(question);
    if (productQueries.length !== 2) return searchSingle({ question, productName, queryAspects, expertPlan });
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
      answer: await answerComparison({
        question,
        compared,
        products: productQueries.map((officialName) => ({ officialName })),
      }),
      sources,
    };
  }

  return { search, compare, allowedOrigins };
}
