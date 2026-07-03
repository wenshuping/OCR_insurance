import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { importReviewedResponsibilityArtifacts } from '../scripts/import-reviewed-responsibility-artifacts.mjs';
import { materializeProductResponsibilityCards } from '../scripts/materialize-product-responsibility-cards.mjs';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-responsibility-cards-'));
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
    CREATE TABLE optional_responsibility_records (
      id TEXT PRIMARY KEY,
      company TEXT,
      product_name TEXT,
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
  `).run(row.id, row.company, row.productName, row.url, JSON.stringify({
    id: row.id,
    company: row.company,
    productName: row.productName,
    url: row.url,
    official: true,
    materialType: 'terms',
    title: `${row.productName}条款`,
    pageText: row.pageText,
  }));
}

function insertIndicator(db, row) {
  db.prepare(`
    INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.id, row.company, row.productName, row.coverageType, row.liability, JSON.stringify({
    id: row.id,
    company: row.company,
    productName: row.productName,
    coverageType: row.coverageType,
    liability: row.liability,
    value: row.value,
    unit: row.unit,
    basis: row.basis,
    formulaText: row.formulaText,
    condition: row.condition,
    triggerCondition: row.triggerCondition,
    sourceUrl: row.sourceUrl,
    sourceExcerpt: row.sourceExcerpt,
  }));
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function seedMeimanAnkang(dbPath) {
  const db = new DatabaseSync(dbPath);
  const company = '新华保险';
  const productName = '美满安康两全保险(A款）（分红型）';
  const sourceUrl = 'https://static-cdn.newchinalife.com/ncl/pdf/meimanankang.pdf';
  const survivalExcerpt = '生存保险金 被保险人在本合同生效后每满三周年的保单生效对应日生存，本公司按该保单生效对应日有效保险金额的9%给付生存保险金，直至被保险人身故。';
  try {
    insertKnowledge(db, {
      id: 1,
      company,
      productName,
      url: sourceUrl,
      pageText: [
        '保险责任 在本合同保险期间内，本公司承担下列保险责任：',
        `1.生存保险金 ${survivalExcerpt}`,
        '2 . 祝 寿 金 被保险人生存至满六十六周岁的保单生效对应日，本公司按该保单生效对应日有效保险金额一次性给付祝寿金。',
        '3.身故保险金 被保险人身故，本公司按约定给付身故保险金。',
        '4.全残豁免保 险费 被保险人身体全残，您可免交续期保险费。',
      ].join('\n'),
    });
    insertIndicator(db, {
      id: 'ind_survival',
      company,
      productName,
      coverageType: '现金流',
      liability: '教育/养老金/两全等返还',
      value: 9,
      unit: '%',
      basis: '保险金额',
      sourceUrl,
      sourceExcerpt: survivalExcerpt,
    });
    insertIndicator(db, {
      id: 'ind_payout',
      company,
      productName,
      coverageType: '规则参数',
      liability: '赔付方式',
      unit: '方式',
      basis: '保险责任赔付机制',
      sourceUrl,
      sourceExcerpt: '保险责任包括生存保险金、祝寿金、身故保险金和全残豁免保险费。',
    });
    return { company, productName };
  } finally {
    db.close();
  }
}

test('materializeProductResponsibilityCards dry-run builds product cards without writing', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const { company, productName } = seedMeimanAnkang(dbPath);
    const result = materializeProductResponsibilityCards({
      dbPath,
      company,
      productName,
      now: '2026-06-22T00:00:00.000Z',
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.selectedProducts, 1);
    assert.equal(result.productsWithCards, 1);
    assert.equal(result.cardsGenerated, 4);
    assert.equal(result.samples[0].cards.find((card) => card.title === '生存保险金')?.calculationStatus, 'calculable');
    assert.equal(result.samples[0].cards.find((card) => card.title === '生存保险金')?.indicatorCheckStatus, 'verified_calculable');
    assert.equal(result.samples[0].cards.find((card) => card.title === '祝寿金')?.cashflowTreatment, 'scheduled_cashflow');
    assert.equal(result.samples[0].cards.find((card) => card.title === '祝寿金')?.calculationStatus, 'calculable');

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(tableExists(db, 'product_responsibility_cards'), false);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('materializeProductResponsibilityCards can require indicators before selecting products', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const { company, productName } = seedMeimanAnkang(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      insertKnowledge(db, {
        id: 11,
        company: '测试保险',
        productName: '只有条款没有指标保险',
        url: 'https://official.example.com/no-indicator.pdf',
        pageText: '保险责任 在本合同保险期间内，本公司按约定承担身故保险金责任。',
      });
    } finally {
      db.close();
    }

    const result = materializeProductResponsibilityCards({
      dbPath,
      requireIndicators: true,
      now: '2026-06-22T00:00:30.000Z',
    });

    assert.equal(result.filters.requireIndicators, true);
    assert.equal(result.selectedProducts, 1);
    assert.equal(result.samples[0].company, company);
    assert.equal(result.samples[0].productName, productName);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('materializeProductResponsibilityCards can write only products missing cards', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const { company, productName } = seedMeimanAnkang(dbPath);
    const existingWrite = materializeProductResponsibilityCards({
      dbPath,
      company,
      productName,
      write: true,
      now: '2026-06-22T00:00:00.000Z',
    });
    assert.equal(existingWrite.insertedRows, 4);

    const nextCompany = '测试保险';
    const nextProduct = '新补责任卡两全保险';
    const nextSourceUrl = 'https://official.example.com/new-card.pdf';
    const nextExcerpt = '满期保险金 被保险人生存至保险期间届满，本公司按基本保险金额给付满期保险金。';
    const db = new DatabaseSync(dbPath);
    try {
      insertKnowledge(db, {
        id: 12,
        company: nextCompany,
        productName: nextProduct,
        url: nextSourceUrl,
        pageText: `保险责任 在本合同保险期间内，本公司承担下列保险责任：${nextExcerpt}`,
      });
      insertIndicator(db, {
        id: 'ind_next_maturity',
        company: nextCompany,
        productName: nextProduct,
        coverageType: '现金流',
        liability: '满期保险金',
        unit: '%',
        value: 100,
        basis: '基本保险金额',
        formulaText: '满期保险金 = 基本保险金额 × 100%',
        sourceUrl: nextSourceUrl,
        sourceExcerpt: nextExcerpt,
      });
    } finally {
      db.close();
    }

    const missingOnlyWrite = materializeProductResponsibilityCards({
      dbPath,
      write: true,
      onlyMissingCards: true,
      requireIndicators: true,
      now: '2026-06-22T00:01:00.000Z',
    });

    assert.equal(missingOnlyWrite.filters.onlyMissingCards, true);
    assert.equal(missingOnlyWrite.filters.requireIndicators, true);
    assert.equal(missingOnlyWrite.selectedProducts, 1);
    assert.equal(missingOnlyWrite.samples[0].productName, nextProduct);
    assert.equal(missingOnlyWrite.deletedRows, 0);
    assert.equal(missingOnlyWrite.insertedRows, 1);

    const readDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(readDb.prepare('SELECT COUNT(*) AS count FROM product_responsibility_cards WHERE company = ? AND product_name = ?').get(company, productName).count, 4);
      assert.equal(readDb.prepare('SELECT COUNT(*) AS count FROM product_responsibility_cards WHERE company = ? AND product_name = ?').get(nextCompany, nextProduct).count, 1);
    } finally {
      readDb.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('materializeProductResponsibilityCards writes product cards and replaces stale rows idempotently', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const { company, productName } = seedMeimanAnkang(dbPath);
    const firstWrite = materializeProductResponsibilityCards({
      dbPath,
      company,
      productName,
      write: true,
      now: '2026-06-22T00:00:00.000Z',
    });

    assert.equal(firstWrite.dryRun, false);
    assert.equal(firstWrite.insertedRows, 4);
    assert.equal(firstWrite.deletedRows, 0);

    const db = new DatabaseSync(dbPath);
    try {
      const productKey = firstWrite.samples[0].productKey;
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM product_responsibility_cards WHERE product_key = ?').get(productKey).count, 4);
      const survival = db.prepare("SELECT calculation_status, payload FROM product_responsibility_cards WHERE title = '生存保险金'").get();
      assert.equal(survival.calculation_status, 'calculable');
      const survivalPayload = JSON.parse(survival.payload);
      assert.equal(survivalPayload.sourceGate, 'source_url_present');
      assert.equal(survivalPayload.indicatorCheckStatus, 'verified_calculable');
      assert.deepEqual(survivalPayload.indicatorCheckIssues, []);
      const birthday = db.prepare("SELECT category, calculation_status, payload FROM product_responsibility_cards WHERE title = '祝寿金'").get();
      assert.equal(birthday.category, '现金流');
      assert.equal(birthday.calculation_status, 'calculable');
      assert.equal(JSON.parse(birthday.payload).payoutSummary, '祝寿金 = 该保单生效对应日有效保险金额');
      db.prepare(`
        INSERT INTO product_responsibility_cards (
          id,
          product_key,
          company,
          product_name,
          title,
          payload
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run('stale_card', productKey, company, productName, '旧责任', JSON.stringify({ title: '旧责任' }));
    } finally {
      db.close();
    }

    const secondWrite = materializeProductResponsibilityCards({
      dbPath,
      company,
      productName,
      write: true,
      now: '2026-06-22T00:01:00.000Z',
    });
    assert.equal(secondWrite.insertedRows, 4);
    assert.equal(secondWrite.deletedRows, 5);

    const readDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(readDb.prepare('SELECT COUNT(*) AS count FROM product_responsibility_cards').get().count, 4);
      assert.equal(readDb.prepare("SELECT COUNT(*) AS count FROM product_responsibility_cards WHERE title = '旧责任'").get().count, 0);
      assert.equal(readDb.prepare("SELECT value FROM app_meta WHERE key = 'product_responsibility_cards_materialized_at'").get().value, '2026-06-22T00:01:00.000Z');
    } finally {
      readDb.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('materializeProductResponsibilityCards keeps return-premium responsibility beside education cashflow', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const db = new DatabaseSync(dbPath);
    const company = '友邦人寿';
    const productName = '友邦小龙凤儿童教育金给付还本寿险';
    const sourceUrl = 'https://www.aia.com.cn/content/dam/cn/zh-cn/docs/public-disclosure/A0089-1_JROP.pdf';
    try {
      insertKnowledge(db, {
        id: 2,
        company,
        productName,
        url: sourceUrl,
        pageText: [
          '保险责任 在本契约有效期内，本公司承担下列保险责任：',
          '1.教育金给付 若被保险人在约定年龄后的首个保单周年日仍然生存，本公司按基本保额的约定比例给付教育金。',
          '2.返还保险费 若被保险人于本契约满期日仍然生存，本公司将返还保险费予投保人。',
        ].join('\n'),
      });
      insertIndicator(db, {
        id: 'ind_education',
        company,
        productName,
        coverageType: '现金流',
        liability: '教育金给付',
        unit: '%',
        value: 10,
        basis: '基本保险金额',
        formulaText: '教育金 = 基本保险金额 × 10%',
        sourceUrl,
        sourceExcerpt: '教育金给付 若被保险人在约定年龄后的首个保单周年日仍然生存，本公司按基本保额的约定比例给付教育金。',
      });
      insertIndicator(db, {
        id: 'ind_return_premium',
        company,
        productName,
        coverageType: '现金流',
        liability: '返还保险费',
        unit: '公式',
        basis: '已交保险费',
        formulaText: '返还保险费 = 已交保险费',
        sourceUrl,
        sourceExcerpt: '返还保险费 若被保险人于本契约满期日仍然生存，本公司将返还保险费予投保人。',
      });
    } finally {
      db.close();
    }

    const result = materializeProductResponsibilityCards({
      dbPath,
      company,
      productName,
      write: true,
      now: '2026-06-22T00:02:00.000Z',
    });

    assert.equal(result.insertedRows, 2);
    const readDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const titles = readDb.prepare('SELECT title FROM product_responsibility_cards ORDER BY title').all().map((row) => row.title);
      assert.deepEqual(titles, ['教育金给付', '返还保险费']);
    } finally {
      readDb.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('materializeProductResponsibilityCards extracts article insurance responsibility clauses', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const db = new DatabaseSync(dbPath);
    const company = '中国平安';
    const productName = '平安智富人生终身寿险（万能型，B）';
    const sourceUrl = 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=893&versionNo=893-1&attachmentType=1';
    try {
      insertKnowledge(db, {
        id: 3,
        company,
        productName,
        url: sourceUrl,
        pageText: '第二条保险责任在本合同保险责任有效期内，被保险人因意外伤害事故或疾病身故，本公司根据身故当时的保险金额给付身故保险金，本合同终止。',
      });
    } finally {
      db.close();
    }

    const result = materializeProductResponsibilityCards({
      dbPath,
      company,
      productName,
      now: '2026-06-29T00:00:00.000Z',
    });

    assert.equal(result.cardsGenerated, 1);
    assert.equal(result.samples[0].cards[0].title, '身故保险金');
    assert.equal(result.samples[0].cards[0].category, '人寿保障');
    assert.equal(result.samples[0].cards[0].cashflowTreatment, 'claim_contingent');
    assert.equal(result.samples[0].cards[0].calculationStatus, 'claim_contingent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('materializeProductResponsibilityCards extracts numbered section responsibility text', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const db = new DatabaseSync(dbPath);
    const company = '中意人寿';
    const productName = '中意e心关爱专项疾病保险（A款）';
    const sourceUrl = 'https://www.generalichina.com/u/cms/www/202306/12164027gpwq.pdf';
    try {
      insertKnowledge(db, {
        id: 4,
        company,
        productName,
        url: sourceUrl,
        pageText: '保险责任本保险合同所保障的特定疾病分为女性特定疾病和男性特定疾病。在本合同有效期内，如果被保险人为女性，在等待期后首次发病并经专科医生首次确诊患有任何一项符合我们上述约定的女性特定疾病，我们将按本合同的基本保险金额向被保险人给付保险金，同时本合同效力终止。',
      });
    } finally {
      db.close();
    }

    const result = materializeProductResponsibilityCards({
      dbPath,
      company,
      productName,
      now: '2026-06-29T00:05:00.000Z',
    });

    assert.equal(result.cardsGenerated, 1);
    assert.equal(result.samples[0].cards[0].title, '疾病保险金');
    assert.equal(result.samples[0].cards[0].category, '疾病保障');
    assert.equal(result.samples[0].cards[0].cashflowTreatment, 'claim_contingent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('materializeProductResponsibilityCards normalizes section fallback benefit titles', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const db = new DatabaseSync(dbPath);
    const rows = [
      {
        id: 5,
        company: '同方全球人寿',
        productName: '海康附加「哆唻咪」意外伤害医疗保险',
        url: 'https://cmsweb.aegonthtf.com/official/accident-medical.pdf',
        pageText: '2.3 保险责任在本附加合同有效期内，被保险人因遭受意外伤害事故，经我们指定或认可的医院进行必要治疗，我们按其自事故发生之日起一百八十天内已支出的必须且合理的实际医疗费用，扣除免赔额后，给付“意外医疗补偿金”予被保险人。',
        expectedTitle: '意外医疗补偿金',
        expectedCategory: '医疗保障',
      },
      {
        id: 6,
        company: '中意人寿',
        productName: '中意附加老年意外骨折意外伤害保险',
        url: 'https://www.generalichina.com/official/fracture.pdf',
        pageText: '保险责任如果被保险人于本附加合同有效期内遭受意外伤害事故，以此意外伤害事故为直接且单独原因造成骨折，并经医院确诊，我们将按照《骨折程度与保险金给付比例表》（见表一）向被保险人支付保险金，其金额按该表所列的给付比例乘以意外伤害事故骨折基本保险金额计算。',
        expectedTitle: '骨折保险金',
        expectedCategory: '意外保障',
      },
      {
        id: 7,
        company: '中意人寿',
        productName: '中意附加意外伤害失能收入损失保险',
        url: 'https://www.generalichina.com/official/disability-income.pdf',
        pageText: '2.3 保险责任在本附加合同有效期内，若被保险人发生并被确认为本附加合同所约定的全残，且在全残持续期内，我们将自被保险人第3个全残确认周年日开始，按本附加合同基本保险金额每年向被保险人给付保险金直至被保险人年满65周岁或身故。另外，在全残持续期内，本公司将豁免本附加合同的保险费，本附加合同继续有效。',
        expectedTitle: '失能收入损失保险金',
        expectedCategory: '疾病保障',
      },
    ];
    try {
      for (const row of rows) insertKnowledge(db, row);
    } finally {
      db.close();
    }

    for (const row of rows) {
      const result = materializeProductResponsibilityCards({
        dbPath,
        company: row.company,
        productName: row.productName,
        now: '2026-06-29T00:10:00.000Z',
      });

      assert.equal(result.cardsGenerated, 1);
      assert.equal(result.samples[0].cards[0].title, row.expectedTitle);
      assert.equal(result.samples[0].cards[0].category, row.expectedCategory);
      assert.equal(result.samples[0].cards[0].cashflowTreatment, 'claim_contingent');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('materializeProductResponsibilityCards skips administrative benefit-claim sections', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const db = new DatabaseSync(dbPath);
    const company = '恒安标准';
    const productName = '恒安标准附加幸福金生提前给付重大疾病保险（C款）';
    try {
      insertKnowledge(db, {
        id: 8,
        company,
        productName,
        url: 'https://www.hengansl.com/official/critical-illness.pdf',
        pageText: '保险金受益人除本附加合同特别约定外，重大疾病提前给付保险金的受益人为被保险人本人。对核定属于保险责任的，我们在与申请人达成有关给付保险金协议后10日内给付保险金。',
      });
    } finally {
      db.close();
    }

    const result = materializeProductResponsibilityCards({
      dbPath,
      company,
      productName,
      now: '2026-06-29T00:15:00.000Z',
    });

    assert.equal(result.cardsGenerated, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reviewed artifact import honors explicit cashflow coverage for maturity benefits', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const artifactPath = path.join(dir, 'review.jsonl');
    const company = '中国太平';
    const productName = '太平百万行无忧两全保险';
    const sourceUrl = 'https://life.cntaiping.com/upload/cms/life/201611/011559401z23.pdf';
    const sourceExcerpt = '满期保险金 如果被保险人在本合同期满日零时生存，我们按以下方式给付满期保险金，同时本合同终止。满期保险金=110%×（本合同的年交保险费＋附加百万行无忧意外保险合同的年交保险费）×交费年期数。';
    fs.writeFileSync(artifactPath, `${JSON.stringify({
      company,
      productName,
      sourceRecords: [{
        sourceRecordId: '7419',
        sourceUrl,
        sourceTitle: `${productName}条款PDF文档`,
      }],
      acceptedResponsibilities: [{
        liability: '满期保险金',
        coverageType: '现金流',
        customerSummary: '被保险人在本合同期满日零时生存，保险公司给付满期保险金，同时合同终止。',
        triggerCondition: '被保险人在本合同期满日零时生存',
        insurerObligation: '给付满期保险金，同时合同终止。',
        formulaText: '满期保险金 = 累计应交保险费 × 110%',
        cashflowTreatment: 'scheduled_cashflow',
        responsibilityScope: 'basic',
        sourceUrl,
        sourceExcerpt,
      }],
      internalIndicatorChecks: [{
        liability: '满期保险金',
        coverageType: '现金流',
        triggerCondition: '被保险人在本合同期满日零时生存',
        basis: '累计应交保险费',
        formulaText: '满期保险金 = 累计应交保险费 × 110%',
        payoutSummary: '给付累计应交保险费的110%。',
        value: 110,
        unit: '%',
        cashflowTreatment: 'scheduled_cashflow',
        calculationStatus: 'calculable',
        calculationEligible: true,
        calculationReason: '金额可由累计应交保险费和固定比例计算。',
        indicatorCheckStatus: 'verified_calculable',
        sourceUrl,
        sourceExcerpt,
      }],
    })}\n`);

    const result = importReviewedResponsibilityArtifacts({
      artifacts: [artifactPath],
      dbPath,
      write: true,
      now: '2026-06-27T00:00:00.000Z',
    });

    assert.equal(result.acceptedResponsibilities, 1);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const card = db.prepare('SELECT category, cashflow_treatment, calculation_status, payload FROM product_responsibility_cards WHERE company = ? AND product_name = ? AND title = ?').get(company, productName, '满期保险金');
      assert.equal(card.category, '现金流');
      assert.equal(card.cashflow_treatment, 'scheduled_cashflow');
      assert.equal(card.calculation_status, 'calculable');
      const payload = JSON.parse(card.payload);
      assert.equal(payload.indicators[0].coverageType, '现金流');
      assert.equal(payload.indicatorCheckStatus, 'verified_calculable');
      assert.equal(payload.indicators[0].calculationReason, '金额可由累计应交保险费和固定比例计算。');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reviewed artifact import preserves reviewed daily allowance metadata', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const artifactPath = path.join(dir, 'review-daily-allowance.jsonl');
    const company = '泰康人寿';
    const productName = '泰康悦享环球高端医疗保险';
    const sourceUrl = 'https://www.taikanglife.com/uploader/pubProductFile/2023/06/20/006bcfa3-8c11-44af-a4d0-6942555480d9.PDF';
    const sourceExcerpt = '无理赔住院津贴 被保险人可在住院前申请放弃对该次住院要求给付住院医疗保险金的权利，换取按合理住院天数进行计算的无理赔住院津贴。我们对该次住院按实际合理住院天数及本合同附表上载明的无理赔住院津贴每日金额计算并向受益人给付无理赔住院津贴，我们不再承担对被保险人因该次住院而发生的医疗费用给付住院医疗保险金的责任。';
    fs.writeFileSync(artifactPath, `${JSON.stringify({
      company,
      productName,
      sourceRecords: [{
        sourceRecordId: '6256',
        sourceUrl,
        sourceTitle: `${productName}产品条款`,
      }],
      acceptedResponsibilities: [{
        liability: '无理赔住院津贴',
        coverageType: '医疗保障',
        customerSummary: '被保险人放弃对某次住院要求给付住院医疗保险金并经保险公司同意后，保险公司可按实际合理住院天数和附表载明的每日金额给付无理赔住院津贴。',
        triggerCondition: '被保险人发生住院并放弃对该次住院要求给付住院医疗保险金',
        insurerObligation: '按实际合理住院天数及附表载明的每日金额给付无理赔住院津贴。',
        formulaText: '无理赔住院津贴 = 实际合理住院天数 × 附表载明的无理赔住院津贴每日金额；每一保单年度给付以30日为限。',
        cashflowTreatment: 'claim_contingent',
        responsibilityScope: 'basic',
        selectionStatus: 'accepted',
        sourceUrl,
        sourceExcerpt,
      }],
      internalIndicatorChecks: [{
        liability: '无理赔住院津贴',
        coverageType: '医疗保障',
        triggerCondition: '被保险人发生住院并放弃对该次住院要求给付住院医疗保险金',
        basis: '实际合理住院天数、无理赔住院津贴每日金额和年度给付天数限制',
        formulaText: '无理赔住院津贴 = 实际合理住院天数 × 附表载明的无理赔住院津贴每日金额；每一保单年度给付以30日为限。',
        payoutSummary: '按实际合理住院天数及附表载明的每日金额给付。',
        cashflowTreatment: 'claim_contingent',
        calculationStatus: 'needs_table',
        calculationEligible: false,
        calculationReason: '无理赔住院津贴需结合实际合理住院天数、附表每日金额和年度给付天数限制核算。',
        indicatorCheckStatus: 'requires_table_or_policy_data',
        calculationMetadataVersion: '2026-06-23-reviewed-responsibility-artifact-import',
        basisKey: 'daily_allowance',
        calculationKey: 'daily_allowance',
        sourceUrl,
        sourceExcerpt,
      }],
    })}\n`);

    importReviewedResponsibilityArtifacts({
      artifacts: [artifactPath],
      dbPath,
      write: true,
      now: '2026-06-27T00:00:00.000Z',
    });

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const card = db.prepare('SELECT calculation_status, payload FROM product_responsibility_cards WHERE company = ? AND product_name = ? AND title = ?').get(company, productName, '无理赔住院津贴');
      const payload = JSON.parse(card.payload);
      assert.equal(card.calculation_status, 'needs_table');
      assert.equal(payload.indicators[0].basisKey, 'daily_allowance');
      assert.equal(payload.indicators[0].calculationKey, 'daily_allowance');
      assert.equal(payload.indicators[0].calculationEligible, false);
      assert.equal(payload.indicatorCheckStatus, 'requires_table_or_policy_data');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reviewed artifact import preserves reviewed policy-data status on cards', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const artifactPath = path.join(dir, 'review-policy-data-status.jsonl');
    const company = '复星保德信人寿';
    const productName = '复星保德信e生守护年金保险';
    const sourceUrl = 'https://www.pflife.com.cn/FBGWServer/upload/file/productData/325cfaecec0a45019543458d29b2d21b.pdf';
    const sourceExcerpt = '年金 在本合同有效期内，如被保险人在首个年金领取日零时仍生存，我们将按以下约定给付年金。按年领取每期年金领取金额为本合同的基本保险金额；按月领取每期年金领取金额为本合同的基本保险金额的8.4%。';
    fs.writeFileSync(artifactPath, `${JSON.stringify({
      company,
      productName,
      sourceRecords: [{
        sourceRecordId: '500983',
        sourceUrl,
        sourceTitle: `${productName}产品条款`,
      }],
      acceptedResponsibilities: [{
        liability: '年金',
        coverageType: '现金流',
        customerSummary: '被保险人在约定首个年金领取日零时仍生存时，保险公司按约定领取方式给付年金。',
        triggerCondition: '被保险人在首个年金领取日零时仍生存',
        insurerObligation: '按年领取给付基本保险金额，按月领取给付基本保险金额的8.4%。',
        formulaText: '年领：每年给付基本保险金额；月领：每月给付基本保险金额×8.4%。',
        cashflowTreatment: 'scheduled_cashflow',
        responsibilityScope: 'basic',
        selectionStatus: 'accepted',
        sourceUrl,
        sourceExcerpt,
      }],
      internalIndicatorChecks: [{
        liability: '年金',
        coverageType: '现金流',
        triggerCondition: '被保险人在首个年金领取日零时仍生存',
        basis: '基本保险金额、首个年金领取年龄和领取方式',
        formulaText: '年领：每年给付基本保险金额；月领：每月给付基本保险金额×8.4%。',
        payoutSummary: '按约定领取方式给付年金。',
        cashflowTreatment: 'scheduled_cashflow',
        calculationStatus: 'requires_policy_schedule',
        calculationEligible: true,
        calculationReason: '金额公式明确，但需要保单载明的首个年金领取年龄和领取方式。',
        indicatorCheckStatus: 'requires_table_or_policy_data',
        calculationMetadataVersion: '2026-06-23-reviewed-responsibility-artifact-import',
        basisKey: 'basic_amount_policy_option',
        calculationKey: 'annuity_basic_amount_or_monthly_factor_with_guarantee',
        sourceUrl,
        sourceExcerpt,
      }],
    })}\n`);

    importReviewedResponsibilityArtifacts({
      artifacts: [artifactPath],
      dbPath,
      write: true,
      now: '2026-06-27T00:00:00.000Z',
    });

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const card = db.prepare('SELECT calculation_status, cashflow_treatment, payload FROM product_responsibility_cards WHERE title = ?').get('年金');
      const payload = JSON.parse(card.payload);
      assert.equal(card.calculation_status, 'requires_policy_schedule');
      assert.equal(card.cashflow_treatment, 'scheduled_cashflow');
      assert.equal(payload.indicatorCheckStatus, 'requires_table_or_policy_data');
      assert.equal(payload.indicators[0].indicatorCheckStatus, 'requires_table_or_policy_data');
      assert.equal(payload.indicators[0].calculationMetadataVersion, '2026-06-23-reviewed-responsibility-artifact-import');
      assert.equal(payload.indicators[0].reviewedCalculationStatus, 'requires_policy_schedule');
      assert.equal(payload.indicators[0].reviewedIndicatorCheckStatus, 'requires_table_or_policy_data');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reviewed artifact import prunes stale non-responsibility indicators', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const artifactPath = path.join(dir, 'review-prune-stale-indicators.jsonl');
    const company = '泰康人寿';
    const productName = '泰康守护A款综合团体医疗保险';
    const sourceUrl = 'https://www.taikanglife.com/uploader/pubProductFile/2025/12/01/9c22bcd4-bc5b-45ff-9f85-e1c1158f761f.pdf';
    const sourceExcerpt = '疾病医疗保险金 被保险人在本合同保险期间内发生符合约定的医疗费用，我们按合同约定给付疾病医疗保险金。';
    const db = new DatabaseSync(dbPath);
    try {
      insertIndicator(db, {
        id: 'ind_stale_payout_method',
        company,
        productName,
        coverageType: '规则参数',
        liability: '赔付方式',
        basis: '保险责任赔付机制',
        sourceUrl,
        sourceExcerpt: '本公司给付医疗保险金时遵循补偿原则。',
      });
    } finally {
      db.close();
    }

    fs.writeFileSync(artifactPath, `${JSON.stringify({
      company,
      productName,
      sourceRecords: [{
        sourceRecordId: '4907',
        sourceUrl,
        sourceTitle: `${productName}产品条款`,
      }],
      acceptedResponsibilities: [{
        liability: '疾病医疗保险金',
        coverageType: '医疗保障',
        customerSummary: '被保险人发生合同约定疾病医疗费用时，保险公司按约定给付疾病医疗保险金。',
        triggerCondition: '被保险人发生合同约定疾病医疗费用',
        insurerObligation: '按合同约定给付疾病医疗保险金。',
        formulaText: '疾病医疗保险金 = 合同约定范围内医疗费用按约定比例和限额给付。',
        cashflowTreatment: 'claim_contingent',
        responsibilityScope: 'optional_if_selected',
        selectionStatus: 'accepted',
        sourceUrl,
        sourceExcerpt,
      }],
      internalIndicatorChecks: [{
        liability: '疾病医疗保险金',
        coverageType: '医疗保障',
        triggerCondition: '被保险人发生合同约定疾病医疗费用',
        basis: '实际医疗费用、免赔额、赔付比例和责任限额',
        formulaText: '疾病医疗保险金 = 合同约定范围内医疗费用按约定比例和限额给付。',
        cashflowTreatment: 'claim_contingent',
        calculationStatus: 'needs_table',
        calculationEligible: false,
        calculationReason: '医疗费用型责任需结合实际费用、免赔额、赔付比例和限额核算。',
        indicatorCheckStatus: 'requires_table_or_policy_data',
        calculationMetadataVersion: '2026-06-23-reviewed-responsibility-artifact-import',
        basisKey: 'medical_expense',
        calculationKey: 'medical_formula',
        sourceUrl,
        sourceExcerpt,
      }],
    })}\n`);

    const result = importReviewedResponsibilityArtifacts({
      artifacts: [artifactPath],
      dbPath,
      write: true,
      now: '2026-06-27T00:00:00.000Z',
    });

    assert.equal(result.prunedIndicators, 1);
    const readDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const liabilities = readDb.prepare('SELECT liability FROM insurance_indicator_records WHERE company = ? AND product_name = ? ORDER BY liability').all(company, productName).map((row) => row.liability);
      assert.deepEqual(liabilities, ['疾病医疗保险金']);
    } finally {
      readDb.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reviewed artifact import preserves reviewed claim-contingent treatment for noncash wording', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const artifactPath = path.join(dir, 'review-claim-treatment.jsonl');
    const company = '众安保险';
    const productName = '附加特约赔偿方式';
    const sourceUrl = 'https://static.zhongan.com/upload/online/material/1667294016237.pdf';
    const sourceExcerpt = '对于主险合同保险责任范围内的保险事故，保险人可以在以下三种方式中选择其中一种赔偿方式，在投保人投保时予以明示，并在保险合同上载明: 保险人按照保险合同约定，向被保险人给付保险金；保险人按照保险合同约定，代投保人履行投保人承担的主险合同保险责任范围内的义务。';
    fs.writeFileSync(artifactPath, `${JSON.stringify({
      company,
      productName,
      sourceRecords: [{
        sourceRecordId: '505802',
        sourceUrl,
        sourceTitle: '众安在线财产保险股份有限公司附加特约赔偿方式保险条款（互联网2022版）',
      }],
      acceptedResponsibilities: [{
        liability: '特约赔偿方式',
        coverageType: '其他',
        customerSummary: '主险保险责任范围内的保险事故发生后，保险人可按保险合同载明方式选择给付保险金或代为履行主险责任范围内义务。',
        triggerCondition: '发生主险合同保险责任范围内的保险事故，且保险合同载明特约赔偿方式。',
        insurerObligation: '按照保险合同约定选择给付保险金或代为履行主险责任范围内义务。',
        formulaText: '具体金额或义务范围取决于主险保险责任和保险合同约定。',
        cashflowTreatment: 'claim_contingent',
        sourceUrl,
        sourceExcerpt,
      }],
      internalIndicatorChecks: [{
        liability: '特约赔偿方式',
        coverageType: '其他',
        triggerCondition: '发生主险合同保险责任范围内的保险事故，且保险合同载明特约赔偿方式。',
        basis: '主险保险责任范围、保险合同载明赔偿方式和事故事实',
        formulaText: '具体金额或义务范围取决于主险保险责任和保险合同约定。',
        payoutSummary: '按保险合同载明方式履行主险责任范围内义务。',
        cashflowTreatment: 'claim_contingent',
        calculationStatus: 'needs_table',
        calculationEligible: false,
        calculationReason: '需结合主险责任、保险合同载明方式和事故事实核算。',
        indicatorCheckStatus: 'requires_table_or_policy_data',
        calculationMetadataVersion: '2026-06-23-reviewed-responsibility-artifact-import',
        basisKey: 'schedule_or_policy_table',
        calculationKey: 'schedule_or_policy_table',
        sourceUrl,
        sourceExcerpt,
      }],
    })}\n`);

    importReviewedResponsibilityArtifacts({
      artifacts: [artifactPath],
      dbPath,
      write: true,
      now: '2026-06-27T00:00:00.000Z',
    });

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const card = db.prepare('SELECT cashflow_treatment, calculation_status, payload FROM product_responsibility_cards WHERE company = ? AND product_name = ? AND title = ?').get(company, productName, '特约赔偿方式');
      const payload = JSON.parse(card.payload);
      assert.equal(card.cashflow_treatment, 'claim_contingent');
      assert.equal(card.calculation_status, 'needs_table');
      assert.equal(payload.indicators[0].cashflowTreatment, 'claim_contingent');
      assert.equal(payload.indicatorCheckStatus, 'requires_table_or_policy_data');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('materializeProductResponsibilityCards honors explicit cashflow category when trigger mentions claims', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const db = new DatabaseSync(dbPath);
    const company = '中国太平';
    const productName = '太平稳得康附加医疗保险（B款）';
    const sourceUrl = 'https://life.cntaiping.com/upload/cms/life/201306/170903169pmk.pdf';
    const sourceExcerpt = '无理赔奖励 如果被保险人生存至本附加合同期满日当天零时，并且没有发生任何住院津贴赔付，我们按基本保险金额的5%给付无理赔奖励。';
    try {
      insertIndicator(db, {
        id: 'ind_no_claim_bonus',
        company,
        productName,
        coverageType: '现金流',
        liability: '无理赔奖励',
        value: 5,
        unit: '%',
        basis: '基本保险金额',
        formulaText: '无理赔奖励 = 基本保险金额 × 5%',
        triggerCondition: '被保险人生存至期满日且没有发生任何住院津贴赔付',
        sourceUrl,
        sourceExcerpt,
      });
    } finally {
      db.close();
    }

    const result = materializeProductResponsibilityCards({
      dbPath,
      company,
      productName,
      write: true,
      now: '2026-06-27T00:01:00.000Z',
    });

    assert.equal(result.insertedRows, 1);
    const readDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const card = readDb.prepare('SELECT category, cashflow_treatment, calculation_status, payload FROM product_responsibility_cards WHERE title = ?').get('无理赔奖励');
      assert.equal(card.category, '现金流');
      assert.equal(card.cashflow_treatment, 'scheduled_cashflow');
      assert.equal(card.calculation_status, 'calculable');
      assert.equal(JSON.parse(card.payload).indicatorCheckStatus, 'verified_calculable');
    } finally {
      readDb.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('materializeProductResponsibilityCards keeps table-dependent explicit cashflow scheduled', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const db = new DatabaseSync(dbPath);
    const company = '中国太平';
    const productName = '太平一生终身寿险（分红型）';
    const sourceUrl = 'https://life.cntaiping.com/upload/cms/life/201306/17093625nosa.pdf';
    const sourceExcerpt = '生存给付金每隔三年给付一次。在本合同的责任有效期间内，若被保险人在本合同每第三个保险合同周年日的零时仍生存，本公司给付生存给付金。在本合同的交费期内，生存给付金等值于保险金额的百分之五，交费期满后生存给付金等值于保险金额的百分之十。';
    try {
      insertIndicator(db, {
        id: 'ind_survival_periodic',
        company,
        productName,
        coverageType: '现金流',
        liability: '生存给付金',
        unit: '公式',
        basis: '保险金额、是否处于交费期',
        formulaText: '生存给付金 = 条件给付（交费期内：保险金额 × 5%；交费期满后：保险金额 × 10%）',
        triggerCondition: '被保险人在每第三个保险合同周年日零时仍生存',
        sourceUrl,
        sourceExcerpt,
      });
    } finally {
      db.close();
    }

    const result = materializeProductResponsibilityCards({
      dbPath,
      company,
      productName,
      write: true,
      now: '2026-06-27T00:02:00.000Z',
    });

    assert.equal(result.insertedRows, 1);
    const readDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const card = readDb.prepare('SELECT category, cashflow_treatment, calculation_status, payload FROM product_responsibility_cards WHERE title = ?').get('生存给付金');
      assert.equal(card.category, '现金流');
      assert.equal(card.cashflow_treatment, 'scheduled_cashflow');
      assert.equal(card.calculation_status, 'needs_table');
      assert.equal(JSON.parse(card.payload).indicatorCheckStatus, 'requires_table_or_policy_data');
    } finally {
      readDb.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('materializeProductResponsibilityCards keeps increasing guaranteed annuity as its own card', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const db = new DatabaseSync(dbPath);
    const company = '中国人寿';
    const productName = '国寿保险金转换年金保险';
    const sourceUrl = 'https://www.e-chinalife.com/upload/resources/file/productBasicInfo/a79afc62-14c3-11ee-a6b7-bc97e1225d40/100_国寿保险金转换年金保险条款.pdf';
    try {
      insertKnowledge(db, {
        id: 3,
        company,
        productName,
        url: sourceUrl,
        pageText: [
          '保险责任 在本合同保险期间内，本公司按照被保险人选择的下述一种年金类型给付年金：',
          '1. 保证给付十年终身年金 本公司按保险单载明的年金领取金额向被保险人给付年金，保证给付十年。',
          '2. 保证给付十年增额终身年金 本公司按保险单载明的年金领取金额向被保险人给付年金，保证给付十年。从第二年起年金给付标准按首年给付标准的5%增加。',
        ].join('\n'),
      });
      insertIndicator(db, {
        id: 'ind_guaranteed_life_annuity',
        company,
        productName,
        coverageType: '现金流',
        liability: '保证给付十年终身年金',
        unit: '公式',
        basis: '保险单载明的年金领取金额',
        formulaText: '保证期内年金 = 保险单载明的年金领取金额',
        sourceUrl,
        sourceExcerpt: '保证给付十年终身年金 本公司按保险单载明的年金领取金额向被保险人给付年金，保证给付十年。',
      });
      insertIndicator(db, {
        id: 'ind_increasing_guaranteed_life_annuity',
        company,
        productName,
        coverageType: '现金流',
        liability: '保证给付十年增额终身年金',
        unit: '公式',
        basis: '保险单载明的年金领取金额和首年给付标准',
        formulaText: '首年年金 = 保险单载明金额；第二年起按首年给付标准的5%增加',
        sourceUrl,
        sourceExcerpt: '保证给付十年增额终身年金 本公司按保险单载明的年金领取金额向被保险人给付年金，保证给付十年。从第二年起年金给付标准按首年给付标准的5%增加。',
      });
    } finally {
      db.close();
    }

    const result = materializeProductResponsibilityCards({
      dbPath,
      company,
      productName,
      write: true,
      now: '2026-06-22T00:03:00.000Z',
    });

    assert.equal(result.insertedRows, 2);
    const readDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const titles = readDb.prepare('SELECT title FROM product_responsibility_cards ORDER BY title').all().map((row) => row.title);
      assert.deepEqual(titles, ['保证给付十年增额终身年金', '保证给付十年终身年金']);
    } finally {
      readDb.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
