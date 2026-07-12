import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(projectRoot, '.runtime', 'local', 'policy-ocr.sqlite');
const DEFAULT_OUTPUT_DIR = path.join(projectRoot, 'reports', 'deepanalyze-indicator-review');

function trim(value) {
  return String(value ?? '').trim();
}

function normalizeSpaces(value) {
  return trim(value)
    .normalize('NFKC')
    .replace(/\r/gu, '\n')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s+/gu, ' ');
}

function parsePayload(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function toPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function splitList(value) {
  return trim(value)
    .split(',')
    .map((item) => trim(item))
    .filter(Boolean);
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function limitText(value, maxChars) {
  const text = normalizeSpaces(value);
  if (!maxChars || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 12))}...已截断`;
}

function sourceTextFromPayload(payload = {}) {
  const pageTexts = Array.isArray(payload.pages)
    ? payload.pages.map((page) => [page?.pageText, page?.text, page?.content].filter(Boolean).join('\n'))
    : [];
  return normalizeSpaces([
    payload.pageText,
    payload.text,
    payload.content,
    payload.body,
    payload.snippet,
    payload.responsibility,
    payload.analysis?.report,
    ...(Array.isArray(payload.analysis?.coverageTable)
      ? payload.analysis.coverageTable.map((row) => [row.coverageType, row.scenario, row.payout, row.note].filter(Boolean).join(' '))
      : []),
    ...pageTexts,
  ].filter(Boolean).join('\n'));
}

function responsibilityTextLooksUseful(value) {
  return /保险责任|保险金|给付|赔付|报销|津贴|年金|免赔额|给付比例|赔付比例/u.test(value);
}

function normalizeKnowledgeRow(row = {}, maxExcerptChars = 4000) {
  const payload = parsePayload(row.payload);
  const sourceText = sourceTextFromPayload(payload);
  return {
    reviewId: `no_indicator:${trim(row.id || payload.id)}`,
    reviewType: 'no_indicator_product',
    sourceRecordId: trim(row.id || payload.id),
    company: trim(row.company || payload.company),
    productName: trim(row.product_name || payload.productName),
    liability: '',
    quantificationStatus: 'no_indicator',
    sourceTitle: trim(payload.title || row.product_name || payload.productName),
    sourceUrl: trim(row.url || payload.url),
    sourceEvidenceLevel: trim(payload.sourceEvidenceLevel || payload.evidenceLevel || (trim(row.url || payload.url) ? 'official_excerpt' : 'local_excerpt')),
    sourceTextLength: sourceText.length,
    excerpt: limitText(sourceText, maxExcerptChars),
  };
}

function normalizeOptionalRow(row = {}, knowledgeById = new Map(), maxExcerptChars = 4000) {
  const payload = parsePayload(row.payload);
  const sourceRecordId = trim(payload.sourceRecordId);
  const source = sourceRecordId ? knowledgeById.get(sourceRecordId) : null;
  const sourcePayload = source ? parsePayload(source.payload) : {};
  const sourceText = normalizeSpaces(payload.sourceExcerpt || sourceTextFromPayload(sourcePayload));
  return {
    reviewId: `pending_optional:${trim(row.id)}`,
    reviewType: 'pending_optional_responsibility',
    optionalResponsibilityId: trim(row.id),
    sourceRecordId,
    company: trim(row.company || payload.company),
    productName: trim(row.product_name || payload.productName),
    liability: trim(row.liability || payload.liability || payload.title),
    quantificationStatus: trim(payload.quantificationStatus || 'pending_review'),
    quantificationReason: trim(payload.quantificationReason),
    sourceTitle: trim(payload.sourceTitle || sourcePayload.title || source?.product_name || payload.productName),
    sourceUrl: trim(payload.sourceUrl || source?.url || sourcePayload.url),
    sourceEvidenceLevel: trim(payload.sourceEvidenceLevel || (sourceRecordId ? 'official_terms' : 'local_excerpt')),
    selectionStatus: trim(payload.selectionStatus),
    sourceTextLength: sourceText.length,
    excerpt: limitText(sourceText, maxExcerptChars),
  };
}

function indicatorProductKeys(db) {
  if (!tableExists(db, 'insurance_indicator_records')) return new Set();
  return new Set(db.prepare(`
    SELECT DISTINCT COALESCE(company, '') AS company, COALESCE(product_name, '') AS product_name
      FROM insurance_indicator_records
     WHERE TRIM(COALESCE(product_name, '')) <> ''
  `).all().map((row) => `${trim(row.company)}\u001f${trim(row.product_name)}`));
}

function loadKnowledgeById(db) {
  if (!tableExists(db, 'knowledge_records')) return new Map();
  return new Map(db.prepare('SELECT id, company, product_name, url, payload FROM knowledge_records').all()
    .map((row) => [trim(row.id), row]));
}

function loadNoIndicatorSamples(db, {
  companies = [],
  limit = 50,
  minExcerptLength = 120,
  maxExcerptChars = 4000,
} = {}) {
  if (!tableExists(db, 'knowledge_records')) return [];
  const existingIndicators = indicatorProductKeys(db);
  const rows = db.prepare(`
    SELECT id, company, product_name, url, payload
      FROM knowledge_records
     WHERE TRIM(COALESCE(product_name, '')) <> ''
     ORDER BY company, product_name, id DESC
  `).all();
  const samples = [];
  const seenProducts = new Set();
  for (const row of rows) {
    const sample = normalizeKnowledgeRow(row, maxExcerptChars);
    if (!sample.company || !sample.productName) continue;
    if (companies.length && !companies.includes(sample.company)) continue;
    const key = `${sample.company}\u001f${sample.productName}`;
    if (seenProducts.has(key) || existingIndicators.has(key)) continue;
    if (sample.sourceTextLength < minExcerptLength || !responsibilityTextLooksUseful(sample.excerpt)) continue;
    seenProducts.add(key);
    samples.push(sample);
    if (samples.length >= limit) break;
  }
  return samples;
}

function loadPendingOptionalSamples(db, {
  companies = [],
  limit = 50,
  minExcerptLength = 80,
  maxExcerptChars = 4000,
} = {}) {
  if (!tableExists(db, 'optional_responsibility_records')) return [];
  const knowledgeById = loadKnowledgeById(db);
  const rows = db.prepare(`
    SELECT id, company, product_name, liability, payload
      FROM optional_responsibility_records
     WHERE json_extract(payload, '$.quantificationStatus') = 'pending_review'
     ORDER BY company, product_name, liability, id
  `).all();
  const samples = [];
  for (const row of rows) {
    const sample = normalizeOptionalRow(row, knowledgeById, maxExcerptChars);
    if (!sample.company || !sample.productName) continue;
    if (companies.length && !companies.includes(sample.company)) continue;
    if (sample.sourceTextLength < minExcerptLength || !responsibilityTextLooksUseful(sample.excerpt)) continue;
    samples.push(sample);
    if (samples.length >= limit) break;
  }
  return samples;
}

function balanceSamples({ noIndicatorSamples = [], pendingOptionalSamples = [], totalLimit = 50 } = {}) {
  const targetPending = Math.max(1, Math.floor(totalLimit * 0.3));
  const targetNoIndicator = totalLimit - targetPending;
  const selectedPending = pendingOptionalSamples.slice(0, targetPending);
  const selectedNoIndicator = noIndicatorSamples.slice(0, targetNoIndicator);
  const selectedIds = new Set([...selectedPending, ...selectedNoIndicator].map((sample) => sample.reviewId));
  const remainder = [...pendingOptionalSamples.slice(targetPending), ...noIndicatorSamples.slice(targetNoIndicator)]
    .filter((sample) => !selectedIds.has(sample.reviewId))
    .slice(0, totalLimit - selectedPending.length - selectedNoIndicator.length);
  return [...selectedPending, ...selectedNoIndicator, ...remainder].slice(0, totalLimit);
}

export function loadDeepAnalyzeIndicatorReviewSamples({
  dbPath = DEFAULT_DB_PATH,
  limit = 50,
  companies = [],
  minExcerptLength = 120,
  maxExcerptChars = 4000,
} = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON');
    const noIndicatorSamples = loadNoIndicatorSamples(db, {
      companies,
      limit,
      minExcerptLength,
      maxExcerptChars,
    });
    const pendingOptionalSamples = loadPendingOptionalSamples(db, {
      companies,
      limit,
      minExcerptLength: Math.min(80, minExcerptLength),
      maxExcerptChars,
    });
    const samples = balanceSamples({ noIndicatorSamples, pendingOptionalSamples, totalLimit: limit });
    return {
      dbPath,
      totalSamples: samples.length,
      noIndicatorLoaded: noIndicatorSamples.length,
      pendingOptionalLoaded: pendingOptionalSamples.length,
      samples,
    };
  } finally {
    db.close();
  }
}

export function renderDeepAnalyzePrompt({ jsonlFileName = 'samples.jsonl', sampleCount = 0 } = {}) {
  return `# DeepAnalyze 保险责任指标候选审计任务

## 输入数据

请读取工作区中的 \`${jsonlFileName}\`。该文件为 JSONL，每行是一条来自 OCR_insurance SQLite 的只读审计样本，共 ${sampleCount} 条。不要修改原文件，不要写数据库。

每条样本包含：

- \`reviewId\`: 审计样本 ID。
- \`reviewType\`: \`no_indicator_product\` 或 \`pending_optional_responsibility\`。
- \`company\`, \`productName\`, \`liability\`: 公司、产品和可选责任名。
- \`sourceRecordId\`, \`optionalResponsibilityId\`, \`sourceUrl\`, \`sourceTitle\`: 来源定位字段。
- \`excerpt\`: 官方条款/说明书中的责任文本摘录。

## 任务

你是一名保险责任指标审计助手。请只基于 \`excerpt\` 中的明示证据，判断每条样本是否存在可结构化入库的责任指标候选。

分类必须使用以下四种之一：

- \`可入库候选\`: 责任名称清晰，公式或数值可由摘录直接支持。
- \`需人工补责任名\`: 公式或数值可用，但责任名称泛化、截断或 OCR 破损。
- \`疑似误识别/暂不入库\`: 触发内容来自责任免除、退保、现金价值说明、合同终止、非责任说明、计划概述或责任名不成立。
- \`仍未识别\`: 没有足够证据形成可复核指标。

## 质量规则

- 不要把 \`给付比例\`、\`赔付比例\`、\`约定比例\` 推断成固定百分比；如果变量明确，输出 \`unit: "公式"\`。
- 医疗费用报销可输出公式，例如 \`(实际合理医疗费用 - 已获补偿/给付 - 免赔额) × 约定给付比例\`。
- 住院/护理/津贴类应使用 \`给付天数 × 日津贴额/住院日额津贴/保险金额/基本保险金额\`，不要套用医疗费用公式。
- 伤残/残疾表按 \`保险金额 × 伤残/残疾等级给付比例\`，不要写固定 100%。
- \`max(现金价值, 已交保险费)\`、退费、解除合同、责任终止等只在明确命名为身故、全残、满期、生存、年金、养老等保险责任时才作为候选。
- 每个候选都必须有 \`sourceQuote\`，从摘录中截取不超过 160 字的原文证据。

## 输出格式

只输出 JSON，不要输出 Markdown 解释。结构如下：

\`\`\`json
{
  "summary": {
    "totalReviewed": 0,
    "可入库候选": 0,
    "需人工补责任名": 0,
    "疑似误识别/暂不入库": 0,
    "仍未识别": 0
  },
  "items": [
    {
      "reviewId": "no_indicator:123",
      "decision": "可入库候选",
      "reason": "一句话说明判断依据",
      "candidates": [
        {
          "coverageType": "医疗保障",
          "liability": "住院医疗保险金",
          "value": null,
          "unit": "公式",
          "basis": "实际合理医疗费用、已获补偿/给付、免赔额、约定给付比例",
          "formulaText": "住院医疗保险金 = (实际合理医疗费用 - 已获补偿/给付 - 免赔额) × 约定给付比例",
          "sourceQuote": "原文证据，不超过160字",
          "confidence": 0.85,
          "ruleGap": "现有规则可能缺少的模式；没有则为空"
        }
      ],
      "rejectReason": ""
    }
  ]
}
\`\`\`
`;
}

function outputPaths(outputDir, stamp) {
  const baseName = `deepanalyze-indicator-review-${stamp}`;
  return {
    jsonlPath: path.join(outputDir, `${baseName}.jsonl`),
    promptPath: path.join(outputDir, `${baseName}-prompt.md`),
    summaryPath: path.join(outputDir, `${baseName}-summary.json`),
  };
}

export async function buildDeepAnalyzeIndicatorReviewPackage({
  dbPath = DEFAULT_DB_PATH,
  outputDir = DEFAULT_OUTPUT_DIR,
  limit = 50,
  companies = [],
  minExcerptLength = 120,
  maxExcerptChars = 4000,
  now = new Date(),
} = {}) {
  const stamp = now.toISOString().replace(/[:.]/gu, '-');
  const sampleResult = loadDeepAnalyzeIndicatorReviewSamples({
    dbPath,
    limit,
    companies,
    minExcerptLength,
    maxExcerptChars,
  });
  await fs.mkdir(outputDir, { recursive: true });
  const paths = outputPaths(outputDir, stamp);
  const jsonl = sampleResult.samples.map((sample) => JSON.stringify(sample)).join('\n');
  await fs.writeFile(paths.jsonlPath, jsonl ? `${jsonl}\n` : '', 'utf8');
  await fs.writeFile(paths.promptPath, renderDeepAnalyzePrompt({
    jsonlFileName: path.basename(paths.jsonlPath),
    sampleCount: sampleResult.totalSamples,
  }), 'utf8');
  const byType = sampleResult.samples.reduce((counts, sample) => {
    counts[sample.reviewType] = (counts[sample.reviewType] || 0) + 1;
    return counts;
  }, {});
  const summary = {
    dbPath,
    outputDir,
    dryRun: true,
    writeTarget: 'reports_only',
    sampleCount: sampleResult.totalSamples,
    noIndicatorLoaded: sampleResult.noIndicatorLoaded,
    pendingOptionalLoaded: sampleResult.pendingOptionalLoaded,
    byType,
    files: paths,
    nextStep: 'Upload the JSONL file to DeepAnalyze with the generated prompt, then review candidates before any database write.',
  };
  await fs.writeFile(paths.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = path.resolve(readArg('db-path', DEFAULT_DB_PATH));
  const outputDir = path.resolve(readArg('output-dir', DEFAULT_OUTPUT_DIR));
  const result = await buildDeepAnalyzeIndicatorReviewPackage({
    dbPath,
    outputDir,
    limit: toPositiveInteger(readArg('limit', '50'), 50),
    companies: splitList(readArg('companies', '')),
    minExcerptLength: toPositiveInteger(readArg('min-excerpt-length', '120'), 120),
    maxExcerptChars: toPositiveInteger(readArg('max-excerpt-chars', '4000'), 4000),
  });
  console.log(JSON.stringify(result, null, 2));
}
