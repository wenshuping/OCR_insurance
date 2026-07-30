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
    if ((key === 'sourceDigest' || key === 'source_digest' || key === 'responsibilitySourceDigest') && text(nested)) {
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
  ]);
  for (const [key, nested] of Object.entries(value)) {
    if (acceptedKeys.has(key) && typeof nested === 'string' && text(nested)) {
      result.push({ text: text(nested), path: [...path, key] });
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
  };
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
  return preferred.length ? preferred : items.filter((item) => !isNavigationOnlyText(item.text));
}

function sentenceFor(textValue, pattern) {
  const content = text(textValue).replace(/\s+/gu, ' ');
  const sentences = content.split(/(?<=[。；;.!！？])/u).map((item) => item.trim()).filter(Boolean);
  const matches = sentences.filter((sentence) => pattern.test(sentence) && !NAVIGATION_RE.test(sentence));
  return matches.find((sentence) => /(?:第\s*[一二三四五六七八九十百千万0-9]+\s*条|本合同|合同约定)/u.test(sentence)
    && !NAVIGATION_RE.test(sentence)) || matches[0] || '';
}

function fieldEvidence(items, pattern, { numeric = false } = {}) {
  const candidates = items
    .map((item) => ({ ...item, excerpt: sentenceFor(item.text, pattern) }))
    .filter((item) => item.excerpt);
  if (!numeric) return candidates[0] || null;
  return candidates.find((item) => /\d+(?:\.\d+)?\s*%/u.test(item.excerpt)) || candidates[0] || null;
}

function rateFromExcerpt(excerpt, pattern = null) {
  const match = text(excerpt).match(pattern || /(\d+(?:\.\d+)?\s*%)/u);
  return match ? match[1].replace(/\s+/gu, '') : '';
}

function clausesFromOfficialText(items, pattern) {
  const clauses = [];
  for (const item of items) {
    const sentences = text(item.text).replace(/\s+/gu, ' ').split(/(?<=[。；;.!！？])/u);
    for (const sentence of sentences) {
      if (pattern.test(sentence) && !NAVIGATION_RE.test(sentence)) clauses.push(sentence.trim());
    }
  }
  return unique(clauses);
}

function universalFields(items) {
  const fields = {};
  const add = (key, label, pattern, options = {}) => {
    const evidence = fieldEvidence(items, pattern, options);
    if (evidence) fields[key] = {
      label,
      value: options.numeric ? rateFromExcerpt(evidence.excerpt, options.ratePattern) || evidence.excerpt : evidence.excerpt,
      sourceExcerpt: evidence.excerpt,
      sourceDigest: evidence.sourceDigest,
    };
  };
  add('minimumGuaranteedRate', '最低保证利率', /最低保证利率|保证利率/u, { numeric: true, ratePattern: /(?:最低保证利率|保证利率)[^%]{0,80}?(\d+(?:\.\d+)?\s*%)/u });
  add('settlement', '账户结算', /结算(?:利率|频率|方式|方法)|公布.*结算|按月.*结算|按日.*结算/u);
  add('singlePremiumInitialCharge', '趸交/一次交清初始费用', /(?:一次交清|一次性交纳|一次性缴纳|趸交|单笔).*?(?:初始费用|费用|手续费)|(?:初始费用|费用|手续费).*?(?:一次交清|一次性交纳|一次性缴纳|趸交|单笔)/u, { numeric: true, ratePattern: /(?:一次交清|一次性交纳|一次性缴纳|趸交|单笔)[^%]{0,80}?(\d+(?:\.\d+)?\s*%)/u });
  add('additionalPremiumInitialCharge', '追加初始费用', /追加.*?(?:初始费用|费用|手续费)|(?:初始费用|费用|手续费).*?追加/u, { numeric: true, ratePattern: /追加[^%]{0,80}?(\d+(?:\.\d+)?\s*%)/u });
  add('managementAndRiskFees', '管理费/风险费', /(?:保单管理费|账户管理费|管理费|风险保险费|风险费|投资管理费)/u);
  add('withdrawalAndSurrenderCharges', '部分领取/退保手续费', /(?:部分领取|部分提取|退保).*?(?:手续费|费用|费率|比例)|(?:手续费|费用|费率|比例).*?(?:部分领取|部分提取|退保)/u);
  add('withdrawalEligibilityAndLimits', '领取/退保条件与限额', /(?:部分领取|部分提取|退保).*?(?:条件|资格|最低|限额|余额|次数|频率|保单年度)|(?:条件|资格|最低|限额|余额|次数|频率|保单年度).*?(?:部分领取|部分提取|退保)/u);
  add('accountValueRule', '账户价值规则', /账户价值.*?(?:等于|计算|扣除|加上|余额)|(?:等于|计算|扣除|加上|余额).*?账户价值/u);
  const withdrawalRates = clausesFromOfficialText(items, /部分领取手续费率|部分领取.*?(?:5\s*%|4\s*%|3\s*%|2\s*%|1\s*%)/u);
  if (withdrawalRates.length) {
    const percentages = unique(withdrawalRates.flatMap((clause) => [...clause.matchAll(/\d+(?:\.\d+)?\s*%/gu)].map((match) => match[0].replace(/\s+/gu, ''))));
    fields.withdrawalAndSurrenderCharges = {
      label: '部分领取/退保手续费',
      value: percentages.length ? `部分领取手续费率：${percentages.join(' / ')}` : withdrawalRates.join(' '),
      sourceExcerpt: withdrawalRates.join(' '),
      sourceDigest: withdrawalRates.length ? fieldEvidence(items, /部分领取手续费/u)?.sourceDigest || '' : '',
    };
  }
  const withdrawalLimits = clausesFromOfficialText(items, /(?:部分领取|个人账户价值).*(?:低于|不得超过|不超过)/u);
  if (withdrawalLimits.length) {
    fields.withdrawalEligibilityAndLimits = {
      label: '领取/退保条件与限额',
      value: withdrawalLimits.join(' '),
      sourceExcerpt: withdrawalLimits.join(' '),
      sourceDigest: fieldEvidence(items, /(?:部分领取|个人账户价值).*(?:低于|不得超过|不超过)/u)?.sourceDigest || '',
    };
  }
  return fields;
}

function accountIdentity(items) {
  return items.find((item) => {
    const body = item.originalText || item.text;
    const productIdentity = text(item.productName);
    return item.articleBody
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
  const chains = sourceChains(entries).filter((chain) => (
    chain.entries.some((entry) => entry.kind === 'artifact')
    && chain.entries.some((entry) => entry.kind === 'card')
    && chain.entries.some((entry) => entry.kind === 'indicator')
  ));
  if (!chains.length) {
    return noSpecialResult({ ...scope, blockers: ['source_chain_not_aligned'] });
  }

  const universalCandidates = chains.map((chain) => accountEvaluation({ sourceDigest: chain.digest, entries: chain.entries }));
  const universalEligible = universalCandidates.filter((candidate) => candidate.eligible);
  const accountIdentityFound = universalCandidates.some((candidate) => candidate.evidenceGates.officialUniversalIdentity);
  if (universalEligible.length > 1) {
    return {
      ...noSpecialResult({ ...scope, blockers: ['version_conflict'] }),
      category: 'blocked',
      sourceDigest: '',
      ordinaryResponsibilities: ordinaryResponsibilities(scopedCards),
      responsibilityInventory: { sourceDigest: '', status: 'review', responsibilities: [], ownerProfiles: [], paymentProfiles: [], conflicts: [{ reason: 'version_conflict' }] },
      universalAccount: { eligible: false, status: 'version_conflict', candidates: universalCandidates },
      evidenceGates: { universalAccount: { versionConflict: true }, incrementalWholeLife: { mutuallyExclusive: true } },
    };
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
    return {
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
    };
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
  return {
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
        ? `本产品提供终身身故、全残保障，有效保险金额是责任计算基础；r/递增因子为每年 ${incremental.rate}% 的有效保险金额增长因子，不是收益率或现金价值增长率。`
        : '',
      formula,
      semanticRole: incremental.eligible
        ? 'r_is_effective_insured_amount_growth_factor_not_yield'
        : '',
      blockers: incrementalBlockers,
    },
  };
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
  if (evaluation.category === 'universal_account' || evaluation.universalAccount?.status === 'hold') {
    next.contentBlocks = blockWithProductFunctions(next.contentBlocks, evaluation.universalAccount?.productFunctions || []);
  }
  if (evaluation.category === 'incremental_whole_life') {
    const rate = text(evaluation.incrementalWholeLife?.rate);
    const formula = evaluation.incrementalWholeLife?.formula?.normalizedFormula?.[0]
      || evaluation.incrementalWholeLife?.formula?.formulaText?.[0]
      || '';
    const purpose = [
      '本产品提供终身身故、全残保障，有效保险金额是责任计算基础。',
      rate ? `条款中的 r/递增因子为每年 ${rate}% 的有效保险金额增长因子，不是收益率或现金价值增长率。` : '',
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
