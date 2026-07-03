import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPolicyDerivedResult } from '../server/policy-derived-results.service.mjs';
import {
  buildResponsibilitySummaryReportFromCards,
  isGeneratedResponsibilityCountReport,
  mergeCoverageTableWithCheckedRows,
  responsibilityRowsFromCards,
} from '../server/responsibility-card-standardizer.mjs';
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

function normalizeCount(value) {
  return Array.isArray(value) ? value.length : 0;
}

function stableJson(value) {
  return JSON.stringify(value || []);
}

function summaryReportForCheckedRows(rows = []) {
  const count = normalizeCount(rows);
  return count ? `已按官网责任和指标核对生成 ${count} 项保险责任。` : '';
}

function reportFromCards({ current = '', checkedRows = [], responsibilityCards = [], optionalResponsibilities = [] } = {}) {
  const existing = String(current || '').trim();
  if (existing && !isGeneratedResponsibilityCountReport(existing)) return existing;
  return buildResponsibilitySummaryReportFromCards(responsibilityCards, { optionalResponsibilities })
    || summaryReportForCheckedRows(checkedRows)
    || existing;
}

function policySummaryChanged(policy, nextResponsibilities, nextReport) {
  return stableJson(policy?.responsibilities) !== stableJson(nextResponsibilities)
    || String(policy?.report || '') !== String(nextReport || '');
}

function sampleRow(policy, derivedResult, checkedRows, nextResponsibilities, changed) {
  return {
    policyId: policy.id,
    company: policy.company,
    name: policy.name,
    beforeResponsibilityCount: normalizeCount(policy.responsibilities),
    responsibilityCardCount: normalizeCount(derivedResult.responsibilityCards),
    checkedSummaryRowCount: checkedRows.length,
    afterResponsibilityCount: nextResponsibilities.length,
    changed,
    checkedCoverageTypes: checkedRows.slice(0, 8).map((row) => row.coverageType),
  };
}

export async function backfillPolicySummaryFromResponsibilityCards({
  dbPath = DEFAULT_DB_PATH,
  write = false,
  sampleLimit = 20,
} = {}) {
  const store = await createSqliteStateStore({ dbPath });
  try {
    const state = await store.load();
    const now = new Date().toISOString();
    const policies = Array.isArray(state.policies) ? state.policies : [];
    const samples = [];
    let derivedResultUpserts = 0;
    let policySummaryUpdates = 0;
    let policiesWithCheckedRows = 0;
    let responsibilityCards = 0;
    let checkedSummaryRows = 0;

    for (const policy of policies) {
      const sourcePolicy = {
        ...policy,
        responsibilities: [],
      };
      const derivedResult = buildPolicyDerivedResult({
        policy: sourcePolicy,
        indicatorRecords: state.insuranceIndicatorRecords,
        knowledgeRecords: state.knowledgeRecords,
        officialDomainProfiles: state.officialDomainProfiles,
        optionalResponsibilityRecords: state.optionalResponsibilityRecords,
        productIndicatorVersions: state.productIndicatorVersions,
        now,
      });
      const checkedRows = responsibilityRowsFromCards(derivedResult.responsibilityCards, {
        optionalResponsibilities: derivedResult.optionalResponsibilities,
      });
      const nextResponsibilities = mergeCoverageTableWithCheckedRows(policy.responsibilities, checkedRows);
      const nextReport = reportFromCards({
        current: policy.report,
        checkedRows,
        responsibilityCards: derivedResult.responsibilityCards,
        optionalResponsibilities: derivedResult.optionalResponsibilities,
      });
      const changed = policySummaryChanged(policy, nextResponsibilities, nextReport);

      responsibilityCards += normalizeCount(derivedResult.responsibilityCards);
      checkedSummaryRows += checkedRows.length;
      if (checkedRows.length) policiesWithCheckedRows += 1;
      if (changed) policySummaryUpdates += 1;
      derivedResultUpserts += 1;
      if (samples.length < sampleLimit) samples.push(sampleRow(policy, derivedResult, checkedRows, nextResponsibilities, changed));

      if (!write) continue;
      const nextPolicy = changed
        ? {
            ...policy,
            responsibilities: nextResponsibilities,
            report: nextReport,
            updatedAt: now,
          }
        : policy;
      if (changed) {
        state.policies = (Array.isArray(state.policies) ? state.policies : policies)
          .map((row) => (Number(row?.id) === Number(policy.id) ? nextPolicy : row));
        await store.persistPolicyState({ state, policy: nextPolicy });
      }
      await store.persistPolicyDerivedResult({
        state,
        derivedResult: {
          ...derivedResult,
          updatedAt: now,
        },
      });
    }

    return {
      dbPath,
      dryRun: !write,
      totalPolicies: policies.length,
      policiesWithCheckedRows,
      policySummaryUpdates,
      derivedResultUpserts,
      responsibilityCards,
      checkedSummaryRows,
      samples,
    };
  } finally {
    store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await backfillPolicySummaryFromResponsibilityCards({
    dbPath: path.resolve(readArg('db-path', DEFAULT_DB_PATH)),
    write: hasFlag('write'),
    sampleLimit: Number(readArg('sample-limit', 20)) || 20,
  });
  console.log(JSON.stringify(result, null, 2));
}
