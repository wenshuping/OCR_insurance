import crypto from 'node:crypto';

export function createInitialState() {
  return {
    users: [],
    sessions: [],
    adminSessions: [],
    smsCodes: [],
    policies: [],
    pendingScans: [],
    sourceRecords: [],
    knowledgeRecords: [],
    insuranceIndicatorRecords: [],
    nextId: 1,
  };
}

export function allocateId(state) {
  const id = Number(state.nextId || 1);
  state.nextId = id + 1;
  return id;
}

export function normalizeMobile(value) {
  return String(value || '').trim();
}

export function normalizeSmsCode(value) {
  return String(value || '')
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10))
    .replace(/[^\d]/g, '')
    .slice(0, 6);
}

export function assertValidMobile(mobile) {
  if (!/^1[3-9]\d{9}$/.test(normalizeMobile(mobile))) {
    const error = new Error('INVALID_MOBILE');
    error.status = 400;
    throw error;
  }
}

export function normalizeGuestId(value) {
  return String(value || '').trim().slice(0, 120);
}

export function normalizePolicyRelation(value) {
  const text = String(value || '').trim();
  if (['父亲', '母亲', '爸爸', '妈妈'].includes(text)) return '父母';
  if (['儿子', '女儿', '孩子'].includes(text)) return '子女';
  if (['配偶', '丈夫', '妻子', '先生', '太太'].includes(text)) return '夫妻';
  return ['本人', '子女', '父母', '夫妻'].includes(text) ? text : '';
}

export function normalizeIdNumber(value) {
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

export function birthdayFromIdNumber(value) {
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

export function normalizeDateOnly(value) {
  const matched = String(value || '').match(/(19\d{2}|20\d{2})[年./-]?(\d{1,2})[月./-]?(\d{1,2})/u);
  if (!matched) return '';
  const year = matched[1];
  const month = matched[2].padStart(2, '0');
  const day = matched[3].padStart(2, '0');
  return isValidDateParts(year, month, day) ? `${year}-${month}-${day}` : '';
}

export function normalizeBeneficiary(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const text = raw
    .replace(/\s+/gu, '')
    .replace(/^(身故保险金受益人|身故受益人|受益人)[:：]?/u, '');
  if (/^(?:被保险人的?)?法定(?:继承人|受益人)?$/u.test(text)) return '法定';
  return raw;
}

export function normalizePolicyScanData(data = {}) {
  const insuredIdNumber = normalizeIdNumber(data.insuredIdNumber || data.insuredIdentityNumber || data.insuredIdCard);
  return {
    company: String(data.company || '').trim() || '待补充保险公司',
    name: String(data.name || '').trim() || '未命名保单',
    applicant: String(data.applicant || '').trim(),
    beneficiary: normalizeBeneficiary(data.beneficiary),
    applicantRelation: normalizePolicyRelation(data.applicantRelation),
    insured: String(data.insured || '').trim(),
    insuredRelation: normalizePolicyRelation(data.insuredRelation),
    insuredIdNumber,
    insuredBirthday: normalizeDateOnly(data.insuredBirthday || data.insuredBirthDate) || birthdayFromIdNumber(insuredIdNumber),
    date: String(data.date || '').trim(),
    paymentPeriod: String(data.paymentPeriod || '').trim(),
    coveragePeriod: String(data.coveragePeriod || '').trim(),
    amount: Number(data.amount || 0) || 0,
    firstPremium: Number(data.firstPremium || 0) || 0,
  };
}

function normalizePolicyPlanRole(value, index, name) {
  const role = String(value || '').trim();
  const text = `${role}${name || ''}`;
  if (/万能型|万能账户|万能险|最低保证利率|账户价值/u.test(text)) return 'linked_account';
  if (/附加/u.test(text)) return 'rider';
  if (['main', 'rider', 'linked_account', 'unknown'].includes(role)) return role;
  return index === 0 ? 'main' : 'rider';
}

export function normalizePolicyPlans(plans = [], company = '') {
  return (Array.isArray(plans) ? plans : [])
    .map((plan, index) => {
      const name = String(plan?.name || plan?.productName || plan?.matchedProductName || '').trim();
      const matchedProductName = String(plan?.matchedProductName || '').trim();
      const effectiveName = matchedProductName || name;
      if (!effectiveName) return null;
      return {
        company: String(plan?.company || company || '').trim(),
        role: normalizePolicyPlanRole(plan?.role, index, name || effectiveName),
        name: name || effectiveName,
        matchedProductName,
        productType: String(plan?.productType || '').trim(),
        amount: Number(plan?.amount || 0) || 0,
        coveragePeriod: String(plan?.coveragePeriod || '').trim(),
        paymentMode: String(plan?.paymentMode || '').trim(),
        paymentPeriod: String(plan?.paymentPeriod || '').trim(),
        premium: Number(plan?.premium || plan?.firstPremium || 0) || 0,
        premiumText: String(plan?.premiumText || '').trim(),
        matchScore: Number(plan?.matchScore || 0) || 0,
        matchReason: String(plan?.matchReason || '').trim(),
      };
    })
    .filter(Boolean);
}

function normalizeLookupText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .trim();
}

function dedupePolicyIndicatorRows(rows = []) {
  const seen = new Set();
  const result = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = [
      row?.id,
      row?.company,
      row?.productName,
      row?.coverageType,
      row?.liability,
      row?.valueText ?? row?.value,
      row?.unit,
      row?.basis,
      row?.formulaText,
    ].map((value) => String(value ?? '')).join('\u001f');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

export function policyProductIndicatorKeys(policy = {}) {
  const keys = [];
  const add = (company, productName) => {
    const normalizedCompany = normalizeLookupText(company || policy.company);
    const normalizedProductName = normalizeLookupText(productName);
    if (!normalizedProductName) return;
    const key = `${normalizedCompany}\u001f${normalizedProductName}`;
    if (!keys.includes(key)) keys.push(key);
  };

  add(policy.company, policy.name);
  for (const plan of Array.isArray(policy.plans) ? policy.plans : []) {
    const company = plan?.company || policy.company;
    add(company, plan?.matchedProductName);
    add(company, plan?.productName);
    add(company, plan?.name);
  }
  return keys;
}

export function findPolicyCoverageIndicators(policy = {}, indicatorRecords = []) {
  const keys = new Set(policyProductIndicatorKeys(policy));
  if (!keys.size) return [];
  return dedupePolicyIndicatorRows(
    (Array.isArray(indicatorRecords) ? indicatorRecords : []).filter((record) =>
      keys.has(`${normalizeLookupText(record?.company)}\u001f${normalizeLookupText(record?.productName)}`),
    ),
  );
}

export function attachPolicyCoverageIndicators(policy = {}, indicatorRecords = []) {
  return {
    ...policy,
    coverageIndicators: findPolicyCoverageIndicators(policy, indicatorRecords),
  };
}

export function attachPoliciesCoverageIndicators(policies = [], indicatorRecords = []) {
  return (Array.isArray(policies) ? policies : []).map((policy) => attachPolicyCoverageIndicators(policy, indicatorRecords));
}

export function normalizePolicySources(sources = []) {
  return (Array.isArray(sources) ? sources : [])
    .map((source) => ({
      company: String(source?.company || '').trim(),
      productName: String(source?.productName || source?.name || '').trim(),
      title: String(source?.title || '').trim(),
      url: String(source?.url || '').trim(),
      snippet: String(source?.snippet || '').trim(),
      evidenceLabel: String(source?.evidenceLabel || '').trim(),
      evidenceLevel: String(source?.evidenceLevel || '').trim(),
      official: Boolean(source?.official),
      sourceType: String(source?.sourceType || '').trim(),
    }))
    .filter((source) => source.url)
    .slice(0, 12);
}

export function buildPolicyFromScan({ state, userId = null, guestId = '', scan, analysis }) {
  const data = normalizePolicyScanData(scan?.data || {});
  const plans = normalizePolicyPlans(scan?.data?.plans, data.company);
  const now = new Date().toISOString();
  const hasAnalysis = Boolean(analysis?.report || analysis?.coverageTable?.length);
  const responsibilities = Array.isArray(analysis?.coverageTable)
    ? analysis.coverageTable.map((row) => ({
        coverageType: String(row.coverageType || '').trim() || '保险责任',
        scenario: String(row.scenario || '').trim() || '以条款约定为准',
        payout: String(row.payout || '').trim() || '以正式条款为准',
        note: String(row.note || '').trim(),
      }))
    : [];

  return {
    id: allocateId(state),
    userId: userId ? Number(userId) : null,
    guestId: userId ? '' : normalizeGuestId(guestId),
    company: data.company,
    name: data.name,
    applicant: data.applicant,
    beneficiary: data.beneficiary,
    applicantRelation: data.applicantRelation,
    insured: data.insured,
    insuredRelation: data.insuredRelation,
    insuredIdNumber: data.insuredIdNumber,
    insuredBirthday: data.insuredBirthday,
    date: data.date,
    paymentPeriod: data.paymentPeriod,
    coveragePeriod: data.coveragePeriod,
    amount: data.amount,
    firstPremium: data.firstPremium,
    plans,
    ocrText: String(scan?.ocrText || '').trim(),
    responsibilities,
    report: String(analysis?.report || '').trim(),
    sources: normalizePolicySources(analysis?.sources),
    reportStatus: hasAnalysis ? 'ready' : 'generating',
    reportError: '',
    createdAt: now,
    updatedAt: now,
  };
}

export function findSessionUser(state, token) {
  const normalized = String(token || '').trim();
  if (!normalized) return null;
  const session = (state.sessions || []).find((row) => String(row.token || '') === normalized);
  if (!session) return null;
  return (state.users || []).find((row) => Number(row.id) === Number(session.userId)) || null;
}

export function createSession(state, userId) {
  const token = crypto.randomUUID();
  state.sessions.push({
    token,
    userId: Number(userId),
    createdAt: new Date().toISOString(),
  });
  return token;
}

export function deleteSession(state, token) {
  const normalized = String(token || '').trim();
  if (!normalized) return false;
  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  const before = sessions.length;
  state.sessions = sessions.filter((row) => String(row.token || '') !== normalized);
  return state.sessions.length < before;
}

export function getBearerToken(req) {
  const header = String(req.headers.authorization || '').trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

export function latestValidSmsCode(state, { mobile, code }) {
  const normalizedMobile = normalizeMobile(mobile);
  const normalizedCode = normalizeSmsCode(code);
  return [...(state.smsCodes || [])]
    .reverse()
    .find(
      (row) =>
        String(row.mobile || '') === normalizedMobile &&
        normalizeSmsCode(row.code) === normalizedCode &&
        !row.used &&
        new Date(row.expiresAt).getTime() > Date.now(),
    );
}

export function publicUser(user) {
  return {
    id: Number(user.id),
    mobile: String(user.mobile || ''),
    createdAt: user.createdAt,
  };
}
