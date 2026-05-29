import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');

const DEFAULT_CATALOG_PATH = path.join(runtimeDir, 'ping-an-product-catalog.json');
const DEFAULT_CONFIG_PATH = path.join(runtimeDir, 'feishu-product-catalog-ping-an.json');
const DEFAULT_BASE_NAME = '保险产品知识库';
const DEFAULT_TABLE_NAME = '中国平安产品目录';

const FIELD_NAMES = [
  '目录ID',
  '保险公司',
  '产品名称',
  '产品分类',
  '销售状态',
  '停售日期',
  'PlanCode',
  'VersionNo',
  '条款标记',
  '说明书标记',
  '入库状态',
  '入库资料数',
  '入库条款数',
  '入库说明书数',
  '跳过原因',
  '官方域名',
  '产品列表来源',
  '条款链接',
  '说明书链接',
  '更新时间',
];

function loadEnvFile(envPath, { override = false } = {}) {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
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

function parseCliJson(stdout) {
  const text = String(stdout || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`飞书 CLI 没有返回 JSON：${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start, end + 1));
}

function runLark(args, { retries = 3 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const result = spawnSync('lark-cli', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.status === 0) return parseCliJson(result.stdout);
    lastError = [
      `lark-cli ${args.join(' ')} 执行失败`,
      result.stdout?.trim(),
      result.stderr?.trim(),
    ]
      .filter(Boolean)
      .join('\n');
    if (attempt < retries && /timeout|i\/o timeout|temporarily|ECONNRESET|ETIMEDOUT|EOF/iu.test(lastError)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 1200);
      continue;
    }
    break;
  }
  throw new Error(lastError || `lark-cli ${args.join(' ')} 执行失败`);
}

function trim(value) {
  return String(value || '').trim();
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function readNumberArg(name, fallback = 0) {
  const value = Number(readArg(name, ''));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readBooleanArg(name) {
  return process.argv.includes(`--${name}`) || ['1', 'true', 'yes'].includes(trim(process.env[name.replace(/-/g, '_').toUpperCase()]).toLowerCase());
}

function resolveConfig() {
  const configPath = path.resolve(readArg('config-path', process.env.FEISHU_CATALOG_CONFIG_PATH || DEFAULT_CONFIG_PATH));
  const saved = readJsonFile(configPath, {});
  return {
    configPath,
    identity: trim(readArg('as', process.env.FEISHU_CATALOG_AS || saved.identity)) || 'user',
    baseName: trim(readArg('base-name', process.env.FEISHU_CATALOG_BASE_NAME || saved.baseName)) || DEFAULT_BASE_NAME,
    tableName: trim(readArg('table-name', process.env.FEISHU_CATALOG_TABLE_NAME || saved.tableName)) || DEFAULT_TABLE_NAME,
    baseToken: trim(readArg('base-token', process.env.FEISHU_CATALOG_BASE_TOKEN || saved.baseToken)),
    tableId: trim(readArg('table-id', process.env.FEISHU_CATALOG_TABLE_ID || saved.tableId)),
    baseUrl: trim(saved.baseUrl),
  };
}

function ensureBase(config) {
  if (config.baseToken) return config;
  const payload = runLark([
    'base',
    '+base-create',
    '--as',
    config.identity,
    '--name',
    config.baseName,
    '--time-zone',
    'Asia/Shanghai',
  ]);
  const base = payload?.data?.base || {};
  if (!base.base_token) throw new Error('飞书 Base 创建成功但没有返回 base_token');
  return {
    ...config,
    baseToken: base.base_token,
    baseUrl: trim(base.url),
  };
}

function ensureTable(config) {
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
  return {
    ...config,
    tableId: table.id,
  };
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

function remoteEffectiveCount(config) {
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
    '目录ID',
    '--field-id',
    '产品名称',
    '--limit',
    '200',
    '--format',
    'json',
  ]);
  const rows = payload?.data?.data || [];
  return rows.filter((row) => trim(row?.[0]) && trim(row?.[1])).length;
}

function loadRemoteCatalogIds(config) {
  const ids = new Set();
  const limit = 200;
  for (let offset = 0; ; offset += limit) {
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
      '目录ID',
      '--limit',
      String(limit),
      '--offset',
      String(offset),
      '--format',
      'json',
    ]);
    const rows = payload?.data?.data || [];
    for (const row of rows) {
      const id = trim(row?.[0]);
      if (id) ids.add(id);
    }
    if (rows.length < limit) break;
  }
  return ids;
}

function toFeishuFields(row) {
  return {
    目录ID: row.catalogId,
    保险公司: row.company,
    产品名称: row.productName,
    产品分类: row.productType,
    销售状态: row.salesStatus,
    停售日期: row.stopSellDate,
    PlanCode: row.planCode,
    VersionNo: row.versionNo,
    条款标记: row.hasTerms ? '是' : '否',
    说明书标记: row.hasProductManual ? '是' : '否',
    入库状态: row.knowledgeStatus,
    入库资料数: String(row.knowledgeRecordCount || 0),
    入库条款数: String(row.knowledgeTermsCount || 0),
    入库说明书数: String(row.knowledgeProductManualCount || 0),
    跳过原因: row.skipReason,
    官方域名: row.officialDomain,
    产品列表来源: row.sourcePage,
    条款链接: row.termsUrl,
    说明书链接: row.productManualUrl,
    更新时间: row.updatedAt,
  };
}

function batchCreateRecords(config, records, { chunkSize = 100 } = {}) {
  let created = 0;
  for (let index = 0; index < records.length; index += chunkSize) {
    const chunk = records.slice(index, index + chunkSize);
    const rows = chunk.map((record) => {
      const fields = toFeishuFields(record);
      return FIELD_NAMES.map((fieldName) => fields[fieldName] || '');
    });
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
        JSON.stringify({ fields: FIELD_NAMES, rows }),
      ],
      { retries: 1 },
    );
    created += chunk.length;
  }
  return created;
}

function main() {
  loadEnvFile(path.join(projectRoot, '.env'));
  loadEnvFile(path.join(projectRoot, '.env.local'), { override: true });

  const catalogPath = path.resolve(readArg('catalog-path', process.env.PING_AN_CATALOG_PATH || DEFAULT_CATALOG_PATH));
  const catalog = readJsonFile(catalogPath, {});
  const records = Array.isArray(catalog.products) ? catalog.products : [];
  if (!records.length) throw new Error(`产品目录为空：${catalogPath}`);

  let config = resolveConfig();
  config = ensureBase(config);
  config = ensureTable(config);
  ensureFields(config);

  const existingIds = loadRemoteCatalogIds(config);
  const existingCount = existingIds.size || remoteEffectiveCount(config);
  const missingRecords = records.filter((record) => !existingIds.has(trim(record.catalogId)));
  if (!missingRecords.length) {
    console.log(`[feishu] 产品目录已是最新：有效记录 ${existingCount} 条，无需新增`);
    return;
  }
  if (existingCount > 0) {
    console.log(`[feishu] 飞书表已有 ${existingCount} 条目录记录，本次只补 ${missingRecords.length} 条缺失记录`);
  }

  const chunkSize = readNumberArg('batch-size', Number(process.env.FEISHU_CATALOG_BATCH_SIZE || 100));
  const created = batchCreateRecords(config, missingRecords, { chunkSize });

  writeJsonFile(config.configPath, {
    baseName: config.baseName,
    tableName: config.tableName,
    identity: config.identity,
    baseToken: config.baseToken,
    tableId: config.tableId,
    baseUrl: config.baseUrl || `https://my.feishu.cn/base/${config.baseToken}`,
    catalogPath,
    syncedAt: new Date().toISOString(),
  });

  console.log(`[feishu] 已同步 ${records.length} 条产品目录记录：新增 ${created}`);
  console.log(`[feishu] Base: ${config.baseUrl || `https://my.feishu.cn/base/${config.baseToken}`}`);
  console.log(`[feishu] 配置: ${config.configPath}`);
}

main();
