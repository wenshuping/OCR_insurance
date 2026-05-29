import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');

const SELECT_FIELDS = [
  '本地ID',
  '保险公司',
  '产品名称',
  '产品分类',
  '资料类型',
  '标题',
  '来源链接',
  '摘要',
  '保险责任正文',
  '质量状态',
  '质量问题',
];

function trim(value) {
  return String(value || '').trim();
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function loadEnvFile(envPath, { override = false } = {}) {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/u)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    const index = value.indexOf('=');
    if (index <= 0) continue;
    const key = value.slice(0, index).trim();
    let envValue = value.slice(index + 1).trim();
    if ((envValue.startsWith('"') && envValue.endsWith('"')) || (envValue.startsWith("'") && envValue.endsWith("'"))) {
      envValue = envValue.slice(1, -1);
    }
    if (override || process.env[key] === undefined) process.env[key] = envValue;
  }
}

function parseCliJson(stdout) {
  const text = trim(stdout);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`飞书 CLI 没有返回 JSON：${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start, end + 1));
}

function isRetryableLarkError(errorText) {
  return /timeout|timed out|i\/o timeout|temporarily|ECONNRESET|ETIMEDOUT|EOF|502|503|504|429|800004135|limited|rate.?limit|too many|too frequent|频率|限流/iu.test(errorText);
}

function retryDelayMs(errorText, attempt) {
  if (/800004135|limited|rate.?limit|too many|too frequent|频率|限流/iu.test(errorText)) {
    return Math.min(60000, attempt * 15000);
  }
  return attempt * 1200;
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runLark(args, { retries = 4 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const result = spawnSync('lark-cli', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 30 * 1024 * 1024,
    });
    if (result.status === 0) return parseCliJson(result.stdout);
    lastError = [
      `lark-cli ${args.join(' ')} 执行失败`,
      result.stdout?.trim(),
      result.stderr?.trim(),
    ]
      .filter(Boolean)
      .join('\n');
    if (attempt < retries && isRetryableLarkError(lastError)) {
      sleepMs(retryDelayMs(lastError, attempt));
      continue;
    }
    break;
  }
  throw new Error(lastError || `lark-cli ${args.join(' ')} 执行失败`);
}

function configPaths() {
  const explicit = trim(readArg('config-paths', process.env.FEISHU_KNOWLEDGE_CONFIG_PATHS || ''))
    .split(',')
    .map((item) => trim(item))
    .filter(Boolean);
  if (explicit.length) return explicit.map((item) => path.resolve(projectRoot, item));
  return fs
    .readdirSync(runtimeDir)
    .filter((name) => /^feishu-knowledge.*\.json$/u.test(name))
    .map((name) => path.join(runtimeDir, name))
    .sort();
}

function loadConfigs() {
  const configs = [];
  const seen = new Set();
  for (const configPath of configPaths()) {
    const saved = readJsonFile(configPath, {});
    const baseToken = trim(saved.baseToken || process.env.FEISHU_KNOWLEDGE_BASE_TOKEN);
    const tableId = trim(saved.tableId);
    if (!baseToken || !tableId) continue;
    const key = `${baseToken}:${tableId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    configs.push({
      configPath,
      identity: trim(saved.identity || process.env.FEISHU_KNOWLEDGE_AS) || 'user',
      baseToken,
      tableId,
      tableName: trim(saved.tableName || path.basename(configPath, '.json')),
    });
  }
  return configs;
}

function rowValue(fields, row, fieldName) {
  const index = fields.indexOf(fieldName);
  if (index < 0) return '';
  return trim(Array.isArray(row) ? row[index] : row?.fields?.[fieldName]);
}

function listRecords(config) {
  const records = [];
  const limit = Number(readArg('page-size', '200')) || 200;
  let offset = Number(readArg('offset', '0')) || 0;
  while (true) {
    const payload = runLark([
      'base',
      '+record-list',
      '--as',
      config.identity,
      '--base-token',
      config.baseToken,
      '--table-id',
      config.tableId,
      ...SELECT_FIELDS.flatMap((field) => ['--field-id', field]),
      '--limit',
      String(limit),
      '--offset',
      String(offset),
      '--format',
      'json',
    ]);
    const fields = Array.isArray(payload?.data?.fields) ? payload.data.fields.map(trim) : SELECT_FIELDS;
    const rows = Array.isArray(payload?.data?.data) ? payload.data.data : [];
    const recordIds = Array.isArray(payload?.data?.record_id_list) ? payload.data.record_id_list : [];
    rows.forEach((row, index) => {
      records.push({
        recordId: trim(recordIds[index]),
        localId: rowValue(fields, row, '本地ID'),
        company: rowValue(fields, row, '保险公司'),
        productName: rowValue(fields, row, '产品名称'),
        productType: rowValue(fields, row, '产品分类'),
        materialType: rowValue(fields, row, '资料类型'),
        title: rowValue(fields, row, '标题'),
        url: rowValue(fields, row, '来源链接'),
        snippet: rowValue(fields, row, '摘要'),
        responsibilityText: rowValue(fields, row, '保险责任正文'),
        qualityStatus: rowValue(fields, row, '质量状态'),
        qualityReason: rowValue(fields, row, '质量问题'),
        feishuTableName: config.tableName,
        feishuTableId: config.tableId,
      });
    });
    if (rows.length < limit) break;
    offset += limit;
    if (readArg('max-pages')) {
      const maxPages = Number(readArg('max-pages'));
      if (records.length >= maxPages * limit) break;
    }
  }
  return records;
}

function normalizeText(value) {
  return trim(value)
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n');
}

function excerpt(value) {
  return normalizeText(value).replace(/\n+/gu, ' ').slice(0, 180);
}

const PLACEHOLDER_RE = /未抽取保险责任正文|未提取保险责任正文|暂无保险责任正文|官网有资料标记|PDF不可用|保险责任正文为空|未获取到保险责任|未识别到保险责任/u;
const BENEFIT_RE = /(?:身故|全残|伤残|疾病|重大疾病|轻症|中症|重症|特定疾病|癌症|恶性肿瘤|意外|医疗|住院|护理|津贴|生存|满期|年金|养老金|教育金|祝寿金|祝贺金|关爱金|豁免|免交|确诊|罹患|保险金|给付|赔付|赔偿|报销)/u;
const CONCRETE_BENEFIT_RE = /(?:身故保险金|身故给付|全残保险金|伤残保险金|重大疾病保险金|疾病保险金|癌症|恶性肿瘤|意外伤害保险金|医疗保险金|医疗费用保险金|住院医疗保险金|门诊急诊医疗费用保险金|特定药品费用医疗保险金|住院津贴|基础住院津贴|护理保险金|护理补贴保险金|生存保险金|生存金|满期保险金|年金|养老保险金|教育保险金|祝寿金|豁免.{0,20}保险费|免交.{0,20}保险费|保险费豁免|给付保险金|赔偿保险金|报销|初次确诊|罹患|承担下列保险责任|承担如下保险责任|承担以下保险责任)/u;
const RESPONSIBILITY_HEADING_RE = /保险责任|保障责任|保险金给付|保障内容|给付责任|赔偿责任/u;
const EXCLUSION_RE = /责任免除|除外责任|不承担保险责任|不予给付|不予赔付/u;
const POLICY_BENEFIT_ONLY_RE = /(?:现金价值|保单利益|利益演示|红利|分红|终了红利|万能账户|账户价值|结算利率|投资账户|有效保险金额递增|减保|保单贷款|退保金|退保)/u;
const SALES_ONLY_RE = /(?:产品特色|产品亮点|投保规则|投保须知|投保示例|投保举例|费率表|保险费率|公司简介|客户服务|信息披露|备案|目录|条款目录|附件目录|理赔资料|理赔流程)/u;
const CONTINUATION_RE = /^(?:保险责任继续有效|上述|该保险金|本项责任|前述|同时|此外|其中|选择可选责任|除另有约定外)/u;
const TOC_ONLY_RE = /(?:保险责任[\.。·…\s]*\d|保险责任.*责任免除|保险责任.*保险事故通知|保险责任.*受益人|保险责任.*释义|保险责任.*解除合同)/u;
const SAVINGS_MAJOR_BENEFIT_RE = /(?:关爱年金|生存保险金|满期保险金|养老年金|养老保险金|养老金|教育金|教育年金|身故保险金|身故或身体全残保险金|全残保险金|豁免保险费)/u;
const MISSING_ENUMERATED_FIRST_OPTION_RE = /(?:以下|下列|二者|两者|三者).{0,140}[（(]2[）)]/u;
const STATUS_ORDER = {
  invalid_empty: 0,
  invalid_non_responsibility: 1,
  valid_partial: 2,
  suspect_needs_source_check: 3,
};

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function statusCounts(items) {
  return items.reduce((counts, item) => {
    counts[item.status] = (counts[item.status] || 0) + 1;
    return counts;
  }, {});
}

function inferTableName(config, records) {
  if (!['保险资料', 'feishu-knowledge'].includes(config.tableName)) return config.tableName;
  const counts = new Map();
  for (const record of records) {
    const company = trim(record.company);
    if (!company) continue;
    counts.set(company, (counts.get(company) || 0) + 1);
  }
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return best?.[0] || config.tableName;
}

function classify(record) {
  const text = normalizeText(record.responsibilityText);
  const compact = text.replace(/\s+/gu, '');
  const productName = trim(record.productName);
  const materialType = trim(record.materialType);
  const reasons = [];

  if (!compact || /^(null|undefined|nan)$/iu.test(compact)) {
    return { status: 'invalid_empty', reasons: ['保险责任正文为空/null'] };
  }
  if (PLACEHOLDER_RE.test(compact)) {
    return { status: 'invalid_empty', reasons: ['保险责任正文是占位/未抽取提示'] };
  }

  const hasBenefit = BENEFIT_RE.test(compact);
  const hasConcreteBenefit = CONCRETE_BENEFIT_RE.test(compact);
  const hasHeading = RESPONSIBILITY_HEADING_RE.test(compact);
  const hasExclusion = EXCLUSION_RE.test(compact);
  const policyBenefitOnly = POLICY_BENEFIT_ONLY_RE.test(compact) && !hasConcreteBenefit;
  const salesOnly = SALES_ONLY_RE.test(compact) && !hasConcreteBenefit && !hasHeading;
  const increasingWholeLifeLike = /增额|终身寿|有效保险金额/u.test(`${productName}${compact}`);
  const increasingValid = increasingWholeLifeLike && /(?:身故|全残)/u.test(compact) && /(?:有效保险金额|现金价值|已交保险费|基本保险金额)/u.test(compact);
  const hasInsurerPaymentSignal = /(?:本公司|保险人|公司按|给付|赔付|赔偿|报销|免交|承担|支付)/u.test(compact);
  const isResponsibility = increasingValid || hasConcreteBenefit || (hasHeading && hasBenefit) || (hasBenefit && hasInsurerPaymentSignal);

  if (isResponsibility) {
    const partialReasons = [];
    const savingsLike = /(?:年金|养老|教育|两全|分红|祝寿)/u.test(productName);
    if (CONTINUATION_RE.test(compact) && !hasConcreteBenefit) partialReasons.push('正文从承接语/半句开始，疑似截取起点过晚');
    if (/上述\s*(?:\d+\s*[、\-—至到]\s*\d+|[一二三四五六七八九十]+)\s*条\s*为\s*基本责任/u.test(compact) && !SAVINGS_MAJOR_BENEFIT_RE.test(compact)) {
      partialReasons.push('正文引用了前面编号责任，但当前字段缺少前置责任内容');
    }
    if (
      materialType === 'product_manual' &&
      /(?:保险责任继续有效|上述\d|上述1-4条|本保险提供的利益保障)/u.test(compact) &&
      !hasConcreteBenefit &&
      !SAVINGS_MAJOR_BENEFIT_RE.test(compact)
    ) {
      partialReasons.push('产品说明书利益保障段不完整，缺少主要给付项目');
    }
    if (savingsLike && /祝寿金/u.test(compact) && !SAVINGS_MAJOR_BENEFIT_RE.test(compact)) {
      partialReasons.push('储蓄/年金类产品只截到祝寿金等尾部责任');
    }
    if (MISSING_ENUMERATED_FIRST_OPTION_RE.test(compact) && !/[（(]1[）)]/u.test(compact)) {
      partialReasons.push('给付公式枚举不完整，缺少第（1）项');
    }
    if (partialReasons.length) {
      return { status: 'valid_partial', reasons: unique(partialReasons) };
    }
    return null;
  }

  if (TOC_ONLY_RE.test(compact) && !hasConcreteBenefit) reasons.push('疑似目录/条款索引，不是保险责任正文');
  if (hasExclusion && !hasBenefit) reasons.push('疑似责任免除/除外责任，不是保险责任正文');
  if (policyBenefitOnly) reasons.push('只有分红/现金价值/账户/有效保额等保单利益规则，缺少给付触发责任');
  if (salesOnly) reasons.push('疑似产品介绍/投保规则/费率/目录等非保险责任内容');
  if (compact.length < 60 && !hasBenefit) reasons.push('正文过短且缺少保险金/给付/生存/身故/全残/年金等责任要素');
  if (!hasBenefit && !reasons.length) reasons.push('缺少可识别的保险责任触发条件或给付规则');

  if (!reasons.length) return { status: 'suspect_needs_source_check', reasons: ['责任要素不足，需回源确认'] };
  const status = reasons.some((reason) => /目录|责任免除|非保险责任|只有分红|缺少可识别|正文过短/u.test(reason))
    ? 'invalid_non_responsibility'
    : 'suspect_needs_source_check';
  return { status, reasons: unique(reasons) };
}

function renderMarkdown(report) {
  const counts = report.summary.statusCounts;
  const lines = [
    '# Feishu Insurance Responsibility Audit',
    '',
    `Generated: ${report.generatedAt}`,
    `Tables scanned: ${report.tablesScanned}`,
    `Rows scanned: ${report.rowsScanned}`,
    `Problem rows: ${report.suspects.length}`,
    `invalid_empty: ${counts.invalid_empty || 0}`,
    `invalid_non_responsibility: ${counts.invalid_non_responsibility || 0}`,
    `valid_partial: ${counts.valid_partial || 0}`,
    `suspect_needs_source_check: ${counts.suspect_needs_source_check || 0}`,
    '',
  ];
  const byTable = new Map();
  for (const item of report.suspects) {
    const list = byTable.get(item.feishuTableName) || [];
    list.push(item);
    byTable.set(item.feishuTableName, list);
  }
  for (const [tableName, items] of [...byTable.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    lines.push(`## ${tableName} (${items.length})`, '');
    for (const item of items) {
      lines.push(
        `- [${item.status}] ${item.company || '-'} | ${item.productName || item.title || '-'} | 本地ID ${item.localId || '-'} | ${item.reasons.join('; ')}`,
      );
      if (item.excerpt) lines.push(`  - 摘录: ${item.excerpt}`);
      if (item.url) lines.push(`  - 来源: ${item.url}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  loadEnvFile(path.join(projectRoot, '.env'));
  loadEnvFile(path.join(projectRoot, '.env.local'), { override: true });

  const configs = loadConfigs();
  const companyFilter = trim(readArg('company', ''));
  const targetConfigs = companyFilter
    ? configs.filter((config) => config.tableName === companyFilter || config.configPath.includes(companyFilter))
    : configs;
  const suspects = [];
  let rowsScanned = 0;
  const tableReports = [];
  const tableErrors = [];

  for (const config of targetConfigs) {
    let records = [];
    try {
      records = listRecords(config);
    } catch (error) {
      tableErrors.push({
        tableName: config.tableName,
        tableId: config.tableId,
        configPath: config.configPath,
        error: error.message,
      });
      console.log(`[audit] ${config.tableName}: skipped error=${error.message.split('\n')[0]}`);
      continue;
    }
    rowsScanned += records.length;
    const displayTableName = inferTableName(config, records);
    for (const record of records) {
      record.feishuTableName = displayTableName;
    }
    let tableSuspects = 0;
    for (const record of records) {
      const result = classify(record);
      if (!result) continue;
      tableSuspects += 1;
      suspects.push({
        status: result.status,
        reasons: result.reasons,
        localId: record.localId,
        recordId: record.recordId,
        company: record.company,
        productName: record.productName,
        productType: record.productType,
        materialType: record.materialType,
        title: record.title,
        url: record.url,
        qualityStatus: record.qualityStatus,
        qualityReason: record.qualityReason,
        feishuTableName: record.feishuTableName,
        feishuTableId: record.feishuTableId,
        excerpt: excerpt(record.responsibilityText),
      });
    }
    const tableItems = suspects.filter((item) => item.feishuTableId === config.tableId);
    tableReports.push({
      tableName: displayTableName,
      configTableName: config.tableName,
      tableId: config.tableId,
      rows: records.length,
      problemRows: tableSuspects,
      statusCounts: statusCounts(tableItems),
    });
    console.log(`[audit] ${displayTableName}: rows=${records.length} problems=${tableSuspects}`);
  }

  suspects.sort((left, right) => {
    return (
      STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
      left.feishuTableName.localeCompare(right.feishuTableName) ||
      String(left.localId).localeCompare(String(right.localId), 'zh-Hans-CN', { numeric: true })
    );
  });

  const generatedAt = new Date().toISOString();
  const report = {
    ok: true,
    generatedAt,
    mode: 'readonly',
    tablesScanned: targetConfigs.length,
    rowsScanned,
    summary: {
      statusCounts: statusCounts(suspects),
    },
    tableReports,
    tableErrors,
    suspects,
  };
  const stamp = generatedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(runtimeDir, `feishu-responsibility-audit-${stamp}.json`);
  const markdownPath = path.join(runtimeDir, `feishu-responsibility-audit-${stamp}.md`);
  writeJsonFile(jsonPath, report);
  fs.writeFileSync(markdownPath, renderMarkdown(report));

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: 'readonly',
        tablesScanned: report.tablesScanned,
        rowsScanned: report.rowsScanned,
        problemRows: report.suspects.length,
        statusCounts: report.summary.statusCounts,
        jsonPath,
        markdownPath,
      },
      null,
      2,
    ),
  );
}

main();
