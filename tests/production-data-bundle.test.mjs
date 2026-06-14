import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCashflowStore, createCashValueStore } from '../server/cashflow-store.mjs';
import { createInitialState } from '../server/policy-ocr.domain.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';
import {
  createProductionDataBundle,
  installProductionDataBundle,
  summarizeSqliteDatabase,
} from '../scripts/production-data-bundle.mjs';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'policy-ocr-production-data-bundle-'));
}

async function seedDatabase(dbPath) {
  const store = await createSqliteStateStore({ dbPath });
  const state = {
    ...createInitialState(),
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-06-13T00:00:00.000Z', updatedAt: '2026-06-13T00:00:00.000Z' }],
    policies: [{ id: 2, userId: 1, guestId: '', company: '新华保险', name: '福如东海A款终身寿险（分红型）', insured: '测试客户', createdAt: '2026-06-13T00:01:00.000Z', updatedAt: '2026-06-13T00:01:00.000Z' }],
    familyProfiles: [{ id: 3, ownerUserId: 1, ownerGuestId: '', familyName: '测试家庭', coreMemberId: 4, status: 'active', createdAt: '2026-06-13T00:02:00.000Z', updatedAt: '2026-06-13T00:02:00.000Z' }],
    familyMembers: [{ id: 4, familyId: 3, name: '测试客户', relationToCore: '本人', status: 'active', createdAt: '2026-06-13T00:03:00.000Z', updatedAt: '2026-06-13T00:03:00.000Z' }],
    familyReportShares: [{ id: 5, familyId: 3, ownerUserId: 1, ownerGuestId: '', token: 'share-token', status: 'active', createdAt: '2026-06-13T00:04:00.000Z', updatedAt: '2026-06-13T00:04:00.000Z' }],
    sourceRecords: [{ id: 6, policyId: 2, company: '新华保险', productName: '福如东海A款终身寿险（分红型）', url: 'https://example.test/source.pdf' }],
    knowledgeRecords: [{ id: 7, company: '新华保险', productName: '福如东海A款终身寿险（分红型）', url: 'https://example.test/terms.pdf', pageText: '保险责任' }],
    insuranceIndicatorRecords: [{ id: 'indicator-1', company: '新华保险', productName: '福如东海A款终身寿险（分红型）', coverageType: '身故', liability: '身故保险金', formulaText: '身故保险金 = 有效保险金额' }],
    optionalResponsibilityRecords: [{ id: 'optional-1', company: '新华保险', productName: '福如东海A款终身寿险（分红型）', liability: '附加重疾', sourceExcerpt: '重大疾病保险责任' }],
    officialDomainProfiles: [{ id: 'new-china-life', company: '新华保险', officialDomains: ['newchinalife.com'] }],
    pendingScans: [{ guestId: 'guest-1', createdAt: '2026-06-13T00:05:00.000Z', scan: { data: { company: '新华保险' } } }],
    insuranceIndicatorSnapshot: { syncedAt: '2026-06-13T00:06:00.000Z', count: 1 },
    nextId: 8,
  };
  await store.persist(state);
  const cashValueStore = createCashValueStore(store.db);
  cashValueStore.replaceValues(2, [{ policyYear: 1, age: 30, cashValue: 1000, source: 'ocr' }]);
  const cashflowStore = createCashflowStore(store.db);
  cashflowStore.replaceEntries(2, [{ year: 2026, age: 30, amount: 100, cumulative: 100, liability: '生存金', calcText: '第1年给付' }]);
  store.close();
}

test('production data bundle preserves policies families knowledge indicators and cash tables', async () => {
  const dir = await makeTempDir();
  const sourceDbPath = path.join(dir, 'source.sqlite');
  const targetDbPath = path.join(dir, 'target.sqlite');
  const outDir = path.join(dir, 'bundles');
  await seedDatabase(sourceDbPath);

  const bundle = await createProductionDataBundle({
    dbPath: sourceDbPath,
    outDir,
    name: 'production-data-test',
  });
  assert.equal(bundle.format, 'policy-ocr-production-sqlite-bundle-v1');
  assert.equal(bundle.snapshot.coreCounts.policies, 1);
  assert.equal(bundle.snapshot.coreCounts.family_profiles, 1);
  assert.equal(bundle.snapshot.coreCounts.knowledge_records, 1);
  assert.equal(bundle.snapshot.coreCounts.insurance_indicator_records, 1);
  assert.equal(bundle.snapshot.coreCounts.optional_responsibility_records, 1);
  assert.equal(bundle.snapshot.coreCounts.policy_cash_values, 1);
  assert.equal(bundle.snapshot.coreCounts.policy_cashflows, 1);

  const installed = await installProductionDataBundle({
    bundlePath: bundle.bundlePath,
    manifestPath: bundle.manifestPath,
    targetDbPath,
  });
  assert.equal(installed.ok, true);
  assert.equal(installed.after.integrity, 'ok');
  assert.deepEqual(installed.after.coreCounts, bundle.snapshot.coreCounts);

  const targetSummary = summarizeSqliteDatabase(targetDbPath);
  assert.equal(targetSummary.coreCounts.policies, 1);
  assert.equal(targetSummary.coreCounts.family_members, 1);
  assert.equal(targetSummary.coreCounts.knowledge_records, 1);
  assert.equal(targetSummary.coreCounts.policy_cashflows, 1);
});

test('production data bundle refuses to replace a non-empty target unless explicitly allowed', async () => {
  const dir = await makeTempDir();
  const sourceDbPath = path.join(dir, 'source.sqlite');
  const targetDbPath = path.join(dir, 'target.sqlite');
  const outDir = path.join(dir, 'bundles');
  await seedDatabase(sourceDbPath);
  await seedDatabase(targetDbPath);

  const bundle = await createProductionDataBundle({
    dbPath: sourceDbPath,
    outDir,
    name: 'production-data-nonempty-test',
  });

  await assert.rejects(
    () => installProductionDataBundle({
      bundlePath: bundle.bundlePath,
      manifestPath: bundle.manifestPath,
      targetDbPath,
    }),
    /Refusing to replace non-empty production database/u,
  );

  const installed = await installProductionDataBundle({
    bundlePath: bundle.bundlePath,
    manifestPath: bundle.manifestPath,
    targetDbPath,
    replaceNonEmpty: true,
  });
  assert.equal(installed.ok, true);
  assert.ok(installed.backup.copied.some((filePath) => filePath.endsWith('target.sqlite')));
  assert.equal(installed.after.coreCounts.knowledge_records, 1);
});
