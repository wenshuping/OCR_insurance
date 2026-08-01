import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createKnowledgeStateStore } from './runtime-knowledge-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const reportDir = path.join(runtimeDir, 'daily-refresh-reports');
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_JOB_ARGS = ['--sale-status=all', '--max-products=50', '--max-pages=1', '--max-workers=4'];
const JOB_OVERRIDES = {
  'new-china': {
    company: '新华保险',
    args: ['--start-page=1', '--max-pages=1', '--max-products-per-page=25'],
    configPath: '.runtime/feishu-knowledge-haibao-life.json',
  },
  'china-life': {
    company: '中国人寿',
    args: ['--sale-type=1', '--start-page=1', '--max-pages=1', '--page-size=15'],
  },
  'picc-life': {
    company: '人保寿险',
    args: ['--sale-status=in_sale', '--start-page=1', '--max-pages=1', '--max-page-workers=1', '--max-workers=4'],
  },
  'cpic-life': {
    company: '太保寿险',
    args: ['--max-products=25', '--max-workers=4'],
  },
  taikang: {
    company: '泰康人寿',
    args: ['--sale-status=all', '--max-products=50', '--max-workers=4'],
  },
  'ping-an': {
    company: '中国平安',
    scriptFile: 'crawl-ping-an-cloak-knowledge.mjs',
    args: ['--sale-type=Y', '--max-products=50', '--max-workers=3'],
  },
  'cathay-life': {
    company: '陆家嘴国泰人寿',
    scriptFile: 'crawl-cathay-life-cloak-knowledge.mjs',
    args: ['--source=all', '--sale-status=all', '--max-products=50', '--max-workers=3'],
  },
  'china-post-life': { company: '中邮人寿', timeoutMs: 5 * 60 * 1000 },
  'haibao-life': { company: '海保人寿', configPath: null },
  'aixin-life': { company: '爱心人寿', configPath: null },
  'foresea-life': { company: '前海人寿', configPath: null },
  'shanghai-life': { company: '上海人寿', configPath: null },
  'three-gorges-life': { company: '三峡人寿', configPath: null },
};

function loadFeishuTableName(configPath) {
  if (!configPath || !fs.existsSync(path.join(projectRoot, configPath))) return '';
  try {
    const config = JSON.parse(fs.readFileSync(path.join(projectRoot, configPath), 'utf8'));
    return String(config.tableName || '').trim();
  } catch {
    return '';
  }
}

export function discoverCompanyJobs({ scriptsDir = __dirname } = {}) {
  return fs.readdirSync(scriptsDir)
    .map((fileName) => ({ fileName, match: fileName.match(/^crawl-(.+)-knowledge\.mjs$/u) }))
    .filter(({ match }) => match && !match[1].endsWith('-cloak') && !match[1].endsWith('-missing'))
    .map(({ fileName, match }) => {
      const key = match[1];
      const override = JOB_OVERRIDES[key] || {};
      const configPath = Object.hasOwn(override, 'configPath')
        ? override.configPath
        : `.runtime/feishu-knowledge-${key}.json`;
      const tableName = loadFeishuTableName(configPath);
      return {
        key,
        company: override.company || tableName || key,
        scriptFile: override.scriptFile || fileName,
        args: override.args || DEFAULT_JOB_ARGS,
        configPath,
        tableName,
        timeoutMs: override.timeoutMs,
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

export function selectCompanyJobs(allJobs, {
  companies = '',
  allCompanies = false,
  batchSize = DEFAULT_BATCH_SIZE,
  date = new Date().toISOString().slice(0, 10),
} = {}) {
  const requestedKeys = companies.split(',').map((item) => item.trim()).filter(Boolean);
  if (requestedKeys.length) {
    const jobsByKey = new Map(allJobs.map((job) => [job.key, job]));
    const unknownKeys = requestedKeys.filter((key) => !jobsByKey.has(key));
    if (unknownKeys.length) throw new Error(`unknown company key: ${unknownKeys.join(', ')}`);
    return {
      mode: 'explicit',
      jobs: requestedKeys.map((key) => jobsByKey.get(key)),
      availableCount: allJobs.length,
      batchIndex: null,
      batchCount: null,
    };
  }

  if (allCompanies || allJobs.length <= batchSize) {
    return { mode: 'all', jobs: allJobs, availableCount: allJobs.length, batchIndex: 0, batchCount: 1 };
  }

  const safeBatchSize = Math.max(1, Math.floor(Number(batchSize) || DEFAULT_BATCH_SIZE));
  const batchCount = Math.ceil(allJobs.length / safeBatchSize);
  const dayNumber = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
  const batchIndex = ((dayNumber % batchCount) + batchCount) % batchCount;
  return {
    mode: 'rotation',
    jobs: allJobs.slice(batchIndex * safeBatchSize, (batchIndex + 1) * safeBatchSize),
    availableCount: allJobs.length,
    batchIndex,
    batchCount,
  };
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readPositiveNumberArg(name, fallback) {
  const value = Number(readArg(name, ''));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function loadStateSummary() {
  const knowledgeStore = await createKnowledgeStateStore({
    dbPath: process.env.POLICY_OCR_APP_DB_PATH || path.join(runtimeDir, 'policy-ocr.sqlite'),
    seedStatePath: process.env.POLICY_OCR_APP_STATE_PATH || path.join(runtimeDir, 'state.json'),
  });
  try {
    const state = knowledgeStore.loadState();
    const rows = Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords : [];
    const ids = rows.map((row) => Number(row.id)).filter(Number.isFinite).sort((left, right) => left - right);
    const byCompany = {};
    for (const row of rows) {
      const company = String(row.company || '未知').trim() || '未知';
      const item = (byCompany[company] ||= { count: 0, maxId: 0 });
      item.count += 1;
      item.maxId = Math.max(item.maxId, Number(row.id) || 0);
    }
    return {
      rows,
      total: rows.length,
      maxId: ids.at(-1) || 0,
      companyCount: Object.keys(byCompany).length,
      byCompany,
      dbPath: knowledgeStore.dbPath,
    };
  } finally {
    knowledgeStore.close();
  }
}

function runCommand(command, args, { allowFailure = false, timeoutMs } = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
    ...(timeoutMs ? { timeout: timeoutMs, killSignal: 'SIGTERM' } : {}),
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms\n${output}`);
  }
  if (result.status !== 0 && !allowFailure) {
    const rendered = [command, ...args].join(' ');
    throw new Error(`${rendered} failed with code ${result.status}\n${output}`);
  }
  return { status: result.status, output };
}

export function parseSyncPlan(output) {
  const text = String(output || '');
  const marker = '待同步计划如下：';
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const jsonStart = text.indexOf('{', start);
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd < jsonStart) return null;
  try {
    return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  } catch {
    return null;
  }
}

function summarizeQuality(rows) {
  return rows.reduce((acc, row) => {
    const key = row.responsibilityQualityStatus || row.qualityStatus || (String(row.pageText || '').trim() ? 'unclassified_nonempty' : 'invalid_empty');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function markdownReport(report) {
  return [
    `日期: ${report.date}`,
    `运行目录: ${projectRoot}`,
    `状态: ${report.status}`,
    '',
    `本地知识库: ${report.preflight.knowledgeRecordsBefore} -> ${report.final.knowledgeRecordsAfter}`,
    `maxId: ${report.preflight.maxIdBefore} -> ${report.final.maxIdAfter}`,
    `批次: ${report.selection.mode}, ${report.selection.selectedCount}/${report.selection.availableCount}`,
    '',
    '公司:',
    ...report.jobs.map((job) => `- ${job.company}: ${job.status}, 新增 ${job.newRecordCount || 0}, 飞书写入 ${job.feishu?.writtenCount || 0}`),
    '',
    '失败:',
    ...(report.failures.length ? report.failures.map((failure) => `- ${failure.company || 'unknown'}: ${failure.stage} ${failure.message}`) : ['- 无']),
  ].join('\n');
}

async function main() {
  fs.mkdirSync(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const companiesArg = readArg('companies', '');
  const refreshDate = readArg('date', new Date().toISOString().slice(0, 10));
  const allJobs = discoverCompanyJobs();
  const selection = selectCompanyJobs(allJobs, {
    companies: companiesArg,
    allCompanies: hasFlag('all-companies'),
    batchSize: readPositiveNumberArg('batch-size', DEFAULT_BATCH_SIZE),
    date: refreshDate,
  });
  if (hasFlag('plan-only')) {
    console.log(JSON.stringify({
      date: refreshDate,
      mode: selection.mode,
      availableCount: selection.availableCount,
      selectedCount: selection.jobs.length,
      batchIndex: selection.batchIndex,
      batchCount: selection.batchCount,
      jobs: selection.jobs.map(({ key, company, scriptFile, configPath, tableName }) => ({ key, company, scriptFile, configPath, tableName })),
    }, null, 2));
    return;
  }
  const preflightOnly = hasFlag('preflight-only');
  const skipFeishu = hasFlag('skip-feishu');
  const preflight = await loadStateSummary();
  const report = {
    createdAt: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    status: preflightOnly ? 'preflight_only' : 'running',
    preflight: {
      dbPath: preflight.dbPath,
      knowledgeRecordsBefore: preflight.total,
      maxIdBefore: preflight.maxId,
      companyCount: preflight.companyCount,
    },
    final: {},
    selection: {
      mode: selection.mode,
      availableCount: selection.availableCount,
      selectedCount: selection.jobs.length,
      batchIndex: selection.batchIndex,
      batchCount: selection.batchCount,
      selectedKeys: selection.jobs.map((job) => job.key),
    },
    jobs: [],
    failures: [],
  };

  writeJson(path.join(reportDir, `${stamp}-preflight.json`), report);
  if (preflightOnly) {
    const final = await loadStateSummary();
    report.final = { knowledgeRecordsAfter: final.total, maxIdAfter: final.maxId };
    report.status = 'preflight_ok';
    writeJson(path.join(reportDir, `${stamp}-report.json`), report);
    fs.writeFileSync(path.join(reportDir, `${stamp}-report.md`), `${markdownReport(report)}\n`);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  for (const job of selection.jobs) {
    const key = job.key;
    const before = await loadStateSummary();
    const beforeIds = new Set(before.rows.map((row) => Number(row.id)).filter(Number.isFinite));
    const item = { key, company: job.company, status: 'started' };
    report.jobs.push(item);
    try {
      const crawl = runCommand('node', [path.join(__dirname, job.scriptFile), ...job.args], { timeoutMs: job.timeoutMs || 10 * 60 * 1000 });
      item.crawlOutputTail = crawl.output.slice(-4000);
      const after = await loadStateSummary();
      const newRows = after.rows.filter((row) => Number.isFinite(Number(row.id)) && !beforeIds.has(Number(row.id)));
      const newCompanies = [...new Set(newRows.map((row) => String(row.company || '').trim()).filter(Boolean))];
      item.status = 'crawled';
      item.newRecordCount = newRows.length;
      item.newCompanies = newCompanies;
      item.newMinId = newRows.map((row) => Number(row.id)).filter(Number.isFinite).sort((a, b) => a - b)[0] || null;
      item.newMaxId = newRows.map((row) => Number(row.id)).filter(Number.isFinite).sort((a, b) => a - b).at(-1) || null;
      item.responsibilityQuality = summarizeQuality(newRows);
      if (!newRows.length || skipFeishu) continue;

      if (!job.configPath || !job.tableName) {
        item.status = 'blocked_feishu_config';
        report.failures.push({ company: job.company, stage: 'feishu_config', message: 'missing Feishu table config' });
        continue;
      }
      if (newCompanies.length !== 1) {
        item.status = 'blocked_company_resolution';
        report.failures.push({ company: job.company, stage: 'company_resolution', message: `expected one company, got ${newCompanies.join(', ') || 'none'}` });
        continue;
      }

      const syncBaseArgs = [
        'run',
        'sync:feishu-knowledge',
        '--',
        `--company=${newCompanies[0]}`,
        `--config-path=${job.configPath}`,
        `--table-name=${job.tableName}`,
        `--local-id-min=${item.newMinId}`,
        '--create-only',
        '--skip-existing-local-ids',
        '--batch-size=10',
      ];
      const dryRun = runCommand('npm', [...syncBaseArgs, '--dry-run']);
      const plan = parseSyncPlan(dryRun.output);
      item.feishu = { dryRunPlan: plan, writtenCount: 0 };
      if (!plan || plan.duplicateKeyCount !== 0) {
        item.status = 'blocked_feishu_dry_run';
        report.failures.push({ company: job.company, stage: 'feishu_dry_run', message: 'dry-run plan missing or duplicateKeyCount not zero' });
        continue;
      }
      const written = runCommand('npm', syncBaseArgs);
      item.feishu.writtenOutputTail = written.output.slice(-2000);
      item.feishu.writtenCount = plan.count || 0;
      item.status = 'synced';
    } catch (error) {
      item.status = 'failed';
      item.error = String(error?.message || error).slice(0, 8000);
      report.failures.push({ company: job.company, stage: item.status, message: item.error.slice(0, 1000) });
    }
  }

  const final = await loadStateSummary();
  report.final = { knowledgeRecordsAfter: final.total, maxIdAfter: final.maxId };
  report.status = report.failures.length ? 'completed_with_failures' : 'completed';
  writeJson(path.join(reportDir, `${stamp}-report.json`), report);
  fs.writeFileSync(path.join(reportDir, `${stamp}-report.md`), `${markdownReport(report)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
