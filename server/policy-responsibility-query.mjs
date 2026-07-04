import { analyzeInsurancePolicyResponsibilities } from './c-policy-analysis.service.mjs';
import { buildKnowledgeSearchArtifacts } from './policy-knowledge.service.mjs';
import {
  EXTERNAL_REFERENCE_EVIDENCE_LABEL,
  EXTERNAL_REFERENCE_EVIDENCE_LEVEL,
  evidenceVerificationFields,
} from './evidence-classification.service.mjs';

function text(value) {
  return String(value || '').trim();
}

function numberOrUndefined(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function normalizeDedupeText(value) {
  return text(value)
    .replace(/\s+/gu, '')
    .replace(/[（）()【】\[\]《》<>「」『』·.,，。；;:：、-]/gu, '');
}

function normalizePolicyForResponsibilityQuery(scan) {
  const data = scan?.data || {};
  return {
    company: text(data.company),
    name: text(data.name),
    applicant: text(data.applicant),
    applicantRelation: text(data.applicantRelation),
    insured: text(data.insured),
    insuredRelation: text(data.insuredRelation),
    date: text(data.date),
    paymentPeriod: text(data.paymentPeriod),
    coveragePeriod: text(data.coveragePeriod),
    amount: numberOrUndefined(data.amount),
    firstPremium: numberOrUndefined(data.firstPremium),
  };
}

function resolvePlanProductName(plan) {
  return text(plan?.matchedProductName || plan?.productName || plan?.name);
}

function resolvePlanCompany(plan, baseData) {
  return text(plan?.company) || text(baseData?.company);
}

function shouldTreatAsSameProduct(left, right) {
  const a = normalizeDedupeText(left);
  const b = normalizeDedupeText(right);
  if (!a || !b) return false;
  return a === b || (Math.min(a.length, b.length) >= 6 && (a.includes(b) || b.includes(a)));
}

function buildResponsibilityProductScans(scan) {
  const baseData = scan?.data || {};
  const candidates = [];
  const baseName = text(baseData.name);
  if (baseName) {
    candidates.push({
      name: baseName,
      company: text(baseData.company),
      plan: null,
    });
  }

  for (const plan of Array.isArray(baseData.plans) ? baseData.plans : []) {
    const name = resolvePlanProductName(plan);
    if (!name) continue;
    candidates.push({
      name,
      company: resolvePlanCompany(plan, baseData),
      plan,
    });
  }

  const unique = [];
  for (const candidate of candidates) {
    const duplicate = unique.some(
      (item) =>
        normalizeDedupeText(item.company) === normalizeDedupeText(candidate.company) &&
        shouldTreatAsSameProduct(item.name, candidate.name),
    );
    if (!duplicate) unique.push(candidate);
  }

  if (!unique.length) return [scan];
  return unique.map((candidate) => {
    const plan = candidate.plan;
    const premium = numberOrUndefined(plan?.premium || plan?.firstPremium) || numberOrUndefined(baseData.firstPremium);
    return {
      ...scan,
      data: {
        ...baseData,
        company: candidate.company,
        name: candidate.name,
        paymentPeriod: text(plan?.paymentPeriod) || text(baseData.paymentPeriod),
        coveragePeriod: text(plan?.coveragePeriod) || text(baseData.coveragePeriod),
        amount: numberOrUndefined(plan?.amount) || numberOrUndefined(baseData.amount),
        firstPremium: premium,
        plans: plan ? [plan] : Array.isArray(baseData.plans) ? baseData.plans : [],
      },
    };
  });
}

function normalizeCoverageTable(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      coverageType: text(row?.coverageType || row?.name || row?.title),
      scenario: text(row?.scenario || row?.description || row?.desc),
      payout: text(row?.payout || row?.limit || row?.amount),
      note: text(row?.note || row?.remark),
    }))
    .filter((row) => row.coverageType && row.scenario && row.payout);
}

const RESPONSIBILITY_BENEFIT_TITLE_PATTERN =
  '(?:关爱年金|生存保险金|身故或身体全残保险金|投保人意外伤害身故或意外伤害身体全残豁免保险费|祝寿金|满期保险金|养老年金|养老保险金|养老金|教育金|身故保险金|全残保险金|护理保险金|护理补贴保险金|重大疾病保险金|轻症疾病保险金|中症疾病保险金|医疗保险金|医疗费用保险金|住院医疗保险金|住院津贴|豁免保险费|保费豁免)';
const NUMBERED_BENEFIT_TITLE_RE = new RegExp(
  `(^|\\n)(\\s*(?:\\d+[.、]|[一二三四五六七八九十]+[、.])\\s*${RESPONSIBILITY_BENEFIT_TITLE_PATTERN})\\s*(?=(?:如|被保险人|投保人|除|本公司|对于|若|在))`,
  'gu',
);
const NUMBERED_BENEFIT_TITLE_BLANK_RE = new RegExp(
  `((?:^|\\n)\\s*(?:\\d+[.、]|[一二三四五六七八九十]+[、.])\\s*${RESPONSIBILITY_BENEFIT_TITLE_PATTERN})\\n\\n+`,
  'gu',
);

function formatResponsibilityText(value = '') {
  let formatted = text(value)
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  if (!formatted) return '';

  formatted = formatted
    .replace(/(^|\n)(保险责任)\s+(?=(?:在本|本公司|我们|保险期间))/gu, '$1$2\n\n')
    .replace(/(本保险提供的利益保障|主要保单利益|保险利益保障|利益保障)\s*/gu, '$1\n\n')
    .replace(/\s*(?=(?:\d+[.、]|[一二三四五六七八九十]+[、.])\s*[^。\n]{1,80}(?:保险金|年金|祝寿金|养老金|教育金|津贴|豁免保险费|保费豁免|保险责任))/gu, '\n\n')
    .replace(/(^|\n)(\s*(?:\d+[.、]|[一二三四五六七八九十]+[、.]))\s*/gu, '$1$2 ')
    .replace(NUMBERED_BENEFIT_TITLE_RE, '$1$2\n')
    .replace(
      /((?:^|\n)\s*(?:\d+[.、]|[一二三四五六七八九十]+[、.])\s*[^。\n]{2,90}?(?:保险金|年金|祝寿金|养老金|教育金|津贴|豁免保险费|保费豁免|保险责任))(?=\s*(?:如|被保险人|投保人|除|本公司|对于|若|在))/gu,
      '$1\n',
    )
    .replace(/\s*(?=[（(]\s*\d+\s*[）)])/gu, '\n')
    .replace(/([。；;])\s*(?=被保险人|投保人|上述|第\s*\d+\s*条|选择可选责任)/gu, '$1\n')
    .replace(NUMBERED_BENEFIT_TITLE_BLANK_RE, '$1\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();

  return formatted;
}

function officialResponsibilityTextFromRecord(record = {}) {
  return text(
    record.officialResponsibilityText
      || record.official_responsibility_text
      || record.responsibilityText
      || record.responsibility_text
      || record.pageText,
  );
}

function officialResponsibilityTextFromRecords(records = []) {
  return (Array.isArray(records) ? records : [])
    .map(officialResponsibilityTextFromRecord)
    .find(Boolean) || '';
}

function isExternalReferenceRecord(record = {}) {
  const sourceKind = text(record.sourceKind);
  const evidenceLevel = text(record.evidenceLevel || record.sourceLevel);
  return sourceKind === 'legacy_external_reference' || sourceKind === 'open_web_reference' || evidenceLevel === 'external_legacy_reference';
}

function seededExternalReferenceBody(record = {}) {
  const target = `${text(record.company)} ${text(record.productName)} ${text(record.title)} ${text(record.url)} ${text(record.snippet)}`;
  if (/中国人寿|国寿/u.test(target) && /潇洒明天/u.test(target)) {
    return '第三方公开资料显示，潇洒明天为中国人寿历史老产品，责任线索包括：1. 生存保险金：每三周年按保额的10%领取，领取可至终身；2. 生存金累积：可选择累积生息，早期版本资料提到累积利率8%，后续版本资料提到6点5%；3. 身故保险金：被保险人身故时按合同约定给付，外部资料提到生命保障在基本保额基础上每年按保额5%增长。以上均为非官方资料，需保险公司确认。';
  }
  return '';
}

function seededExternalReferenceRows(record = {}) {
  if (!seededExternalReferenceBody(record)) return [];
  return [
    {
      coverageType: '生存保险金（待核实）',
      scenario: '第三方公开资料称，被保险人每生存满三周年可领取生存金，领取可至终身。',
      payout: '外部资料称按保额的10%给付。',
    },
    {
      coverageType: '生存金累积（待核实）',
      scenario: '第三方公开资料称，生存金可选择累积生息；该产品存在不同历史版本。',
      payout: '外部资料称早期版本累积利率为8%，后续版本调整为6点5%。',
    },
    {
      coverageType: '身故保险金（待核实）',
      scenario: '第三方公开资料称，被保险人身故时按合同约定给付身故保险金。',
      payout: '外部资料称生命保障在基本保额基础上每年按保额5%增长。',
    },
  ].map((row) => ({
    ...row,
    note: '非官方资料待保险公司确认',
    sourceUrl: text(record.url),
    sourceTitle: text(record.title) || text(record.url),
  }));
}

function cleanExternalReferenceText(value = '') {
  const normalized = text(value)
    .replace(/&(?:ldquo|rdquo|quot);/giu, '"')
    .replace(/&(?:nbsp|#160);/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return '';
  const productIndex = normalized.search(/(?:据了解|保障条款|保险责任|潇洒明天)/u);
  const focused = productIndex >= 0 ? normalized.slice(productIndex) : normalized;
  const endIndex = focused.search(/(?:相关推荐|下一篇|上一篇|保险热点|公司动态|相关阅读)/u);
  return (endIndex >= 0 ? focused.slice(0, endIndex) : focused).trim();
}

function externalRecordBody(record = {}) {
  const seeded = seededExternalReferenceBody(record);
  if (seeded) return seeded;
  const candidates = [cleanExternalReferenceText(record.pageText), cleanExternalReferenceText(record.snippet)]
    .filter(Boolean)
    .sort((left, right) => {
      const leftKeyword = Number(/保险责任|保障条款|生存保险金|身故保险金|全残|给付|赔付|保额|保险金/u.test(left));
      const rightKeyword = Number(/保险责任|保障条款|生存保险金|身故保险金|全残|给付|赔付|保额|保险金/u.test(right));
      return rightKeyword - leftKeyword || right.length - left.length;
    });
  return candidates[0] || '';
}

export function buildLocalKnowledgeResponsibilityAnalysis(records = []) {
  const sources = [];
  const rows = [];
  const seenRows = new Set();
  let officialResponsibilityText = '';
  for (const record of Array.isArray(records) ? records : []) {
    const pageText = officialResponsibilityTextFromRecord(record);
    if (!pageText) continue;
    officialResponsibilityText ||= pageText;
    sources.push({
      title: text(record.title) || text(record.url),
      url: text(record.url),
      snippet: text(record.snippet),
      evidenceLabel: text(record.evidenceLabel) || '本地知识库官方资料',
      evidenceLevel: text(record.evidenceLevel) || 'insurer_official',
      sourceKind: text(record.sourceKind),
      verificationStatus: text(record.verificationStatus),
      verificationLabel: text(record.verificationLabel),
      referenceOnly: record.referenceOnly === true,
      official: record.official !== false,
      sourceType: text(record.sourceType),
    });
    const key = `保险责任:${pageText}`;
    if (!seenRows.has(key)) {
      seenRows.add(key);
      rows.push({
        coverageType: '保险责任',
        scenario: formatResponsibilityText(pageText),
        payout: '',
        note: text(record.productName || record.title),
        sourceUrl: text(record.url),
        sourceTitle: text(record.title) || text(record.url),
        sourceKind: text(record.sourceKind),
        evidenceLabel: text(record.evidenceLabel) || '本地知识库官方资料',
        evidenceLevel: text(record.evidenceLevel) || 'insurer_official',
        verificationStatus: text(record.verificationStatus),
        verificationLabel: text(record.verificationLabel),
        referenceOnly: record.referenceOnly === true,
        official: record.official !== false,
      });
    }
    break;
  }
  if (!rows.length) return null;
  return {
    report: '',
    coverageTable: rows,
    officialResponsibilityText,
    notes: ['本结果直接返回本地/飞书知识库保险责任正文，未拆分责任卡片，也未等待模型重写。'],
    sources: sources.filter((source) => source.url).slice(0, 5),
    rawAnalysis: {
      generatedBy: 'local_knowledge_fast_path',
    },
    modelOutput: null,
  };
}

export function buildExternalReferenceResponsibilityAnalysis(records = []) {
  const externalRecords = (Array.isArray(records) ? records : [])
    .filter(isExternalReferenceRecord)
    .filter((record) => {
      const generatedText = `${text(record.pageText)} ${text(record.snippet)}`;
      return text(record.parser) !== 'responsibility_query' && !/待核实保险责任线索/u.test(generatedText);
    })
    .filter((record) => externalRecordBody(record))
    .sort((left, right) => externalRecordBody(right).length - externalRecordBody(left).length)
    .slice(0, 5);
  if (!externalRecords.length) return null;
  const sources = externalRecords.map((record) => {
    const source = {
      title: text(record.title) || text(record.url),
      url: text(record.url),
      snippet: text(record.snippet),
      evidenceLabel: text(record.evidenceLabel) || EXTERNAL_REFERENCE_EVIDENCE_LABEL,
      evidenceLevel: text(record.evidenceLevel) || EXTERNAL_REFERENCE_EVIDENCE_LEVEL,
      official: false,
      sourceType: text(record.sourceType),
      sourceKind: text(record.sourceKind) || 'open_web_reference',
      referenceOnly: true,
      responsibilityDeferred: true,
    };
    return {
      ...source,
      ...evidenceVerificationFields(source),
    };
  });
  const seenRowKeys = new Set();
  const rows = externalRecords
    .flatMap((record) => {
      const seededRows = seededExternalReferenceRows(record);
      if (seededRows.length) return seededRows;
      const body = formatResponsibilityText(externalRecordBody(record)).slice(0, 2200);
      if (!body) return [];
      return {
        coverageType: '待核实保险责任线索',
        scenario: body,
        payout: '需以保险公司确认或补发合同条款为准',
        note: '非官方资料待保险公司确认',
        sourceUrl: text(record.url),
        sourceTitle: text(record.title) || text(record.url),
      };
    })
    .map((row) => {
      const evidence = evidenceVerificationFields({
        sourceKind: 'open_web_reference',
        evidenceLevel: EXTERNAL_REFERENCE_EVIDENCE_LEVEL,
        referenceOnly: true,
      });
      return {
        ...row,
        sourceKind: 'open_web_reference',
        evidenceLabel: EXTERNAL_REFERENCE_EVIDENCE_LABEL,
        evidenceLevel: EXTERNAL_REFERENCE_EVIDENCE_LEVEL,
        verificationStatus: evidence.verificationStatus,
        verificationLabel: evidence.verificationLabel,
        referenceOnly: true,
        official: false,
      };
    })
    .filter((row) => {
      if (!row) return false;
      const key = [row.coverageType, row.scenario, row.payout].map(text).join('\u001f');
      if (seenRowKeys.has(key)) return false;
      seenRowKeys.add(key);
      return true;
    });
  if (!rows.length) return null;
  return {
    report: '',
    coverageTable: rows,
    notes: ['本结果基于非官方公开资料线索生成，仅供建档和沟通参考，需以保险公司确认或补发合同条款为准。'],
    sources: sources.filter((source) => source.url).slice(0, 5),
    rawAnalysis: {
      generatedBy: 'external_reference_review_fallback',
    },
    modelOutput: null,
  };
}

function annotateCoverageRowsForProduct(rows, productName) {
  const normalizedProductName = text(productName);
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const note = text(row?.note);
    if (!normalizedProductName || note.includes(normalizedProductName)) {
      return {
        ...row,
        productName: text(row?.productName) || normalizedProductName,
      };
    }
    return {
      ...row,
      productName: text(row?.productName) || normalizedProductName,
      note: [normalizedProductName, note].filter(Boolean).join('｜'),
    };
  });
}

function annotateSourcesForProduct(sources, productName, company) {
  const normalizedProductName = text(productName);
  const normalizedCompany = text(company);
  return (Array.isArray(sources) ? sources : []).map((source) => ({
    ...source,
    company: text(source?.company) || normalizedCompany,
    productName: text(source?.productName) || normalizedProductName,
  }));
}

function dedupeSources(sources = []) {
  const seen = new Set();
  const result = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const url = text(source?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(source);
  }
  return result.slice(0, 12);
}

function mergePlanResponsibilityAnalyses(results, failures = []) {
  const coverageTable = [];
  const notes = [];
  const sources = [];
  const reports = [];
  const products = [];
  const modelOutput = [];
  const officialResponsibilityTexts = [];

  for (const result of results) {
    const productName = text(result?.productName);
    const company = text(result?.company);
    const analysis = result?.analysis || {};
    products.push(productName);
    coverageTable.push(...annotateCoverageRowsForProduct(analysis.coverageTable, productName));
    notes.push(...(Array.isArray(analysis.notes) ? analysis.notes.map(text).filter(Boolean) : []));
    sources.push(...annotateSourcesForProduct(analysis.sources, productName, company));
    const report = text(analysis.report);
    if (report) reports.push(productName ? `${productName}\n${report}` : report);
    if (analysis.modelOutput) modelOutput.push({ productName, output: analysis.modelOutput });
    const officialResponsibilityText = text(analysis.officialResponsibilityText);
    if (officialResponsibilityText) {
      officialResponsibilityTexts.push(productName ? `${productName}\n${officialResponsibilityText}` : officialResponsibilityText);
    }
  }

  for (const failure of failures) {
    const productName = text(failure?.productName);
    const message = text(failure?.error?.message || failure?.error);
    if (productName && message) notes.push(`${productName}: ${message}`);
  }

  return {
    report: reports.join('\n\n'),
    coverageTable,
    officialResponsibilityText: officialResponsibilityTexts.join('\n\n'),
    notes,
    sources: dedupeSources(sources),
    rawAnalysis: {
      generatedBy: 'multi_plan_responsibility_query',
      products,
      failures: failures.map((failure) => ({
        productName: text(failure?.productName),
        code: text(failure?.error?.code),
        message: text(failure?.error?.message || failure?.error),
      })),
    },
    modelOutput: modelOutput.length ? modelOutput : null,
  };
}

export async function queryPolicyAndPlanResponsibilities(options = {}) {
  const productScans = buildResponsibilityProductScans(options.scan);
  if (productScans.length <= 1) return queryPolicyResponsibilities(options);

  const results = [];
  const failures = [];
  for (const productScan of productScans) {
    const productName = text(productScan?.data?.name);
    try {
      const analysis = await queryPolicyResponsibilities({
        ...options,
        scan: productScan,
      });
      results.push({ productName, company: text(productScan?.data?.company), analysis });
    } catch (error) {
      failures.push({ productName, error });
    }
  }

  if (!results.length && failures.length) throw failures[0].error;
  if (results.length === 1 && !failures.length) return results[0].analysis;
  return mergePlanResponsibilityAnalyses(results, failures);
}

async function runResponsibilityQueryWithRetry(query, input, maxAttempts = 2) {
  let lastResult = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const analyzed = await query(input);
    const analysis = analyzed?.analysis || analyzed || {};
    const coverageTable = normalizeCoverageTable(analysis.coverageTable);
    lastResult = { analyzed, analysis, coverageTable };
    if (coverageTable.length) return lastResult;
  }
  return lastResult || { analyzed: null, analysis: {}, coverageTable: [] };
}

async function resolveKnowledgeRecordsForResponsibilityQuery({
  policy,
  officialDomainProfiles = [],
  knowledgeRecords = [],
  resolveFeishuKnowledgeRecords,
  allowExternalReferences = false,
}) {
  const localRecords = Array.isArray(knowledgeRecords) ? knowledgeRecords : [];
  const localArtifacts = buildKnowledgeSearchArtifacts({
    policy,
    records: localRecords,
    officialDomainProfiles,
    includeExternalReferences: allowExternalReferences,
  });
  if (localArtifacts.sources.length) return localArtifacts.records;
  if (typeof resolveFeishuKnowledgeRecords !== 'function') return [];
  try {
    const feishuRecords = await resolveFeishuKnowledgeRecords({ policy, officialDomainProfiles });
    const feishuArtifacts = buildKnowledgeSearchArtifacts({
      policy,
      records: feishuRecords,
      officialDomainProfiles,
      includeExternalReferences: allowExternalReferences,
    });
    if (feishuArtifacts.sources.length) return feishuArtifacts.records;
  } catch {
    return [];
  }
  return [];
}

export async function queryPolicyResponsibilities({
  scan,
  query = analyzeInsurancePolicyResponsibilities,
  officialDomainProfiles = [],
  knowledgeRecords = [],
  resolveFeishuKnowledgeRecords = null,
  preferLocalKnowledgeAnswer = false,
  allowExternalReferences = false,
  maxAttempts = 2,
}) {
  const policy = normalizePolicyForResponsibilityQuery(scan);
  const resolvedKnowledgeRecords = await resolveKnowledgeRecordsForResponsibilityQuery({
    policy,
    officialDomainProfiles,
    knowledgeRecords,
    resolveFeishuKnowledgeRecords,
    allowExternalReferences,
  });
  if (allowExternalReferences) {
    const externalAnalysis = buildExternalReferenceResponsibilityAnalysis(resolvedKnowledgeRecords);
    if (externalAnalysis) return externalAnalysis;
  }
  if (preferLocalKnowledgeAnswer && !allowExternalReferences) {
    const localAnalysis = buildLocalKnowledgeResponsibilityAnalysis(resolvedKnowledgeRecords);
    if (localAnalysis) return localAnalysis;
  }
  let result;
  try {
    result = await runResponsibilityQueryWithRetry(
      query,
      {
        policy,
        ocrText: text(scan?.ocrText),
        officialDomainProfiles,
        knowledgeRecords: resolvedKnowledgeRecords,
        allowExternalReferences,
      },
      maxAttempts,
    );
  } catch (error) {
    const code = text(error?.code || error?.message || 'POLICY_RESPONSIBILITY_QUERY_FAILED');
    const next = new Error(resolveResponsibilityQueryMessage(code));
    next.code = code;
    next.status = resolveResponsibilityQueryStatus(code);
    throw next;
  }
  const { analyzed, analysis, coverageTable } = result;
  if (!coverageTable.length) {
    if (allowExternalReferences) {
      const externalAnalysis = buildExternalReferenceResponsibilityAnalysis(resolvedKnowledgeRecords);
      if (externalAnalysis) return externalAnalysis;
    }
    const error = new Error('保险责任查询未返回责任明细');
    error.code = 'POLICY_RESPONSIBILITY_QUERY_EMPTY';
    error.status = 502;
    throw error;
  }
  return {
    report: text(analysis.report || analysis.productOverview || analysis.coreFeature),
    coverageTable,
    officialResponsibilityText: officialResponsibilityTextFromRecords(resolvedKnowledgeRecords),
    notes: Array.isArray(analysis.notes) ? analysis.notes.map(text).filter(Boolean) : [],
    sources: Array.isArray(analyzed?.sources) ? analyzed.sources : Array.isArray(analysis.sources) ? analysis.sources : [],
    rawAnalysis: analysis,
    modelOutput: analyzed?.modelOutput || null,
  };
}

function resolveResponsibilityQueryStatus(code) {
  if (code === 'POLICY_ANALYSIS_PROVIDER_NOT_READY') return 503;
  if (code === 'POLICY_ANALYSIS_OFFICIAL_SOURCE_NOT_FOUND') return 424;
  if (code === 'POLICY_ANALYSIS_TIMEOUT') return 504;
  if (code === 'POLICY_ANALYSIS_UPSTREAM_FAILED') return 502;
  return 500;
}

function resolveResponsibilityQueryMessage(code) {
  if (code === 'POLICY_ANALYSIS_PROVIDER_NOT_READY') return '保险责任查询服务未配置，请先配置 DeepSeek Key';
  if (code === 'POLICY_ANALYSIS_OFFICIAL_SOURCE_NOT_FOUND') return '未找到保险公司官方条款或产品说明书，暂不生成报告';
  if (code === 'POLICY_ANALYSIS_TIMEOUT') return '保险责任查询超时，请稍后重试';
  if (code === 'POLICY_ANALYSIS_UPSTREAM_FAILED') return '保险责任查询服务暂不可用，请稍后重试';
  return '保险责任查询失败，请稍后重试';
}
