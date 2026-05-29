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
  const normalizedInsured = compactText(insuredName);
  const candidates = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = compactText(lines[index]);
    const idNumber = normalizeIdNumber(line);
    if (!idNumber) continue;

    let score = 0;
    if (/^(?:证件号码|证件号|身份证号码|身份证号|居民身份证号码|居民身份证号)[:：]?/u.test(line)) score += 5;
    const previousWindow = lines.slice(Math.max(0, index - 3), index).map(compactText).join(' ');
    const nextWindow = lines.slice(index + 1, index + 4).map(compactText).join(' ');
    if (/被保险人|被保人|受保人/u.test(previousWindow) || /被保险人|被保人|受保人/u.test(line)) score += 6;
    if (/投保人|要保人/u.test(previousWindow) || /投保人|要保人/u.test(line)) score -= 3;
    if (normalizedInsured && (previousWindow.includes(normalizedInsured) || line.includes(normalizedInsured) || nextWindow.includes(normalizedInsured))) {
      score += 4;
    }
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
      if (!normalizedOcr.includes(keyword.normalized)) continue;
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
  const addProduct = (recordCompany, productName, weight = 1) => {
    const sourceCompany = trim(recordCompany);
    const name = trim(productName);
    if (!sourceCompany || !name) return;
    if (trim(company) && !companyMatches(sourceCompany, company)) return;
    const key = `${sourceCompany}\u001f${name}`;
    const current = stats.get(key) || { company: sourceCompany, productName: name, recordCount: 0 };
    current.recordCount += weight;
    stats.set(key, current);
  };

  for (const record of state.knowledgeRecords || []) addProduct(record.company, record.productName || record.title, 1);
  for (const policy of state.policies || []) addProduct(policy.company, policy.name, 1);
  return [...stats.values()];
}

function productKeywordCandidates(productName) {
  const keywords = new Map();
  const name = trim(productName);
  const withoutParen = name.replace(/（[^）]*）|\([^)]*\)/gu, '');
  const beforeClause = withoutParen.replace(/(?:产品条款|保险条款|条款|说明书)$/u, '');
  const stripLegalInsurerPrefix = (value) =>
    trim(value).replace(/^[\p{Script=Han}]{2,24}(?:人寿|财产|养老|健康)?保险(?:股份有限公司|有限责任公司|有限公司)/u, '');
  for (const value of [name, withoutParen, beforeClause]) {
    const normalized = normalizeOcrMappingText(value);
    if (normalized.length >= 3) keywords.set(normalized, trim(value));
    const stripped = stripLegalInsurerPrefix(value);
    const strippedNormalized = normalizeOcrMappingText(stripped);
    if (strippedNormalized.length >= 3) keywords.set(strippedNormalized, stripped);
  }
  return [...keywords.entries()].map(([normalized, raw]) => ({ normalized, raw }));
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

function normalizePolicyPlan(plan = {}, index = 0, company = '') {
  const name = trim(plan.matchedProductName || plan.name || plan.productName);
  const rawName = trim(plan.name || plan.productName || name);
  if (!name && !rawName) return null;
  return {
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
  };
}

function normalizePolicyPlans(plans = [], company = '') {
  return (Array.isArray(plans) ? plans : [])
    .map((plan, index) => normalizePolicyPlan(plan, index, company))
    .filter(Boolean);
}

function findBestProductMatchForName(ocrText, state = {}, company = '', name = '') {
  const product = trim(name);
  if (!product) return null;
  const directText = [company, product].map(trim).filter(Boolean).join(' ');
  return matchInsuranceProductFromOcr(directText, state, company) || matchInsuranceProductFromOcr(`${directText} ${ocrText || ''}`, state, company);
}

function attachPlanProductMatches({ plans = [], ocrText = '', state = {}, company = '' }) {
  const normalizedPlans = normalizePolicyPlans(plans, company);
  return normalizedPlans.map((plan) => {
    const match = findBestProductMatchForName(ocrText, state, company, plan.name);
    if (!match?.productName) return plan;
    return {
      ...plan,
      company: match.company || plan.company || company,
      matchedProductName: match.productName,
      matchScore: Number(match.score || 0) || plan.matchScore || 0,
      matchReason: '本地产品名称匹配',
    };
  });
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
  const matchedName = trim(productMatch?.productName || mainPlan?.matchedProductName);
  if (matchedName) return matchedName;

  const rawDataName = trim(dataName);
  const planName = trim(mainPlan?.name);
  const normalizedDataName = normalizeOcrMappingText(rawDataName);
  const normalizedPlanName = normalizeOcrMappingText(planName);
  if (rawDataName && normalizedPlanName && normalizedDataName.includes(normalizedPlanName)) return rawDataName;
  return planName || rawDataName || '';
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
  const plans = attachPlanProductMatches({
    plans: data.plans,
    ocrText,
    state,
    company,
  });
  const mainPlan = plans.find((plan) => plan.role === 'main') || plans[0] || null;
  const productMatch = company
    ? findBestProductMatchForName(ocrText, state, company, mainPlan?.name || data.name) || matchInsuranceProductFromOcr(ocrText, state, company)
    : null;
  const durations = extractDurationFieldsFromOcrText(ocrText);
  const planPremiumTotal = sumPlanPremiums(plans);
  const insuredIdentity = data.insuredIdNumber
    ? {
        insuredIdNumber: normalizeIdNumber(data.insuredIdNumber),
        insuredBirthday: data.insuredBirthday || birthdayFromIdNumber(data.insuredIdNumber),
      }
    : extractInsuredIdentityFromOcrText(ocrText, data.insured);

  return {
    ...sourceScan,
    data: {
      ...data,
      company: company || data.company || '',
      name: chooseMappedPolicyName(data.name, mainPlan, productMatch),
      insuredIdNumber: insuredIdentity.insuredIdNumber || data.insuredIdNumber || '',
      insuredBirthday: data.insuredBirthday || insuredIdentity.insuredBirthday || '',
      paymentPeriod: mainPlan?.paymentPeriod || durations.paymentPeriod || data.paymentPeriod || '',
      coveragePeriod: mainPlan?.coveragePeriod || durations.coveragePeriod || data.coveragePeriod || '',
      amount: mainPlan?.amount || data.amount || '',
      firstPremium: chooseFirstPremium(data.firstPremium, planPremiumTotal),
      ...(plans.length ? { plans } : {}),
    },
  };
}
