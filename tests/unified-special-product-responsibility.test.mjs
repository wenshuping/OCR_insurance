import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyUnifiedSpecialProductEvaluation,
  buildOfficialResponsibilityInventory,
  buildSpecialProductDatabaseSummary,
  routeUnifiedSpecialProductResponsibility,
} from '../server/unified-special-product-responsibility.mjs';

const company = '示例人寿保险有限公司';
const productName = '示例终身保险';

function universalChain(digest = 'sha256:universal-v1', { fields = true } = {}) {
  const body = fields ? [
    '第十条 本合同设置万能账户，账户价值按本条款计算。',
    '第十一条 万能账户最低保证利率为年利率2%，结算利率按月公布并按日复利结算。',
    '第十二条 趸交初始费用为保险费的1%，追加保险费初始费用为每笔追加保险费的2%。',
    '第十三条 每月扣除保单管理费0元，另收取风险保险费0.1%。',
    '第十四条 部分领取手续费按领取金额的3%收取，退保手续费按保单年度阶梯收取。',
    '第十五条 部分领取须满足合同生效满一年，领取后账户价值不得低于约定最低余额。',
  ].join('\n') : '第十条 本合同设置万能账户。';
  return {
    artifacts: [{
      company,
      productName,
      sourceDigest: digest,
      audit: { status: 'approved' },
      sourceExcerpt: `目录：最低保证利率为年利率1%。\n${body}`,
    }],
    cards: [{
      company,
      productName,
      sourceDigest: digest,
      title: '身故保险金',
      plainSummary: '被保险人身故，按合同约定给付身故保险金。',
      sourceExcerpt: body,
    }, {
      company,
      productName,
      sourceDigest: digest,
      title: '账户价值',
      plainSummary: '万能账户账户价值按条款规则计算。',
      sourceExcerpt: body,
    }],
    indicators: [{
      company,
      productName,
      sourceDigest: digest,
      sourceExcerpt: body,
      formulaText: body,
    }],
  };
}

function incrementalChain(digest = 'sha256:incremental-v1', { formula = true } = {}) {
  const growth = formula
    ? '第一个保单年度有效保险金额等于基本保险金额；自第二个保单年度起，当年度有效保险金额等于上一保单年度有效保险金额×(1+3.5%)。'
    : '第一个保单年度按基本保险金额确定。';
  const benefit = '被保险人身故或全残，按已交保险费、现金价值、当年度有效保险金额三者中的较大者给付。';
  return {
    artifacts: [{
      company,
      productName: '示例增额终身寿险',
      sourceDigest: digest,
      audit: { status: 'approved' },
      productIdentity: { productType: '终身寿险' },
      productRules: formula ? [{
        calculation: {
          formulaText: '基本保险金额 × (1+3.5%)^(n-1)',
          normalizedFormula: 'effective_insured_amount_n = basic_insured_amount * (1+0.035)^(n-1)',
          requiredInputs: ['基本保险金额', '保单年度 n'],
          operands: ['基本保险金额', 'r'],
          branches: ['身故或全残时取三者较大者'],
        },
        sourceExcerpt: growth,
      }] : [],
      responsibilities: [{ sourceExcerpt: `${growth}${benefit}` }],
    }],
    cards: [{
      company,
      productName: '示例增额终身寿险',
      sourceDigest: digest,
      title: '身故或全残保险金',
      plainSummary: benefit,
      sourceExcerpt: `${growth}${benefit}`,
    }],
    indicators: [{
      company,
      productName: '示例增额终身寿险',
      sourceDigest: digest,
      formulaText: growth,
      normalizedFormula: 'effective_insured_amount_n = effective_insured_amount_{n-1} * (1+0.035)',
      requiredInputs: ['基本保险金额', '保单年度 n'],
      operands: ['基本保险金额', 'r'],
      branches: ['身故或全残时取三者较大者'],
      sourceExcerpt: benefit,
    }],
  };
}

function routeEvidence(evidence, name = productName) {
  return routeUnifiedSpecialProductResponsibility({ company, productName: name, ...evidence });
}

test('universal lane prefers substantive article body over contents-page rate', () => {
  const result = routeEvidence(universalChain());
  assert.equal(result.category, 'universal_account');
  assert.equal(result.sourceDigest, 'sha256:universal-v1');
  assert.equal(result.universalAccount.fields.minimumGuaranteedRate.value, '2%');
  assert.match(result.universalAccount.fields.settlement.value, /按月公布/u);
});

test('universal lane accepts an exact 万能型 product identity with official personal-account clauses', () => {
  const evidence = universalChain('sha256:universal-product-identity');
  const universalProductName = '示例两全保险（万能型）';
  evidence.artifacts = evidence.artifacts.map((artifact) => ({
    ...artifact,
    productName: universalProductName,
    sourceExcerpt: '第十条 本合同个人账户价值按本条款计算。',
  }));
  evidence.cards = evidence.cards.map((card) => ({
    ...card,
    productName: universalProductName,
    sourceExcerpt: card.sourceExcerpt.replaceAll('万能账户', '个人账户'),
  }));
  evidence.indicators = evidence.indicators.map((indicator) => ({
    ...indicator,
    productName: universalProductName,
    sourceExcerpt: indicator.sourceExcerpt.replaceAll('万能账户', '个人账户'),
    formulaText: indicator.formulaText.replaceAll('万能账户', '个人账户'),
  }));
  const result = routeEvidence(evidence, universalProductName);
  assert.equal(result.category, 'universal_account');
  assert.equal(result.evidenceGates.universalAccount.officialUniversalIdentity, true);
});

test('universal lane reads account fields from structured artifact product overview', () => {
  const evidence = universalChain('sha256:universal-structured-overview');
  const universalProductName = '示例两全保险（万能型）';
  evidence.artifacts = evidence.artifacts.map((artifact) => ({
    ...artifact,
    productName: universalProductName,
    sourceExcerpt: '第十条 本合同个人账户价值按本条款计算。',
    productOverview: {
      mainFunctions: ['保单账户价值按条款规则积累增长', '最低保证利率为年利率1%'],
      importantLimits: [
        '初始费用：一次性支付3%，约定追加1%，自主追加3%',
        '部分领取/退保费用在保单年度前5年递增至0%',
      ],
    },
  }));
  evidence.cards = evidence.cards.map((card) => ({
    ...card,
    productName: universalProductName,
    sourceExcerpt: '第十条 身故保险金按合同给付。',
  }));
  evidence.indicators = evidence.indicators.map((indicator) => ({
    ...indicator,
    productName: universalProductName,
    sourceExcerpt: '第十条 身故保险金按合同给付。',
    formulaText: '身故保险金按合同给付。',
  }));

  const result = routeEvidence(evidence, universalProductName);
  assert.equal(result.category, 'universal_account');
  assert.equal(result.universalAccount.eligible, true);
  assert.equal(result.universalAccount.fields.minimumGuaranteedRate.value, '1%');
  assert.match(result.universalAccount.fields.singlePremiumInitialCharge.value, /3%/u);
  assert.match(result.universalAccount.fields.additionalPremiumInitialCharge.value, /1%/u);
  assert.match(result.universalAccount.fields.accountValueRule.value, /积累增长/u);
});

test('universal lane retains substantive clauses that mention a product summary later in the source', () => {
  const evidence = universalChain('sha256:universal-with-summary-word');
  evidence.cards = evidence.cards.map((card) => ({ ...card, sourceExcerpt: `${card.sourceExcerpt}\n产品摘要以正式条款为准。` }));
  evidence.indicators = evidence.indicators.map((indicator) => ({ ...indicator, sourceExcerpt: `${indicator.sourceExcerpt}\n产品摘要以正式条款为准。` }));
  evidence.artifacts = evidence.artifacts.map((artifact) => ({ ...artifact, sourceExcerpt: `${artifact.sourceExcerpt}\n产品摘要以正式条款为准。` }));
  const result = routeEvidence(evidence);
  assert.equal(result.category, 'universal_account');
  assert.equal(result.universalAccount.fields.minimumGuaranteedRate.value, '2%');
});

test('universal lane keeps single and additional premium charges separate', () => {
  const result = routeEvidence(universalChain());
  assert.match(result.universalAccount.fields.singlePremiumInitialCharge.value, /1%/u);
  assert.match(result.universalAccount.fields.additionalPremiumInitialCharge.value, /2%/u);
  assert.notEqual(
    result.universalAccount.fields.singlePremiumInitialCharge.value,
    result.universalAccount.fields.additionalPremiumInitialCharge.value,
  );
});

test('universal lane selects numeric fee clauses and retains account fee rules', () => {
  const evidence = universalChain('sha256:universal-fee-clause');
  const body = [
    '第十条 本合同设置万能账户，建立个人账户，每次交纳保险费在扣除初始费用后计入个人账户。',
    '第十一条 一次性交纳保险费的初始费用收取比例为3%；追加保险费的初始费用收取比例为3%。',
    '第十二条 保单管理费为每月0元；风险保险费按风险保额和年龄费率按月收取。',
    '第十三条 我们于每月初确定账户结算利率，按日复利计算个人账户价值。',
    '第十四条 部分领取手续费率如下：第一年至第五年为5%/4%/3%/2%/1%。',
    '第十五条 退保手续费率如下：第一年至第五年为5%/4%/3%/2%/1%。',
  ].join('\n');
  evidence.artifacts[0].sourceExcerpt = body;
  evidence.cards = evidence.cards.map((card) => ({ ...card, sourceExcerpt: body }));
  evidence.indicators = evidence.indicators.map((indicator) => ({ ...indicator, sourceExcerpt: body, formulaText: body }));
  const result = routeEvidence(evidence);

  assert.equal(result.category, 'universal_account');
  assert.equal(result.universalAccount.fields.singlePremiumInitialCharge.value, '3%');
  assert.equal(result.universalAccount.fields.additionalPremiumInitialCharge.value, '3%');
  assert.match(result.universalAccount.fields.managementAndRiskFees.value, /每月0元/u);
  assert.match(result.universalAccount.fields.settlement.value, /按日复利/u);
  assert.match(result.universalAccount.fields.withdrawalAndSurrenderCharges.value, /部分领取手续费率/u);
  assert.match(result.universalAccount.fields.withdrawalAndSurrenderCharges.value, /退保手续费率/u);
});

test('universal lane omits unsupported fields and reports blockers', () => {
  const result = routeEvidence(universalChain('sha256:universal-sparse', { fields: false }));
  assert.equal(result.category, 'blocked');
  assert.equal(result.universalAccount.productFunctions.length, 0);
  assert.ok(result.blockers.includes('missing_official_account_field_evidence'));
  assert.ok(result.blockers.includes('missing_account_field:additionalPremiumInitialCharge'));
});

test('official PDF fields remain displayable without an approved persistence chain', () => {
  const result = routeUnifiedSpecialProductResponsibility({
    company: '中国平安',
    productName: '平安招财宝终身寿险（万能型）',
    cards: [{
      company: '中国平安',
      productName: '平安招财宝终身寿险（万能型）',
      title: '身故保险金',
      plainSummary: '被保险人身故，按合同约定给付。',
    }],
    sourceRecords: [{
      company: '中国平安',
      productName: '平安招财宝终身寿险（万能型）',
      url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=853&versionNo=853-1&attachmentType=1',
      sourceType: 'pdf',
      official: true,
      evidenceLevel: 'insurer_official',
      sourceDigest: 'sha256:853-1',
      sourceAcquisition: { strategy: 'bound_official_pdf', identityVerified: true, pdfMagicVerified: true },
      pageText: [
        '第十条 本合同设置万能账户，账户价值按条款规则计算。',
        '第十一条 最低保证利率为年利率2%。',
        '第十二条 结算利率按月公布。',
      ].join('\n'),
    }],
  });

  assert.equal(result.category, 'blocked');
  assert.equal(result.universalAccount.eligible, false);
  assert.equal(result.universalAccount.status, 'display_only');
  assert.equal(result.fieldEvidenceDisplay.mode, 'display-only');
  assert.equal(result.fieldEvidenceDisplay.persistenceStatus, 'persistence-not-aligned');
  assert.equal(result.fieldEvidenceDisplay.calculationEligible, false);
  assert.match(result.fieldEvidenceDisplay.fields.minimumGuaranteedRate.value, /2%/u);
  assert.equal(result.fieldEvidenceDisplay.fields.singlePremiumInitialCharge, undefined);
  assert.equal(result.ordinaryResponsibilities.length, 1);
  assert.equal(result.ordinaryResponsibilities[0].title, '身故保险金');
  assert.ok(result.blockers.includes('source_chain_not_aligned'));
});

test('legacy universal evidence without a source digest holds instead of becoming ordinary', () => {
  const legacyProductName = '示例万能终身寿险（万能型）';
  const result = routeUnifiedSpecialProductResponsibility({
    company,
    productName: legacyProductName,
    cards: [{
      company,
      productName: legacyProductName,
      title: '身故保险金',
      plainSummary: '身故保险金按基本保险金额与保单账户价值的较大者给付。',
    }],
    sourceRecords: [{
      company,
      productName: legacyProductName,
      official: true,
      url: 'https://official.example.test/legacy-universal.pdf',
      pageText: '第十条 被保险人身故，按基本保险金额与保单账户价值的较大者给付身故保险金。',
    }],
  });

  assert.equal(result.category, 'blocked');
  assert.equal(result.universalAccount.status, 'hold');
  assert.equal(result.universalAccount.productFunctions.length, 0);
  assert.ok(result.blockers.includes('source_chain_not_aligned'));
  assert.equal(result.ordinaryResponsibilities[0].title, '身故保险金');
});

test('official materials from the same plan version merge for display instead of becoming a version conflict', () => {
  const baseUrl = 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=853&versionNo=853-1';
  const result = routeUnifiedSpecialProductResponsibility({
    company: '中国平安',
    productName: '平安招财宝终身寿险（万能型）',
    cards: [{
      company: '中国平安',
      productName: '平安招财宝终身寿险（万能型）',
      title: '身故保险金',
      plainSummary: '被保险人身故，按合同约定给付。',
    }],
    sourceRecords: [{
      company: '中国平安',
      productName: '平安招财宝终身寿险（万能型）',
      url: `${baseUrl}&attachmentType=7`,
      sourceType: 'pdf',
      official: true,
      evidenceLevel: 'insurer_official',
      sourceDigest: 'sha256:product-description',
      sourceAcquisition: { strategy: 'bound_official_pdf', identityVerified: true, pdfMagicVerified: true },
      pageText: '第十条 本合同设置万能账户。第十一条 结算利率按月公布。',
    }, {
      company: '中国平安',
      productName: '平安招财宝终身寿险（万能型）',
      url: `${baseUrl}&attachmentType=1`,
      sourceType: 'pdf',
      official: true,
      evidenceLevel: 'insurer_official',
      sourceDigest: 'sha256:policy-terms',
      sourceAcquisition: { strategy: 'bound_official_pdf', identityVerified: true, pdfMagicVerified: true },
      pageText: '第十二条 最低保证利率为年利率1.75%。第十三条 部分领取须满足合同约定。',
    }],
  });

  assert.equal(result.category, 'blocked');
  assert.equal(result.fieldEvidenceDisplay.status, 'display_only');
  assert.equal(result.fieldEvidenceDisplay.sourceDigest, 'sha256:policy-terms');
  assert.match(result.fieldEvidenceDisplay.fields.minimumGuaranteedRate.value, /1\.75%/u);
  assert.match(result.fieldEvidenceDisplay.fields.settlement.value, /按月公布/u);
  assert.equal(result.fieldEvidenceDisplay.blockers.includes('version_conflict'), false);
});

test('source-only field evidence keeps line-level excerpts instead of copying the whole PDF projection', () => {
  const result = routeUnifiedSpecialProductResponsibility({
    company: '中国平安',
    productName: '平安招财宝终身寿险（万能型）',
    sourceRecords: [{
      company: '中国平安',
      productName: '平安招财宝终身寿险（万能型）',
      url: 'https://life.pingan.com/terms.pdf',
      sourceType: 'pdf',
      official: true,
      evidenceLevel: 'insurer_official',
      sourceDigest: 'sha256:line-level-evidence',
      sourceAcquisition: { strategy: 'bound_official_pdf', identityVerified: true, pdfMagicVerified: true },
      pageText: [
        '本产品提供最低保证利率，保单账户价值按不低于保证利率累积',
        '本行不应进入最低保证利率字段，结算利率按月公布',
        '部分领取须在犹豫期后申请，领取后账户价值不得低于最低余额',
      ].join('\n'),
    }],
  });

  assert.equal(result.fieldEvidenceDisplay.fields.minimumGuaranteedRate.value, '本产品提供最低保证利率，保单账户价值按不低于保证利率累积');
  assert.doesNotMatch(result.fieldEvidenceDisplay.fields.minimumGuaranteedRate.value, /本行不应进入/u);
  assert.match(result.fieldEvidenceDisplay.fields.withdrawalEligibilityAndLimits.value, /部分领取须在犹豫期后申请/u);
  assert.doesNotMatch(result.fieldEvidenceDisplay.fields.withdrawalEligibilityAndLimits.value, /结算利率/u);
});

test('cross-insurance display evidence is projected field by field from one official PDF digest', () => {
  const result = routeUnifiedSpecialProductResponsibility({
    company,
    productName: '示例综合保障保险',
    sourceRecords: [{
      company,
      productName: '示例综合保障保险',
      url: 'https://official.example.test/composite.pdf',
      sourceType: 'pdf',
      official: true,
      evidenceLevel: 'insurer_official',
      sourceDigest: 'sha256:composite-v1',
      pageText: [
        '第十条 医疗保险金年度免赔额为1万元，赔付比例为80%，限二级及以上医院。',
        '第十一条 重大疾病分为六组，最多给付六次，相邻两次间隔期为180日，并豁免后续保险费。',
        '第十二条 意外伤残按伤残等级对应的给付比例给付，航空意外另行给付。',
        '第十三条 当年度有效保险金额等于基本保险金额×(1+3%)^(n-1)。',
        '第十四条 年金可按年领取或按月领取，月领折算系数为0.085，期满给付满期保险金。',
      ].join('\n'),
    }],
  });

  const fields = result.fieldEvidenceDisplay.fields;
  assert.match(fields.medicalDeductible.value, /1万元/u);
  assert.match(fields.medicalPaymentRatio.value, /80%/u);
  assert.match(fields.medicalHospitalScope.value, /二级及以上医院/u);
  assert.match(fields.criticalDiseaseGrouping.value, /六组/u);
  assert.match(fields.criticalPaymentCount.value, /六次/u);
  assert.match(fields.criticalInterval.value, /180日/u);
  assert.match(fields.criticalPremiumWaiver.value, /豁免/u);
  assert.match(fields.accidentDisabilityGrade.value, /伤残等级/u);
  assert.match(fields.effectiveInsuredAmountFormula.value, /1\+3%/u);
  assert.match(fields.annuityPaymentFrequency.value, /按年领取/u);
  assert.match(fields.annuityMonthlyFactor.value, /0\.085/u);
  assert.match(fields.maturityBenefit.value, /满期保险金/u);
  assert.equal(fields.medicalWaitingPeriod, undefined);
});

test('customer database fast path emits productFunctions without model work and preserves ordinary responsibility', () => {
  const evidence = universalChain();
  const summary = {
    headline: '本产品提供身故保障。',
    mainResponsibilities: [{ title: '身故保险金', plainText: '身故按合同给付。' }],
    contentBlocks: [
      { blockKey: 'productPurpose', order: 1, content: '本产品提供身故保障。' },
      { blockKey: 'responsibilities', order: 2, content: '身故保险金：身故按合同给付。' },
      { blockKey: 'productFunctions', order: 3, enabled: true, content: '模型不应补充的内容' },
    ],
  };
  const result = buildSpecialProductDatabaseSummary({ summary, evidence: { company, productName, ...evidence } });
  assert.equal(result.source, 'database');
  assert.equal(result.evaluation.category, 'universal_account');
  assert.match(result.summary.contentBlocks.find((block) => block.blockKey === 'productFunctions').content, /趸交\/一次交清初始费用/u);
  assert.match(result.summary.contentBlocks.find((block) => block.blockKey === 'responsibilities').content, /身故保险金/u);
  assert.doesNotMatch(result.summary.contentBlocks.find((block) => block.blockKey === 'productFunctions').content, /模型不应补充/u);
});

test('universal identity makes the two special lanes mutually exclusive', () => {
  const evidence = universalChain();
  evidence.artifacts[0].productName = '示例增额终身寿险（万能型）';
  evidence.cards = evidence.cards.map((card) => ({ ...card, productName: '示例增额终身寿险（万能型）' }));
  evidence.indicators = evidence.indicators.map((indicator) => ({ ...indicator, productName: '示例增额终身寿险（万能型）' }));
  const result = routeEvidence(evidence, '示例增额终身寿险（万能型）');
  assert.equal(result.category, 'universal_account');
  assert.equal(result.incrementalWholeLife.status, 'mutually_exclusive');
  assert.equal(result.evidenceGates.incrementalWholeLife.evaluated, false);
});

test('incremental lane accepts explicit formula and preserves formula structure and r role', () => {
  const evidence = incrementalChain();
  const result = routeEvidence(evidence, '示例增额终身寿险');
  assert.equal(result.category, 'incremental_whole_life');
  assert.equal(result.incrementalWholeLife.path, 'explicit_expanded');
  assert.equal(result.incrementalWholeLife.formula.normalizedFormula[0], 'effective_insured_amount_n = basic_insured_amount * (1+0.035)^(n-1)');
  assert.deepEqual(result.incrementalWholeLife.formula.requiredInputs, ['基本保险金额', '保单年度 n']);
  assert.match(result.incrementalWholeLife.productPurpose, /有效保险金额/u);
  assert.match(result.incrementalWholeLife.productPurpose, /不是收益率/u);
});

test('incremental lane accepts equivalent recurrence and requires death or total-disability linkage', () => {
  const evidence = incrementalChain('sha256:incremental-recurrence');
  evidence.artifacts[0].productRules = [];
  const result = routeEvidence(evidence, '示例增额终身寿险');
  assert.equal(result.category, 'incremental_whole_life');
  assert.equal(result.incrementalWholeLife.path, 'equivalent_recurrence');
  assert.equal(result.incrementalWholeLife.gates.benefitAssociation, true);
  assert.equal(result.incrementalWholeLife.gates.paidCashComparison, true);
});

test('incremental lane does not classify a product without an explicit formula', () => {
  const evidence = incrementalChain('sha256:incremental-no-formula', { formula: false });
  const result = routeEvidence(evidence, '示例增额终身寿险');
  assert.equal(result.category, 'ordinary');
  assert.equal(result.incrementalWholeLife.eligible, false);
  assert.ok(result.blockers.includes('missing_three_gate_evidence'));
});

test('same product name with two independently renderable digests is a version conflict', () => {
  const first = universalChain('sha256:universal-a');
  const second = universalChain('sha256:universal-b');
  const result = routeUnifiedSpecialProductResponsibility({
    company,
    productName,
    artifacts: [...first.artifacts, ...second.artifacts],
    cards: [...first.cards, ...second.cards],
    indicators: [...first.indicators, ...second.indicators],
  });
  assert.equal(result.category, 'blocked');
  assert.equal(result.universalAccount.status, 'version_conflict');
  assert.ok(result.blockers.includes('version_conflict'));
});

test('shared inventory assigns one owner per responsibility and keeps payment profiles reusable', () => {
  const evidence = universalChain();
  const responsibilities = [
    {
      responsibilityId: 'r-annuity',
      title: '养老年金',
      sourceExcerpt: '第十六条 被保险人生存至约定日期，按年领取养老年金。',
    },
    {
      responsibilityId: 'r-accident-medical',
      title: '意外伤害医疗费用保险金',
      sourceExcerpt: '第十七条 因意外导致医疗费用，按实际费用报销。',
      topology: 'rider',
    },
    {
      responsibilityId: 'r-endowment',
      title: '身故保险金',
      sourceExcerpt: '第十八条 被保险人身故，按已交保险费与现金价值的较大者给付。',
      topology: 'standalone',
    },
  ];
  const result = routeUnifiedSpecialProductResponsibility({
    company,
    productName,
    productCategory: 'endowment',
    ...evidence,
    responsibilities,
  });
  assert.deepEqual(result.responsibilityInventory.ownerProfiles.sort(), ['accident', 'annuity', 'endowment']);
  assert.equal(result.responsibilityInventory.status, 'approved');
  const accidentMedical = result.responsibilityInventory.responsibilities.find((item) => item.responsibilityId === 'r-accident-medical');
  assert.equal(accidentMedical.ownerProfile, 'accident');
  assert.equal(accidentMedical.paymentProfile, 'medical_reimbursement');
  assert.equal(accidentMedical.topology, 'rider');
  assert.equal(accidentMedical.sourceDigest, 'sha256:universal-v1');
  assert.ok(result.categories.includes('annuity'));
});

test('inventory models topology orthogonally for whole-life and accident extra benefits', () => {
  const inventory = buildOfficialResponsibilityInventory({
    sourceDigest: 'sha256:topology-v1',
    productCategory: 'endowment',
    responsibilities: [
      { responsibilityId: 'base-life', title: '身故保险金', sourceExcerpt: '第六条 身故按现金价值与已交保费较大者给付。', topology: 'standalone' },
      { responsibilityId: 'accident-extra', title: '交通意外额外给付', sourceExcerpt: '第七条 交通意外身故额外给付基本保险金额。', topology: 'rider' },
    ],
  });
  assert.equal(inventory.status, 'approved');
  assert.equal(inventory.responsibilities.find((item) => item.responsibilityId === 'base-life').ownerProfile, 'endowment');
  assert.equal(inventory.responsibilities.find((item) => item.responsibilityId === 'accident-extra').ownerProfile, 'accident');
  assert.deepEqual(inventory.responsibilities.map((item) => item.topology), ['standalone', 'rider']);
  assert.ok(inventory.paymentProfiles.includes('max_min_comparison'));
});

test('duplicate responsibility id with owner disagreement enters review and never overwrites', () => {
  const inventory = buildOfficialResponsibilityInventory({
    sourceDigest: 'sha256:conflict-v1',
    responsibilities: [
      { responsibilityId: 'same-id', title: '意外医疗', ownerProfile: 'accident', sourceExcerpt: '第十条 意外导致医疗费用，按实际费用报销。' },
      { responsibilityId: 'same-id', title: '意外医疗', ownerProfile: 'medical', sourceExcerpt: '第十条 意外导致医疗费用，按实际费用报销。' },
    ],
  });
  assert.equal(inventory.status, 'review');
  assert.equal(inventory.responsibilities.length, 1);
  assert.equal(inventory.responsibilities[0].ownerProfile, 'accident');
  assert.ok(inventory.conflicts.some((conflict) => conflict.reason === 'owner_conflict'));
  assert.equal(inventory.gates.oneOwnerPerResponsibility, false);
});

test('inventory rejects a responsibility packet from a different source digest', () => {
  const inventory = buildOfficialResponsibilityInventory({
    sourceDigest: 'sha256:source-a',
    responsibilities: [{
      responsibilityId: 'wrong-source',
      title: '身故保险金',
      sourceDigest: 'sha256:source-b',
      sourceExcerpt: '第十条 身故按合同约定给付。',
    }],
  });
  assert.equal(inventory.status, 'review');
  assert.equal(inventory.gates.sourceDigestAligned, false);
  assert.ok(inventory.conflicts.some((conflict) => conflict.reason === 'source_digest_conflict'));
});
