import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { buildOptionalResponsibilityId } from '../server/optional-responsibility-governance.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');

const COMPANY = '中华人寿';
const PRODUCT_NAME = '中华健乐臻倍2025重大疾病保险';
const PRODUCT_TYPE = '健康保险';
const SALES_STATUS = '在售';
const SOURCE_RECORD_ID = 25724;
const SOURCE_TITLE = '中华健乐臻倍2025重大疾病保险产品说明书';
const SOURCE_URL =
  'https://faos-static-prd.life.cic.cn/term-lib/cpsms/2025/11/19/12-3-%E4%B8%AD%E5%8D%8E%E5%81%A5%E4%B9%90%E8%87%BB%E5%80%8D2025%E9%87%8D%E5%A4%A7%E7%96%BE%E7%97%85%E4%BF%9D%E9%99%A9%E4%BA%A7%E5%93%81%E8%AF%B4%E6%98%8E%E4%B9%A6.pdf';
const VERSION = '2026-05-31-zhonghua-jianle-zhenbei-2025';
const DB_PATHS = [
  path.join(runtimeDir, 'policy-ocr.sqlite'),
  path.join(runtimeDir, 'local', 'policy-ocr.sqlite'),
];

function trim(value) {
  return String(value ?? '').trim();
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function qid(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function backupSqlite(dbPath) {
  if (!(await exists(dbPath))) return [];
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  await fs.mkdir(backupDir, { recursive: true });
  const label = dbPath.includes(`${path.sep}local${path.sep}`) ? 'local-policy-ocr' : 'policy-ocr';
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const backupBase = path.join(backupDir, `${label}-before-zhonghua-jianle-repair-${stamp}.sqlite`);
  const copied = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${dbPath}${suffix}`;
    if (!(await exists(source))) continue;
    const target = `${backupBase}${suffix}`;
    await fs.copyFile(source, target);
    copied.push(target);
  }
  return copied;
}

async function fetchPdfBuffer() {
  const response = await fetch(SOURCE_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/pdf,*/*',
    },
  });
  if (!response.ok) throw new Error(`PDF 下载失败：HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function extractPdfText(buffer) {
  const result = spawnSync(
    'python3',
    [
      '-c',
      [
        'import base64, io, sys',
        'from pypdf import PdfReader',
        'data = base64.b64decode(sys.stdin.read())',
        'reader = PdfReader(io.BytesIO(data))',
        "print('\\n'.join((page.extract_text() or '') for page in reader.pages))",
      ].join('\n'),
    ],
    {
      input: Buffer.from(buffer || []).toString('base64'),
      encoding: 'utf8',
      maxBuffer: 30 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(trim(result.stderr) || 'PDF 文本抽取失败');
  }
  return trim(result.stdout);
}

function normalizeOneLine(text) {
  return trim(text)
    .replace(/\r/gu, '\n')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s+/gu, ' ');
}

function extractRange(text, startPattern, endPattern) {
  const source = normalizeOneLine(text);
  const start = source.search(startPattern);
  if (start < 0) return '';
  const tail = source.slice(start);
  const end = tail.slice(20).search(endPattern);
  return trim(end >= 0 ? tail.slice(0, 20 + end) : tail);
}

function excerptAround(text, markerPattern, length = 520) {
  const source = normalizeOneLine(text);
  const index = source.search(markerPattern);
  if (index < 0) return source.slice(0, length);
  return trim(source.slice(Math.max(0, index - 24), index + length));
}

function indicatorId(liability, condition = '') {
  const digest = crypto
    .createHash('sha1')
    .update(['zhonghua-jianle-zhenbei-2025', COMPANY, PRODUCT_NAME, liability, condition].join('\u001f'))
    .digest('hex')
    .slice(0, 18);
  return `ind_zh_jlz_${digest}`;
}

function optionalIndicatorId(optionalResponsibilityId, liability, condition = '') {
  const digest = crypto
    .createHash('sha1')
    .update(['zhonghua-jianle-zhenbei-2025-optional', optionalResponsibilityId, COMPANY, PRODUCT_NAME, liability, condition].join('\u001f'))
    .digest('hex')
    .slice(0, 18);
  return `ind_zh_jlz_opt_${digest}`;
}

function valueText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function buildIndicator({
  id,
  coverageType,
  liability,
  value = null,
  unit = '',
  basis = '',
  formulaText = '',
  condition = '',
  sourceExcerpt = '',
  responsibilityScope = 'basic',
  optionalResponsibilityId = '',
  quantificationStatus = 'quantified',
  excludeFromCalculation = false,
}) {
  return {
    id,
    version: VERSION,
    company: COMPANY,
    productName: PRODUCT_NAME,
    productType: PRODUCT_TYPE,
    salesStatus: SALES_STATUS,
    coverageType,
    liability,
    value,
    valueText: valueText(value),
    unit,
    basis,
    formulaText,
    condition,
    extractionMethod: 'official_pdf_responsibility_rule_repair',
    sourceRecordId: String(SOURCE_RECORD_ID),
    sourceUrl: SOURCE_URL,
    sourceTitle: SOURCE_TITLE,
    sourceExcerpt: trim(sourceExcerpt).slice(0, 900),
    sourceEvidenceLevel: 'official_terms',
    responsibilityScope,
    optionalResponsibilityId,
    quantificationStatus,
    excludeFromCalculation,
    updatedAt: new Date().toISOString(),
  };
}

function buildKnowledgePayload(existingPayload, pageText) {
  return {
    ...existingPayload,
    id: SOURCE_RECORD_ID,
    company: COMPANY,
    productName: PRODUCT_NAME,
    productType: PRODUCT_TYPE,
    salesStatus: SALES_STATUS,
    title: SOURCE_TITLE,
    url: SOURCE_URL,
    snippet: '中华人寿官网产品说明书，已重新抽取完整保险责任正文及等待期段。',
    pageText,
    sourceType: 'pdf',
    materialType: 'product_manual',
    official: true,
    evidenceLabel: '本地知识库官方资料',
    evidenceLevel: 'insurer_official',
    officialDomain: 'life.cic.cn',
    parser: 'zhonghua_jianle_zhenbei_2025_repair',
    repairedAt: new Date().toISOString(),
  };
}

function buildOptionalRecord({ liability, sourceExcerpt, indicatorIds }) {
  const id = buildOptionalResponsibilityId({ company: COMPANY, productName: PRODUCT_NAME, liability });
  return {
    id,
    company: COMPANY,
    productName: PRODUCT_NAME,
    coverageType: '可选责任',
    liability,
    title: liability,
    responsibilityScope: 'optional',
    selectionStatus: 'unknown',
    selectionEvidence: 'official_terms',
    quantificationStatus: indicatorIds.length ? 'quantified' : 'pending_review',
    quantificationReason: indicatorIds.length ? '' : '缺少可计算结构化指标',
    indicatorIds,
    sourceExcerpt: trim(sourceExcerpt).slice(0, 4000),
    sourceRecordId: String(SOURCE_RECORD_ID),
    sourceUrl: SOURCE_URL,
    sourceTitle: SOURCE_TITLE,
  };
}

function buildRepairPayload(rawText) {
  const responsibilityText = extractRange(rawText, /1\.1\s*保险责任|保险责任\s*在本合同保险期间内/u, /1\.2\s*责任免除/u);
  if (!responsibilityText || !/可选保险责任二|特定心脑血管重大疾病二次给付关爱保险金/u.test(responsibilityText)) {
    throw new Error('未抽取到完整保险责任正文');
  }
  const waitingText = extractRange(rawText, /1\.7\s*等待期/u, /1\.8\s*犹豫期/u);
  const pageText = [responsibilityText, waitingText].filter(Boolean).join('\n\n');
  const optionalOneText = extractRange(responsibilityText, /可选保险责任一/u, /可选保险责任二/u);
  const optionalTwoText = extractRange(responsibilityText, /可选保险责任二/u, /特别提示/u);
  if (!optionalOneText || !optionalTwoText) throw new Error('未定位到完整可选责任一/二');

  const optionalOneId = buildOptionalResponsibilityId({ company: COMPANY, productName: PRODUCT_NAME, liability: '可选责任一' });
  const optionalTwoId = buildOptionalResponsibilityId({ company: COMPANY, productName: PRODUCT_NAME, liability: '可选责任二' });
  const optionalIndicators = [
    buildIndicator({
      id: optionalIndicatorId(optionalOneId, '轻症(首次给付)', '每次30%，最多6次'),
      coverageType: '疾病保障',
      liability: '轻症(首次给付)',
      value: 30,
      unit: '%',
      basis: '基本保险金额',
      formulaText: '轻度疾病保险金 = 基本保险金额 × 30%',
      condition: '可选责任一；轻度疾病每次给付30%，最多6次；第2-6次须距前次确诊满90日',
      sourceExcerpt: excerptAround(optionalOneText, /第一次轻度疾病保险金/u),
      responsibilityScope: 'optional',
      optionalResponsibilityId: optionalOneId,
    }),
    buildIndicator({
      id: optionalIndicatorId(optionalOneId, '轻症疾病种数'),
      coverageType: '疾病保障',
      liability: '轻症疾病种数',
      value: 40,
      unit: '种',
      basis: '疾病定义数量',
      condition: '可选责任一',
      sourceExcerpt: excerptAround(optionalOneText, /轻度疾病共40种/u),
      responsibilityScope: 'optional',
      optionalResponsibilityId: optionalOneId,
    }),
    buildIndicator({
      id: optionalIndicatorId(optionalOneId, '责任给付次数上限', '轻度疾病保险金'),
      coverageType: '规则参数',
      liability: '责任给付次数上限',
      value: 6,
      unit: '次',
      basis: '轻度疾病保险金',
      condition: '可选责任一；轻度疾病保险金累计给付次数',
      sourceExcerpt: excerptAround(optionalOneText, /第六次轻度疾病保险金/u),
      responsibilityScope: 'optional',
      optionalResponsibilityId: optionalOneId,
    }),
    buildIndicator({
      id: optionalIndicatorId(optionalOneId, '中症(首次给付)', '每次50%，最多3次'),
      coverageType: '疾病保障',
      liability: '中症(首次给付)',
      value: 50,
      unit: '%',
      basis: '基本保险金额',
      formulaText: '中度疾病保险金 = 基本保险金额 × 50%',
      condition: '可选责任一；中度疾病每次给付50%，最多3次；第2-3次须距前次确诊满90日',
      sourceExcerpt: excerptAround(optionalOneText, /第一次中度疾病保险金/u),
      responsibilityScope: 'optional',
      optionalResponsibilityId: optionalOneId,
    }),
    buildIndicator({
      id: optionalIndicatorId(optionalOneId, '中症疾病种数'),
      coverageType: '疾病保障',
      liability: '中症疾病种数',
      value: 20,
      unit: '种',
      basis: '疾病定义数量',
      condition: '可选责任一',
      sourceExcerpt: excerptAround(optionalOneText, /中度疾病共20种/u),
      responsibilityScope: 'optional',
      optionalResponsibilityId: optionalOneId,
    }),
    buildIndicator({
      id: optionalIndicatorId(optionalOneId, '责任给付次数上限', '中度疾病保险金'),
      coverageType: '规则参数',
      liability: '责任给付次数上限',
      value: 3,
      unit: '次',
      basis: '中度疾病保险金',
      condition: '可选责任一；中度疾病保险金累计给付次数',
      sourceExcerpt: excerptAround(optionalOneText, /第三次中度疾病保险金/u),
      responsibilityScope: 'optional',
      optionalResponsibilityId: optionalOneId,
    }),
    buildIndicator({
      id: optionalIndicatorId(optionalTwoId, '恶性肿瘤-重度二次给付关爱保险金'),
      coverageType: '疾病保障',
      liability: '恶性肿瘤-重度二次给付关爱保险金',
      value: 100,
      unit: '%',
      basis: '基本保险金额',
      formulaText: '恶性肿瘤-重度二次给付关爱保险金 = 基本保险金额 × 100%',
      condition: '可选责任二；初次恶性肿瘤-重度已给付重大疾病保险金；确诊满3年后且85周岁前再次确诊；给付1次',
      sourceExcerpt: excerptAround(optionalTwoText, /恶性肿瘤-\s*重度二次/u),
      responsibilityScope: 'optional',
      optionalResponsibilityId: optionalTwoId,
    }),
    buildIndicator({
      id: optionalIndicatorId(optionalTwoId, '特定心脑血管重大疾病二次给付关爱保险金'),
      coverageType: '疾病保障',
      liability: '特定心脑血管重大疾病二次给付关爱保险金',
      value: 100,
      unit: '%',
      basis: '基本保险金额',
      formulaText: '特定心脑血管重大疾病二次给付关爱保险金 = 基本保险金额 × 100%',
      condition: '可选责任二；较重急性心肌梗死或严重脑中风后遗症已给付重大疾病保险金；确诊满3年后且85周岁前再次确诊同一种疾病；给付1次',
      sourceExcerpt: excerptAround(optionalTwoText, /特定心脑\s*血管重大\s*疾病二次/u),
      responsibilityScope: 'optional',
      optionalResponsibilityId: optionalTwoId,
    }),
    buildIndicator({
      id: optionalIndicatorId(optionalTwoId, '责任给付次数上限', '恶性肿瘤二次'),
      coverageType: '规则参数',
      liability: '责任给付次数上限',
      value: 1,
      unit: '次',
      basis: '恶性肿瘤-重度二次给付关爱保险金',
      condition: '可选责任二；恶性肿瘤-重度二次给付关爱保险金',
      sourceExcerpt: excerptAround(optionalTwoText, /恶性肿瘤-\s*重度二次给付关爱保险金的给付次数以一次为限/u),
      responsibilityScope: 'optional',
      optionalResponsibilityId: optionalTwoId,
    }),
    buildIndicator({
      id: optionalIndicatorId(optionalTwoId, '责任给付次数上限', '心脑血管二次'),
      coverageType: '规则参数',
      liability: '责任给付次数上限',
      value: 1,
      unit: '次',
      basis: '特定心脑血管重大疾病二次给付关爱保险金',
      condition: '可选责任二；特定心脑血管重大疾病二次给付关爱保险金',
      sourceExcerpt: excerptAround(optionalTwoText, /特定心脑\s*血管重大\s*疾病二次给付关爱保险金的给付次数以一次为限/u),
      responsibilityScope: 'optional',
      optionalResponsibilityId: optionalTwoId,
    }),
  ];

  const basicIndicators = [
    buildIndicator({
      id: indicatorId('等待期'),
      coverageType: '规则参数',
      liability: '等待期',
      value: 90,
      unit: '日',
      basis: '合同等待期',
      condition: '疾病触发轻度疾病、中度疾病、重大疾病、全残或身故；意外伤害无等待期',
      sourceExcerpt: excerptAround(pageText, /1\.7\s*等待期|等待期/u),
      responsibilityScope: 'rule_parameter',
    }),
    buildIndicator({
      id: indicatorId('等待期退费处理'),
      coverageType: '规则参数',
      liability: '等待期退费处理',
      unit: '公式',
      basis: '已交保险费',
      formulaText: '等待期内因疾病发生约定保险事故 = 无息退还已交保险费',
      condition: '本合同生效或最后复效之日起90日内；因疾病发生约定情形',
      sourceExcerpt: excerptAround(pageText, /无息退还已交保险费/u),
      responsibilityScope: 'rule_parameter',
    }),
    buildIndicator({
      id: indicatorId('重疾疾病种数'),
      coverageType: '疾病保障',
      liability: '重疾疾病种数',
      value: 130,
      unit: '种',
      basis: '疾病定义数量',
      sourceExcerpt: excerptAround(responsibilityText, /重大疾病共130种/u),
    }),
    buildIndicator({
      id: indicatorId('重疾疾病分组数'),
      coverageType: '疾病保障',
      liability: '重疾疾病分组数',
      value: 6,
      unit: '组',
      basis: '重大疾病分组',
      sourceExcerpt: excerptAround(responsibilityText, /分为六组/u),
    }),
    buildIndicator({
      id: indicatorId('重疾(首次给付)', '首次'),
      coverageType: '疾病保障',
      liability: '重疾(首次给付)',
      unit: '公式',
      basis: '基本保险金额/现金价值/已交保险费',
      formulaText: '第一次重大疾病保险金 = max(基本保险金额, 现金价值, 已交保险费)',
      condition: '初次确诊本合同所指一种或多种重大疾病',
      sourceExcerpt: excerptAround(responsibilityText, /第一次重大疾病保险金/u),
    }),
    buildIndicator({
      id: indicatorId('重疾(后续给付)', '第2-6次'),
      coverageType: '疾病保障',
      liability: '重疾(后续给付)',
      value: 100,
      unit: '%',
      basis: '基本保险金额',
      formulaText: '第二至第六次重大疾病保险金 = 基本保险金额 × 100%',
      condition: '85周岁前；距前一次重大疾病确诊满365日；不同组别重大疾病',
      sourceExcerpt: excerptAround(responsibilityText, /第二次重大疾病保险金/u),
    }),
    buildIndicator({
      id: indicatorId('责任给付次数上限', '重大疾病保险金'),
      coverageType: '规则参数',
      liability: '责任给付次数上限',
      value: 6,
      unit: '次',
      basis: '重大疾病保险金',
      condition: '重大疾病保险金累计给付次数；每组重大疾病给付1次',
      sourceExcerpt: excerptAround(responsibilityText, /累计给付次数以六次为限/u),
      responsibilityScope: 'rule_parameter',
    }),
    buildIndicator({
      id: indicatorId('疾病全残', '18周岁前'),
      coverageType: '人寿保障',
      liability: '疾病全残',
      value: 100,
      unit: '%',
      basis: '已交保险费',
      formulaText: '18周岁前全残保险金 = 已交保险费 × 100%',
      condition: '年满18周岁的首个保单周年日之前全残',
      sourceExcerpt: excerptAround(responsibilityText, /若被保险人全残/u),
    }),
    buildIndicator({
      id: indicatorId('疾病全残', '18周岁后'),
      coverageType: '人寿保障',
      liability: '疾病全残',
      unit: '公式',
      basis: '基本保险金额/现金价值/已交保险费',
      formulaText: '18周岁后全残保险金 = max(基本保险金额, 现金价值, 已交保险费)',
      condition: '年满18周岁的首个保单周年日含以后全残',
      sourceExcerpt: excerptAround(responsibilityText, /年满18周岁的首个保单周年日（含周年日）之后全残/u),
    }),
    buildIndicator({
      id: indicatorId('疾病身故', '18周岁前'),
      coverageType: '人寿保障',
      liability: '疾病身故',
      value: 100,
      unit: '%',
      basis: '已交保险费',
      formulaText: '18周岁前身故保险金 = 已交保险费 × 100%',
      condition: '年满18周岁的首个保单周年日之前身故',
      sourceExcerpt: excerptAround(responsibilityText, /若被保险人身故/u),
    }),
    buildIndicator({
      id: indicatorId('疾病身故', '18周岁后'),
      coverageType: '人寿保障',
      liability: '疾病身故',
      unit: '公式',
      basis: '基本保险金额/现金价值/已交保险费',
      formulaText: '18周岁后身故保险金 = max(基本保险金额, 现金价值, 已交保险费)',
      condition: '年满18周岁的首个保单周年日含以后身故',
      sourceExcerpt: excerptAround(responsibilityText, /之后身故/u),
    }),
    buildIndicator({
      id: indicatorId('少儿特定重大疾病保险金'),
      coverageType: '疾病保障',
      liability: '少儿特定重大疾病保险金',
      value: 100,
      unit: '%',
      basis: '基本保险金额',
      formulaText: '少儿特定重大疾病保险金 = 基本保险金额 × 100%',
      condition: '18周岁前初次确诊约定少儿特定重大疾病；给付重大疾病保险金的同时额外给付；给付1次',
      sourceExcerpt: excerptAround(responsibilityText, /少儿特定重大疾病保险金/u),
    }),
    buildIndicator({
      id: indicatorId('特定疾病种数', '少儿特定重大疾病'),
      coverageType: '疾病保障',
      liability: '特定疾病种数',
      value: 24,
      unit: '种',
      basis: '少儿特定重大疾病清单',
      condition: '少儿特定重大疾病',
      sourceExcerpt: excerptAround(responsibilityText, /1\. 白血病/u),
    }),
    buildIndicator({
      id: indicatorId('赔付方式'),
      coverageType: '规则参数',
      liability: '赔付方式',
      unit: '方式',
      basis: '保险责任赔付机制',
      value: null,
      formulaText: '',
      condition: '本产品责任以定额给付为主，等待期内按条款退还已交保险费',
      sourceExcerpt: excerptAround(responsibilityText, /我们按照基本保险金额/u),
      responsibilityScope: 'rule_parameter',
      quantificationStatus: 'not_quantifiable',
      excludeFromCalculation: true,
    }),
  ];

  const optionalRecords = [
    buildOptionalRecord({
      liability: '可选责任一',
      sourceExcerpt: optionalOneText,
      indicatorIds: optionalIndicators.filter((indicator) => indicator.optionalResponsibilityId === optionalOneId).map((indicator) => indicator.id),
    }),
    buildOptionalRecord({
      liability: '可选责任二',
      sourceExcerpt: optionalTwoText,
      indicatorIds: optionalIndicators.filter((indicator) => indicator.optionalResponsibilityId === optionalTwoId).map((indicator) => indicator.id),
    }),
  ];

  return {
    rawText,
    pageText,
    responsibilityText,
    waitingText,
    indicators: [...basicIndicators, ...optionalIndicators],
    optionalRecords,
  };
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return fallback;
  }
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_records (
      id INTEGER PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      url TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_records_company ON knowledge_records(company);
    CREATE INDEX IF NOT EXISTS idx_knowledge_records_product_name ON knowledge_records(product_name);
    CREATE INDEX IF NOT EXISTS idx_knowledge_records_url ON knowledge_records(url);
    CREATE TABLE IF NOT EXISTS insurance_indicator_records (
      id TEXT PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      coverage_type TEXT,
      liability TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_insurance_indicator_records_company ON insurance_indicator_records(company);
    CREATE INDEX IF NOT EXISTS idx_insurance_indicator_records_product_name ON insurance_indicator_records(product_name);
    CREATE TABLE IF NOT EXISTS optional_responsibility_records (
      id TEXT PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      liability TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_optional_responsibility_records_company ON optional_responsibility_records(company);
    CREATE INDEX IF NOT EXISTS idx_optional_responsibility_records_product_name ON optional_responsibility_records(product_name);
  `);
}

function applyRepair(dbPath, payload, { dryRun = false } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 10000');
  try {
    ensureTables(db);
    const existingKnowledge = db.prepare('SELECT payload FROM knowledge_records WHERE id = ?').get(SOURCE_RECORD_ID);
    const knowledgePayload = buildKnowledgePayload(parseJson(existingKnowledge?.payload), payload.pageText);
    const now = new Date().toISOString();
    const before = {
      knowledgeRecords: db.prepare('SELECT COUNT(*) AS count FROM knowledge_records WHERE product_name = ?').get(PRODUCT_NAME).count,
      indicators: db.prepare('SELECT COUNT(*) AS count FROM insurance_indicator_records WHERE product_name = ?').get(PRODUCT_NAME).count,
      optionalRecords: db.prepare('SELECT COUNT(*) AS count FROM optional_responsibility_records WHERE product_name = ?').get(PRODUCT_NAME).count,
    };
    if (dryRun) {
      return {
        dbPath,
        dryRun: true,
        before,
        after: {
          indicators: payload.indicators.length,
          optionalRecords: payload.optionalRecords.length,
          pageTextLength: payload.pageText.length,
        },
      };
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO knowledge_records (id, company, product_name, url, payload)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          company = excluded.company,
          product_name = excluded.product_name,
          url = excluded.url,
          payload = excluded.payload
      `).run(SOURCE_RECORD_ID, COMPANY, PRODUCT_NAME, SOURCE_URL, JSON.stringify(knowledgePayload));
      db.prepare('DELETE FROM insurance_indicator_records WHERE product_name = ?').run(PRODUCT_NAME);
      db.prepare('DELETE FROM optional_responsibility_records WHERE product_name = ?').run(PRODUCT_NAME);
      const insertIndicator = db.prepare(`
        INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const record of payload.indicators) {
        insertIndicator.run(record.id, record.company, record.productName, record.coverageType, record.liability, JSON.stringify(record));
      }
      const insertOptional = db.prepare(`
        INSERT INTO optional_responsibility_records (id, company, product_name, liability, payload)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const record of payload.optionalRecords) {
        insertOptional.run(record.id, record.company, record.productName, record.liability, JSON.stringify(record));
      }
      for (const [key, value] of [
        ['zhonghua_jianle_zhenbei_2025_repaired_at', now],
        ['insurance_indicator_records_updated_at', now],
        ['optional_responsibility_records_updated_at', now],
        ['updated_at', now],
      ]) {
        db.prepare(`
          INSERT INTO app_meta (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(key, value);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const after = {
      knowledgePageTextLength: db.prepare("SELECT length(json_extract(payload, '$.pageText')) AS length FROM knowledge_records WHERE id = ?").get(SOURCE_RECORD_ID).length,
      indicators: db.prepare('SELECT COUNT(*) AS count FROM insurance_indicator_records WHERE product_name = ?').get(PRODUCT_NAME).count,
      optionalRecords: db.prepare('SELECT COUNT(*) AS count FROM optional_responsibility_records WHERE product_name = ?').get(PRODUCT_NAME).count,
      pendingOptional: db.prepare(`
        SELECT COUNT(*) AS count
          FROM optional_responsibility_records
         WHERE product_name = ?
           AND json_extract(payload, '$.quantificationStatus') = 'pending_review'
      `).get(PRODUCT_NAME).count,
    };
    return { dbPath, dryRun: false, before, after };
  } finally {
    db.close();
  }
}

async function main() {
  const explicitDbPath = trim(readArg('db-path'));
  const dbPaths = explicitDbPath ? [path.resolve(explicitDbPath)] : DB_PATHS;
  const dryRun = hasFlag('dry-run');
  const pdfBuffer = await fetchPdfBuffer();
  const rawText = extractPdfText(pdfBuffer);
  const payload = buildRepairPayload(rawText);
  const backups = dryRun ? {} : Object.fromEntries(await Promise.all(dbPaths.map(async (dbPath) => [dbPath, await backupSqlite(dbPath)])));
  const results = dbPaths.map((dbPath) => applyRepair(dbPath, payload, { dryRun }));
  const report = {
    ok: true,
    dryRun,
    productName: PRODUCT_NAME,
    sourceRecordId: SOURCE_RECORD_ID,
    sourceUrl: SOURCE_URL,
    rawTextLength: rawText.length,
    pageTextLength: payload.pageText.length,
    responsibilityTextLength: payload.responsibilityText.length,
    waitingTextLength: payload.waitingText.length,
    indicatorCount: payload.indicators.length,
    optionalResponsibilityCount: payload.optionalRecords.length,
    optionalResponsibilities: payload.optionalRecords.map((record) => ({
      id: record.id,
      liability: record.liability,
      quantificationStatus: record.quantificationStatus,
      indicatorIds: record.indicatorIds,
    })),
    indicators: payload.indicators.map((record) => ({
      id: record.id,
      coverageType: record.coverageType,
      liability: record.liability,
      value: record.value,
      unit: record.unit,
      formulaText: record.formulaText,
      condition: record.condition,
      optionalResponsibilityId: record.optionalResponsibilityId,
      quantificationStatus: record.quantificationStatus,
    })),
    backups,
    results,
  };
  const reportDir = path.join(projectRoot, 'outputs');
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `zhonghua-jianle-zhenbei-2025-repair-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
