import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createKnowledgeStateStore } from './runtime-knowledge-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');

const DEFAULT_STATE_PATH = path.join(runtimeDir, 'state.json');
const DEFAULT_CONFIG_PATH = path.join(runtimeDir, 'feishu-knowledge.json');
const DEFAULT_BASE_NAME = '保险产品知识库';
const DEFAULT_TABLE_NAME = '保险资料';

const FIELD_NAMES = [
  '本地ID',
  '保险公司',
  '产品名称',
  '产品分类',
  '销售状态',
  '资料类型',
  '标题',
  '官方域名',
  '来源链接',
  '摘要',
  '保险责任正文',
  '质量状态',
  '质量问题',
  '解析器',
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
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

function writeSyncConfig(config, extra = {}) {
  writeJsonFile(config.configPath, {
    baseName: config.baseName,
    tableName: config.tableName,
    identity: config.identity,
    baseToken: config.baseToken,
    tableId: config.tableId,
    baseUrl: config.baseUrl || `https://my.feishu.cn/base/${config.baseToken}`,
    ...extra,
  });
}

function parseCliJson(stdout) {
  const text = String(stdout || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`飞书 CLI 没有返回 JSON：${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start, end + 1));
}

function retryDelayMs(errorText, attempt) {
  if (/800004135|limited|rate.?limit|too many|too frequent|频率|限流/iu.test(errorText)) {
    return Math.min(60000, attempt * 15000);
  }
  return attempt * 1200;
}

function isRetryableLarkError(errorText) {
  return /timeout|timed out|i\/o timeout|temporarily|ECONNRESET|ETIMEDOUT|EOF|502|503|504|429|800004135|limited|rate.?limit|too many|too frequent|频率|限流/iu.test(errorText);
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
    if (attempt < retries && isRetryableLarkError(lastError)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelayMs(lastError, attempt));
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

function limitText(value, max = 9000) {
  const text = trim(value).replace(/\r\n?/gu, '\n');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 18)}\n...已截断同步展示`;
}

function normalizeKnowledgeRecord(record) {
  return {
      id: String(record.id || '').trim(),
      company: trim(record.company),
      productName: trim(record.productName),
      productType: trim(record.productType),
      salesStatus: trim(record.salesStatus),
      materialType: trim(record.materialType || record.sourceType),
      title: trim(record.title),
      officialDomain: trim(record.officialDomain),
      url: trim(record.url),
      snippet: trim(record.snippet),
      pageText: trim(record.pageText),
      qualityStatus: trim(record.qualityStatus),
      qualityReason: trim(record.qualityReason),
      parser: trim(record.parser),
      updatedAt: trim(record.updatedAt || record.lastFetchedAt || record.discoveredAt),
    };
}

function loadKnowledgeRecords(statePath) {
  const state = readJsonFile(statePath, {});
  return (Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords : [])
    .map(normalizeKnowledgeRecord)
    .filter((record) => record.id && (record.company || record.productName || record.url));
}

async function loadKnowledgeRecordsForSync(statePath, { preferFile = false } = {}) {
  if (preferFile) return { records: loadKnowledgeRecords(statePath), source: statePath };
  try {
    const knowledgeStore = await createKnowledgeStateStore();
    try {
      const records = knowledgeStore.loadState().knowledgeRecords
        .map(normalizeKnowledgeRecord)
        .filter((record) => record.id && (record.company || record.productName || record.url));
      if (records.length) return { records, source: knowledgeStore.dbPath };
    } finally {
      knowledgeStore.close();
    }
  } catch (error) {
    console.warn(`[feishu] SQLite 知识库读取失败，回退到 state.json：${error.message}`);
  }
  return { records: loadKnowledgeRecords(statePath), source: statePath };
}

function resolveConfig() {
  const configPath = path.resolve(readArg('config-path', process.env.FEISHU_KNOWLEDGE_CONFIG_PATH || DEFAULT_CONFIG_PATH));
  const saved = readJsonFile(configPath, {});
  return {
    configPath,
    identity: trim(readArg('as', process.env.FEISHU_KNOWLEDGE_AS || saved.identity)) || 'user',
    baseName: trim(readArg('base-name', process.env.FEISHU_KNOWLEDGE_BASE_NAME || saved.baseName)) || DEFAULT_BASE_NAME,
    tableName: trim(readArg('table-name', process.env.FEISHU_KNOWLEDGE_TABLE_NAME || saved.tableName)) || DEFAULT_TABLE_NAME,
    baseToken: trim(readArg('base-token', process.env.FEISHU_KNOWLEDGE_BASE_TOKEN || saved.baseToken)),
    tableId: trim(readArg('table-id', process.env.FEISHU_KNOWLEDGE_TABLE_ID || saved.tableId)),
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

function findRemoteRecordId(config, localId) {
  const payload = runLark([
    'base',
    '+record-search',
    '--as',
    config.identity,
    '--base-token',
    config.baseToken,
    '--table-id',
    config.tableId,
    '--json',
    JSON.stringify({
      keyword: String(localId),
      search_fields: ['本地ID'],
      select_fields: ['本地ID'],
      limit: 10,
    }),
    '--format',
    'json',
  ]);
  const recordIds = payload?.data?.record_id_list || [];
  return trim(recordIds[0]);
}

function listRemoteLocalIds(config) {
  let offset = 0;
  const limit = 200;
  const ids = new Set();
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
      '本地ID',
      '--limit',
      String(limit),
      '--offset',
      String(offset),
      '--format',
      'json',
    ]);
    const rows = payload?.data?.data || [];
    for (const row of rows) {
      const localId = trim(Array.isArray(row) ? row[0] : row?.fields?.本地ID);
      if (localId) ids.add(localId);
    }
    if (rows.length < limit) break;
    offset += limit;
  }
  return ids;
}

function toFeishuFields(record) {
  const pageTextMax = readNumberArg('page-text-max', Number(process.env.FEISHU_KNOWLEDGE_PAGE_TEXT_MAX || 9000));
  return {
    本地ID: record.id,
    保险公司: record.company,
    产品名称: record.productName,
    产品分类: record.productType,
    销售状态: record.salesStatus,
    资料类型: record.materialType,
    标题: record.title,
    官方域名: record.officialDomain,
    来源链接: record.url,
    摘要: limitText(record.snippet, 1200),
    保险责任正文: limitText(record.pageText, pageTextMax),
    质量状态: record.qualityStatus,
    质量问题: limitText(record.qualityReason, 1200),
    解析器: record.parser,
    更新时间: record.updatedAt,
  };
}

function upsertRecord(config, record) {
  const remoteRecordId = findRemoteRecordId(config, record.id);
  const args = [
    'base',
    '+record-upsert',
    '--as',
    config.identity,
    '--base-token',
    config.baseToken,
    '--table-id',
    config.tableId,
    '--json',
    JSON.stringify(toFeishuFields(record)),
  ];
  if (remoteRecordId) args.push('--record-id', remoteRecordId);
  runLark(args);
  return remoteRecordId ? 'updated' : 'created';
}

function createRecord(config, record) {
  const args = [
    'base',
    '+record-upsert',
    '--as',
    config.identity,
    '--base-token',
    config.baseToken,
    '--table-id',
    config.tableId,
    '--json',
    JSON.stringify(toFeishuFields(record)),
  ];
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      runLark(args, { retries: 1 });
      return 'created';
    } catch (error) {
      lastError = error;
      if (!isRetryableLarkError(error.message)) throw error;
      const remoteRecordId = findRemoteRecordId(config, record.id);
      if (remoteRecordId) return 'created';
      sleepMs(retryDelayMs(error.message, attempt));
    }
  }
  throw lastError;
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function batchCreateRecords(config, records, { chunkSize = 10, delayMs = 0 } = {}) {
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
      { retries: 8 },
    );
    created += chunk.length;
    console.log(`[feishu] 批量创建进度 ${created}/${records.length}`);
    if (delayMs && index + chunkSize < records.length) sleepMs(delayMs);
  }
  return created;
}

function buildSyncPlan(records) {
  const ids = records.map((record) => Number(record.id)).filter(Number.isFinite).sort((left, right) => left - right);
  const byCompany = {};
  const byMaterialType = {};
  const byQualityStatus = {};
  const duplicateKeys = [];
  const seen = new Set();
  for (const record of records) {
    byCompany[record.company || '未知'] = (byCompany[record.company || '未知'] || 0) + 1;
    byMaterialType[record.materialType || '未知'] = (byMaterialType[record.materialType || '未知'] || 0) + 1;
    byQualityStatus[record.qualityStatus || '未标记'] = (byQualityStatus[record.qualityStatus || '未标记'] || 0) + 1;
    const key = trim(record.url) || [record.company, record.productName, record.materialType, record.title].map(trim).join('|');
    if (!key) continue;
    if (seen.has(key)) duplicateKeys.push({ id: record.id, key, productName: record.productName, title: record.title });
    else seen.add(key);
  }
  return {
    count: records.length,
    minId: ids[0] || null,
    maxId: ids.at(-1) || null,
    byCompany,
    byMaterialType,
    byQualityStatus,
    duplicateKeyCount: duplicateKeys.length,
    duplicateKeys: duplicateKeys.slice(0, 20),
    sample: records.slice(0, 20).map((record) => ({
      id: record.id,
      company: record.company,
      productName: record.productName,
      materialType: record.materialType,
      title: record.title,
      url: record.url,
      qualityStatus: record.qualityStatus,
    })),
  };
}

async function main() {
  loadEnvFile(path.join(projectRoot, '.env'));
  loadEnvFile(path.join(projectRoot, '.env.local'), { override: true });

  const explicitStatePath = Boolean(readArg('state-path', ''));
  const statePath = path.resolve(readArg('state-path', process.env.POLICY_OCR_APP_STATE_PATH || DEFAULT_STATE_PATH));
  const localIdMin = readNumberArg('local-id-min', Number(process.env.FEISHU_KNOWLEDGE_LOCAL_ID_MIN || 0));
  const localIdMax = readNumberArg('local-id-max', Number(process.env.FEISHU_KNOWLEDGE_LOCAL_ID_MAX || 0));
  const createOnly = readBooleanArg('create-only');
  const createOnlySingle = readBooleanArg('create-only-single');
  const dryRun = readBooleanArg('dry-run');
  if (createOnly && !localIdMin) {
    throw new Error('使用 --create-only 时必须同时传 --local-id-min，避免重复写入飞书');
  }
  const company = trim(readArg('company', process.env.FEISHU_KNOWLEDGE_COMPANY || ''));
  const qualityStatus = trim(readArg('quality-status', process.env.FEISHU_KNOWLEDGE_QUALITY_STATUS || ''));
  const idFilter = new Set(
    trim(readArg('ids', process.env.FEISHU_KNOWLEDGE_IDS || ''))
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const localKnowledge = await loadKnowledgeRecordsForSync(statePath, { preferFile: explicitStatePath });
  let records = localKnowledge.records
    .filter((record) => !company || record.company === company)
    .filter((record) => !qualityStatus || record.qualityStatus === qualityStatus)
    .filter((record) => !idFilter.size || idFilter.has(record.id))
    .filter((record) => !localIdMin || Number(record.id) >= localIdMin)
    .filter((record) => !localIdMax || Number(record.id) <= localIdMax)
    .sort((left, right) => Number(left.id) - Number(right.id));
  if (!records.length) {
    console.log(`[feishu] 本地知识库为空：${localKnowledge.source}`);
    return;
  }

  let config = resolveConfig();
  if (dryRun) {
    if (!config.baseToken || !config.tableId) {
      throw new Error('使用 --dry-run 时需要已有 baseToken 和 tableId，请传 --config-path 指向已初始化的飞书配置');
    }
    if (createOnly && readBooleanArg('skip-existing-local-ids')) {
      const remoteLocalIds = listRemoteLocalIds(config);
      const beforeSkip = records.length;
      records = records.filter((record) => !remoteLocalIds.has(record.id));
      console.log(`[feishu] dry-run 已跳过远端已有本地ID ${beforeSkip - records.length} 条，待创建 ${records.length} 条`);
    }
    console.log('[feishu] dry-run 未写入飞书，待同步计划如下：');
    console.log(JSON.stringify(buildSyncPlan(records), null, 2));
    return;
  }
  config = ensureBase(config);
  config = ensureTable(config);
  ensureFields(config);
  writeSyncConfig(config, {
    initializedAt: new Date().toISOString(),
  });

  let created = 0;
  let updated = 0;
  if (createOnly && readBooleanArg('skip-existing-local-ids')) {
    const remoteLocalIds = listRemoteLocalIds(config);
    const beforeSkip = records.length;
    records = records.filter((record) => !remoteLocalIds.has(record.id));
    console.log(`[feishu] 已跳过远端已有本地ID ${beforeSkip - records.length} 条，待创建 ${records.length} 条`);
  }
  if (createOnly && createOnlySingle) {
    const delayMs = readNumberArg('single-delay-ms', Number(process.env.FEISHU_KNOWLEDGE_SINGLE_DELAY_MS || 0));
    for (const [index, record] of records.entries()) {
      createRecord(config, record);
      created += 1;
      if (created % 50 === 0 || created === records.length) {
        console.log(`[feishu] 单条创建进度 ${created}/${records.length}`);
      }
      if (delayMs && index + 1 < records.length) sleepMs(delayMs);
    }
  } else if (createOnly) {
    const chunkSize = readNumberArg('batch-size', Number(process.env.FEISHU_KNOWLEDGE_BATCH_SIZE || 10));
    const delayMs = readNumberArg('batch-delay-ms', Number(process.env.FEISHU_KNOWLEDGE_BATCH_DELAY_MS || 0));
    created = batchCreateRecords(config, records, { chunkSize, delayMs });
  } else {
    for (const record of records) {
      const action = upsertRecord(config, record);
      if (action === 'created') created += 1;
      if (action === 'updated') updated += 1;
      if ((created + updated) % 50 === 0 || created + updated === records.length) {
        console.log(`[feishu] Upsert 进度 ${created + updated}/${records.length}`);
      }
    }
  }

  writeSyncConfig(config, {
    initializedAt: readJsonFile(config.configPath, {}).initializedAt,
    syncedAt: new Date().toISOString(),
  });

  console.log(`[feishu] 已同步 ${records.length} 条知识库记录：新增 ${created}，更新 ${updated}`);
  console.log(`[feishu] Base: ${config.baseUrl || `https://my.feishu.cn/base/${config.baseToken}`}`);
  console.log(`[feishu] 配置: ${config.configPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
