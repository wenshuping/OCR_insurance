import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const defaultProdDbPath = path.join(projectRoot, '.runtime', 'policy-ocr.sqlite');
const defaultDevDbPath = path.join(projectRoot, '.runtime', 'local', 'policy-ocr.sqlite');
const prodDbPath = path.resolve(process.env.POLICY_OCR_PROD_DB_PATH || defaultProdDbPath);
const devDbPath = path.resolve(process.env.POLICY_OCR_DEV_DB_PATH || defaultDevDbPath);

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function backupExistingDevDb() {
  if (!(await exists(devDbPath))) return '';
  const backupDir = path.join(path.dirname(devDbPath), 'backups');
  await fs.mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `policy-ocr-before-sync-${stamp}.sqlite`);
  await fs.copyFile(devDbPath, backupPath);
  return backupPath;
}

async function removeSqliteFiles(basePath) {
  await Promise.all(
    ['', '-wal', '-shm'].map(async (suffix) => {
      try {
        await fs.unlink(`${basePath}${suffix}`);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }),
  );
}

function summarize(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = [
      'users',
      'policies',
      'sessions',
      'sms_codes',
      'pending_scans',
      'source_records',
      'knowledge_records',
      'insurance_indicator_records',
      'state_documents',
    ];
    const summary = {};
    for (const table of tables) {
      try {
        summary[table] = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
      } catch {
        summary[table] = null;
      }
    }
    return summary;
  } finally {
    db.close();
  }
}

async function main() {
  if (!(await exists(prodDbPath))) {
    throw new Error(`生产数据库不存在：${prodDbPath}`);
  }
  await fs.mkdir(path.dirname(devDbPath), { recursive: true });
  const backupPath = await backupExistingDevDb();
  await removeSqliteFiles(devDbPath);

  const prodDb = new DatabaseSync(prodDbPath, { readOnly: true });
  try {
    prodDb.exec(`VACUUM INTO ${sqlString(devDbPath)}`);
  } finally {
    prodDb.close();
  }

  const result = {
    ok: true,
    prodDbPath,
    devDbPath,
    backupPath,
    devSummary: summarize(devDbPath),
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
