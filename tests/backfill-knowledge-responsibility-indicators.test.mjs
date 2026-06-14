import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { backfillKnowledgeResponsibilityIndicators } from '../scripts/backfill-knowledge-responsibility-indicators.mjs';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-indicators-'));
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
  `);
  db.close();
  return { dir, dbPath };
}

function insertKnowledge(db, row) {
  db.prepare(`
    INSERT INTO knowledge_records (id, company, product_name, url, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(row.id, row.company, row.productName, row.url || 'https://example.test/terms.pdf', JSON.stringify({
    id: row.id,
    company: row.company,
    productName: row.productName,
    productType: row.productType || '健康险',
    pageText: row.pageText,
    url: row.url || 'https://example.test/terms.pdf',
    title: `${row.productName}条款`,
  }));
}

test('backfills high-confidence knowledge responsibility indicators only', () => {
  const { dir, dbPath } = makeTempDb();
  const db = new DatabaseSync(dbPath);
  try {
    insertKnowledge(db, {
      id: 1,
      company: '测试人寿',
      productName: '旧批次测试保险',
      pageText: '保险责任 身故保险金被保险人身故，我们按基本保险金额给付身故保险金。',
    });
    insertKnowledge(db, {
      id: 100,
      company: '测试人寿',
      productName: '测试住院医疗保险',
      pageText: '保险责任 页住院医疗保险金被保险人在医院接受住院治疗，对实际发生的合理且必要的医疗费用，扣除已获补偿、免赔额后按给付比例给付。',
    });
    insertKnowledge(db, {
      id: 101,
      company: '测试人寿',
      productName: '测试重疾保险',
      pageText: '保险责任 2.4.5 可选责任四身故保险金被保险人因意外伤害或等待期后非意外伤害身故，我们按本合同的基本保险金额给付身故保险金。',
    });
    insertKnowledge(db, {
      id: 102,
      company: '测试人寿',
      productName: '测试弱文本医疗保险',
      pageText: '保险责任 按照必要的医疗费用按照以下标准给付医疗保险金被保险人提交申请后，本公司审核资料。',
    });
    insertKnowledge(db, {
      id: 103,
      company: '测试人寿',
      productName: '已有指标产品',
      pageText: '保险责任 身故保险金被保险人身故，我们按基本保险金额给付身故保险金。',
    });
    insertKnowledge(db, {
      id: 104,
      company: '测试人寿',
      productName: '测试年金身故保险',
      productType: '年金保险',
      pageText: '保险责任 身故保险金被保险人身故，按保险单载明的年金领取金额给付身故保险金。',
    });
    insertKnowledge(db, {
      id: 105,
      company: '测试人寿',
      productName: '测试脏片段保险',
      pageText: '保险责任 若同时符合多项责任，我们仅按基本保险金额给付其中一项保险金。后该种轻症疾病保险金不再重复给付。期内应给付的养老保险金按基本保险金额10%给付。保证领取期间内应给付的养老年金按基本保险金额10%给付。范围)给付各项保险金。表中所列相应残疾程度对应的给付比例给付意外残疾保险金。之和不超过您投保的保障计划对应的一般门急诊医疗保险金。给付比例对于一般医疗保险金为100%。下的各项保险金按保险金额给付。各对应意外残疾保险金按给付比例给付。各该项残疾保险金累计给付。双倍相应的身故或全残保险金按保险金额给付。等值于基本保险金按保险金额给付。',
    });
    insertKnowledge(db, {
      id: 106,
      company: '测试人寿',
      productName: '测试后续年金保险',
      productType: '年金保险',
      pageText: '保险责任 后续年金被保险人生存，我们按保险单载明的年金领取金额给付后续年金。',
    });
    insertKnowledge(db, {
      id: 107,
      company: '测试人寿',
      productName: '测试明确比例医疗保险',
      pageText: '保险责任 住院医疗保险金被保险人在医院接受住院治疗，对实际发生的合理且必要的医疗费用，扣除已获补偿、免赔额后按百分之百给付住院医疗保险金。',
    });
    insertKnowledge(db, {
      id: 108,
      company: '测试人寿',
      productName: '测试津贴保险',
      pageText: '保险责任 住院津贴保险金被保险人住院治疗，我们按给付天数乘以日住院津贴额200元给付住院津贴保险金。',
    });
    insertKnowledge(db, {
      id: 109,
      company: '测试人寿',
      productName: '测试高残保险',
      pageText: '保险责任 身故或身体高度残疾保险金被保险人身故或身体高度残疾，我们按基本保险金额给付身故或身体高度残疾保险金。',
    });
    insertKnowledge(db, {
      id: 110,
      company: '测试人寿',
      productName: '测试津贴串医疗比例保险',
      pageText: '保险责任 住院津贴保险金被保险人住院治疗，我们按实际住院日数乘以日住院津贴金额给付住院津贴保险金。医疗费用保险金计算方式为实际合理医疗费用扣除免赔额后按90%给付。',
    });
    insertKnowledge(db, {
      id: 111,
      company: '测试人寿',
      productName: '测试意外伤残比例保险',
      pageText: '保险责任 意外伤残保险金被保险人因意外伤害导致伤残，我们按评定结果所对应标准规定的给付比例乘以本合同基本保险金额给付意外伤残保险金。',
    });
    insertKnowledge(db, {
      id: 112,
      company: '测试人寿',
      productName: '测试限额清洗医疗保险',
      pageText: '保险责任 限额特定药品医疗费用保险金被保险人实际发生合理且必要的特定药品费用，我们按100%给付特定药品医疗费用保险金。',
    });
    db.prepare(`
      INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('existing_indicator', '测试人寿', '已有指标产品', '身故保障', '身故保险金', JSON.stringify({ id: 'existing_indicator' }));
  } finally {
    db.close();
  }

  try {
    const dryRun = backfillKnowledgeResponsibilityIndicators({ dbPath, minKnowledgeId: 100, sampleLimit: 10 });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.candidateProducts, 12);
    assert.equal(dryRun.productsWithIndicators, 8);
    assert.equal(dryRun.indicatorUpserts, 8);
    assert.equal(dryRun.skippedProducts, 4);

    const includeExisting = backfillKnowledgeResponsibilityIndicators({
      dbPath,
      minKnowledgeId: 100,
      includeExistingProducts: true,
      sampleLimit: 10,
    });
    assert.equal(includeExisting.candidateProducts, 13);
    assert.equal(includeExisting.productsWithIndicators, 9);
    assert.equal(includeExisting.indicatorUpserts, 9);

    const write = backfillKnowledgeResponsibilityIndicators({ dbPath, write: true, minKnowledgeId: 100, sampleLimit: 10 });
    assert.equal(write.indicatorUpserts, 8);

    const readDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = readDb.prepare(`
        SELECT liability, coverage_type, payload
          FROM insurance_indicator_records
         WHERE id LIKE 'ind_knowledge_auto_%'
         ORDER BY liability
      `).all();
      assert.equal(rows.length, 8);
      assert.ok(rows.some((row) => row.liability === '身故保险金'));
      assert.ok(rows.some((row) => row.liability === '住院医疗保险金'));
      assert.ok(rows.some((row) => row.liability === '后续年金'));
      assert.ok(rows.some((row) => row.liability === '住院津贴保险金'));
      assert.ok(rows.some((row) => row.liability === '身故或身体高度残疾保险金'));
      assert.ok(rows.some((row) => row.liability === '意外伤残保险金'));
      assert.ok(rows.some((row) => row.liability === '特定药品医疗费用保险金'));
      assert.ok(!rows.some((row) => row.liability === '其中一项保险金'));
      assert.ok(!rows.some((row) => row.liability === '后该种轻症疾病保险金'));
      assert.ok(!rows.some((row) => row.liability === '期内应给付的养老保险金'));
      assert.ok(!rows.some((row) => row.liability === '保证领取期间内应给付的养老年金'));
      assert.ok(!rows.some((row) => row.liability === '范围)给付各项保险金'));
      assert.ok(!rows.some((row) => row.liability === '表中所列相应残疾程度对应的给付比例给付意外残疾保险金'));
      assert.ok(!rows.some((row) => row.liability === '之和不超过您投保的保障计划对应的一般门急诊医疗保险金'));
      assert.ok(!rows.some((row) => row.liability === '给付比例对于一般医疗保险金'));
      assert.ok(!rows.some((row) => row.liability === '下的各项保险金'));
      assert.ok(!rows.some((row) => row.liability === '各对应意外残疾保险金'));
      assert.ok(!rows.some((row) => row.liability === '各该项残疾保险金'));
      assert.ok(!rows.some((row) => row.liability === '双倍相应的身故或全残保险金'));
      assert.ok(!rows.some((row) => row.liability === '等值于基本保险金'));
      assert.ok(!rows.some((row) => row.liability === '限额特定药品医疗费用保险金'));
      assert.equal(rows.find((row) => row.liability === '身故保险金').coverage_type, '身故保障');
      assert.equal(rows.find((row) => row.liability === '后续年金').coverage_type, '现金流');
      assert.equal(rows.find((row) => row.liability === '住院津贴保险金').coverage_type, '津贴保障');
      assert.equal(rows.find((row) => row.liability === '身故或身体高度残疾保险金').coverage_type, '身故保障');
      const optionalPayload = JSON.parse(rows.find((row) => row.liability === '身故保险金').payload);
      assert.equal(optionalPayload.responsibilityScope, 'optional');
      const medicalPayload = JSON.parse(rows.find((row) => row.liability === '住院医疗保险金').payload);
      assert.equal(medicalPayload.responsibilityScope, 'basic');
      assert.equal(medicalPayload.formulaText, '住院医疗保险金 = (实际合理医疗费用 - 已获补偿 - 免赔额/起付金额) × 100%');
      assert.equal(medicalPayload.value, 100);
      assert.equal(medicalPayload.unit, '%');
      assert.equal(medicalPayload.sourceRecordId, '107');
      const allowancePayload = JSON.parse(rows.find((row) => row.liability === '住院津贴保险金').payload);
      assert.ok(
        [
          '住院津贴保险金 = 给付天数 × 日津贴额 200 元',
          '住院津贴保险金 = 给付天数 × 日津贴额',
        ].includes(allowancePayload.formulaText)
      );
      assert.doesNotMatch(allowancePayload.formulaText, /实际合理医疗费用/u);
      const disabilityPayload = JSON.parse(rows.find((row) => row.liability === '意外伤残保险金').payload);
      assert.equal(disabilityPayload.formulaText, '意外伤残保险金 = 基本保险金额 × 伤残/残疾等级给付比例');
      assert.equal(disabilityPayload.unit, '公式');
      const total = readDb.prepare('SELECT COUNT(*) AS count FROM insurance_indicator_records').get().count;
      assert.equal(total, 9);
    } finally {
      readDb.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
