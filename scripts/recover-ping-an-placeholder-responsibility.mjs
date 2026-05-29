import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const crawlerPath = path.join(projectRoot, 'server', 'scrapling-policy-crawler.py');
const scraplingPython = process.env.SCRAPLING_PYTHON_BIN || '/Users/wenshuping/Documents/Scrapling/.venv/bin/python';
const scraplingCwd = process.env.SCRAPLING_PROJECT_DIR || '/Users/wenshuping/Documents/Scrapling';
const outputMarker = '__POLICY_KNOWLEDGE_JSON__';
const baseToken = process.env.FEISHU_KNOWLEDGE_BASE_TOKEN || 'IR6Tb9RoEaXb1tsunNzcfKIxnrd';
const tableId = process.env.FEISHU_PING_AN_TABLE_ID || 'tbl9Kl6PjPEHn6bu';

function trim(value) {
  return String(value || '').trim();
}

function timestampForFile() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\..+$/u, '').replace('T', '-');
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function readNumberArg(name, fallback = 0) {
  const value = Number(readArg(name, ''));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
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

function runLark(args, { retries = 3 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const result = spawnSync('lark-cli', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 80 * 1024 * 1024,
    });
    if (result.status === 0) return parseCliJson(result.stdout);
    lastError = [
      `lark-cli ${args.join(' ')} 执行失败`,
      result.stdout?.trim(),
      result.stderr?.trim(),
    ]
      .filter(Boolean)
      .join('\n');
    if (attempt < retries && /timeout|timed out|i\/o timeout|temporarily|ECONNRESET|ETIMEDOUT|EOF|502|503|504|429|频率|限流/u.test(lastError)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(60000, attempt * 3000));
      continue;
    }
    break;
  }
  throw new Error(lastError || `lark-cli ${args.join(' ')} 执行失败`);
}

function isPlaceholderText(text) {
  return /未抽取保险责任正文|未提取保险责任正文|官网有资料标记|PDF不可用|暂无保险责任正文/u.test(trim(text));
}

function parsePingAnCatalogId(id) {
  const match = trim(id).match(/^catalog:ping_an_([YN])_(.+)_(.+)$/u);
  if (!match) return null;
  return {
    saleType: match[1],
    planCode: match[2],
    versionNo: match[3],
  };
}

function listPlaceholderRows() {
  const rows = [];
  const limit = 200;
  for (let offset = 0; ; offset += limit) {
    const payload = runLark([
      'base',
      '+record-list',
      '--as',
      'user',
      '--base-token',
      baseToken,
      '--table-id',
      tableId,
      '--field-id',
      '本地ID',
      '--field-id',
      '产品名称',
      '--field-id',
      '产品分类',
      '--field-id',
      '销售状态',
      '--field-id',
      '资料类型',
      '--field-id',
      '标题',
      '--field-id',
      '来源链接',
      '--field-id',
      '保险责任正文',
      '--limit',
      String(limit),
      '--offset',
      String(offset),
      '--format',
      'json',
    ]);
    const chunk = payload?.data?.data || [];
    const recordIds = payload?.data?.record_id_list || [];
    for (const [index, row] of chunk.entries()) {
      const localId = trim(row?.[0]);
      const productName = trim(row?.[1]);
      const url = trim(row?.[6]);
      const text = trim(row?.[7]);
      if (!localId.startsWith('catalog:ping_an_') || !url || !isPlaceholderText(text)) continue;
      const parsed = parsePingAnCatalogId(localId);
      rows.push({
        remoteRecordId: recordIds[index],
        localId,
        productName,
        productType: trim(row?.[2]),
        salesStatus: trim(row?.[3]) || (parsed?.saleType === 'N' ? '停售' : '在售'),
        materialType: trim(row?.[4]) || 'terms',
        title: trim(row?.[5]) || `${productName}产品条款`,
        url,
        oldText: text,
        saleType: parsed?.saleType || '',
        planCode: parsed?.planCode || '',
        versionNo: parsed?.versionNo || '',
      });
    }
    if (chunk.length < limit) break;
  }
  return rows;
}

function runCrawler(tasks, { cdpUrl, delayMs, pdfRetryCount, pdfRetryDelayMs }) {
  const result = spawnSync(scraplingPython, [crawlerPath], {
    cwd: scraplingCwd,
    input: JSON.stringify({
      mode: 'ping_an_browser_catalog_materials',
      company: '中国平安',
      cdpUrl,
      delayMs,
      pdfRetryCount,
      pdfRetryDelayMs,
      tasks,
    }),
    encoding: 'utf8',
    maxBuffer: 260 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`平安占位正文恢复爬取失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`平安占位正文恢复没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

function limitText(value, max = 9000) {
  const text = trim(value).replace(/\r\n?/gu, '\n');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 18)}\n...已截断同步展示`;
}

function updateRemoteRow(task, record) {
  const now = new Date().toISOString();
  runLark(
    [
      'base',
      '+record-upsert',
      '--as',
      'user',
      '--base-token',
      baseToken,
      '--table-id',
      tableId,
      '--record-id',
      task.remoteRecordId,
      '--json',
      JSON.stringify({
        本地ID: task.localId,
        保险公司: '中国平安',
        产品名称: record.productName || task.productName,
        产品分类: record.productType || task.productType,
        销售状态: record.salesStatus || task.salesStatus,
        资料类型: record.materialType || task.materialType || 'terms',
        标题: record.title || task.title,
        官方域名: 'life.pingan.com',
        来源链接: record.url || task.url,
        摘要: '中国平安官网产品条款，已重新抽取保险责任正文段。',
        保险责任正文: limitText(record.pageText),
        解析器: 'scrapling_ping_an_placeholder_recovery',
        更新时间: now,
      }),
    ],
    { retries: 6 },
  );
}

function main() {
  const cdpUrl = readArg('cdp-url', process.env.PING_AN_CDP_URL || 'http://127.0.0.1:9223');
  const offset = readNumberArg('offset', Number(process.env.PING_AN_PLACEHOLDER_OFFSET || 0));
  const limit = readNumberArg('limit', Number(process.env.PING_AN_PLACEHOLDER_LIMIT || 20));
  const delayMs = readNumberArg('delay-ms', Number(process.env.PING_AN_PLACEHOLDER_DELAY_MS || 1200));
  const pdfRetryCount = readNumberArg('pdf-retry-count', Number(process.env.PING_AN_PLACEHOLDER_PDF_RETRY_COUNT || 2));
  const pdfRetryDelayMs = readNumberArg('pdf-retry-delay-ms', Number(process.env.PING_AN_PLACEHOLDER_PDF_RETRY_DELAY_MS || 4000));
  const dryRun = process.argv.includes('--dry-run');
  const ts = timestampForFile();

  const allRows = listPlaceholderRows();
  const selectedRows = limit ? allRows.slice(offset, offset + limit) : allRows.slice(offset);
  const tasks = selectedRows.map((row) => ({
    productName: row.productName,
    productType: row.productType,
    salesStatus: row.salesStatus,
    label: '产品条款',
    materialType: 'terms',
    url: row.url,
  }));
  const tasksPath = path.join(runtimeDir, `ping-an-placeholder-responsibility-tasks-${ts}.json`);
  writeJson(tasksPath, {
    baseToken,
    tableId,
    offset,
    limit,
    placeholderCount: allRows.length,
    selectedCount: selectedRows.length,
    rows: selectedRows,
  });

  if (dryRun || !selectedRows.length) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun,
          placeholderCount: allRows.length,
          selectedCount: selectedRows.length,
          tasksPath,
        },
        null,
        2,
      ),
    );
    return;
  }

  const crawlResult = runCrawler(tasks, { cdpUrl, delayMs, pdfRetryCount, pdfRetryDelayMs });
  if (crawlResult.ok === false) {
    console.log(JSON.stringify(crawlResult, null, 2));
    process.exitCode = 2;
    return;
  }

  const taskByUrl = new Map(selectedRows.map((task) => [task.url, task]));
  const updated = [];
  for (const record of Array.isArray(crawlResult.records) ? crawlResult.records : []) {
    const task = taskByUrl.get(trim(record.url));
    if (!task?.remoteRecordId || !trim(record.pageText)) continue;
    updateRemoteRow(task, record);
    updated.push({
      localId: task.localId,
      remoteRecordId: task.remoteRecordId,
      productName: record.productName || task.productName,
      url: record.url || task.url,
      pageTextPreview: trim(record.pageText).slice(0, 240),
    });
  }

  const reportPath = path.join(runtimeDir, `ping-an-placeholder-responsibility-recovery-${ts}.json`);
  writeJson(reportPath, {
    ok: true,
    baseToken,
    tableId,
    cdpUrl,
    offset,
    limit,
    delayMs,
    pdfRetryCount,
    pdfRetryDelayMs,
    placeholderCountBefore: allRows.length,
    selectedCount: selectedRows.length,
    crawledRecordCount: Array.isArray(crawlResult.records) ? crawlResult.records.length : 0,
    skippedCount: crawlResult.skippedCount || 0,
    skipped: crawlResult.skipped || [],
    updatedCount: updated.length,
    updated,
    tasksPath,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        placeholderCountBefore: allRows.length,
        selectedCount: selectedRows.length,
        crawledRecordCount: Array.isArray(crawlResult.records) ? crawlResult.records.length : 0,
        skippedCount: crawlResult.skippedCount || 0,
        updatedCount: updated.length,
        tasksPath,
        reportPath,
      },
      null,
      2,
    ),
  );
}

main();
