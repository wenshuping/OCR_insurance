const REQUIRED_COLUMNS = new Set([
  'company', 'product_name', 'status', 'headline', 'summary_json', 'source_urls_json',
]);
const MAX_JSON_CHARS = 256_000;
const MAX_RESPONSIBILITIES = 12;
const MAX_SOURCES = 20;
const MAX_ANSWER_CHARS = 4_000;

function clean(value, limit = 500) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && normalized.length <= limit ? normalized : '';
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

function responsibilityLine(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const title = clean(value.title, 160);
  const detail = clean(value.plainText || value.howItPays || value.triggerCondition, 500);
  if (!title && !detail) return '';
  return title && detail ? `- ${title}：${detail}` : `- ${title || detail}`;
}

function answerFromSummary(summary, rowHeadline, queryAspects) {
  const headline = clean(summary.headline, 300) || clean(rowHeadline, 300);
  const wantsResponsibilities = !Array.isArray(queryAspects)
    || queryAspects.length === 0
    || queryAspects.includes('main_responsibilities');
  const lines = wantsResponsibilities && Array.isArray(summary.mainResponsibilities)
    ? summary.mainResponsibilities.slice(0, MAX_RESPONSIBILITIES).map(responsibilityLine).filter(Boolean)
    : [];
  return [headline, ...lines].filter(Boolean).join('\n').slice(0, MAX_ANSWER_CHARS);
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
      if (queryAspects.some((aspect) => aspect !== 'main_responsibilities')) {
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
      return {
        answer: answerFromSummary(summary, row.headline, queryAspects),
        sources,
      };
    },
  };
}
