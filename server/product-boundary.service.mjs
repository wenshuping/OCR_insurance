function text(value) {
  return String(value ?? '').trim();
}

function unique(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}

function normalizeComparable(value) {
  return text(value)
    .toLowerCase()
    .replace(/[\s·•,，。；;：:（）()《》【】\[\]_-]+/gu, '')
    .replace(/保险股份有限公司|股份有限公司|有限责任公司/gu, '')
    .replace(/医疗险$/u, '医疗保险')
    .replace(/重疾险$/u, '重大疾病保险');
}

const GENERIC_PRODUCT_TERMS = new Set([
  '保险', '产品保险', '保险责任', '医疗保险', '人寿保险', '重大疾病保险', '年金保险',
]);

const COMPANY_PATTERN = /(?:中国人寿|平安人寿|新华保险|太平人寿|太平洋人寿|泰康人寿|友邦保险|阳光人寿|人保寿险|中邮人寿|招商信诺|工银安盛|中信保诚|光大永明|中意人寿|中英人寿|华夏保险|大家人寿|国联人寿|瑞众人寿|[\u4e00-\u9fff]{2,12}(?:人寿保险|财产保险|健康保险|养老保险)(?:股份)?有限公司)/gu;
const PRODUCT_PATTERN = /[\u4e00-\u9fffA-Za-z0-9·（）()]{2,36}?(?:终身|定期)?(?:重大疾病保险|医疗保险|年金保险|两全保险|养老保险|意外伤害保险|护理保险|寿险|医疗险|重疾险)/gu;
const CODE_PATTERN = /(?:产品代码|条款编号|备案编号|注册编号)\s*[：:]?\s*([A-Z0-9][A-Z0-9_-]{2,29})/giu;

function cleanProductName(value) {
  return text(value)
    .replace(/^(?:保险公司|承保公司|产品名称|产品名)\s*[：:]?\s*/u, '')
    .replace(/^(?:中国人寿|平安人寿|新华保险|太平人寿|太平洋人寿|泰康人寿|友邦保险|阳光人寿|人保寿险|中邮人寿)\s*/u, '')
    .replace(/^(?:本页介绍|重点推荐|主推产品|产品对比|竞品对比)\s*/u, '')
    .replace(/^[与和及]/u, '')
    .trim();
}

function productNamesFromText(value) {
  const matches = text(value).match(PRODUCT_PATTERN) || [];
  return unique(matches.map(cleanProductName)).filter((name) => {
    const normalized = normalizeComparable(name);
    return normalized.length >= 4 && !GENERIC_PRODUCT_TERMS.has(name) && !GENERIC_PRODUCT_TERMS.has(normalized);
  });
}

function productCodesFromText(value) {
  return unique([...text(value).matchAll(CODE_PATTERN)].map((match) => match[1].toUpperCase()));
}

function companyFromPage(value) {
  return unique(text(value).match(COMPANY_PATTERN) || [])[0] || '';
}

export function detectProductBoundaries(pages = []) {
  const byName = new Map();
  let lastCompany = '';
  for (const page of Array.isArray(pages) ? pages : []) {
    const pageNo = Number(page?.pageNo || 0);
    const pageText = [page?.headings, page?.rawText, ...(page?.tables || []).map((table) => table?.text)]
      .flat().map(text).filter(Boolean).join('\n');
    const company = companyFromPage(pageText) || lastCompany;
    if (company) lastCompany = company;
    const names = productNamesFromText(pageText);
    const codes = productCodesFromText(pageText);
    const comparisonPage = names.length > 1 || /对比|比较|竞品|PK/iu.test(pageText);
    for (const productName of names) {
      const key = `${normalizeComparable(company)}\u001f${normalizeComparable(productName)}`;
      const candidate = byName.get(key) || {
        company,
        productName,
        productCodes: [],
        evidencePages: [],
        comparisonPages: [],
        signals: [],
      };
      candidate.productCodes = unique([...candidate.productCodes, ...codes]);
      candidate.evidencePages = unique([...candidate.evidencePages, String(pageNo)]).map(Number).sort((a, b) => a - b);
      if (comparisonPage) candidate.comparisonPages = unique([...candidate.comparisonPages, String(pageNo)]).map(Number);
      if (company) candidate.signals.push('company_and_name');
      if (codes.length) candidate.signals.push('product_code');
      if (/产品名称|产品介绍|保险条款/u.test(pageText)) candidate.signals.push('explicit_product_context');
      byName.set(key, candidate);
    }
  }

  const candidates = [...byName.values()].map((candidate) => {
    const signals = unique(candidate.signals);
    const confidence = Math.min(0.98, 0.45
      + (candidate.company ? 0.15 : 0)
      + (candidate.productCodes.length ? 0.2 : 0)
      + (signals.includes('explicit_product_context') ? 0.1 : 0)
      + (candidate.evidencePages.length > 1 ? 0.05 : 0));
    return {
      ...candidate,
      signals,
      pageStart: Math.min(...candidate.evidencePages),
      pageEnd: Math.max(...candidate.evidencePages),
      relationType: candidate.comparisonPages.length ? 'comparison' : 'primary',
      confidence: Number(confidence.toFixed(2)),
    };
  }).sort((left, right) => left.pageStart - right.pageStart || left.productName.localeCompare(right.productName, 'zh-CN'));

  return {
    candidates,
    requiresReview: candidates.length !== 1 || candidates.some((candidate) => candidate.confidence < 0.8),
  };
}

function bigrams(value) {
  const normalized = normalizeComparable(value);
  if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
  return new Set(Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2)));
}

function diceSimilarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap += 1;
  return (2 * overlap) / (a.size + b.size);
}

function normalizeExact(value) {
  return text(value).toLowerCase().replace(/[\s·•,，。；;：:（）()《》【】\[\]_-]+/gu, '');
}

function normalizedCatalogProduct(product = {}) {
  return {
    canonicalProductId: text(product.canonicalProductId || product.canonical_product_id),
    company: text(product.company),
    officialName: text(product.officialName || product.official_name || product.productName || product.name),
    productCodes: unique([
      product.productCode,
      product.product_code,
      ...(Array.isArray(product.productCodes) ? product.productCodes : []),
    ]).map((code) => code.toUpperCase()),
  };
}

export function matchProductCandidates(detected = [], catalog = []) {
  const products = (Array.isArray(catalog) ? catalog : []).map(normalizedCatalogProduct)
    .filter((product) => product.canonicalProductId && product.officialName);
  return (Array.isArray(detected) ? detected : []).map((candidate) => {
    const candidateCodes = unique(candidate?.productCodes || []).map((code) => code.toUpperCase());
    const matches = products.map((product) => {
      const sharedCode = candidateCodes.find((code) => product.productCodes.includes(code));
      const sameCompany = normalizeComparable(candidate?.company) === normalizeComparable(product.company);
      const exactName = normalizeExact(candidate?.productName) === normalizeExact(product.officialName);
      const nameScore = diceSimilarity(candidate?.productName, product.officialName);
      if (sharedCode) return { ...product, score: 1, reason: 'exact_product_code' };
      if (sameCompany && exactName) return { ...product, score: 0.96, reason: 'exact_company_name' };
      if (sameCompany && nameScore >= 0.55) return { ...product, score: Number((0.55 + nameScore * 0.35).toFixed(3)), reason: 'similar_company_name' };
      return null;
    }).filter(Boolean).sort((left, right) => right.score - left.score);
    return {
      candidate,
      matches: matches.slice(0, 5),
      autoLinkEligible: matches[0]?.reason === 'exact_product_code'
        || matches[0]?.reason === 'exact_company_name',
      requiresReview: !matches.length || !['exact_product_code', 'exact_company_name'].includes(matches[0].reason),
    };
  });
}

