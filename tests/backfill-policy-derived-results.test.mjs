import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { backfillPolicyDerivedResults } from '../scripts/backfill-policy-derived-results.mjs';
import { createInitialState } from '../server/policy-ocr.domain.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';

async function makeTempDbPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-derived-backfill-'));
  return { dir, dbPath: path.join(dir, 'policy-ocr.sqlite') };
}

test('backfill policy derived results supports dry-run, write, and idempotent rerun', async () => {
  const { dir, dbPath } = await makeTempDbPath();
  const store = await createSqliteStateStore({ dbPath });
  try {
    const state = {
      ...createInitialState(),
      policies: [{
        id: 101,
        userId: 1,
        guestId: '',
        company: '新华保险',
        name: '多倍保障重大疾病保险',
        insured: '温舒萍',
        createdAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-15T00:00:00.000Z',
      }],
      insuranceIndicatorRecords: [{
        id: 'ind_1',
        company: '新华保险',
        productName: '多倍保障重大疾病保险',
        coverageType: '重大疾病保险金',
        liability: '确诊重大疾病',
      }],
      knowledgeRecords: [],
      optionalResponsibilityRecords: [],
      productIndicatorVersions: [{
        productKey: 'company_product:新华保险:多倍保障重大疾病保险',
        version: 2,
        batchId: 'batch_1',
        updatedAt: '2026-06-15T00:00:00.000Z',
      }],
      nextId: 102,
    };
    await store.persist(state);
  } finally {
    store.close();
  }

  try {
    const dryRun = await backfillPolicyDerivedResults({ dbPath });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.candidatePolicies, 1);
    assert.equal(dryRun.derivedResultUpserts, 1);

    const afterDryRun = await createSqliteStateStore({ dbPath });
    try {
      const state = await afterDryRun.load();
      assert.equal(state.policyDerivedResults.length, 0);
    } finally {
      afterDryRun.close();
    }

    const written = await backfillPolicyDerivedResults({ dbPath, write: true });
    assert.equal(written.dryRun, false);
    assert.equal(written.candidatePolicies, 1);
    assert.equal(written.derivedResultUpserts, 1);

    const afterWrite = await createSqliteStateStore({ dbPath });
    try {
      const state = await afterWrite.load();
      assert.equal(state.policyDerivedResults.length, 1);
      assert.equal(state.policyDerivedResults[0].policyId, 101);
      assert.equal(state.policyDerivedResults[0].coverageIndicators.length, 1);
      assert.deepEqual(state.policyDerivedResults[0].indicatorVersions, {
        'company_product:新华保险:多倍保障重大疾病保险': 2,
      });
    } finally {
      afterWrite.close();
    }

    const rerun = await backfillPolicyDerivedResults({ dbPath, write: true });
    assert.equal(rerun.candidatePolicies, 0);
    assert.equal(rerun.derivedResultUpserts, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
