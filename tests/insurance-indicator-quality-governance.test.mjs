import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { auditInsuranceIndicatorQuality } from '../scripts/insurance-indicator-quality-governance.mjs';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'indicator-governance-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE knowledge_records (
      id INTEGER PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      url TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE insurance_indicator_records (
      id TEXT PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      coverage_type TEXT,
      liability TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE policy_derived_results (
      policy_id INTEGER PRIMARY KEY,
      product_keys TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'ready',
      stale_reason TEXT,
      generated_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE product_indicator_versions (
      product_key TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 0,
      batch_id TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE indicator_update_batches (
      id TEXT PRIMARY KEY,
      created_at TEXT,
      product_keys TEXT NOT NULL DEFAULT '[]',
      changed_product_key_count INTEGER NOT NULL DEFAULT 0,
      affected_policy_count INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL
    );
  `);
  db.close();
  return { dir, dbPath };
}

function insertKnowledge(db, row) {
  const payload = {
    id: row.id,
    company: row.company,
    productName: row.productName,
    productType: row.productType || '年金险',
    salesStatus: row.salesStatus || '停售',
    title: `${row.productName}条款`,
    url: row.url || 'https://example.test/terms.pdf',
    pageText: row.pageText,
  };
  db.prepare(`
    INSERT INTO knowledge_records (id, company, product_name, url, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(row.id, row.company, row.productName, payload.url, JSON.stringify(payload));
}

function insertIndicator(db, row) {
  const payload = {
    id: row.id,
    company: row.company,
    productName: row.productName,
    coverageType: row.coverageType,
    liability: row.liability,
    value: row.value ?? null,
    valueText: row.valueText || '',
    unit: row.unit || '',
    basis: row.basis || '',
    formulaText: row.formulaText || '',
    condition: row.condition || '',
    sourceRecordId: String(row.sourceRecordId || ''),
    sourceExcerpt: row.sourceExcerpt || '',
  };
  db.prepare(`
    INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.id, row.company, row.productName, row.coverageType, row.liability, JSON.stringify(payload));
}

test('audits annuity cashflow candidates while keeping disease and medical lanes report-only', () => {
  const { dir, dbPath } = makeTempDb();
  const db = new DatabaseSync(dbPath);
  try {
    insertKnowledge(db, {
      id: 1359,
      company: '新华保险',
      productName: '尊享人生年金保险（分红型）',
      pageText: [
        '保险责任 关爱年金如被保险人于犹豫期结束的次日、每年保单生效对应日生存，本公司按首次交纳的基本责任的保险费的1%给付关爱年金。',
        '生存保险金被保险人于本合同生效后至60周岁保单生效对应日之前每满两周年的保单生效对应日生存，本公司按该保单生效对应日基本责任的保险金额的9%给付生存保险金。',
        '身故或身体全残保险金被保险人身故或身体全残，本公司给付身故或身体全残保险金。',
        '投保人意外身故或全残豁免保险费。',
      ].join(' '),
    });
    insertIndicator(db, {
      id: 'generic_cashflow',
      company: '新华保险',
      productName: '尊享人生年金保险（分红型）',
      coverageType: '现金流',
      liability: '教育/养老金/两全等返还',
      value: 1,
      valueText: '1',
      unit: '%',
      basis: '条款载明',
      sourceRecordId: '1359',
      sourceExcerpt: '关爱年金按首次交纳的基本责任的保险费的1%给付',
    });
    insertKnowledge(db, {
      id: 2000,
      company: '测试人寿',
      productName: '测试恶性肿瘤疾病保险',
      productType: '疾病保险',
      pageText: '保险责任 恶性肿瘤-重度二次确诊关爱金被保险人再次确诊恶性肿瘤-重度，我们按基本保险金额的30%给付恶性肿瘤-重度二次确诊关爱金。',
    });
    insertKnowledge(db, {
      id: 2001,
      company: '测试人寿',
      productName: '测试意外医疗保险',
      productType: '医疗保险',
      pageText: '保险责任 意外伤害医疗保险金=（该次治疗的医疗费用－其他途径获得的补偿－100元免赔额）×80%。',
    });

    const result = auditInsuranceIndicatorQuality({
      dbPath,
      knowledgeIds: [1359, 2000, 2001],
      includeExistingProducts: true,
      sampleLimit: 20,
    });

    const writeAllowed = result.candidates.filter((candidate) => candidate.writeAllowed);
    assert.equal(writeAllowed.length, 2);
    assert.ok(writeAllowed.some((candidate) => candidate.proposedIndicator.liability === '关爱年金'));
    assert.ok(writeAllowed.some((candidate) => candidate.proposedIndicator.formulaText === '生存保险金 = 基本责任保险金额 × 9%'));
    assert.ok(result.candidates.some((candidate) => candidate.lane === 'critical_illness' && candidate.writeAllowed === false));
    assert.ok(result.issues.some((issue) => issue.lane === 'medical_formula'));
    assert.equal(result.summary.writeAllowedCandidates, 2);
    assert.equal(result.summary.byLane.cashflow_annuity.writeAllowedCandidates, 2);
    assert.equal(result.summary.byLane.critical_illness.writeAllowedCandidates, 0);
    assert.equal(result.summary.byLane.medical_formula.writeAllowedCandidates, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('write mode upserts only allowed annuity cashflow candidates', () => {
  const { dir, dbPath } = makeTempDb();
  const db = new DatabaseSync(dbPath);
  try {
    insertKnowledge(db, {
      id: 1359,
      company: '新华保险',
      productName: '尊享人生年金保险（分红型）',
      pageText: [
        '保险责任 关爱年金如被保险人于犹豫期结束的次日、每年保单生效对应日生存，本公司按首次交纳的基本责任的保险费的1%给付关爱年金。',
        '生存保险金被保险人于本合同生效后至60周岁保单生效对应日之前每满两周年的保单生效对应日生存，本公司按该保单生效对应日基本责任的保险金额的9%给付生存保险金。',
      ].join(' '),
    });
    insertKnowledge(db, {
      id: 2000,
      company: '测试人寿',
      productName: '测试恶性肿瘤疾病保险',
      productType: '疾病保险',
      pageText: '保险责任 恶性肿瘤-重度二次确诊关爱金被保险人再次确诊恶性肿瘤-重度，我们按基本保险金额的30%给付恶性肿瘤-重度二次确诊关爱金。',
    });

    const dryRun = auditInsuranceIndicatorQuality({
      dbPath,
      knowledgeIds: [1359, 2000],
      includeExistingProducts: true,
    });
    assert.equal(dryRun.dryRun, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM insurance_indicator_records').get().count, 0);

    const written = auditInsuranceIndicatorQuality({
      dbPath,
      knowledgeIds: [1359, 2000],
      includeExistingProducts: true,
      writeAnnuityCashflow: true,
    });

    assert.equal(written.dryRun, false);
    assert.equal(written.indicatorUpserts, 2);
    const rows = db.prepare('SELECT coverage_type, liability, payload FROM insurance_indicator_records ORDER BY liability').all();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.liability), ['关爱年金', '生存保险金']);
    assert.ok(rows.every((row) => row.coverage_type === '现金流'));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('annuity lane recognizes broader return-money liability names', () => {
  const { dir, dbPath } = makeTempDb();
  const db = new DatabaseSync(dbPath);
  try {
    insertKnowledge(db, {
      id: 3000,
      company: '测试人寿',
      productName: '测试返钱年金保险',
      pageText: [
        '保险责任 贺寿金被保险人生存至年满60周岁后的首个保单周年日，我们按基本保险金额的20%给付贺寿金。',
        '大学教育金被保险人在18周岁至21周岁每个保单周年日生存，我们按基本保险金额的10%给付大学教育金。',
        '保证领取保险金若保证领取期内仍应给付年金，我们按保证领取总额扣除已领取年金后的余额给付保证领取保险金。',
      ].join(' '),
    });

    const result = auditInsuranceIndicatorQuality({
      dbPath,
      knowledgeIds: [3000],
      includeExistingProducts: true,
    });

    const annuityLiabilities = result.candidates
      .filter((candidate) => candidate.lane === 'cashflow_annuity')
      .map((candidate) => candidate.proposedIndicator.liability);
    assert.ok(annuityLiabilities.includes('贺寿金'));
    assert.ok(annuityLiabilities.includes('大学教育金'));
    assert.ok(result.summary.byLane.cashflow_annuity.candidates >= 2);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('governance treats basic annuity clauses as writable and suppresses equivalent existing formulas', () => {
  const { dir, dbPath } = makeTempDb();
  const db = new DatabaseSync(dbPath);
  try {
    insertKnowledge(db, {
      id: 4000,
      company: '新华保险',
      productName: '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）',
      salesStatus: '在售',
      pageText: [
        '保险责任 本合同的保险责任分为基本责任和可选责任。在本合同保险期间内，我们根据您的选择承担下列保险责任：1.基本责任',
        '（1）生存保险金 若男性被保险人在投保时未满55周岁，女性被保险人在投保时未满50周岁，被保险人于本合同生效满五年的首个保单周年日含起至养老年金开始领取日不含之前，在每个保单周年日零时生存，我们按基本保险金额给付生存保险金。',
        '（2）养老年金 被保险人于养老年金开始领取日含起至保险期间届满之前，在每个保单周年日零时生存，我们按基本保险金额给付养老年金。',
        '（3）满期生存保险金 被保险人生存至保险期间届满，我们按本合同实际交纳的保险费给付满期生存保险金，本合同终止。',
        '2.可选责任 （1）成长教育金 本合同生效满五年之后，若被保险人于15周岁、18周岁、21周岁、24周岁的每个保单周年日零时生存，我们按基本保险金额的2倍给付成长教育金。',
        '（2）成家立业金 被保险人于30周岁保单周年日零时生存，我们按基本保险金额的2倍给付成家立业金。',
      ].join(' '),
    });
    insertIndicator(db, {
      id: 'existing_maturity',
      company: '新华保险',
      productName: '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）',
      coverageType: '现金流',
      liability: '满期生存保险金',
      unit: '公式',
      basis: '已交保费',
      formulaText: '满期生存保险金 = 实际交纳保险费',
      sourceRecordId: '4000',
    });
    insertIndicator(db, {
      id: 'existing_career',
      company: '新华保险',
      productName: '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）',
      coverageType: '现金流',
      liability: '成家立业金',
      value: 2,
      unit: '倍',
      basis: '基本保险金额',
      formulaText: '基本保险金额 × 2',
      sourceRecordId: '4000',
    });

    const result = auditInsuranceIndicatorQuality({
      dbPath,
      knowledgeIds: [4000],
      includeExistingProducts: true,
      sampleLimit: 20,
    });

    const candidatesByLiability = new Map(result.candidates.map((candidate) => [
      candidate.proposedIndicator.liability,
      candidate,
    ]));
    assert.equal(candidatesByLiability.get('生存保险金')?.writeAllowed, true);
    assert.equal(candidatesByLiability.get('养老年金')?.writeAllowed, true);
    assert.equal(candidatesByLiability.has('满期生存保险金'), false);
    assert.equal(candidatesByLiability.has('成家立业金'), false);
    assert.equal(candidatesByLiability.get('成长教育金')?.writeAllowed, false);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('governance blocks single-formula writes for multi-rate annuity clauses', () => {
  const { dir, dbPath } = makeTempDb();
  const db = new DatabaseSync(dbPath);
  try {
    insertKnowledge(db, {
      id: 5000,
      company: '新华保险',
      productName: '新华人寿保险股份有限公司尊尚人生两全保险（分红型）',
      productType: '两全保险',
      pageText: [
        '保险责任 1.基本责任',
        '（1）生存保险金 被保险人于本合同生效满三年起至60周岁保单生效对应日之前，在每一保单生效对应日零时生存，本公司按该保单生效对应日基本责任的保险金额的5%给付生存保险金；',
        '被保险人于60周岁保单生效对应日起至80周岁保单生效对应日期间，在每一保单生效对应日零时生存，本公司按该保单生效对应日基本责任的保险金额的10%给付生存保险金。',
      ].join(' '),
    });

    const result = auditInsuranceIndicatorQuality({
      dbPath,
      knowledgeIds: [5000],
      includeExistingProducts: true,
    });

    const candidate = result.candidates.find((item) => item.proposedIndicator.liability === '生存保险金');
    assert.equal(candidate?.lane, 'cashflow_annuity');
    assert.equal(candidate?.writeAllowed, false);
    assert.equal(candidate?.blockedReason, 'cashflow_candidate_not_high_confidence');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
