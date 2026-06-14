import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPolicyOcrApp } from './app.mjs';
import { createSqliteStateStore } from './sqlite-state-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const initialEnvKeys = new Set(Object.keys(process.env));

function normalizeEnvValue({ key, value, envPath }) {
  if (key === 'SMS_DELIVERY_CONFIG_PATH' && value && !path.isAbsolute(value)) {
    return path.resolve(path.dirname(envPath), value);
  }
  return value;
}

async function loadEnvFile(envPath, { override = false } = {}) {
  let raw = '';
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (initialEnvKeys.has(key)) continue;
    if (override || process.env[key] === undefined) {
      process.env[key] = normalizeEnvValue({ key, value, envPath });
    }
  }
}

const skipProjectDotenvLocal = String(process.env.POLICY_OCR_SKIP_PROJECT_DOTENV_LOCAL || '').trim().toLowerCase();

await loadEnvFile(path.join(projectRoot, '.env'));
if (!['1', 'true', 'yes', 'on'].includes(skipProjectDotenvLocal)) {
  await loadEnvFile(path.join(projectRoot, '.env.local'), { override: true });
}
await loadEnvFile(path.resolve(__dirname, '.env'), { override: true });
await loadEnvFile(path.resolve(__dirname, '.env.local'), { override: true });

const statePath = process.env.POLICY_OCR_APP_STATE_PATH || '';
const dbPath = process.env.POLICY_OCR_APP_DB_PATH || path.resolve(__dirname, '../.runtime/policy-ocr.sqlite');
const port = Number(process.env.POLICY_OCR_APP_API_PORT || 4206);
const host = process.env.POLICY_OCR_APP_HOST || '0.0.0.0';

const store = await createSqliteStateStore({ dbPath, seedStatePath: statePath });
const state = await store.load();
const app = createPolicyOcrApp({
  state,
  persist: store.persist,
  persistPolicyScanSave: store.persistPolicyScanSave,
  persistPendingScan: store.persistPendingScan,
  persistFamilyState: store.persistFamilyState,
  persistAdminSession: store.persistAdminSession,
  persistAuthSmsCode: store.persistAuthSmsCode,
  persistAuthRegistration: store.persistAuthRegistration,
  persistMembershipConfig: store.persistMembershipConfig,
  persistOfficialDomainProfiles: store.persistOfficialDomainProfiles,
  db: store.db,
});

app.listen(port, host, () => {
  console.log(`[policy-ocr-app] API listening on http://${host}:${port}`);
  console.log(`[policy-ocr-app] db=${dbPath}`);
  if (statePath) console.log(`[policy-ocr-app] seed-state=${statePath}`);
});
