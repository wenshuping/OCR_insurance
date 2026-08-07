import { createHash } from 'node:crypto';

import { evaluateIncrementalWholeLifePurpose } from './incremental-whole-life-purpose-evaluator.mjs';

const ACCOUNT_IDENTITY_RE = /(?:万能账户|万能型|万能险|投资连结|投连型|投连险)/u;
const ACCOUNT_BODY_RE = /(?:万能账户|保单账户|投资账户|账户价值|最低保证利率|结算利率|部分领取|追加保险费|一次交清)/u;
const NAVIGATION_RE = /(?:目录|目次|阅读指南|名词解释|释义|产品介绍|宣传|营销|摘要)/u;
const ORDINARY_RESPONSIBILITY_RE = /(?:身故|全残|生存|满期|疾病|医疗|意外|护理|豁免|年金)/u;
const OWNER_PROFILES = new Set(['accident', 'medical', 'disease', 'endowment', 'annuity', 'universal', 'life']);
const PAYMENT_PROFILES = new Set([
  'lump_sum', 'medical_reimbursement', 'daily_allowance', 'annuity', 'waiver',
  'account', 'max_min_comparison',
]);
const TOPOLOGIES = new Set(['standalone', 'rider', 'group', 'bundle']);

function text(value) {
  return String(value ?? '').trim();
}

function plainObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(array(values).map(text).filter(Boolean))];
}

function uniqueValues(values) {
  const seen = new Set();
  return array(values).filter((value) => {
    const key = typeof value === 'string' ? value : JSON.stringify(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isNavigationOnlyText(value) {
  const opening = text(value).slice(0, 180);
  return NAVIGATION_RE.test(opening)
    && !/(?:第\s*[一二三四五六七八九十百千万0-9]+\s*条|本合同|合同约定)/u.test(opening);
}

function digestKey(value) {
  return text(value).replace(/^sha256:/iu, '').toLowerCase();
}

function sourceDigest(value) {
  const raw = text(value);
  return raw ? (raw.startsWith('sha256:') ? raw : `sha256:${raw}`) : '';
}

function payloadOf(entry) {
  return plainObject(entry?.payload || entry);
}

function entryCompany(entry) {
  const payload = payloadOf(entry);
  return text(entry?.company || entry?.company_name || payload.company || payload.companyName);
}

function entryProductName(entry) {
  const payload = payloadOf(entry);
  return text(entry?.productName || entry?.product_name || payload.productName || payload.product_name || payload.name);
}

function entryProductKey(entry) {
  const payload = payloadOf(entry);
  return text(entry?.productKey || entry?.product_key || payload.productKey || payload.product_key);
}

function collectDigests(value, result = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectDigests(item, result));
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  for (const [key, nested] of Object.entries(value)) {
    if ((key === 'sourceDigest' || key === 'source_digest' || key === 'responsibilitySourceDigest' || key === 'pdfSha256') && text(nested)) {
      result.push(text(nested));
    }
    collectDigests(nested, result);
  }
  return result;
}

function collectTextValues(value, result = [], path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectTextValues(item, result, [...path, String(index)]));
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  const acceptedKeys = new Set([
    'pageText', 'page_text', 'sourceExcerpt', 'source_excerpt', 'sourceText', 'source_text',
    'officialResponsibilityText', 'official_responsibility_text', 'formulaText', 'formula_text',
    'calculationText', 'calculation_text', 'plainSummary', 'plain_summary', 'payoutSummary',
    'payout_summary', 'customerSummary', 'customer_summary', 'content',
    'mainFunctions', 'importantLimits', 'productFunctions',
  ]);
  for (const [key, nested] of Object.entries(value)) {
    if (acceptedKeys.has(key)) {
      if (typeof nested === 'string' && text(nested)) {
        result.push({ text: text(nested), path: [...path, key] });
      } else if (Array.isArray(nested)) {
        nested.forEach((item, index) => {
          if (typeof item === 'string' && text(item)) {
            result.push({ text: text(item), path: [...path, key, String(index)] });
          }
        });
      }
    }
    collectTextValues(nested, result, [...path, key]);
  }
  return result;
}

function normalizedEntry(entry, kind) {
  const payload = payloadOf(entry);
  return {
    raw: entry,
    payload,
    kind,
    company: entryCompany(entry),
    productName: entryProductName(entry),
    productKey: entryProductKey(entry),
    digests: unique([...collectDigests(entry), ...collectDigests(payload)].map(digestKey)),
    texts: collectTextValues(payload),
    approved: text(payload.audit?.status || payload.approvalStatus || payload.status || entry?.status).toLowerCase() === 'approved',
    official: payload.official !== false && entry?.official !== false,
    sourceType: text(payload.sourceType || payload.source_type || entry?.sourceType || entry?.source_type).toLowerCase(),
    sourceUrl: text(payload.sourceUrl || payload.source_url || payload.url || entry?.sourceUrl || entry?.source_url || entry?.url),
    evidenceLevel: text(payload.evidenceLevel || payload.evidence_level || entry?.evidenceLevel || entry?.evidence_level),
    sourceAcquisition: plainObject(payload.sourceAcquisition || entry?.sourceAcquisition),
  };
}

function canonicalSourceUrl(value, { omitAttachmentType = false } = {}) {
  try {
    const url = new URL(text(value));
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (omitAttachmentType) url.searchParams.delete('attachmentType');
    const sortedParams = [...url.searchParams.entries()]
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
      ));
    url.search = new URLSearchParams(sortedParams).toString();
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function officialMaterialFamilyKey(entry) {
  const digest = entry.digests[0] || '';
  const fallback = digest ? `digest:${digest}` : '';
  try {
    const url = new URL(entry.sourceUrl);
    const planCode = text(url.searchParams.get('planCode'));
    const versionNo = text(url.searchParams.get('versionNo'));
    const attachmentType = text(url.searchParams.get('attachmentType'));
    if (!planCode || !versionNo || !attachmentType) return fallback;
    return `official-material-set:${canonicalSourceUrl(entry.sourceUrl, { omitAttachmentType: true })}`;
  } catch {
    return fallback;
  }
}

function officialMaterialPriority(entry) {
  try {
    return text(new URL(entry.sourceUrl).searchParams.get('attachmentType')) === '1' ? 1 : 0;
  } catch {
    return 0;
  }
}

function matchesScope(entry, { company, productName, productKey }) {
  if (productKey && entry.productKey) return entry.productKey === productKey;
  if (entry.company && entry.company !== company) return false;
  if (entry.productName && entry.productName !== productName) return false;
  return true;
}

function substantiveTextItems(entries) {
  const items = entries.flatMap((entry) => entry.texts.map((item) => ({
    ...item,
    originalText: item.text,
    kind: entry.kind,
    productName: entry.productName,
    sourceDigest: sourceDigest(entry.digests[0]),
    articleBody: /(?:第\s*[一二三四五六七八九十百千万0-9]+\s*条|本合同|合同约定)/u.test(item.text),
  })));
  const preferred = items.filter((item) => item.articleBody && !isNavigationOnlyText(item.text));
  const structuredAccountItems = items.filter((item) => item.kind === 'artifact'
    && item.path.some((segment) => /^(?:mainFunctions|importantLimits|productFunctions)$/u.test(segment))
    && !isNavigationOnlyText(item.text));
  return preferred.length
    ? uniqueValues([...preferred, ...structuredAccountItems])
    : items.filter((item) => !isNavigationOnlyText(item.text));
}

function sentenceFor(textValue, pattern, { preferPattern = null } = {}) {
  const sentences = text(textValue)
    .split(/\r?\n|[。；;！？!?]+|(?<!\d)\.(?!\d)/u)
    .map((item) => item.replace(/[\t\f\v ]+/gu, ' ').trim())
    .filter(Boolean);
  const matches = sentences.filter((sentence) => pattern.test(sentence) && !NAVIGATION_RE.test(sentence));
  const preferredMatches = preferPattern
    ? matches.filter((sentence) => preferPattern.test(sentence))
    : matches;
  const isArticleBody = (sentence) => /(?:第\s*[一二三四五六七八九十百千万0-9]+\s*条|本合同|合同约定)/u.test(sentence);
  return preferredMatches.find(isArticleBody) || preferredMatches[0] || matches.find(isArticleBody) || matches[0] || '';
}

function fieldEvidence(items, pattern, { numeric = false, numericPattern = /\d+(?:\.\d+)?\s*%/u } = {}) {
  const candidates = items
    .map((item) => ({
      ...item,
      excerpt: sentenceFor(item.text, pattern, { preferPattern: numeric ? numericPattern : null }),
    }))
    .filter((item) => item.excerpt);
  const structured = candidates.find((item) => item.path.includes('mainFunctions') || item.path.includes('importantLimits') || item.path.includes('productFunctions'));
  if (!numeric) return structured || candidates[0] || null;
  return (structured && numericPattern.test(structured.excerpt) ? structured : null)
    || candidates.find((item) => numericPattern.test(item.excerpt))
    || candidates[0]
    || null;
}

function rateFromExcerpt(excerpt, pattern = null) {
  const match = text(excerpt).match(pattern || /(\d+(?:\.\d+)?\s*%)/u);
  return match ? match[1].replace(/\s+/gu, '') : '';
}

function clausesFromOfficialText(items, pattern) {
  const clauses = [];
  for (const item of items) {
    const sentences = text(item.text).split(/\r?\n|[。；;！？!?]+|(?<!\d)\.(?!\d)/u);
    for (const sentence of sentences) {
      const normalized = sentence.replace(/[\t\f\v ]+/gu, ' ').trim();
      if (pattern.test(normalized) && !NAVIGATION_RE.test(normalized)) clauses.push(normalized);
    }
  }
  return unique(clauses);
}

function universalFields(items) {
  const fields = {};
  const add = (key, label, pattern, options = {}) => {
    if (options.combine) {
      const excerpts = clausesFromOfficialText(items, pattern);
      if (excerpts.length) {
        fields[key] = {
          label,
          value: excerpts.join(' '),
          sourceExcerpt: excerpts.join(' '),
          sourceDigest: fieldEvidence(items, pattern)?.sourceDigest || '',
        };
        return;
      }
    }
    const evidence = fieldEvidence(items, pattern, {
      ...options,
      numericPattern: options.ratePattern || options.numericPattern,
    });
    if (evidence) fields[key] = {
      label,
      value: options.numeric ? rateFromExcerpt(evidence.excerpt, options.ratePattern) || evidence.excerpt : evidence.excerpt,
      sourceExcerpt: evidence.excerpt,
      sourceDigest: evidence.sourceDigest,
    };
  };
  add('minimumGuaranteedRate', '最低保证利率', /最低保证利率|保证利率/u, { numeric: true, ratePattern: /(?:最低保证利率|保证利率)[^%]{0,80}?(\d+(?:\.\d+)?\s*%)/u });
  add('settlement', '账户结算', /结算(?:利率|频率|方式|方法)|公布.*结算|按月.*结算|按日.*结算/u, { combine: true });
  add('singlePremiumInitialCharge', '趸交/一次交清初始费用', /(?:一次交清|一次性交纳|一次性缴纳|一次性支付|趸交|单笔).*?(?:初始费用|费用|手续费)|(?:初始费用|费用|手续费).*?(?:一次交清|一次性交纳|一次性缴纳|一次性支付|趸交|单笔)/u, { numeric: true, ratePattern: /(?:一次交清|一次性交纳|一次性缴纳|一次性支付|趸交|单笔)[^%]{0,80}?(\d+(?:\.\d+)?\s*%)/u });
  add('additionalPremiumInitialCharge', '追加初始费用', /追加[^。；;，,]{0,80}?(?:初始费用|费用|手续费|\d+(?:\.\d+)?\s*%)|(?:初始费用|费用|手续费)[^。；;，,]{0,80}?追加/u, { numeric: true, ratePattern: /追加[^%]{0,80}?(\d+(?:\.\d+)?\s*%)/u });
  add('managementAndRiskFees', '管理费/风险费', /(?:保单管理费|账户管理费|管理费|风险保险费|风险费|投资管理费)/u, { combine: true });
  add('withdrawalAndSurrenderCharges', '部分领取/退保手续费', /(?:部分领取|部分提取|退保).*?(?:手续费|费用|费率|比例)|(?:手续费|费用|费率|比例).*?(?:部分领取|部分提取|退保)/u);
  add('withdrawalEligibilityAndLimits', '领取/退保条件与限额', /(?:部分领取|部分提取|退保).*?(?:条件|资格|最低|限额|余额|次数|频率|保单年度|犹豫期|申请|效力终止|有效身份证件)|(?:条件|资格|最低|限额|余额|次数|频率|保单年度|犹豫期|申请|效力终止|有效身份证件).*?(?:部分领取|部分提取|退保)/u);
  add('accountValueRule', '账户价值规则', /账户价值.*?(?:等于|计算|扣除|加上|余额|积累|增长)|(?:等于|计算|扣除|加上|余额|积累|增长).*?账户价值/u);
  const rateScheduleAfter = (anchor) => unique(items.flatMap((item) => {
    const body = text(item.originalText || item.text);
    const schedules = [];
    for (const match of body.matchAll(anchor)) {
      const tail = body.slice(Number(match.index || 0), Number(match.index || 0) + 1600);
      const nextClauseIndex = tail.slice(match[0].length).search(/\n\s*第[一二三四五六七八九十百零〇\d]{1,8}条\s*/u);
      const schedule = nextClauseIndex >= 0
        ? tail.slice(0, match[0].length + nextClauseIndex)
        : tail;
      schedules.push(...[...schedule.matchAll(/\d+(?:\.\d+)?\s*%/gu)].map((rate) => rate[0].replace(/\s+/gu, '')));
    }
    return schedules;
  }));
  const partialWithdrawalRates = clausesFromOfficialText(items, /部分领取手续费率|部分领取.*?(?:5\s*%|4\s*%|3\s*%|2\s*%|1\s*%)/u);
  const surrenderRates = clausesFromOfficialText(items, /退保手续费率|退保.*?(?:5\s*%|4\s*%|3\s*%|2\s*%|1\s*%)/u);
  const withdrawalRates = unique([...partialWithdrawalRates, ...surrenderRates]);
  if (withdrawalRates.length) {
    const percentagesFor = (clauses) => unique(clauses.flatMap((clause) => [...clause.matchAll(/\d+(?:\.\d+)?\s*%/gu)].map((match) => match[0].replace(/\s+/gu, ''))));
    const rateParts = [];
    const partialPercentages = unique([
      ...percentagesFor(partialWithdrawalRates),
      ...rateScheduleAfter(/部分领取手续费率/gu),
    ]);
    const surrenderPercentages = unique([
      ...percentagesFor(surrenderRates),
      ...rateScheduleAfter(/退保手续费率/gu),
    ]);
    if (partialPercentages.length) rateParts.push(`部分领取手续费率：${partialPercentages.join(' / ')}`);
    if (surrenderPercentages.length) rateParts.push(`退保手续费率：${surrenderPercentages.join(' / ')}`);
    fields.withdrawalAndSurrenderCharges = {
      label: '部分领取/退保手续费',
      value: rateParts.length ? rateParts.join('；') : withdrawalRates.join(' '),
      sourceExcerpt: withdrawalRates.join(' '),
      sourceDigest: withdrawalRates.length ? fieldEvidence(items, /部分领取手续费/u)?.sourceDigest || '' : '',
    };
  }
  const withdrawalLimits = clausesFromOfficialText(items, /(?:部分领取|个人账户价值).*(?:低于|不得超过|不超过|犹豫期|申请|效力终止|有效身份证件)/u);
  if (withdrawalLimits.length) {
    fields.withdrawalEligibilityAndLimits = {
      label: '领取/退保条件与限额',
      value: withdrawalLimits.join(' '),
      sourceExcerpt: withdrawalLimits.join(' '),
      sourceDigest: fieldEvidence(items, /(?:部分领取|个人账户价值).*(?:低于|不得超过|不超过|犹豫期|申请|效力终止|有效身份证件)/u)?.sourceDigest || '',
    };
  }
  return fields;
}

function accountIdentity(items) {
  return items.find((item) => {
    const body = item.originalText || item.text;
    const productIdentity = text(item.productName);
    return (item.articleBody || item.kind === 'artifact')
      && ACCOUNT_BODY_RE.test(body)
      && (ACCOUNT_IDENTITY_RE.test(body) || ACCOUNT_IDENTITY_RE.test(productIdentity));
  }) || null;
}

function accountContent(fields) {
  return Object.values(fields).map((field) => ({
    title: field.label,
    plainText: field.value,
    sourceRefs: field.sourceDigest ? [field.sourceDigest] : [],
  }));
}

function crossInsuranceFields(items) {
  const fields = {};
  const add = (key, label, pattern) => {
    const excerpts = clausesFromOfficialText(items, pattern);
    if (!excerpts.length) return;
    fields[key] = {
      label,
      value: excerpts.join(' '),
      sourceExcerpt: excerpts.join(' '),
      sourceDigest: fieldEvidence(items, pattern)?.sourceDigest || '',
    };
  };
  add('medicalDeductible', '健康/医疗免赔额', /(?:免赔额|免赔金额|年度免赔)/u);
  add('medicalPaymentRatio', '健康/医疗赔付比例', /(?:医疗|住院|门诊|疾病|费用)[^。；;]{0,100}(?:赔付比例|给付比例|报销比例|按[^。；;]{0,32}%)|(?:赔付比例|给付比例|报销比例)[^。；;]{0,100}(?:医疗|住院|门诊|疾病|费用)/u);
  add('medicalCoverageLimit', '健康/医疗责任限额', /(?:年度(?:累计)?(?:最高)?限额|责任限额|给付限额|报销限额|最高给付金额)/u);
  add('medicalHospitalScope', '健康/医疗医院范围', /(?:医院范围|定点医院|二级及以上医院|指定医院|认可的医院)/u);
  add('medicalWaitingPeriod', '健康/医疗等待期', /等待期/u);
  add('criticalDiseaseGrouping', '重疾疾病分组', /(?:重大疾病|重疾|疾病)[^。；;]{0,80}(?:分组|分为[^。；;]{0,40}组)|(?:分组|组别)[^。；;]{0,80}(?:重大疾病|重疾|疾病)/u);
  add('criticalPaymentCount', '重疾给付次数', /(?:重大疾病|重疾|疾病)[^。；;]{0,80}(?:给付|赔付)[^。；;]{0,30}(?:次数|[一二三四五六七八九十百\d]+\s*次)|(?:给付|赔付)次数[^。；;]{0,60}(?:重大疾病|重疾|疾病)/u);
  add('criticalInterval', '重疾给付间隔期', /(?:间隔期|两次[^。；;]{0,30}间隔|相邻两次[^。；;]{0,30}(?:天|日|年))/u);
  add('criticalPremiumWaiver', '重疾保费豁免', /(?:豁免保险费|保险费豁免|豁免后续[^。；;]{0,20}保险费)/u);
  add('accidentDisabilityGrade', '意外伤残等级', /(?:伤残等级|伤残评定|伤残程度|第[一二三四五六七八九十0-9]+级伤残)/u);
  add('accidentPaymentRatio', '意外伤残给付比例', /(?:伤残[^。；;]{0,50}(?:给付比例|赔付比例)|(?:给付比例|赔付比例)[^。；;]{0,50}伤残)/u);
  add('accidentScenario', '意外保障场景', /(?:交通工具|航空意外|公共交通|驾乘意外|驾乘车|列车|轮船|电梯|自然灾害|步行|骑行)[^。；;]{0,120}(?:意外|保险金|给付|赔付)/u);
  add('effectiveInsuredAmountFormula', '增额寿有效保险金额公式', /(?:有效保险金额|有效保额)[^。；;]{0,180}(?:等于|×|\*|递增|增长|1\s*[+＋]\s*\d+(?:\.\d+)?\s*%)/u);
  add('annuityPaymentFrequency', '年金/两全领取频率', /(?:按月领取|按年领取|每月领取|每年领取|领取频率|领取方式)/u);
  add('annuityMonthlyFactor', '年金月领折算系数', /月领折算系数/u);
  add('maturityBenefit', '年金/两全满期责任', /满期保险金/u);
  return fields;
}

function displayTrustedSourceEntry(entry) {
  if (entry.kind !== 'source' || !entry.official || !entry.digests.length) return false;
  const pdf = entry.sourceType === 'pdf' || /\.pdf(?:$|[?#])/iu.test(entry.sourceUrl);
  if (!pdf) return false;
  return entry.sourceAcquisition.strategy === 'bound_official_pdf'
    || ['insurer_official', 'regulatory_industry_terms'].includes(entry.evidenceLevel);
}

function buildFieldEvidenceDisplay(entries, alignedChains) {
  const trustedSources = entries.filter(displayTrustedSourceEntry);
  const trustedFamilies = unique(trustedSources.map(officialMaterialFamilyKey));
  const trustedSourceSlots = new Map();
  for (const entry of trustedSources) {
    const slot = canonicalSourceUrl(entry.sourceUrl) || `digest:${entry.digests[0] || ''}`;
    trustedSourceSlots.set(slot, unique([...(trustedSourceSlots.get(slot) || []), ...entry.digests]));
  }
  const duplicateMaterialConflict = [...trustedSourceSlots.values()].some((digests) => digests.length > 1);
  const alignedDigests = unique(alignedChains.map((chain) => digestKey(chain.digest)));
  if ((trustedFamilies.length ? trustedFamilies.length > 1 || duplicateMaterialConflict : alignedDigests.length > 1)) {
    return {
      status: 'version_conflict',
      mode: 'blocked',
      persistenceStatus: 'persistence-not-aligned',
      calculationEligible: false,
      sourceDigest: '',
      fields: {},
      productFunctions: [],
      blockers: ['version_conflict'],
    };
  }
  const selectedSources = trustedSources
    .filter((entry) => !trustedFamilies.length || officialMaterialFamilyKey(entry) === trustedFamilies[0])
    .sort((left, right) => officialMaterialPriority(right) - officialMaterialPriority(left));
  const selectedDigests = trustedFamilies.length
    ? unique(selectedSources.flatMap((entry) => entry.digests))
    : alignedDigests;
  const selectedDigest = selectedSources[0]?.digests[0] || selectedDigests[0] || '';
  if (!selectedDigest) {
    return {
      status: 'not_detected',
      mode: '',
      persistenceStatus: 'persistence-not-aligned',
      calculationEligible: false,
      sourceDigest: '',
      fields: {},
      productFunctions: [],
      blockers: [],
    };
  }
  const selectedEntries = entries.filter((entry) => entry.digests.some((digest) => selectedDigests.includes(digest)));
  const items = substantiveTextItems(selectedEntries);
  const fields = { ...crossInsuranceFields(items), ...universalFields(items) };
  const aligned = selectedEntries.some((entry) => entry.kind === 'artifact')
    && selectedEntries.some((entry) => entry.kind === 'card')
    && selectedEntries.some((entry) => entry.kind === 'indicator');
  return {
    status: Object.keys(fields).length ? (aligned ? 'aligned' : 'display_only') : 'not_detected',
    mode: Object.keys(fields).length ? (aligned ? 'aligned' : 'display-only') : '',
    persistenceStatus: aligned ? 'aligned' : 'persistence-not-aligned',
    calculationEligible: false,
    sourceDigest: sourceDigest(selectedDigest),
    fields,
    productFunctions: accountContent(fields),
    blockers: aligned || !Object.keys(fields).length ? [] : ['source_chain_not_aligned'],
    universalIdentity: Boolean(accountIdentity(items)),
  };
}

function accountEvaluation({ sourceDigest: digest, entries }) {
  const items = substantiveTextItems(entries);
  const identityEvidence = accountIdentity(items);
  const fields = universalFields(items);
  const fieldKeys = Object.keys(fields);
  const blockers = [];
  if (!identityEvidence) blockers.push('missing_official_universal_account_identity');
  if (!fieldKeys.length) blockers.push('missing_official_account_field_evidence');
  for (const key of [
    'minimumGuaranteedRate', 'settlement', 'singlePremiumInitialCharge',
    'additionalPremiumInitialCharge', 'managementAndRiskFees',
    'withdrawalAndSurrenderCharges', 'withdrawalEligibilityAndLimits', 'accountValueRule',
  ]) {
    if (!fields[key]) blockers.push(`missing_account_field:${key}`);
  }
  const aligned = entries.some((entry) => entry.kind === 'artifact')
    && entries.some((entry) => entry.kind === 'card')
    && entries.some((entry) => entry.kind === 'indicator');
  if (!aligned) blockers.push('source_chain_not_aligned');
  const eligible = Boolean(identityEvidence && fieldKeys.length && aligned);
  return {
    eligible,
    status: eligible ? 'eligible' : 'hold',
    sourceDigest: digest,
    fields,
    productFunctions: accountContent(fields),
    blockers,
    evidenceGates: {
      officialUniversalIdentity: Boolean(identityEvidence),
      substantiveArticleEvidence: items.some((item) => item.articleBody),
      sourceDigestAligned: aligned,
      concreteAccountFields: fieldKeys.length > 0,
    },
    evidence: {
      identity: identityEvidence?.text || '',
      fieldCount: fieldKeys.length,
      textCount: items.length,
    },
  };
}

function structuredFormula(entries) {
  const values = {
    formulaText: [],
    normalizedFormula: [],
    requiredInputs: [],
    operands: [],
    branches: [],
  };
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      const target = {
        formulaText: 'formulaText', formula_text: 'formulaText',
        normalizedFormula: 'normalizedFormula', normalized_formula: 'normalizedFormula',
        requiredInputs: 'requiredInputs', required_inputs: 'requiredInputs',
        operands: 'operands', branches: 'branches',
      }[key];
      if (target) {
        if (Array.isArray(nested)) values[target].push(...nested);
        else if (text(nested)) values[target].push(nested);
      }
      visit(nested);
    }
  };
  entries.forEach((entry) => visit(entry.payload));
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    const seen = new Set();
    const deduplicated = value.filter((item) => {
      const identity = typeof item === 'string' ? item : JSON.stringify(item);
      if (!identity || seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
    return [key, deduplicated];
  }));
}

function responsibilityTitle(item) {
  return text(item?.title || item?.name || item?.liability || item?.responsibilityName || item?.责任名称);
}

function responsibilityContent(item) {
  return [
    responsibilityTitle(item),
    item?.plainText,
    item?.summary,
    item?.description,
    item?.sourceExcerpt,
    item?.source_excerpt,
    item?.triggerCondition,
    item?.insurerObligation,
    item?.paymentRule,
    item?.howItPays,
    ...array(item?.evidencePacket?.excerpts),
  ].map(text).filter(Boolean).join(' ');
}

function derivedResponsibilityId(title, digest) {
  return `responsibility:${createHash('sha1')
    .update(`${digestKey(digest)}\u001f${title}`)
    .digest('hex')
    .slice(0, 16)}`;
}

function inferOwnerProfile(item, productCategory = '') {
  const content = responsibilityContent(item);
  const explicit = text(item?.ownerProfile || item?.owner_profile).toLowerCase();
  if (explicit) return explicit;
  if (/(?:意外|交通|航空|列车|驾乘|自然灾害).*?(?:医疗|住院|门诊|费用)|(?:医疗|住院|门诊|费用).*?(?:意外|交通)/u.test(content)) return 'accident';
  if (/(?:意外|交通|航空|列车|驾乘|自然灾害)/u.test(content)) return 'accident';
  if (/(?:医疗|住院|门诊|报销|医疗费用)/u.test(content)) return 'medical';
  if (/(?:重大疾病|重疾|特定疾病|疾病)/u.test(content)) return 'disease';
  if (/(?:万能|账户价值|最低保证利率|结算利率)/u.test(content)) return 'universal';
  if (/(?:年金|养老金|养老年金)/u.test(content) || productCategory === 'annuity') return 'annuity';
  if (/(?:两全|满期|生存金)/u.test(content) || productCategory === 'endowment' || productCategory === 'incremental_whole_life') return 'endowment';
  if (/(?:身故|全残)/u.test(content)) return 'life';
  return '';
}

function inferPaymentProfiles(item) {
  const content = responsibilityContent(item);
  const profiles = [];
  if (/(?:报销|医疗费用|实际费用|发票|免赔额)/u.test(content)) profiles.push('medical_reimbursement');
  if (/(?:每日|日额|住院津贴|津贴)/u.test(content)) profiles.push('daily_allowance');
  if (/(?:年金|养老|按年|按月领取|定期领取)/u.test(content)) profiles.push('annuity');
  if (/(?:豁免)/u.test(content)) profiles.push('waiver');
  if (/(?:账户价值|保单账户|账户余额|结算利率)/u.test(content)) profiles.push('account');
  if (/(?:较大者|最大者|最小者|三者|max\s*\(|min\s*\()/iu.test(content)) profiles.push('max_min_comparison');
  if (!profiles.length) profiles.push('lump_sum');
  return unique(profiles);
}

function evidencePacketForResponsibility(item, digest) {
  const excerpts = unique([
    ...collectTextValues(item).map((value) => value.text),
    ...array(item?.evidencePacket?.excerpts),
    item?.sourceExcerpt,
    item?.source_excerpt,
  ]);
  const sourceUrl = text(item?.sourceUrl || item?.source_url || item?.url || item?.evidencePacket?.sourceUrl);
  return {
    sourceDigest: sourceDigest(item?.sourceDigest || item?.source_digest || digest),
    sourceUrl,
    excerpts,
  };
}

function normalizeResponsibility(item, { sourceDigest: digest, productCategory = '', topology = 'standalone' } = {}) {
  const title = responsibilityTitle(item);
  const normalizedDigest = sourceDigest(item?.sourceDigest || item?.source_digest || digest);
  const resolvedTopology = text(item?.topology || item?.contractTopology || topology) || 'standalone';
  const ownerProfile = inferOwnerProfile(item, productCategory);
  const paymentProfiles = unique(array(item?.paymentProfiles).length
    ? item.paymentProfiles
    : [item?.paymentProfile, ...inferPaymentProfiles(item)]);
  return {
    responsibilityId: text(item?.responsibilityId || item?.responsibility_id) || derivedResponsibilityId(title, normalizedDigest),
    title,
    ownerProfile,
    paymentProfile: paymentProfiles[0] || '',
    paymentProfiles,
    topology: resolvedTopology,
    sourceDigest: normalizedDigest,
    evidencePacket: evidencePacketForResponsibility(item, normalizedDigest),
  };
}

export function allocateResponsibilityOwners({ responsibilities = [], productCategory = '', topology = 'standalone' } = {}) {
  const allocated = array(responsibilities).map((item) => normalizeResponsibility(item, {
    sourceDigest: item?.sourceDigest || item?.source_digest || '',
    productCategory,
    topology,
  }));
  const conflicts = [];
  allocated.forEach((item) => {
    if (!item.title) conflicts.push({ responsibilityId: item.responsibilityId, reason: 'title_required' });
    if (!OWNER_PROFILES.has(item.ownerProfile)) conflicts.push({ responsibilityId: item.responsibilityId, reason: 'owner_profile_required', ownerProfile: item.ownerProfile });
    if (item.paymentProfiles.some((profile) => !PAYMENT_PROFILES.has(profile))) {
      conflicts.push({ responsibilityId: item.responsibilityId, reason: 'payment_profile_unknown' });
    }
    if (!TOPOLOGIES.has(item.topology)) conflicts.push({ responsibilityId: item.responsibilityId, reason: 'contract_topology_unknown', topology: item.topology });
    if (!item.sourceDigest || !item.evidencePacket.excerpts.length) {
      conflicts.push({ responsibilityId: item.responsibilityId, reason: 'evidence_packet_required' });
    }
  });
  return { responsibilities: allocated, conflicts };
}

export function buildOfficialResponsibilityInventory({
  sourceDigest: digest = '',
  responsibilities = [],
  productCategory = '',
  topology = 'standalone',
} = {}) {
  const resolvedDigest = sourceDigest(digest);
  const candidates = array(responsibilities).map((item) => normalizeResponsibility(item, {
    sourceDigest: resolvedDigest,
    productCategory,
    topology,
  }));
  const conflicts = [];
  const byId = new Map();
  const byTitle = new Map();
  const byEvidence = new Map();
  const uniqueResponsibilities = [];
  for (const candidate of candidates) {
    if (resolvedDigest && candidate.sourceDigest !== resolvedDigest) {
      conflicts.push({
        responsibilityId: candidate.responsibilityId,
        reason: 'source_digest_conflict',
        expectedSourceDigest: resolvedDigest,
        incomingSourceDigest: candidate.sourceDigest,
      });
    }
    const idExisting = byId.get(candidate.responsibilityId);
    const signature = JSON.stringify(candidate);
    if (idExisting) {
      if (JSON.stringify(idExisting) !== signature) {
        conflicts.push({
          responsibilityId: candidate.responsibilityId,
          reason: candidate.ownerProfile !== idExisting.ownerProfile ? 'owner_conflict' : 'responsibility_id_conflict',
          existingOwnerProfile: idExisting.ownerProfile,
          incomingOwnerProfile: candidate.ownerProfile,
        });
      }
      continue;
    }
    const titleKey = `${candidate.sourceDigest}\u001f${candidate.title}`;
    const evidenceKey = `${candidate.sourceDigest}\u001f${JSON.stringify(candidate.evidencePacket.excerpts)}`;
    if (byTitle.has(titleKey)) conflicts.push({ responsibilityId: candidate.responsibilityId, reason: 'duplicate_title', title: candidate.title });
    if (byEvidence.has(evidenceKey)) conflicts.push({ responsibilityId: candidate.responsibilityId, reason: 'duplicate_evidence_packet' });
    byId.set(candidate.responsibilityId, candidate);
    byTitle.set(titleKey, candidate);
    byEvidence.set(evidenceKey, candidate);
    uniqueResponsibilities.push(candidate);
  }
  const allocation = allocateResponsibilityOwners({
    responsibilities: uniqueResponsibilities,
    productCategory,
    topology,
  });
  const allConflicts = uniqueValues([...conflicts, ...allocation.conflicts]);
  const ownerProfiles = unique(uniqueResponsibilities.map((item) => item.ownerProfile));
  const paymentProfiles = unique(uniqueResponsibilities.flatMap((item) => item.paymentProfiles));
  return {
    sourceDigest: resolvedDigest,
    status: allConflicts.length ? 'review' : 'approved',
    responsibilities: uniqueResponsibilities,
    ownerProfiles,
    paymentProfiles,
    conflicts: allConflicts,
    gates: {
      sourceDigestPresent: Boolean(resolvedDigest),
      responsibilityIdUnique: new Set(uniqueResponsibilities.map((item) => item.responsibilityId)).size === uniqueResponsibilities.length,
      titleUnique: new Set(uniqueResponsibilities.map((item) => `${item.sourceDigest}\u001f${item.title}`)).size === uniqueResponsibilities.length,
      evidencePacketUnique: new Set(uniqueResponsibilities.map((item) => `${item.sourceDigest}\u001f${JSON.stringify(item.evidencePacket.excerpts)}`)).size === uniqueResponsibilities.length,
      sourceDigestAligned: uniqueResponsibilities.every((item) => item.sourceDigest === resolvedDigest),
      oneOwnerPerResponsibility: allConflicts.every((conflict) => conflict.reason !== 'owner_conflict'),
      topologyOrthogonal: uniqueResponsibilities.every((item) => TOPOLOGIES.has(item.topology)),
    },
  };
}

function ordinaryResponsibilities(cards) {
  return cards
    .filter((card) => {
      const content = [card.payload.title, card.payload.plainSummary, card.payload.payoutSummary].map(text).join(' ');
      return ORDINARY_RESPONSIBILITY_RE.test(content) || !ACCOUNT_BODY_RE.test(content);
    })
    .map((card) => card.payload);
}

function responsibilityCandidatesForChain(chain, explicitResponsibilities = []) {
  if (array(explicitResponsibilities).length) return explicitResponsibilities;
  const artifactEntries = chain.entries.filter((entry) => entry.kind === 'artifact');
  return artifactEntries.flatMap((entry) => array(entry.payload.responsibilities));
}

function scopedEntries({ company, productName, productKey, cards, indicators, artifacts, sourceRecords }) {
  return [
    ...array(artifacts).map((entry) => normalizedEntry(entry, 'artifact')).filter((entry) => entry.approved),
    ...array(cards).map((entry) => normalizedEntry(entry, 'card')),
    ...array(indicators).map((entry) => normalizedEntry(entry, 'indicator')),
    ...array(sourceRecords).map((entry) => normalizedEntry(entry, 'source')),
  ].filter((entry) => matchesScope(entry, { company, productName, productKey }));
}

function sourceChains(entries) {
  const digests = unique(entries.flatMap((entry) => entry.digests));
  return digests.map((key) => ({
    key,
    digest: sourceDigest(key),
    entries: entries.filter((entry) => entry.digests.includes(key)),
  }));
}

function noSpecialResult({ company, productName, productKey, blockers = [] } = {}) {
  return {
    category: 'ordinary',
    sourceDigest: '',
    product: { company, productName, productKey },
    evidenceGates: { universalAccount: {}, incrementalWholeLife: {} },
    blockers: unique(blockers),
    ordinaryResponsibilities: [],
    responsibilityInventory: {
      sourceDigest: '',
      status: 'not_run',
      responsibilities: [],
      ownerProfiles: [],
      paymentProfiles: [],
      conflicts: [],
    },
    universalAccount: { eligible: false, status: 'not_detected', blockers: [] },
    incrementalWholeLife: { eligible: false, status: 'not_detected', blockers: [] },
  };
}

export function routeUnifiedSpecialProductResponsibility({
  company = '',
  productName = '',
  productKey = '',
  cards = [],
  indicators = [],
  artifacts = [],
  sourceRecords = [],
  responsibilities = [],
  productCategory = '',
  topology = 'standalone',
} = {}) {
  const scope = { company: text(company), productName: text(productName), productKey: text(productKey) };
  if (!scope.company || !scope.productName) return noSpecialResult({ ...scope, blockers: ['product_identity_required'] });
  const entries = scopedEntries({ ...scope, cards, indicators, artifacts, sourceRecords });
  const scopedCards = entries.filter((entry) => entry.kind === 'card');
  const allChains = sourceChains(entries);
  const chains = allChains.filter((chain) => (
    chain.entries.some((entry) => entry.kind === 'artifact')
    && chain.entries.some((entry) => entry.kind === 'card')
    && chain.entries.some((entry) => entry.kind === 'indicator')
  ));
  const unalignedUniversalIdentity = accountIdentity(substantiveTextItems(entries));
  const fieldEvidenceDisplay = buildFieldEvidenceDisplay(entries, chains);
  const withFieldDisplay = (result) => ({
    ...result,
    blockers: unique([...array(result?.blockers), ...array(fieldEvidenceDisplay.blockers)]),
    fieldEvidenceDisplay,
  });
  if (fieldEvidenceDisplay.status === 'version_conflict' && !chains.length) {
    return withFieldDisplay({
      ...noSpecialResult({ ...scope, blockers: ['version_conflict'] }),
      category: 'blocked',
    });
  }
  if (!chains.length) {
    const result = noSpecialResult({ ...scope, blockers: ['source_chain_not_aligned'] });
    result.ordinaryResponsibilities = ordinaryResponsibilities(scopedCards);
    if (fieldEvidenceDisplay.universalIdentity && fieldEvidenceDisplay.productFunctions.length) {
      result.category = 'blocked';
      result.sourceDigest = fieldEvidenceDisplay.sourceDigest;
      result.universalAccount = {
        eligible: false,
        status: 'display_only',
        fields: fieldEvidenceDisplay.fields,
        productFunctions: fieldEvidenceDisplay.productFunctions,
        blockers: ['source_chain_not_aligned'],
      };
    } else if (unalignedUniversalIdentity) {
      result.category = 'blocked';
      result.universalAccount = {
        eligible: false,
        status: 'hold',
        fields: {},
        productFunctions: [],
        blockers: ['source_chain_not_aligned', 'missing_source_digest'],
      };
    }
    return withFieldDisplay(result);
  }

  const universalCandidates = chains.map((chain) => accountEvaluation({ sourceDigest: chain.digest, entries: chain.entries }));
  const universalEligible = universalCandidates.filter((candidate) => candidate.eligible);
  const accountIdentityFound = universalCandidates.some((candidate) => candidate.evidenceGates.officialUniversalIdentity);
  if (universalEligible.length > 1) {
    return withFieldDisplay({
      ...noSpecialResult({ ...scope, blockers: ['version_conflict'] }),
      category: 'blocked',
      sourceDigest: '',
      ordinaryResponsibilities: ordinaryResponsibilities(scopedCards),
      responsibilityInventory: { sourceDigest: '', status: 'review', responsibilities: [], ownerProfiles: [], paymentProfiles: [], conflicts: [{ reason: 'version_conflict' }] },
      universalAccount: { eligible: false, status: 'version_conflict', candidates: universalCandidates },
      evidenceGates: { universalAccount: { versionConflict: true }, incrementalWholeLife: { mutuallyExclusive: true } },
    });
  }

  if (accountIdentityFound) {
    const account = universalEligible[0] || universalCandidates.find((candidate) => candidate.evidenceGates.officialUniversalIdentity);
    const accountChain = chains.find((chain) => chain.digest === account.sourceDigest) || chains[0];
    const responsibilityInventory = buildOfficialResponsibilityInventory({
      sourceDigest: account.sourceDigest,
      responsibilities: responsibilityCandidatesForChain(accountChain, responsibilities),
      productCategory,
      topology,
    });
    const category = account.eligible ? 'universal_account' : 'blocked';
    return withFieldDisplay({
      category,
      categories: unique([category, ...responsibilityInventory.ownerProfiles]),
      sourceDigest: account.sourceDigest,
      product: scope,
      domainProfiles: responsibilityInventory.ownerProfiles,
      responsibilityInventory,
      evidenceGates: {
        universalAccount: account.evidenceGates,
        incrementalWholeLife: { mutuallyExclusive: true, evaluated: false },
      },
      blockers: unique(account.blockers),
      ordinaryResponsibilities: ordinaryResponsibilities(scopedCards),
      universalAccount: account,
      incrementalWholeLife: {
        eligible: false,
        status: 'mutually_exclusive',
        blockers: ['universal_account_identity_precedes_incremental_whole_life'],
      },
    });
  }

  if (fieldEvidenceDisplay.status === 'version_conflict') {
    return withFieldDisplay({
      ...noSpecialResult({ ...scope, blockers: ['version_conflict'] }),
      category: 'blocked',
    });
  }

  const incremental = evaluateIncrementalWholeLifePurpose({
    company: scope.company,
    productName: scope.productName,
    cards: entries.filter((entry) => entry.kind === 'card').map((entry) => entry.raw),
    indicators: entries.filter((entry) => entry.kind === 'indicator').map((entry) => entry.raw),
    artifacts: entries.filter((entry) => entry.kind === 'artifact').map((entry) => entry.raw),
  });
  const formulaEntries = entries.filter((entry) => ['artifact', 'card', 'indicator'].includes(entry.kind));
  const formula = structuredFormula(formulaEntries);
  const incrementalChain = chains.find((chain) => chain.digest === sourceDigest(incremental.sourceDigest)) || chains[0];
  const responsibilityInventory = buildOfficialResponsibilityInventory({
    sourceDigest: incremental.eligible ? sourceDigest(incremental.sourceDigest) : '',
    responsibilities: responsibilityCandidatesForChain(incrementalChain, responsibilities),
    productCategory: productCategory || (incremental.eligible ? 'incremental_whole_life' : ''),
    topology,
  });
  const category = incremental.eligible ? 'incremental_whole_life' : 'ordinary';
  const incrementalBlockers = incremental.eligible
    ? []
    : [text(incremental.holdReason) || 'missing_three_gate_evidence'];
  return withFieldDisplay({
    category,
    categories: unique([category, ...responsibilityInventory.ownerProfiles]),
    sourceDigest: incremental.eligible ? sourceDigest(incremental.sourceDigest) : '',
    product: scope,
    domainProfiles: responsibilityInventory.ownerProfiles,
    responsibilityInventory,
    evidenceGates: {
      universalAccount: { mutuallyExclusive: true, officialUniversalIdentity: false },
      incrementalWholeLife: incremental.gates || {},
    },
    blockers: incrementalBlockers,
    ordinaryResponsibilities: ordinaryResponsibilities(scopedCards),
    universalAccount: { eligible: false, status: 'not_detected', blockers: [] },
    incrementalWholeLife: {
      ...incremental,
      productPurpose: incremental.eligible
        ? `${incremental.productPurpose}有效保险金额是责任计算基础；r/递增因子为每年 ${incremental.rate}% 的有效保险金额增长因子，不是收益率或现金价值增长率。`
        : '',
      formula,
      semanticRole: incremental.eligible
        ? 'r_is_effective_insured_amount_growth_factor_not_yield'
        : '',
      blockers: incrementalBlockers,
    },
  });
}

function blockWithProductFunctions(blocks, functions) {
  const content = array(functions).map((item) => `${text(item.title)}：${text(item.plainText)}`).filter((line) => !line.startsWith('：') && !line.endsWith('：'));
  const byKey = new Map(array(blocks).map((block) => [text(block?.blockKey), block]));
  const existing = byKey.get('productFunctions') || { blockKey: 'productFunctions', title: '产品功能/权益', order: 3 };
  byKey.set('productFunctions', {
    ...existing,
    blockKey: 'productFunctions',
    title: text(existing.title) || '产品功能/权益',
    enabled: content.length > 0,
    editable: existing.editable !== false,
    order: Number.isFinite(Number(existing.order)) ? Number(existing.order) : 3,
    content: content.join('\n'),
  });
  return [...byKey.values()].sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
}

export function applyUnifiedSpecialProductEvaluation(summary = {}, evaluation = {}) {
  const next = { ...summary };
  next.category = text(evaluation.category);
  next.sourceDigest = text(evaluation.sourceDigest);
  next.evidenceGates = evaluation.evidenceGates || {};
  next.blockers = unique(evaluation.blockers);
  const fieldDisplay = evaluation.fieldEvidenceDisplay || {};
  if (fieldDisplay.mode) {
    next.evidenceMode = text(fieldDisplay.mode);
    next.persistenceStatus = text(fieldDisplay.persistenceStatus);
  }
  if (array(fieldDisplay.productFunctions).length) {
    next.contentBlocks = blockWithProductFunctions(next.contentBlocks, fieldDisplay.productFunctions);
  } else if (evaluation.category === 'universal_account' || evaluation.universalAccount?.status === 'hold') {
    next.contentBlocks = blockWithProductFunctions(next.contentBlocks, evaluation.universalAccount?.productFunctions || []);
  }
  if (evaluation.category === 'blocked' && evaluation.universalAccount?.status === 'hold') {
    next.notices = unique([
      ...array(next.notices),
      '万能账户条款版本或责任数据尚未完成对齐，账户利率、费用及领取规则暂不展示。',
    ]);
  }
  if (evaluation.category === 'incremental_whole_life') {
    const rate = text(evaluation.incrementalWholeLife?.rate);
    const formula = evaluation.incrementalWholeLife?.formula?.normalizedFormula?.[0]
      || evaluation.incrementalWholeLife?.formula?.formulaText?.[0]
      || '';
    const verifiedPurpose = text(evaluation.incrementalWholeLife?.productPurpose);
    const purpose = [
      verifiedPurpose || '本产品提供终身身故、全残保障，有效保险金额是责任计算基础。',
      verifiedPurpose && !/有效保险金额/u.test(verifiedPurpose) ? '有效保险金额是责任计算基础。' : '',
      rate && !/不是收益率/u.test(verifiedPurpose)
        ? `条款中的 r/递增因子为每年 ${rate}% 的有效保险金额增长因子，不是收益率或现金价值增长率。`
        : '',
      formula ? `责任计算公式：${formula}` : '',
    ].filter(Boolean).join('');
    next.headline = purpose;
    next.contentBlocks = array(next.contentBlocks).map((block) => text(block?.blockKey) === 'productPurpose'
      ? { ...block, content: purpose, enabled: true }
      : block);
  }
  return next;
}

export function buildSpecialProductDatabaseSummary({ summary = {}, evidence = {} } = {}) {
  const evaluation = routeUnifiedSpecialProductResponsibility(evidence);
  return {
    ok: true,
    source: 'database',
    summary: applyUnifiedSpecialProductEvaluation(summary, evaluation),
    evaluation,
  };
}
