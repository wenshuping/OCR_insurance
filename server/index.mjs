import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPolicyOcrApp } from './app.mjs';
import { createSqliteStateStore } from './sqlite-state-store.mjs';
import { createDingtalkIdentityRuntime } from './dingtalk-identity-runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const initialEnvKeys = new Set(Object.keys(process.env));
const projectDotenvLocalPath = path.join(projectRoot, '.env.local');
const skippedProjectDotenvLocalAllowKeys = new Set([
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'DEEPSEEK_FALLBACK_MODEL',
  'DEEPSEEK_TIMEOUT_MS',
  'DEEPSEEK_FAMILY_REVIEW_MODEL',
  'DEEPSEEK_FAMILY_REVIEW_TIMEOUT_MS',
  'DEEPSEEK_FAMILY_REVIEW_MAX_TOKENS',
  'DEEPSEEK_FAMILY_REPORT_MODEL',
  'DEEPSEEK_FAMILY_REPORT_TIMEOUT_MS',
  'DEEPSEEK_FAMILY_REPORT_MAX_TOKENS',
]);

function normalizeEnvValue({ key, value, envPath }) {
  if (key === 'SMS_DELIVERY_CONFIG_PATH' && value && !path.isAbsolute(value)) {
    return path.resolve(path.dirname(envPath), value);
  }
  return value;
}

async function loadEnvFile(envPath, { override = false, allowKeys = null } = {}) {
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
    if (allowKeys && !allowKeys.has(key)) continue;
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
  await loadEnvFile(projectDotenvLocalPath, { override: true });
} else {
  await loadEnvFile(projectDotenvLocalPath, { override: true, allowKeys: skippedProjectDotenvLocalAllowKeys });
}
await loadEnvFile(path.resolve(__dirname, '.env'), { override: true });
await loadEnvFile(path.resolve(__dirname, '.env.local'), { override: true });

const statePath = process.env.POLICY_OCR_APP_STATE_PATH || '';
const dbPath = process.env.POLICY_OCR_APP_DB_PATH || path.resolve(__dirname, '../.runtime/policy-ocr.sqlite');
const port = Number(process.env.POLICY_OCR_APP_API_PORT || 4206);
const host = process.env.POLICY_OCR_APP_HOST || '0.0.0.0';

const store = await createSqliteStateStore({ dbPath, seedStatePath: statePath });
const state = await store.load();
const dingtalkIdentityRuntime = createDingtalkIdentityRuntime({ env: process.env });
const app = createPolicyOcrApp({
  state,
  persist: store.persist,
  persistPolicyScanSave: store.persistPolicyScanSave,
  persistPendingScan: store.persistPendingScan,
  persistFamilyState: store.persistFamilyState,
  persistFamilyReportState: store.persistFamilyReportState,
  persistAgentPolicyImportTask: store.persistAgentPolicyImportTask,
  findAgentPolicyImportTask: store.findAgentPolicyImportTask,
  reserveAgentPolicyImportFinalization: store.reserveAgentPolicyImportFinalization,
  completeAgentPolicyImportFinalization: store.completeAgentPolicyImportFinalization,
  findAgentPolicyImportFinalization: store.findAgentPolicyImportFinalization,
  failAgentPolicyImportFinalization: store.failAgentPolicyImportFinalization,
  findPolicyByImportSource: store.findPolicyByImportSource,
  persistAdminSession: store.persistAdminSession,
  persistAuthSmsCode: store.persistAuthSmsCode,
  persistAuthRegistration: store.persistAuthRegistration,
  persistAuthLogout: store.persistAuthLogout,
  persistPolicyState: store.persistPolicyState,
  persistPolicyDelete: store.persistPolicyDelete,
  persistMembershipConfig: store.persistMembershipConfig,
  persistStateDocument: store.persistStateDocument,
  persistMembershipState: store.persistMembershipState,
  persistDingtalkIdentityState: store.persistDingtalkIdentityState,
  persistOfficialDomainProfiles: store.persistOfficialDomainProfiles,
  persistPolicyDerivedResult: store.persistPolicyDerivedResult,
  persistProductCustomerResponsibilitySummary: store.persistProductCustomerResponsibilitySummary,
  persistProductCustomerSummaryGenerationRun: store.persistProductCustomerSummaryGenerationRun,
  persistResponsibilityLookupArtifacts: store.persistResponsibilityLookupArtifacts,
  findProductCustomerResponsibilitySummary: store.findProductCustomerResponsibilitySummary,
  markPolicyDerivedResultsStaleByProductKeys: store.markPolicyDerivedResultsStaleByProductKeys,
  upsertProductIndicatorVersions: store.upsertProductIndicatorVersions,
  recordIndicatorUpdateBatch: store.recordIndicatorUpdateBatch,
  ...dingtalkIdentityRuntime,
  db: store.db,
});

app.listen(port, host, () => {
  console.log(`[policy-ocr-app] API listening on http://${host}:${port}`);
  console.log(`[policy-ocr-app] db=${dbPath}`);
  if (statePath) console.log(`[policy-ocr-app] seed-state=${statePath}`);
});
