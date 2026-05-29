import { analyzeInsurancePolicyResponsibilities } from './c-policy-analysis.service.mjs';
import { buildKnowledgeSearchArtifacts } from './policy-knowledge.service.mjs';

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

export function buildLocalKnowledgeResponsibilityAnalysis(records = []) {
  const sources = [];
  const rows = [];
  const seenRows = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    const pageText = text(record?.pageText);
    if (!pageText) continue;
    sources.push({
      title: text(record.title) || text(record.url),
      url: text(record.url),
      snippet: text(record.snippet),
      evidenceLabel: text(record.evidenceLabel) || '本地知识库官方资料',
      evidenceLevel: text(record.evidenceLevel) || 'insurer_official',
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
      });
    }
    break;
  }
  if (!rows.length) return null;
  return {
    report: '',
    coverageTable: rows,
    notes: ['本结果直接返回本地/飞书知识库保险责任正文，未拆分责任卡片，也未等待模型重写。'],
    sources: sources.filter((source) => source.url).slice(0, 5),
    rawAnalysis: {
      generatedBy: 'local_knowledge_fast_path',
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
  }

  for (const failure of failures) {
    const productName = text(failure?.productName);
    const message = text(failure?.error?.message || failure?.error);
    if (productName && message) notes.push(`${productName}: ${message}`);
  }

  return {
    report: reports.join('\n\n'),
    coverageTable,
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
}) {
  const localRecords = Array.isArray(knowledgeRecords) ? knowledgeRecords : [];
  const localArtifacts = buildKnowledgeSearchArtifacts({
    policy,
    records: localRecords,
    officialDomainProfiles,
  });
  if (localArtifacts.sources.length) return localArtifacts.records;
  if (typeof resolveFeishuKnowledgeRecords !== 'function') return localRecords;
  try {
    const feishuRecords = await resolveFeishuKnowledgeRecords({ policy, officialDomainProfiles });
    const feishuArtifacts = buildKnowledgeSearchArtifacts({
      policy,
      records: feishuRecords,
      officialDomainProfiles,
    });
    if (feishuArtifacts.sources.length) return feishuArtifacts.records;
  } catch {
    return localRecords;
  }
  return localRecords;
}

export async function queryPolicyResponsibilities({
  scan,
  query = analyzeInsurancePolicyResponsibilities,
  officialDomainProfiles = [],
  knowledgeRecords = [],
  resolveFeishuKnowledgeRecords = null,
  preferLocalKnowledgeAnswer = false,
  maxAttempts = 2,
}) {
  const policy = normalizePolicyForResponsibilityQuery(scan);
  const resolvedKnowledgeRecords = await resolveKnowledgeRecordsForResponsibilityQuery({
    policy,
    officialDomainProfiles,
    knowledgeRecords,
    resolveFeishuKnowledgeRecords,
  });
  if (preferLocalKnowledgeAnswer) {
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
    const error = new Error('保险责任查询未返回责任明细');
    error.code = 'POLICY_RESPONSIBILITY_QUERY_EMPTY';
    error.status = 502;
    throw error;
  }
  return {
    report: text(analysis.report || analysis.productOverview || analysis.coreFeature),
    coverageTable,
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
