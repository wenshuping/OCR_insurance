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

test('backfill reports changed product keys and marks matching derived results stale', () => {
  const { dir, dbPath } = makeTempDb();
  const db = new DatabaseSync(dbPath);
  try {
    insertKnowledge(db, {
      id: 200,
      company: '测试人寿',
      productName: '测试影响范围保险',
      pageText: '保险责任 身故保险金被保险人身故，我们按基本保险金额给付身故保险金。',
    });
    const productKey = 'company_product:测试人寿:测试影响范围保险';
    db.prepare(`
      INSERT INTO policy_derived_results (policy_id, product_keys, status, stale_reason, generated_at, updated_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      301,
      JSON.stringify([productKey]),
      'ready',
      '',
      '2026-06-15T00:00:00.000Z',
      '2026-06-15T00:00:00.000Z',
      JSON.stringify({
        policyId: 301,
        productKeys: [productKey],
        coverageIndicators: [],
        optionalResponsibilities: [],
        indicatorVersions: {},
        status: 'ready',
        staleReason: '',
        generatedAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-15T00:00:00.000Z',
      }),
    );

    const dryRun = backfillKnowledgeResponsibilityIndicators({
      dbPath,
      minKnowledgeId: 200,
    });

    assert.deepEqual(dryRun.changedProductKeys, [productKey]);
    assert.equal(dryRun.changedProductKeyCount, 1);
    assert.equal(dryRun.affectedPolicyCount, 1);
    assert.equal(db.prepare('SELECT status FROM policy_derived_results WHERE policy_id = ?').get(301).status, 'ready');

    const written = backfillKnowledgeResponsibilityIndicators({
      dbPath,
      write: true,
      minKnowledgeId: 200,
    });

    assert.deepEqual(written.changedProductKeys, [productKey]);
    assert.equal(written.affectedPolicyCount, 1);
    const derived = JSON.parse(db.prepare('SELECT payload FROM policy_derived_results WHERE policy_id = ?').get(301).payload);
    assert.equal(derived.status, 'stale');
    assert.equal(derived.staleReason, 'indicator_updated');
    assert.equal(db.prepare('SELECT version FROM product_indicator_versions WHERE product_key = ?').get(productKey).version, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM indicator_update_batches').get().count, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backfills high-confidence and parameterized knowledge responsibility indicators', () => {
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
      pageText: '保险责任 页住院医疗保险金被保险人在医院接受住院治疗，对实际发生的合理且必要的医疗费用，扣除已获补偿、免赔额后按本合同约定的给付比例给付住院医疗保险金。',
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
      pageText: '保险责任 若同时符合多项责任，我们仅按基本保险金额给付其中一项保险金。后该种轻症疾病保险金不再重复给付。期内应给付的养老保险金按基本保险金额10%给付。保证领取期间内应给付的养老年金按基本保险金额10%给付。范围)给付各项保险金。表中所列相应残疾程度对应的给付比例给付意外残疾保险金。之和不超过您投保的保障计划对应的一般门急诊医疗保险金。给付比例对于一般医疗保险金为100%。下的各项保险金按保险金额给付。各对应意外残疾保险金按给付比例给付。各该项残疾保险金累计给付。双倍相应的身故或全残保险金按保险金额给付。等值于基本保险金按保险金额给付。若已给付首次重大疾病保险金，则身故保险金降低为基本保险金额的10%。应当赔付的保险金=(被保险人发生的医疗费用-免赔额)×赔付比例A。给付各分项保险金且不超过保险金额。其他保险金给付申请材料。保险人承担给付特定医疗保险金的责任，实际医疗费用扣除免赔额后按约定给付比例给付。',
    });
    insertKnowledge(db, {
      id: 113,
      company: '测试人寿',
      productName: '测试上下文残片保险',
      pageText: '保险责任 定期领取该类型下养老年金按年金领取金额给付。保险金若您选择的养老年金按年金领取金额给付。保险金(若有)和恶性肿瘤——重度关爱保险金按基本保险金额30%给付。交清增额保险对应的满期保险金按保险金额给付。分别以保险单上载明的该项交通工具对应的保险金给付。时应扣除事故前的伤残对应的伤残保险金。日及其后的年对应日按基本保险金给付。上限为基本保险金按基本保险金额给付。每项特定重大手术对应的特定重大手术康复保险金若被保险人接受特定重大手术，我们按保险金额给付。保险金和恶性肿瘤--重度额外保险金若被保险人确诊恶性肿瘤--重度，我们按基本保险金额30%给付。',
    });
    insertKnowledge(db, {
      id: 114,
      company: '测试人寿',
      productName: '测试重复责任边界年金保险',
      productType: '年金保险',
      pageText: '保险责任 养老年金被保险人生存，我们按本合同基本保险金额给付养老年金。身故保险金被保险人身故，我们按以下两项较大者给付身故保险金，本合同终止：1.本合同已交保险费；2.本合同现金价值。满期金被保险人满期仍生存，我们按本合同已交保险费给付满期金。',
    });
    insertKnowledge(db, {
      id: 115,
      company: '测试人寿',
      productName: '测试账户价值年金保险',
      productType: '年金保险',
      pageText: '保险责任 养老保险金被保险人生存至养老保险金领取日，我们按个人账户已归属被保险人部分的账户价值给付养老保险金。身故或全残保险金被保险人身故或全残，我们按当时个人账户价值给付身故或全残保险金。',
    });
    insertKnowledge(db, {
      id: 116,
      company: '测试人寿',
      productName: '测试前文比例不污染后项保险',
      pageText: '保险责任 身故保险金被保险人身故，我们按本合同已交保险费的一定比例给付身故保险金。具体比例如下表：18-40周岁160%，41-60周岁140%。首次重大疾病保险金被保险人首次确诊重大疾病，我们按本合同基本保险金额给付首次重大疾病保险金。',
    });
    insertKnowledge(db, {
      id: 117,
      company: '测试人寿',
      productName: '测试固定日额津贴保险',
      pageText: '保险责任 重症监护室津贴保险金=重症监护室津贴保险金每日给付额（1000 元/天）× 在重症监护室接受治疗的天数。',
    });
    insertKnowledge(db, {
      id: 118,
      company: '测试人寿',
      productName: '测试单位日额津贴保险',
      pageText: '保险责任 意外住院津贴保险金=意外住院津贴保险金每日给付额（10 元/单位/天）×保险单位数×实际住院天数。',
    });
    insertKnowledge(db, {
      id: 119,
      company: '测试人寿',
      productName: '测试确诊金保险',
      pageText: '保险责任 少儿特定重大疾病确诊金被保险人初次确诊少儿特定重大疾病，我们按照约定的少儿特定重大疾病保险金额给付少儿特定重大疾病确诊金。',
    });
    insertKnowledge(db, {
      id: 120,
      company: '测试人寿',
      productName: '测试空格责任名津贴保险',
      pageText: '保险责任 意外伤害 住院津贴 保险金 被保险人住院治疗，我们按该被保险人的基本保险金额乘以住院日数给付意外伤害住院津贴保险金。',
    });
    insertKnowledge(db, {
      id: 121,
      company: '测试人寿',
      productName: '测试建筑施工可选责任保险',
      pageText: '保险责任终止。可选责任本合同的可选责任包括“意外伤害医疗保险金”，“意外伤害住院津贴保险金”两项。意外伤害医疗保险金被保险人在从事建筑施工相关工作时因遭受意外伤害事故并在医疗机构进行治疗的，我们对该次事故发生之日起180日内发生的、符合当地基本医疗保险规定的、医疗必需且合理的实际医疗费用扣除被保险人取得的补偿或给付以及本合同约定的免赔额后，按约定的给付比例给付意外伤害医疗保险金。伤残等级1级2级给付比例100%90%。意外伤害住院津贴保险金被保险人因遭受意外伤害事故住院治疗的，我们按该被保险人的住院日额津贴乘以实际住院日数计算给付意外伤害住院津贴保险金。',
    });
    insertKnowledge(db, {
      id: 122,
      company: '测试人寿',
      productName: '测试基本可选日额津贴保险',
      pageText: '保险责任本合同保险责任分为基本部分和可选部分。基本部分一般住院日额津贴保险金被保险人因遭受意外伤害事故在医疗机构住院治疗的，本公司按该被保险人每次住院7的实际日数，乘以该被保险人的一般住院日额津贴计算给付一般住院日额津贴保险金。被保险人因患疾病在医疗机构住院治疗的，本公司按该被保险人每次住院的实际住院日数扣减3日，乘以该被保险人的一般住院日额津贴计算给付一般住院日额津贴保险金。可选部分 （一）恶性肿瘤住院日额津贴保险金被保险人初次罹患恶性肿瘤在医疗机构进行住院治疗的，本公司按该被保险人每次住院的实际日数，乘以该被保险人恶性肿瘤住院日额津贴计算给付恶性肿瘤住院日额津贴保险金。（二）重症监护日额津贴保险金被保险人因遭受意外伤害事故或疾病，在医疗机构重症监护病房住院治疗的，本公司按该被保险人每次住在重症监护病房的实际日数，乘以该被保险人的重症监护日额津贴计算给付重症监护日额津贴保险金。',
    });
    insertKnowledge(db, {
      id: 123,
      company: '测试人寿',
      productName: '测试句尾给付两全保险',
      productType: '两全保险',
      pageText: '保险责任 身故保险金被保险人身故，我们按现金价值给付身故保险金。满期生存保险金被保险人于保险期满仍生存，我们按本合同已交保险费及附加险已交保险费之和的110%给付满期生存保险金，本合同终止。责任免除发生免责情形的，我们退还现金价值。',
    });
    insertKnowledge(db, {
      id: 124,
      company: '测试人寿',
      productName: '测试较大者定期寿险',
      productType: '定期寿险',
      pageText: '保险责任 高残保险金若被保险人身体高度残疾，我们按下列两项中较大者给付高残保险金：1.本合同基本保险金额；2.剩余保险期间与本合同基本保险金额的十分之一的乘积。责任免除发生免责情形的，我们退还现金价值。',
    });
    insertKnowledge(db, {
      id: 125,
      company: '测试人寿',
      productName: '测试给付限制不污染寿险',
      productType: '两全保险',
      pageText: '保险责任 身故保险金若被保险人身故，则我们给付等值于基本保险金额的身故保险金。保险金给付限制若已给付首次重大疾病保险金，则身故保险金降低为基本保险金额的10%。',
    });
    insertKnowledge(db, {
      id: 126,
      company: '测试人寿',
      productName: '测试等值于比例重疾保险',
      productType: '重疾险',
      pageText: '保险责任 额外保险金：确诊重大疾病时未满60周岁，我们按基本保险金额的80%给付重大疾病额外保险金，本项责任终止。',
    });
    insertKnowledge(db, {
      id: 127,
      company: '测试人寿',
      productName: '测试分红终身寿保险',
      productType: '终身寿险',
      pageText: '保险责任 身故保险金若被保险人身故，我们按以下金额中的较大者与累积红利基本保险金额对应的现金价值之和给付身故保险金：1.已支付的保险费的一定比例；2.基本保险金额对应的现金价值。保单红利另有约定。',
    });
    insertKnowledge(db, {
      id: 128,
      company: '测试人寿',
      productName: '测试保费比例取大两全保险',
      productType: '两全保险',
      pageText: '保险责任 身故保险金若被保险人身故，我们按以下两者的较大者给付身故保险金：1.您已支付的保险费的110%；2.本合同与附加险合同的现金价值之和。满期保险金若被保险人生存至保险期间届满，我们按已交保险费给付满期保险金。',
    });
    insertKnowledge(db, {
      id: 129,
      company: '测试人寿',
      productName: '测试条件比例医疗保险',
      productType: '医疗险',
      pageText: '保险责任 特定药品医疗保险金被保险人发生合理且必要的特定药品费用。除另有约定外，若被保险人未在本合同指定机构内进行检测，保险人按照60%的给付比例进行赔付。',
    });
    insertKnowledge(db, {
      id: 130,
      company: '测试人寿',
      productName: '测试通用责任名意外保险',
      productType: '意外险',
      pageText: '保险责任 身故保险金被保险人遭受意外伤害，并因该意外伤害身故，我们按保险金额给付身故保险金。伤残保险金被保险人因该意外伤害导致伤残，我们按伤残等级给付比例乘以保险金额给付伤残保险金。',
    });
    insertKnowledge(db, {
      id: 131,
      company: '测试人寿',
      productName: '测试表格限额不污染医疗保险',
      productType: '医疗险',
      pageText: '保障计划表 年度给付限额 每一保险期间累计给付的境内医疗保险金和境外医疗保险金之和以基本保险金额为限。保险责任 境内医疗保险金被保险人接受治疗发生合理且必要的医疗费用，我们按给付比例100%给付境内医疗保险金。',
    });
    insertKnowledge(db, {
      id: 132,
      company: '测试人寿',
      productName: '测试终止条款不污染医疗保险',
      productType: '医疗险',
      pageText: '保险责任 住院医疗保险金被保险人住院治疗发生合理且必要的医疗费用，我们扣除免赔额后按80%给付住院医疗保险金。责任终止 我们累计给付已达到保险单上载明的住院医疗保险金额时，本项责任终止。',
    });
    insertKnowledge(db, {
      id: 133,
      company: '测试人寿',
      productName: '测试账户价值不污染意外身故保险',
      productType: '意外险',
      pageText: '保险责任 意外身故保险金被保险人因该意外伤害事故身故的，我们按该种意外伤害事故保险责任的给付限额扣除已给付的意外伤残保险金后的余额给付意外身故保险金。其他约定 退保时退还现金价值，个人账户价值另有约定。',
    });
    insertKnowledge(db, {
      id: 134,
      company: '测试人寿',
      productName: '测试页眉断词不污染意外身故保险',
      productType: '意外险',
      pageText: '保险责任 外伤害身故保险金 被保险人申请材料见本页。意外伤害身故保险金被保险人遭受意外伤害并身故，我们按基本保险金额给付意外伤害身故保险金。',
    });
    insertKnowledge(db, {
      id: 135,
      company: '测试人寿',
      productName: '测试医保身份条件比例医疗保险',
      productType: '医疗险',
      pageText: '保险责任 质子重离子医疗保险金被保险人接受质子重离子治疗发生合理且必要的医疗费用，我们按约定的赔付比例给付质子重离子医疗保险金。医疗保险金=(合理且必要的医疗费用-已获得补偿-免赔额)×赔付比例。若未以基本医疗保险参保人身份就诊并结算，则赔付比例为60%，其他情况下赔付比例为100%。',
    });
    insertKnowledge(db, {
      id: 136,
      company: '测试人寿',
      productName: '测试如字边界年金保险',
      productType: '年金保险',
      pageText: '保险责任 养老年金 计划一：如被保险人在养老年金领取日仍生存，我们按以下约定给付养老年金：（1）按年领取：基本保险金额的100%；（2）按月领取：基本保险金额的8.5%。计划二：按年领取为基本保险金额的150%。祝寿金 如被保险人在年满99周岁后仍生存，我们按本合同实际交纳的保险费给付祝寿金。满期金 如被保险人在保险期间届满时仍生存，我们按本合同保险期间届满时的基本保险金额的10倍给付满期金。身故保险金 如被保险人身故，我们按以下两项金额中的较大者给付身故保险金：1.实际交纳的保险费；2.现金价值。',
    });
    insertKnowledge(db, {
      id: 137,
      company: '测试人寿',
      productName: '测试非意外身故分类保险',
      productType: '定期寿险',
      pageText: '保险责任 非意外身故保险金被保险人因非意外原因身故，我们按基本保险金额的50%给付非意外身故保险金。',
    });
    insertKnowledge(db, {
      id: 138,
      company: '测试财险',
      productName: '测试先进疗法医疗保险',
      productType: '医疗险',
      pageText: '第二条 保险责任 在本附加合同保险期间内，被保险人初次确诊罹患恶性肿瘤--重度，保险人对下述1-3类费用，按照本合同的约定在扣除约定的免赔额后，承担给付恶性肿瘤先进疗法医疗保险金的责任：（一）恶性肿瘤质子重离子医疗费用；（二）恶性肿瘤硼中子俘获治疗医疗费用；（三）恶性肿瘤光免疫疗法医疗费用。保险人累计承担的恶性肿瘤先进疗法医疗保险金以本附加合同约定的恶性肿瘤先进疗法医疗保险金额为限。第三条 免赔额 本附加合同关于免赔额的约定与主合同一致。第四条 补偿原则和赔付标准 本附加合同适用医疗费用补偿原则。若被保险人已从其他途径获得本附加合同责任范围内医疗费用补偿，则保险人仅对被保险人实际发生的合理的医疗费用扣除其所获医疗费用补偿后的余额按照本附加合同的约定进行赔付。若本次治疗费用未获得基本医疗保险补偿的，则保险人根据本附加合同单独约定的给付比例进行赔付。第五条 责任免除 对不属于保险责任范围的费用，保险人不承担给付保险金的责任。',
    });
    insertKnowledge(db, {
      id: 139,
      company: '测试财险',
      productName: '测试特定药械医疗保险',
      productType: '医疗险',
      pageText: '第二条 保险责任 本附加合同的保险责任包括恶性肿瘤--重度院外特定药品费用医疗保险金和恶性肿瘤--重度特定器械耗材费用医疗保险金。（一）恶性肿瘤--重度院外特定药品费用医疗保险金 在本附加合同保险期间内，被保险人初次确诊恶性肿瘤--重度，对治疗实际发生的、必需且合理的院外特定药品费用，保险人在扣除合同约定的免赔额后按照本附加合同约定的给付比例给付恶性肿瘤--重度院外特定药品费用医疗保险金。（二）恶性肿瘤--重度特定器械耗材费用医疗保险金 在本附加合同保险期间内，被保险人初次确诊恶性肿瘤--重度，对治疗实际发生的、必需且合理的特定器械耗材费用，保险人在扣除合同约定的免赔额后按照本附加合同约定的给付比例给付恶性肿瘤--重度特定器械耗材费用医疗保险金。第四条 补偿原则 本附加合同适用医疗费用补偿原则，保险人仅对实际发生的合理费用扣除其已获得医疗费用补偿后的余额按本附加合同的约定进行赔付。',
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
    assert.equal(dryRun.candidateProducts, 39);
    assert.equal(dryRun.productsWithIndicators, 34);
    assert.equal(dryRun.indicatorUpserts, 51);
    assert.equal(dryRun.skippedProducts, 5);

    const includeExisting = backfillKnowledgeResponsibilityIndicators({
      dbPath,
      minKnowledgeId: 100,
      includeExistingProducts: true,
      sampleLimit: 10,
    });
    assert.equal(includeExisting.candidateProducts, 40);
    assert.equal(includeExisting.productsWithIndicators, 35);
    assert.equal(includeExisting.indicatorUpserts, 52);

    const write = backfillKnowledgeResponsibilityIndicators({ dbPath, write: true, minKnowledgeId: 100, sampleLimit: 10 });
    assert.equal(write.indicatorUpserts, 51);

    const readDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = readDb.prepare(`
        SELECT liability, coverage_type, payload
          FROM insurance_indicator_records
         WHERE id LIKE 'ind_knowledge_auto_%'
         ORDER BY liability
      `).all();
      assert.equal(rows.length, 51);
      assert.ok(rows.some((row) => row.liability === '身故保险金'));
      assert.ok(rows.some((row) => row.liability === '住院医疗保险金'));
      assert.ok(rows.some((row) => row.liability === '后续年金'));
      assert.ok(rows.some((row) => row.liability === '住院津贴保险金'));
      assert.ok(rows.some((row) => row.liability === '身故或身体高度残疾保险金'));
      assert.ok(rows.some((row) => row.liability === '意外伤残保险金'));
      assert.ok(rows.some((row) => row.liability === '特定药品医疗费用保险金'));
      assert.ok(rows.some((row) => row.liability === '特定重大手术康复保险金'));
      assert.ok(rows.some((row) => row.liability === '恶性肿瘤--重度额外保险金'));
      assert.ok(rows.some((row) => row.liability === '养老年金'));
      assert.ok(rows.some((row) => row.liability === '满期金'));
      assert.ok(rows.some((row) => row.liability === '养老保险金'));
      assert.ok(rows.some((row) => row.liability === '身故或全残保险金'));
      assert.ok(rows.some((row) => row.liability === '首次重大疾病保险金'));
      assert.ok(rows.some((row) => row.liability === '重症监护室津贴保险金'));
      assert.ok(rows.some((row) => row.liability === '意外住院津贴保险金'));
      assert.ok(rows.some((row) => row.liability === '少儿特定重大疾病确诊金'));
      assert.ok(rows.some((row) => row.liability === '意外伤害住院津贴保险金'));
      assert.ok(rows.some((row) => row.liability === '意外伤害医疗保险金'));
      assert.ok(rows.some((row) => row.liability === '一般住院日额津贴保险金'));
      assert.ok(rows.some((row) => row.liability === '恶性肿瘤住院日额津贴保险金'));
      assert.ok(rows.some((row) => row.liability === '重症监护日额津贴保险金'));
      assert.ok(rows.some((row) => row.liability === '境内医疗保险金'));
      assert.ok(rows.some((row) => row.liability === '意外身故保险金'));
      assert.ok(rows.some((row) => row.liability === '意外伤害身故保险金'));
      assert.ok(rows.some((row) => row.liability === '质子重离子医疗保险金'));
      assert.ok(rows.some((row) => row.liability === '恶性肿瘤先进疗法医疗保险金'));
      assert.ok(rows.some((row) => row.liability === '恶性肿瘤--重度院外特定药品费用医疗保险金'));
      assert.ok(rows.some((row) => row.liability === '恶性肿瘤--重度特定器械耗材费用医疗保险金'));
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
      assert.ok(!rows.some((row) => row.liability === '应当赔付的保险金'));
      assert.ok(!rows.some((row) => row.liability === '各分项保险金'));
      assert.ok(!rows.some((row) => row.liability === '其他保险金'));
      assert.ok(!rows.some((row) => row.liability === '特定医疗保险金'));
      assert.ok(!rows.some((row) => (
        row.liability === '首次重大疾病保险金'
        && JSON.parse(row.payload).sourceRecordId === '105'
      )));
      assert.ok(!rows.some((row) => (
        row.liability === '身故保险金'
        && JSON.parse(row.payload).sourceRecordId === '127'
      )));
      assert.ok(!rows.some((row) => (
        row.liability === '特定药品医疗保险金'
        && JSON.parse(row.payload).sourceRecordId === '129'
      )));
      assert.ok(!rows.some((row) => row.liability === '定期领取该类型下养老年金'));
      assert.ok(!rows.some((row) => row.liability === '保险金若您选择的养老年金'));
      assert.ok(!rows.some((row) => row.liability === '保险金(若有)和恶性肿瘤——重度关爱保险金'));
      assert.ok(!rows.some((row) => row.liability === '交清增额保险对应的满期保险金'));
      assert.ok(!rows.some((row) => row.liability === '分别以保险单上载明的该项交通工具对应的保险金'));
      assert.ok(!rows.some((row) => row.liability === '时应扣除事故前的伤残对应的伤残保险金'));
      assert.ok(!rows.some((row) => row.liability === '日及其后的年对应日按基本保险金'));
      assert.ok(!rows.some((row) => row.liability === '上限为基本保险金'));
      assert.ok(!rows.some((row) => row.liability === '每项特定重大手术对应的特定重大手术康复保险金'));
      assert.ok(!rows.some((row) => row.liability === '保险金和恶性肿瘤--重度额外保险金'));
      assert.ok(!rows.some((row) => row.liability === '限额特定药品医疗费用保险金'));
      assert.ok(!rows.some((row) => row.liability === '每一保险期间累计给付的境内医疗保险金'));
      assert.ok(!rows.some((row) => row.liability === '已达到保险单上载明的住院医疗保险金'));
      assert.ok(!rows.some((row) => row.liability === '外伤害身故保险金'));
      assert.equal(rows.find((row) => row.liability === '身故保险金').coverage_type, '身故保障');
      assert.equal(rows.find((row) => row.liability === '后续年金').coverage_type, '现金流');
      assert.equal(rows.find((row) => row.liability === '住院津贴保险金').coverage_type, '津贴保障');
      assert.equal(rows.find((row) => row.liability === '身故或身体高度残疾保险金').coverage_type, '身故保障');
      const optionalPayload = JSON.parse(rows.find((row) => (
        row.liability === '身故保险金'
        && JSON.parse(row.payload).sourceRecordId === '101'
      )).payload);
      assert.equal(optionalPayload.responsibilityScope, 'optional');
      const medicalPayload = JSON.parse(rows.find((row) => (
        row.liability === '住院医疗保险金'
        && JSON.parse(row.payload).sourceRecordId === '107'
      )).payload);
      assert.equal(medicalPayload.responsibilityScope, 'basic');
      assert.equal(medicalPayload.formulaText, '住院医疗保险金 = (实际合理医疗费用 - 已获补偿 - 免赔额/起付金额) × 100%');
      assert.equal(medicalPayload.value, 100);
      assert.equal(medicalPayload.unit, '%');
      assert.equal(medicalPayload.sourceRecordId, '107');
      const parameterizedMedicalPayload = JSON.parse(rows.find((row) => (
        row.liability === '住院医疗保险金'
        && JSON.parse(row.payload).sourceRecordId === '100'
      )).payload);
      assert.equal(parameterizedMedicalPayload.formulaText, '住院医疗保险金 = (实际合理医疗费用 - 已获补偿/给付 - 免赔额) × 约定给付比例');
      assert.equal(parameterizedMedicalPayload.unit, '公式');
      assert.equal(parameterizedMedicalPayload.basis, '实际合理医疗费用、已获补偿/给付、免赔额、约定给付比例');
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
      const maxPayload = JSON.parse(rows.find((row) => (
        row.liability === '身故保险金'
        && JSON.parse(row.payload).sourceRecordId === '114'
      )).payload);
      assert.equal(maxPayload.formulaText, '身故保险金 = max(现金价值, 已交保险费)');
      const maturityPayload = JSON.parse(rows.find((row) => (
        row.liability === '满期金'
        && JSON.parse(row.payload).sourceRecordId === '114'
      )).payload);
      assert.equal(maturityPayload.formulaText, '满期金 = 已交保险费');
      const paidPremiumPercentPayload = JSON.parse(rows.find((row) => row.liability === '满期生存保险金').payload);
      assert.equal(paidPremiumPercentPayload.formulaText, '满期生存保险金 = 已交保险费及附加险已交保险费之和 × 110%');
      assert.equal(paidPremiumPercentPayload.value, 110);
      assert.equal(paidPremiumPercentPayload.unit, '%');
      const residualTermMaxPayload = JSON.parse(rows.find((row) => row.liability === '高残保险金').payload);
      assert.equal(residualTermMaxPayload.formulaText, '高残保险金 = max(基本保险金额, 剩余保险期间 × 基本保险金额 / 10)');
      const equivalentAmountPayload = JSON.parse(rows.find((row) => row.liability === '重大疾病额外保险金').payload);
      assert.equal(equivalentAmountPayload.formulaText, '重大疾病额外保险金 = 基本保险金额 × 80%');
      const limitGuardPayload = JSON.parse(rows.find((row) => (
        row.liability === '身故保险金'
        && JSON.parse(row.payload).sourceRecordId === '125'
      )).payload);
      assert.equal(limitGuardPayload.formulaText, '身故保险金 = 基本保险金额 × 100%');
      const paidPremiumMaxPayload = JSON.parse(rows.find((row) => (
        row.liability === '身故保险金'
        && JSON.parse(row.payload).sourceRecordId === '128'
      )).payload);
      assert.equal(paidPremiumMaxPayload.formulaText, '身故保险金 = max(已交保险费 × 110%, 主险及附加险现金价值之和)');
      const accidentalDeathPayload = JSON.parse(rows.find((row) => (
        row.liability === '身故保险金'
        && JSON.parse(row.payload).sourceRecordId === '130'
      )).payload);
      assert.equal(accidentalDeathPayload.coverageType, '意外身故保障');
      const limitBalanceDeathPayload = JSON.parse(rows.find((row) => (
        row.liability === '意外身故保险金'
        && JSON.parse(row.payload).sourceRecordId === '133'
      )).payload);
      assert.equal(limitBalanceDeathPayload.formulaText, '意外身故保险金 = 给付限额 - 已给付伤残保险金');
      assert.doesNotMatch(limitBalanceDeathPayload.formulaText, /账户价值/u);
      const tableLimitMedicalPayload = JSON.parse(rows.find((row) => (
        row.liability === '境内医疗保险金'
        && JSON.parse(row.payload).sourceRecordId === '131'
      )).payload);
      assert.equal(tableLimitMedicalPayload.formulaText, '境内医疗保险金 = (实际合理医疗费用 - 已获补偿 - 免赔额/起付金额) × 100%');
      const terminationMedicalPayload = JSON.parse(rows.find((row) => (
        row.liability === '住院医疗保险金'
        && JSON.parse(row.payload).sourceRecordId === '132'
      )).payload);
      assert.equal(terminationMedicalPayload.formulaText, '住院医疗保险金 = (实际合理医疗费用 - 已获补偿 - 免赔额/起付金额) × 80%');
      const brokenHeaderPayload = JSON.parse(rows.find((row) => (
        row.liability === '意外伤害身故保险金'
        && JSON.parse(row.payload).sourceRecordId === '134'
      )).payload);
      assert.equal(brokenHeaderPayload.formulaText, '意外伤害身故保险金 = 基本保险金额 × 100%');
      const conditionalPercentPayload = JSON.parse(rows.find((row) => (
        row.liability === '质子重离子医疗保险金'
        && JSON.parse(row.payload).sourceRecordId === '135'
      )).payload);
      assert.equal(conditionalPercentPayload.formulaText, '质子重离子医疗保险金 = (实际合理医疗费用 - 已获补偿/给付 - 免赔额) × 约定给付比例');
      assert.doesNotMatch(conditionalPercentPayload.formulaText, /60%/u);
      const advancedTherapyPayload = JSON.parse(rows.find((row) => (
        row.liability === '恶性肿瘤先进疗法医疗保险金'
        && JSON.parse(row.payload).sourceRecordId === '138'
      )).payload);
      assert.equal(advancedTherapyPayload.coverageType, '医疗保障');
      assert.equal(advancedTherapyPayload.formulaText, '恶性肿瘤先进疗法医疗保险金 = (实际合理医疗费用 - 已获补偿/给付 - 免赔额) × 约定给付比例');
      assert.equal(advancedTherapyPayload.unit, '公式');
      const drugPayload = JSON.parse(rows.find((row) => (
        row.liability === '恶性肿瘤--重度院外特定药品费用医疗保险金'
        && JSON.parse(row.payload).sourceRecordId === '139'
      )).payload);
      assert.equal(drugPayload.formulaText, '恶性肿瘤--重度院外特定药品费用医疗保险金 = (实际合理医疗费用 - 已获补偿/给付 - 免赔额) × 约定给付比例');
      const devicePayload = JSON.parse(rows.find((row) => (
        row.liability === '恶性肿瘤--重度特定器械耗材费用医疗保险金'
        && JSON.parse(row.payload).sourceRecordId === '139'
      )).payload);
      assert.equal(devicePayload.formulaText, '恶性肿瘤--重度特定器械耗材费用医疗保险金 = (实际合理医疗费用 - 已获补偿/给付 - 免赔额) × 约定给付比例');
      const plannedAnnuityPayload = JSON.parse(rows.find((row) => (
        row.liability === '养老年金'
        && JSON.parse(row.payload).sourceRecordId === '136'
      )).payload);
      assert.equal(plannedAnnuityPayload.formulaText, '养老年金 = 基本保险金额 × 约定领取比例');
      const birthdayPayload = JSON.parse(rows.find((row) => (
        row.liability === '祝寿金'
        && JSON.parse(row.payload).sourceRecordId === '136'
      )).payload);
      assert.equal(birthdayPayload.formulaText, '祝寿金 = 已交保险费');
      const boundaryMaturityPayload = JSON.parse(rows.find((row) => (
        row.liability === '满期金'
        && JSON.parse(row.payload).sourceRecordId === '136'
      )).payload);
      assert.equal(boundaryMaturityPayload.formulaText, '满期金 = 基本保险金额 × 10');
      const boundaryDeathPayload = JSON.parse(rows.find((row) => (
        row.liability === '身故保险金'
        && JSON.parse(row.payload).sourceRecordId === '136'
      )).payload);
      assert.equal(boundaryDeathPayload.formulaText, '身故保险金 = max(现金价值, 已交保险费)');
      const nonAccidentDeathPayload = JSON.parse(rows.find((row) => (
        row.liability === '非意外身故保险金'
        && JSON.parse(row.payload).sourceRecordId === '137'
      )).payload);
      assert.equal(nonAccidentDeathPayload.coverageType, '身故保障');
      assert.equal(nonAccidentDeathPayload.formulaText, '非意外身故保险金 = 基本保险金额 × 50%');
      const accountPayload = JSON.parse(rows.find((row) => row.liability === '养老保险金').payload);
      assert.equal(accountPayload.formulaText, '养老保险金 = 个人账户价值');
      assert.equal(accountPayload.basis, '个人账户价值');
      const diseasePayload = JSON.parse(rows.find((row) => row.liability === '首次重大疾病保险金').payload);
      assert.equal(diseasePayload.formulaText, '首次重大疾病保险金 = 基本保险金额 × 100%');
      const fixedDailyPayload = JSON.parse(rows.find((row) => row.liability === '重症监护室津贴保险金').payload);
      assert.equal(fixedDailyPayload.formulaText, '重症监护室津贴保险金 = 给付天数 × 日津贴额 1000 元');
      assert.equal(fixedDailyPayload.unit, '元/日');
      const unitDailyPayload = JSON.parse(rows.find((row) => row.liability === '意外住院津贴保险金').payload);
      assert.equal(unitDailyPayload.formulaText, '意外住院津贴保险金 = 给付天数 × 每单位日津贴额 10 元 × 保险单位数');
      assert.equal(unitDailyPayload.unit, '元/单位/日');
      const diagnosisPayload = JSON.parse(rows.find((row) => row.liability === '少儿特定重大疾病确诊金').payload);
      assert.equal(diagnosisPayload.formulaText, '少儿特定重大疾病确诊金 = 保险金额 × 100%');
      assert.equal(diagnosisPayload.coverageType, '重大疾病保障');
      const spacedAllowancePayload = JSON.parse(rows.find((row) => (
        row.liability === '意外伤害住院津贴保险金'
        && JSON.parse(row.payload).sourceRecordId === '120'
      )).payload);
      assert.equal(spacedAllowancePayload.formulaText, '意外伤害住院津贴保险金 = 给付天数 × 基本保险金额');
      const optionalMedicalPayload = JSON.parse(rows.find((row) => row.liability === '意外伤害医疗保险金').payload);
      assert.equal(optionalMedicalPayload.formulaText, '意外伤害医疗保险金 = (实际合理医疗费用 - 已获补偿/给付 - 免赔额) × 约定给付比例');
      assert.equal(optionalMedicalPayload.unit, '公式');
      assert.equal(optionalMedicalPayload.responsibilityScope, 'optional');
      const variableAllowancePayload = JSON.parse(rows.find((row) => (
        row.liability === '意外伤害住院津贴保险金'
        && JSON.parse(row.payload).sourceRecordId === '121'
      )).payload);
      assert.equal(variableAllowancePayload.formulaText, '意外伤害住院津贴保险金 = 给付天数 × 住院日额津贴');
      assert.equal(variableAllowancePayload.unit, '公式');
      assert.equal(variableAllowancePayload.responsibilityScope, 'optional');
      const generalDailyPayload = JSON.parse(rows.find((row) => (
        row.liability === '一般住院日额津贴保险金'
        && JSON.parse(row.payload).sourceRecordId === '122'
      )).payload);
      assert.equal(generalDailyPayload.formulaText, '一般住院日额津贴保险金 = 给付天数 × 住院日额津贴');
      assert.equal(generalDailyPayload.basis, '给付天数、住院日额津贴、疾病住院扣减3日');
      assert.equal(generalDailyPayload.responsibilityScope, 'basic');
      const cancerDailyPayload = JSON.parse(rows.find((row) => (
        row.liability === '恶性肿瘤住院日额津贴保险金'
        && JSON.parse(row.payload).sourceRecordId === '122'
      )).payload);
      assert.equal(cancerDailyPayload.formulaText, '恶性肿瘤住院日额津贴保险金 = 给付天数 × 住院日额津贴');
      assert.equal(cancerDailyPayload.responsibilityScope, 'optional');
      const icuDailyPayload = JSON.parse(rows.find((row) => (
        row.liability === '重症监护日额津贴保险金'
        && JSON.parse(row.payload).sourceRecordId === '122'
      )).payload);
      assert.equal(icuDailyPayload.formulaText, '重症监护日额津贴保险金 = 给付天数 × 日津贴额');
      assert.equal(icuDailyPayload.responsibilityScope, 'optional');
      const total = readDb.prepare('SELECT COUNT(*) AS count FROM insurance_indicator_records').get().count;
      assert.equal(total, 52);
    } finally {
      readDb.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
