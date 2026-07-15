const REQUIRED_COLUMNS = new Set([
  'company', 'product_name', 'status', 'headline', 'summary_json', 'source_urls_json',
]);
const MAX_JSON_CHARS = 256_000;
const MAX_RESPONSIBILITIES = 12;
const MAX_SOURCES = 20;
const MAX_ANSWER_CHARS = 48_000;

function clean(value, limit = 500) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && normalized.length <= limit ? normalized : '';
}

function boundedText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function normalizeOfficialTerms(value) {
  return boundedText(value, 6_000)
    .replace(/\s+/gu, ' ')
    .replace(/2\.3\.\s*1\s*轻症\s*疾病保险金/gu, '\n1. 轻症疾病保险金\n')
    .replace(/2\.3\.\s*2\s*重大\s*疾病保险金/gu, '\n2. 重大疾病保险金\n')
    .replace(/\s*([，。；：（）])\s*/gu, '$1')
    .replace(/(?<=[\p{Script=Han}\d])\s+(?=[\p{Script=Han}\d%])/gu, '')
    .trim();
}

function comparable(value) {
  return clean(value, 500).normalize('NFKC').toLowerCase()
    .replace(/[\s《》（）()【】\[\]·,，。:：;；、-]+/gu, '');
}

function tableColumns(db) {
  try {
    return new Set(db.prepare('PRAGMA table_info(product_customer_responsibility_summaries)')
      .all().map((row) => clean(row.name, 100)));
  } catch {
    return new Set();
  }
}

function parseSummary(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_JSON_CHARS) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || typeof parsed.headline !== 'string'
      || !Array.isArray(parsed.mainResponsibilities)
      || (parsed.sourceUrls !== undefined && (!Array.isArray(parsed.sourceUrls)
        || parsed.sourceUrls.some((url) => typeof url !== 'string')))) return null;
    for (const item of parsed.mainResponsibilities) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      for (const field of ['title', 'plainText', 'howItPays', 'triggerCondition']) {
        if (item[field] !== undefined && typeof item[field] !== 'string') return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseStringArray(value) {
  if (typeof value !== 'string' || value.length > MAX_JSON_CHARS) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? parsed.map((item) => clean(item, 2_048)).filter(Boolean)
      : null;
  } catch {
    return null;
  }
}

function profileAliases(profile) {
  return [
    profile?.company,
    ...(Array.isArray(profile?.aliases) ? profile.aliases : []),
    ...(Array.isArray(profile?.companyAliases) ? profile.companyAliases : []),
  ].map(comparable).filter((alias) => alias.length >= 2);
}

function normalizedProfiles(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((profile) => profile && typeof profile === 'object' && !Array.isArray(profile))
    .map((profile) => ({
      company: clean(profile.company, 200),
      aliases: Array.isArray(profile.aliases)
        ? profile.aliases.map((item) => clean(item, 200)).filter(Boolean) : [],
      companyAliases: Array.isArray(profile.companyAliases)
        ? profile.companyAliases.map((item) => clean(item, 200)).filter(Boolean) : [],
      officialDomains: Array.isArray(profile.officialDomains)
        ? profile.officialDomains.map((item) => clean(item, 253)).filter(Boolean) : [],
      siteDomains: Array.isArray(profile.siteDomains)
        ? profile.siteDomains.map((item) => clean(item, 253)).filter(Boolean) : [],
    })).filter((profile) => profile.company || profile.aliases.length || profile.companyAliases.length);
}

function profileForCompany(company, profiles) {
  const target = comparable(company);
  if (!target) return null;
  return (Array.isArray(profiles) ? profiles : [])
    .map((profile) => ({ profile, score: Math.max(0, ...profileAliases(profile)
      .filter((alias) => target === alias || target.includes(alias) || alias.includes(target))
      .map((alias) => alias.length)) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.profile || null;
}

function officialSource(urlValue, profile) {
  const value = clean(urlValue, 2_048);
  if (!value || !profile) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    const host = url.hostname.toLowerCase().replace(/\.$/u, '');
    const domains = [
      ...(Array.isArray(profile.officialDomains) ? profile.officialDomains : []),
      ...(Array.isArray(profile.siteDomains) ? profile.siteDomains : []),
    ].map((domain) => clean(domain, 253).toLowerCase().replace(/^https?:\/\//u, '').split('/')[0])
      .filter(Boolean);
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
      ? url.toString()
      : '';
  } catch {
    return '';
  }
}

function responsibilityBlock(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const title = clean(value.title, 160);
  const details = [
    boundedText(value.plainText, 1_200),
    value.triggerCondition ? `触发条件：${boundedText(value.triggerCondition, 800)}` : '',
    boundedText(value.howItPays, 800),
    value.calculationStatus ? `calculationStatus: ${clean(value.calculationStatus, 100)}` : '',
    Array.isArray(value.sourceRefs)
      ? `来源：${value.sourceRefs.map((item) => clean(item, 200)).filter(Boolean).slice(0, 20).join('、')}` : '',
    Array.isArray(value.requiredPolicyFields)
      ? `计算所需保单信息：${value.requiredPolicyFields.map((item) => clean(item, 200)).filter(Boolean).slice(0, 20).join('、')}` : '',
  ].filter((item, detailIndex, items) => item && items.indexOf(item) === detailIndex);
  if (!title && !details.length) return '';
  return [`${index + 1}. **${title || '保险责任'}**`, ...details].join('\n');
}

function linkedProductNames(summary) {
  const content = JSON.stringify(summary || {});
  return [...new Set(content.match(/附加[\p{Script=Han}A-Za-z0-9（）()·]{2,80}?保险/gu) || [])].slice(0, 4);
}

function answerFromSummary(summary, rowHeadline, queryAspects, associatedProducts = []) {
  const headline = clean(summary.headline, 300) || clean(rowHeadline, 300);
  const wantsResponsibilities = Array.isArray(queryAspects)
    && (queryAspects.includes('main_responsibilities')
      || queryAspects.includes('sales_guidance'));
  const responsibilities = wantsResponsibilities && Array.isArray(summary.mainResponsibilities)
    ? summary.mainResponsibilities.slice(0, MAX_RESPONSIBILITIES).map(responsibilityBlock).filter(Boolean)
    : [];
  const blocks = wantsResponsibilities && Array.isArray(summary.contentBlocks)
    ? summary.contentBlocks
      .filter((block) => block && typeof block === 'object' && !Array.isArray(block)
        && block.enabled !== false && (clean(block.title, 200) || boundedText(block.content, 4_000)))
      .sort((left, right) => Number(left?.order || 0) - Number(right?.order || 0))
      .flatMap((block) => {
        const sourceRefs = Array.isArray(block.sourceRefs)
          ? block.sourceRefs.map((item) => clean(item, 200)).filter(Boolean).slice(0, 20) : [];
        return [
          clean(block.title, 200) ? `### ${clean(block.title, 200)}` : '',
          boundedText(block.content, 4_000),
          sourceRefs.length ? `来源：${sourceRefs.join('、')}` : '',
        ].filter(Boolean);
      })
    : [];
  const notices = wantsResponsibilities && Array.isArray(summary.notices)
    ? summary.notices.slice(0, 12)
      .map((notice) => boundedText(notice, 800))
      .filter((notice) => notice
        && !/路由分类|来源未提及，视为无/u.test(notice)
        && !(associatedProducts.length && /附加.*(?:需另看|需另行核对)|是否包含重疾保险金/u.test(notice)))
    : [];
  const associated = associatedProducts.flatMap((product) => [
    '### 关联附加险责任（不属于两全主险责任）',
    `**${product.productName}**`,
    product.pageText,
  ]);
  const requiredPolicyFields = Array.isArray(summary.requiredPolicyFields)
    ? summary.requiredPolicyFields.map((item) => clean(item, 200)).filter(Boolean).slice(0, 20) : [];
  const materialSources = Array.isArray(summary.materialSources)
    ? summary.materialSources.slice(0, 20).flatMap((source) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
      const evidenceId = clean(source.evidenceId, 200);
      const fileName = clean(source.fileName, 500) || '已审核上传资料';
      const pageStart = Number(source.pageStart || 0);
      const pageEnd = Number(source.pageEnd || pageStart || 0);
      const pages = pageStart ? `（第${pageStart}${pageEnd && pageEnd !== pageStart ? `-${pageEnd}` : ''}页）` : '';
      return evidenceId ? [`- ${evidenceId}：${fileName}${pages}`] : [];
    }) : [];
  return [
    ...(blocks.length ? blocks : [headline]),
    ...(responsibilities.length ? [`### 责任明细（${responsibilities.length}项）`, ...responsibilities] : []),
    ...(requiredPolicyFields.length ? ['### 计算金额需要这些保单信息', requiredPolicyFields.join('、')] : []),
    ...(notices.length ? ['### 注意事项', ...notices.map((notice, index) => `${index + 1}. ${notice}`)] : []),
    ...(materialSources.length ? ['### 上传资料来源', ...materialSources] : []),
    ...associated,
  ].filter(Boolean).join('\n').slice(0, MAX_ANSWER_CHARS);
}

export function createAgentProductKnowledgeService({
  db,
  officialDomainProfiles = [],
  loadOfficialDomainProfiles,
} = {}) {
  if (!db) throw new TypeError('db is required');
  const columns = tableColumns(db);
  const ready = [...REQUIRED_COLUMNS].every((column) => columns.has(column));
  const staticProfiles = normalizedProfiles(officialDomainProfiles);
  const hasKnowledgeTable = Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_records' LIMIT 1
  `).get());
  const linkedKnowledgeStatement = hasKnowledgeTable ? db.prepare(`
    SELECT company, product_name, url, payload
    FROM knowledge_records
    WHERE instr(product_name, ?) > 0
      AND json_valid(payload) = 1
      AND json_extract(payload, '$.evidenceLevel') = 'insurer_official'
    ORDER BY id
    LIMIT 20
  `) : null;

  return {
    async search({ scope, product, queryAspects = [] } = {}) {
      if (!ready || scope !== 'public_read_only'
        || !product || typeof product !== 'object' || Array.isArray(product)
        || !Array.isArray(queryAspects)) {
        return { answer: '', sources: [] };
      }
      const company = clean(product.company, 200);
      const officialName = clean(product.officialName, 200);
      if (!company || !officialName) return { answer: '', sources: [] };

      let profiles = staticProfiles;
      if (typeof loadOfficialDomainProfiles === 'function') {
        try {
          profiles = normalizedProfiles(await loadOfficialDomainProfiles());
        } catch {
          return { answer: '', sources: [] };
        }
      }

      let row;
      try {
        row = db.prepare(`
          SELECT headline, summary_json, source_urls_json
          FROM product_customer_responsibility_summaries
          WHERE company = ? AND product_name = ? AND status = 'ready'
          ORDER BY rowid DESC
          LIMIT 1
        `).get(company, officialName);
      } catch {
        return { answer: '', sources: [] };
      }
      if (!row) return { answer: '', sources: [] };
      const summary = parseSummary(row.summary_json);
      const storedSourceUrls = parseStringArray(row.source_urls_json);
      if (!summary || !storedSourceUrls) return { answer: '', sources: [] };
      if (!queryAspects.length
        || queryAspects.some((aspect) => !['main_responsibilities', 'sales_guidance'].includes(aspect))) {
        return { answer: '', sources: [] };
      }

      const headline = clean(summary.headline, 300) || clean(row.headline, 300) || officialName;
      const profile = profileForCompany(company, profiles);
      const urls = [
        ...storedSourceUrls,
        ...(Array.isArray(summary.sourceUrls) ? summary.sourceUrls : []),
      ];
      const sources = [...new Set(urls.map((url) => officialSource(url, profile)).filter(Boolean))]
        .slice(0, MAX_SOURCES)
        .map((url) => ({
          verified: true,
          title: headline,
          url,
          provenance: 'verified_product_summary',
        }));
      const associatedProducts = [];
      if (linkedKnowledgeStatement && profile) {
        for (const linkedName of linkedProductNames(summary)) {
          const linkedIdentity = comparable(linkedName);
          const match = linkedKnowledgeStatement.all(linkedName).find((candidate) => {
            const candidateProfile = profileForCompany(candidate.company, profiles);
            return candidateProfile?.company === profile.company
              && comparable(candidate.product_name).endsWith(linkedIdentity);
          });
          if (!match) continue;
          let payload;
          try { payload = JSON.parse(match.payload); } catch { payload = null; }
          const pageText = normalizeOfficialTerms(payload?.pageText);
          const sourceUrl = officialSource(match.url, profile);
          if (!pageText || !sourceUrl) continue;
          associatedProducts.push({ productName: clean(match.product_name, 300), pageText });
          if (!sources.some((source) => source.url === sourceUrl)) {
            sources.push({
              verified: true,
              title: clean(payload?.title, 300) || clean(match.product_name, 300),
              url: sourceUrl,
              provenance: 'linked_official_terms',
            });
          }
        }
      }
      return {
        answer: answerFromSummary(summary, row.headline, queryAspects, associatedProducts),
        sources: sources.slice(0, MAX_SOURCES),
      };
    },
  };
}
