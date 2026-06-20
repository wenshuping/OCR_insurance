import { canonicalProductIdFromOfficialProduct } from './canonical-product-id.mjs';
import { shouldKeepPolicyPlan } from '../src/policy-plan-filter.mjs';
import { extractPolicyFieldsFromText } from '../ocr-service/insurance-ocr.service.mjs';

const GENERIC_COMPANY_KEYWORDS = new Set(['保险', '保司', '人寿', '寿险', '公司', '集团', '中国', '股份', '有限责任公司', '股份有限公司']);

const COMMON_COMPANY_KEYWORDS = [
  { includes: ['中国平安', '平安保险'], keywords: ['中国平安', '平安', 'PINGAN', 'PING AN'] },
  { includes: ['新华保险', '新华人寿'], keywords: ['新华保险', '新华'] },
  { includes: ['中国人寿', '国寿'], keywords: ['中国人寿', '国寿'] },
  { includes: ['中国太平洋', '太平洋保险', '太保寿险'], keywords: ['中国太平洋', '太平洋', '太保'] },
  { includes: ['泰康保险', '泰康人寿'], keywords: ['泰康保险', '泰康'] },
  { includes: ['中国太平'], keywords: ['中国太平'] },
  { includes: ['太平人寿'], keywords: ['太平人寿'] },
  { includes: ['友邦保险', '友邦人寿'], keywords: ['友邦保险', '友邦'] },
  { includes: ['阳光保险', '阳光人寿'], keywords: ['阳光保险', '阳光'] },
  { includes: ['人保寿险'], keywords: ['人保寿险', '中国人保寿险'] },
  { includes: ['中邮保险', '中邮人寿'], keywords: ['中邮保险', '中邮'] },
];

function trim(value) {
  return String(value || '').trim();
}

function compactText(value) {
  return trim(value).replace(/\s+/gu, '');
}

const PERSON_NAME_TRAILING_LABEL_PATTERN = /(性别|生日|出生|生于|身份证号码|身份证号|居民身份证号码|居民身份证号|身份证|居民身份证|证件号码|证件号|受益顺序|受益份额|本栏以下空白|及保险主要事项).*$/u;

function normalizePersonLikeOcrValue(value) {
  return compactText(value)
    .replace(/^(投保人姓名|投保人名称|投保人|要保人姓名|要保人|设保人姓名|设保人|被保险人姓名|被保险人|被保险入姓名|被保险入|披保险人姓名|披保险人|受保人姓名|受保人|被保人|身故保险金受益人|身故受益人|受益人)[:：]?/u, '')
    .replace(/^（[^）]*）[:：]?/u, '')
    .replace(PERSON_NAME_TRAILING_LABEL_PATTERN, '')
    .trim();
}

function isIdentityOnlyPersonPlaceholder(value) {
  return /^(?:身份证|居民身份证|证件号码|证件号)[:：]?(?:\d{6,}[\dXx]?)?$/u.test(compactText(value));
}

function shouldReplaceNoisyPersonValue(currentValue, extractedValue) {
  const extracted = trim(extractedValue);
  if (!extracted) return false;
  const current = trim(currentValue);
  if (!current) return false;
  const normalizedCurrent = normalizePersonLikeOcrValue(current);
  return normalizedCurrent === extracted && current !== extracted;
}

function normalizeIdNumber(value) {
  const text = String(value || '')
    .normalize('NFKC')
    .replace(/[^\dXx]/g, '')
    .toUpperCase();
  const matched18 = text.match(/\d{17}[\dX]/);
  if (matched18) return matched18[0];
  const matched15 = text.match(/\d{15}/);
  return matched15?.[0] || '';
}

function isValidDateParts(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
  );
}

function birthdayFromIdNumber(value) {
  const idNumber = normalizeIdNumber(value);
  if (idNumber.length === 18) {
    const year = idNumber.slice(6, 10);
    const month = idNumber.slice(10, 12);
    const day = idNumber.slice(12, 14);
    return isValidDateParts(year, month, day) ? `${year}-${month}-${day}` : '';
  }
  if (idNumber.length === 15) {
    const shortYear = Number(idNumber.slice(6, 8));
    const year = String(shortYear >= 30 ? 1900 + shortYear : 2000 + shortYear);
    const month = idNumber.slice(8, 10);
    const day = idNumber.slice(10, 12);
    return isValidDateParts(year, month, day) ? `${year}-${month}-${day}` : '';
  }
  return '';
}

function extractInsuredIdentityFromOcrText(ocrText = '', insuredName = '') {
  const lines = trim(ocrText).split(/\r?\n/u).map(trim).filter(Boolean);
  const normalizedInsured = normalizePersonLikeOcrValue(insuredName) || compactText(insuredName);
  const candidates = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = compactText(lines[index]);
    const idNumber = normalizeIdNumber(line);
    if (!idNumber) continue;

    let score = 0;
    if (/^(?:证件号码|证件号|身份证号码|身份证号|居民身份证号码|居民身份证号)[:：]?/u.test(line)) score += 5;
    const previousWindow = lines.slice(Math.max(0, index - 3), index).map(compactText).join(' ');
    const nextWindow = lines.slice(index + 1, index + 4).map(compactText).join(' ');
    if (/被保险[人入]|披保险人|被保人|受保人/u.test(line)) score += 10;
    else if (/被保险[人入]|披保险人|被保人|受保人/u.test(previousWindow)) score += 3;
    if (/投保人|设保人|要保人/u.test(line)) score -= 8;
    else if (/投保人|设保人|要保人/u.test(previousWindow)) score -= 3;
    if (normalizedInsured && line.includes(normalizedInsured)) score += 8;
    else if (normalizedInsured && (previousWindow.includes(normalizedInsured) || nextWindow.includes(normalizedInsured))) score += 2;
    candidates.push({ idNumber, score, index });
  }

  candidates.sort((left, right) => right.score - left.score || right.index - left.index);
  const insuredIdNumber = candidates[0]?.idNumber || '';
  return {
    insuredIdNumber,
    insuredBirthday: birthdayFromIdNumber(insuredIdNumber),
  };
}

export function normalizeOcrMappingText(value) {
  return trim(value)
    .normalize('NFKC')
    .replace(/險/gu, '险')
    .replace(/壽/gu, '寿')
    .replace(/終/gu, '终')
    .replace(/費/gu, '费')
    .replace(/額/gu, '额')
    .replace(/稱/gu, '称')
    .replace(/繳/gu, '缴')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

function addKeyword(keywords, value) {
  const raw = trim(value);
  const normalized = normalizeOcrMappingText(raw);
  if (!raw || normalized.length < 2 || GENERIC_COMPANY_KEYWORDS.has(raw) || GENERIC_COMPANY_KEYWORDS.has(normalized)) return;
  keywords.set(normalized, raw);
}

function companyKeywordCandidates(company, aliases = []) {
  const keywords = new Map();
  const values = [company, ...aliases].map(trim).filter(Boolean);

  for (const value of values) {
    addKeyword(keywords, value);
    addKeyword(keywords, value.replace(/(?:人寿|健康|养老)?保险(?:股份有限公司|有限责任公司)?$/u, ''));
    addKeyword(keywords, value.replace(/(?:股份有限公司|有限责任公司|集团有限责任公司|集团)$/u, ''));
    addKeyword(keywords, value.replace(/保险$/u, ''));
    const withoutChina = value.replace(/^中国/u, '');
    if (withoutChina !== value) addKeyword(keywords, withoutChina);
  }

  const normalizedCompany = normalizeOcrMappingText(company);
  for (const item of COMMON_COMPANY_KEYWORDS) {
    if (item.includes.some((keyword) => normalizedCompany.includes(normalizeOcrMappingText(keyword)))) {
      for (const keyword of item.keywords) addKeyword(keywords, keyword);
    }
  }

  return [...keywords.entries()].map(([normalized, raw]) => ({ normalized, raw }));
}

function splitOcrEvidenceLines(ocrText = '') {
  return trim(ocrText).split(/\r?\n/u).map(trim).filter(Boolean);
}

function isShortCompanyAlias(keyword = {}) {
  return normalizeOcrMappingText(keyword.raw || keyword.normalized).length <= 2;
}

function hasExplicitCompanySuffix(line = '', rawKeyword = '') {
  const text = compactText(line);
  const keyword = trim(rawKeyword).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  if (!keyword) return false;
  return new RegExp(`${keyword}(?:人寿|财产|养老|健康|财险)?保险(?:股份有限公司|有限责任公司|有限公司)?`, 'u').test(text)
    || new RegExp(`${keyword}(?:人寿|财产|养老|健康|财险)`, 'u').test(text);
}

function isCompanyContextLine(line = '') {
  const text = compactText(line);
  return /(?:保险公司|承保公司|公司名称|保险人|承保人|保险单|NCI|PINGAN|PINGAN|PICC)/iu.test(text);
}

function isProductContextLine(line = '') {
  const text = compactText(line);
  return /(?:险种名称|产品名称|保险项目|保险利益表|主险|附加险|附加|基本保险金额|保险金额|保险期间|保障期间|交费方式|缴费方式|保险费|保费)/u.test(text)
    || /(?:两全|终身|年金|医疗|疾病|重疾|意外|护理|养老).{0,12}保险/u.test(text)
    || /保险.{0,12}(?:A款|B款|C款|D款|万能型|分红型|费率可调)/u.test(text);
}

function hasCompanyKeywordEvidence(ocrText = '', keyword = {}) {
  const normalizedOcr = normalizeOcrMappingText(ocrText);
  if (!normalizedOcr || !keyword?.normalized || !normalizedOcr.includes(keyword.normalized)) return false;
  if (!isShortCompanyAlias(keyword)) return true;

  for (const line of splitOcrEvidenceLines(ocrText)) {
    const normalizedLine = normalizeOcrMappingText(line);
    if (!normalizedLine.includes(keyword.normalized)) continue;
    if (hasExplicitCompanySuffix(line, keyword.raw)) return true;
    if (isCompanyContextLine(line) && !isProductContextLine(line)) return true;
  }
  return false;
}

function buildKnownCompanyStats(state = {}) {
  const stats = new Map();
  const addCompany = (company, aliases = [], weight = 1) => {
    const name = trim(company);
    if (!name) return;
    const key = normalizeOcrMappingText(name);
    const current = stats.get(key) || { company: name, aliases: new Set(), recordCount: 0 };
    current.recordCount += weight;
    for (const alias of aliases || []) {
      const text = trim(alias);
      if (text) current.aliases.add(text);
    }
    stats.set(key, current);
  };

  for (const record of state.knowledgeRecords || []) addCompany(record.company, [], 1);
  for (const policy of state.policies || []) addCompany(policy.company, [], 1);
  for (const profile of state.officialDomainProfiles || []) addCompany(profile.company, profile.aliases || [], 0);

  return [...stats.values()].map((item) => ({
    company: item.company,
    aliases: [...item.aliases],
    recordCount: item.recordCount,
  }));
}

export function matchInsuranceCompanyFromOcr(ocrText, state = {}) {
  const normalizedOcr = normalizeOcrMappingText(ocrText);
  if (!normalizedOcr) return null;

  const matches = [];
  for (const entry of buildKnownCompanyStats(state)) {
    for (const keyword of companyKeywordCandidates(entry.company, entry.aliases)) {
      if (!hasCompanyKeywordEvidence(ocrText, keyword)) continue;
      matches.push({
        company: entry.company,
        keyword: keyword.raw,
        score: keyword.normalized.length * 2 + Math.min(entry.recordCount, 20) / 20,
      });
    }
  }

  matches.sort((left, right) => right.score - left.score || right.keyword.length - left.keyword.length || right.company.length - left.company.length);
  const best = matches[0] || null;
  const secondDifferent = matches.find((item) => item.company !== best?.company);
  if (!best) return null;
  if (secondDifferent && best.score - secondDifferent.score < 1) return null;
  return best;
}

function companyMatches(left, right) {
  const a = normalizeOcrMappingText(left);
  const b = normalizeOcrMappingText(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function buildKnownProductStats(state = {}, company = '') {
  const stats = new Map();
  const addProduct = (recordCompany, productName, weight = 1, options = {}) => {
    const sourceCompany = trim(recordCompany);
    const name = trim(productName);
    if (!sourceCompany || !name) return;
    if (trim(company) && !companyMatches(sourceCompany, company)) return;
    const key = `${sourceCompany}\u001f${name}`;
    const official = Boolean(options.official);
    const canonicalProductId = official
      ? canonicalProductIdFromOfficialProduct({ company: sourceCompany, productName: name })
      : '';
    const current = stats.get(key) || {
      company: sourceCompany,
      productName: name,
      productType: '',
      canonicalProductId: '',
      recordCount: 0,
      official: false,
    };
    current.recordCount += weight;
    current.official = current.official || official;
    if (!current.productType && trim(options.productType)) current.productType = trim(options.productType);
    if (!current.canonicalProductId && canonicalProductId) current.canonicalProductId = canonicalProductId;
    stats.set(key, current);
  };

  for (const record of state.knowledgeRecords || []) {
    addProduct(record.company, record.productName || record.title, 1, {
      official: true,
      productType: record.productType,
    });
  }
  for (const policy of state.policies || []) addProduct(policy.company, policy.name, 1, { official: false });
  return [...stats.values()];
}

function isNonEmptyObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function manualPolicyContextText(body = {}) {
  const manualData = isNonEmptyObject(body.manualData) ? body.manualData : {};
  const planNames = (Array.isArray(manualData.plans) ? manualData.plans : [])
    .map((plan) => [plan?.matchedProductName, plan?.name, plan?.productName].map(trim).filter(Boolean).join(' '))
    .filter(Boolean);
  return [
    body.ocrText,
    body.uploadItem?.name,
    manualData.company,
    manualData.name,
    ...planNames,
  ].map(trim).filter(Boolean).join(' ');
}

function rankVisionProductContextCandidates({ state = {}, company = '', hintText = '', limit = 12 } = {}) {
  const normalizedHint = normalizeOcrMappingText(hintText);
  const products = buildKnownProductStats(state, company);
  const candidates = [];

  for (const product of products) {
    if (!isRecoverableOfficialProductName(product.productName)) continue;
    let bestKeyword = '';
    let score = (product.official ? 3 : 0) + Math.min(product.recordCount || 0, 10) / 10;
    if (normalizedHint) {
      const matchedKeyword = productKeywordCandidates(product.productName)
        .filter((keyword) => normalizedHint.includes(keyword.normalized))
        .sort((left, right) => right.normalized.length - left.normalized.length)[0] || null;
      if (matchedKeyword) {
        bestKeyword = matchedKeyword.raw;
        score += matchedKeyword.normalized.length * 2;
      } else if (!company) {
        continue;
      }
    } else if (!company) {
      continue;
    }
    candidates.push({
      company: product.company,
      productName: product.productName,
      ...(product.productType ? { productType: product.productType } : {}),
      ...(product.canonicalProductId ? { canonicalProductId: product.canonicalProductId } : {}),
      ...(bestKeyword ? { keyword: bestKeyword } : {}),
      score,
    });
  }

  return candidates
    .sort((left, right) => right.score - left.score || right.productName.length - left.productName.length)
    .slice(0, limit)
    .map(({ score: _score, ...candidate }) => candidate);
}

export function buildPolicyOcrVisionContext({ state = {}, body = {} } = {}) {
  const manualData = isNonEmptyObject(body.manualData) ? body.manualData : {};
  const hintText = manualPolicyContextText(body);
  const explicitCompany = trim(manualData.company || body.company);
  const inferredCompany = explicitCompany || matchInsuranceCompanyFromOcr(hintText, state)?.company || '';
  const companyHints = [...new Set([explicitCompany, inferredCompany].map(trim).filter(Boolean))];
  const productCandidates = rankVisionProductContextCandidates({
    state,
    company: inferredCompany,
    hintText,
    limit: 12,
  });

  const context = {};
  if (companyHints.length) context.companyHints = companyHints;
  if (productCandidates.length) context.productCandidates = productCandidates;
  return Object.keys(context).length ? context : undefined;
}

function stripLegalInsurerPrefix(value) {
  return trim(value).replace(/^[\p{Script=Han}]{2,24}(?:人寿|财产|养老|健康)?保险(?:股份有限公司|有限责任公司|有限公司)/u, '');
}

function productKeywordCandidates(productName) {
  const keywords = new Map();
  const name = trim(productName);
  const withoutParen = name.replace(/（[^）]*）|\([^)]*\)/gu, '');
  const beforeClause = withoutParen.replace(/(?:产品条款|保险条款|条款|说明书)$/u, '');
  for (const value of [name, withoutParen, beforeClause]) {
    const normalized = normalizeOcrMappingText(value);
    if (normalized.length >= 3) keywords.set(normalized, trim(value));
    const stripped = stripLegalInsurerPrefix(value);
    const strippedNormalized = normalizeOcrMappingText(stripped);
    if (strippedNormalized.length >= 3) keywords.set(strippedNormalized, stripped);
  }
  return [...keywords.entries()].map(([normalized, raw]) => ({ normalized, raw }));
}

function isRecoverableOfficialProductName(productName = '') {
  const text = trim(productName);
  const normalized = normalizeOcrMappingText(text);
  if (!normalized) return false;
  if (!/(保险|寿险|年金|万能|两全|重疾|疾病|医疗|意外|护理)/u.test(text)) return false;
  if (/保险责任名称|责任名称|金额\/?份数|给付标准|免赔额|赔付比例|接第\d+页/u.test(text)) return false;
  return true;
}

export function matchInsuranceProductFromOcr(ocrText, state = {}, company = '') {
  const normalizedOcr = normalizeOcrMappingText(ocrText);
  if (!normalizedOcr) return null;

  const matches = [];
  for (const product of buildKnownProductStats(state, company)) {
    for (const keyword of productKeywordCandidates(product.productName)) {
      if (!normalizedOcr.includes(keyword.normalized)) continue;
      matches.push({
        company: product.company,
        productName: product.productName,
        ...(product.productType ? { productType: product.productType } : {}),
        ...(product.canonicalProductId ? { canonicalProductId: product.canonicalProductId } : {}),
        keyword: keyword.raw,
        score: keyword.normalized.length * 2 + Math.min(product.recordCount, 20) / 10,
      });
    }
  }

  matches.sort((left, right) => right.score - left.score || right.keyword.length - left.keyword.length || right.productName.length - left.productName.length);
  const best = matches[0] || null;
  const secondDifferent = matches.find((item) => item.productName !== best?.productName);
  if (!best || best.score < 6) return null;
  if (secondDifferent && best.score - secondDifferent.score < 1) return null;
  return best;
}

function inferCompanyFromProductPlans({ plans = [], ocrText = '', state = {} }) {
  const normalizedPlans = normalizePolicyPlans(plans, '');
  const matches = normalizedPlans
    .map((plan) => findBestProductMatchForName(ocrText, state, '', plan.name))
    .filter((match) => match?.company && match?.productName);
  if (!matches.length) return null;
  const companyCounts = new Map();
  for (const match of matches) {
    const key = normalizeOcrMappingText(match.company);
    const current = companyCounts.get(key) || { company: match.company, count: 0, score: 0 };
    current.count += 1;
    current.score += Number(match.score || 0);
    companyCounts.set(key, current);
  }
  const ranked = [...companyCounts.values()].sort((left, right) => right.count - left.count || right.score - left.score);
  return ranked[0]?.company ? { company: ranked[0].company } : null;
}

function normalizePaymentPeriod(value) {
  const text = trim(value).replace(/\s+/gu, '');
  if (!text) return '';
  if (/^(趸交|一次交清|一次性交清|一次性交费|一次性缴清)$/u.test(text)) return '趸交';
  const yearPay = text.match(/^(\d{1,3})年(?:交|缴)$/u);
  if (yearPay?.[1]) return `${yearPay[1]}年交`;
  const splitPay = text.match(/^(年交|年缴|月交|月缴|季交|季缴|半年交|半年缴)\/?(\d{1,3})年$/u);
  if (splitPay?.[1] && splitPay?.[2]) {
    const mode = splitPay[1].replace('缴', '交');
    return mode === '年交' ? `${splitPay[2]}年交` : `${splitPay[2]}年${mode}`;
  }
  return '';
}

function paymentModeFromPaymentPeriod(value) {
  const text = normalizePaymentPeriod(value) || trim(value).replace(/\s+/gu, '');
  if (!text) return '';
  if (text === '趸交') return '趸交';
  if (/年交$/u.test(text)) return '年交';
  if (/月交$/u.test(text)) return '月交';
  if (/季交$/u.test(text)) return '季交';
  if (/半年交$/u.test(text)) return '半年交';
  return '';
}

function normalizePolicyPlanRole(value, index, name) {
  const text = normalizeOcrMappingText(`${value || ''}${name || ''}`);
  if (/万能型|万能账户|万能险|最低保证利率|账户价值/u.test(text)) return 'linked_account';
  if (/附加/u.test(text)) return 'rider';
  if (['main', 'rider', 'linked_account', 'unknown'].includes(String(value || ''))) return String(value);
  return index === 0 ? 'main' : 'rider';
}

function normalizePlanAmount(value) {
  const text = trim(value).replace(/[,，\s¥￥元圆]/gu, '');
  if (!text) return '';
  const matched = text.match(/(\d+(?:\.\d+)?)(万|亿)?/u);
  if (!matched?.[1]) return '';
  const base = Number(matched[1]);
  if (!Number.isFinite(base)) return '';
  const multiplier = matched[2] === '亿' ? 100000000 : matched[2] === '万' ? 10000 : 1;
  return String(Math.round(base * multiplier));
}

function normalizePlanBenefitRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      responsibilityName: trim(row?.responsibilityName),
      amountText: trim(row?.amountText),
      amount: normalizePlanAmount(row?.amount),
      premium: normalizePlanAmount(row?.premium),
      coveragePeriod: normalizeCoveragePeriod(row?.coveragePeriod),
      paymentMode: trim(row?.paymentMode),
      paymentPeriod: normalizePaymentPeriod(row?.paymentPeriod) || trim(row?.paymentPeriod),
      paymentBasis: trim(row?.paymentBasis),
      benefitStandard: trim(row?.benefitStandard),
      deductible: trim(row?.deductible),
      ratio: trim(row?.ratio),
      evidence: trim(row?.evidence),
    }))
    .filter((row) => Object.values(row).some(Boolean));
}

function normalizePolicyPlan(plan = {}, index = 0, company = '') {
  const name = trim(plan.matchedProductName || plan.name || plan.productName);
  const rawName = trim(plan.name || plan.productName || name);
  if (!name && !rawName) return null;
  const normalized = {
    company: trim(plan.company) || company,
    role: normalizePolicyPlanRole(plan.role, index, rawName || name),
    name: rawName || name,
    matchedProductName: trim(plan.matchedProductName),
    productType: trim(plan.productType),
    amount: normalizePlanAmount(plan.amount),
    coveragePeriod: normalizeCoveragePeriod(plan.coveragePeriod),
    paymentMode: trim(plan.paymentMode),
    paymentPeriod: normalizePaymentPeriod(plan.paymentPeriod) || trim(plan.paymentPeriod),
    premium: normalizePlanAmount(plan.premium || plan.firstPremium),
    premiumText: trim(plan.premiumText),
    matchScore: Number(plan.matchScore || 0) || 0,
    matchReason: trim(plan.matchReason),
    canonicalProductId: trim(plan.canonicalProductId),
  };
  const benefitRows = normalizePlanBenefitRows(plan.benefitRows);
  if (benefitRows.length) normalized.benefitRows = benefitRows;
  return normalized;
}

function normalizePolicyPlans(plans = [], company = '') {
  return (Array.isArray(plans) ? plans : [])
    .map((plan, index) => normalizePolicyPlan(plan, index, company))
    .filter(Boolean)
    .filter((plan) => shouldKeepPolicyPlan(plan));
}

function countMissingCorePlanValues(plans = []) {
  return normalizePolicyPlans(plans).reduce((count, plan) => {
    const role = normalizePolicyPlanRole(plan.role, 0, plan.name);
    if (role === 'linked_account') return count;
    return count + (plan.amount ? 0 : 1) + (plan.premium ? 0 : 1);
  }, 0);
}

function countCompleteCorePlans(plans = []) {
  return normalizePolicyPlans(plans).filter((plan) => {
    const role = normalizePolicyPlanRole(plan.role, 0, plan.name);
    return role !== 'linked_account' && Boolean(plan.name && plan.amount && plan.premium);
  }).length;
}

function shouldUseOcrTextPlans(currentPlans = [], extractedPlans = []) {
  const current = normalizePolicyPlans(currentPlans);
  const extracted = normalizePolicyPlans(extractedPlans);
  if (!extracted.length) return false;
  if (!current.length) return true;

  const currentMissing = countMissingCorePlanValues(current);
  const extractedMissing = countMissingCorePlanValues(extracted);
  if (extractedMissing < currentMissing) return true;

  const currentComplete = countCompleteCorePlans(current);
  const extractedComplete = countCompleteCorePlans(extracted);
  return extractedComplete > currentComplete && extractedMissing <= currentMissing;
}

const PLAN_DERIVED_TOP_LEVEL_FIELDS = new Set([
  'amount',
  'coveragePeriod',
  'paymentMode',
  'paymentPeriod',
  'firstPremium',
]);

const NOISY_PERSON_FIELDS = new Set(['applicant', 'insured', 'beneficiary']);

function mergeExtractedPolicyData(currentData = {}, extractedData = {}, { preferPlanDerivedFields = false } = {}) {
  const merged = { ...currentData };
  let changed = false;
  for (const [field, value] of Object.entries(extractedData)) {
    if (field === 'plans' || field === 'fieldEvidence' || field === 'fieldConfidence') continue;
    if (Array.isArray(value)) continue;
    if (value && typeof value === 'object') continue;
    if (preferPlanDerivedFields && PLAN_DERIVED_TOP_LEVEL_FIELDS.has(field) && trim(value)) {
      if (trim(merged[field]) !== trim(value)) {
        merged[field] = value;
        changed = true;
      }
      continue;
    }
    if (
      NOISY_PERSON_FIELDS.has(field)
      && trim(value)
      && (shouldReplaceNoisyPersonValue(merged[field], value) || isIdentityOnlyPersonPlaceholder(merged[field]))
    ) {
      if (trim(merged[field]) !== trim(value)) {
        merged[field] = value;
        changed = true;
      }
      continue;
    }
    if (!trim(merged[field]) && trim(value)) {
      merged[field] = value;
      changed = true;
    }
  }

  const currentInsuredName = normalizePersonLikeOcrValue(currentData.insured);
  const extractedInsuredName = normalizePersonLikeOcrValue(extractedData.insured);
  const extractedInsuredId = normalizeIdNumber(extractedData.insuredIdNumber);
  const currentInsuredId = normalizeIdNumber(currentData.insuredIdNumber);
  const sameInsured = extractedInsuredName && (!currentInsuredName || currentInsuredName === extractedInsuredName);
  let insuredIdChanged = false;
  if (sameInsured && extractedInsuredId && extractedInsuredId !== currentInsuredId) {
    merged.insuredIdNumber = extractedInsuredId;
    changed = true;
    insuredIdChanged = true;
  }
  const extractedBirthday = trim(extractedData.insuredBirthday);
  const currentBirthday = trim(currentData.insuredBirthday);
  if (
    sameInsured
    && extractedBirthday
    && extractedBirthday !== currentBirthday
    && (insuredIdChanged || !currentBirthday || currentBirthday === birthdayFromIdNumber(currentInsuredId))
  ) {
    merged.insuredBirthday = extractedBirthday;
    changed = true;
  }

  return { data: merged, changed };
}

export function repairPolicyScanDataFromOcrText(scan = {}) {
  const sourceScan = scan && typeof scan === 'object' ? scan : {};
  const ocrText = trim(sourceScan.ocrText);
  if (!ocrText) return sourceScan;

  const currentData = sourceScan.data && typeof sourceScan.data === 'object' ? sourceScan.data : {};
  const extractedData = extractPolicyFieldsFromText(ocrText);
  const extractedPlans = Array.isArray(extractedData?.plans) ? extractedData.plans : [];
  const currentPlans = Array.isArray(currentData?.plans) ? currentData.plans : [];
  const useExtractedPlans = shouldUseOcrTextPlans(currentPlans, extractedPlans);
  const repaired = mergeExtractedPolicyData(currentData, extractedData, {
    preferPlanDerivedFields: useExtractedPlans,
  });
  const repairedData = repaired.data;
  if (useExtractedPlans) repairedData.plans = extractedPlans;

  if (!useExtractedPlans && !repaired.changed) return sourceScan;
  if (useExtractedPlans && currentPlans.length) {
    console.info('[policy-ocr-mapping] repaired plans from OCR text', {
      currentPlanCount: currentPlans.length,
      extractedPlanCount: extractedPlans.length,
      currentMissingCoreValues: countMissingCorePlanValues(currentPlans),
      extractedMissingCoreValues: countMissingCorePlanValues(extractedPlans),
    });
  }

  return {
    ...sourceScan,
    data: repairedData,
  };
}

function chooseMatchedProductType(planType, matchedType) {
  const current = trim(planType);
  const matched = trim(matchedType);
  if (!matched) return current;
  if (!current) return matched;
  if (current === '增额终身寿险' && /^(?:寿险|终身寿险)$/u.test(matched)) return matched;
  return current;
}

function hasMainPolicyPlan(plans = []) {
  return (Array.isArray(plans) ? plans : []).some((plan) => normalizePolicyPlanRole(plan?.role, 0, plan?.name) === 'main');
}

function inferRecoveredProductRole(productName = '', plans = []) {
  const text = normalizeOcrMappingText(productName);
  if (/万能型|万能账户|万能险|最低保证利率|账户价值/u.test(text)) return 'linked_account';
  if (/附加/u.test(text)) return 'rider';
  return hasMainPolicyPlan(plans) ? 'rider' : 'main';
}

function inferIntrinsicOfficialProductRole(productName = '') {
  const text = normalizeOcrMappingText(productName);
  if (/万能型|万能账户|万能险|最低保证利率|账户价值/u.test(text)) return 'linked_account';
  if (/附加/u.test(text)) return 'rider';
  return '';
}

function orderPolicyPlans(plans = []) {
  const rankPlan = (plan) => {
    const role = normalizePolicyPlanRole(plan?.role, 0, plan?.name);
    if (role === 'main') return 0;
    if (role === 'rider') return 1;
    if (role === 'linked_account') return 2;
    return 3;
  };
  return (Array.isArray(plans) ? plans : [])
    .map((plan, index) => ({ plan, index }))
    .sort((left, right) => rankPlan(left.plan) - rankPlan(right.plan) || left.index - right.index)
    .map(({ plan }) => plan);
}

function hydrateMappedMainPlanFields(plans = [], data = {}, durations = {}) {
  const hydrated = (Array.isArray(plans) ? plans : []).map((plan) => ({ ...plan }));
  if (!hydrated.length) return hydrated;

  const mainIndex = hydrated.findIndex((plan) => normalizePolicyPlanRole(plan?.role, 0, plan?.name) === 'main');
  const target = hydrated[mainIndex >= 0 ? mainIndex : 0];
  if (!target) return hydrated;

  const amount = normalizePlanAmount(data.amount);
  const coveragePeriod = normalizeCoveragePeriod(data.coveragePeriod) || normalizeCoveragePeriod(durations.coveragePeriod);
  const paymentPeriod = normalizePaymentPeriod(data.paymentPeriod) || normalizePaymentPeriod(durations.paymentPeriod) || trim(data.paymentPeriod);
  const paymentMode = trim(data.paymentMode) || paymentModeFromPaymentPeriod(paymentPeriod);

  if (!target.amount && amount) target.amount = amount;
  if (!target.coveragePeriod && coveragePeriod) target.coveragePeriod = coveragePeriod;
  if (!target.paymentPeriod && paymentPeriod) target.paymentPeriod = paymentPeriod;
  if (!target.paymentMode && paymentMode) target.paymentMode = paymentMode;
  return hydrated;
}

function planMatchesOfficialProduct(plan = {}, productName = '') {
  const productKeywords = new Set(productKeywordCandidates(productName).map((keyword) => keyword.normalized));
  return [plan.matchedProductName, plan.productName, plan.name].some((value) => {
    const normalized = normalizeOcrMappingText(value);
    return Boolean(normalized && productKeywords.has(normalized));
  });
}

function charSimilarity(left = '', right = '') {
  const a = Array.from(normalizeOcrMappingText(left));
  const b = Array.from(normalizeOcrMappingText(right));
  if (!a.length || !b.length) return 0;
  const counts = new Map();
  for (const char of a) counts.set(char, (counts.get(char) || 0) + 1);
  let overlap = 0;
  for (const char of b) {
    const count = counts.get(char) || 0;
    if (!count) continue;
    overlap += 1;
    counts.set(char, count - 1);
  }
  return (overlap * 2) / (a.length + b.length);
}

function officialProductSimilarity(planName = '', productName = '') {
  const normalizedPlan = normalizeOcrMappingText(planName);
  if (!normalizedPlan) return 0;
  let best = 0;
  for (const keyword of productKeywordCandidates(productName)) {
    const normalizedKeyword = keyword.normalized;
    if (!normalizedKeyword) continue;
    if (normalizedPlan === normalizedKeyword) return 1;
    if (normalizedPlan.includes(normalizedKeyword) || normalizedKeyword.includes(normalizedPlan)) {
      best = Math.max(best, Math.min(normalizedPlan.length, normalizedKeyword.length) / Math.max(normalizedPlan.length, normalizedKeyword.length));
      continue;
    }
    best = Math.max(best, charSimilarity(normalizedPlan, normalizedKeyword));
  }
  return best;
}

function findOfficialProductRepairTarget(plans = [], mention = {}) {
  const intrinsicRole = inferIntrinsicOfficialProductRole(mention.productName);
  const candidates = [];
  (Array.isArray(plans) ? plans : []).forEach((plan, index) => {
    if (!plan?.name) return;
    if (plan.matchedProductName || plan.canonicalProductId) return;
    const role = normalizePolicyPlanRole(plan.role, index, plan.name);
    if (intrinsicRole === 'linked_account' && role !== 'linked_account') return;
    if (intrinsicRole === 'rider' && role === 'main') return;
    if (!intrinsicRole && /附加/u.test(plan.name)) return;
    const similarity = officialProductSimilarity(plan.name, mention.productName);
    if (similarity < 0.58) return;
    candidates.push({
      plan,
      role,
      similarity,
      rank: role === 'main' ? 0 : role === 'rider' ? 1 : 2,
      index,
    });
  });
  candidates.sort((left, right) => right.similarity - left.similarity || left.rank - right.rank || left.index - right.index);
  return candidates[0] || null;
}

function applyOfficialProductMentionToPlan(plan = {}, mention = {}, role = '') {
  const displayName = stripLegalInsurerPrefix(mention.keyword || mention.productName);
  const productType = chooseMatchedProductType(plan.productType, mention.productType);
  plan.company = mention.company || plan.company || '';
  plan.role = role || plan.role || '';
  plan.name = displayName || trim(mention.productName) || plan.name;
  plan.matchedProductName = trim(mention.productName);
  if (productType) plan.productType = productType;
  plan.matchScore = Math.max(Number(plan.matchScore || 0) || 0, Number(mention.score || 0) || 0);
  plan.matchReason = plan.matchReason || 'OCR原文官方产品名纠错';
  if (!plan.canonicalProductId && trim(mention.canonicalProductId)) plan.canonicalProductId = trim(mention.canonicalProductId);
  return plan;
}

function findOfficialProductMentionsInOcrText(ocrText = '', state = {}, company = '') {
  const normalizedOcr = normalizeOcrMappingText(ocrText);
  if (!normalizedOcr) return [];

  const candidates = [];
  for (const product of buildKnownProductStats(state, company)) {
    if (!product.official) continue;
    if (!isRecoverableOfficialProductName(product.productName)) continue;
    const matchedKeywords = productKeywordCandidates(product.productName)
      .map((keyword) => ({
        ...keyword,
        matchIndex: findProductKeywordInOcrText(normalizedOcr, keyword.normalized),
      }))
      .filter((keyword) => keyword.matchIndex >= 0)
      .sort((left, right) => right.normalized.length - left.normalized.length || left.matchIndex - right.matchIndex);
    const bestKeyword = matchedKeywords[0] || null;
    if (!bestKeyword) continue;
    candidates.push({
      ...product,
      keyword: bestKeyword.raw,
      keywordNormalized: bestKeyword.normalized,
      matchIndex: bestKeyword.matchIndex,
      score: bestKeyword.normalized.length * 2 + Math.min(product.recordCount, 20) / 10,
    });
  }

  const accepted = [];
  for (const candidate of [...candidates].sort((left, right) => (
    right.keywordNormalized.length - left.keywordNormalized.length ||
    left.matchIndex - right.matchIndex ||
    left.productName.localeCompare(right.productName, 'zh-CN')
  ))) {
    const sameKeywordOtherProduct = candidates.some((item) =>
      item.productName !== candidate.productName && item.keywordNormalized === candidate.keywordNormalized
    );
    if (sameKeywordOtherProduct) continue;
    const shadowedBySpecificProduct = accepted.some((item) =>
      item.productName !== candidate.productName && item.keywordNormalized.includes(candidate.keywordNormalized)
    );
    if (shadowedBySpecificProduct) continue;
    accepted.push(candidate);
  }

  return accepted.sort((left, right) => left.matchIndex - right.matchIndex || right.score - left.score);
}

function findProductKeywordInOcrText(normalizedOcr = '', normalizedKeyword = '') {
  const directIndex = normalizedOcr.indexOf(normalizedKeyword);
  if (directIndex >= 0) return directIndex;
  if (normalizedKeyword.endsWith('保险')) {
    const missingFinalChar = normalizedKeyword.slice(0, -1);
    if (missingFinalChar.length >= 8) return normalizedOcr.indexOf(missingFinalChar);
  }
  return -1;
}

function recoverMissingOfficialProductPlans({ plans = [], ocrText = '', state = {}, company = '' } = {}) {
  const recovered = [...plans];
  for (const mention of findOfficialProductMentionsInOcrText(ocrText, state, company)) {
    const existing = recovered.find((plan) => planMatchesOfficialProduct(plan, mention.productName));
    if (existing) {
      const intrinsicRole = inferIntrinsicOfficialProductRole(mention.productName);
      const role = normalizePolicyPlanRole(existing.role, 0, existing.name);
      if (intrinsicRole) {
        existing.role = intrinsicRole;
      } else if (!hasMainPolicyPlan(recovered)) {
        existing.role = 'main';
      } else if (role === 'main') {
        existing.role = 'main';
      }
      applyOfficialProductMentionToPlan(existing, mention, existing.role || role);
      continue;
    }
    const repairTarget = findOfficialProductRepairTarget(recovered, mention);
    if (repairTarget?.plan) {
      applyOfficialProductMentionToPlan(repairTarget.plan, mention, repairTarget.role);
      continue;
    }
    const role = inferRecoveredProductRole(mention.productName, recovered);
    recovered.push({
      company: mention.company || company,
      role,
      name: stripLegalInsurerPrefix(mention.keyword || mention.productName),
      matchedProductName: mention.productName,
      productType: trim(mention.productType),
      amount: '',
      coveragePeriod: '',
      paymentMode: '',
      paymentPeriod: '',
      premium: '',
      premiumText: '',
      matchScore: Number(mention.score || 0) || 0,
      matchReason: 'OCR原文官方产品名匹配',
      canonicalProductId: trim(mention.canonicalProductId),
    });
  }
  return recovered;
}

function findBestProductMatchForName(ocrText, state = {}, company = '', name = '') {
  const product = trim(name);
  if (!product) return null;
  const directText = [company, product].map(trim).filter(Boolean).join(' ');
  return matchInsuranceProductFromOcr(directText, state, company);
}

function attachPlanProductMatches({ plans = [], ocrText = '', state = {}, company = '' }) {
  const normalizedPlans = normalizePolicyPlans(plans, company);
  return normalizedPlans.map((plan) => {
    const match = findBestProductMatchForName(ocrText, state, company, plan.name);
    if (!match?.productName) return plan;
    const canonicalProductId = plan.canonicalProductId || match.canonicalProductId || '';
    const productType = chooseMatchedProductType(plan.productType, match.productType);
    return {
      ...plan,
      company: match.company || plan.company || company,
      matchedProductName: match.productName,
      ...(productType ? { productType } : {}),
      matchScore: Number(match.score || 0) || plan.matchScore || 0,
      matchReason: '本地产品名称匹配',
      ...(canonicalProductId ? { canonicalProductId } : {}),
    };
  });
}

const EVIDENCE_VALUE_FIELDS = new Set([
  'company',
  'name',
  'applicant',
  'beneficiary',
  'policyNumber',
  'insured',
  'insuredIdNumber',
  'insuredBirthday',
  'date',
  'paymentPeriod',
  'coveragePeriod',
  'amount',
  'firstPremium',
]);

function compactEvidenceValue(value) {
  return trim(value).replace(/\s+/gu, '');
}

function fieldEvidenceMatchesMappedValue(item, value) {
  const expected = compactEvidenceValue(value);
  if (!expected) return false;
  const evidenceValue = compactEvidenceValue(item?.value);
  if (evidenceValue && evidenceValue === expected) return true;
  const rowText = compactEvidenceValue(item?.rowText);
  return Boolean(rowText && rowText.includes(expected));
}

function filterFieldEvidenceForMappedData(sourceScan = {}, mappedData = {}) {
  const sourceEvidence = sourceScan.fieldEvidence && typeof sourceScan.fieldEvidence === 'object'
    ? sourceScan.fieldEvidence
    : null;
  if (!sourceEvidence) return {};

  const fieldEvidence = {};
  const fieldConfidence = {};
  const sourceConfidence = sourceScan.fieldConfidence && typeof sourceScan.fieldConfidence === 'object'
    ? sourceScan.fieldConfidence
    : {};

  for (const [field, item] of Object.entries(sourceEvidence)) {
    if (!EVIDENCE_VALUE_FIELDS.has(field) || fieldEvidenceMatchesMappedValue(item, mappedData[field])) {
      fieldEvidence[field] = item;
      if (sourceConfidence[field]) fieldConfidence[field] = sourceConfidence[field];
    }
  }

  return {
    ...(Object.keys(fieldEvidence).length ? { fieldEvidence } : {}),
    ...(Object.keys(fieldConfidence).length ? { fieldConfidence } : {}),
  };
}

function formatNumericAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  const rounded = Math.round(amount * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/\.?0+$/u, '');
}

function sumPlanPremiums(plans = []) {
  const premiums = plans
    .map((plan) => Number(normalizePlanAmount(plan?.premium || plan?.firstPremium)))
    .filter((amount) => Number.isFinite(amount) && amount > 0);
  if (!premiums.length) return '';
  return formatNumericAmount(premiums.reduce((total, amount) => total + amount, 0));
}

function chooseFirstPremium(dataPremium, planPremiumTotal) {
  const dataAmount = Number(normalizePlanAmount(dataPremium));
  const planAmount = Number(normalizePlanAmount(planPremiumTotal));
  const validData = Number.isFinite(dataAmount) && dataAmount > 0;
  const validPlan = Number.isFinite(planAmount) && planAmount > 0;
  if (validData && validPlan) return formatNumericAmount(Math.max(dataAmount, planAmount));
  if (validData) return formatNumericAmount(dataAmount);
  if (validPlan) return formatNumericAmount(planAmount);
  return '';
}

function chooseMappedPolicyName(dataName, mainPlan, productMatch) {
  const matchedName = trim(mainPlan?.matchedProductName || productMatch?.productName);
  if (matchedName) return matchedName;

  const rawDataName = trim(dataName);
  const planName = trim(mainPlan?.name);
  const normalizedDataName = normalizeOcrMappingText(rawDataName);
  const normalizedPlanName = normalizeOcrMappingText(planName);
  if (rawDataName && normalizedPlanName && normalizedDataName.includes(normalizedPlanName)) return rawDataName;
  return planName || rawDataName || trim(productMatch?.productName) || '';
}

function logCompanyMappingDecision({ rawCompany = '', companyMatch = null, inferredCompanyMatch = null, finalCompany = '', mainPlan = null } = {}) {
  const before = trim(rawCompany);
  const matched = trim(companyMatch?.company);
  const inferred = trim(inferredCompanyMatch?.company);
  const final = trim(finalCompany);
  if (!matched && !inferred && before === final) return;
  console.info('[policy-ocr-mapping] company decision', {
    rawCompany: before,
    companyMatch: matched,
    companyKeyword: trim(companyMatch?.keyword),
    inferredCompany: inferred,
    finalCompany: final,
    mainPlanName: trim(mainPlan?.name),
    matchedProductName: trim(mainPlan?.matchedProductName),
  });
}

const OCR_REPAIR_WARNING_LABEL_FIELDS = [
  ['保险公司', 'company'],
  ['投保人', 'applicant'],
  ['受益人', 'beneficiary'],
  ['被保险人', 'insured'],
  ['被保险人生日', 'insuredBirthday'],
  ['投保/生效日期', 'date'],
  ['首期保费', 'firstPremium'],
];

function filterSatisfiedOcrWarnings(warnings = [], data = {}) {
  return (Array.isArray(warnings) ? warnings : [])
    .map((warning) => {
      const text = trim(warning);
      if (!text.includes('仍需确认：')) return text;
      const [prefix, labelsText] = text.split('仍需确认：');
      const labels = labelsText.split('、').map(trim).filter(Boolean);
      const remaining = labels.filter((label) => {
        const field = OCR_REPAIR_WARNING_LABEL_FIELDS.find(([itemLabel]) => itemLabel === label)?.[1] || '';
        return !field || !trim(data[field]);
      });
      return remaining.length ? `${prefix}仍需确认：${remaining.join('、')}` : '';
    })
    .filter(Boolean);
}

function normalizeCoveragePeriod(value) {
  const text = trim(value).replace(/\s+/gu, '');
  if (!text) return '';
  if (text.includes('终身')) return '终身';
  const ageMatched = text.match(/(?:保至|保障至|至)(\d{2,3})周?岁/u);
  if (ageMatched?.[1]) return `至${ageMatched[1]}岁`;
  const yearMatched = text.match(/^(\d{1,3})年$/u);
  if (yearMatched?.[1]) return `${yearMatched[1]}年`;
  const dateMatched = text.match(/至20\d{2}年\d{1,2}月\d{1,2}日(?:零时)?/u);
  return dateMatched?.[0] || '';
}

export function extractDurationFieldsFromOcrText(ocrText) {
  const text = trim(ocrText);
  const compact = text.replace(/\s+/gu, '');
  const directPayment =
    normalizePaymentPeriod(compact.match(/(?:交费期间|缴费期间|交费年期|缴费年期|交费期限|缴费期限)[:：]?([^,，。；;\n]{1,18})/u)?.[1] || '')
    || normalizePaymentPeriod(compact.match(/(\d{1,3}年(?:交|缴)|趸交|一次交清|一次性交清)/u)?.[1] || '');
  const splitPayment = compact.match(/(?:交费方式|缴费方式)[:：]?(年交|年缴|月交|月缴|季交|季缴|半年交|半年缴).*?(?:交费期间|缴费期间|交费年期|缴费年期|交费期限|缴费期限)?[:：]?\/?(\d{1,3})年/u);
  const paymentPeriod = splitPayment?.[1] && splitPayment?.[2]
    ? normalizePaymentPeriod(`${splitPayment[1]}/${splitPayment[2]}年`)
    : directPayment;

  const coveragePeriod =
    normalizeCoveragePeriod(compact.match(/(?:保险期间|保障期间|保险期限|保障期限|合同期限)[:：]?([^,，。；;\n]{1,24})/u)?.[1] || '')
    || normalizeCoveragePeriod(compact.match(/(终身|至\d{2,3}周?岁|保至\d{2,3}周?岁|保障至\d{2,3}周?岁|至20\d{2}年\d{1,2}月\d{1,2}日(?:零时)?)/u)?.[1] || '');

  return {
    paymentPeriod,
    coveragePeriod,
  };
}

export function enhancePolicyScanWithOcrMapping({ scan, state }) {
  const sourceScan = scan && typeof scan === 'object' ? scan : {};
  const data = sourceScan.data && typeof sourceScan.data === 'object' ? sourceScan.data : {};
  const ocrText = trim(sourceScan.ocrText);
  if (!ocrText && !Object.keys(data).length) return sourceScan;

  const companyMatch = matchInsuranceCompanyFromOcr(ocrText, state);
  const inferredCompanyMatch =
    companyMatch || (trim(data.company) ? null : inferCompanyFromProductPlans({ plans: data.plans, ocrText, state }));
  const company = companyMatch?.company || trim(data.company) || inferredCompanyMatch?.company || '';
  const plans = recoverMissingOfficialProductPlans({
    plans: attachPlanProductMatches({
      plans: data.plans,
      ocrText,
      state,
      company,
    }),
    ocrText,
    state,
    company,
  });
  const durations = extractDurationFieldsFromOcrText(ocrText);
  const orderedPlans = hydrateMappedMainPlanFields(orderPolicyPlans(plans), data, durations);
  const mainPlan = orderedPlans.find((plan) => plan.role === 'main') || orderedPlans[0] || null;
  logCompanyMappingDecision({
    rawCompany: data.company,
    companyMatch,
    inferredCompanyMatch,
    finalCompany: company,
    mainPlan,
  });
  const productMatch = company
    ? findBestProductMatchForName(ocrText, state, company, mainPlan?.name || data.name) || matchInsuranceProductFromOcr(ocrText, state, company)
    : null;
  const canonicalProductId = mainPlan?.canonicalProductId || productMatch?.canonicalProductId || '';
  const planPremiumTotal = sumPlanPremiums(orderedPlans);
  const insuredIdentity = data.insuredIdNumber
    ? {
        insuredIdNumber: normalizeIdNumber(data.insuredIdNumber),
        insuredBirthday: data.insuredBirthday || birthdayFromIdNumber(data.insuredIdNumber),
      }
    : extractInsuredIdentityFromOcrText(ocrText, data.insured);

  const mappedData = {
    ...data,
    company: company || data.company || '',
    name: chooseMappedPolicyName(data.name, mainPlan, productMatch),
    insuredIdNumber: insuredIdentity.insuredIdNumber || data.insuredIdNumber || '',
    insuredBirthday: data.insuredBirthday || insuredIdentity.insuredBirthday || '',
    paymentPeriod: mainPlan?.paymentPeriod || durations.paymentPeriod || data.paymentPeriod || '',
    coveragePeriod: mainPlan?.coveragePeriod || durations.coveragePeriod || data.coveragePeriod || '',
    amount: mainPlan?.amount || data.amount || '',
    firstPremium: chooseFirstPremium(data.firstPremium, planPremiumTotal),
    ...(canonicalProductId ? { canonicalProductId } : {}),
    ...(orderedPlans.length ? { plans: orderedPlans } : {}),
  };
  const mappedEvidence = filterFieldEvidenceForMappedData(sourceScan, mappedData);

  return {
    ...sourceScan,
    data: mappedData,
    ...mappedEvidence,
    ...(sourceScan.ocrWarnings ? { ocrWarnings: filterSatisfiedOcrWarnings(sourceScan.ocrWarnings, mappedData) } : {}),
  };
}
