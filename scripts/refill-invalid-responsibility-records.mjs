import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const backupDir = path.join(runtimeDir, 'backups');
const statePathDefault = path.join(runtimeDir, 'state.json');
const crawlerPath = path.join(projectRoot, 'server', 'scrapling-policy-crawler.py');
const scraplingPython = process.env.SCRAPLING_PYTHON_BIN || '/Users/wenshuping/Documents/Scrapling/.venv/bin/python';
const scraplingCwd = process.env.SCRAPLING_PROJECT_DIR || '/Users/wenshuping/Documents/Scrapling';
const outputMarker = '__POLICY_KNOWLEDGE_JSON__';

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
  return Number.isFinite(value) && value >= 0 ? value : fallback;
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

function selectedSeverities() {
  return new Set(
    trim(readArg('severity', 'high,medium'))
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function selectedCurrentStatuses() {
  const values = trim(readArg('current-status', 'invalid_responsibility'))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item === 'blank' || item === '__blank__' ? '' : item));
  return new Set(values);
}

function normalizeSuspects(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.suspects)) return raw.suspects;
  if (Array.isArray(raw?.records)) return raw.records;
  return [];
}

function runCrawler(records, options) {
  const mode = trim(options.crawlerMode) || 'reextract_responsibility_records';
  const payload =
    mode === 'ping_an_browser_catalog_materials'
      ? {
          mode,
          company: options.company || '中国平安',
          cdpUrl: options.cdpUrl,
          delayMs: options.delayMs,
          pdfRetryCount: options.pdfRetryCount,
          pdfRetryDelayMs: options.pdfRetryDelayMs,
          tasks: records,
        }
      : {
          mode,
          maxWorkers: options.maxWorkers,
          records,
        };
  const result = spawnSync(scraplingPython, [crawlerPath], {
    cwd: scraplingCwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 280 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
    timeout: options.timeoutMs || undefined,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`保险责任重新抽取失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`保险责任重新抽取没有返回结果\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

function runCrawlerSingleSafe(record, options) {
  try {
    return runCrawler([record], { ...options, maxWorkers: 1, timeoutMs: options.recordTimeoutMs });
  } catch (error) {
    return {
      ok: true,
      taskCount: 1,
      recordCount: 0,
      skippedCount: 1,
      records: [],
      skipped: [
        {
          id: trim(record.id),
          productName: trim(record.productName),
          url: trim(record.url),
          reason: error?.code === 'ETIMEDOUT' ? 'timeout' : `process_failed:${trim(error?.message) || 'unknown'}`,
        },
      ],
    };
  }
}

function taskFromRecord(record) {
  return {
    id: trim(record.id),
    company: trim(record.company),
    productName: trim(record.productName),
    productType: trim(record.productType),
    salesStatus: trim(record.salesStatus),
    title: trim(record.title),
    url: trim(record.url),
    sourcePage: trim(record.sourcePage),
    materialType: trim(record.materialType || record.sourceType),
    officialDomain: trim(record.officialDomain),
  };
}

function main() {
  const statePath = path.resolve(readArg('state-path', process.env.POLICY_OCR_APP_STATE_PATH || statePathDefault));
  const suspectsPath = path.resolve(readArg('suspects-path', path.join(runtimeDir, 'responsibility-quality-suspects-pingan.json')));
  const company = trim(readArg('company', '中国平安'));
  const severities = selectedSeverities();
  const currentStatuses = selectedCurrentStatuses();
  const offset = readNumberArg('offset', 0);
  const limit = readNumberArg('limit', 0);
  const batchSize = readNumberArg('batch-size', 25) || 25;
  const maxWorkers = readNumberArg('max-workers', 3) || 3;
  const crawlerMode = trim(readArg('crawler-mode', 'reextract_responsibility_records'));
  const cdpUrl = trim(readArg('cdp-url', process.env.PING_AN_CDP_URL || 'http://127.0.0.1:9223'));
  const delayMs = readNumberArg('delay-ms', Number(process.env.PING_AN_REFILL_DELAY_MS || 0));
  const pdfRetryCount = readNumberArg('pdf-retry-count', Number(process.env.PING_AN_REFILL_PDF_RETRY_COUNT || 2));
  const pdfRetryDelayMs = readNumberArg('pdf-retry-delay-ms', Number(process.env.PING_AN_REFILL_PDF_RETRY_DELAY_MS || 4000));
  const dryRun = process.argv.includes('--dry-run');
  const flushEachBatch = process.argv.includes('--flush-each-batch');
  const skipReextractFailed = process.argv.includes('--skip-reextract-failed');
  const batchTimeoutMs = readNumberArg('batch-timeout-ms', Number(process.env.RESPONSIBILITY_REFILL_BATCH_TIMEOUT_MS || 0));
  const recordTimeoutMs = readNumberArg('record-timeout-ms', Number(process.env.RESPONSIBILITY_REFILL_RECORD_TIMEOUT_MS || 0));
  const fallbackSingleTimeoutMs = readNumberArg(
    'fallback-single-timeout-ms',
    Number(process.env.RESPONSIBILITY_REFILL_FALLBACK_SINGLE_TIMEOUT_MS || recordTimeoutMs || 0),
  );
  const now = new Date().toISOString();
  const stamp = timestampForFile();

  const state = readJson(statePath, {});
  if (!Array.isArray(state.knowledgeRecords)) {
    throw new Error(`未找到 knowledgeRecords：${statePath}`);
  }
  const suspects = normalizeSuspects(readJson(suspectsPath, []));
  const targetIds = new Set(
    suspects
      .filter((item) => severities.has(trim(item.severity)))
      .filter((item) => !company || trim(item.company) === company || trim(item.feishuTableName) === company)
      .map((item) => trim(item.id || item.localId))
      .filter(Boolean),
  );

  const allTargets = state.knowledgeRecords
    .filter((record) => targetIds.has(trim(record.id)))
    .filter((record) => !company || trim(record.company) === company)
    .filter((record) => currentStatuses.has(trim(record.qualityStatus)))
    .filter((record) => !skipReextractFailed || !trim(record.qualityReason).startsWith('reextract_failed:'))
    .filter((record) => trim(record.url) && trim(record.productName));
  const selected = limit ? allTargets.slice(offset, offset + limit) : allTargets.slice(offset);
  const tasks = selected.map(taskFromRecord);
  const tasksPath = path.join(runtimeDir, `responsibility-refill-tasks-${stamp}.json`);
  writeJson(tasksPath, {
    statePath,
    suspectsPath,
    company,
    severity: [...severities],
    currentStatus: [...currentStatuses],
    offset,
    limit,
    targetCount: allTargets.length,
    selectedCount: selected.length,
    crawlerMode,
    tasks,
  });

  if (dryRun || !selected.length) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun,
          targetCount: allTargets.length,
          selectedCount: selected.length,
          tasksPath,
        },
        null,
        2,
      ),
    );
    return;
  }

  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `state-before-responsibility-refill-${stamp}.json`);
  fs.copyFileSync(statePath, backupPath);
  const reportPath = path.join(runtimeDir, `responsibility-refill-report-${stamp}.json`);

  const recordById = new Map(state.knowledgeRecords.map((record) => [trim(record.id), record]));
  const recordByUrl = new Map(state.knowledgeRecords.map((record) => [trim(record.url), record]));
  const refilled = [];
  const failed = [];
  for (let index = 0; index < tasks.length; index += batchSize) {
    const batch = tasks.slice(index, index + batchSize);
    const baseCrawlerOptions = {
      crawlerMode,
      company,
      maxWorkers,
      cdpUrl,
      delayMs,
      pdfRetryCount,
      pdfRetryDelayMs,
      recordTimeoutMs,
    };
    let result;
    if (recordTimeoutMs) {
      result = batch.reduce(
        (merged, task) => {
          const itemResult = runCrawlerSingleSafe(task, baseCrawlerOptions);
          merged.records.push(...(Array.isArray(itemResult.records) ? itemResult.records : []));
          merged.skipped.push(...(Array.isArray(itemResult.skipped) ? itemResult.skipped : []));
          return merged;
        },
        { ok: true, records: [], skipped: [] },
      );
    } else {
      try {
        result = runCrawler(batch, { ...baseCrawlerOptions, timeoutMs: batchTimeoutMs });
      } catch (error) {
        if (!fallbackSingleTimeoutMs) throw error;
        console.warn(
          `[refill] 批次 ${index + 1}-${index + batch.length} 失败，降级单条重试：${
            error?.code === 'ETIMEDOUT' ? 'timeout' : trim(error?.message).split('\n')[0] || 'unknown'
          }`,
        );
        result = batch.reduce(
          (merged, task) => {
            const itemResult = runCrawlerSingleSafe(task, {
              ...baseCrawlerOptions,
              recordTimeoutMs: fallbackSingleTimeoutMs,
            });
            merged.records.push(...(Array.isArray(itemResult.records) ? itemResult.records : []));
            merged.skipped.push(...(Array.isArray(itemResult.skipped) ? itemResult.skipped : []));
            return merged;
          },
          { ok: true, records: [], skipped: [] },
        );
      }
    }
    for (const item of Array.isArray(result.records) ? result.records : []) {
      const record = recordById.get(trim(item.id)) || recordByUrl.get(trim(item.url));
      if (!record || !trim(item.pageText)) continue;
      record.pageText = trim(item.pageText);
      record.snippet = trim(item.snippet) || '官网资料，已重新抽取保险责任正文段。';
      record.parser = trim(item.parser) || 'scrapling_responsibility_refill';
      record.materialType = trim(item.materialType) || trim(record.materialType);
      record.officialDomain = trim(item.officialDomain) || trim(record.officialDomain);
      record.qualityStatus = 'valid_responsibility_refilled';
      record.qualityReason = '';
      record.refilledAt = now;
      record.lastFetchedAt = now;
      record.updatedAt = now;
      if (Number(item.pages)) record.pages = item.pages;
      if (Number(item.bytes)) record.bytes = item.bytes;
      refilled.push({
        id: trim(record.id),
        productName: trim(record.productName),
        url: trim(record.url),
        pageTextLength: trim(record.pageText).length,
        preview: trim(record.pageText).slice(0, 220),
      });
    }
    for (const item of Array.isArray(result.skipped) ? result.skipped : []) {
      const record = recordById.get(trim(item.id)) || recordByUrl.get(trim(item.url));
      if (record) {
        record.qualityStatus = 'invalid_responsibility';
        record.qualityReason = `reextract_failed:${trim(item.reason) || 'unknown'}`;
        record.pageText = '';
        record.updatedAt = now;
      }
      failed.push(item);
    }
    console.log(`[refill] 进度 ${Math.min(index + batch.length, tasks.length)}/${tasks.length}，成功 ${refilled.length}，失败 ${failed.length}`);
    if (flushEachBatch) {
      writeJson(statePath, state);
      writeJson(reportPath, {
        ok: true,
        partial: index + batch.length < tasks.length,
        statePath,
        suspectsPath,
        backupPath,
        tasksPath,
        company,
        severity: [...severities],
        currentStatus: [...currentStatuses],
        offset,
        limit,
        batchSize,
        maxWorkers,
        batchTimeoutMs,
        fallbackSingleTimeoutMs,
        crawlerMode,
        cdpUrl: crawlerMode === 'ping_an_browser_catalog_materials' ? cdpUrl : '',
        delayMs: crawlerMode === 'ping_an_browser_catalog_materials' ? delayMs : 0,
        pdfRetryCount: crawlerMode === 'ping_an_browser_catalog_materials' ? pdfRetryCount : 0,
        pdfRetryDelayMs: crawlerMode === 'ping_an_browser_catalog_materials' ? pdfRetryDelayMs : 0,
        targetCount: allTargets.length,
        selectedCount: selected.length,
        processedCount: Math.min(index + batch.length, tasks.length),
        refilledCount: refilled.length,
        failedCount: failed.length,
        refilled,
        failed,
      });
    }
  }

  writeJson(statePath, state);
  const report = {
    ok: true,
    statePath,
    suspectsPath,
    backupPath,
    tasksPath,
    company,
    severity: [...severities],
    currentStatus: [...currentStatuses],
    offset,
    limit,
    batchSize,
    maxWorkers,
    batchTimeoutMs,
    fallbackSingleTimeoutMs,
    crawlerMode,
    cdpUrl: crawlerMode === 'ping_an_browser_catalog_materials' ? cdpUrl : '',
    delayMs: crawlerMode === 'ping_an_browser_catalog_materials' ? delayMs : 0,
    pdfRetryCount: crawlerMode === 'ping_an_browser_catalog_materials' ? pdfRetryCount : 0,
    pdfRetryDelayMs: crawlerMode === 'ping_an_browser_catalog_materials' ? pdfRetryDelayMs : 0,
    targetCount: allTargets.length,
    selectedCount: selected.length,
    refilledCount: refilled.length,
    failedCount: failed.length,
    refilled,
    failed,
  };
  writeJson(reportPath, report);
  console.log(
    JSON.stringify(
      {
        ok: true,
        targetCount: allTargets.length,
        selectedCount: selected.length,
        refilledCount: refilled.length,
        failedCount: failed.length,
        backupPath,
        tasksPath,
        reportPath,
      },
      null,
      2,
    ),
  );
}

main();
