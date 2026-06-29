import crypto from 'node:crypto';

export const CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION = 'customer-summary-v1';

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_TIMEOUT_MS = 45_000;
const INTERNAL_FIELD_NAMES = new Set([
  'calculationKey',
  'claim_contingent',
  'needs_table',
  'indicatorCheckStatus',
  'indicatorCheckIssues',
  'cashflowTreatment',
  'calculationStatus',
]);

function text(value) {
  return String(value ?? '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function excerpt(value, limit) {
  const normalized = text(value).replace(/\s+/gu, ' ');
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of normalizeArray(values)) {
    const item = text(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function productKeyFor(company, productName) {
  const resolvedCompany = text(company);
  const resolvedProductName = text(productName);
  if (!resolvedCompany || !resolvedProductName) return '';
  return `company_product:${resolvedCompany}:${resolvedProductName}`;
}

function comparableProductName(value) {
  return text(value).replace(/[\s《》（）()【】\[\]·,，。:：;；、-]/gu, '');
}

function productNameMatchesQuery(candidate, query) {
  const normalizedCandidate = comparableProductName(candidate);
  const normalizedQuery = comparableProductName(query);
  if (!normalizedCandidate || !normalizedQuery) return false;
  return normalizedCandidate === normalizedQuery
    || normalizedCandidate.includes(normalizedQuery)
    || normalizedQuery.includes(normalizedCandidate);
}

function sourceUrlFrom(row = {}) {
  return text(row.sourceUrl || row.officialUrl || row.url || row.source_url || row.fileUrl);
}

function productNameFrom(row = {}) {
  return text(row.productName || row.product_name || row.name || row.title);
}

function companyFrom(row = {}) {
  return text(row.company || row.companyName || row.company_name);
}

function normalizeCardRow(row = {}) {
  const payload = parseJson(row.payload, row);
  return {
    ...payload,
    id: text(payload.id || row.id),
    productKey: text(payload.productKey || payload.product_key || row.product_key),
    company: text(payload.company || row.company),
    productName: text(payload.productName || payload.product_name || row.product_name),
    title: text(payload.title || row.title),
    category: text(payload.category || row.category),
    plainSummary: text(payload.plainSummary || payload.plain_summary),
    payoutSummary: text(payload.payoutSummary || payload.payout_summary),
    sourceUrl: text(payload.sourceUrl || payload.source_url || row.source_url),
    sourceTitle: text(payload.sourceTitle || payload.source_title),
    sourceExcerpt: text(payload.sourceExcerpt || payload.source_excerpt),
    indicators: normalizeArray(payload.indicators),
  };
}

function productMatches(row, { company, productName, productKey }) {
  if (productKey && text(row.productKey) === productKey) return true;
  return companyFrom(row) === company && productNameMatchesQuery(productNameFrom(row), productName);
}

function loadProductResponsibilityCards(db, { company, productName, productKey }) {
  if (!db || typeof db.prepare !== 'function') return [];
  try {
    const rows = db.prepare(`
      SELECT *
      FROM product_responsibility_cards
      WHERE product_key = ?
         OR (
           company = ?
           AND (
             product_name = ?
             OR product_name LIKE ?
             OR ? LIKE '%' || product_name || '%'
           )
         )
      ORDER BY title ASC, id ASC
    `).all(productKey, company, productName, `%${productName}%`, productName);
    return normalizeArray(rows)
      .map((row) => normalizeCardRow(row))
      .filter((row) => productMatches(row, { company, productName, productKey }));
  } catch {
    return [];
  }
}

function recordProductMatches(row, { company, productName }) {
  if (companyFrom(row) !== company) return false;
  return productNameMatchesQuery(productNameFrom(row), productName);
}

function sourceRecordsForProduct(records, product) {
  return normalizeArray(records)
    .filter((record) => recordProductMatches(record, product))
    .filter((record) => sourceUrlFrom(record) || text(record.pageText || record.text || record.content || record.sourceExcerpt))
    .slice(0, 6);
}

function indicatorsForProduct(records, product) {
  return normalizeArray(records)
    .filter((record) => recordProductMatches(record, product))
    .slice(0, 24);
}

function preferredProductNameFromSources({ inputProductName, cards = [], records = [], indicators = [] } = {}) {
  const counts = new Map();
  const add = (value, weight) => {
    const name = text(value);
    if (!name || !productNameMatchesQuery(name, inputProductName)) return;
    counts.set(name, (counts.get(name) || 0) + weight);
  };
  for (const card of normalizeArray(cards)) add(productNameFrom(card), 4);
  for (const record of normalizeArray(records)) add(productNameFrom(record), 3);
  for (const indicator of normalizeArray(indicators)) add(productNameFrom(indicator), 2);
  const ranked = [...counts.entries()]
    .sort((left, right) =>
      right[1] - left[1]
      || comparableProductName(right[0]).length - comparableProductName(left[0]).length
      || left[0].localeCompare(right[0], 'zh-CN'),
    );
  return ranked[0]?.[0] || text(inputProductName);
}

function digestCard(card = {}) {
  return {
    title: text(card.title),
    sourceExcerpt: excerpt(card.sourceExcerpt, 800),
    sourceUrl: sourceUrlFrom(card),
    payoutSummary: text(card.payoutSummary),
  };
}

function digestIndicator(indicator = {}) {
  return {
    liability: text(indicator.liability || indicator.title || indicator.name),
    formulaText: text(indicator.formulaText || indicator.formula || indicator.calcText),
    basis: text(indicator.basis || indicator.basisText),
    sourceUrl: sourceUrlFrom(indicator),
  };
}

function digestRecord(record = {}) {
  return {
    title: text(record.title || record.productName || record.name),
    url: sourceUrlFrom(record),
    pageText: excerpt(record.pageText || record.text || record.content || record.sourceExcerpt, 1000),
  };
}

export function buildCustomerResponsibilitySourceDigest({ cards = [], indicators = [], records = [] } = {}) {
  const payload = {
    cards: normalizeArray(cards).map(digestCard),
    indicators: normalizeArray(indicators).map(digestIndicator),
    records: normalizeArray(records).map(digestRecord),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function assertNoInternalFields(value, path = 'summary') {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (INTERNAL_FIELD_NAMES.has(key)) {
      const error = new Error(`客户摘要包含内部字段: ${path}.${key}`);
      error.code = 'CUSTOMER_SUMMARY_INTERNAL_FIELD';
      error.status = 422;
      throw error;
    }
    if (nested && typeof nested === 'object') assertNoInternalFields(nested, `${path}.${key}`);
  }
}

function requiredFieldError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.status = 422;
  return error;
}

export function validateCustomerResponsibilitySummaryJson(
  summary,
  { allowedTitles = new Set(), allowedSourceUrls = new Set() } = {},
) {
  assertNoInternalFields(summary);
  const normalized = {
    company: text(summary?.company),
    productName: text(summary?.productName),
    headline: text(summary?.headline),
    mainResponsibilities: normalizeArray(summary?.mainResponsibilities).map((item) => ({
      title: text(item?.title),
      plainText: text(item?.plainText),
      howItPays: text(item?.howItPays),
      requiredPolicyFields: uniqueStrings(item?.requiredPolicyFields),
    })),
    notices: uniqueStrings(summary?.notices),
    requiredPolicyFields: uniqueStrings(summary?.requiredPolicyFields),
    sourceUrls: uniqueStrings(summary?.sourceUrls),
  };

  if (!normalized.company || !normalized.productName || !normalized.headline) {
    throw requiredFieldError('客户摘要缺少公司、产品名称或一句话摘要', 'CUSTOMER_SUMMARY_REQUIRED_FIELDS');
  }
  if (!normalized.mainResponsibilities.length) {
    throw requiredFieldError('客户摘要缺少主要责任', 'CUSTOMER_SUMMARY_EMPTY_RESPONSIBILITIES');
  }
  for (const item of normalized.mainResponsibilities) {
    if (!item.title || !item.plainText) {
      throw requiredFieldError('客户摘要责任条目缺少标题或说明', 'CUSTOMER_SUMMARY_RESPONSIBILITY_FIELDS');
    }
    if (allowedTitles.size && !allowedTitles.has(item.title)) {
      throw requiredFieldError(`客户摘要责任缺少来源支持: ${item.title}`, 'CUSTOMER_SUMMARY_UNSUPPORTED_TITLE');
    }
  }
  for (const url of normalized.sourceUrls) {
    if (allowedSourceUrls.size && !allowedSourceUrls.has(url)) {
      throw requiredFieldError(`客户摘要来源链接缺少来源支持: ${url}`, 'CUSTOMER_SUMMARY_UNSUPPORTED_SOURCE');
    }
  }
  return normalized;
}

function cardPromptItem(card = {}) {
  return {
    title: text(card.title),
    category: text(card.category),
    plainSummary: text(card.plainSummary),
    payoutSummary: text(card.payoutSummary),
    sourceUrl: sourceUrlFrom(card),
    sourceTitle: text(card.sourceTitle),
    sourceExcerpt: excerpt(card.sourceExcerpt, 800),
  };
}

function indicatorPromptItem(indicator = {}) {
  return {
    liability: text(indicator.liability || indicator.title || indicator.name),
    formulaText: text(indicator.formulaText || indicator.formula || indicator.calcText),
    basis: text(indicator.basis || indicator.basisText),
    calculationHint: text(indicator.calculationReason || indicator.condition || indicator.triggerCondition),
    sourceUrl: sourceUrlFrom(indicator),
  };
}

function recordPromptItem(record = {}) {
  return {
    title: text(record.title || record.productName || record.name),
    url: sourceUrlFrom(record),
    excerpt: excerpt(record.pageText || record.text || record.content || record.sourceExcerpt, 1000),
  };
}

function buildDeepSeekPrompt({ company, productName, cards, indicators, records }) {
  const context = {
    product: { company, productName },
    responsibilityCards: normalizeArray(cards).map(cardPromptItem),
    indicators: normalizeArray(indicators).map(indicatorPromptItem),
    officialSources: normalizeArray(records).map(recordPromptItem),
  };
  return [
    '请根据给定资料生成客户可读的保险责任摘要。',
    '只输出 JSON，不要输出 Markdown，不要解释。',
    '写给保险客户，不写给内部审核人员。',
    '不要出现 calculationKey、claim_contingent、needs_table、indicatorCheckStatus、indicatorCheckIssues、cashflowTreatment、calculationStatus 等内部字段名。',
    '不要编造资料中没有的保险责任、免责事项或给付方式。',
    '无法在缺少保单信息时算出精确金额的责任，请列出 requiredPolicyFields。',
    'JSON 字段必须是 company、productName、headline、mainResponsibilities、notices、requiredPolicyFields、sourceUrls。',
    JSON.stringify(context, null, 2),
  ].join('\n');
}

function resolveDeepSeekConfig(env = process.env) {
  const timeoutCandidate = Number(env.DEEPSEEK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return {
    apiKey: text(env.DEEPSEEK_API_KEY),
    baseUrl: text(env.DEEPSEEK_BASE_URL) || DEFAULT_DEEPSEEK_BASE_URL,
    model: text(env.DEEPSEEK_MODEL) || DEFAULT_MODEL,
    timeoutMs: Number.isFinite(timeoutCandidate) ? Math.max(1000, timeoutCandidate) : DEFAULT_TIMEOUT_MS,
  };
}

function deepSeekTransportError(error) {
  if (error?.code && error?.status) return error;
  const timedOut = error?.name === 'AbortError';
  const next = new Error(timedOut ? 'DeepSeek request timed out' : 'DeepSeek request failed');
  next.code = timedOut ? 'DEEPSEEK_REQUEST_TIMEOUT' : 'DEEPSEEK_REQUEST_FAILED';
  next.status = 502;
  next.cause = error;
  return next;
}

export async function callDeepSeekForCustomerResponsibilitySummary({
  prompt,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const config = resolveDeepSeekConfig(env);
  if (!config.apiKey) {
    const error = new Error('DeepSeek API key is not configured');
    error.code = 'DEEPSEEK_API_KEY_MISSING';
    error.status = 503;
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(new URL('/chat/completions', config.baseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: '你是保险责任摘要助手，只输出合法 JSON。' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' },
        }),
      });
    } catch (error) {
      throw deepSeekTransportError(error);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error?.message || `DeepSeek request failed: ${response.status}`);
      error.code = 'DEEPSEEK_REQUEST_FAILED';
      error.status = 502;
      throw error;
    }
    return parseJson(text(payload?.choices?.[0]?.message?.content), null);
  } finally {
    clearTimeout(timer);
  }
}

function safeCustomerSummary(row = {}) {
  const summary = row.summaryJson || row.summary_json || row;
  return {
    company: text(summary.company),
    productName: text(summary.productName),
    headline: text(summary.headline),
    mainResponsibilities: normalizeArray(summary.mainResponsibilities).map((item) => ({
      title: text(item?.title),
      plainText: text(item?.plainText),
      howItPays: text(item?.howItPays),
      requiredPolicyFields: uniqueStrings(item?.requiredPolicyFields),
    })),
    notices: uniqueStrings(summary.notices),
    requiredPolicyFields: uniqueStrings(summary.requiredPolicyFields),
    sourceUrls: uniqueStrings(summary.sourceUrls),
  };
}

function sourceUrlSet({ cards, records, indicators }) {
  return new Set([
    ...normalizeArray(cards).map(sourceUrlFrom),
    ...normalizeArray(records).map(sourceUrlFrom),
    ...normalizeArray(indicators).map(sourceUrlFrom),
  ].filter(Boolean));
}

function titleSet(cards, indicators) {
  return new Set([
    ...normalizeArray(cards).map((card) => text(card.title)),
    ...normalizeArray(indicators).map((indicator) => text(indicator.liability || indicator.title || indicator.name)),
  ].filter(Boolean));
}

function buildSummaryContext({ productKey, company, productName, cards, indicators, records }) {
  return {
    productKey,
    product: { company, productName },
    cards: normalizeArray(cards).map(cardPromptItem),
    indicators: normalizeArray(indicators).map(indicatorPromptItem),
    officialSources: normalizeArray(records).map(recordPromptItem),
  };
}

export async function generateProductCustomerResponsibilitySummary({
  state = {},
  db,
  input = {},
  findSummary,
  persistSummary,
  generateWithDeepSeek = callDeepSeekForCustomerResponsibilitySummary,
  modelName = resolveDeepSeekConfig().model,
  nowIso = () => new Date().toISOString(),
} = {}) {
  const company = text(input.company).slice(0, 80);
  const inputProductName = text(input.name || input.productName).slice(0, 160);
  if (!company || !inputProductName) {
    const error = new Error('请输入保险公司和保险名称');
    error.code = 'POLICY_RESPONSIBILITY_QUERY_INPUT_REQUIRED';
    error.status = 400;
    throw error;
  }

  const inputProductKey = productKeyFor(company, inputProductName);
  const inputProduct = { company, productName: inputProductName, productKey: inputProductKey };
  let cards = loadProductResponsibilityCards(db, inputProduct);
  let records = sourceRecordsForProduct(state.knowledgeRecords, inputProduct);
  let indicators = indicatorsForProduct(state.insuranceIndicatorRecords, inputProduct);
  if (!cards.length && !records.length) {
    return {
      ok: false,
      status: 'needs_source_review',
      message: '这个产品还缺少可用于客户摘要的保险责任来源。',
    };
  }

  const productName = preferredProductNameFromSources({ inputProductName, cards, records, indicators });
  const productKey = productKeyFor(company, productName);
  if (productName !== inputProductName) {
    const resolvedProduct = { company, productName, productKey };
    const resolvedCards = loadProductResponsibilityCards(db, resolvedProduct);
    const resolvedRecords = sourceRecordsForProduct(state.knowledgeRecords, resolvedProduct);
    const resolvedIndicators = indicatorsForProduct(state.insuranceIndicatorRecords, resolvedProduct);
    if (resolvedCards.length || resolvedRecords.length) {
      cards = resolvedCards;
      records = resolvedRecords;
      indicators = resolvedIndicators;
    }
  }
  const sourceDigest = buildCustomerResponsibilitySourceDigest({ cards, indicators, records });
  const existing = typeof findSummary === 'function'
    ? await findSummary({
      productKey,
      summaryVersion: CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION,
      sourceDigest,
    })
    : null;
  if (existing) {
    return {
      ok: true,
      source: 'database',
      summary: safeCustomerSummary(existing),
    };
  }

  const prompt = buildDeepSeekPrompt({ company, productName, cards, indicators, records });
  const rawSummary = await generateWithDeepSeek({ prompt, company, productName, cards, indicators, records });
  const summaryJson = validateCustomerResponsibilitySummaryJson(rawSummary, {
    allowedTitles: titleSet(cards, indicators),
    allowedSourceUrls: sourceUrlSet({ cards, records, indicators }),
  });
  const summaryContext = buildSummaryContext({ productKey, company, productName, cards, indicators, records });
  const now = nowIso();
  const row = {
    id: `customer_summary:${productKey}:${CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION}`,
    productKey,
    company,
    productName,
    summaryVersion: CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION,
    status: 'ready',
    headline: summaryJson.headline,
    summaryJson,
    sourceUrls: summaryJson.sourceUrls,
    sourceDigest,
    modelProvider: 'deepseek',
    modelName: text(modelName) || DEFAULT_MODEL,
    generatedAt: now,
    updatedAt: now,
    payload: {
      productKey,
      company,
      productName,
      summaryVersion: CUSTOMER_RESPONSIBILITY_SUMMARY_VERSION,
      sourceDigest,
      summaryJson,
      sourceUrls: summaryJson.sourceUrls,
      summaryContext,
    },
  };
  const saved = typeof persistSummary === 'function' ? await persistSummary(row) : row;
  return {
    ok: true,
    source: 'generated',
    summary: safeCustomerSummary(saved || row),
  };
}
