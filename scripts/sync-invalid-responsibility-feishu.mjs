import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);
const runtimeDir = path.join(projectRoot, '.runtime');
const defaultSuspectsPath = path.join(runtimeDir, 'responsibility-quality-suspects-no-pingan.json');
const baseToken = process.env.FEISHU_KNOWLEDGE_BASE_TOKEN || 'IR6Tb9RoEaXb1tsunNzcfKIxnrd';
const identity = process.env.FEISHU_KNOWLEDGE_AS || 'user';
const KNOWN_TABLE_IDS = {
  新华人寿: 'tblfBjd71tuHsTFs',
};

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

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function selectedSeverities() {
  return new Set(
    String(readArg('severity', 'high,medium'))
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function parseCliJson(stdout) {
  const text = String(stdout || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`飞书 CLI 没有返回 JSON：${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start, end + 1));
}

function runLark(args) {
  const result = spawnSync('lark-cli', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 30 * 1024 * 1024,
  });
  if (result.status === 0) return parseCliJson(result.stdout);
  throw new Error([`lark-cli ${args.join(' ')} 执行失败`, result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join('\n'));
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function loadConfigByTableName() {
  const byName = new Map();
  for (const file of fs.readdirSync(runtimeDir).filter((item) => /^feishu-knowledge-.*\.json$/u.test(item))) {
    const config = readJson(path.join(runtimeDir, file), {});
    if (config.tableName && config.tableId) byName.set(config.tableName, { ...config, configFile: file });
  }
  return byName;
}

function ensureQualityFields(tableId) {
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
  const names = new Set((payload?.data?.fields || []).map((field) => String(field.name || '').trim()).filter(Boolean));
  for (const name of ['质量状态', '质量问题']) {
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
  }
}

function listRemoteRecordMap(tableId) {
  let offset = 0;
  const limit = 200;
  const byLocalId = new Map();
  const byUrl = new Map();
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
    rows.forEach((row, index) => {
      const localId = String(Array.isArray(row) ? row[0] : row?.fields?.本地ID || '').trim();
      const url = String(Array.isArray(row) ? row[1] : row?.fields?.来源链接 || '').trim();
      const recordId = String(recordIds[index] || '').trim();
      if (localId && recordId) byLocalId.set(localId, recordId);
      if (url && recordId) byUrl.set(url, recordId);
    });
    if (rows.length < limit) break;
    offset += limit;
  }
  return { byLocalId, byUrl };
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

const severities = selectedSeverities();
const companyFilter = String(readArg('company', '')).trim();
const suspectsPath = path.resolve(readArg('suspects-path', defaultSuspectsPath));
const configsByName = loadConfigByTableName();
const suspects = readJson(suspectsPath, [])
  .filter((item) => !companyFilter || item.company === companyFilter || item.feishuTableName === companyFilter)
  .filter((item) => severities.has(item.severity));

const byTable = new Map();
const skipped = [];
for (const item of suspects) {
  const config = item.feishuTableId
    ? { tableId: item.feishuTableId, tableName: item.feishuTableName }
    : configsByName.get(item.feishuTableName) || (KNOWN_TABLE_IDS[item.feishuTableName] ? { tableId: KNOWN_TABLE_IDS[item.feishuTableName], tableName: item.feishuTableName } : null);
  if (!config?.tableId) {
    skipped.push({ id: item.id, company: item.company, tableName: item.feishuTableName, reason: 'missing_table_config' });
    continue;
  }
  const table = byTable.get(config.tableId) || { tableId: config.tableId, tableName: item.feishuTableName, items: [] };
  table.items.push(item);
  byTable.set(config.tableId, table);
}

let updated = 0;
const missingRemote = [];
const tableReports = [];
for (const table of byTable.values()) {
  ensureQualityFields(table.tableId);
  const remoteMap = listRemoteRecordMap(table.tableId);
  const byReason = new Map();
  for (const item of table.items) {
    const recordId = remoteMap.byLocalId.get(String(item.id)) || remoteMap.byUrl.get(String(item.url || '').trim());
    if (!recordId) {
      missingRemote.push({ id: item.id, company: item.company, tableName: table.tableName });
      continue;
    }
    const reason = item.reasons || '疑似非保险责任正文';
    const recordIds = byReason.get(reason) || [];
    recordIds.push(recordId);
    byReason.set(reason, recordIds);
  }
  let tableUpdated = 0;
  for (const [reason, recordIds] of byReason.entries()) {
    for (const recordIdChunk of chunk(recordIds, 100)) {
      runLark([
        'base',
        '+record-batch-update',
        '--as',
        identity,
        '--base-token',
        baseToken,
        '--table-id',
        table.tableId,
        '--json',
        JSON.stringify({
          record_id_list: recordIdChunk,
          patch: {
            保险责任正文: '',
            质量状态: 'invalid_responsibility',
            质量问题: reason,
          },
        }),
      ]);
      updated += recordIdChunk.length;
      tableUpdated += recordIdChunk.length;
      console.log(`[feishu-invalid] ${table.tableName} ${tableUpdated}/${table.items.length}`);
      sleepMs(250);
    }
  }
  tableReports.push({ tableName: table.tableName, tableId: table.tableId, target: table.items.length, updated: tableUpdated });
}

const report = {
  ok: true,
  severity: [...severities],
  target: suspects.length,
  updated,
  skipped,
  missingRemote,
  tables: tableReports,
};
writeJson(path.join(runtimeDir, 'feishu-invalid-responsibility-sync-report.json'), report);
console.log(JSON.stringify(report, null, 2));
