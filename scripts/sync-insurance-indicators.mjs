import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  FileBlob,
  SpreadsheetFile,
} from '/Users/wenshuping/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const statePath = path.resolve(process.env.POLICY_OCR_APP_STATE_PATH || path.join(runtimeDir, 'state.json'));

const DEFAULT_VERSION = '2026-05-27';
const DEFAULT_WORKBOOK_PATH = path.join(
  projectRoot,
  'outputs',
  'insurance-indicators-20260527',
  '本地知识库保险量化指标抽取_2026-05-27.xlsx',
);
const DEFAULT_FEISHU_CONFIG_PATH = path.join(runtimeDir, 'feishu-insurance-indicators-20260527.json');
const DEFAULT_SOURCE_FEISHU_CONFIG_PATH = path.join(runtimeDir, 'feishu-knowledge.json');
const DEFAULT_TABLE_NAME = '保险量化指标_20260527';
const DEFAULT_DB_PATH = path.join(runtimeDir, 'policy-ocr.sqlite');

const FIELD_NAMES = [
  '指标ID',
  '版本',
  '保险公司',
  '产品名称',
  '产品分类',
  '销售状态',
  '保障类型',
  '责任类别',
  '数值',
  '单位',
  '计算基准',
  '公式文本',
  '条件口径',
  '抽取方法',
  '来源记录ID',
  '来源链接',
  '来源摘录',
  '更新时间',
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

function readNumberArg(name, fallback) {
  const value = Number(readArg(name, ''));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function limitText(value, max = 1200) {
  const text = trim(value).replace(/\r\n?/gu, '\n');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 18)}\n...已截断同步展示`;
}

function loadEnvFile(envPath, { override = false } = {}) {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/u)) {
    const item = line.trim();
    if (!item || item.startsWith('#')) continue;
    const index = item.indexOf('=');
    if (index <= 0) continue;
    const key = item.slice(0, index).trim();
    let value = item.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
}

function stableIndicatorId(row) {
  const digest = crypto
    .createHash('sha1')
    .update(
      [
        row.rowNumber,
        row.sourceRecordId,
        row.company,
        row.productName,
        row.coverageType,
        row.liability,
        row.valueText,
        row.unit,
        row.basis,
        row.formulaText,
        row.condition,
        row.sourceExcerpt,
      ].join('\u001f'),
    )
    .digest('hex')
    .slice(0, 18);
  return `ind_${digest}`;
}

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = trim(value).replace(/,/gu, '');
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return trim(value);
}

function normalizeIndicatorFormula(item) {
  const text = [
    item.coverageType,
    item.liability,
    item.formulaText,
    item.basis,
    item.condition,
    item.sourceExcerpt,
  ].join(' ');
  if (
    item.coverageType === '现金流' &&
    /满期(?:生存)?保险金|满期金|满期返还/u.test(text) &&
    /实际交纳的保险费|已交保险费|所交保险费/u.test(text)
  ) {
    return {
      ...item,
      liability: /满期(?:生存)?保险金|满期金/u.test(text) ? '满期生存保险金' : item.liability,
      unit: item.unit === '公式' || !item.unit ? '公式' : item.unit,
      basis: item.basis || '实际交纳保险费',
      formulaText: '满期生存保险金 = 实际交纳保险费',
    };
  }
  return item;
}

async function loadIndicatorRows(workbookPath, version) {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
  const sheet = workbook.worksheets.getItem('保障量化长表');
  if (!sheet) throw new Error(`Excel 缺少工作表：保障量化长表 (${workbookPath})`);
  const values = sheet.getUsedRange(true).values;
  const headers = (values[0] || []).map(trim);
  const indexByHeader = new Map(headers.map((header, index) => [header, index]));
  const required = [
    '公司',
    '产品名称',
    '产品分类',
    '销售状态',
    '保障类型',
    '责任类别',
    '数值',
    '单位',
    '计算基准',
    '公式文本',
    '条件/口径',
    '抽取方法',
    '来源记录ID',
    '来源链接',
    '来源摘录',
  ];
  for (const header of required) {
    if (!indexByHeader.has(header)) throw new Error(`保障量化长表缺少列：${header}`);
  }

  const records = [];
  for (let rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    const row = values[rowIndex] || [];
    const item = {
      version,
      rowNumber: rowIndex + 1,
      company: trim(row[indexByHeader.get('公司')]),
      productName: trim(row[indexByHeader.get('产品名称')]),
      productType: trim(row[indexByHeader.get('产品分类')]),
      salesStatus: trim(row[indexByHeader.get('销售状态')]),
      coverageType: trim(row[indexByHeader.get('保障类型')]),
      liability: trim(row[indexByHeader.get('责任类别')]),
      value: parseNumber(row[indexByHeader.get('数值')]),
      valueText: formatValue(row[indexByHeader.get('数值')]),
      unit: trim(row[indexByHeader.get('单位')]),
      basis: trim(row[indexByHeader.get('计算基准')]),
      formulaText: trim(row[indexByHeader.get('公式文本')]),
      condition: trim(row[indexByHeader.get('条件/口径')]),
      extractionMethod: trim(row[indexByHeader.get('抽取方法')]),
      sourceRecordId: trim(row[indexByHeader.get('来源记录ID')]),
      sourceUrl: trim(row[indexByHeader.get('来源链接')]),
      sourceExcerpt: trim(row[indexByHeader.get('来源摘录')]),
    };
    if (!item.company && !item.productName && !item.coverageType && !item.liability) continue;
    const normalizedItem = normalizeIndicatorFormula(item);
    normalizedItem.indicatorId = stableIndicatorId(normalizedItem);
    records.push(normalizedItem);
  }
  return records;
}

function buildStats(records) {
  const byCoverageType = {};
  const byProductType = {};
  const byUnit = {};
  let formulaRows = 0;
  const duplicateIds = [];
  const seen = new Set();
  for (const record of records) {
    byCoverageType[record.coverageType || '未知'] = (byCoverageType[record.coverageType || '未知'] || 0) + 1;
    byProductType[record.productType || '未知'] = (byProductType[record.productType || '未知'] || 0) + 1;
    byUnit[record.unit || '空'] = (byUnit[record.unit || '空'] || 0) + 1;
    if (record.formulaText) formulaRows += 1;
    if (seen.has(record.indicatorId)) duplicateIds.push(record.indicatorId);
    seen.add(record.indicatorId);
  }
  return {
    count: records.length,
    formulaRows,
    byCoverageType,
    byProductType,
    byUnit,
    duplicateIdCount: duplicateIds.length,
    duplicateIds: duplicateIds.slice(0, 20),
    sample: records.slice(0, 10).map((record) => ({
      indicatorId: record.indicatorId,
      company: record.company,
      productName: record.productName,
      productType: record.productType,
      coverageType: record.coverageType,
      liability: record.liability,
      valueText: record.valueText,
      unit: record.unit,
      formulaText: record.formulaText,
      sourceRecordId: record.sourceRecordId,
    })),
  };
}

function saveLocalIndicatorRecords({ records, stats, version, workbookPath }) {
  const dbPath = path.resolve(readArg('db-path', process.env.POLICY_OCR_APP_DB_PATH || DEFAULT_DB_PATH));
  const state = readJson(statePath, {});
  const generatedAt = new Date().toISOString();
  const backupPath = path.join(runtimeDir, 'backups', `state-before-insurance-indicators-${generatedAt.replace(/[:.]/gu, '-')}.json`);
  if (fs.existsSync(statePath)) {
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(statePath, backupPath);
  }

  state.insuranceIndicatorRecords = records.map((record) => ({
    id: record.indicatorId,
    version: record.version,
    rowNumber: record.rowNumber,
    company: record.company,
    productName: record.productName,
    productType: record.productType,
    salesStatus: record.salesStatus,
    coverageType: record.coverageType,
    liability: record.liability,
    value: record.value,
    valueText: record.valueText,
    unit: record.unit,
    basis: record.basis,
    formulaText: record.formulaText,
    condition: record.condition,
    extractionMethod: record.extractionMethod,
    sourceRecordId: record.sourceRecordId,
    sourceUrl: record.sourceUrl,
    sourceExcerpt: record.sourceExcerpt,
    updatedAt: generatedAt,
  }));
  state.insuranceIndicatorSnapshot = {
    version,
    generatedAt,
    sourceWorkbook: workbookPath,
    backupPath,
    count: records.length,
    formulaRows: stats.formulaRows,
    fields: FIELD_NAMES,
    note: '从保障量化长表抽取，产品分类使用当前本地知识库 productType 结果，公式写入 formulaText/公式文本 字段。',
  };
  if (fs.existsSync(statePath)) writeJson(statePath, state);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
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
      CREATE TABLE IF NOT EXISTS state_documents (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
    `);
    const insert = db.prepare(`
      INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        company = excluded.company,
        product_name = excluded.product_name,
        coverage_type = excluded.coverage_type,
        liability = excluded.liability,
        payload = excluded.payload
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM insurance_indicator_records');
      for (const record of state.insuranceIndicatorRecords) {
        insert.run(
          record.id,
          record.company,
          record.productName,
          record.coverageType,
          record.liability,
          JSON.stringify(record),
        );
      }
      db.prepare(`
        INSERT INTO state_documents (key, payload)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET payload = excluded.payload
      `).run('insuranceIndicatorSnapshot', JSON.stringify(state.insuranceIndicatorSnapshot));
      db.prepare(`
        INSERT INTO app_meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run('insurance_indicator_records_updated_at', generatedAt);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }

  return { backupPath: fs.existsSync(backupPath) ? backupPath : '', dbPath, generatedAt };
}

function parseCliJson(stdout) {
  const text = String(stdout || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`飞书 CLI 没有返回 JSON：${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start, end + 1));
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRetryableLarkError(text) {
  return /800004135|limited|rate.?limit|too many|too frequent|频率|限流|timeout|timed out|i\/o timeout|EOF|ECONNRESET|ETIMEDOUT|429|502|503|504/iu.test(
    text,
  );
}

function runLark(args, { retries = 8, timeout = 90_000, maxBuffer = 40 * 1024 * 1024 } = {}) {
  let lastError = '';
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const result = spawnSync('lark-cli', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer,
      timeout,
    });
    if (result.status === 0) return parseCliJson(result.stdout);
    lastError = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (attempt < retries && isRetryableLarkError(lastError)) {
      sleepMs(Math.min(60_000, attempt * 8_000));
      continue;
    }
    break;
  }
  throw new Error(lastError.slice(0, 3000) || `lark-cli ${args.join(' ')} 执行失败`);
}

function resolveFeishuConfig() {
  const configPath = path.resolve(readArg('feishu-config-path', DEFAULT_FEISHU_CONFIG_PATH));
  const saved = readJson(configPath, {});
  const source = readJson(path.resolve(readArg('source-feishu-config-path', DEFAULT_SOURCE_FEISHU_CONFIG_PATH)), {});
  return {
    configPath,
    identity: trim(readArg('as', process.env.FEISHU_INDICATOR_AS || saved.identity || source.identity)) || 'user',
    baseToken: trim(readArg('base-token', process.env.FEISHU_INDICATOR_BASE_TOKEN || saved.baseToken || source.baseToken)),
    baseName: trim(saved.baseName || source.baseName || '保险产品知识库'),
    baseUrl: trim(saved.baseUrl || source.baseUrl),
    tableName: trim(readArg('table-name', process.env.FEISHU_INDICATOR_TABLE_NAME || saved.tableName)) || DEFAULT_TABLE_NAME,
    tableId: trim(readArg('table-id', process.env.FEISHU_INDICATOR_TABLE_ID || saved.tableId)),
  };
}

function writeFeishuConfig(config, extra = {}) {
  writeJson(config.configPath, {
    baseName: config.baseName,
    tableName: config.tableName,
    identity: config.identity,
    baseToken: config.baseToken,
    tableId: config.tableId,
    baseUrl: config.baseUrl || `https://my.feishu.cn/base/${config.baseToken}`,
    ...extra,
  });
}

function ensureTable(config) {
  if (!config.baseToken) throw new Error('缺少飞书 baseToken，请先确认 .runtime/feishu-knowledge.json');
  if (config.tableId) return config;
  const payload = runLark([
    'base',
    '+table-create',
    '--as',
    config.identity,
    '--base-token',
    config.baseToken,
    '--name',
    config.tableName,
  ]);
  const table = payload?.data?.table || {};
  if (!table.id) throw new Error('飞书表格创建成功但没有返回 table id');
  return { ...config, tableId: table.id };
}

function listFieldNames(config) {
  const payload = runLark([
    'base',
    '+field-list',
    '--as',
    config.identity,
    '--base-token',
    config.baseToken,
    '--table-id',
    config.tableId,
  ]);
  return new Set((payload?.data?.fields || []).map((field) => trim(field.name)).filter(Boolean));
}

function ensureFields(config) {
  const existing = listFieldNames(config);
  for (const name of FIELD_NAMES) {
    if (existing.has(name)) continue;
    runLark([
      'base',
      '+field-create',
      '--as',
      config.identity,
      '--base-token',
      config.baseToken,
      '--table-id',
      config.tableId,
      '--json',
      JSON.stringify({ name, type: 'text' }),
    ]);
  }
}

function listRemoteIndicatorIds(config) {
  const ids = new Set();
  const limit = 200;
  let offset = 0;
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
      '--field-id',
      '指标ID',
      '--limit',
      String(limit),
      '--offset',
      String(offset),
      '--format',
      'json',
    ]);
    const rows = payload?.data?.data || [];
    for (const row of rows) {
      const id = trim(Array.isArray(row) ? row[0] : row?.fields?.指标ID);
      if (id) ids.add(id);
    }
    if (rows.length < limit) break;
    offset += limit;
  }
  return ids;
}

function toFeishuRow(record, updatedAt) {
  return [
    record.indicatorId,
    record.version,
    record.company,
    record.productName,
    record.productType,
    record.salesStatus,
    record.coverageType,
    record.liability,
    record.valueText,
    record.unit,
    record.basis,
    limitText(record.formulaText, 1000),
    limitText(record.condition, 1000),
    record.extractionMethod,
    record.sourceRecordId,
    limitText(record.sourceUrl, 1200),
    limitText(record.sourceExcerpt, readNumberArg('source-excerpt-max', 700)),
    updatedAt,
  ];
}

function batchCreateFeishu(config, records, updatedAt) {
  const chunkSize = Math.min(200, readNumberArg('batch-size', 100));
  const delayMs = readNumberArg('batch-delay-ms', 800);
  let created = 0;
  for (let index = 0; index < records.length; index += chunkSize) {
    const chunk = records.slice(index, index + chunkSize);
    runLark(
      [
        'base',
        '+record-batch-create',
        '--as',
        config.identity,
        '--base-token',
        config.baseToken,
        '--table-id',
        config.tableId,
        '--json',
        JSON.stringify({
          fields: FIELD_NAMES,
          rows: chunk.map((record) => toFeishuRow(record, updatedAt)),
        }),
      ],
      { retries: 8, timeout: 120_000 },
    );
    created += chunk.length;
    console.log(`[feishu] 批量创建进度 ${created}/${records.length}`);
    if (delayMs && index + chunkSize < records.length) sleepMs(delayMs);
  }
  return created;
}

function syncFeishu(records, updatedAt) {
  let config = resolveFeishuConfig();
  config = ensureTable(config);
  ensureFields(config);
  writeFeishuConfig(config, { initializedAt: readJson(config.configPath, {}).initializedAt || updatedAt });

  const remoteIds = hasFlag('skip-remote-check') ? new Set() : listRemoteIndicatorIds(config);
  const pending = records.filter((record) => !remoteIds.has(record.indicatorId));
  console.log(`[feishu] 远端已有 ${remoteIds.size} 条，待创建 ${pending.length} 条`);
  const created = pending.length ? batchCreateFeishu(config, pending, updatedAt) : 0;
  writeFeishuConfig(config, {
    initializedAt: readJson(config.configPath, {}).initializedAt || updatedAt,
    syncedAt: new Date().toISOString(),
    syncedCount: records.length,
    createdInLastRun: created,
  });
  return {
    configPath: config.configPath,
    tableName: config.tableName,
    tableId: config.tableId,
    baseUrl: config.baseUrl || `https://my.feishu.cn/base/${config.baseToken}`,
    remoteExisting: remoteIds.size,
    created,
  };
}

async function main() {
  loadEnvFile(path.join(projectRoot, '.env'));
  loadEnvFile(path.join(projectRoot, '.env.local'), { override: true });

  const workbookPath = path.resolve(readArg('workbook', DEFAULT_WORKBOOK_PATH));
  const version = trim(readArg('version', DEFAULT_VERSION)) || DEFAULT_VERSION;
  const dryRun = hasFlag('dry-run');
  const localOnly = hasFlag('local-only');
  const feishuOnly = hasFlag('feishu-only');
  const reportPath = path.join(runtimeDir, `insurance-indicator-sync-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);

  const allRecords = await loadIndicatorRows(workbookPath, version);
  const recordOffset = Number(readArg('record-offset', '0'));
  const recordLimit = Number(readArg('record-limit', '0'));
  const normalizedOffset = Number.isFinite(recordOffset) && recordOffset > 0 ? Math.floor(recordOffset) : 0;
  const normalizedLimit = Number.isFinite(recordLimit) && recordLimit > 0 ? Math.floor(recordLimit) : 0;
  const records = normalizedLimit
    ? allRecords.slice(normalizedOffset, normalizedOffset + normalizedLimit)
    : allRecords.slice(normalizedOffset);
  const stats = buildStats(records);
  if (stats.duplicateIdCount) {
    throw new Error(`指标ID 存在重复：${stats.duplicateIds.join(', ')}`);
  }

  console.log('[indicator] 待同步量化指标概览：');
  console.log(JSON.stringify(stats, null, 2));

  if (dryRun) {
    writeJson(reportPath, {
      dryRun: true,
      workbookPath,
      version,
      totalRecords: allRecords.length,
      recordOffset: normalizedOffset,
      recordLimit: normalizedLimit || null,
      stats,
    });
    console.log(`[indicator] dry-run 未写入本地和飞书，报告：${reportPath}`);
    return;
  }

  let local = null;
  if (!feishuOnly) {
    local = saveLocalIndicatorRecords({ records, stats, version, workbookPath });
    console.log(`[indicator] 已写入本地知识库 ${records.length} 条，备份：${local.backupPath}`);
  }

  let feishu = null;
  if (!localOnly) {
    feishu = syncFeishu(records, local?.generatedAt || new Date().toISOString());
    console.log(`[feishu] 已同步飞书表 ${feishu.tableName}，新增 ${feishu.created} 条`);
    console.log(`[feishu] 配置：${feishu.configPath}`);
  }

  writeJson(reportPath, {
    dryRun: false,
    workbookPath,
    version,
    totalRecords: allRecords.length,
    recordOffset: normalizedOffset,
    recordLimit: normalizedLimit || null,
    stats,
    local,
    feishu,
  });
  console.log(`[indicator] 同步报告：${reportPath}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
