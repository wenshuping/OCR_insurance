import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createCashflowStore, createCashValueStore } from '../server/cashflow-store.mjs';
import { createInitialState } from '../server/policy-ocr.domain.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';
import {
  createKnowledgeDataBundle,
  createProductionDataBundle,
  installKnowledgeDataBundle,
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
    familyReports: [{ id: 9, familyId: 3, ownerUserId: 1, ownerGuestId: '', status: 'active', source: 'code', report: { summary: { familyId: 3, memberCount: 1, policyCount: 1 } }, generatedAt: '2026-06-13T00:04:10.000Z', createdAt: '2026-06-13T00:04:10.000Z', updatedAt: '2026-06-13T00:04:10.000Z', summary: { familyId: 3, memberCount: 1, policyCount: 1, issueCount: 1 } }],
    familyReportIssues: [{ id: 10, reportId: 9, familyId: 3, ownerUserId: 1, ownerGuestId: '', severity: 'warning', category: 'coverage_gap', status: 'open', source: 'rule', title: '家庭成员未绑定保单', detail: '测试报告问题', createdAt: '2026-06-13T00:04:20.000Z', updatedAt: '2026-06-13T00:04:20.000Z' }],
    familyReportCorrections: [{ id: 11, reportId: 9, familyId: 3, ownerUserId: 1, ownerGuestId: '', policyId: 2, memberId: 4, dimension: 'medical', action: 'mark_unquantifiable', status: 'auto_applied', source: 'deepseek', issueId: 10, reason: '报销型医疗不展示固定保额', createdAt: '2026-06-13T00:04:25.000Z', updatedAt: '2026-06-13T00:04:25.000Z' }],
    familySalesReviews: [{ id: 8, familyId: 3, ownerUserId: 1, ownerGuestId: '', status: 'active', content: '家庭销售建议', model: 'internal-expert', generatedAt: '2026-06-13T00:04:30.000Z', createdAt: '2026-06-13T00:04:30.000Z', updatedAt: '2026-06-13T00:04:30.000Z', inputSummary: { familyId: 3, memberCount: 1, policyCount: 1 } }],
    sourceRecords: [{ id: 6, policyId: 2, company: '新华保险', productName: '福如东海A款终身寿险（分红型）', url: 'https://example.test/source.pdf' }],
    knowledgeRecords: [{ id: 7, company: '新华保险', productName: '福如东海A款终身寿险（分红型）', url: 'https://example.test/terms.pdf', pageText: '保险责任' }],
    insuranceIndicatorRecords: [{ id: 'indicator-1', company: '新华保险', productName: '福如东海A款终身寿险（分红型）', coverageType: '身故', liability: '身故保险金', formulaText: '身故保险金 = 有效保险金额' }],
    optionalResponsibilityRecords: [{ id: 'optional-1', company: '新华保险', productName: '福如东海A款终身寿险（分红型）', liability: '附加重疾', sourceExcerpt: '重大疾病保险责任' }],
    officialDomainProfiles: [{ id: 'new-china-life', company: '新华保险', officialDomains: ['newchinalife.com'] }],
    pendingScans: [{ guestId: 'guest-1', createdAt: '2026-06-13T00:05:00.000Z', scan: { data: { company: '新华保险' } } }],
    insuranceIndicatorSnapshot: { syncedAt: '2026-06-13T00:06:00.000Z', count: 1 },
    nextId: 12,
  };
  await store.persist(state);
  const cashValueStore = createCashValueStore(store.db);
  cashValueStore.replaceValues(2, [{ policyYear: 1, age: 30, cashValue: 1000, source: 'ocr' }]);
  const cashflowStore = createCashflowStore(store.db);
  cashflowStore.replaceEntries(2, [{ year: 2026, age: 30, amount: 100, cumulative: 100, liability: '生存金', calcText: '第1年给付' }]);
  store.db.prepare(`
    INSERT INTO product_responsibility_cards (
      id,
      product_key,
      company,
      product_name,
      title,
      category,
      cashflow_treatment,
      calculation_status,
      payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'product-card-1',
    'company_product:新华保险:福如东海A款终身寿险（分红型）',
    '新华保险',
    '福如东海A款终身寿险（分红型）',
    '身故保险金',
    '人寿保障',
    'claim_contingent',
    'claim_contingent',
    JSON.stringify({ title: '身故保险金' }),
  );
  store.close();
}

function withDb(dbPath, fn) {
  const db = new DatabaseSync(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function insertProductionOnlyPolicy(dbPath) {
  withDb(dbPath, (db) => {
    const user = { id: 20, mobile: '15968125145', createdAt: '2026-06-14T00:00:00.000Z', updatedAt: '2026-06-14T00:00:00.000Z' };
    const policy = { id: 21, userId: 20, guestId: '', company: '中国人寿', name: '国寿鑫福年年养老年金保险', insured: '陈家明', createdAt: '2026-06-14T00:01:00.000Z', updatedAt: '2026-06-14T00:01:00.000Z' };
    db.prepare(`
      INSERT INTO users (id, mobile, created_at, updated_at, payload)
      VALUES (?, ?, ?, ?, ?)
    `).run(user.id, user.mobile, user.createdAt, user.updatedAt, JSON.stringify(user));
    db.prepare(`
      INSERT INTO policies (id, user_id, guest_id, company, name, insured, created_at, updated_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(policy.id, policy.userId, policy.guestId, policy.company, policy.name, policy.insured, policy.createdAt, policy.updatedAt, JSON.stringify(policy));
  });
}

function replaceKnowledgeRows(dbPath, label) {
  withDb(dbPath, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM knowledge_records').run();
      db.prepare('DELETE FROM insurance_indicator_records').run();
      db.prepare('DELETE FROM optional_responsibility_records').run();
      db.prepare('DELETE FROM product_responsibility_cards').run();
      db.prepare('DELETE FROM official_domain_profiles').run();
      db.prepare("DELETE FROM state_documents WHERE key = 'insuranceIndicatorSnapshot'").run();
      db.prepare(`
        INSERT INTO knowledge_records (id, company, product_name, url, payload)
        VALUES (?, ?, ?, ?, ?)
      `).run(70, '中国人寿', `知识-${label}`, `https://example.test/${label}.pdf`, JSON.stringify({ id: 70, company: '中国人寿', productName: `知识-${label}`, url: `https://example.test/${label}.pdf`, pageText: `责任-${label}` }));
      db.prepare(`
        INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`indicator-${label}`, '中国人寿', `知识-${label}`, '年金', '养老年金', JSON.stringify({ id: `indicator-${label}`, company: '中国人寿', productName: `知识-${label}`, coverageType: '年金', liability: '养老年金' }));
      db.prepare(`
        INSERT INTO optional_responsibility_records (id, company, product_name, liability, payload)
        VALUES (?, ?, ?, ?, ?)
      `).run(`optional-${label}`, '中国人寿', `知识-${label}`, '万能账户', JSON.stringify({ id: `optional-${label}`, company: '中国人寿', productName: `知识-${label}`, liability: '万能账户' }));
      db.prepare(`
        INSERT INTO product_responsibility_cards (
          id,
          product_key,
          company,
          product_name,
          title,
          category,
          cashflow_treatment,
          calculation_status,
          payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `product-card-${label}`,
        `company_product:中国人寿:知识-${label}`,
        '中国人寿',
        `知识-${label}`,
        '养老年金',
        '现金流',
        'scheduled_cashflow',
        'calculable',
        JSON.stringify({ title: '养老年金', label }),
      );
      db.prepare(`
        INSERT INTO official_domain_profiles (id, payload)
        VALUES (?, ?)
      `).run(`profile-${label}`, JSON.stringify({ id: `profile-${label}`, company: '中国人寿', officialDomains: [`${label}.example.test`] }));
      db.prepare(`
        INSERT INTO state_documents (key, payload)
        VALUES ('insuranceIndicatorSnapshot', ?)
      `).run(JSON.stringify({ syncedAt: `2026-06-14T00:00:00.000Z`, label }));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
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
  assert.equal(bundle.snapshot.coreCounts.family_reports, 1);
  assert.equal(bundle.snapshot.coreCounts.family_report_issues, 1);
  assert.equal(bundle.snapshot.coreCounts.family_report_corrections, 1);
  assert.equal(bundle.snapshot.coreCounts.family_sales_reviews, 1);
  assert.equal(bundle.snapshot.coreCounts.knowledge_records, 1);
  assert.equal(bundle.snapshot.coreCounts.insurance_indicator_records, 1);
  assert.equal(bundle.snapshot.coreCounts.optional_responsibility_records, 1);
  assert.equal(bundle.snapshot.coreCounts.product_responsibility_cards, 1);
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
  assert.equal(targetSummary.coreCounts.family_reports, 1);
  assert.equal(targetSummary.coreCounts.family_report_issues, 1);
  assert.equal(targetSummary.coreCounts.family_report_corrections, 1);
  assert.equal(targetSummary.coreCounts.family_sales_reviews, 1);
  assert.equal(targetSummary.coreCounts.knowledge_records, 1);
  assert.equal(targetSummary.coreCounts.product_responsibility_cards, 1);
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

test('production data full install refuses to remove protected user policy rows', async () => {
  const dir = await makeTempDir();
  const sourceDbPath = path.join(dir, 'source.sqlite');
  const targetDbPath = path.join(dir, 'target.sqlite');
  const outDir = path.join(dir, 'bundles');
  await seedDatabase(sourceDbPath);
  await seedDatabase(targetDbPath);
  insertProductionOnlyPolicy(targetDbPath);

  const bundle = await createProductionDataBundle({
    dbPath: sourceDbPath,
    outDir,
    name: 'production-data-protected-delete-test',
  });

  await assert.rejects(
    () => installProductionDataBundle({
      bundlePath: bundle.bundlePath,
      manifestPath: bundle.manifestPath,
      targetDbPath,
      replaceNonEmpty: true,
    }),
    /would remove protected production rows/u,
  );

  const targetSummary = summarizeSqliteDatabase(targetDbPath);
  assert.equal(targetSummary.coreCounts.users, 2);
  assert.equal(targetSummary.coreCounts.policies, 2);
});

test('knowledge data install updates knowledge tables without replacing user policies', async () => {
  const dir = await makeTempDir();
  const sourceDbPath = path.join(dir, 'source.sqlite');
  const targetDbPath = path.join(dir, 'target.sqlite');
  const outDir = path.join(dir, 'bundles');
  await seedDatabase(sourceDbPath);
  await seedDatabase(targetDbPath);
  insertProductionOnlyPolicy(targetDbPath);
  replaceKnowledgeRows(sourceDbPath, 'source');
  replaceKnowledgeRows(targetDbPath, 'target');

  const bundle = await createKnowledgeDataBundle({
    dbPath: sourceDbPath,
    outDir,
    name: 'knowledge-install-test',
  });
  assert.equal(bundle.mode, 'knowledge');
  assert.equal(bundle.snapshot.coreCounts.users, 0);
  assert.equal(bundle.snapshot.coreCounts.policies, 0);
  assert.equal(bundle.snapshot.coreCounts.family_profiles, 0);
  assert.equal(bundle.snapshot.coreCounts.policy_cashflows, 0);
  assert.equal(bundle.snapshot.coreCounts.policy_cash_values, 0);
  assert.equal(bundle.snapshot.coreCounts.knowledge_records, 1);
  assert.equal(bundle.snapshot.coreCounts.insurance_indicator_records, 1);
  assert.equal(bundle.snapshot.coreCounts.optional_responsibility_records, 1);
  assert.equal(bundle.snapshot.coreCounts.product_responsibility_cards, 1);
  const manifest = JSON.parse(await fs.readFile(bundle.manifestPath, 'utf8'));
  assert.equal(manifest.sourceDbPath, undefined);
  assert.equal(manifest.bundlePath, undefined);
  assert.equal(manifest.bundleFile, 'knowledge-install-test.sqlite.gz');
  assert.equal(manifest.source.counts, undefined);
  assert.equal(manifest.source.coreCounts, undefined);
  assert.equal(manifest.source.knowledgeCounts.users, undefined);
  assert.equal(manifest.source.knowledgeCounts.policies, undefined);
  assert.equal(manifest.source.knowledgeCounts.knowledge_records, 1);
  assert.equal(manifest.source.knowledgeCounts.product_responsibility_cards, 1);
  assert.equal(manifest.snapshot.nonEmptyGuardTotal, undefined);
  assert.equal(manifest.snapshot.counts.users, undefined);
  assert.equal(manifest.snapshot.counts.policies, undefined);
  assert.equal(manifest.snapshot.counts.knowledge_records, 1);

  await assert.rejects(
    () => installProductionDataBundle({
      bundlePath: bundle.bundlePath,
      manifestPath: bundle.manifestPath,
      targetDbPath: path.join(dir, 'wrong-full-target.sqlite'),
    }),
    /Knowledge-only bundle cannot be installed as a full production database/u,
  );

  const installed = await installKnowledgeDataBundle({
    bundlePath: bundle.bundlePath,
    manifestPath: bundle.manifestPath,
    targetDbPath,
  });

  assert.equal(installed.ok, true);
  assert.equal(installed.mode, 'knowledge');
  assert.equal(installed.after.coreCounts.users, 2);
  assert.equal(installed.after.coreCounts.policies, 2);
  assert.equal(installed.after.coreCounts.knowledge_records, 1);
  assert.equal(installed.after.coreCounts.product_responsibility_cards, 1);

  withDb(targetDbPath, (db) => {
    assert.equal(db.prepare('SELECT count(*) AS count FROM policies WHERE id = 21').get().count, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM knowledge_records WHERE product_name = '知识-source'").get().count, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM knowledge_records WHERE product_name = '知识-target'").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM product_responsibility_cards WHERE product_name = '知识-source'").get().count, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM product_responsibility_cards WHERE product_name = '知识-target'").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM pending_scans WHERE guest_id = 'guest-1'").get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM policy_cashflows WHERE policy_id = 2').get().count, 1);
    assert.equal(JSON.parse(db.prepare("SELECT payload FROM state_documents WHERE key = 'insuranceIndicatorSnapshot'").get().payload).label, 'source');
  });
});
