import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createCashflowStore, createCashValueStore } from '../server/cashflow-store.mjs';
import { createInitialState } from '../server/policy-ocr.domain.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'policy-ocr-sqlite-store-'));
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function insertExternalKnowledgeRecord(store) {
  store.db.prepare(`
    INSERT INTO knowledge_records (id, company, product_name, url, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    99,
    '测试保险',
    '外部写入记录',
    'https://example.test/extra',
    JSON.stringify({ id: 99, company: '测试保险', productName: '外部写入记录' }),
  );
}

function assertKnowledgeTablesUntouched(db) {
  assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_records').get().count, 2);
  assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_records WHERE id = ?').get(99).count, 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM insurance_indicator_records').get().count, 1);
}

function baseKnowledgeState() {
  return {
    knowledgeRecords: [{ id: 5, company: '新华保险', productName: '已有保单', url: 'https://example.test/terms' }],
    insuranceIndicatorRecords: [{
      id: 'ind_1',
      company: '新华保险',
      productName: '已有保单',
      coverageType: '现金流',
      liability: '满期返还',
    }],
  };
}

test('sqlite state store imports JSON once and keeps database as the source of truth', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const seedStatePath = path.join(dir, 'state.json');
  await writeJson(seedStatePath, {
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' }],
    sessions: [{ token: 'token-1', userId: 1, createdAt: '2026-05-01T00:01:00.000Z' }],
    adminSessions: [{ token: 'admin-1', expiresAt: '2026-05-02T00:00:00.000Z' }],
    smsCodes: [{ id: 2, mobile: '18616135811', code: '123456', used: false, createdAt: '2026-05-01T00:02:00.000Z', expiresAt: '2026-05-01T00:12:00.000Z' }],
    policies: [{ id: 3, userId: 1, guestId: '', company: '新华保险', name: '盛世荣耀', insured: '温舒萍', createdAt: '2026-05-01T00:03:00.000Z', updatedAt: '2026-05-01T00:03:00.000Z' }],
    pendingScans: [{ guestId: 'guest-a', createdAt: '2026-05-01T00:04:00.000Z', scan: { data: { name: '待保存保单' } } }],
    sourceRecords: [{ id: 4, policyId: 3, company: '新华保险', productName: '盛世荣耀', url: 'https://example.test/source' }],
    knowledgeRecords: [{ id: 5, company: '新华保险', productName: '盛世荣耀', url: 'https://example.test/terms' }],
    insuranceIndicatorRecords: [{
      id: 'ind_1',
      company: '新华保险',
      productName: '盛世荣耀',
      coverageType: '现金流',
      liability: '满期返还',
      unit: '公式',
      formulaText: '满期返还 = 已交保费',
    }],
    officialDomainProfiles: [{ id: 'profile-1', company: '新华保险', domains: ['example.test'] }],
    familyProfiles: [{ id: 8, ownerUserId: 1, ownerGuestId: '', familyName: '张三家庭', coreMemberId: 9, status: 'active', createdAt: '2026-05-01T00:09:00.000Z', updatedAt: '2026-05-01T00:09:00.000Z' }],
    familyMembers: [{ id: 9, familyId: 8, name: '张三', relationToCore: 'self', relationLabel: '本人', role: 'core', status: 'active', createdAt: '2026-05-01T00:09:00.000Z', updatedAt: '2026-05-01T00:09:00.000Z' }],
    familyReportShares: [{ id: 10, familyId: 8, ownerUserId: 1, ownerGuestId: '', token: 'share-token-1', status: 'active', createdAt: '2026-05-01T00:10:00.000Z', updatedAt: '2026-05-01T00:10:00.000Z' }],
    familySalesReviews: [{
      id: 11,
      familyId: 8,
      ownerUserId: 1,
      ownerGuestId: '',
      status: 'active',
      content: '销售建议报告',
      model: 'internal-expert',
      generatedAt: '2026-05-01T00:11:00.000Z',
      createdAt: '2026-05-01T00:11:00.000Z',
      updatedAt: '2026-05-01T00:11:00.000Z',
      inputSummary: { familyId: 8, memberCount: 1, policyCount: 1 },
    }],
    familyReports: [{
      id: 12,
      familyId: 8,
      ownerUserId: 1,
      ownerGuestId: '',
      status: 'active',
      source: 'code',
      report: { summary: { familyId: 8, memberCount: 1, policyCount: 1 } },
      generatedAt: '2026-05-01T00:12:00.000Z',
      createdAt: '2026-05-01T00:12:00.000Z',
      updatedAt: '2026-05-01T00:12:00.000Z',
      summary: { familyId: 8, memberCount: 1, policyCount: 1, issueCount: 1 },
    }],
    familyReportIssues: [{
      id: 13,
      reportId: 12,
      familyId: 8,
      ownerUserId: 1,
      ownerGuestId: '',
      severity: 'warning',
      category: 'coverage_gap',
      status: 'open',
      source: 'rule',
      title: '家庭成员未绑定保单',
      detail: '测试问题',
      createdAt: '2026-05-01T00:12:30.000Z',
      updatedAt: '2026-05-01T00:12:30.000Z',
    }],
    familyReportCorrections: [{
      id: 14,
      reportId: 12,
      familyId: 8,
      ownerUserId: 1,
      ownerGuestId: '',
      policyId: 3,
      memberId: 9,
      dimension: 'medical',
      action: 'mark_unquantifiable',
      status: 'auto_applied',
      source: 'deepseek',
      issueId: 13,
      reason: '报销型医疗不展示固定保额',
      createdAt: '2026-05-01T00:12:40.000Z',
      updatedAt: '2026-05-01T00:12:40.000Z',
    }],
    insuranceIndicatorSnapshot: { syncedAt: '2026-05-01T00:05:00.000Z', count: 1 },
    nextId: 6,
  });

  const store = await createSqliteStateStore({ dbPath, seedStatePath });
  const imported = await store.load();
  assert.equal(imported.users.length, 1);
  assert.equal(imported.policies.length, 1);
  assert.equal(imported.knowledgeRecords.length, 1);
  assert.equal(imported.insuranceIndicatorRecords.length, 1);
  assert.equal(imported.insuranceIndicatorRecords[0].formulaText, '满期返还 = 已交保费');
  assert.equal(imported.familyProfiles.length, 1);
  assert.equal(imported.familyProfiles[0].familyName, '张三家庭');
  assert.equal(imported.familyMembers.length, 1);
  assert.equal(imported.familyMembers[0].name, '张三');
  assert.equal(imported.familyReportShares.length, 1);
  assert.equal(imported.familyReportShares[0].familyId, 8);
  assert.equal(imported.familyReportShares[0].token, 'share-token-1');
  assert.equal(imported.familySalesReviews.length, 1);
  assert.equal(imported.familySalesReviews[0].familyId, 8);
  assert.equal(imported.familySalesReviews[0].content, '销售建议报告');
  assert.equal(imported.familyReports.length, 1);
  assert.equal(imported.familyReports[0].summary.issueCount, 1);
  assert.equal(imported.familyReportIssues.length, 1);
  assert.equal(imported.familyReportIssues[0].reportId, 12);
  assert.equal(imported.familyReportCorrections.length, 1);
  assert.equal(imported.familyReportCorrections[0].status, 'auto_applied');
  assert.deepEqual(imported.insuranceIndicatorSnapshot, { syncedAt: '2026-05-01T00:05:00.000Z', count: 1 });
  assert.equal(imported.nextId, 15);

  imported.users.push({ id: 6, mobile: '13900000000', createdAt: '2026-05-01T00:06:00.000Z', updatedAt: '2026-05-01T00:06:00.000Z' });
  imported.policies.push({ id: 7, userId: 6, guestId: '', company: '平安人寿', name: '平安福', insured: '张三', createdAt: '2026-05-01T00:07:00.000Z', updatedAt: '2026-05-01T00:07:00.000Z' });
  imported.insuranceIndicatorRecords.push({
    id: 'ind_2',
    company: '平安人寿',
    productName: '平安福',
    coverageType: '疾病保障',
    liability: '重疾(首次给付)',
    unit: '公式',
    formulaText: '重疾(首次给付) = 基本保险金额',
  });
  imported.insuranceIndicatorSnapshot = { syncedAt: '2026-05-01T00:08:00.000Z', count: 2 };
  imported.nextId = 8;
  await store.persist(imported);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM insurance_indicator_records').get().count, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_profiles').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_members').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_reports').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_report_issues').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_report_corrections').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_report_shares').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_sales_reviews').get().count, 1);
    assert.equal(
      JSON.parse(db.prepare('SELECT payload FROM insurance_indicator_records WHERE id = ?').get('ind_2').payload).formulaText,
      '重疾(首次给付) = 基本保险金额',
    );
  } finally {
    db.close();
  }

  await writeJson(seedStatePath, {
    users: [],
    policies: [],
    knowledgeRecords: [],
    insuranceIndicatorRecords: [],
    insuranceIndicatorSnapshot: { syncedAt: 'bad-json-overwrite', count: 0 },
    nextId: 1,
  });

  const reloaded = await store.load();
  assert.equal(reloaded.users.length, 2);
  assert.equal(reloaded.policies.length, 2);
  assert.equal(reloaded.knowledgeRecords.length, 1);
  assert.equal(reloaded.insuranceIndicatorRecords.length, 2);
  assert.equal(reloaded.familyProfiles.length, 1);
  assert.equal(reloaded.familyProfiles[0].familyName, '张三家庭');
  assert.equal(reloaded.familyMembers.length, 1);
  assert.equal(reloaded.familyMembers[0].name, '张三');
  assert.equal(reloaded.familyReportShares.length, 1);
  assert.equal(reloaded.familyReportShares[0].familyId, 8);
  assert.equal(reloaded.familyReportShares[0].token, 'share-token-1');
  assert.equal(reloaded.familySalesReviews.length, 1);
  assert.equal(reloaded.familySalesReviews[0].content, '销售建议报告');
  assert.equal(reloaded.familyReports.length, 1);
  assert.equal(reloaded.familyReports[0].summary.issueCount, 1);
  assert.equal(reloaded.familyReportIssues.length, 1);
  assert.equal(reloaded.familyReportIssues[0].title, '家庭成员未绑定保单');
  assert.equal(reloaded.familyReportCorrections.length, 1);
  assert.equal(reloaded.familyReportCorrections[0].action, 'mark_unquantifiable');
  assert.equal(
    reloaded.insuranceIndicatorRecords.find((record) => record.id === 'ind_2')?.formulaText,
    '重疾(首次给付) = 基本保险金额',
  );
  assert.deepEqual(reloaded.insuranceIndicatorSnapshot, { syncedAt: '2026-05-01T00:08:00.000Z', count: 2 });
  assert.equal(reloaded.nextId, 15);
  store.close();

  const reopened = await createSqliteStateStore({ dbPath, seedStatePath });
  const reloadedAfterRestart = await reopened.load();
  assert.equal(reloadedAfterRestart.users.length, 2);
  assert.equal(reloadedAfterRestart.policies.length, 2);
  assert.equal(reloadedAfterRestart.knowledgeRecords.length, 1);
  assert.equal(reloadedAfterRestart.insuranceIndicatorRecords.length, 2);
  assert.equal(reloadedAfterRestart.familyProfiles.length, 1);
  assert.equal(reloadedAfterRestart.familyProfiles[0].familyName, '张三家庭');
  assert.equal(reloadedAfterRestart.familyMembers.length, 1);
  assert.equal(reloadedAfterRestart.familyMembers[0].name, '张三');
  assert.equal(reloadedAfterRestart.familyReportShares.length, 1);
  assert.equal(reloadedAfterRestart.familyReportShares[0].familyId, 8);
  assert.equal(reloadedAfterRestart.familyReportShares[0].token, 'share-token-1');
  assert.equal(reloadedAfterRestart.familySalesReviews.length, 1);
  assert.equal(reloadedAfterRestart.familySalesReviews[0].content, '销售建议报告');
  assert.equal(reloadedAfterRestart.familyReports.length, 1);
  assert.equal(reloadedAfterRestart.familyReports[0].summary.issueCount, 1);
  assert.equal(reloadedAfterRestart.familyReportIssues.length, 1);
  assert.equal(reloadedAfterRestart.familyReportIssues[0].reportId, 12);
  assert.equal(reloadedAfterRestart.familyReportCorrections.length, 1);
  assert.equal(reloadedAfterRestart.familyReportCorrections[0].reportId, 12);
  assert.deepEqual(reloadedAfterRestart.insuranceIndicatorSnapshot, { syncedAt: '2026-05-01T00:08:00.000Z', count: 2 });
  reopened.close();
});

test('sqlite state store leaves cash stores untouched across persist and reload', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const state = {
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' }],
    policies: [{ id: 3, userId: 1, guestId: '', company: '新华保险', name: '盛世荣耀', insured: '温舒萍', createdAt: '2026-05-01T00:03:00.000Z', updatedAt: '2026-05-01T00:03:00.000Z' }],
    nextId: 4,
  };

  const store = await createSqliteStateStore({ dbPath });
  await store.persist(state);

  const cashValueStore = createCashValueStore(store.db);
  const cashflowStore = createCashflowStore(store.db);
  cashValueStore.replaceValues(3, [
    { policyYear: 1, age: 30, cashValue: 8500 },
    { policyYear: 2, age: 31, cashValue: 19200 },
  ]);
  cashflowStore.replaceEntries(3, [
    { year: 2026, age: 30, amount: 1000, cumulative: 1000, liability: '生存金', calcText: '第1年给付1000' },
    { year: 2027, age: 31, amount: 2000, cumulative: 3000, liability: '生存金', calcText: '第2年给付2000' },
  ]);

  state.policies[0].updatedAt = '2026-05-01T00:04:00.000Z';
  await store.persist(state);

  assert.deepEqual(cashValueStore.getValues(3), [
    { policyYear: 1, age: 30, cashValue: 8500, source: 'ocr' },
    { policyYear: 2, age: 31, cashValue: 19200, source: 'ocr' },
  ]);
  assert.deepEqual(cashflowStore.getEntries(3).map((entry) => ({
    year: entry.year,
    age: entry.age,
    amount: entry.amount,
    cumulative: entry.cumulative,
    liability: entry.liability,
    calcText: entry.calcText,
  })), [
    { year: 2026, age: 30, amount: 1000, cumulative: 1000, liability: '生存金', calcText: '第1年给付1000' },
    { year: 2027, age: 31, amount: 2000, cumulative: 3000, liability: '生存金', calcText: '第2年给付2000' },
  ]);

  store.close();

  const reopened = await createSqliteStateStore({ dbPath });
  const reloadedCashValueStore = createCashValueStore(reopened.db);
  const reloadedCashflowStore = createCashflowStore(reopened.db);

  assert.deepEqual(reloadedCashValueStore.getValues(3), [
    { policyYear: 1, age: 30, cashValue: 8500, source: 'ocr' },
    { policyYear: 2, age: 31, cashValue: 19200, source: 'ocr' },
  ]);
  assert.deepEqual(reloadedCashflowStore.getEntries(3).map((entry) => ({
    year: entry.year,
    age: entry.age,
    amount: entry.amount,
    cumulative: entry.cumulative,
    liability: entry.liability,
    calcText: entry.calcText,
  })), [
    { year: 2026, age: 30, amount: 1000, cumulative: 1000, liability: '生存金', calcText: '第1年给付1000' },
    { year: 2027, age: 31, amount: 2000, cumulative: 3000, liability: '生存金', calcText: '第2年给付2000' },
  ]);

  reopened.close();
});

test('sqlite state store incrementally persists a saved policy without rewriting knowledge tables', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  const state = {
    ...createInitialState(),
    policies: [
      {
        id: 3,
        userId: 1,
        guestId: '',
        company: '新华保险',
        name: '已有保单',
        insured: '温舒萍',
        createdAt: '2026-05-01T00:03:00.000Z',
        updatedAt: '2026-05-01T00:03:00.000Z',
      },
    ],
    pendingScans: [
      { guestId: 'guest-a', createdAt: '2026-05-01T00:04:00.000Z', scan: { data: { name: '待保存A' } } },
      { guestId: 'guest-b', createdAt: '2026-05-01T00:05:00.000Z', scan: { data: { name: '待保存B' } } },
    ],
    sourceRecords: [],
    knowledgeRecords: [{ id: 5, company: '新华保险', productName: '已有保单', url: 'https://example.test/terms' }],
    insuranceIndicatorRecords: [{
      id: 'ind_1',
      company: '新华保险',
      productName: '已有保单',
      coverageType: '现金流',
      liability: '满期返还',
      unit: '公式',
      formulaText: '满期返还 = 已交保费',
    }],
    familyProfiles: [{
      id: 8,
      ownerUserId: 1,
      ownerGuestId: '',
      familyName: '测试家庭',
      coreMemberId: 9,
      status: 'active',
      createdAt: '2026-05-01T00:09:00.000Z',
      updatedAt: '2026-05-01T00:09:00.000Z',
    }],
    familyMembers: [{
      id: 9,
      familyId: 8,
      name: '温舒萍',
      relationToCore: 'self',
      relationLabel: '本人',
      role: 'core',
      status: 'active',
      createdAt: '2026-05-01T00:09:00.000Z',
      updatedAt: '2026-05-01T00:09:00.000Z',
    }],
    familyReports: [{
      id: 18,
      familyId: 8,
      ownerUserId: 1,
      ownerGuestId: '',
      status: 'active',
      source: 'code',
      report: { summary: { familyId: 8, policyCount: 1, memberCount: 1 } },
      generatedAt: '2026-05-01T00:10:00.000Z',
      createdAt: '2026-05-01T00:10:00.000Z',
      updatedAt: '2026-05-01T00:10:00.000Z',
      summary: { familyId: 8, policyCount: 1, memberCount: 1, issueCount: 1 },
    }],
    familyReportIssues: [{
      id: 19,
      reportId: 18,
      familyId: 8,
      ownerUserId: 1,
      ownerGuestId: '',
      severity: 'warning',
      category: 'coverage_gap',
      status: 'open',
      source: 'rule',
      title: '家庭成员未绑定保单',
      detail: '保存保单时应保留报告问题',
      createdAt: '2026-05-01T00:10:30.000Z',
      updatedAt: '2026-05-01T00:10:30.000Z',
    }],
    familyReportCorrections: [{
      id: 23,
      reportId: 18,
      familyId: 8,
      ownerUserId: 1,
      ownerGuestId: '',
      policyId: 20,
      memberId: 9,
      dimension: 'medical',
      action: 'exclude_amount',
      status: 'pending_review',
      source: 'deepseek',
      issueId: 19,
      reason: '测试保存保单时保留报告修正',
      createdAt: '2026-05-01T00:10:40.000Z',
      updatedAt: '2026-05-01T00:10:40.000Z',
    }],
    nextId: 20,
  };
  await store.persist(state);

  const savedPolicy = {
    id: 20,
    userId: null,
    guestId: 'guest-a',
    company: '新华保险',
    name: '多倍保障重大疾病保险',
    insured: '温舒萍',
    createdAt: '2026-06-08T01:00:00.000Z',
    updatedAt: '2026-06-08T01:00:00.000Z',
  };
  state.policies.push(savedPolicy);
  state.pendingScans = state.pendingScans.filter((row) => row.guestId !== 'guest-a');
  state.sourceRecords.push({
    id: 21,
    policyId: savedPolicy.id,
    company: '新华保险',
    productName: savedPolicy.name,
    url: 'https://example.test/policy-source',
  });
  state.familyMembers[0].relationLabel = '本人';
  state.nextId = 22;

  await store.persistPolicyScanSave({ state, policy: savedPolicy, clearPendingGuestId: 'guest-a' });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM policies').get().count, 2);
    assert.equal(
      JSON.parse(db.prepare('SELECT payload FROM policies WHERE id = ?').get(savedPolicy.id).payload).name,
      '多倍保障重大疾病保险',
    );
    assert.equal(db.prepare('SELECT count(*) AS count FROM pending_scans WHERE guest_id = ?').get('guest-a').count, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM pending_scans WHERE guest_id = ?').get('guest-b').count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_records').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM insurance_indicator_records').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM source_records WHERE policy_id = ?').get(savedPolicy.id).count, 1);
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM family_members WHERE id = ?').get(9).payload).relationLabel, '本人');
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_reports WHERE id = ?').get(18).count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_report_issues WHERE id = ?').get(19).count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_report_corrections WHERE id = ?').get(23).count, 1);
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'next_id'").get().value, '24');
  } finally {
    db.close();
    store.close();
  }
});

test('sqlite state store incrementally persists family state without rewriting knowledge tables', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  const state = {
    ...createInitialState(),
    policies: [
      {
        id: 3,
        userId: null,
        guestId: 'guest-family',
        company: '新华保险',
        name: '已有保单',
        insured: '温舒萍',
        createdAt: '2026-05-01T00:03:00.000Z',
        updatedAt: '2026-05-01T00:03:00.000Z',
      },
    ],
    knowledgeRecords: [{ id: 5, company: '新华保险', productName: '已有保单', url: 'https://example.test/terms' }],
    insuranceIndicatorRecords: [{
      id: 'ind_1',
      company: '新华保险',
      productName: '已有保单',
      coverageType: '现金流',
      liability: '满期返还',
    }],
    familyProfiles: [{
      id: 8,
      ownerUserId: null,
      ownerGuestId: 'guest-family',
      familyName: '测试家庭',
      coreMemberId: null,
      status: 'active',
      createdAt: '2026-05-01T00:09:00.000Z',
      updatedAt: '2026-05-01T00:09:00.000Z',
    }],
    familyMembers: [],
    familyReportShares: [],
    nextId: 20,
  };
  await store.persist(state);
  store.db.prepare(`
    INSERT INTO knowledge_records (id, company, product_name, url, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    99,
    '测试保险',
    '外部写入记录',
    'https://example.test/extra',
    JSON.stringify({ id: 99, company: '测试保险', productName: '外部写入记录' }),
  );

  state.familyProfiles[0].familyName = '更新后的测试家庭';
  state.familyMembers.push({
    id: 20,
    familyId: 8,
    name: '温舒萍',
    relationToCore: 'self',
    relationLabel: '本人',
    role: 'core',
    status: 'active',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
  });
  state.familyReportShares.push({
    id: 21,
    familyId: 8,
    ownerGuestId: 'guest-family',
    token: 'family-share-token',
    status: 'active',
    createdAt: '2026-06-08T00:01:00.000Z',
    updatedAt: '2026-06-08T00:01:00.000Z',
  });
  state.familySalesReviews.push({
    id: 22,
    familyId: 8,
    ownerGuestId: 'guest-family',
    status: 'active',
    content: '家庭销售建议已保存',
    model: 'internal-expert',
    generatedAt: '2026-06-08T00:02:00.000Z',
    createdAt: '2026-06-08T00:02:00.000Z',
    updatedAt: '2026-06-08T00:02:00.000Z',
    inputSummary: { familyId: 8, memberCount: 1, policyCount: 1 },
  });
  state.policies[0].familyId = 8;
  state.policies[0].insuredMemberId = 20;
  state.nextId = 23;

  await store.persistFamilyState({ state, includePolicies: true });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM family_profiles WHERE id = ?').get(8).payload).familyName, '更新后的测试家庭');
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_members WHERE family_id = ?').get(8).count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_report_shares WHERE token = ?').get('family-share-token').count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_sales_reviews WHERE family_id = ?').get(8).count, 1);
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM family_sales_reviews WHERE id = ?').get(22).payload).content, '家庭销售建议已保存');
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM policies WHERE id = ?').get(3).payload).insuredMemberId, 20);
    assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_records').get().count, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_records WHERE id = ?').get(99).count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM insurance_indicator_records').get().count, 1);
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'next_id'").get().value, '23');
  } finally {
    db.close();
    store.close();
  }
});

test('sqlite state store incrementally persists pending scan diagnostics', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  const state = {
    ...createInitialState(),
    pendingScans: [
      {
        guestId: 'guest-pending',
        createdAt: '2026-06-08T00:00:00.000Z',
        scan: null,
        rawUpload: { uploadItem: { name: 'policy.jpg', hasDataUrl: true } },
      },
    ],
    knowledgeRecords: [{ id: 5, company: '新华保险', productName: '已有保单', url: 'https://example.test/terms' }],
    insuranceIndicatorRecords: [{
      id: 'ind_1',
      company: '新华保险',
      productName: '已有保单',
      coverageType: '现金流',
      liability: '满期返还',
    }],
    nextId: 10,
  };
  await store.persist(state);

  state.pendingScans[0] = {
    ...state.pendingScans[0],
    scan: { data: { company: '新华保险', name: '多倍保障重大疾病保险' } },
    analysis: { report: '待保存分析' },
    updatedAt: '2026-06-08T00:01:00.000Z',
  };
  state.nextId = 11;
  await store.persistPendingScan({ state, guestId: 'guest-pending' });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM pending_scans WHERE guest_id = ?').get('guest-pending').count, 1);
    const pending = JSON.parse(db.prepare('SELECT payload FROM pending_scans WHERE guest_id = ?').get('guest-pending').payload);
    assert.equal(pending.scan.data.name, '多倍保障重大疾病保险');
    assert.equal(pending.analysis.report, '待保存分析');
    assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_records').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM insurance_indicator_records').get().count, 1);
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'next_id'").get().value, '11');
  } finally {
    db.close();
    store.close();
  }
});

test('sqlite state store incrementally persists admin sessions without rewriting knowledge tables', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  const state = {
    ...createInitialState(),
    adminSessions: [],
    knowledgeRecords: [{ id: 5, company: '新华保险', productName: '已有保单', url: 'https://example.test/terms' }],
    insuranceIndicatorRecords: [{
      id: 'ind_1',
      company: '新华保险',
      productName: '已有保单',
      coverageType: '现金流',
      liability: '满期返还',
    }],
    nextId: 10,
  };
  await store.persist(state);
  store.db.prepare(`
    INSERT INTO knowledge_records (id, company, product_name, url, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    99,
    '测试保险',
    '外部写入记录',
    'https://example.test/extra',
    JSON.stringify({ id: 99, company: '测试保险', productName: '外部写入记录' }),
  );

  const session = {
    token: 'admin-fast-token',
    createdAt: '2026-06-14T00:00:00.000Z',
    expiresAt: '2026-06-14T12:00:00.000Z',
  };
  state.adminSessions.push(session);
  await store.persistAdminSession({ state, session });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM admin_sessions WHERE token = ?').get('admin-fast-token').count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_records').get().count, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_records WHERE id = ?').get(99).count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM insurance_indicator_records').get().count, 1);
  } finally {
    db.close();
    store.close();
  }
});

test('sqlite state store incrementally persists auth sms codes without rewriting knowledge tables', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  const state = {
    ...createInitialState(),
    smsCodes: [],
    knowledgeRecords: [{ id: 5, company: '新华保险', productName: '已有保单', url: 'https://example.test/terms' }],
    insuranceIndicatorRecords: [{
      id: 'ind_1',
      company: '新华保险',
      productName: '已有保单',
      coverageType: '现金流',
      liability: '满期返还',
    }],
    nextId: 20,
  };
  await store.persist(state);
  store.db.prepare(`
    INSERT INTO knowledge_records (id, company, product_name, url, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    99,
    '测试保险',
    '外部写入记录',
    'https://example.test/extra',
    JSON.stringify({ id: 99, company: '测试保险', productName: '外部写入记录' }),
  );

  const sms = {
    id: 20,
    mobile: '18616135811',
    code: '123456',
    used: false,
    createdAt: '2026-06-14T00:00:00.000Z',
    expiresAt: '2026-06-14T00:10:00.000Z',
  };
  state.smsCodes.push(sms);
  state.nextId = 21;
  await store.persistAuthSmsCode({ state, sms });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM sms_codes WHERE id = ?').get(20).count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_records').get().count, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_records WHERE id = ?').get(99).count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM insurance_indicator_records').get().count, 1);
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'next_id'").get().value, '21');
  } finally {
    db.close();
    store.close();
  }
});

test('sqlite state store persists and reloads policy derived results', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  try {
    const state = await store.load();
    const row = {
      policyId: 101,
      productKeys: ['company_product:新华保险:多倍保障重大疾病保险'],
      coverageIndicators: [{ id: 'ind_1' }],
      optionalResponsibilities: [{ id: 'opt_1' }],
      responsibilityCards: [{ id: 'card_1', title: '关爱年金', indicators: [{ id: 'ind_1' }] }],
      indicatorVersions: { 'company_product:新华保险:多倍保障重大疾病保险': 2 },
      knowledgeVersion: 0,
      status: 'ready',
      staleReason: '',
      generatedAt: '2026-06-15T00:00:00.000Z',
      error: '',
    };

    await store.persistPolicyDerivedResult({ state, derivedResult: row });

    const reloaded = await store.load();
    assert.equal(reloaded.policyDerivedResults.length, 1);
    assert.equal(reloaded.policyDerivedResults[0].policyId, 101);
    assert.deepEqual(reloaded.policyDerivedResults[0].coverageIndicators, [{ id: 'ind_1' }]);
    assert.deepEqual(reloaded.policyDerivedResults[0].responsibilityCards, [{ id: 'card_1', title: '关爱年金', indicators: [{ id: 'ind_1' }] }]);
    assert.deepEqual(state.policyDerivedResults, reloaded.policyDerivedResults);
  } finally {
    store.close();
  }
});

test('sqlite state store persists and reloads product customer responsibility summaries', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  try {
    const state = await store.load();
    const summary = {
      id: 'customer_summary:company_product:新华保险:盛世荣耀:v1',
      productKey: 'company_product:新华保险:盛世荣耀',
      company: '新华保险',
      productName: '盛世荣耀',
      summaryVersion: 'customer-summary-v1',
      status: 'ready',
      headline: '这是一份以身故或身体全残保障为主的终身寿险。',
      summaryJson: {
        company: '新华保险',
        productName: '盛世荣耀',
        headline: '这是一份以身故或身体全残保障为主的终身寿险。',
        mainResponsibilities: [
          {
            title: '身故或身体全残保险金',
            plainText: '发生身故或身体全残时，保险公司按条款约定给付保险金。',
            howItPays: '金额需要结合保单信息计算。',
            requiredPolicyFields: ['基本保险金额', '已交保险费'],
          },
        ],
        notices: ['具体金额需要结合保单信息计算。'],
        requiredPolicyFields: ['基本保险金额', '已交保险费'],
        sourceUrls: ['https://example.test/terms.pdf'],
      },
      sourceUrls: ['https://example.test/terms.pdf'],
      sourceDigest: 'digest-1',
      modelProvider: 'deepseek',
      modelName: 'deepseek-v4-flash',
      generatedAt: '2026-06-29T00:00:00.000Z',
      updatedAt: '2026-06-29T00:00:00.000Z',
      payload: {
        productKey: 'company_product:新华保险:盛世荣耀',
        source: 'generated',
      },
    };

    await store.persistProductCustomerResponsibilitySummary({ state, summary });

    const reloaded = await store.load();
    assert.equal(reloaded.productCustomerResponsibilitySummaries.length, 1);
    assert.equal(reloaded.productCustomerResponsibilitySummaries[0].productKey, summary.productKey);
    assert.equal(reloaded.productCustomerResponsibilitySummaries[0].status, 'ready');
    assert.equal(reloaded.productCustomerResponsibilitySummaries[0].summaryJson.headline, summary.summaryJson.headline);

    const read = await store.findProductCustomerResponsibilitySummary({
      productKey: summary.productKey,
      summaryVersion: summary.summaryVersion,
      sourceDigest: summary.sourceDigest,
    });
    assert.equal(read?.summaryJson?.mainResponsibilities?.[0]?.title, '身故或身体全残保险金');
    assert.deepEqual(state.productCustomerResponsibilitySummaries, reloaded.productCustomerResponsibilitySummaries);
  } finally {
    store.close();
  }
});

test('sqlite state store persists product customer summary generation runs', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  try {
    const state = await store.load();
    const run = {
      id: 'customer_summary_run:company_product:新华保险:鑫荣耀:v22:1',
      productKey: 'company_product:新华保险:鑫荣耀',
      company: '新华保险',
      productName: '鑫荣耀',
      summaryVersion: 'customer-summary-v22-structured-rag',
      status: 'needs_model_review',
      productCategory: 'incremental_whole_life',
      categoryLabel: '增额终身寿险',
      modelProvider: 'deepseek',
      modelName: 'deepseek-v4-pro',
      modelTier: 'pro',
      sourceDigest: 'source-digest',
      sourceSectionsDigest: 'sections-digest',
      qualityIssues: [{ code: 'missing_required_keyword', keyword: '复利递增' }],
      rawPreview: '{"headline":"..."}',
      createdAt: '2026-07-01T00:00:00.000Z',
      payload: { attempt: 1 },
    };

    await store.persistProductCustomerSummaryGenerationRun({ state, run });

    const reloaded = await store.load();
    assert.equal(reloaded.productCustomerSummaryGenerationRuns.length, 1);
    assert.equal(reloaded.productCustomerSummaryGenerationRuns[0].id, run.id);
    assert.equal(reloaded.productCustomerSummaryGenerationRuns[0].status, 'needs_model_review');
    assert.equal(reloaded.productCustomerSummaryGenerationRuns[0].productCategory, 'incremental_whole_life');
    assert.equal(reloaded.productCustomerSummaryGenerationRuns[0].modelName, 'deepseek-v4-pro');
    assert.equal(reloaded.productCustomerSummaryGenerationRuns[0].qualityIssues[0].keyword, '复利递增');
    assert.equal(reloaded.productCustomerSummaryGenerationRuns[0].rawPreview, '{"headline":"..."}');
    assert.equal(reloaded.productCustomerSummaryGenerationRuns[0].payload.attempt, 1);
    assert.deepEqual(state.productCustomerSummaryGenerationRuns, reloaded.productCustomerSummaryGenerationRuns);
  } finally {
    store.close();
  }
});

test('sqlite state store upserts product customer summary generation runs', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  try {
    const state = await store.load();
    const run = {
      id: 'customer_summary_run:company_product:新华保险:鑫荣耀:v22:retry',
      productKey: 'company_product:新华保险:鑫荣耀',
      company: '新华保险',
      productName: '鑫荣耀',
      summaryVersion: 'customer-summary-v22-structured-rag',
      status: 'needs_model_review',
      productCategory: 'incremental_whole_life',
      categoryLabel: '增额终身寿险',
      modelProvider: 'deepseek',
      modelName: 'deepseek-v4-flash',
      modelTier: 'flash',
      sourceDigest: 'source-digest-1',
      sourceSectionsDigest: 'sections-digest-1',
      qualityIssues: [{ code: 'missing_formula', keyword: '有效保险金额' }],
      rawPreview: '{"headline":"first"}',
      createdAt: '2026-07-01T00:00:00.000Z',
      payload: { attempt: 1 },
    };

    await store.persistProductCustomerSummaryGenerationRun({ state, run });
    await store.persistProductCustomerSummaryGenerationRun({
      state,
      run: {
        ...run,
        status: 'failed',
        modelName: 'deepseek-v4-pro',
        modelTier: 'pro',
        sourceDigest: 'source-digest-2',
        sourceSectionsDigest: 'sections-digest-2',
        qualityIssues: [{ code: 'model_error', detail: 'timeout' }],
        rawPreview: '{"headline":"second"}',
        createdAt: '2026-07-01T00:01:00.000Z',
        payload: { attempt: 2, refreshed: true },
      },
    });

    const reloaded = await store.load();
    assert.equal(reloaded.productCustomerSummaryGenerationRuns.length, 1);
    assert.equal(reloaded.productCustomerSummaryGenerationRuns[0].status, 'failed');
    assert.equal(reloaded.productCustomerSummaryGenerationRuns[0].modelName, 'deepseek-v4-pro');
    assert.equal(reloaded.productCustomerSummaryGenerationRuns[0].modelTier, 'pro');
    assert.equal(reloaded.productCustomerSummaryGenerationRuns[0].sourceDigest, 'source-digest-2');
    assert.equal(reloaded.productCustomerSummaryGenerationRuns[0].sourceSectionsDigest, 'sections-digest-2');
    assert.deepEqual(reloaded.productCustomerSummaryGenerationRuns[0].qualityIssues, [{ code: 'model_error', detail: 'timeout' }]);
    assert.equal(reloaded.productCustomerSummaryGenerationRuns[0].rawPreview, '{"headline":"second"}');
    assert.deepEqual(reloaded.productCustomerSummaryGenerationRuns[0].payload, { attempt: 2, refreshed: true });
  } finally {
    store.close();
  }
});

test('sqlite state store marks derived results stale by changed product keys', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  try {
    const state = await store.load();
    await store.persistPolicyDerivedResult({
      state,
      derivedResult: {
        policyId: 201,
        productKeys: ['company_product:新华保险:多倍保障重大疾病保险'],
        coverageIndicators: [],
        optionalResponsibilities: [],
        indicatorVersions: {},
        knowledgeVersion: 0,
        status: 'ready',
        staleReason: '',
        generatedAt: '2026-06-15T00:00:00.000Z',
        error: '',
      },
    });

    const marked = await store.markPolicyDerivedResultsStaleByProductKeys({
      state,
      productKeys: ['company_product:新华保险:多倍保障重大疾病保险'],
      staleReason: 'indicator_updated',
    });

    assert.deepEqual(marked.policyIds, [201]);
    const reloaded = await store.load();
    assert.equal(reloaded.policyDerivedResults[0].status, 'stale');
    assert.equal(reloaded.policyDerivedResults[0].staleReason, 'indicator_updated');
  } finally {
    store.close();
  }
});

test('sqlite state store records product indicator versions and update batches', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  try {
    const state = await store.load();
    await store.upsertProductIndicatorVersions({
      state,
      productKeys: ['company_product:新华保险:多倍保障重大疾病保险'],
      batchId: 'batch_1',
    });
    await store.recordIndicatorUpdateBatch({
      state,
      batch: {
        id: 'batch_1',
        productKeys: ['company_product:新华保险:多倍保障重大疾病保险'],
        changedProductKeyCount: 1,
        affectedPolicyCount: 0,
        createdAt: '2026-06-15T00:00:00.000Z',
      },
    });

    const reloaded = await store.load();
    assert.deepEqual(reloaded.productIndicatorVersions.map((row) => ({
      productKey: row.productKey,
      version: row.version,
      batchId: row.batchId,
    })), [
      {
        productKey: 'company_product:新华保险:多倍保障重大疾病保险',
        version: 1,
        batchId: 'batch_1',
      },
    ]);
    assert.equal(reloaded.indicatorUpdateBatches.length, 1);
    assert.equal(reloaded.indicatorUpdateBatches[0].id, 'batch_1');
  } finally {
    store.close();
  }
});

test('sqlite state store incrementally persists auth registration without rewriting knowledge tables', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  const state = {
    ...createInitialState(),
    smsCodes: [{
      id: 20,
      mobile: '18616135811',
      code: '123456',
      used: false,
      createdAt: '2026-06-14T00:00:00.000Z',
      expiresAt: '2026-06-14T00:10:00.000Z',
    }],
    policies: [{
      id: 21,
      userId: null,
      guestId: 'guest-fast-auth',
      company: '新华保险',
      name: '盛世荣耀',
      insured: '温舒萍',
      createdAt: '2026-06-14T00:01:00.000Z',
      updatedAt: '2026-06-14T00:01:00.000Z',
    }],
    pendingScans: [{
      id: 22,
      guestId: 'guest-fast-auth',
      scan: { data: { company: '新华保险', name: '待保存保单' } },
      createdAt: '2026-06-14T00:02:00.000Z',
    }],
    sourceRecords: [{
      id: 23,
      policyId: 21,
      company: '新华保险',
      productName: '盛世荣耀',
      url: 'https://example.test/source',
    }],
    familyProfiles: [{
      id: 24,
      ownerUserId: null,
      ownerGuestId: 'guest-fast-auth',
      familyName: '默认家庭',
      coreMemberId: 25,
      status: 'active',
      createdAt: '2026-06-14T00:03:00.000Z',
      updatedAt: '2026-06-14T00:03:00.000Z',
    }],
    familyMembers: [{
      id: 25,
      familyId: 24,
      name: '温舒萍',
      relationToCore: 'self',
      status: 'active',
      createdAt: '2026-06-14T00:03:00.000Z',
      updatedAt: '2026-06-14T00:03:00.000Z',
    }],
    knowledgeRecords: [{ id: 5, company: '新华保险', productName: '已有保单', url: 'https://example.test/terms' }],
    insuranceIndicatorRecords: [{
      id: 'ind_1',
      company: '新华保险',
      productName: '已有保单',
      coverageType: '现金流',
      liability: '满期返还',
    }],
    nextId: 30,
  };
  await store.persist(state);
  store.db.prepare(`
    INSERT INTO knowledge_records (id, company, product_name, url, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    99,
    '测试保险',
    '外部写入记录',
    'https://example.test/extra',
    JSON.stringify({ id: 99, company: '测试保险', productName: '外部写入记录' }),
  );

  const user = {
    id: 30,
    mobile: '18616135811',
    createdAt: '2026-06-14T00:04:00.000Z',
    updatedAt: '2026-06-14T00:04:00.000Z',
  };
  const session = {
    token: 'user-fast-token',
    userId: 30,
    createdAt: '2026-06-14T00:05:00.000Z',
  };
  state.users.push(user);
  state.sessions.push(session);
  state.smsCodes[0].used = true;
  state.policies[0].userId = 30;
  state.policies[0].guestId = '';
  state.policies[0].updatedAt = '2026-06-14T00:05:00.000Z';
  state.familyProfiles[0].ownerUserId = 30;
  state.familyProfiles[0].ownerGuestId = '';
  state.familyProfiles[0].updatedAt = '2026-06-14T00:05:00.000Z';
  state.pendingScans = [];
  state.nextId = 31;

  await store.persistAuthRegistration({
    state,
    user,
    sms: state.smsCodes[0],
    session,
    guestId: 'guest-fast-auth',
    policyIds: [21],
  });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM users WHERE id = ?').get(30).count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM sessions WHERE token = ?').get('user-fast-token').count, 1);
    assert.equal(db.prepare('SELECT used FROM sms_codes WHERE id = ?').get(20).used, 1);
    assert.equal(db.prepare('SELECT user_id AS userId, guest_id AS guestId FROM policies WHERE id = ?').get(21).userId, 30);
    assert.equal(db.prepare('SELECT count(*) AS count FROM pending_scans WHERE guest_id = ?').get('guest-fast-auth').count, 0);
    assert.equal(db.prepare('SELECT owner_user_id AS ownerUserId, owner_guest_id AS ownerGuestId FROM family_profiles WHERE id = ?').get(24).ownerUserId, 30);
    assert.equal(db.prepare('SELECT count(*) AS count FROM source_records WHERE policy_id = ?').get(21).count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_records').get().count, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_records WHERE id = ?').get(99).count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM insurance_indicator_records').get().count, 1);
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'next_id'").get().value, '31');
  } finally {
    db.close();
    store.close();
  }
});

test('sqlite state store incrementally persists membership config without rewriting knowledge tables', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  const state = {
    ...createInitialState(),
    ...baseKnowledgeState(),
    membershipConfig: {
      enabled: true,
      annualPriceCents: 30000,
      annualDurationDays: 365,
      registeredFreePolicyQuota: 3,
      familyReportDailyRefreshLimit: 3,
      familySalesReviewDailyRefreshLimit: 3,
      updatedAt: '2026-06-14T00:00:00.000Z',
    },
    reportRefreshEvents: [{
      id: 9,
      kind: 'familyReport',
      familyId: 3,
      reportId: 7,
      ownerUserId: 1,
      ownerGuestId: '',
      createdAt: '2026-06-14T00:02:00.000Z',
    }],
    nextId: 10,
  };
  await store.persist(state);
  insertExternalKnowledgeRecord(store);

  state.membershipConfig = {
    ...state.membershipConfig,
    enabled: false,
    registeredFreePolicyQuota: 6,
    updatedAt: '2026-06-14T00:01:00.000Z',
  };
  await store.persistMembershipConfig({ state, config: state.membershipConfig });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const config = JSON.parse(db.prepare('SELECT payload FROM membership_config WHERE id = 1').get().payload);
    const event = JSON.parse(db.prepare('SELECT payload FROM report_refresh_events WHERE id = 9').get().payload);
    assert.equal(config.enabled, false);
    assert.equal(config.registeredFreePolicyQuota, 6);
    assert.equal(event.kind, 'familyReport');
    assert.equal(event.reportId, 7);
    assertKnowledgeTablesUntouched(db);
  } finally {
    db.close();
    store.close();
  }
});

test('sqlite state store incrementally deletes auth sessions without rewriting knowledge tables', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  const state = {
    ...createInitialState(),
    ...baseKnowledgeState(),
    sessions: [{ token: 'user-fast-token', userId: 30, createdAt: '2026-06-14T00:05:00.000Z' }],
    nextId: 40,
  };
  await store.persist(state);
  insertExternalKnowledgeRecord(store);

  state.sessions = [];
  state.nextId = 41;
  await store.persistAuthLogout({ state, token: 'user-fast-token' });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM sessions WHERE token = ?').get('user-fast-token').count, 0);
    assertKnowledgeTablesUntouched(db);
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'next_id'").get().value, '41');
  } finally {
    db.close();
    store.close();
  }
});

test('sqlite state store incrementally persists policy updates without rewriting knowledge tables', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  const state = {
    ...createInitialState(),
    ...baseKnowledgeState(),
    policies: [{
      id: 20,
      userId: 30,
      guestId: '',
      company: '新华保险',
      name: '旧保单',
      insured: '温舒萍',
      createdAt: '2026-06-14T00:01:00.000Z',
      updatedAt: '2026-06-14T00:01:00.000Z',
    }],
    sourceRecords: [{
      id: 21,
      policyId: 20,
      company: '新华保险',
      productName: '旧保单',
      url: 'https://example.test/old-source',
    }],
    familyProfiles: [{
      id: 24,
      ownerUserId: 30,
      ownerGuestId: '',
      familyName: '默认家庭',
      coreMemberId: 25,
      status: 'active',
      createdAt: '2026-06-14T00:03:00.000Z',
      updatedAt: '2026-06-14T00:03:00.000Z',
    }],
    familyMembers: [{
      id: 25,
      familyId: 24,
      name: '温舒萍',
      relationToCore: 'self',
      relationLabel: '本人',
      status: 'active',
      createdAt: '2026-06-14T00:03:00.000Z',
      updatedAt: '2026-06-14T00:03:00.000Z',
    }],
    nextId: 50,
  };
  await store.persist(state);
  insertExternalKnowledgeRecord(store);

  state.policies[0].name = '更新后的保单';
  state.policies[0].reportStatus = 'ready';
  state.policies[0].updatedAt = '2026-06-14T00:06:00.000Z';
  state.sourceRecords = [{
    id: 22,
    policyId: 20,
    company: '新华保险',
    productName: '更新后的保单',
    url: 'https://example.test/new-source',
  }];
  state.familyMembers[0].relationLabel = '本人';
  state.nextId = 51;

  await store.persistPolicyState({ state, policy: state.policies[0], includeFamilyState: true });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM policies WHERE id = ?').get(20).payload).name, '更新后的保单');
    assert.equal(db.prepare('SELECT count(*) AS count FROM source_records WHERE policy_id = ?').get(20).count, 1);
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM source_records WHERE policy_id = ?').get(20).payload).url, 'https://example.test/new-source');
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM family_members WHERE id = ?').get(25).payload).relationLabel, '本人');
    assertKnowledgeTablesUntouched(db);
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'next_id'").get().value, '51');
  } finally {
    db.close();
    store.close();
  }
});

test('sqlite state store incrementally deletes policies without rewriting knowledge tables', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  const state = {
    ...createInitialState(),
    ...baseKnowledgeState(),
    policies: [{
      id: 20,
      userId: 30,
      guestId: '',
      company: '新华保险',
      name: '待删除保单',
      insured: '温舒萍',
      createdAt: '2026-06-14T00:01:00.000Z',
      updatedAt: '2026-06-14T00:01:00.000Z',
    }],
    sourceRecords: [{
      id: 21,
      policyId: 20,
      company: '新华保险',
      productName: '待删除保单',
      url: 'https://example.test/source',
    }],
    nextId: 50,
  };
  await store.persist(state);
  insertExternalKnowledgeRecord(store);

  state.policies = [];
  state.sourceRecords = [];
  state.nextId = 51;
  await store.persistPolicyDelete({ state, policyId: 20 });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM policies WHERE id = ?').get(20).count, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM source_records WHERE policy_id = ?').get(20).count, 0);
    assertKnowledgeTablesUntouched(db);
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'next_id'").get().value, '51');
  } finally {
    db.close();
    store.close();
  }
});

test('sqlite state store incrementally persists membership and wechat state without rewriting knowledge tables', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  const state = {
    ...createInitialState(),
    ...baseKnowledgeState(),
    users: [{ id: 30, mobile: '18616135811', createdAt: '2026-06-14T00:00:00.000Z', updatedAt: '2026-06-14T00:00:00.000Z' }],
    membershipOrders: [],
    memberships: [],
    userWechatIdentities: [],
    wechatOAuthStates: [],
    nextId: 60,
  };
  await store.persist(state);
  insertExternalKnowledgeRecord(store);

  const order = {
    id: 60,
    outTradeNo: 'm-test-order',
    userId: 30,
    productCode: 'annual_membership',
    amountCents: 30000,
    currency: 'CNY',
    status: 'paid',
    prepayId: 'wx-prepay',
    transactionId: '4200001',
    paidAt: '2026-06-14T00:10:00.000Z',
    expiresAt: '2026-06-14T00:30:00.000Z',
    createdAt: '2026-06-14T00:05:00.000Z',
    updatedAt: '2026-06-14T00:10:00.000Z',
    payload: { notify: { trade_state: 'SUCCESS' } },
  };
  const membership = {
    userId: 30,
    plan: 'annual',
    status: 'active',
    startedAt: '2026-06-14T00:10:00.000Z',
    expiresAt: '2027-06-14T00:10:00.000Z',
    lastOrderId: 60,
    updatedAt: '2026-06-14T00:10:00.000Z',
  };
  const oauthState = {
    state: 'oauth-state-fast',
    userId: 30,
    appId: 'wx123',
    redirectUrl: '/#/member',
    usedAt: '2026-06-14T00:11:00.000Z',
    expiresAt: '2026-06-14T00:15:00.000Z',
    createdAt: '2026-06-14T00:05:00.000Z',
  };
  const identity = {
    userId: 30,
    appId: 'wx123',
    openid: 'openid-fast',
    scope: 'snsapi_base',
    createdAt: '2026-06-14T00:11:00.000Z',
    updatedAt: '2026-06-14T00:11:00.000Z',
  };
  state.membershipOrders.push(order);
  state.memberships.push(membership);
  state.wechatOAuthStates.push(oauthState);
  state.userWechatIdentities.push(identity);
  state.nextId = 61;

  await store.persistMembershipState({
    state,
    order,
    membership,
    oauthState,
    identity,
  });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM membership_orders WHERE id = ?').get(60).count, 1);
    assert.equal(db.prepare('SELECT status FROM membership_orders WHERE id = ?').get(60).status, 'paid');
    assert.equal(db.prepare('SELECT status FROM memberships WHERE user_id = ?').get(30).status, 'active');
    assert.equal(db.prepare('SELECT used_at AS usedAt FROM wechat_oauth_states WHERE state = ?').get('oauth-state-fast').usedAt, '2026-06-14T00:11:00.000Z');
    assert.equal(db.prepare('SELECT openid FROM user_wechat_identities WHERE user_id = ? AND app_id = ?').get(30, 'wx123').openid, 'openid-fast');
    assertKnowledgeTablesUntouched(db);
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'next_id'").get().value, '61');
  } finally {
    db.close();
    store.close();
  }
});

test('sqlite state store persists product optional responsibility records', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  const state = {
    ...createInitialState(),
    optionalResponsibilityRecords: [
      {
        id: 'optrec_xinhua_zhixiang_1',
        company: '新华保险',
        productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
        liability: '可选责任一',
        title: '可选责任一',
        quantificationStatus: 'pending_review',
        quantificationReason: '缺少结构化指标',
        indicatorIds: [],
        sourceExcerpt: '3.可选责任一 （1）轻度疾病保险金。',
      },
    ],
  };

  await store.persist(state);
  const reloaded = await store.load();

  assert.equal(reloaded.optionalResponsibilityRecords.length, 1);
  assert.equal(reloaded.optionalResponsibilityRecords[0].liability, '可选责任一');
  assert.equal(reloaded.optionalResponsibilityRecords[0].quantificationStatus, 'pending_review');
  store.close();
});

test('sqlite state store persists membership orders, memberships, wechat identities, and oauth states', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const seedStatePath = path.join(dir, 'state.json');
  await writeJson(seedStatePath, {
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    membershipConfig: {
      enabled: true,
      annualPriceCents: 30000,
      annualDurationDays: 365,
      registeredFreePolicyQuota: 2,
      familyReportDailyRefreshLimit: 4,
      familySalesReviewDailyRefreshLimit: 5,
      updatedAt: '2026-06-11T08:00:00.000Z',
    },
    reportRefreshEvents: [{
      id: 19,
      kind: 'familySalesReview',
      familyId: 3,
      reportId: 8,
      ownerUserId: 1,
      ownerGuestId: '',
      createdAt: '2026-06-11T08:00:30.000Z',
    }],
    membershipOrders: [{
      id: 20,
      outTradeNo: 'mem_1_1790000000000_abcdef',
      userId: 1,
      productCode: 'annual_membership',
      amountCents: 30000,
      currency: 'CNY',
      status: 'paid',
      prepayId: 'wx-prepay',
      transactionId: '4200001',
      paidAt: '2026-06-11T08:01:00.000Z',
      expiresAt: '2026-06-11T08:30:00.000Z',
      createdAt: '2026-06-11T08:00:00.000Z',
      updatedAt: '2026-06-11T08:01:00.000Z',
      payload: { notify: { trade_state: 'SUCCESS' } },
    }],
    memberships: [{ userId: 1, plan: 'annual', status: 'active', startedAt: '2026-06-11T08:01:00.000Z', expiresAt: '2027-06-11T08:01:00.000Z', lastOrderId: 20, updatedAt: '2026-06-11T08:01:00.000Z' }],
    userWechatIdentities: [{ userId: 1, appId: 'wx123', openid: 'openid-1', scope: 'snsapi_base', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    wechatOAuthStates: [{ state: 'oauth-state-1', userId: 1, appId: 'wx123', redirectUrl: '/#/member', usedAt: '', expiresAt: '2026-06-11T08:10:00.000Z', createdAt: '2026-06-11T08:00:00.000Z' }],
    nextId: 21,
  });

  const store = await createSqliteStateStore({ dbPath, seedStatePath });
  const imported = await store.load();
  assert.equal(imported.membershipConfig.registeredFreePolicyQuota, 2);
  assert.equal(imported.membershipConfig.familyReportDailyRefreshLimit, 4);
  assert.equal(imported.membershipConfig.familySalesReviewDailyRefreshLimit, 5);
  assert.equal(imported.reportRefreshEvents[0].kind, 'familySalesReview');
  assert.equal(imported.membershipOrders[0].outTradeNo, 'mem_1_1790000000000_abcdef');
  assert.equal(imported.memberships[0].expiresAt, '2027-06-11T08:01:00.000Z');
  assert.equal(imported.userWechatIdentities[0].openid, 'openid-1');
  assert.equal(imported.wechatOAuthStates[0].state, 'oauth-state-1');
  assert.equal(imported.nextId, 21);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM membership_orders').get().count, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM memberships').get().count, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM report_refresh_events').get().count, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM user_wechat_identities').get().count, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM wechat_oauth_states').get().count, 1);
  assert.equal(
    store.db.prepare(`
      SELECT count(*) AS count
      FROM state_documents
      WHERE key IN ('membershipConfig', 'membershipOrders', 'memberships', 'userWechatIdentities', 'wechatOAuthStates')
    `).get().count,
    0,
  );

  imported.membershipConfig = { ...imported.membershipConfig, registeredFreePolicyQuota: 4, updatedAt: '2026-06-11T09:00:00.000Z' };
  imported.membershipOrders.push({
    id: 21,
    outTradeNo: 'mem_1_1790000000001_bcdefa',
    userId: 1,
    productCode: 'annual_membership',
    amountCents: 30000,
    currency: 'CNY',
    status: 'prepay_created',
    prepayId: 'wx-prepay-2',
    transactionId: '',
    paidAt: '',
    expiresAt: '2026-06-11T09:30:00.000Z',
    createdAt: '2026-06-11T09:00:00.000Z',
    updatedAt: '2026-06-11T09:00:00.000Z',
    payload: {},
  });
  imported.nextId = 22;
  await store.persist(imported);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM membership_orders').get().count, 2);
  assert.equal(
    store.db.prepare(`
      SELECT count(*) AS count
      FROM state_documents
      WHERE key IN ('membershipConfig', 'membershipOrders', 'memberships', 'userWechatIdentities', 'wechatOAuthStates')
    `).get().count,
    0,
  );
  store.close();

  const reopened = await createSqliteStateStore({ dbPath, seedStatePath });
  const reloaded = await reopened.load();
  assert.equal(reloaded.membershipConfig.registeredFreePolicyQuota, 4);
  assert.equal(reloaded.membershipOrders.length, 2);
  assert.equal(reloaded.membershipOrders[1].prepayId, 'wx-prepay-2');
  assert.equal(reloaded.memberships.length, 1);
  assert.equal(reloaded.userWechatIdentities.length, 1);
  assert.equal(reloaded.wechatOAuthStates.length, 1);
  assert.equal(reloaded.nextId, 22);
  reopened.close();
});
