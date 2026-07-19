import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

import { createCashflowStore, createCashValueStore } from '../server/cashflow-store.mjs';
import { createAgentQuestionRouter } from '../server/agent-question-router.service.mjs';
import { dispatchPendingTransferRegenerationJobs, startTransferRegenerationRecovery } from '../server/agent-confirmation.service.mjs';
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

test('sqlite store loads only authorized family rows for Agent queries', async (t) => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const seedStatePath = path.join(dir, 'state.json');
  await writeJson(seedStatePath, {
    users: [{ id: 7, mobile: '13800138000', status: 'active' }],
    officialDomainProfiles: [{ id: 'profile-1', company: '测试保险', officialDomains: ['example.test'] }],
    familyProfiles: [
      { id: 71, ownerUserId: 7, familyName: '授权家庭', status: 'active' },
      { id: 72, ownerUserId: 8, familyName: '其他家庭', status: 'active' },
    ],
    familyMembers: [{ id: 711, familyId: 71, name: '成员', status: 'active' }],
    policies: [
      { id: 712, userId: 7, familyId: 71, company: '测试保险', name: '测试保单', status: 'active' },
      { id: 713, userId: 8, familyId: 71, company: '其他保险', name: '越权保单', status: 'active' },
    ],
    familyReports: [
      { id: 714, familyId: 71, ownerUserId: 7, status: 'active', generatedAt: '2026-07-14T01:00:00.000Z' },
      { id: 715, familyId: 71, ownerUserId: 8, status: 'active', generatedAt: '2026-07-14T02:00:00.000Z' },
      { id: 716, familyId: 71, ownerUserId: null, ownerGuestId: '', status: 'active', generatedAt: '2026-07-14T03:00:00.000Z' },
      { id: 717, familyId: 71, ownerUserId: null, ownerGuestId: 'guest-other', status: 'active', generatedAt: '2026-07-14T04:00:00.000Z' },
    ],
    familySalesReviews: [
      { id: 718, familyId: 71, ownerUserId: 7, status: 'active', generatedAt: '2026-07-14T01:00:00.000Z' },
      { id: 719, familyId: 71, ownerUserId: 8, status: 'active', generatedAt: '2026-07-14T02:00:00.000Z' },
      { id: 720, familyId: 71, ownerUserId: null, ownerGuestId: '', status: 'active', generatedAt: '2026-07-14T03:00:00.000Z' },
      { id: 721, familyId: 71, ownerUserId: null, ownerGuestId: 'guest-other', status: 'active', generatedAt: '2026-07-14T04:00:00.000Z' },
    ],
  });
  const store = await createSqliteStateStore({ dbPath, seedStatePath });
  t.after(() => store.close());
  await store.load();
  const identityState = await store.loadAgentIdentityState();
  assert.deepEqual(identityState.users.map((row) => row.id), [7]);
  assert.deepEqual(identityState.agentChannelIdentities, []);
  assert.deepEqual((await store.loadOfficialDomainProfiles()).map((row) => row.id), ['profile-1']);
  assert.deepEqual((await store.listAuthorizedFamilyProfiles({ internalUserId: 7 })).map((row) => row.id), [71]);
  const loaded = await store.loadAuthorizedFamilyState({ familyId: 71, internalUserId: 7 });
  assert.equal(loaded.family.id, 71);
  assert.equal(loaded.state.familyMembers.length, 1);
  assert.deepEqual(loaded.state.policies.map((row) => row.id), [712]);
  assert.deepEqual(loaded.state.familyReports.map((row) => row.id), [714, 716]);
  assert.deepEqual(loaded.state.familySalesReviews.map((row) => row.id), [718, 720]);
  assert.equal(await store.loadAuthorizedFamilyState({ familyId: 72, internalUserId: 7 }), null);
});

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
    familySalesChatThreads: [{
      id: 30,
      familyId: 8,
      ownerUserId: 1,
      ownerGuestId: '',
      status: 'active',
      title: '微信话术',
      createdAt: '2026-05-01T00:11:10.000Z',
      updatedAt: '2026-05-01T00:11:20.000Z',
    }],
    familySalesChatMessages: [
      { id: 31, threadId: 30, familyId: 8, role: 'user', content: '帮我改成微信话术', status: 'complete', createdAt: '2026-05-01T00:11:10.000Z' },
      { id: 32, threadId: 30, familyId: 8, role: 'assistant', content: '可以这样发客户', status: 'complete', createdAt: '2026-05-01T00:11:20.000Z' },
    ],
    familySalesMemories: [{
      id: 6,
      familyId: 8,
      ownerUserId: 1,
      ownerGuestId: '',
      kind: 'objection',
      content: '客户预算敏感，优先基础方案',
      evidenceMessageIds: [31, 32],
      sourceThreadId: 30,
      status: 'active',
      confidence: 0.92,
      createdAt: '2026-05-01T00:11:30.000Z',
      updatedAt: '2026-05-01T00:11:30.000Z',
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
  assert.equal(imported.familySalesChatThreads.length, 1);
  assert.equal(imported.familySalesChatThreads[0].title, '微信话术');
  assert.equal(imported.familySalesChatMessages.length, 2);
  assert.equal(imported.familySalesChatMessages[1].content, '可以这样发客户');
  assert.equal(imported.familySalesMemories.length, 1);
  assert.equal(imported.familySalesMemories[0].content, '客户预算敏感，优先基础方案');
  assert.equal(imported.familyReports.length, 1);
  assert.equal(imported.familyReports[0].summary.issueCount, 1);
  assert.equal(imported.familyReportIssues.length, 1);
  assert.equal(imported.familyReportIssues[0].reportId, 12);
  assert.equal(imported.familyReportCorrections.length, 1);
  assert.equal(imported.familyReportCorrections[0].status, 'auto_applied');
  assert.deepEqual(imported.insuranceIndicatorSnapshot, { syncedAt: '2026-05-01T00:05:00.000Z', count: 1 });
  assert.equal(imported.nextId, 33);

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
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_sales_chat_threads').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_sales_chat_messages').get().count, 2);
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
  assert.equal(reloaded.familySalesChatThreads.length, 1);
  assert.equal(reloaded.familySalesChatThreads[0].title, '微信话术');
  assert.equal(reloaded.familySalesChatMessages.length, 2);
  assert.equal(reloaded.familySalesChatMessages[1].content, '可以这样发客户');
  assert.equal(reloaded.familySalesMemories.length, 1);
  assert.equal(reloaded.familySalesMemories[0].kind, 'objection');
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
  assert.equal(reloaded.nextId, 33);
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
  assert.equal(reloadedAfterRestart.familySalesChatThreads.length, 1);
  assert.equal(reloadedAfterRestart.familySalesChatThreads[0].title, '微信话术');
  assert.equal(reloadedAfterRestart.familySalesChatMessages.length, 2);
  assert.equal(reloadedAfterRestart.familySalesChatMessages[1].content, '可以这样发客户');
  assert.equal(reloadedAfterRestart.familySalesMemories.length, 1);
  assert.equal(reloadedAfterRestart.familySalesMemories[0].sourceThreadId, 30);
  assert.equal(reloadedAfterRestart.familyReports.length, 1);
  assert.equal(reloadedAfterRestart.familyReports[0].summary.issueCount, 1);
  assert.equal(reloadedAfterRestart.familyReportIssues.length, 1);
  assert.equal(reloadedAfterRestart.familyReportIssues[0].reportId, 12);
  assert.equal(reloadedAfterRestart.familyReportCorrections.length, 1);
  assert.equal(reloadedAfterRestart.familyReportCorrections[0].reportId, 12);
  assert.deepEqual(reloadedAfterRestart.insuranceIndicatorSnapshot, { syncedAt: '2026-05-01T00:08:00.000Z', count: 2 });
  reopened.close();
});

test('sqlite state store persists a single state document without rewriting knowledge tables', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  const state = await store.load();
  state.knowledgeRecords.push({ id: 1, company: '测试保险', productName: '测试产品', url: 'https://example.test/terms' });
  await store.persist(state);

  await store.persistStateDocument({
    state,
    key: 'responsibilityGenerationGovernance',
    value: {
      enabled: true,
      promptRules: ['后台规则'],
      blockedResponsibilityTitles: ['免赔额'],
      failureExamples: [],
      fallbackMode: 'official_text_after_second_failure',
      updatedAt: '2026-07-05T00:00:00.000Z',
    },
  });

  assert.equal(store.db.prepare('SELECT count(*) AS count FROM knowledge_records').get().count, 1);
  assert.equal(
    JSON.parse(store.db.prepare('SELECT payload FROM state_documents WHERE key = ?').get('responsibilityGenerationGovernance').payload).blockedResponsibilityTitles[0],
    '免赔额',
  );
  const reloaded = await store.load();
  assert.equal(reloaded.knowledgeRecords.length, 1);
  assert.equal(reloaded.responsibilityGenerationGovernance.promptRules[0], '后台规则');
  store.close();
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
  state.familySalesChatThreads.push({
    id: 23,
    familyId: 8,
    ownerGuestId: 'guest-family',
    status: 'active',
    title: '预算异议',
    createdAt: '2026-06-08T00:03:00.000Z',
    updatedAt: '2026-06-08T00:04:00.000Z',
  });
  state.familySalesChatMessages.push(
    { id: 24, threadId: 23, familyId: 8, role: 'user', content: '预算不够怎么办', status: 'complete', createdAt: '2026-06-08T00:03:00.000Z' },
    { id: 25, threadId: 23, familyId: 8, role: 'assistant', content: '先拆基础方案', status: 'complete', createdAt: '2026-06-08T00:04:00.000Z' },
  );
  store.db.exec(`
    CREATE TRIGGER family_sales_memories_requires_version
      BEFORE INSERT ON family_sales_memories
      WHEN COALESCE(NEW.version, 0) <= 0
      BEGIN SELECT RAISE(ABORT, 'family sales memory version is required'); END;
  `);
  state.familySalesMemories.push({
    id: 6,
    familyId: 8,
    ownerGuestId: 'guest-family',
    kind: 'strategy',
    content: '预算异议先拆基础方案',
    evidenceMessageIds: [24, 25],
    sourceThreadId: 23,
    status: 'active',
    confidence: 0.9,
    createdAt: '2026-06-08T00:05:00.000Z',
    updatedAt: '2026-06-08T00:05:00.000Z',
  });
  state.policies[0].familyId = 8;
  state.policies[0].insuredMemberId = 20;
  state.nextId = 26;

  await store.persistFamilyState({ state, includePolicies: true });

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM family_profiles WHERE id = ?').get(8).payload).familyName, '更新后的测试家庭');
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_members WHERE family_id = ?').get(8).count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_report_shares WHERE token = ?').get('family-share-token').count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_sales_reviews WHERE family_id = ?').get(8).count, 1);
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM family_sales_reviews WHERE id = ?').get(22).payload).content, '家庭销售建议已保存');
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_sales_chat_threads WHERE family_id = ?').get(8).count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_sales_chat_messages WHERE thread_id = ?').get(23).count, 2);
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM family_sales_chat_messages WHERE id = ?').get(25).payload).content, '先拆基础方案');
    assert.equal(db.prepare('SELECT count(*) AS count FROM family_sales_memories WHERE family_id = ?').get(8).count, 1);
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM family_sales_memories WHERE id = ?').get(6).payload).content, '预算异议先拆基础方案');
    assert.equal(db.prepare('SELECT version FROM family_sales_memories WHERE id = ?').get(6).version, 1);
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM policies WHERE id = ?').get(3).payload).insuredMemberId, 20);
    assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_records').get().count, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_records WHERE id = ?').get(99).count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM insurance_indicator_records').get().count, 1);
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'next_id'").get().value, '26');
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
        contentBlocks: [
          {
            blockKey: 'productPurpose',
            title: '产品主要做什么',
            enabled: true,
            editable: true,
            order: 1,
            content: '这是一份以身故或身体全残保障为主的终身寿险。',
          },
          {
            blockKey: 'attentionNotes',
            title: '注意事项',
            enabled: true,
            editable: true,
            order: 4,
            content: '具体金额需要结合保单信息计算。',
          },
        ],
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
    assert.equal(reloaded.productCustomerResponsibilitySummaries[0].summaryJson.contentBlocks.length, 2);
    assert.equal(reloaded.productCustomerResponsibilitySummaries[0].summaryJson.contentBlocks[0].title, '产品主要做什么');

    const read = await store.findProductCustomerResponsibilitySummary({
      productKey: summary.productKey,
      summaryVersion: summary.summaryVersion,
      sourceDigest: summary.sourceDigest,
    });
    assert.equal(read?.summaryJson?.mainResponsibilities?.[0]?.title, '身故或身体全残保险金');
    assert.equal(read?.summaryJson?.contentBlocks?.[1]?.title, '注意事项');
    assert.deepEqual(state.productCustomerResponsibilitySummaries, reloaded.productCustomerResponsibilitySummaries);
  } finally {
    store.close();
  }
});

test('sqlite state store fresh load exposes empty product customer summary generation runs', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  try {
    const state = await store.load();
    assert.deepEqual(state.productCustomerSummaryGenerationRuns, []);
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

test('sqlite state store reloads product customer summary generation runs from db columns', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  try {
    const state = await store.load();
    await store.persistProductCustomerSummaryGenerationRun({
      state,
      run: {
        id: 'customer_summary_run:company_product:新华保险:鑫荣耀:v22:columns-a',
        productKey: 'company_product:新华保险:鑫荣耀',
        company: '新华保险',
        productName: '鑫荣耀',
        summaryVersion: 'customer-summary-v22-structured-rag',
        status: 'needs_model_review',
        modelName: 'deepseek-v4-flash',
        qualityIssues: [{ code: 'stale_payload_issue' }],
        rawPreview: 'stale-preview-a',
        createdAt: '2026-07-01T00:00:00.000Z',
        payload: { marker: 'stale-a' },
      },
    });
    await store.persistProductCustomerSummaryGenerationRun({
      state,
      run: {
        id: 'customer_summary_run:company_product:新华保险:鑫荣耀:v22:columns-b',
        productKey: 'company_product:新华保险:鑫荣耀',
        company: '新华保险',
        productName: '鑫荣耀',
        summaryVersion: 'customer-summary-v22-structured-rag',
        status: 'failed',
        modelName: 'deepseek-v4-pro',
        qualityIssues: [{ code: 'other_issue' }],
        rawPreview: 'preview-b',
        createdAt: '2026-07-01T00:02:00.000Z',
        payload: { marker: 'b' },
      },
    });
    store.db.prepare(`
      UPDATE product_customer_summary_generation_runs
      SET status = ?,
        quality_issues_json = ?,
        raw_preview = ?,
        created_at = ?
      WHERE id = ?
    `).run(
      'needs_source_review',
      JSON.stringify([{ code: 'db_column_issue', keyword: '官方条款' }]),
      'db-column-preview',
      '2026-07-01T00:03:00.000Z',
      'customer_summary_run:company_product:新华保险:鑫荣耀:v22:columns-a',
    );

    const reloaded = await store.load();
    assert.deepEqual(
      reloaded.productCustomerSummaryGenerationRuns.map((run) => run.id),
      [
        'customer_summary_run:company_product:新华保险:鑫荣耀:v22:columns-a',
        'customer_summary_run:company_product:新华保险:鑫荣耀:v22:columns-b',
      ],
    );
    assert.equal(reloaded.productCustomerSummaryGenerationRuns[0].status, 'needs_source_review');
    assert.deepEqual(reloaded.productCustomerSummaryGenerationRuns[0].qualityIssues, [
      { code: 'db_column_issue', keyword: '官方条款' },
    ]);
    assert.equal(reloaded.productCustomerSummaryGenerationRuns[0].rawPreview, 'db-column-preview');
    assert.equal(reloaded.productCustomerSummaryGenerationRuns[0].createdAt, '2026-07-01T00:03:00.000Z');
    assert.deepEqual(reloaded.productCustomerSummaryGenerationRuns[0].payload, { marker: 'stale-a' });
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

test('sqlite state store ignores empty cached product customer responsibility summaries', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  try {
    const state = await store.load();
    const summary = {
      id: 'customer_summary:company_product:新华保险:吉祥至尊两全保险（分红型）:v1',
      productKey: 'company_product:新华保险:吉祥至尊两全保险（分红型）',
      company: '新华保险',
      productName: '吉祥至尊两全保险（分红型）',
      summaryVersion: 'customer-summary-v1',
      status: 'ready',
      headline: '',
      summaryJson: {
        company: '',
        productName: '',
        headline: '',
        mainResponsibilities: [],
        notices: [],
        requiredPolicyFields: [],
        sourceUrls: [],
      },
      sourceUrls: ['https://example.test/terms.pdf'],
      sourceDigest: 'digest-empty',
      modelProvider: 'deepseek',
      modelName: 'deepseek-v4-pro',
      generatedAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:00:00.000Z',
      payload: {
        productKey: 'company_product:新华保险:吉祥至尊两全保险（分红型）',
        source: 'generated',
      },
    };

    await store.persistProductCustomerResponsibilitySummary({ state, summary });

    const reloaded = await store.load();
    assert.equal(reloaded.productCustomerResponsibilitySummaries.length, 0);
    assert.equal(state.productCustomerResponsibilitySummaries.length, 0);

    const read = await store.findProductCustomerResponsibilitySummary({
      productKey: summary.productKey,
      summaryVersion: summary.summaryVersion,
      sourceDigest: summary.sourceDigest,
    });
    assert.equal(read, null);
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

test('sqlite state store persists responsibility lookup artifacts into knowledge, indicator, and card tables', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  try {
    const state = await store.load();
    const result = await store.persistResponsibilityLookupArtifacts({
      state,
      knowledgeRecords: [
        {
          company: '测试保险',
          productName: '测试重疾保险',
          title: '测试重疾保险条款',
          url: 'https://official.example-life.test/terms.pdf',
          pageText: '保险责任 本公司给付重大疾病保险金。',
          official: true,
          sourceKind: 'insurer_official',
        },
      ],
      indicatorRecords: [
        {
          id: 'ind_card_basic_test',
          company: '测试保险',
          productName: '测试重疾保险',
          coverageType: '疾病保障',
          liability: '重大疾病保险金',
        },
      ],
      responsibilityCards: [
        {
          id: 'product_responsibility_card:company_product:测试保险:测试重疾保险:0000:重大疾病保险金',
          productKey: 'company_product:测试保险:测试重疾保险',
          company: '测试保险',
          productName: '测试重疾保险',
          title: '重大疾病保险金',
          category: '疾病保障',
          cashflowTreatment: 'claim_contingent',
          calculationStatus: 'claim_contingent',
          sourceUrl: 'https://official.example-life.test/terms.pdf',
          payload: {
            title: '重大疾病保险金',
            company: '测试保险',
            productName: '测试重疾保险',
          },
        },
      ],
    });

    assert.equal(result.knowledgeRecordCount, 1);
    assert.equal(result.indicatorRecordCount, 1);
    assert.equal(result.responsibilityCardCount, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM knowledge_records').get().count, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM insurance_indicator_records').get().count, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM product_responsibility_cards').get().count, 1);
    const cardPayload = JSON.parse(store.db.prepare('SELECT payload FROM product_responsibility_cards LIMIT 1').get().payload);
    assert.equal(cardPayload.title, '重大疾病保险金');

    const reloaded = await store.load();
    assert.equal(reloaded.knowledgeRecords[0].productName, '测试重疾保险');
    assert.equal(reloaded.insuranceIndicatorRecords[0].liability, '重大疾病保险金');
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

test('sqlite state store drafts and transactionally publishes agent question policy versions', async () => {
  const dir = await makeTempDir();
  const store = await createSqliteStateStore({ dbPath: path.join(dir, 'policy-ocr.sqlite') });
  const first = await store.createAgentQuestionPolicyDraft({
    version: 1,
    policies: [{ key: 'chat', decision: 'execute' }],
    runtimeSettings: { fallbackHistoryMessageLimit: 12, productContextTtlMinutes: 90 },
    actor: 'admin:1',
    createdAt: '2026-07-12T01:00:00.000Z',
  });
  const second = await store.createAgentQuestionPolicyDraft({
    version: 2,
    policies: [{ key: 'chat', decision: 'propose' }],
    actor: 'admin:2',
    createdAt: '2026-07-12T02:00:00.000Z',
  });

  await store.publishAgentQuestionPolicyVersion({ id: first.id, actor: 'admin:1', publishedAt: '2026-07-12T01:05:00.000Z' });
  await store.publishAgentQuestionPolicyVersion({ id: second.id, actor: 'admin:2', publishedAt: '2026-07-12T02:05:00.000Z' });
  const published = await store.getPublishedAgentQuestionPolicyVersion();

  assert.equal(published.version, 2);
  assert.equal(published.status, 'published');
  assert.equal(published.actor, 'admin:2');
  assert.deepEqual(published.policies, [{ key: 'chat', decision: 'propose' }]);
  assert.deepEqual(published.runtimeSettings, { fallbackHistoryMessageLimit: 40, productContextTtlMinutes: 30 });
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM agent_question_policy_versions WHERE status = 'published'").get().count, 1);
  assert.equal(store.db.prepare('SELECT status FROM agent_question_policy_versions WHERE id = ?').get(first.id).status, 'archived');
  assert.equal((await store.publishAgentQuestionPolicyVersion({ id: second.id, actor: 'admin:2' })).status, 'published');
  await assert.rejects(
    store.publishAgentQuestionPolicyVersion({ id: first.id, actor: 'admin:1' }),
    /must be a draft/i,
  );
  store.close();
});

test('sqlite state store allocates draft versions and rolls back policies with runtime settings atomically', async () => {
  const dir = await makeTempDir();
  const store = await createSqliteStateStore({ dbPath: path.join(dir, 'policy-ocr.sqlite') });
  const drafts = await Promise.all(Array.from({ length: 4 }, (_, index) => store.createAgentQuestionPolicyDraft({
    policies: [{ key: 'chat' }],
    runtimeSettings: index === 0 ? { fallbackHistoryMessageLimit: 12, productContextTtlMinutes: 90 } : undefined,
    actor: 'admin',
  })));
  assert.deepEqual(drafts.map((row) => row.version).sort((a, b) => a - b), [1, 2, 3, 4]);
  await store.publishAgentQuestionPolicyVersion({ id: drafts[0].id, actor: 'admin' });
  const rolled = await store.rollbackAgentQuestionPolicyVersion({ sourceId: drafts[0].id, actor: 'admin' });
  assert.equal(rolled.status, 'published');
  assert.equal(rolled.version, 5);
  assert.deepEqual(rolled.runtimeSettings, { fallbackHistoryMessageLimit: 12, productContextTtlMinutes: 90 });
  assert.equal(store.db.prepare("SELECT count(*) count FROM agent_question_policy_versions WHERE status = 'published'").get().count, 1);
  assert.equal(store.db.prepare("SELECT count(*) count FROM agent_question_policy_versions WHERE version = 5 AND status = 'draft'").get().count, 0);
  store.close();
});

test('sqlite state store rejects unsafe agent question policy JSON', async () => {
  const dir = await makeTempDir();
  const store = await createSqliteStateStore({ dbPath: path.join(dir, 'policy-ocr.sqlite') });
  const base = { actor: 'admin:1', createdAt: '2026-07-12T01:00:00.000Z' };
  await assert.rejects(store.createAgentQuestionPolicyDraft({ ...base, version: 1, policies: Array.from({ length: 257 }, (_, index) => ({ key: `rule-${index}` })) }), /256 entries/i);
  await assert.rejects(store.createAgentQuestionPolicyDraft({ ...base, version: 2, policies: [Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`field${index}`, index]))] }), /32 fields/i);
  await assert.rejects(store.createAgentQuestionPolicyDraft({ ...base, version: 3, policies: [{ key: 'large', detail: 'x'.repeat(263_000) }] }), /bytes/i);
  await assert.rejects(store.createAgentQuestionPolicyDraft({ ...base, version: 4, policies: [new Date()] }), /plain object/i);
  const circular = { key: 'circular' };
  circular.self = circular;
  await assert.rejects(store.createAgentQuestionPolicyDraft({ ...base, version: 5, policies: [circular] }), /valid JSON values/i);
  await assert.rejects(store.createAgentQuestionPolicyDraft({ ...base, version: 6, policies: [{ key: 'lossy', value: undefined }] }), /valid JSON values/i);
  await assert.rejects(store.createAgentQuestionPolicyDraft({ ...base, version: 7, policies: [{ key: 'lossy', value: Number.NaN }] }), /valid JSON values/i);
  store.close();
});

test('sqlite state store appends and limits unknown agent questions', async () => {
  const dir = await makeTempDir();
  const store = await createSqliteStateStore({ dbPath: path.join(dir, 'policy-ocr.sqlite') });
  await store.appendAgentUnknownQuestion({ userId: 7, messageRef: 'msg-1', question: '第一个问题', actor: 'router', createdAt: '2026-07-12T03:00:00.000Z', payload: { intent: 'unknown_read' } });
  await store.appendAgentUnknownQuestion({ userId: 8, messageRef: 'msg-2', question: '第二个问题', actor: 'router', createdAt: '2026-07-12T03:01:00.000Z', payload: { intent: 'unknown_write' } });

  const rows = await store.listAgentUnknownQuestions({ limit: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, 8);
  assert.equal(rows[0].messageRef, 'msg-2');
  assert.deepEqual(rows[0].payload, { intent: 'unknown_write' });
  store.close();
});

test('sqlite state store atomically consumes owned, unexpired agent action confirmations once', async () => {
  const dir = await makeTempDir();
  const store = await createSqliteStateStore({ dbPath: path.join(dir, 'policy-ocr.sqlite') });
  const confirmation = await store.createAgentActionConfirmation({
    id: 'confirm-1',
    userId: 7,
    action: 'save_memory',
    actor: 'sales_champion',
    expiresAt: '2026-07-12T04:10:00.000Z',
    createdAt: '2026-07-12T04:00:00.000Z',
    payload: { memory: '客户预算敏感' },
  });
  assert.equal(confirmation.status, 'pending');
  await assert.rejects(
    store.consumeAgentActionConfirmation({ id: confirmation.id, userId: 8, consumedAt: '2026-07-12T04:01:00.000Z' }),
    /ownership/i,
  );
  assert.equal((await store.consumeAgentActionConfirmation({ id: confirmation.id, userId: 7, consumedAt: '2026-07-12T04:01:00.000Z' })).status, 'consumed');
  assert.equal((await store.consumeAgentActionConfirmation({ id: confirmation.id, userId: 7, consumedAt: '2026-07-12T04:02:00.000Z' })).status, 'already_consumed');

  await store.createAgentActionConfirmation({ id: 'confirm-expired', userId: 7, action: 'save_memory', actor: 'sales_champion', expiresAt: '2026-07-12T03:59:00.000Z', createdAt: '2026-07-12T03:00:00.000Z' });
  assert.equal((await store.consumeAgentActionConfirmation({ id: 'confirm-expired', userId: 7, consumedAt: '2026-07-12T04:00:00.000Z' })).status, 'expired');
  store.close();
});

test('sqlite state store atomically transfers a policy, preserves evidence, invalidates derived views, and audits before/after', async () => {
  const dir = await makeTempDir();
  const store = await createSqliteStateStore({ dbPath: path.join(dir, 'policy-ocr.sqlite') });
  await store.load();
  await store.persist({
    ...createInitialState(),
    familyProfiles: [{ id: 10, ownerUserId: 7, familyName: '来源家庭', status: 'active' }, { id: 20, ownerUserId: 7, familyName: '目标家庭', status: 'active' }],
    familyMembers: [{ id: 201, familyId: 20, name: '李四', status: 'active' }],
    policies: [{ id: 301, userId: 7, familyId: 10, policyNo: 'P-1234', applicantMemberId: 201, insuredMemberId: 201, sourceEvidence: { page: 8 }, ocr: { digest: 'keep-me' } }],
    familyReports: [{ id: 401, familyId: 10, ownerUserId: 7, status: 'active' }, { id: 402, familyId: 20, ownerUserId: 7, status: 'active' }],
    familySalesReviews: [{ id: 501, familyId: 10, ownerUserId: 7, status: 'active' }, { id: 502, familyId: 20, ownerUserId: 7, status: 'active' }],
    familyReportShares: [{ id: 601, familyId: 10, ownerUserId: 7, token: 'secret', status: 'active' }],
  });
  await store.createAgentActionConfirmation({
    id: 'transfer-1', userId: 7, action: 'transfer_policy_between_families', actor: 'agent_confirmation',
    createdAt: '2026-07-12T04:00:00.000Z', expiresAt: '2026-07-12T04:05:00.000Z',
    payload: { sourceFamilyId: 10, targetFamilyId: 20, policyId: 301, targetApplicantMemberId: 201, targetInsuredMemberId: 201, stateVersion: 0, stateHash: '', impact: {} },
  });
  const result = await store.transferPolicyBetweenFamilies({ confirmationId: 'transfer-1', userId: 7, consumedAt: '2026-07-12T04:01:00.000Z' });
  assert.equal(result.status, 'transferred');
  const loaded = await store.load();
  assert.equal(loaded.policies[0].familyId, 20);
  assert.deepEqual(loaded.policies[0].sourceEvidence, { page: 8 });
  assert.deepEqual(loaded.policies[0].ocr, { digest: 'keep-me' });
  assert.deepEqual(loaded.familyReports.map((row) => row.status), ['stale', 'stale']);
  assert.deepEqual(loaded.familySalesReviews.map((row) => row.status), ['stale', 'stale']);
  assert.equal(loaded.familyReportShares[0].status, 'revoked');
  const audit = store.db.prepare('SELECT * FROM agent_policy_transfer_audits').get();
  assert.deepEqual(JSON.parse(audit.before_payload), { familyId: 10, applicantMemberId: 201, insuredMemberId: 201 });
  assert.deepEqual(JSON.parse(audit.after_payload), { familyId: 20, applicantMemberId: 201, insuredMemberId: 201 });
  const outbox = store.db.prepare('SELECT * FROM agent_policy_transfer_regeneration_outbox ORDER BY id').all();
  assert.equal(outbox.length, 4);
  assert.deepEqual(outbox.map((row) => row.status), ['pending', 'pending', 'pending', 'pending']);
  assert.equal(new Set(outbox.map((row) => row.dedupe_key)).size, 4);
  assert.equal((await store.transferPolicyBetweenFamilies({ confirmationId: 'transfer-1', userId: 7, consumedAt: '2026-07-12T04:02:00.000Z' })).status, 'already_consumed');
  assert.equal(store.db.prepare('SELECT count(*) count FROM agent_policy_transfer_audits').get().count, 1);
  store.close();
});

test('policy transfer confirmation hides expired and other-user confirmations without mutation', async () => {
  const dir = await makeTempDir();
  const store = await createSqliteStateStore({ dbPath: path.join(dir, 'policy-ocr.sqlite') });
  await store.load();
  await store.createAgentActionConfirmation({ id: 'expired-transfer', userId: 7, action: 'transfer_policy_between_families', actor: 'agent_confirmation', createdAt: '2026-07-12T03:00:00.000Z', expiresAt: '2026-07-12T03:05:00.000Z', payload: {} });
  assert.equal((await store.transferPolicyBetweenFamilies({ confirmationId: 'expired-transfer', userId: 8, consumedAt: '2026-07-12T04:00:00.000Z' })).status, 'not_found');
  assert.equal((await store.transferPolicyBetweenFamilies({ confirmationId: 'expired-transfer', userId: 7, consumedAt: '2026-07-12T04:00:00.000Z' })).status, 'expired');
  assert.equal(store.db.prepare('SELECT count(*) count FROM agent_policy_transfer_audits').get().count, 0);
  assert.equal(store.db.prepare('SELECT count(*) count FROM agent_policy_transfer_regeneration_outbox').get().count, 0);
  store.close();
});

test('policy transfer duplicate guard normalizes policy number and company-product identity', async () => {
  for (const duplicate of [
    { id: 302, familyId: 20, policyNo: ' px_1234 ' },
    { id: 302, familyId: 20, company: ' 测试保险 ', name: '守护一生' },
  ]) {
    const dir = await makeTempDir();
    const store = await createSqliteStateStore({ dbPath: path.join(dir, 'policy-ocr.sqlite') });
    await store.load();
    const source = duplicate.policyNo
      ? { id: 301, familyId: 10, policyNo: 'PX-1234', applicantMemberId: 201, insuredMemberId: 201 }
      : { id: 301, familyId: 10, company: '测试保险', name: '守护一生', applicantMemberId: 201, insuredMemberId: 201 };
    await store.persist({ ...createInitialState(), familyProfiles: [{ id: 10, ownerUserId: 7, status: 'active' }, { id: 20, ownerUserId: 7, status: 'active' }], familyMembers: [{ id: 201, familyId: 20, status: 'active' }], policies: [source, duplicate] });
    await store.createAgentActionConfirmation({ id: 'duplicate-transfer', userId: 7, action: 'transfer_policy_between_families', actor: 'agent_confirmation', createdAt: '2026-07-12T04:00:00.000Z', expiresAt: '2026-07-12T04:05:00.000Z', payload: { sourceFamilyId: 10, targetFamilyId: 20, policyId: 301, targetApplicantMemberId: 201, targetInsuredMemberId: 201, stateVersion: 0, stateHash: '' } });
    assert.equal((await store.transferPolicyBetweenFamilies({ confirmationId: 'duplicate-transfer', userId: 7, consumedAt: '2026-07-12T04:01:00.000Z' })).status, 'duplicate_policy');
    assert.equal(JSON.parse(store.db.prepare('SELECT payload FROM policies WHERE id = 301').get().payload).familyId, 10);
    store.close();
  }
});

test('transfer regeneration outbox retries failed delivery without repeating dispatched jobs', async () => {
  const dir = await makeTempDir();
  const store = await createSqliteStateStore({ dbPath: path.join(dir, 'policy-ocr.sqlite') });
  await store.load();
  const created = '2026-07-12T04:00:00.000Z';
  for (const [familyId, type] of [[10, 'family_report'], [10, 'family_sales_review']]) {
    store.db.prepare(`INSERT INTO agent_policy_transfer_regeneration_outbox
      (confirmation_id,user_id,family_id,job_type,dedupe_key,status,attempts,last_error,created_at,updated_at,dispatched_at)
      VALUES (?,?,?,?,?,'pending',0,'',?,?,'')`).run('recover-1', 7, familyId, type, `recover-1:${familyId}:${type}`, created, created);
  }
  const calls = [];
  let fail = true;
  const queue = { async enqueueUnique(job) { calls.push(job); if (fail && job.type === 'family_sales_review') { fail = false; throw new Error('offline'); } } };
  assert.deepEqual(await dispatchPendingTransferRegenerationJobs({ store, reportQueue: queue, confirmationId: 'recover-1', now: () => '2026-07-12T04:01:00.000Z' }), { dispatched: 1, failed: 1 });
  assert.deepEqual(store.db.prepare('SELECT status FROM agent_policy_transfer_regeneration_outbox ORDER BY id').all().map((row) => row.status), ['dispatched', 'failed']);
  assert.deepEqual(await dispatchPendingTransferRegenerationJobs({ store, reportQueue: queue, confirmationId: 'recover-1', now: () => '2026-07-12T04:02:00.000Z' }), { dispatched: 1, failed: 0 });
  assert.deepEqual(store.db.prepare('SELECT status FROM agent_policy_transfer_regeneration_outbox ORDER BY id').all().map((row) => row.status), ['dispatched', 'dispatched']);
  assert.equal(calls.length, 3);
  store.close();
});

test('concurrent dispatchers lease each outbox job once and recovery drains jobs after reopen', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const seed = await createSqliteStateStore({ dbPath });
  await seed.load();
  const created = '2026-07-12T04:00:00.000Z';
  for (let index = 0; index < 4; index += 1) {
    seed.db.prepare(`INSERT INTO agent_policy_transfer_regeneration_outbox
      (confirmation_id,user_id,family_id,job_type,dedupe_key,status,attempts,last_error,created_at,updated_at,dispatched_at)
      VALUES (?,?,?,?,?,'pending',0,'',?,?,'')`).run('restart-1', 7, index < 2 ? 10 : 20, index % 2 ? 'family_sales_review' : 'family_report', `restart-job-${index}`, created, created);
  }
  seed.close();
  const first = await createSqliteStateStore({ dbPath });
  const second = await createSqliteStateStore({ dbPath });
  const counts = new Map();
  const queue = { async enqueueUnique(job) { counts.set(job.dedupeKey, (counts.get(job.dedupeKey) || 0) + 1); } };
  await Promise.all([
    dispatchPendingTransferRegenerationJobs({ store: first, reportQueue: queue, workerId: 'worker-a', now: () => '2026-07-12T04:01:00.000Z' }),
    dispatchPendingTransferRegenerationJobs({ store: second, reportQueue: queue, workerId: 'worker-b', now: () => '2026-07-12T04:01:00.000Z' }),
  ]);
  assert.deepEqual([...counts.values()], [1, 1, 1, 1]);
  first.db.prepare("UPDATE agent_policy_transfer_regeneration_outbox SET status = 'failed', dispatched_at = '', claim_token = '', lease_until = '' WHERE id = 4").run();
  first.close();
  second.close();
  const reopened = await createSqliteStateStore({ dbPath });
  let intervalCallback;
  const recovery = startTransferRegenerationRecovery({
    store: reopened, reportQueue: queue, workerId: 'restart-worker', now: () => '2026-07-12T04:02:00.000Z',
    setIntervalFn(callback) { intervalCallback = callback; return { unref() {} }; }, clearIntervalFn() {},
  });
  assert.deepEqual(await recovery.initialDrain, { dispatched: 1, failed: 0 });
  assert.equal(typeof intervalCallback, 'function');
  assert.equal(counts.get('restart-job-3'), 2);
  assert.equal(reopened.db.prepare("SELECT count(*) count FROM agent_policy_transfer_regeneration_outbox WHERE status = 'dispatched'").get().count, 4);
  recovery.stop();
  reopened.close();
});

test('sqlite store migrates pre-lease transfer outbox rows without losing pending work', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE agent_policy_transfer_regeneration_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, confirmation_id TEXT NOT NULL, user_id INTEGER NOT NULL, family_id INTEGER NOT NULL,
    job_type TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK (status IN ('pending','failed','dispatched')),
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, dispatched_at TEXT NOT NULL DEFAULT '');`);
  db.prepare(`INSERT INTO agent_policy_transfer_regeneration_outbox
    (confirmation_id,user_id,family_id,job_type,dedupe_key,status,created_at,updated_at) VALUES (?,?,?,?,?,'pending',?,?)`)
    .run('legacy-1', 7, 10, 'family_report', 'legacy-key', '2026-07-12T04:00:00.000Z', '2026-07-12T04:00:00.000Z');
  db.close();
  const store = await createSqliteStateStore({ dbPath });
  assert.equal(store.db.prepare("SELECT count(*) count FROM pragma_table_info('agent_policy_transfer_regeneration_outbox') WHERE name IN ('claim_token','lease_until')").get().count, 2);
  assert.equal((await store.claimPendingTransferRegenerationJobs({ workerId: 'migration-worker', now: '2026-07-12T04:01:00.000Z' }))[0].dedupeKey, 'legacy-key');
  store.close();
});

test('competing policy transfer workers produce one mutation, one audit, and one outbox set', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  await store.load();
  await store.persist({
    ...createInitialState(),
    familyProfiles: [{ id: 10, ownerUserId: 7, familyName: '来源', status: 'active' }, { id: 20, ownerUserId: 7, familyName: '目标', status: 'active' }],
    familyMembers: [{ id: 201, familyId: 20, name: '成员', status: 'active' }],
    policies: [{ id: 301, userId: 7, familyId: 10, policyNo: 'P-CONCURRENT', applicantMemberId: 201, insuredMemberId: 201 }],
  });
  await store.createAgentActionConfirmation({ id: 'concurrent-transfer', userId: 7, action: 'transfer_policy_between_families', actor: 'agent_confirmation', createdAt: '2026-07-12T04:00:00.000Z', expiresAt: '2026-07-12T04:05:00.000Z', payload: { sourceFamilyId: 10, targetFamilyId: 20, policyId: 301, targetApplicantMemberId: 201, targetInsuredMemberId: 201, stateVersion: 0, stateHash: '' } });
  store.close();
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createSqliteStateStore } = await import(workerData.moduleUrl);
      const workerStore = await createSqliteStateStore({ dbPath: workerData.dbPath });
      parentPort.postMessage({ type: 'ready' });
      parentPort.once('message', async () => {
        try { parentPort.postMessage({ type: 'result', value: await workerStore.transferPolicyBetweenFamilies(workerData.input) }); }
        catch (error) { parentPort.postMessage({ type: 'error', message: error.stack || error.message }); }
        finally { workerStore.close(); }
      });
    })().catch((error) => parentPort.postMessage({ type: 'error', message: error.stack || error.message }));
  `;
  const spawn = () => {
    const worker = new Worker(workerSource, { eval: true, workerData: { dbPath, moduleUrl: new URL('../server/sqlite-state-store.mjs', import.meta.url).href, input: { confirmationId: 'concurrent-transfer', userId: 7, consumedAt: '2026-07-12T04:01:00.000Z' } } });
    const ready = new Promise((resolve, reject) => { worker.on('message', (message) => message.type === 'ready' && resolve()); worker.once('error', reject); });
    const result = new Promise((resolve, reject) => { worker.on('message', (message) => message.type === 'result' ? resolve(message.value) : message.type === 'error' && reject(new Error(message.message))); worker.once('error', reject); });
    return { worker, ready, result };
  };
  const workers = [spawn(), spawn()];
  await Promise.all(workers.map((item) => item.ready));
  workers.forEach((item) => item.worker.postMessage('go'));
  const results = await Promise.all(workers.map((item) => item.result));
  assert.deepEqual(results.map((row) => row.status).sort(), ['already_consumed', 'transferred']);
  const verify = await createSqliteStateStore({ dbPath });
  assert.equal((await verify.load()).policies[0].familyId, 20);
  assert.equal(verify.db.prepare('SELECT count(*) count FROM agent_policy_transfer_audits').get().count, 1);
  assert.equal(verify.db.prepare('SELECT count(*) count FROM agent_policy_transfer_regeneration_outbox').get().count, 4);
  verify.close();
});

test('sqlite state store normalizes confirmation timestamps and serializes competing consumers', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  try {
    const confirmation = await store.createAgentActionConfirmation({
      id: 'confirm-offset',
      userId: 7,
      action: 'save_memory',
      actor: 'sales_champion',
      createdAt: '2026-07-12T11:00:00+08:00',
      expiresAt: '2026-07-12T12:00:00+08:00',
    });
    assert.equal(confirmation.createdAt, '2026-07-12T03:00:00.000Z');
    assert.equal(confirmation.expiresAt, '2026-07-12T04:00:00.000Z');
    store.close();

    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { createSqliteStateStore } = await import(workerData.storeModuleUrl);
        const workerStore = await createSqliteStateStore({ dbPath: workerData.dbPath });
        parentPort.postMessage({ type: 'ready' });
        parentPort.once('message', async ({ type }) => {
          if (type !== 'go') return;
          try {
            const result = await workerStore.consumeAgentActionConfirmation(workerData.consumeArgs);
            parentPort.postMessage({ type: 'result', result });
          } catch (error) {
            parentPort.postMessage({ type: 'error', message: error.message, stack: error.stack });
          } finally {
            workerStore.close();
          }
        });
      })().catch((error) => parentPort.postMessage({ type: 'error', message: error.message, stack: error.stack }));
    `;
    const storeModuleUrl = new URL('../server/sqlite-state-store.mjs', import.meta.url).href;
    const createConsumer = (consumedAt) => {
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: {
          dbPath,
          storeModuleUrl,
          consumeArgs: { id: confirmation.id, userId: 7, consumedAt },
        },
      });
      const ready = new Promise((resolve, reject) => {
        worker.once('message', (message) => message.type === 'ready' ? resolve() : reject(new Error(message.stack || message.message)));
        worker.once('error', reject);
      });
      const result = new Promise((resolve, reject) => {
        const onMessage = (message) => {
          if (message.type === 'result') resolve(message.result);
          if (message.type === 'error') reject(new Error(message.stack || message.message));
        };
        worker.on('message', onMessage);
        worker.once('error', reject);
        worker.once('exit', (code) => {
          if (code !== 0) reject(new Error(`confirmation worker exited with code ${code}`));
        });
      });
      return { worker, ready, result };
    };
    const consumers = [
      createConsumer('2026-07-12T11:59:00+08:00'),
      createConsumer('2026-07-12T11:59:00+08:00'),
    ];
    await Promise.all(consumers.map((consumer) => consumer.ready));
    for (const consumer of consumers) consumer.worker.postMessage({ type: 'go' });
    const results = await Promise.all(consumers.map((consumer) => consumer.result));
    assert.deepEqual(results.map((row) => row.status).sort(), ['already_consumed', 'consumed']);
    assert.equal(results.find((row) => row.status === 'consumed').consumedAt, '2026-07-12T03:59:00.000Z');
  } finally {
    try {
      store.close();
    } catch {
      // The store is closed before workers open independent connections.
    }
  }
});

test('sqlite state store persists traceable bounded agent route audit events', async () => {
  const dir = await makeTempDir();
  const store = await createSqliteStateStore({ dbPath: path.join(dir, 'policy-ocr.sqlite') });
  const policy = await store.createAgentQuestionPolicyDraft({ version: 3, policies: [{ key: 'family_summary' }], actor: 'admin:1' });
  await store.publishAgentQuestionPolicyVersion({ id: policy.id, actor: 'admin:1' });
  await store.appendAgentRouteAuditEvent({
    policyVersion: 3,
    userId: 7,
    messageRef: 'msg-route-1',
    decision: 'execute',
    actor: 'router',
    createdAt: '2026-07-12T05:00:00.000Z',
    payload: { intent: 'family_summary', handler: 'insurance_expert' },
  });
  const rows = await store.listAgentRouteAuditEvents({ limit: 10, userId: 7 });
  assert.equal(rows[0].policyVersion, 3);
  assert.equal(rows[0].userId, 7);
  assert.equal(rows[0].messageRef, 'msg-route-1');
  assert.equal(rows[0].decision, 'execute');
  assert.deepEqual(rows[0].payload, { intent: 'family_summary', handler: 'insurance_expert' });
  await assert.rejects(
    store.appendAgentRouteAuditEvent({ policyVersion: 3, userId: 7, messageRef: 'msg-route-2', decision: 'execute', actor: 'router', payload: { detail: 'x'.repeat(17_000) } }),
    /payload.*bytes/i,
  );
  await assert.rejects(
    store.appendAgentRouteAuditEvent({ policyVersion: 3, userId: 7, messageRef: 'msg-route-3', decision: 'execute', actor: 'router', payload: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`field${index}`, index])) }),
    /payload.*fields/i,
  );
  await assert.rejects(
    store.appendAgentRouteAuditEvent({ policyVersion: 999, userId: 7, messageRef: 'msg-route-4', decision: 'execute', actor: 'router' }),
    /policy version.*not found/i,
  );
  await assert.rejects(
    store.appendAgentRouteAuditEvent({ policyVersion: 3, userId: 7, messageRef: 'msg-route-5', decision: 'execute', actor: 'router', payload: { lost: () => true } }),
    /valid JSON values/i,
  );
  await assert.rejects(
    store.appendAgentRouteAuditEvent({ policyVersion: 3, userId: 7, messageRef: 'msg-route-6', decision: 'execute', actor: 'router', payload: { invalid: Infinity } }),
    /valid JSON values/i,
  );
  store.close();
});

test('sqlite state store persists complete built-in router audits without a published policy version', async () => {
  const dir = await makeTempDir();
  const store = await createSqliteStateStore({ dbPath: path.join(dir, 'policy-ocr.sqlite') });
  const router = createAgentQuestionRouter({
    store,
    handlers: { sales_champion: async () => ({ interaction: { type: 'answer', text: '你好' } }) },
    clock: () => new Date('2026-07-12T08:00:00.000Z'),
  });

  assert.equal((await router.route({
    internalUserId: 7,
    messageRef: 'msg-built-in-chat',
    candidate: { intent: 'chat', question: '你好', confidence: 0.9, requestedOperation: 'read' },
  })).decision, 'execute');
  assert.equal((await router.route({
    internalUserId: 7,
    messageRef: 'msg-built-in-unknown',
    candidate: { intent: 'unregistered', question: '查一下', confidence: 0.9, requestedOperation: 'read' },
  })).decision, 'open_web');

  const rows = await store.listAgentRouteAuditEvents({ userId: 7 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].policyVersion, null);
  assert.equal(rows[0].policySource, 'built_in');
  assert.equal(rows[0].payload.policyKey, 'unknown_read');
  assert.equal(rows[0].payload.candidate.intent, 'unknown');
  assert.equal(rows[0].payload.candidate.confidence, 0.9);
  assert.deepEqual(rows[0].payload.authorizedResourceIds, []);
  assert.equal(rows[0].payload.result, 'unknown_read_fallback');
  assert.equal(rows[1].payload.result, 'handled');
  store.close();
});

test('built-in route audit migrates the legacy non-null policy version table', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE agent_route_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_version INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      message_ref TEXT NOT NULL,
      decision TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  legacy.close();

  const store = await createSqliteStateStore({ dbPath });
  await store.recordAgentRouteAudit({
    policyVersion: null,
    policySource: 'built_in',
    userId: 7,
    messageRef: 'msg-migrated',
    decision: 'open_web',
    actor: 'router',
    candidate: { intent: 'unknown', entities: {}, confidence: 0.5 },
    policyKey: 'unknown_read',
    authorizedResourceIds: [],
    fallback: true,
    result: 'unknown_read_fallback',
  });
  const [row] = await store.listAgentRouteAuditEvents({ userId: 7 });
  assert.equal(row.policyVersion, null);
  assert.equal(row.policySource, 'built_in');
  store.close();
});

test('published route audit still rejects a missing policy version', async () => {
  const dir = await makeTempDir();
  const store = await createSqliteStateStore({ dbPath: path.join(dir, 'policy-ocr.sqlite') });
  await assert.rejects(
    store.recordAgentRouteAudit({
      policyVersion: 999,
      policySource: 'published',
      userId: 7,
      messageRef: 'msg-missing-policy',
      decision: 'execute',
      actor: 'router',
      candidate: { intent: 'chat', entities: {}, confidence: 1 },
      policyKey: 'chat',
      authorizedResourceIds: [],
      fallback: false,
      result: 'handled',
    }),
    /policy version.*not found/i,
  );
  store.close();
});

test('router attributes a published-policy fallback to the built-in policy source', async () => {
  const dir = await makeTempDir();
  const store = await createSqliteStateStore({ dbPath: path.join(dir, 'policy-ocr.sqlite') });
  const draft = await store.createAgentQuestionPolicyDraft({
    version: 10,
    actor: 'admin:1',
    policies: [{
      key: 'coverage_report', intent: 'coverage_report', decision: 'execute', handler: 'insurance_expert',
      operation: 'read', confirmation: 'not_required', outputMode: 'structured', tool: 'coverage_report', enabled: false,
    }],
  });
  await store.publishAgentQuestionPolicyVersion({ id: draft.id, actor: 'admin:1' });
  const router = createAgentQuestionRouter({ store, clock: () => new Date('2026-07-12T08:00:00.000Z') });

  const result = await router.route({
    internalUserId: 7,
    messageRef: 'msg-published-fallback',
    candidate: { intent: 'coverage_report', question: '看看保障', confidence: 0.9, requestedOperation: 'read' },
  });
  const [audit] = await store.listAgentRouteAuditEvents({ userId: 7 });

  assert.equal(result.decision, 'open_web');
  assert.equal(audit.policySource, 'built_in');
  assert.equal(audit.policyVersion, null);
  assert.equal(audit.payload.policyKey, 'unknown_read');
  assert.equal(audit.payload.evaluatedPublishedVersion, 10);
  store.close();
});

test('router audit drops arbitrary intents and entity keys containing sensitive text', async () => {
  const dir = await makeTempDir();
  const store = await createSqliteStateStore({ dbPath: path.join(dir, 'policy-ocr.sqlite') });
  const router = createAgentQuestionRouter({ store, clock: () => new Date('2026-07-12T08:00:00.000Z') });
  await router.route({
    internalUserId: 7,
    messageRef: 'msg-redacted-audit',
    candidate: {
      intent: '身份证_310000000000000000',
      question: '测试',
      entities: {
        familyName: '张三家庭',
        '身份证310000000000000000': '秘密',
      },
      confidence: 0.8,
      requestedOperation: 'read',
    },
  });

  const [audit] = await store.listAgentRouteAuditEvents({ userId: 7 });
  assert.equal(audit.payload.candidate.intent, 'unknown');
  assert.deepEqual(audit.payload.candidate.entities, { familyName: '[redacted]' });
  assert.equal(JSON.stringify(audit).includes('310000000000000000'), false);
  store.close();
});
