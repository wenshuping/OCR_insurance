import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createKnowledgeStateStore } from './runtime-knowledge-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const reportDir = path.join(runtimeDir, 'daily-refresh-reports');

const COMPANY_JOBS = {
  'china-life': {
    company: '中国人寿',
    script: 'crawl:china-life-knowledge',
    args: ['--sale-type=1', '--start-page=1', '--max-pages=1', '--page-size=15'],
    configPath: '.runtime/feishu-knowledge-china-life.json',
    tableName: '中国人寿',
  },
  'picc-life': {
    company: '人保寿险',
    script: 'crawl:picc-life-knowledge',
    args: ['--sale-status=in_sale', '--start-page=1', '--max-pages=1', '--max-page-workers=1', '--max-workers=4'],
    configPath: '.runtime/feishu-knowledge-picc-life.json',
    tableName: '人保寿险',
  },
  'cpic-life': {
    company: '太保寿险',
    script: 'crawl:cpic-life-knowledge',
    args: ['--max-products=25', '--max-workers=4'],
    configPath: '.runtime/feishu-knowledge-cpic-life.json',
    tableName: '太保寿险',
  },
  taikang: {
    company: '泰康人寿',
    script: 'crawl:taikang-knowledge',
    args: ['--sale-status=all', '--max-products=50', '--max-workers=4'],
    configPath: '.runtime/feishu-knowledge-taikang.json',
    tableName: '泰康',
  },
};

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
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

function runCommand(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (result.status !== 0 && !allowFailure) {
    const rendered = [command, ...args].join(' ');
    throw new Error(`${rendered} failed with code ${result.status}\n${output}`);
  }
  return { status: result.status, output };
}

function parseSyncPlan(output) {
  const text = String(output || '');
  const marker = '待同步计划如下：';
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const jsonStart = text.indexOf('{', start);
  if (jsonStart < 0) return null;
  try {
    return JSON.parse(text.slice(jsonStart));
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
  const companiesArg = readArg('companies', 'china-life,picc-life,cpic-life,taikang');
  const preflightOnly = hasFlag('preflight-only');
  const skipFeishu = hasFlag('skip-feishu');
  const jobKeys = companiesArg.split(',').map((item) => item.trim()).filter(Boolean);
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

  for (const key of jobKeys) {
    const job = COMPANY_JOBS[key];
    if (!job) {
      report.failures.push({ company: key, stage: 'config', message: 'unknown company key' });
      continue;
    }
    const before = await loadStateSummary();
    const beforeCompanyMaxId = before.byCompany[job.company]?.maxId || 0;
    const item = { key, company: job.company, status: 'started', beforeMaxId: beforeCompanyMaxId };
    report.jobs.push(item);
    try {
      const crawl = runCommand('npm', ['run', job.script, '--', ...job.args]);
      item.crawlOutputTail = crawl.output.slice(-4000);
      const after = await loadStateSummary();
      const newRows = after.rows.filter((row) => row.company === job.company && Number(row.id) > beforeCompanyMaxId);
      item.status = 'crawled';
      item.newRecordCount = newRows.length;
      item.newMinId = newRows.map((row) => Number(row.id)).filter(Number.isFinite).sort((a, b) => a - b)[0] || null;
      item.newMaxId = newRows.map((row) => Number(row.id)).filter(Number.isFinite).sort((a, b) => a - b).at(-1) || null;
      item.responsibilityQuality = summarizeQuality(newRows);
      if (!newRows.length || skipFeishu) continue;

      const syncBaseArgs = [
        'run',
        'sync:feishu-knowledge',
        '--',
        `--company=${job.company}`,
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
      break;
    }
  }

  const final = await loadStateSummary();
  report.final = { knowledgeRecordsAfter: final.total, maxIdAfter: final.maxId };
  report.status = report.failures.length ? 'completed_with_failures' : 'completed';
  writeJson(path.join(reportDir, `${stamp}-report.json`), report);
  fs.writeFileSync(path.join(reportDir, `${stamp}-report.md`), `${markdownReport(report)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
