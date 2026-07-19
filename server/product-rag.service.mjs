import { topicSearchTerms } from './product-knowledge-topics.mjs';

function text(value) {
  return String(value ?? '').trim();
}

const QUERY_RULES = [
  ['recommendation', /推荐|适合谁|适合什么人|客户需求|保障缺口|预算/u],
  ['product_comparison', /对比|比较|区别|差异|哪个更|PK/iu],
  ['product_advantage', /优势|亮点|卖点|竞争力|好在哪里/u],
  ['version_history', /历史版本|旧版|新版|版本|停售|在售/u],
  ['sales_guidance', /话术|异议|怎么讲|怎么卖|客户沟通/u],
  ['exact_field', /等待期|犹豫期|投保年龄|免赔额|保额|缴费期|保障期|续保条件/u],
  ['clause_explanation', /条款|责任免除|保险责任|释义|给付|赔付|理赔/u],
];

const DOMAIN_TERMS = [
  '等待期', '犹豫期', '投保年龄', '免赔额', '保险责任', '责任免除', '续保', '健康告知',
  '职业类别', '缴费期间', '保障期间', '现金价值', '给付比例', '给付次数', '费率', '保费',
  '产品优势', '产品亮点', '销售话术', '异议处理',
];

const ADVANTAGE_SEARCH_TERMS = ['适用人群', '投保规则', '健康服务', '保障责任'];
const ADVANTAGE_TOPIC_LIMITS = new Map([
  ['product_advantage', 3],
  ['target_audience', 1],
  ['health_services', 1],
  ['other', 1],
]);

const ALL_FACT_KEYS = [
  'waiting_period', 'annual_deductible', 'reimbursement_ratio',
  'benefit_limit', 'entry_age', 'renewal_period',
];

export function classifyProductKnowledgeQuery(query) {
  const normalized = text(query);
  return QUERY_RULES.find(([, pattern]) => pattern.test(normalized))?.[0] || 'general_product_knowledge';
}

function searchTerms(query, products = [], canonicalProductId = '') {
  const normalized = text(query);
  const terms = topicSearchTerms(normalized);
  if (classifyProductKnowledgeQuery(normalized) === 'product_advantage') terms.push(...ADVANTAGE_SEARCH_TERMS);
  terms.push(...DOMAIN_TERMS.filter((term) => normalized.includes(term)));
  if (!text(canonicalProductId)) {
    for (const product of Array.isArray(products) ? products : []) {
      const productName = text(product?.productName || product?.officialName || product?.name);
      if (productName) terms.push(productName);
    }
  }
  if (!terms.length) {
    const compact = normalized
      .replace(/[请问一下帮我查询介绍说明告诉这款产品是否多少什么怎么呢吗？?，,。！!]/gu, ' ')
      .split(/\s+/u)
      .map(text)
      .filter((term) => term.length >= 2);
    terms.push(...compact.slice(0, 3));
  }
  return [...new Set(terms)].slice(0, 6);
}

function advantageTopic(chunk) {
  const context = text(chunk?.contextualPrefix);
  if (/产品优势|产品特色/u.test(context)) return 'product_advantage';
  if (/适用人群|投保规则/u.test(context)) return 'target_audience';
  if (/健康服务/u.test(context)) return 'health_services';
  return 'other';
}

export function buildProductRetrievalPlan(queryType) {
  if (queryType === 'exact_field') {
    return { useFacts: true, materialLimit: 2, semanticKinds: ['fact', 'clause', 'formula'] };
  }
  if (queryType === 'clause_explanation') {
    return { useFacts: true, materialLimit: 2, semanticKinds: ['clause', 'definition', 'process', 'fact'] };
  }
  if (queryType === 'product_advantage') {
    return { useFacts: true, materialLimit: 6, semanticKinds: ['claim', 'fact', 'clause', 'process'] };
  }
  return { useFacts: false, materialLimit: 4, semanticKinds: [] };
}

function queryFactKeys(query) {
  const normalized = text(query);
  return ALL_FACT_KEYS.filter((key) => ({
    waiting_period: /等待期/u,
    annual_deductible: /免赔额/u,
    reimbursement_ratio: /赔付比例|给付比例|报销比例/u,
    benefit_limit: /限额|保额/u,
    entry_age: /投保年龄/u,
    renewal_period: /续保/u,
  })[key].test(normalized));
}

function selectRankedCandidates(ranked, queryType, plan) {
  if (queryType !== 'product_advantage') return ranked.slice(0, plan.materialLimit);
  const selected = [];
  const topicCounts = new Map();
  const usedPages = new Set();
  for (const item of ranked) {
    const chunk = item.chunk;
    const pageStart = Number(chunk.pageStart || 0);
    const pageKey = pageStart > 0
      ? `${text(chunk.documentId)}:${pageStart}:${Number(chunk.pageEnd || pageStart)}`
      : `chunk:${text(chunk.id)}`;
    if (usedPages.has(pageKey)) continue;
    const topic = advantageTopic(chunk);
    const count = topicCounts.get(topic) || 0;
    if (count >= (ADVANTAGE_TOPIC_LIMITS.get(topic) || 3)) continue;
    selected.push(item);
    usedPages.add(pageKey);
    topicCounts.set(topic, count + 1);
    if (selected.length >= plan.materialLimit) break;
  }
  return selected;
}

function rankedChildren(store, input) {
  const byId = new Map();
  const terms = searchTerms(input.query, input.products, input.canonicalProductId);
  terms.forEach((term) => {
    const searchInput = {
      tenantId: input.tenantId,
      query: term,
      canonicalProductId: input.canonicalProductId,
      productVersionId: input.productVersionId,
      asOfDate: input.asOfDate,
      sourceAuthorities: input.sourceAuthorities,
      semanticKinds: input.plan.semanticKinds,
      factKeys: input.factKeys,
      includeQuarantined: input.includeQuarantined === true,
      limit: input.candidateLimit || 20,
    };
    const rows = store.searchChunks(searchInput);
    rows.forEach((chunk, rank) => {
      const current = byId.get(chunk.id) || { chunk, fusionScore: 0, matchedTerms: [] };
      current.fusionScore += 1 / (60 + rank + 1);
      current.matchedTerms.push(term);
      byId.set(chunk.id, current);
    });
  });
  return [...byId.values()]
    .map((item) => ({ ...item, matchedTerms: [...new Set(item.matchedTerms)] }))
    .sort((left, right) => right.fusionScore - left.fusionScore || left.chunk.id.localeCompare(right.chunk.id));
}

function withRequiredContexts(store, ranked) {
  const rankedIds = new Set(ranked.map((item) => text(item.chunk?.id)));
  const requiredIds = [...new Set(ranked.flatMap((item) => (
    Array.isArray(item.chunk?.payload?.semantic?.requiredContextChunkIds)
      ? item.chunk.payload.semantic.requiredContextChunkIds : []
  )).map(text).filter((id) => id && !rankedIds.has(id)))];
  if (!requiredIds.length) return ranked;
  const contexts = store.getChunksByIds({
    tenantId: ranked[0]?.chunk?.tenantId,
    chunkIds: requiredIds,
  });
  return [
    ...ranked,
    ...contexts.map((chunk) => ({ chunk, fusionScore: 0, matchedTerms: ['required_context'] })),
  ];
}

function parentCanReplaceChild(parent, child) {
  if (!parent || !child) return false;
  const childContent = text(child.content);
  const parentStart = Number(parent.pageStart || 0);
  const parentEnd = Number(parent.pageEnd || parentStart);
  const childStart = Number(child.pageStart || 0);
  const childEnd = Number(child.pageEnd || childStart);
  return Boolean(childContent)
    && parentStart > 0
    && childStart > 0
    && parentStart <= childStart
    && parentEnd >= childEnd
    && text(parent.content).includes(childContent);
}

function evidenceFromRanked(store, ranked, tokenBudget) {
  const parentIds = [...new Set(ranked.map((item) => text(item.chunk.parentChunkId)).filter(Boolean))];
  const parents = new Map(store.getChunksByIds({
    tenantId: ranked[0]?.chunk?.tenantId,
    chunkIds: parentIds,
  }).map((chunk) => [chunk.id, chunk]));
  const evidence = [];
  const usedParents = new Set();
  let remaining = tokenBudget;
  for (const item of ranked) {
    const child = item.chunk;
    const parent = parents.get(child.parentChunkId);
    const eligibleParent = parentCanReplaceChild(parent, child) ? parent : null;
    if (eligibleParent && usedParents.has(eligibleParent.id)) continue;
    const preferred = child.chunkType === 'table'
      ? child
      : eligibleParent && eligibleParent.tokenCount <= remaining
        ? eligibleParent
        : child;
    if (preferred.tokenCount > remaining && evidence.length) continue;
    const allowedTokens = Math.max(1, Math.min(preferred.tokenCount || 1, remaining));
    const selectedContent = preferred.content;
    evidence.push({
      evidenceId: `M${evidence.length + 1}`,
      chunkId: preferred.id,
      matchedChunkId: child.id,
      parentChunkId: text(child.parentChunkId),
      documentId: child.documentId,
      canonicalProductId: child.canonicalProductId,
      productVersionId: child.productVersionId,
      content: selectedContent,
      matchedContent: preferred.id === child.id ? '' : child.content,
      contextualPrefix: child.contextualPrefix,
      pageStart: preferred.pageStart || child.pageStart,
      pageEnd: preferred.pageEnd || child.pageEnd,
      sourceAuthority: child.sourceAuthority,
      reviewStatus: child.reviewStatus,
      retrievalScore: Number(item.fusionScore.toFixed(6)),
      matchedTerms: item.matchedTerms,
      tokenCount: allowedTokens,
      citation: {
        documentId: child.documentId,
        fileName: child.fileName,
        pageStart: preferred.pageStart || child.pageStart,
        pageEnd: preferred.pageEnd || child.pageEnd,
        chunkId: preferred.id,
        sourceAuthority: child.sourceAuthority,
        reviewStatus: child.reviewStatus,
      },
    });
    if (eligibleParent && preferred.id === eligibleParent.id) usedParents.add(eligibleParent.id);
    remaining -= allowedTokens;
    if (remaining <= 0) break;
  }
  return evidence;
}

export function createProductRagService(options = {}) {
  const store = options.store;

  function retrieve(input = {}) {
    const tenantId = text(input.tenantId) || 'default';
    const query = text(input.query);
    const tokenBudget = Math.max(200, Math.min(8000, Math.trunc(Number(input.tokenBudget || 3000)) || 3000));
    if (!store || !query) {
      return {
        queryType: classifyProductKnowledgeQuery(query),
        products: Array.isArray(input.products) ? input.products : [],
        structuredFacts: [],
        evidenceChunks: [],
        conflicts: [],
        missingInformation: [query ? '产品知识检索服务不可用' : '缺少检索问题'],
        retrievalVersion: 'rag-v2',
      };
    }
    const ranked = rankedChildren(store, {
      ...input,
      tenantId,
      query,
      plan: buildProductRetrievalPlan(classifyProductKnowledgeQuery(query)),
      factKeys: queryFactKeys(query),
    });
    const queryType = classifyProductKnowledgeQuery(query);
    const plan = buildProductRetrievalPlan(queryType);
    const selectedRanked = selectRankedCandidates(ranked, queryType, plan);
    const evidenceRanked = withRequiredContexts(store, selectedRanked);
    const evidenceChunks = evidenceFromRanked(store, evidenceRanked, tokenBudget);
    const structuredFacts = plan.useFacts && typeof store.listProductFacts === 'function' && text(input.canonicalProductId)
      ? store.listProductFacts({
          tenantId,
          canonicalProductId: input.canonicalProductId,
          productVersionId: input.productVersionId,
          fieldKeys: queryFactKeys(query),
          statuses: ['confirmed'],
        })
      : [];
    return {
      queryType,
      products: Array.isArray(input.products) ? input.products : [],
      structuredFacts,
      evidenceChunks,
      conflicts: [],
      missingInformation: evidenceChunks.length ? [] : ['没有找到可用于回答的已发布产品资料'],
      retrievalVersion: 'rag-v2',
      previewMode: input.includeQuarantined === true,
      retrievalMeta: {
        searchTerms: searchTerms(query, input.products, input.canonicalProductId),
        candidateCount: ranked.length,
        selectedCandidateCount: selectedRanked.length,
        requiredContextCount: Math.max(0, evidenceRanked.length - selectedRanked.length),
        evidenceTokenBudget: tokenBudget,
      },
    };
  }

  return { retrieve };
}
