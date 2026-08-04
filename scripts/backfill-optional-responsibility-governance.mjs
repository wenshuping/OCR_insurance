import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebuildOptionalResponsibilityGovernance } from '../server/optional-responsibility-governance.mjs';
import { resolvePolicyOcrWriteDatabasePath } from '../server/policy-ocr-database-target.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = resolvePolicyOcrWriteDatabasePath({ projectRoot });
const seedStatePath = process.env.POLICY_OCR_STATE_PATH || '.runtime/local/state.json';
const store = await createSqliteStateStore({ dbPath, seedStatePath });

try {
  const state = await store.load();
  const next = rebuildOptionalResponsibilityGovernance(state);
  await store.persist(next);

  console.log(JSON.stringify({
    optionalResponsibilityCount: next.optionalResponsibilityRecords.length,
    optionalIndicatorCount: next.insuranceIndicatorRecords.filter((row) => row.responsibilityScope === 'optional').length,
  }, null, 2));
} finally {
  store.close();
}
