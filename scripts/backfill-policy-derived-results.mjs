import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPolicyDerivedResult } from '../server/policy-derived-results.service.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(projectRoot, '.runtime', 'local', 'policy-ocr.sqlite');

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function existingDerivedByPolicyId(state) {
  return new Map((Array.isArray(state.policyDerivedResults) ? state.policyDerivedResults : [])
    .map((row) => [Number(row?.policyId || 0), row])
    .filter(([policyId]) => policyId > 0));
}

function needsBackfill(policy, existingByPolicyId) {
  const existing = existingByPolicyId.get(Number(policy?.id || 0));
  return !existing || String(existing.status || '') !== 'ready';
}

export async function backfillPolicyDerivedResults({
  dbPath = DEFAULT_DB_PATH,
  write = false,
  sampleLimit = 20,
} = {}) {
  const store = await createSqliteStateStore({ dbPath });
  try {
    const state = await store.load();
    const existingByPolicyId = existingDerivedByPolicyId(state);
    const candidates = (Array.isArray(state.policies) ? state.policies : [])
      .filter((policy) => needsBackfill(policy, existingByPolicyId));
    const now = new Date().toISOString();
    const derivedResults = candidates.map((policy) => buildPolicyDerivedResult({
      policy,
      indicatorRecords: state.insuranceIndicatorRecords,
      knowledgeRecords: state.knowledgeRecords,
      optionalResponsibilityRecords: state.optionalResponsibilityRecords,
      productIndicatorVersions: state.productIndicatorVersions,
      now,
    }));

    if (write) {
      for (const derivedResult of derivedResults) {
        await store.persistPolicyDerivedResult({ state, derivedResult });
      }
    }

    return {
      dbPath,
      dryRun: !write,
      totalPolicies: Array.isArray(state.policies) ? state.policies.length : 0,
      candidatePolicies: candidates.length,
      derivedResultUpserts: derivedResults.length,
      samples: derivedResults.slice(0, sampleLimit).map((row) => ({
        policyId: row.policyId,
        productKeys: row.productKeys,
        coverageIndicatorCount: row.coverageIndicators.length,
        optionalResponsibilityCount: row.optionalResponsibilities.length,
        status: row.status,
      })),
    };
  } finally {
    store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await backfillPolicyDerivedResults({
    dbPath: path.resolve(readArg('db-path', DEFAULT_DB_PATH)),
    write: hasFlag('write'),
    sampleLimit: Number(readArg('sample-limit', 20)) || 20,
  });
  console.log(JSON.stringify(result, null, 2));
}
