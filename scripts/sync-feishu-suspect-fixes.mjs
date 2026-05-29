import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const defaultStatePath = path.join(runtimeDir, 'state.json');
const defaultSuspectsPath = path.join(runtimeDir, 'responsibility-quality-suspects-no-pingan.json');
const defaultBaseToken = 'IR6Tb9RoEaXb1tsunNzcfKIxnrd';

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

function readJson(filePath, fallback) {
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

function parseCliJson(stdout) {
  const text = String(stdout || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`飞书 CLI 没有返回 JSON：${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start, end + 1));
}

function isRetryable(errorText) {
  return /timeout|timed out|i\/o timeout|temporarily|ECONNRESET|ETIMEDOUT|EOF|502|503|504|429|800004135|limited|rate.?limit|too many|too frequent|频率|限流/iu.test(
    errorText,
  );
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runLark(args, { retries = 5 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const result = spawnSync('lark-cli', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 40 * 1024 * 1024,
    });
    if (result.status === 0) return parseCliJson(result.stdout);
    lastError = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join('\n');
    if (attempt < retries && isRetryable(lastError)) {
      sleepMs(Math.min(60000, attempt * 5000));
      continue;
    }
    break;
  }
  throw new Error(lastError || `lark-cli ${args.join(' ')} 执行失败`);
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/gu, '-');
}

function limitText(value, max = 9000) {
  const text = trim(value).replace(/\r\n?/gu, '\n');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 18)}\n...已截断同步展示`;
}

function toFields(record) {
  return {
    本地ID: record.id,
    保险公司: trim(record.company),
    产品名称: trim(record.productName),
    产品分类: trim(record.productType),
    销售状态: trim(record.salesStatus),
    资料类型: trim(record.materialType || record.sourceType),
    标题: trim(record.title),
    官方域名: trim(record.officialDomain),
    来源链接: trim(record.url),
    摘要: limitText(record.snippet, 1200),
    保险责任正文: limitText(record.pageText),
    质量状态: trim(record.qualityStatus),
    质量问题: limitText(record.qualityReason, 1200),
    解析器: trim(record.parser),
    更新时间: trim(record.updatedAt || record.lastFetchedAt || record.discoveredAt),
  };
}

function chunk(array, size) {
  const chunks = [];
  for (let index = 0; index < array.length; index += size) chunks.push(array.slice(index, index + size));
  return chunks;
}

function loadTableConfigs() {
  const configs = [];
  for (const file of fs.readdirSync(runtimeDir)) {
    if (!file.startsWith('feishu-knowledge') || !file.endsWith('.json')) continue;
    const config = readJson(path.join(runtimeDir, file), {});
    configs.push({
      file,
      tableName: trim(config.tableName),
      tableId: trim(config.tableId),
      baseToken: trim(config.baseToken) || defaultBaseToken,
    });
  }
  return configs;
}

function listTables(baseToken, identity) {
  const payload = runLark([
    'base',
    '+table-list',
    '--as',
    identity,
    '--base-token',
    baseToken,
    '--limit',
    '200',
  ]);
  const tables = payload?.data?.tables || [];
  return new Map(tables.map((table) => [trim(table.name), trim(table.id)]).filter(([name, id]) => name && id));
}

function ensureSyncFields({ baseToken, tableId, identity }) {
  const payload = runLark([
    'base',
    '+field-list',
    '--as',
    identity,
    '--base-token',
    baseToken,
    '--table-id',
    tableId,
    '--limit',
    '200',
  ]);
  const names = new Set((payload?.data?.fields || []).map((field) => trim(field.name)).filter(Boolean));
  for (const name of ['质量状态', '质量问题', '解析器', '更新时间']) {
    if (names.has(name)) continue;
    runLark([
      'base',
      '+field-create',
      '--as',
      identity,
      '--base-token',
      baseToken,
      '--table-id',
      tableId,
      '--json',
      JSON.stringify({ name, type: 'text' }),
    ]);
    names.add(name);
  }
}

function listRemoteRecordMap({ baseToken, tableId, identity }) {
  let offset = 0;
  const limit = 200;
  const byLocalId = new Map();
  const byUrl = new Map();
  const byProductAndTitle = new Map();
  const byProductNameCandidates = new Map();
  while (true) {
    const payload = runLark([
      'base',
      '+record-list',
      '--as',
      identity,
      '--base-token',
      baseToken,
      '--table-id',
      tableId,
      '--field-id',
      '本地ID',
      '--field-id',
      '产品名称',
      '--field-id',
      '标题',
      '--field-id',
      '来源链接',
      '--limit',
      String(limit),
      '--offset',
      String(offset),
      '--format',
      'json',
    ]);
    const rows = payload?.data?.data || [];
    const recordIds = payload?.data?.record_id_list || [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const localId = trim(Array.isArray(row) ? row[0] : row?.fields?.本地ID);
      const productName = trim(Array.isArray(row) ? row[1] : row?.fields?.产品名称);
      const title = trim(Array.isArray(row) ? row[2] : row?.fields?.标题);
      const url = trim(Array.isArray(row) ? row[3] : row?.fields?.来源链接);
      const recordId = trim(recordIds[index]);
      if (localId && recordId) byLocalId.set(localId, recordId);
      if (url && recordId) byUrl.set(url, recordId);
      if (productName && title && recordId) byProductAndTitle.set(`${productName}::${title}`, recordId);
      if (productName && recordId) {
        if (!byProductNameCandidates.has(productName)) byProductNameCandidates.set(productName, []);
        byProductNameCandidates.get(productName).push(recordId);
      }
    }
    if (rows.length < limit) break;
    offset += limit;
  }
  const byUniqueProductName = new Map(
    [...byProductNameCandidates.entries()]
      .filter(([, recordIds]) => recordIds.length === 1)
      .map(([productName, recordIds]) => [productName, recordIds[0]]),
  );
  return { byLocalId, byUrl, byProductAndTitle, byUniqueProductName };
}

function resolveRemoteRecordId(remoteMap, record) {
  return (
    remoteMap.byLocalId.get(trim(record.id)) ||
    remoteMap.byUrl.get(trim(record.url)) ||
    remoteMap.byProductAndTitle.get(`${trim(record.productName)}::${trim(record.title)}`) ||
    remoteMap.byUniqueProductName.get(trim(record.productName)) ||
    ''
  );
}

function updateOneRecord({ baseToken, tableId, identity, recordId, record }) {
  runLark([
    'base',
    '+record-upsert',
    '--as',
    identity,
    '--base-token',
    baseToken,
    '--table-id',
    tableId,
    '--record-id',
    recordId,
    '--json',
    JSON.stringify(toFields(record)),
  ]);
}

function batchPatchRecords({ baseToken, tableId, identity, recordIds, patch, chunkSize }) {
  for (const ids of chunk(recordIds, chunkSize)) {
    runLark(
      [
        'base',
        '+record-batch-update',
        '--as',
        identity,
        '--base-token',
        baseToken,
        '--table-id',
        tableId,
        '--json',
        JSON.stringify({ record_id_list: ids, patch }),
      ],
      { retries: 8 },
    );
  }
}

function main() {
  const statePath = path.resolve(readArg('state-path', process.env.POLICY_OCR_APP_STATE_PATH || defaultStatePath));
  const suspectsPath = path.resolve(readArg('suspects-path', defaultSuspectsPath));
  const identity = trim(readArg('as', process.env.FEISHU_KNOWLEDGE_AS || 'user')) || 'user';
  const baseToken = trim(readArg('base-token', process.env.FEISHU_KNOWLEDGE_BASE_TOKEN || defaultBaseToken)) || defaultBaseToken;
  const companyFilter = new Set(
    trim(readArg('company', ''))
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const dryRun = process.argv.includes('--dry-run');
  const chunkSize = readNumberArg('chunk-size', 100) || 100;
  const reportPath = path.join(runtimeDir, `feishu-suspect-fix-sync-report-${timestampForFile()}.json`);

  const state = readJson(statePath, {});
  const recordsById = new Map((state.knowledgeRecords || []).map((record) => [trim(record.id), record]));
  const suspects = readJson(suspectsPath, []);
  const configs = loadTableConfigs();
  const tablesByName = listTables(baseToken, identity);
  const groups = new Map();

  for (const suspect of suspects) {
    const id = trim(suspect.id || suspect.localId);
    const record = recordsById.get(id);
    if (!record) continue;
    const company = trim(suspect.company || record.company);
    if (companyFilter.size && !companyFilter.has(company)) continue;
    const qualityStatus = trim(record.qualityStatus);
    const qualityReason = trim(record.qualityReason);
    if (qualityStatus !== 'valid_responsibility_refilled' && !qualityReason.startsWith('reextract_failed:')) continue;

    const tableName = trim(suspect.feishuTableName) || company;
    const config = configs.find((item) => trim(item.tableId) === trim(suspect.feishuTableId)) || configs.find((item) => item.tableName === tableName);
    const tableId = trim(suspect.feishuTableId) || trim(config?.tableId) || tablesByName.get(tableName);
    if (!tableId) {
      console.warn(`[feishu-sync] 找不到表 ID：${company} / ${tableName}`);
      continue;
    }
    const key = `${baseToken}::${tableId}::${tableName}`;
    if (!groups.has(key)) {
      groups.set(key, { baseToken, tableId, tableName, company, records: [] });
    }
    groups.get(key).records.push(record);
  }

  const report = {
    ok: true,
    dryRun,
    suspectsPath,
    statePath,
    groupCount: groups.size,
    groups: [],
  };

  for (const group of groups.values()) {
    if (!dryRun) ensureSyncFields({ ...group, identity });
    const remoteMap = dryRun
      ? {
          byLocalId: new Map(group.records.map((record) => [trim(record.id), `dry_${trim(record.id)}`])),
          byUrl: new Map(),
          byProductAndTitle: new Map(),
          byUniqueProductName: new Map(),
        }
      : listRemoteRecordMap({ ...group, identity });
    let validUpdated = 0;
    let failedUpdated = 0;
    let missing = 0;
    const failedByPatch = new Map();
    for (const record of group.records) {
      const recordId = resolveRemoteRecordId(remoteMap, record);
      if (!recordId) {
        missing += 1;
        continue;
      }
      if (trim(record.qualityStatus) === 'valid_responsibility_refilled') {
        if (!dryRun) updateOneRecord({ ...group, identity, recordId, record });
        validUpdated += 1;
      } else {
        const patch = {
          本地ID: trim(record.id),
          保险公司: trim(record.company),
          产品名称: trim(record.productName),
          产品分类: trim(record.productType),
          销售状态: trim(record.salesStatus),
          资料类型: trim(record.materialType || record.sourceType),
          标题: trim(record.title),
          官方域名: trim(record.officialDomain),
          来源链接: trim(record.url),
          摘要: limitText(record.snippet, 1200),
          保险责任正文: null,
          质量状态: 'invalid_responsibility',
          质量问题: limitText(record.qualityReason, 1200),
          解析器: trim(record.parser),
          更新时间: trim(record.updatedAt || record.lastFetchedAt || record.discoveredAt),
        };
        const patchKey = JSON.stringify(patch);
        if (!failedByPatch.has(patchKey)) failedByPatch.set(patchKey, { patch, recordIds: [] });
        failedByPatch.get(patchKey).recordIds.push(recordId);
      }
      if ((validUpdated + failedUpdated + missing) % 50 === 0) {
        console.log(
          `[feishu-sync] ${group.tableName} 已准备/同步 ${validUpdated + failedUpdated + missing}/${group.records.length}`,
        );
      }
    }
    for (const { patch, recordIds } of failedByPatch.values()) {
      if (!dryRun) batchPatchRecords({ ...group, identity, recordIds, patch, chunkSize });
      failedUpdated += recordIds.length;
      console.log(`[feishu-sync] ${group.tableName} 批量失败状态 ${failedUpdated}/${group.records.length}`);
    }
    report.groups.push({
      tableName: group.tableName,
      tableId: group.tableId,
      selectedCount: group.records.length,
      validUpdated,
      failedUpdated,
      missing,
    });
    console.log(
      `[feishu-sync] ${group.tableName} 完成：补回 ${validUpdated}，失败清空 ${failedUpdated}，远端缺失 ${missing}`,
    );
    writeJson(reportPath, report);
  }

  writeJson(reportPath, report);
  console.log(JSON.stringify({ ok: true, reportPath, groupCount: report.groupCount }, null, 2));
}

main();
