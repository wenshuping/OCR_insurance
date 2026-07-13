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

export function classifyProductKnowledgeQuery(query) {
  const normalized = text(query);
  return QUERY_RULES.find(([, pattern]) => pattern.test(normalized))?.[0] || 'general_product_knowledge';
}

function searchTerms(query, products = []) {
  const normalized = text(query);
  const terms = DOMAIN_TERMS.filter((term) => normalized.includes(term));
  for (const product of Array.isArray(products) ? products : []) {
    const productName = text(product?.productName || product?.officialName || product?.name);
    if (productName) terms.push(productName);
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

function rankedChildren(store, input) {
  const byId = new Map();
  const terms = searchTerms(input.query, input.products);
  terms.forEach((term) => {
    const rows = store.searchChunks({
      tenantId: input.tenantId,
      query: term,
      canonicalProductId: input.canonicalProductId,
      includeQuarantined: input.includeQuarantined === true,
      limit: input.candidateLimit || 20,
    });
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
    if (parent && usedParents.has(parent.id)) continue;
    const preferred = child.chunkType === 'table'
      ? child
      : parent && parent.tokenCount <= remaining
        ? parent
        : child;
    if (preferred.tokenCount > remaining && evidence.length) continue;
    const allowedTokens = Math.max(1, Math.min(preferred.tokenCount || 1, remaining));
    const selectedContent = preferred.content;
    evidence.push({
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
    if (parent) usedParents.add(parent.id);
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
    });
    const evidenceChunks = evidenceFromRanked(store, ranked, tokenBudget);
    return {
      queryType: classifyProductKnowledgeQuery(query),
      products: Array.isArray(input.products) ? input.products : [],
      structuredFacts: [],
      evidenceChunks,
      conflicts: [],
      missingInformation: evidenceChunks.length ? [] : ['没有找到可用于回答的已发布产品资料'],
      retrievalVersion: 'rag-v2',
      previewMode: input.includeQuarantined === true,
      retrievalMeta: {
        searchTerms: searchTerms(query, input.products),
        candidateCount: ranked.length,
        evidenceTokenBudget: tokenBudget,
      },
    };
  }

  return { retrieve };
}
