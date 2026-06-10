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
  assert.deepEqual(imported.insuranceIndicatorSnapshot, { syncedAt: '2026-05-01T00:05:00.000Z', count: 1 });
  assert.equal(imported.nextId, 11);

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
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_report_shares').get().count, 1);
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
  assert.equal(
    reloaded.insuranceIndicatorRecords.find((record) => record.id === 'ind_2')?.formulaText,
    '重疾(首次给付) = 基本保险金额',
  );
  assert.deepEqual(reloaded.insuranceIndicatorSnapshot, { syncedAt: '2026-05-01T00:08:00.000Z', count: 2 });
  assert.equal(reloaded.nextId, 11);
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
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'next_id'").get().value, '22');
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
  state.policies[0].familyId = 8;
  state.policies[0].insuredMemberId = 20;
  state.nextId = 22;

  await store.persistFamilyState({ state, includePolicies: true });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM family_profiles WHERE id = ?').get(8).payload).familyName, '更新后的测试家庭');
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_members WHERE family_id = ?').get(8).count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_report_shares WHERE token = ?').get('family-share-token').count, 1);
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM policies WHERE id = ?').get(3).payload).insuredMemberId, 20);
    assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_records').get().count, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_records WHERE id = ?').get(99).count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM insurance_indicator_records').get().count, 1);
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'next_id'").get().value, '22');
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
