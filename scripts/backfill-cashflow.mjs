// scripts/backfill-cashflow.mjs
// One-time backfill script: compute and store cashflow entries for all existing policies.
// Usage: node scripts/backfill-cashflow.mjs [--dry-run]

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { computePolicyCashflow, computeScenarioEntries } from '../server/cashflow-compute.mjs';
import { findProductCashflowTemplate } from '../server/cashflow-template.mjs';
import { createCashflowStore } from '../server/cashflow-store.mjs';
import { findPolicyCoverageIndicators } from '../server/policy-ocr.domain.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const DB_PATH = process.argv.find(a => !a.startsWith('--') && a !== process.argv[0] && !a.endsWith('.mjs'))
  || path.resolve('.runtime/local/policy-ocr.sqlite');

console.log(`Backfill cashflow: ${DB_PATH} ${DRY_RUN ? '(DRY RUN)' : ''}`);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

const cashflowStore = createCashflowStore(db);

// Load policies
const policies = db.prepare('SELECT payload FROM policies').all()
  .map(r => { try { return JSON.parse(r.payload); } catch { return null; } })
  .filter(Boolean);

// Load indicator records
const indicatorRecords = db.prepare('SELECT payload FROM insurance_indicator_records').all()
  .map(r => { try { return JSON.parse(r.payload); } catch { return null; } })
  .filter(Boolean);

// Load knowledge records
const knowledgeRecords = db.prepare('SELECT payload FROM knowledge_records').all()
  .map(r => { try { return JSON.parse(r.payload); } catch { return null; } })
  .filter(Boolean);

console.log(`Found ${policies.length} policies, ${indicatorRecords.length} indicators, ${knowledgeRecords.length} knowledge records`);

let totalComputed = 0;
let totalEntries = 0;

for (const policy of policies) {
  const indicators = findPolicyCoverageIndicators(policy, indicatorRecords);
  const template = findProductCashflowTemplate(policy, knowledgeRecords);
  const cashflowEntries = computePolicyCashflow(policy, template, indicators);
  const scenarioEntries = computeScenarioEntries(indicators, policy);

  console.log(`  Policy ${policy.id} (${policy.name || 'unnamed'}): ${cashflowEntries.length} cashflow entries, ${scenarioEntries.length} scenario entries${template ? ' [template]' : ''}`);

  if (!DRY_RUN) {
    cashflowStore.replaceEntries(policy.id, cashflowEntries);
  }

  if (cashflowEntries.length) {
    totalComputed++;
    totalEntries += cashflowEntries.length;
  }
}

const status = cashflowStore.getStatus();
console.log(`\nResults: ${totalComputed} policies with cashflow, ${totalEntries} total entries`);
console.log(`DB status: ${JSON.stringify(status)}`);

db.close();
console.log('Done.');
