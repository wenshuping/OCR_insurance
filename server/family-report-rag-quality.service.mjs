import {
  generateFamilyReportQualityIssues,
} from './family-report-quality.service.mjs';

const DEFAULT_LLM_WIKI_BASE_URL = 'http://127.0.0.1:19828';
const DEFAULT_LLM_WIKI_PROJECT_ID = 'current';
const DEFAULT_TOP_K = 3;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_QUERIES_PER_POLICY = 8;
const DEFAULT_MAX_EVIDENCE_PER_POLICY = 10;
const DEFAULT_MAX_EVIDENCE_TEXT = 1200;

function trim(value) {
  return String(value || '').trim();
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampInteger(value, fallback, min, max) {
  const number = Math.trunc(finiteNumber(value, fallback));
  return Math.max(min, Math.min(max, number));
}

function excerpt(value, limit = DEFAULT_MAX_EVIDENCE_TEXT) {
  const text = trim(value).replace(/\s+/gu, ' ');
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function normalizeTextKey(value) {
  return trim(value).normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
}

function uniqueTexts(values = []) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const text = trim(value);
    const key = normalizeTextKey(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
  }
  return output;
}

function policyProductNames(policy = {}) {
  const planNames = (Array.isArray(policy.plans) ? policy.plans : [])
    .map((plan) => plan?.matchedProductName || plan?.productName || plan?.name);
  return uniqueTexts([
    policy.name,
    policy.productName,
    ...planNames,
  ]).slice(0, 4);
}

export function resolveFamilyReportRagConfig(env = process.env) {
  return {
    enabled: trim(env.FAMILY_REPORT_RAG_ENABLED || '1') !== '0',
    baseUrl: trim(env.LLM_WIKI_API_BASE_URL) || DEFAULT_LLM_WIKI_BASE_URL,
    token: trim(env.LLM_WIKI_API_TOKEN),
    projectId: trim(env.FAMILY_REPORT_RAG_PROJECT_ID || env.LLM_WIKI_PROJECT_ID) || DEFAULT_LLM_WIKI_PROJECT_ID,
    topK: clampInteger(env.FAMILY_REPORT_RAG_TOP_K || env.LLM_WIKI_TOP_K, DEFAULT_TOP_K, 1, 10),
    timeoutMs: clampInteger(env.FAMILY_REPORT_RAG_TIMEOUT_MS || env.LLM_WIKI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 2_000, 60_000),
    maxQueriesPerPolicy: clampInteger(env.FAMILY_REPORT_RAG_MAX_QUERIES_PER_POLICY, DEFAULT_MAX_QUERIES_PER_POLICY, 1, 20),
    maxEvidencePerPolicy: clampInteger(env.FAMILY_REPORT_RAG_MAX_EVIDENCE_PER_POLICY, DEFAULT_MAX_EVIDENCE_PER_POLICY, 1, 30),
  };
}

export function buildFamilyReportPolicyEvidenceQueries(policy = {}) {
  const company = trim(policy.company);
  const productNames = policyProductNames(policy);
  if (!productNames.length) return [];

  const queryTemplates = [
    { dimension: 'overview', terms: '保险责任 产品类型 主险 附加险 条款' },
    { dimension: 'life', terms: '身故 全残 有效保险金额 基本保险金额 红利 赔付方式' },
    { dimension: 'critical', terms: '重大疾病 轻症 中症 癌症 额外给付 保险金' },
    { dimension: 'medical', terms: '住院 医疗 报销 免赔额 赔付比例 日额 津贴' },
    { dimension: 'wealth', terms: '生存金 年金 教育金 满期金 领取 年份 金额' },
  ];

  return productNames.flatMap((productName) => {
    const identity = [company, productName].filter(Boolean).join(' ');
    return queryTemplates.map((template) => ({
      dimension: template.dimension,
      productName,
      query: `${identity} ${template.terms}`.trim(),
    }));
  });
}

function normalizeBaseUrl(value) {
  return (trim(value) || DEFAULT_LLM_WIKI_BASE_URL).replace(/\/+$/u, '');
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await options.fetchImpl(url, {
      method: options.method || 'GET',
      signal: controller.signal,
      headers: options.headers,
      body: options.body,
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`LLM_WIKI_NON_JSON_RESPONSE:${text.slice(0, 300)}`);
    }
    if (!response.ok || payload?.ok === false) {
      throw new Error(`LLM_WIKI_UPSTREAM_${response.status}:${trim(payload?.error) || response.statusText || 'upstream_error'}`);
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('LLM_WIKI_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeSearchResult(result = {}, query = {}) {
  const content = trim(result.content) || trim(result.snippet);
  if (!content) return null;
  return {
    dimension: trim(query.dimension),
    query: trim(query.query),
    path: trim(result.path),
    title: trim(result.title),
    snippet: excerpt(result.snippet, 500),
    content: excerpt(content),
    score: finiteNumber(result.score, null),
    vectorScore: finiteNumber(result.vectorScore, null),
  };
}

async function searchLlmWikiEvidence(query, { config, fetchImpl }) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const url = new URL(`/api/v1/projects/${encodeURIComponent(config.projectId)}/search`, baseUrl);
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;

  const payload = await fetchJsonWithTimeout(url, {
    fetchImpl,
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: query.query,
      topK: config.topK,
      includeContent: true,
    }),
  }, config.timeoutMs);

  return (Array.isArray(payload.results) ? payload.results : [])
    .map((result) => normalizeSearchResult(result, query))
    .filter(Boolean);
}

function dedupeEvidence(results = [], limit = DEFAULT_MAX_EVIDENCE_PER_POLICY) {
  const seen = new Set();
  const output = [];
  for (const result of results) {
    const key = normalizeTextKey([result.path, result.title, result.content].join('|'));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(result);
    if (output.length >= limit) break;
  }
  return output;
}

function evidenceSourceUrl(projectId, evidence = {}) {
  if (!evidence.path) return `llm-wiki:${projectId}`;
  return `llm-wiki:${projectId}:${evidence.path}`;
}

function buildRagKnowledgeRecord(policyEvidence = {}, config = {}) {
  const evidence = Array.isArray(policyEvidence.evidence) ? policyEvidence.evidence : [];
  if (!evidence.length) return null;

  const pageText = [
    'LLM Wiki 检索证据，供 DeepSeek 质检时作为官网条款/产品 Wiki 的补充依据；最终报告仍由代码校验后落库。',
    ...evidence.map((item, index) => [
      `[${index + 1}] dimension=${item.dimension || 'unknown'}`,
      `query=${item.query}`,
      `title=${item.title || '-'}`,
      `path=${item.path || '-'}`,
      item.score === null ? '' : `score=${item.score}`,
      `content=${item.content}`,
    ].filter(Boolean).join('\n')),
  ].join('\n\n');

  return {
    company: policyEvidence.company,
    productName: policyEvidence.productName,
    productType: 'LLM Wiki/RAG evidence',
    officialUrl: evidenceSourceUrl(config.projectId || DEFAULT_LLM_WIKI_PROJECT_ID, evidence[0]),
    pageText,
  };
}

export async function collectFamilyReportLlmWikiEvidence({
  policies = [],
  fetchImpl = globalThis.fetch,
  env = process.env,
} = {}) {
  const config = resolveFamilyReportRagConfig(env);
  const policyList = Array.isArray(policies) ? policies : [];
  const errors = [];
  const policyEvidence = [];

  if (!config.enabled || !policyList.length) {
    return { policyEvidence, knowledgeRecords: [], errors, config: { ...config, token: '' } };
  }
  if (typeof fetchImpl !== 'function') {
    return {
      policyEvidence,
      knowledgeRecords: [],
      errors: [{ code: 'LLM_WIKI_FETCH_UNAVAILABLE', message: 'fetchImpl is not available' }],
      config: { ...config, token: '' },
    };
  }

  for (const policy of policyList) {
    const queries = buildFamilyReportPolicyEvidenceQueries(policy).slice(0, config.maxQueriesPerPolicy);
    const results = [];
    for (const query of queries) {
      try {
        results.push(...await searchLlmWikiEvidence(query, { config, fetchImpl }));
      } catch (error) {
        errors.push({
          code: 'LLM_WIKI_SEARCH_FAILED',
          policyId: Number(policy?.id || 0) || null,
          productName: trim(policy?.name || policy?.productName),
          query: query.query,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const evidence = dedupeEvidence(results, config.maxEvidencePerPolicy);
    policyEvidence.push({
      policyId: Number(policy?.id || 0) || null,
      company: trim(policy?.company),
      productName: trim(policy?.name || policy?.productName),
      evidence,
    });
  }

  const knowledgeRecords = policyEvidence
    .map((item) => buildRagKnowledgeRecord(item, config))
    .filter(Boolean);
  return { policyEvidence, knowledgeRecords, errors, config: { ...config, token: '' } };
}

export async function generateFamilyReportQualityIssuesWithLlmWikiEvidence({
  knowledgeRecords = [],
  fetchImpl = globalThis.fetch,
  env = process.env,
  ...input
} = {}) {
  const rag = await collectFamilyReportLlmWikiEvidence({
    policies: input.policies,
    fetchImpl,
    env,
  });
  return generateFamilyReportQualityIssues({
    ...input,
    knowledgeRecords: [
      ...rag.knowledgeRecords,
      ...(Array.isArray(knowledgeRecords) ? knowledgeRecords : []),
    ],
    fetchImpl,
    env,
  });
}

export const generateFamilyReportQualityIssuesWithRag = generateFamilyReportQualityIssuesWithLlmWikiEvidence;
