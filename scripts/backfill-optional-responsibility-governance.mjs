import { rebuildOptionalResponsibilityGovernance } from '../server/optional-responsibility-governance.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';

const dbPath = process.env.POLICY_OCR_APP_DB_PATH || '.runtime/local/policy-ocr.sqlite';
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
