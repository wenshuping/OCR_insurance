import fs from 'node:fs';
import path from 'node:path';

import { createKnowledgeStateStore } from './runtime-knowledge-state.mjs';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);
const runtimeDir = path.join(projectRoot, '.runtime');
const backupDir = path.join(runtimeDir, 'backups');
const defaultDbPath = path.join(runtimeDir, 'policy-ocr.sqlite');
const defaultSeedStatePath = path.join(runtimeDir, 'state.json');

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

function trim(value) {
  return String(value || '').trim();
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

async function main() {
  const dbPath = path.resolve(readArg('db-path', process.env.POLICY_OCR_APP_DB_PATH || defaultDbPath));
  const seedStatePath = path.resolve(readArg('state-path', process.env.POLICY_OCR_APP_STATE_PATH || defaultSeedStatePath));
  const suspectsPath = path.resolve(readArg('suspects-path', path.join(runtimeDir, 'responsibility-quality-suspects-no-pingan.json')));
  const severities = selectedSeverities();
  const companyFilter = String(readArg('company', '')).trim();
  const knowledgeStore = await createKnowledgeStateStore({ dbPath, seedStatePath });
  try {
    const state = knowledgeStore.loadState();
    if (!Array.isArray(state.knowledgeRecords)) {
      throw new Error(`未找到 knowledgeRecords：${dbPath}`);
    }
    const suspects = readJson(suspectsPath, []);
    const targetById = new Map(
      suspects
        .filter((item) => severities.has(item.severity))
        .filter((item) => !companyFilter || item.company === companyFilter || item.feishuTableName === companyFilter)
        .map((item) => [String(item.id), item]),
    );

    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `knowledge-before-responsibility-invalid-mark-${stamp}.json`);
    writeJson(backupPath, state.knowledgeRecords);

    const now = new Date().toISOString();
    const changedRows = [];
    const byCompany = {};
    for (const record of state.knowledgeRecords) {
      const suspect = targetById.get(String(record.id));
      if (!suspect) continue;
      record.qualityStatus = 'invalid_responsibility';
      record.qualityReason = suspect.reasons || '疑似非保险责任正文';
      record.invalidatedAt = now;
      record.pageText = '';
      record.updatedAt = now;
      changedRows.push(record);
      byCompany[record.company || '未知'] = (byCompany[record.company || '未知'] || 0) + 1;
    }

    if (changedRows.length) {
      knowledgeStore.upsertRows(changedRows, { nextId: state.nextId });
    }

    const report = {
      ok: true,
      dbPath,
      backupPath,
      changed: changedRows.length,
      severity: [...severities],
      byCompany: Object.entries(byCompany).sort((a, b) => b[1] - a[1]),
    };
    writeJson(path.join(runtimeDir, 'responsibility-invalid-mark-report.json'), report);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    knowledgeStore.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
