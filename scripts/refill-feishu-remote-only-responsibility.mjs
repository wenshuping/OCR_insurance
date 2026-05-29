import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const statePathDefault = path.join(runtimeDir, 'state.json');
const crawlerPath = path.join(projectRoot, 'server', 'scrapling-policy-crawler.py');
const scraplingPython = process.env.SCRAPLING_PYTHON_BIN || '/Users/wenshuping/Documents/Scrapling/.venv/bin/python';
const scraplingCwd = process.env.SCRAPLING_PROJECT_DIR || '/Users/wenshuping/Documents/Scrapling';
const defaultBaseToken = 'IR6Tb9RoEaXb1tsunNzcfKIxnrd';
const outputMarker = '__POLICY_KNOWLEDGE_JSON__';

function trim(value) {
  return String(value || '').trim();
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
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

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/gu, '-');
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

function limitText(value, max = 9000) {
  const text = trim(value).replace(/\r\n?/gu, '\n');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 18)}\n...已截断同步展示`;
}

function fieldsFromRecord(record) {
  return {
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
    保险责任正文: limitText(record.pageText),
    质量状态: 'valid_responsibility_refilled',
    质量问题: '',
    解析器: trim(record.parser),
    更新时间: new Date().toISOString(),
  };
}

function fieldsFromFailure(suspect, reason) {
  return {
    本地ID: trim(suspect.localId || suspect.id),
    保险公司: trim(suspect.company),
    产品名称: trim(suspect.productName),
    产品分类: trim(suspect.productType),
    资料类型: trim(suspect.materialType),
    标题: trim(suspect.title),
    来源链接: trim(suspect.url),
    保险责任正文: null,
    质量状态: 'invalid_responsibility',
    质量问题: limitText(`reextract_failed:${trim(reason) || 'unknown'}`, 1200),
    解析器: 'remote_only_responsibility_refill',
    更新时间: new Date().toISOString(),
  };
}

function runCrawler(tasks, maxWorkers) {
  const result = spawnSync(scraplingPython, [crawlerPath], {
    cwd: scraplingCwd,
    input: JSON.stringify({ mode: 'reextract_responsibility_records', maxWorkers, records: tasks }),
    encoding: 'utf8',
    maxBuffer: 280 * 1024 * 1024,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  if (result.status !== 0) throw new Error(`远端缺失记录重新抽取失败\n${result.stderr || result.stdout}`);
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`远端缺失记录重新抽取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

function taskFromSuspect(suspect) {
  return {
    id: trim(suspect.localId || suspect.id),
    company: trim(suspect.company),
    productName: trim(suspect.productName),
    productType: trim(suspect.productType),
    salesStatus: trim(suspect.salesStatus),
    title: trim(suspect.title),
    url: trim(suspect.url),
    materialType: trim(suspect.materialType),
  };
}

function main() {
  const statePath = path.resolve(readArg('state-path', process.env.POLICY_OCR_APP_STATE_PATH || statePathDefault));
  const suspectsPath = path.resolve(readArg('suspects-path', path.join(runtimeDir, 'feishu-responsibility-audit-2026-05-25-final-suspects-for-repair.json')));
  const identity = trim(readArg('as', process.env.FEISHU_KNOWLEDGE_AS || 'user')) || 'user';
  const baseToken = trim(readArg('base-token', process.env.FEISHU_KNOWLEDGE_BASE_TOKEN || defaultBaseToken)) || defaultBaseToken;
  const maxWorkers = Number(readArg('max-workers', '3')) || 3;
  const dryRun = process.argv.includes('--dry-run');
  const state = readJson(statePath, {});
  const localIds = new Set((state.knowledgeRecords || []).map((record) => trim(record.id)).filter(Boolean));
  const suspects = readJson(suspectsPath, []).filter((suspect) => trim(suspect.severity) === 'high');
  const remoteOnly = suspects.filter((suspect) => !localIds.has(trim(suspect.localId || suspect.id)));
  const runnable = remoteOnly.filter((suspect) => trim(suspect.productName) && trim(suspect.url) && trim(suspect.recordId) && trim(suspect.feishuTableId));
  const result = dryRun ? { records: [], skipped: [] } : runCrawler(runnable.map(taskFromSuspect), maxWorkers);
  const recordById = new Map((result.records || []).map((record) => [trim(record.id), record]));
  const skippedById = new Map((result.skipped || []).map((item) => [trim(item.id), item]));
  const report = { ok: true, dryRun, remoteOnlyCount: remoteOnly.length, runnableCount: runnable.length, validUpdated: 0, failedUpdated: 0, skipped: [] };
  const ensuredTables = new Set();

  for (const suspect of remoteOnly) {
    const tableId = trim(suspect.feishuTableId);
    const recordId = trim(suspect.recordId);
    if (!tableId || !recordId) {
      report.skipped.push({ localId: trim(suspect.localId), company: trim(suspect.company), reason: 'missing_table_or_record_id' });
      continue;
    }
    const tableKey = `${baseToken}::${tableId}`;
    if (!dryRun && !ensuredTables.has(tableKey)) {
      ensureSyncFields({ baseToken, tableId, identity });
      ensuredTables.add(tableKey);
    }
    const localId = trim(suspect.localId || suspect.id);
    const record = recordById.get(localId);
    const fields = record ? fieldsFromRecord(record) : fieldsFromFailure(suspect, skippedById.get(localId)?.reason || 'missing_product_or_url');
    if (!dryRun) {
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
        JSON.stringify(fields),
      ]);
    }
    if (record) report.validUpdated += 1;
    else report.failedUpdated += 1;
  }

  const reportPath = path.join(runtimeDir, `feishu-remote-only-responsibility-refill-report-${timestampForFile()}.json`);
  writeJson(reportPath, report);
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}

main();
