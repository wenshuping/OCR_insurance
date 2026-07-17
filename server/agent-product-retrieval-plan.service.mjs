const MAX_QUERY_CHARS = 1_000;
const MAX_QUERIES = 2;

const ASPECT_TERMS = Object.freeze({
  main_responsibilities: '保险责任 触发条件 给付方式 限额 主要限制 可选责任',
  product_advantages: '产品优势 客户价值 适用场景 投保规则 服务权益 必要限制',
  exclusions: '责任免除 不承担责任 除外责任',
  waiting_period: '等待期 生效条件',
  deductible: '免赔额 年度免赔额',
  reimbursement_ratio: '给付比例 赔付比例 报销比例',
  renewal: '续保 保证续保 续保条件 最高续保年龄',
  sales_status: '在售 停售 销售状态',
  comparison: '保险责任 给付方式 限额 等待期 主要限制 适用场景',
});

const OFFICIAL_ASPECT_TERMS = Object.freeze({
  exclusions: ['责任免除', '不承担', '除外'],
  waiting_period: ['等待期'],
  deductible: ['免赔额'],
  reimbursement_ratio: ['给付比例', '赔付比例', '报销比例'],
  renewal: ['续保'],
});

const RESPONSIBILITY_RANGE_PATTERN = /第\s*[一二三四五六七八九十百\d]+\s*款\s*至\s*第\s*[一二三四五六七八九十百\d]+\s*款/u;
const NUMBERED_RESPONSIBILITY_PATTERN = /(?:^|[\n。；])\s*(?:[2-9]|1\d|[二三四五六七八九十]+)[.、．]\s*[^\n。；]{2,80}?(?:保险金|医疗费用|救援费用)/gu;

function text(value, limit = MAX_QUERY_CHARS) {
  return typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').slice(0, limit) : '';
}

function productIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const company = text(value.company, 200);
  const officialName = text(value.officialName || value.productName, 300);
  const canonicalProductId = text(value.canonicalProductId, 200);
  return company && officialName ? { canonicalProductId, company, officialName } : null;
}

function normalizedAspects(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((aspect) => text(aspect, 80))
    .filter((aspect) => Object.prototype.hasOwnProperty.call(ASPECT_TERMS, aspect)))].slice(0, 8);
}

function sameProduct(left, right) {
  if (!left || !right) return false;
  if (left.canonicalProductId && right.canonicalProductId) {
    return left.canonicalProductId === right.canonicalProductId;
  }
  return left.company === right.company && left.officialName === right.officialName;
}

function evidenceText(items) {
  return (Array.isArray(items) ? items : []).map((item) => text(item?.content, 4_000)).join('\n');
}

export function isResponsibilityOutlineOnly(value) {
  const content = typeof value === 'string' ? value.trim() : '';
  if (!content || !RESPONSIBILITY_RANGE_PATTERN.test(content)) return false;
  const headings = content.match(NUMBERED_RESPONSIBILITY_PATTERN) || [];
  return headings.length < 2;
}

export function hasDetailedResponsibilityEvidence(value) {
  const content = typeof value === 'string' ? value.trim() : '';
  if (!content || isResponsibilityOutlineOnly(content)) return false;
  const headings = content.match(NUMBERED_RESPONSIBILITY_PATTERN) || [];
  if (headings.length >= 2) return true;
  return (content.match(/保险金|医疗费用|救援费用/gu) || []).length >= 2;
}

export function createProductRetrievalPlan({ question, product, queryAspects = [] } = {}) {
  const identity = productIdentity(product);
  const originalQuestion = text(question);
  if (!identity || !originalQuestion) return null;
  const aspects = normalizedAspects(queryAspects);
  const standaloneQuestion = text(`${identity.company}《${identity.officialName}》 ${originalQuestion}`);
  const queries = [...new Set([originalQuestion, standaloneQuestion])].slice(0, MAX_QUERIES);
  const aspectTerms = aspects.map((aspect) => ASPECT_TERMS[aspect]).filter(Boolean).join(' ');
  const supplementalQuery = text(
    `${identity.company}《${identity.officialName}》 ${aspectTerms || originalQuestion}`,
  );
  return {
    product: identity,
    originalQuestion,
    standaloneQuestion,
    queryAspects: aspects,
    queries,
    supplementalQuery,
    maxRetrievalRounds: 2,
  };
}

export function validateProductRetrievalPlan(plan, expectedProduct) {
  const expected = productIdentity(expectedProduct);
  const actual = productIdentity(plan?.product);
  if (!expected || !actual || !sameProduct(actual, expected)) return false;
  if (!Array.isArray(plan?.queries) || !plan.queries.length || plan.queries.length > MAX_QUERIES) return false;
  return plan.queries.every((query) => text(query) === query)
    && text(plan?.originalQuestion) === plan.originalQuestion
    && text(plan?.standaloneQuestion) === plan.standaloneQuestion
    && text(plan?.supplementalQuery) === plan.supplementalQuery
    && plan.maxRetrievalRounds === 2;
}

export function assessProductEvidenceCompleteness({
  queryAspects = [],
  expertPlan = null,
  customerResponsibilitySummary,
  officialEvidence = [],
  materialEvidence = [],
  verifiedSources = [],
  retrievalRound = 1,
} = {}) {
  const aspects = normalizedAspects(queryAspects);
  const missingEvidence = [];
  const officialText = evidenceText(officialEvidence);
  const plannedSkills = new Set(Array.isArray(expertPlan?.skills) ? expertPlan.skills : []);
  const planComparison = plannedSkills.has('plan_comparison');
  const responsibilityDetail = plannedSkills.has('responsibility_detail');
  const hasOfficialSource = (Array.isArray(verifiedSources) ? verifiedSources : [])
    .some((source) => source?.verified === true && source?.provenance !== 'company_material');
  const responsibilities = Array.isArray(customerResponsibilitySummary?.mainResponsibilities)
    ? customerResponsibilitySummary.mainResponsibilities.filter((item) => text(item?.title, 200))
    : [];

  if (((planComparison || responsibilityDetail) && !hasDetailedResponsibilityEvidence(officialText))
    || (aspects.includes('main_responsibilities')
      && !responsibilities.length
      && !hasDetailedResponsibilityEvidence(officialText))) {
    missingEvidence.push('complete_responsibility_summary');
  }
  if (planComparison
    && !/(?:计划|方案)[一二三四五六七八九十百\dA-Za-z]+/u.test(officialText)) {
    missingEvidence.push('official_plan_comparison');
  }
  for (const aspect of aspects) {
    const requiredTerms = OFFICIAL_ASPECT_TERMS[aspect] || [];
    if (requiredTerms.length && !requiredTerms.some((term) => officialText.includes(term))) {
      missingEvidence.push(`official_${aspect}`);
    }
  }
  if (aspects.includes('product_advantages') && !materialEvidence.length && retrievalRound === 1) {
    missingEvidence.push('approved_product_material');
  }
  if (!hasOfficialSource && !officialEvidence.length) missingEvidence.push('verified_official_source');

  const uniqueMissing = [...new Set(missingEvidence)];
  return {
    status: uniqueMissing.length ? (retrievalRound === 1 ? 'incomplete' : 'partial') : 'complete',
    missingEvidence: uniqueMissing,
    shouldRetry: retrievalRound === 1 && uniqueMissing.some((item) => (
      item === 'approved_product_material'
      || item === 'complete_responsibility_summary'
      || item.startsWith('official_')
    )),
  };
}
