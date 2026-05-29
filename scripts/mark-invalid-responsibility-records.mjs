import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);
const statePath = path.join(projectRoot, '.runtime', 'state.json');
const backupDir = path.join(projectRoot, '.runtime', 'backups');

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

const state = readJson(statePath, {});
const suspectsPath = path.resolve(readArg('suspects-path', path.join(projectRoot, '.runtime', 'responsibility-quality-suspects-no-pingan.json')));
const suspects = readJson(suspectsPath, []);
const severities = selectedSeverities();
const companyFilter = String(readArg('company', '')).trim();
const targetById = new Map(
  suspects
    .filter((item) => severities.has(item.severity))
    .filter((item) => !companyFilter || item.company === companyFilter || item.feishuTableName === companyFilter)
    .map((item) => [String(item.id), item]),
);

if (!Array.isArray(state.knowledgeRecords)) {
  throw new Error(`未找到 knowledgeRecords：${statePath}`);
}

fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `state-before-responsibility-invalid-mark-${stamp}.json`);
fs.copyFileSync(statePath, backupPath);

const now = new Date().toISOString();
let changed = 0;
const byCompany = {};
for (const record of state.knowledgeRecords) {
  const suspect = targetById.get(String(record.id));
  if (!suspect) continue;
  record.qualityStatus = 'invalid_responsibility';
  record.qualityReason = suspect.reasons || '疑似非保险责任正文';
  record.invalidatedAt = now;
  record.pageText = '';
  record.updatedAt = now;
  changed += 1;
  byCompany[record.company || '未知'] = (byCompany[record.company || '未知'] || 0) + 1;
}

writeJson(statePath, state);
const report = {
  ok: true,
  statePath,
  backupPath,
  changed,
  severity: [...severities],
  byCompany: Object.entries(byCompany).sort((a, b) => b[1] - a[1]),
};
writeJson(path.join(projectRoot, '.runtime', 'responsibility-invalid-mark-report.json'), report);
console.log(JSON.stringify(report, null, 2));
