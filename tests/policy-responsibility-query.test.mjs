import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExternalReferenceResponsibilityAnalysis,
  buildLocalKnowledgeResponsibilityAnalysis,
  queryPolicyAndPlanResponsibilities,
  queryPolicyResponsibilities,
} from '../server/policy-responsibility-query.mjs';
import {
  indicatorsFromResponsibilityCards,
  knowledgeRecordsFromResponsibilityAnalysis,
} from '../server/responsibility-lookup-artifacts.mjs';
import { extractStructuredResponsibilitySections } from '../server/responsibility-section-extractor.mjs';
import {
  JRCPCX_TERMS_EVIDENCE_LEVEL,
  LEGACY_EXTERNAL_REFERENCE_LEVEL,
  buildKnowledgeSearchArtifacts,
  callDeepSeekForOpenWebSearchPlan,
  crawlOpenWebProductReferenceRecords,
  findKnowledgeProductCandidates,
  legacyExternalProductReferenceRecords,
  searchOfficialProductSalesStatuses,
  upsertKnowledgeRecords,
  withPolicyProductMatchStatus,
} from '../server/policy-knowledge.service.mjs';

test('responsibility query retries once when the first model response is empty', async () => {
  const calls = [];
  const result = await queryPolicyResponsibilities({
    scan: {
      ocrText: '新华保险 安鑫优选终身护理保险 护理保险金 疾病身故保险金',
      data: {
        company: '新华保险',
        name: '安鑫优选终身护理保险',
        coveragePeriod: '终身',
        amount: 60312,
        firstPremium: 2400,
      },
    },
    query: async (input) => {
      calls.push(input);
      if (calls.length === 1) return { coverageTable: [] };
      return {
        coverageTable: [
          {
            coverageType: '护理保险金',
            scenario: '被保险人达到护理保险金给付条件',
            payout: '按合同约定给付护理保险金',
            note: '给付后合同终止',
          },
        ],
      };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(result.coverageTable.length, 1);
  assert.equal(result.coverageTable[0].coverageType, '护理保险金');
});

test('responsibility card indicators persist with canonical calculation inputs', () => {
  const policy = {
    company: '新华保险',
    name: '测试多倍保障重大疾病保险',
    amount: 500000,
  };
  const evidence = {
    sourceUrl: 'customer-policy-terms://knowledge/test',
    sourceTitle: '客户上传保单责任页/合同页',
    sourceKind: 'customer_policy_terms',
    evidenceLevel: 'customer_policy_terms',
    verificationStatus: 'verified',
    referenceOnly: false,
    official: true,
  };
  const indicators = indicatorsFromResponsibilityCards({
    policy,
    cards: [
      {
        ...evidence,
        id: 'card-critical',
        title: '轻症疾病保险金',
        category: '疾病保障',
        triggerCondition: '被保险人确诊合同约定轻症疾病',
        payoutSummary: '按基本保险金额的20%给付',
        formulaText: '轻症疾病保险金 = 基本保险金额的20%',
        basis: '基本保险金额',
        value: 20,
        unit: '%',
        cashflowTreatment: 'claim_contingent',
        sourceExcerpt: '轻症疾病保险金 被保险人确诊轻症疾病，本公司按基本保险金额的20%给付轻症疾病保险金。',
      },
      {
        ...evidence,
        id: 'card-medical',
        title: '疾病医疗保险金',
        category: '医疗保障',
        triggerCondition: '被保险人发生合同约定医疗费用',
        payoutSummary: '按实际合理医疗费用扣除免赔额后补偿',
        formulaText: '疾病医疗保险金 = 实际医疗费用 - 免赔额',
        basis: '实际医疗费用',
        cashflowTreatment: 'claim_contingent',
        sourceExcerpt: '疾病医疗保险金 被保险人发生实际合理医疗费用，本公司按约定免赔额和赔付比例补偿医疗费用。',
      },
    ],
  });

  assert.equal(indicators.length, 2);
  const critical = indicators.find((item) => item.liability === '轻症疾病保险金');
  assert.ok(critical);
  assert.equal(critical.calculationEligible, true);
  assert.equal(critical.calculationKey, 'percent_of_basic_amount');
  assert.deepEqual(critical.requiredInputs, ['policy.amount']);
  const medical = indicators.find((item) => item.liability === '疾病医疗保险金');
  assert.ok(medical);
  assert.equal(medical.calculationEligible, false);
  assert.equal(medical.calculationKey, 'medical_formula');
  assert.deepEqual(medical.requiredInputs, ['actualMedicalExpense', 'deductible', 'reimbursementRate', 'thirdPartyPaid', 'liabilityLimit']);
  assert.equal(medical.calculationStatus, 'needs_table');
});

test('responsibility query can limit retry attempts for manual online lookup', async () => {
  const calls = [];
  await assert.rejects(
    () =>
      queryPolicyResponsibilities({
        scan: {
          ocrText: '新华保险 尊享人生两全',
          data: {
            company: '新华保险',
            name: '尊享人生两全',
          },
        },
        maxAttempts: 1,
        query: async (input) => {
          calls.push(input);
          return { coverageTable: [] };
        },
      }),
    /保险责任查询未返回责任明细/u,
  );

  assert.equal(calls.length, 1);
});

test('responsibility query uses local knowledge before Feishu knowledge lookup', async () => {
  let feishuCalled = false;
  const calls = [];
  const result = await queryPolicyResponsibilities({
    scan: {
      ocrText: '中国平安 平安福 身故保险金',
      data: {
        company: '中国平安',
        name: '平安福',
      },
    },
    knowledgeRecords: [
      {
        company: '中国平安',
        productName: '平安福',
        title: '平安福保险条款',
        url: 'https://life.pingan.com/products/pinganfu-local.pdf',
        pageText: '平安福保险责任包括身故保险金。',
        official: true,
        sourceType: 'pdf',
      },
    ],
    resolveFeishuKnowledgeRecords: async () => {
      feishuCalled = true;
      return [];
    },
    query: async (input) => {
      calls.push(input);
      return {
        coverageTable: [
          {
            coverageType: '身故保险金',
            scenario: '被保险人身故',
            payout: '按合同约定给付',
          },
        ],
      };
    },
  });

  assert.equal(feishuCalled, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].knowledgeRecords[0].url, 'https://life.pingan.com/products/pinganfu-local.pdf');
  assert.equal(result.coverageTable[0].coverageType, '身故保险金');
});

test('responsibility query uses Feishu knowledge before falling back to the current query path', async () => {
  const calls = [];
  const result = await queryPolicyResponsibilities({
    scan: {
      ocrText: '中国平安 平安福 重大疾病保险金',
      data: {
        company: '中国平安',
        name: '平安福',
      },
    },
    knowledgeRecords: [],
    resolveFeishuKnowledgeRecords: async ({ policy }) => {
      assert.equal(policy.company, '中国平安');
      assert.equal(policy.name, '平安福');
      return [
        {
          company: '中国平安',
          productName: '平安福',
          title: '平安福飞书条款',
          url: 'https://life.pingan.com/products/pinganfu-feishu.pdf',
          pageText: '平安福保险责任包括重大疾病保险金。',
          official: true,
          sourceType: 'pdf',
          evidenceLabel: '飞书知识库官方资料',
        },
      ];
    },
    query: async (input) => {
      calls.push(input);
      return {
        coverageTable: [
          {
            coverageType: '重大疾病保险金',
            scenario: '被保险人确诊合同约定重大疾病',
            payout: '按合同约定给付',
          },
        ],
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].knowledgeRecords[0].url, 'https://life.pingan.com/products/pinganfu-feishu.pdf');
  assert.equal(calls[0].knowledgeRecords[0].evidenceLabel, '飞书知识库官方资料');
  assert.equal(result.coverageTable[0].coverageType, '重大疾病保险金');
});

test('responsibility query prefers multi-source expert synthesis before the external review fallback', async () => {
  const calls = [];
  const result = await queryPolicyResponsibilities({
    scan: {
      ocrText: '中国人寿 潇洒明天',
      data: {
        company: '中国人寿',
        name: '潇洒明天',
      },
    },
    preferLocalKnowledgeAnswer: true,
    allowExternalReferences: true,
    knowledgeRecords: [
      {
        company: '中国人寿',
        productName: '潇洒明天',
        title: '潇洒明天外部资料',
        url: 'https://insurance.example.test/xiaosa',
        snippet: '非官方公开资料提及保险责任。',
        pageText: '保险责任：被保险人身故，按合同约定给付身故保险金。',
        official: false,
        sourceKind: 'open_web_reference',
        evidenceLabel: '非官方资料，待保险公司确认',
        evidenceLevel: LEGACY_EXTERNAL_REFERENCE_LEVEL,
        responsibilityDeferred: true,
      },
    ],
    query: async (input) => {
      calls.push(input);
      return {
        analysis: {
          coverageTable: [
            {
              coverageType: '保险金给付',
              liability: '身故保险金',
              scenario: '非官方公开资料称被保险人身故。',
              payout: '按合同约定给付身故保险金。',
              sourceExcerpt: '被保险人身故，按合同约定给付身故保险金。',
              note: '非官方资料待保险公司确认',
            },
          ],
        },
        sources: input.knowledgeRecords.map((record) => ({
          title: record.title,
          url: record.url,
          snippet: record.snippet,
          evidenceLabel: record.evidenceLabel,
          evidenceLevel: record.evidenceLevel,
          official: record.official,
          sourceKind: record.sourceKind,
        })),
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(result.rawAnalysis.generatedBy, 'multi_source_external_analysis');
  assert.equal(result.coverageTable[0].coverageType, '身故保险金');
  assert.match(result.coverageTable[0].scenario, /被保险人身故/u);
  assert.equal(result.coverageTable[0].sourceUrl, 'https://insurance.example.test/xiaosa');
  assert.equal(result.coverageTable[0].sourceTitle, '潇洒明天外部资料');
  assert.equal(result.sources[0].official, false);
  assert.equal(result.sources[0].evidenceLevel, LEGACY_EXTERNAL_REFERENCE_LEVEL);
});

test('external responsibility synthesis merges shared plan responsibilities without dropping plan differences', async () => {
  const result = await queryPolicyResponsibilities({
    scan: { data: { company: '测试承保公司', name: '测试惠民医疗险' } },
    allowExternalReferences: true,
    knowledgeRecords: [{
      company: '测试承保公司',
      productName: '测试惠民医疗险',
      title: '测试惠民医疗险公开资料',
      url: 'https://reference.test/medical',
      pageText: '医保目录内合规自付费用补充医疗保障。住院津贴。',
      official: false,
      sourceKind: 'open_web_reference',
      evidenceLevel: LEGACY_EXTERNAL_REFERENCE_LEVEL,
    }],
    query: async () => ({
      analysis: { coverageTable: [
        {
          coverageType: '基础版-医保目录内合规自付费用补充医疗保障',
          scenario: '基本医保报销后的目录内费用',
          payout: '最高限额100万元',
          sourceExcerpt: '资料1：医保目录内合规自付费用补充医疗保障。',
        },
        {
          coverageType: '升级版-医保目录内合规自付费用补充医疗保障',
          scenario: '基本医保报销后的目录内费用',
          payout: '最高限额150万元',
          sourceExcerpt: '资料1：医保目录内合规自付费用补充医疗保障。',
        },
        {
          coverageType: '升级版-住院津贴',
          scenario: '住院治疗',
          payout: '每日100元',
          sourceExcerpt: '资料1：住院津贴。',
        },
      ] },
      sources: [{ title: '测试惠民医疗险公开资料', url: 'https://reference.test/medical' }],
    }),
  });

  assert.equal(result.coverageTable.length, 2);
  assert.equal(result.coverageTable[0].coverageType, '医保目录内合规自付费用补充医疗保障');
  assert.match(result.coverageTable[0].scenario, /基础版：.*升级版：/u);
  assert.match(result.coverageTable[0].payout, /基础版：最高限额100万元.*升级版：最高限额150万元/u);
  assert.equal(result.coverageTable[1].coverageType, '住院津贴');
  assert.match(result.coverageTable[1].scenario, /升级版：住院治疗/u);
});

test('customer policy photo candidates require approval before global matching', () => {
  const policy = { company: '新华保险', name: '测试多倍保障重大疾病保险' };
  const pendingRecord = {
    company: '新华保险',
    productName: '测试多倍保障重大疾病保险',
    title: '客户补充保单照片识别：测试多倍保障重大疾病保险',
    url: 'customer-policy-photo://knowledge/pending',
    pageText: '产品名称:测试多倍保障重大疾病保险\n保险责任:可选责任一。',
    official: false,
    sourceKind: 'customer_policy_photo',
    evidenceLevel: 'customer_policy_photo_pending',
    reviewStatus: 'pending',
    globalSearchable: false,
    responsibilityDeferred: true,
  };
  const approvedRecord = {
    ...pendingRecord,
    url: 'customer-policy-photo://knowledge/approved',
    evidenceLevel: 'customer_policy_photo_reviewed',
    reviewStatus: 'approved',
    globalSearchable: true,
  };

  const pendingMatches = findKnowledgeProductCandidates({
    policy,
    records: [pendingRecord],
    includeCustomerPolicyPhotoRecords: true,
    requirePageText: false,
  });
  assert.equal(pendingMatches.length, 0);

  const approvedMatches = findKnowledgeProductCandidates({
    policy,
    records: [approvedRecord],
    includeCustomerPolicyPhotoRecords: true,
    requirePageText: false,
  });
  assert.equal(approvedMatches.length, 1);
  assert.equal(approvedMatches[0].sourceKind, 'customer_policy_photo');
  const resolved = withPolicyProductMatchStatus({ policy, matches: approvedMatches });
  assert.equal(resolved.status, 'candidates');
  assert.equal(resolved.matches[0].needsConfirmation, true);
});

test('responsibility lookup artifacts keep external review sources non-official', () => {
  const records = knowledgeRecordsFromResponsibilityAnalysis({
    policy: {
      company: '中国人寿',
      name: '潇洒明天',
    },
    analysis: {
      coverageTable: [
        {
          coverageType: '身故保险金',
          scenario: '被保险人身故。',
          payout: '按合同约定给付。',
          note: '非官方资料待保险公司确认',
        },
      ],
      sources: [
        {
          title: '潇洒明天外部资料',
          url: 'https://insurance.example.test/xiaosa',
          snippet: '非官方公开资料。',
          official: false,
          sourceKind: 'open_web_reference',
          evidenceLevel: LEGACY_EXTERNAL_REFERENCE_LEVEL,
        },
      ],
    },
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].official, false);
  assert.equal(records[0].sourceKind, 'open_web_reference');
  assert.equal(records[0].evidenceLevel, LEGACY_EXTERNAL_REFERENCE_LEVEL);
  assert.equal(records[0].materialType, 'external_reference');
});

test('responsibility query artifacts expose official responsibility text for customer summary extraction', () => {
  const records = knowledgeRecordsFromResponsibilityAnalysis({
    policy: {
      company: '中国人寿',
      name: '国寿99鸿福两全保险',
    },
    analysis: {
      coverageTable: [
        {
          coverageType: '身故保险金',
          scenario: '被保险人身故。',
          payout: '保险金额 x 100%',
        },
        {
          coverageType: '生存保险金',
          scenario: '被保险人生存至合同约定日期。',
          payout: '保险金额',
        },
      ],
      sources: [
        {
          title: '国寿99鸿福两全保险条款',
          url: 'https://www.e-chinalife.com/upload/resources/file/productBasicInfo/a79b6c2e-14c3-11ee-a6ed-bc97e1225d40/100_国寿99鸿福两全保险条款.pdf',
          snippet: '中国人寿官网条款，已截取保险责任正文段。',
          official: true,
          sourceKind: 'insurer_official',
          evidenceLevel: 'insurer_official',
          sourceType: 'pdf',
          materialType: 'terms',
        },
      ],
    },
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].parser, 'responsibility_query');
  assert.equal(records[0].qualityStatus, 'valid_responsibility_refilled');
  assert.match(records[0].responsibilityText, /身故保险金/u);

  const sections = extractStructuredResponsibilitySections({
    productCategory: 'annuity',
    records,
  });

  assert.equal(sections.quality.status, 'complete');
  assert.match(sections.mainResponsibilityText, /生存保险金/u);
});

test('external reference responsibility fallback returns review rows when model is empty', async () => {
  const result = await queryPolicyResponsibilities({
    scan: {
      ocrText: '中国人寿 潇洒明天',
      data: {
        company: '中国人寿',
        name: '潇洒明天',
      },
    },
    allowExternalReferences: true,
    knowledgeRecords: [
      {
        company: '中国人寿',
        productName: '潇洒明天',
        title: '潇洒明天外部资料',
        url: 'https://insurance.example.test/xiaosa',
        snippet: '非官方公开资料提及保险责任。',
        pageText: '保障条款：生存保险金，每三周年给付10%的保额。身故保险金，按合同约定给付基本保额。',
        official: false,
        sourceKind: 'open_web_reference',
        evidenceLabel: '非官方资料，待保险公司确认',
        evidenceLevel: LEGACY_EXTERNAL_REFERENCE_LEVEL,
        responsibilityDeferred: true,
      },
    ],
    query: async () => ({ coverageTable: [] }),
  });

  assert.equal(result.rawAnalysis.generatedBy, 'external_reference_review_fallback');
  assert.equal(result.coverageTable[0].coverageType, '生存保险金（待核实）');
  assert.match(result.coverageTable[0].scenario, /生存金/u);
  assert.equal(result.coverageTable[0].payout, '外部资料称按保额的10%给付。');
  assert.equal(result.coverageTable[0].referenceOnly, true);
  assert.equal(result.coverageTable[0].verificationStatus, 'pending_review');
  assert.equal(result.sources[0].official, false);
  assert.equal(result.sources[0].referenceOnly, true);
});

test('external reference fallback formats old popular products into concise review rows', () => {
  const analysis = buildExternalReferenceResponsibilityAnalysis([
    {
      company: '中国人寿',
      productName: '潇洒明天',
      title: '中国人寿潇洒明天-基础知识-金投保险-金投网',
      url: 'https://insurance.cngold.org/jczs/c3246186.html',
      snippet: '第三方网页称“潇洒明天”是一份增额终身人寿保险。',
      pageText: '中国人寿潇洒明天-基础知识-金投保险-金投网 金投首页 黄金 白银 原油 外汇 正文 中国人寿潇洒明天 据了解，中国人寿“潇洒明天”其中生命保障会在基本保额的基础上按每年保额的5%增长，并且每3年领取生存金是保额的10%直至终身。相关推荐 上海银保监局等三部门联合发文。',
      official: false,
      sourceKind: 'open_web_reference',
      evidenceLevel: LEGACY_EXTERNAL_REFERENCE_LEVEL,
    },
    {
      company: '中国人寿',
      productName: '潇洒明天',
      title: '人寿保险潇洒明天险种',
      url: 'https://www.shenlanbao.com/he/1608721',
      snippet: '第三方保险内容站提及“潇洒明天”相关老产品信息。',
      pageText: '潇洒明天相关老产品信息：包含身故保险金和生存保险金等责任线索。',
      official: false,
      sourceKind: 'legacy_external_reference',
      evidenceLevel: LEGACY_EXTERNAL_REFERENCE_LEVEL,
    },
  ]);

  assert.equal(analysis.coverageTable.length, 3);
  assert.deepEqual(
    analysis.coverageTable.map((row) => row.coverageType),
    ['生存保险金（待核实）', '生存金累积（待核实）', '身故保险金（待核实）'],
  );
  const renderedText = analysis.coverageTable.map((row) => `${row.coverageType} ${row.scenario} ${row.payout}`).join('\n');
  assert.match(renderedText, /每生存满三周年/u);
  assert.match(renderedText, /身故/u);
  assert.doesNotMatch(renderedText, /金投首页|黄金|相关推荐|银保监局/u);
});

test('external reference fallback extracts numbered responsibilities without product-specific rules', () => {
  const result = buildExternalReferenceResponsibilityAnalysis([
    {
      company: '测试联合承保公司',
      productName: '城市惠民保障',
      productType: '重疾险',
      title: '热门重大疾病保险｜城市惠民保障计划',
      url: 'https://reference.test/coverage',
      pageText: [
        '保障责任 责任一：医保目录内合规自付费用补充医疗保障。',
        '扣除年度累计0.9万元起付线后，按10%至80%报销，年度累计最高支付限额120万元。',
        '责任二：医保目录外合理医疗费用补充医疗保障。',
        '扣除年度累计1万元起付线后，按30%至70%报销，年度累计最高支付限额120万元。',
      ].join(' '),
      official: false,
      sourceKind: 'open_web_reference',
      evidenceLevel: 'external_reference',
      referenceOnly: true,
    },
    {
      company: '测试联合承保公司',
      productName: '城市惠民医疗险',
      title: '产品资讯导航页',
      url: 'https://reference.test/navigation',
      pageText: '当前位置 登录 免费注册 我的保单 客服热线 产品测评 保险问答 '.repeat(100),
      official: false,
      sourceKind: 'open_web_reference',
      evidenceLevel: 'external_reference',
      referenceOnly: true,
    },
  ]);

  assert.equal(result.coverageTable.length, 2);
  assert.match(result.coverageTable[0].coverageType, /责任一.*医保目录内/u);
  assert.match(result.coverageTable[0].payout, /0\.9万元起付线/u);
  assert.match(result.coverageTable[1].coverageType, /责任二.*医保目录外/u);
  assert.ok(result.coverageTable.every((row) => row.referenceOnly === true && row.official === false));
  assert.equal(result.rawAnalysis.productCategory, 'medical');
  assert.deepEqual(result.sources.map((source) => source.url), ['https://reference.test/coverage']);
  assert.doesNotMatch(JSON.stringify(result.coverageTable), /当前位置|登录|免费注册|我的保单|客服热线/u);
});

test('external reference fallback summarizes enumerated coverage changes as separate responsibility cards', () => {
  const result = buildExternalReferenceResponsibilityAnalysis([{
    company: '测试保险公司',
    productName: '测试保障产品',
    title: '测试保障产品公开说明',
    url: 'https://reference.test/updates',
    pageText: [
      '保障责任主要有三点：',
      '一是新增“住院津贴保障”，住院期间按每日200元给付；',
      '二是提升重大疾病保险金额度，最高保额增加至50万元；',
      '三是增加保费豁免责任，符合约定条件时豁免后续保费。',
      '四是截至2026年1月1日，持有本地居住证连续满2年以上。',
    ].join(''),
    official: false,
    sourceKind: 'open_web_reference',
    evidenceLevel: 'external_reference',
    referenceOnly: true,
  }]);

  assert.equal(result.coverageTable.length, 3);
  assert.match(result.coverageTable[0].coverageType, /住院津贴保障/u);
  assert.match(result.coverageTable[0].payout, /每日200元给付/u);
  assert.match(result.coverageTable[1].coverageType, /重大疾病保险金额度/u);
  assert.match(result.coverageTable[2].coverageType, /保费豁免责任/u);
  assert.doesNotMatch(JSON.stringify(result.coverageTable), /居住证/u);
});

test('derived external review records cannot overwrite richer crawled responsibility text', () => {
  const state = { knowledgeRecords: [{
    id: 1,
    company: '测试保险公司',
    productName: '测试保障产品',
    title: '测试保障产品保障计划',
    url: 'https://reference.test/coverage',
    pageText: '责任一：身故保险金。被保险人身故时按基本保险金额给付。'.repeat(30),
    snippet: '包含完整责任正文和给付规则',
    official: false,
    sourceKind: 'open_web_reference',
    evidenceLevel: 'external_reference',
    referenceOnly: true,
    parser: 'deepseek_planned_open_web_search',
  }] };

  upsertKnowledgeRecords(state, [{
    company: '测试保险公司',
    productName: '测试保障产品',
    title: '测试保障产品公开介绍',
    url: 'https://reference.test/coverage',
    pageText: '测试保障产品公开介绍',
    snippet: '公开介绍',
    official: false,
    sourceKind: 'open_web_reference',
    evidenceLevel: 'external_reference',
    referenceOnly: true,
    parser: 'external_review_query_source',
  }]);

  assert.match(state.knowledgeRecords[0].pageText, /责任一：身故保险金/u);
  assert.equal(state.knowledgeRecords[0].parser, 'deepseek_planned_open_web_search');
  assert.equal(state.knowledgeRecords[0].snippet, '包含完整责任正文和给付规则');
});

test('external knowledge search prefers responsibility-rich pages over newer title-only cache rows', () => {
  const artifacts = buildKnowledgeSearchArtifacts({
    policy: { company: '测试联合承保公司', name: '城市惠民医疗险' },
    includeExternalReferences: true,
    records: [
      {
        company: '测试联合承保公司', productName: '城市惠民医疗险',
        title: '城市惠民医疗险公开介绍', url: 'https://reference.test/thin',
        pageText: '城市惠民医疗险公开介绍', official: false,
        sourceKind: 'open_web_reference', referenceOnly: true,
        updatedAt: '2026-07-18T00:00:00.000Z',
      },
      {
        company: '测试联合承保公司', productName: '城市惠民医疗险',
        title: '城市惠民医疗险保障计划', url: 'https://reference.test/rich',
        pageText: '保障责任：责任一：医保目录内费用按约定报销。责任二：医保目录外费用按约定报销。',
        official: false, sourceKind: 'open_web_reference', referenceOnly: true,
        updatedAt: '2026-07-17T00:00:00.000Z',
      },
    ],
  });

  assert.equal(artifacts.records[0].url, 'https://reference.test/rich');
});

test('external knowledge search excludes explicitly stale annual terms when current-year sources are available', () => {
  const currentYear = new Date().getFullYear();
  const staleYear = currentYear - 1;
  const common = {
    company: '测试联合承保公司', productName: '城市惠民医疗险',
    official: false, sourceKind: 'open_web_reference', referenceOnly: true,
  };
  const artifacts = buildKnowledgeSearchArtifacts({
    policy: { company: common.company, name: common.productName },
    includeExternalReferences: true,
    maxResults: 8,
    records: [
      {
        ...common, title: `${staleYear}城市惠民医疗险详细保障`, url: 'https://reference.test/stale',
        pageText: `${staleYear}责任五起付线5万元，报销比例10%。`,
      },
      {
        ...common, title: `${currentYear}城市惠民医疗险保障方案`, url: 'https://reference.test/current-1',
        pageText: `${currentYear}责任五起付线3万元，报销比例20%。`,
      },
      {
        ...common, title: `${currentYear}城市惠民医疗险理赔须知`, url: 'https://reference.test/current-2',
        pageText: `${currentYear}中断后重新投保，报销比例按规则调整。`,
      },
      {
        ...common, title: '城市惠民医疗险官网入口', url: 'https://reference.test/yearless',
        pageText: '城市惠民医疗险产品入口。',
      },
    ],
  });

  assert.ok(artifacts.records.some((record) => record.url === 'https://reference.test/current-1'));
  assert.ok(artifacts.records.some((record) => record.url === 'https://reference.test/yearless'));
  assert.ok(!artifacts.records.some((record) => record.url === 'https://reference.test/stale'));
});

test('buildExternalReferenceResponsibilityAnalysis ignores official-only records', () => {
  assert.equal(
    buildExternalReferenceResponsibilityAnalysis([
      {
        company: '中国人寿',
        productName: '潇洒明天',
        title: '官方条款',
        url: 'https://www.e-chinalife.com/xiaosa.pdf',
        pageText: '保险责任 身故保险金。',
        official: true,
        evidenceLevel: 'insurer_official',
      },
    ]),
    null,
  );
});

test('knowledge product candidates fuzzy match similar local official products', () => {
  const matches = findKnowledgeProductCandidates({
    policy: { company: '新华保险', name: '尊享人生两全' },
    officialDomainProfiles: [
      {
        company: '新华保险',
        aliases: ['新华保险', '新华人寿'],
        siteDomains: ['static-cdn.newchinalife.com'],
        officialDomains: ['static-cdn.newchinalife.com'],
      },
    ],
    records: [
      {
        company: '新华保险',
        productName: '尊享人生年金保险（分红型）',
        title: '尊享人生年金保险（分红型）',
        url: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
        pageText: '保险责任包括关爱年金、生存保险金、身故或身体全残保险金。',
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
      },
      {
        company: '新华保险',
        productName: '新华人寿保险股份有限公司尊尚人生两全保险（分红型）',
        title: '新华人寿保险股份有限公司尊尚人生两全保险（分红型）',
        url: 'https://static-cdn.newchinalife.com/ncl/pdf/zunshang.pdf',
        pageText: '保险责任包括生存保险金、满期保险金、身故保险金。',
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
      },
      {
        company: '新华保险',
        productName: '健康无忧重大疾病保险',
        title: '健康无忧重大疾病保险',
        url: 'https://static-cdn.newchinalife.com/ncl/pdf/health.pdf',
        pageText: '保险责任包括重大疾病保险金。',
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
      },
    ],
  });

  assert.ok(matches.length >= 2);
  assert.ok(matches.some((match) => match.productName === '尊享人生年金保险（分红型）'));
  assert.ok(matches.some((match) => match.productName === '新华人寿保险股份有限公司尊尚人生两全保险（分红型）'));
  assert.equal(matches.some((match) => match.productName === '健康无忧重大疾病保险'), false);
  for (const match of matches) {
    assert.match(match.canonicalProductId, /^product_[a-f0-9]{16}$/u);
  }
  const zunxiang = matches.find((match) => match.productName === '尊享人生年金保险（分红型）');
  const zunshang = matches.find((match) => match.productName === '新华人寿保险股份有限公司尊尚人生两全保险（分红型）');
  assert.notEqual(zunxiang.canonicalProductId, zunshang.canonicalProductId);
});

test('knowledge product candidates can query across insurers when company is omitted', () => {
  const matches = findKnowledgeProductCandidates({
    policy: { name: '城市惠民医疗保险' },
    minScore: 0.1,
    requirePageText: false,
    records: [
      {
        company: '甲保险', productName: '甲市城市惠民医疗保险',
        title: '甲市城市惠民医疗保险', url: 'https://example-a.test/terms.pdf',
        official: true, sourceKind: 'jrcpcx',
      },
      {
        company: '乙保险', productName: '乙市城市惠民医疗保险',
        title: '乙市城市惠民医疗保险', url: 'https://example-b.test/terms.pdf',
        official: true, sourceKind: 'jrcpcx',
      },
    ],
  });

  assert.deepEqual(matches.map((match) => match.company).sort(), ['乙保险', '甲保险']);
});

test('knowledge product candidates expose product codes and rank matching code first', () => {
  const matches = findKnowledgeProductCandidates({
    policy: { company: '中国平安', name: '聚财宝（844）' },
    officialDomainProfiles: [
      {
        company: '中国平安',
        aliases: ['中国平安', '平安'],
        siteDomains: ['life.pingan.com'],
        officialDomains: ['life.pingan.com'],
      },
    ],
    records: [
      {
        company: '中国平安',
        productName: '平安附加聚财宝两全保险（万能型，2015）',
        title: '平安附加聚财宝两全保险（万能型，2015）产品条款',
        url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=848&versionNo=848-1&attachmentType=1',
        pageText: '保险责任包括身故保险金。',
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
      },
      {
        company: '中国平安',
        productName: '平安附加聚财宝两全保险（万能型）',
        title: '平安附加聚财宝两全保险（万能型）产品条款',
        url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=844&versionNo=844-1&attachmentType=1',
        pageText: '保险责任包括身故保险金。',
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
      },
    ],
  });

  assert.equal(matches[0].productName, '平安附加聚财宝两全保险（万能型）');
  assert.equal(matches[0].productCode, '844');
  assert.deepEqual(matches[0].productCodes, ['844']);
  assert.equal(matches[0].bestSource.productCode, '844');
  assert.equal(matches[0].matchReason, '产品代码 844');
});

test('knowledge product candidates rank strict exact product version before loose normalized variants', () => {
  const matches = findKnowledgeProductCandidates({
    policy: { company: '友邦人寿', name: '友邦附加安益意外医药补偿（2020）医疗保险' },
    officialDomainProfiles: [
      {
        company: '友邦人寿',
        aliases: ['友邦人寿'],
        siteDomains: ['aia.com.cn'],
        officialDomains: ['aia.com.cn'],
      },
    ],
    records: [
      {
        company: '友邦人寿',
        productName: '友邦附加安益意外医药补偿医疗保险',
        title: '友邦附加安益意外医药补偿医疗保险产品条款',
        url: 'https://www.aia.com.cn/public/unversioned-terms-a.pdf',
        pageText: '第二条保险责任 本公司给付意外医药费用补偿金。',
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
      },
      {
        company: '友邦人寿',
        productName: '友邦附加安益意外医药补偿医疗保险',
        title: '友邦附加安益意外医药补偿医疗保险产品说明书',
        url: 'https://www.aia.com.cn/public/unversioned-manual.pdf',
        pageText: '保险责任 包括意外医药费用补偿金。',
        official: true,
        sourceType: 'pdf',
        materialType: 'product_manual',
      },
      {
        company: '友邦人寿',
        productName: '友邦附加安益意外医药补偿（2020）医疗保险',
        title: '友邦附加安益意外医药补偿（2020）医疗保险产品条款',
        url: 'https://www.aia.com.cn/public/versioned-terms.pdf',
        pageText: '第二条保险责任 本公司支付意外医药费用补偿金。',
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
      },
    ],
  });

  assert.equal(matches[0].productName, '友邦附加安益意外医药补偿（2020）医疗保险');
  assert.equal(matches[0].bestSource.url, 'https://www.aia.com.cn/public/versioned-terms.pdf');
});

test('knowledge product match status gates fuzzy and version-near matches behind confirmation', () => {
  const policy = { company: '新华保险', name: '多倍保障智享版' };
  const { status, matches } = withPolicyProductMatchStatus({
    policy,
    matches: [
      {
        company: '新华保险',
        productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
        title: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）条款',
        score: 0.92,
        matchReason: '产品名称高度相近',
        evidenceLabel: '本地知识库官方资料',
        sourceCount: 1,
      },
      {
        company: '新华保险',
        productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）',
        title: '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）条款',
        score: 0.89,
        matchReason: '产品名称高度相近',
        evidenceLabel: '本地知识库官方资料',
        sourceCount: 1,
      },
    ],
  });

  assert.equal(status, 'candidates');
  assert.equal(matches.length, 2);
  assert.equal(matches.every((match) => match.needsConfirmation), true);
});

test('knowledge product match status allows a single strict official name correction', () => {
  const { status, matches } = withPolicyProductMatchStatus({
    policy: { company: '友邦人寿', name: '友邦附加安益意外医药补偿（2020）医疗保险' },
    matches: [
      {
        company: '友邦人寿',
        productName: '友邦附加安益意外医药补偿（2020）医疗保险',
        title: '友邦附加安益意外医药补偿（2020）医疗保险产品条款',
        score: 1,
        matchReason: '官方产品名完全一致',
        evidenceLabel: '本地知识库官方资料',
        sourceCount: 1,
      },
    ],
  });

  assert.equal(status, 'exact');
  assert.equal(matches[0].needsConfirmation, false);
  assert.equal(matches[0].resolvedProductName, '友邦附加安益意外医药补偿（2020）医疗保险');
});

test('knowledge product candidates can expose JRCPCX catalog records as confirmation-only candidates', () => {
  const matches = findKnowledgeProductCandidates({
    policy: { company: '测试人寿保险有限公司', name: '安心重大疾病保险' },
    records: [
      {
        company: '测试人寿保险有限公司',
        productName: '测试安心重大疾病保险',
        title: '测试安心重大疾病保险条款',
        url: 'https://www.jrcpcx.cn/#/query?catalogId=test',
        official: true,
        officialDomain: 'inspdinfo.iachina.cn',
        sourceKind: 'jrcpcx',
        evidenceLevel: JRCPCX_TERMS_EVIDENCE_LEVEL,
        evidenceLabel: '金融产品查询平台/中国保险行业协会条款 PDF',
        materialType: 'terms',
        pageText: '',
      },
    ],
    minScore: 0.1,
    requirePageText: false,
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].sourceKind, 'jrcpcx');
  assert.equal(matches[0].evidenceLevel, JRCPCX_TERMS_EVIDENCE_LEVEL);
  assert.equal(matches[0].needsConfirmation, true);
});

test('legacy external product references expose old popular products as non-official candidates', () => {
  const records = legacyExternalProductReferenceRecords({
    policy: { company: '中国人寿', name: '潇洒明天' },
  });
  const matches = findKnowledgeProductCandidates({
    policy: { company: '中国人寿', name: '潇洒明天' },
    records,
    minScore: 0.1,
    requirePageText: false,
    includeExternalReferences: true,
  });

  assert.ok(records.length >= 1);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].sourceKind, 'legacy_external_reference');
  assert.equal(matches[0].evidenceLevel, LEGACY_EXTERNAL_REFERENCE_LEVEL);
  assert.equal(matches[0].responsibilityDeferred, true);
  assert.equal(matches[0].needsConfirmation, true);
});

test('DeepSeek open web search plan can produce dynamic external reference records', async () => {
  const requests = [];
  const fakeSearchHtml = `
    <html><body>
      <div class="result">
        <a class="result__a" href="https://insurance.example.test/xiaosa">中国人寿潇洒明天保险介绍</a>
        <a class="result__snippet">第三方网页提及中国人寿潇洒明天老产品。</a>
      </div>
    </body></html>
  `;
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), body: options.body });
    if (String(url).includes('/chat/completions')) {
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                queries: ['中国人寿 潇洒明天 老产品'],
                preferredDomains: ['insurance.example.test'],
              }),
            },
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(fakeSearchHtml, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const policy = { company: '中国人寿', name: '潇洒明天' };
  const plan = await callDeepSeekForOpenWebSearchPlan({
    policy,
    fetchImpl,
    env: {
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: 'https://deepseek.example.test',
      DEEPSEEK_OPEN_WEB_SEARCH_MODEL: 'deepseek-v4-flash',
    },
  });
  const result = await crawlOpenWebProductReferenceRecords({
    policy,
    fetchImpl,
    searchPlan: plan,
    maxResults: 5,
  });
  const matches = findKnowledgeProductCandidates({
    policy,
    records: result.records,
    minScore: 0.1,
    requirePageText: false,
    includeExternalReferences: true,
  });
  const gated = withPolicyProductMatchStatus({ policy, matches });

  assert.equal(plan.queries[0], '中国人寿 潇洒明天 老产品');
  assert.equal(result.status, 'candidates');
  assert.equal(result.records[0].sourceKind, 'open_web_reference');
  assert.equal(result.records[0].responsibilityDeferred, true);
  assert.equal(gated.status, 'candidates');
  assert.equal(gated.matches[0].needsConfirmation, true);
  assert.ok(requests.some((request) => request.url.includes('/chat/completions')));
});

test('open web discovery samples every planned query instead of filling all slots from the first query', async () => {
  const searchedQueries = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const query = parsed.searchParams.get('q') || parsed.searchParams.get('wd') || '';
    if (parsed.hostname === 'insurance.example.test') {
      return new Response('<html><body>城市惠民医疗险保障正文</body></html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      });
    }
    searchedQueries.push(query);
    const detail = query.includes('理赔须知');
    const suffix = detail ? 'notice' : 'coverage';
    return new Response(`
      <html><body><div class="result">
        <a class="result__a" href="https://insurance.example.test/${suffix}">城市惠民医疗险${detail ? '理赔须知' : '保障方案'}</a>
        <a class="result__snippet">城市惠民医疗险${detail ? '断保规则' : '责任明细'}。</a>
      </div></body></html>
    `, { status: 200, headers: { 'content-type': 'text/html' } });
  };

  const result = await crawlOpenWebProductReferenceRecords({
    policy: { company: '测试联合承保公司', name: '城市惠民医疗险' },
    fetchImpl,
    searchPlan: {
      queries: ['城市惠民医疗险 保障方案', '城市惠民医疗险 理赔须知'],
      preferredDomains: [],
    },
    maxResults: 2,
  });

  assert.deepEqual(result.records.map((record) => record.url).sort(), [
    'https://insurance.example.test/coverage',
    'https://insurance.example.test/notice',
  ]);
  assert.ok(searchedQueries.some((query) => query.includes('保障方案')));
  assert.ok(searchedQueries.some((query) => query.includes('理赔须知')));
});

test('open web product discovery can infer an insurer when the user only supplied a product name', async () => {
  const fakeSearchHtml = `
    <html><body>
      <div class="result">
        <a class="result__a" href="https://public.example.test/product">城市补充医疗保障计划</a>
        <a class="result__snippet">该计划由示例人寿保险股份有限公司牵头承保。</a>
      </div>
    </body></html>
  `;
  const fetchImpl = async () => new Response(fakeSearchHtml, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
  const result = await crawlOpenWebProductReferenceRecords({
    policy: { company: '', name: '城市补充医疗保障计划' },
    fetchImpl,
    searchPlan: {
      queries: ['城市补充医疗保障计划 承保公司'],
      preferredDomains: ['public.example.test'],
    },
    officialDomainProfiles: [{
      company: '示例人寿保险股份有限公司',
      aliases: ['示例人寿', '示例人寿保险股份有限公司'],
      companyAliases: ['示例人寿保险股份有限公司'],
      officialDomains: ['insurer.example.test'],
      siteDomains: ['insurer.example.test'],
    }],
    maxResults: 5,
  });

  assert.equal(result.status, 'candidates');
  assert.equal(result.records[0].company, '示例人寿保险股份有限公司');
  assert.equal(result.records[0].productName, '城市补充医疗保障计划');
  assert.equal(result.records[0].sourceKind, 'open_web_reference');
});

test('official sales-status lookup accepts only explicit status on an insurer domain', async () => {
  const searchHtml = `
    <html><body>
      <div class="result">
        <a class="result__a" href="https://official.test/products/current-a">国寿百万医疗保险（A款）</a>
        <a class="result__snippet">中国人寿官方产品页</a>
      </div>
    </body></html>
  `;
  const fetchImpl = async (url) => {
    if (String(url) === 'https://official.test/products/current-a') {
      return new Response('<html><body>产品名称：国寿百万医疗保险（A款） 销售状态：在售</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response(searchHtml, { status: 200, headers: { 'content-type': 'text/html' } });
  };

  const result = await searchOfficialProductSalesStatuses({
    company: '中国人寿',
    productNames: ['国寿百万医疗保险（A款）'],
    officialDomainProfiles: [{
      company: '中国人寿',
      aliases: ['中国人寿', '国寿'],
      siteDomains: ['official.test'],
      officialDomains: ['official.test'],
    }],
    fetchImpl,
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].status, '在售');
  assert.equal(result[0].productName, '国寿百万医疗保险（A款）');
  assert.equal(result[0].source.url, 'https://official.test/products/current-a');
});

test('official sales-status lookup discovers unknown medical products before exact verification', async () => {
  const broadSearchHtml = `
    <html><body><li class="res-list"><h3 class="res-title">
      <a href="https://www.so.com/link?m=test" data-mdurl="https://media.test/china-life-new">中国人寿推出健康保险新品</a>
    </h3><span class="res-list-summary">“康悦”系列再添新翼——国寿康悦臻享医疗保险（费率可调）成功上市</span></li></body></html>
  `;
  const exactSearchHtml = `
    <html><body><div class="result">
      <a class="result__a" href="https://official.test/products/kangyue">国寿康悦臻享医疗保险（费率可调）</a>
      <a class="result__snippet">中国人寿官方产品页</a>
    </div></body></html>
  `;
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value === 'https://official.test/products/kangyue') {
      return new Response('<html><body>国寿康悦臻享医疗保险（费率可调） 当前销售状态：在售</body></html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      });
    }
    const query = new URL(value).searchParams.get('q') || new URL(value).searchParams.get('wd') || '';
    return new Response(query.includes('康悦臻享') ? exactSearchHtml : broadSearchHtml, {
      status: 200, headers: { 'content-type': 'text/html' },
    });
  };

  const result = await searchOfficialProductSalesStatuses({
    company: '中国人寿',
    productNames: ['国寿如E康悦百万医疗保险（A款）'],
    discoveryQuery: '百万医疗',
    officialDomainProfiles: [{
      company: '中国人寿', aliases: ['中国人寿', '国寿'],
      siteDomains: ['official.test'], officialDomains: ['official.test'],
    }],
    fetchImpl,
  });

  const discovered = result.find((item) => item.productName === '国寿康悦臻享医疗保险（费率可调）');
  assert.equal(discovered.status, '在售');
  assert.equal(discovered.evidenceLevel, 'insurer_official');
  assert.equal(discovered.source.url, 'https://official.test/products/kangyue');
});

test('knowledge search keeps exact product version before similar New China variants', () => {
  const productName = '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）';
  const artifacts = buildKnowledgeSearchArtifacts({
    policy: { company: '新华保险', name: `${productName}保险` },
    officialDomainProfiles: [
      {
        company: '新华保险',
        aliases: ['新华保险', '新华人寿'],
        siteDomains: ['static-cdn.newchinalife.com'],
        officialDomains: ['static-cdn.newchinalife.com'],
      },
    ],
    records: [
      {
        company: '新华保险',
        productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）',
        title: '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）',
        url: 'https://static-cdn.newchinalife.com/ncl/pdf/ying.pdf',
        pageText: '保险责任 智赢版责任文本。',
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
        updatedAt: '2026-05-31T00:00:00.000Z',
      },
      {
        company: '新华保险',
        productName,
        title: productName,
        url: 'https://static-cdn.newchinalife.com/ncl/pdf/xiang.pdf',
        pageText: '保险责任 智享版责任文本。',
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
    ],
  });

  assert.equal(artifacts.records.length, 1);
  assert.equal(artifacts.records[0].productName, productName);
  assert.equal(artifacts.sources[0].url, 'https://static-cdn.newchinalife.com/ncl/pdf/xiang.pdf');
  assert.match(artifacts.context, /智享版责任文本/u);
  assert.doesNotMatch(artifacts.context, /智赢版责任文本/u);
});

test('responsibility assistant returns local responsibility text as one raw row without model call', async () => {
  let modelCalled = false;
  const responsibilityText =
    '保险责任 在本合同保险期间内，本公司承担下列保险责任：1.生存保险金 被保险人生存至约定日期，本公司按基本保险金额给付生存保险金。2.身故保险金 被保险人身故，本公司按合同约定给付身故保险金。';
  const result = await queryPolicyResponsibilities({
    scan: {
      ocrText: '新华保险 尊尚人生两全保险',
      data: {
        company: '新华保险',
        name: '尊尚人生两全保险',
      },
    },
    preferLocalKnowledgeAnswer: true,
    officialDomainProfiles: [
      {
        company: '新华保险',
        aliases: ['新华保险', '新华人寿'],
        siteDomains: ['static-cdn.newchinalife.com'],
        officialDomains: ['static-cdn.newchinalife.com'],
      },
    ],
    knowledgeRecords: [
      {
        company: '新华保险',
        productName: '尊尚人生两全保险',
        title: '尊尚人生两全保险条款',
        url: 'https://static-cdn.newchinalife.com/ncl/pdf/zunshang.pdf',
        pageText: responsibilityText,
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
      },
    ],
    query: async () => {
      modelCalled = true;
      return { coverageTable: [] };
    },
  });

  assert.equal(modelCalled, false);
  assert.equal(result.coverageTable.length, 1);
  assert.equal(result.coverageTable[0].coverageType, '保险责任');
  assert.match(result.coverageTable[0].scenario, /保险责任\n\n在本合同保险期间内/u);
  assert.match(result.coverageTable[0].scenario, /1\. 生存保险金\n被保险人生存至约定日期/u);
  assert.match(result.coverageTable[0].scenario, /2\. 身故保险金\n被保险人身故/u);
  assert.equal(result.coverageTable[0].payout, '');
  assert.equal(result.coverageTable[0].sourceUrl, 'https://static-cdn.newchinalife.com/ncl/pdf/zunshang.pdf');
  assert.equal(result.coverageTable[0].sourceTitle, '尊尚人生两全保险条款');
  assert.equal(result.officialResponsibilityText, responsibilityText);
  assert.equal(result.sources[0].url, 'https://static-cdn.newchinalife.com/ncl/pdf/zunshang.pdf');
  assert.equal(result.rawAnalysis.generatedBy, 'local_knowledge_fast_path');
});

test('responsibility query does not fast-path unrelated local knowledge', async () => {
  const calls = [];
  const result = await queryPolicyResponsibilities({
    scan: {
      ocrText: '测试保险 安心一号 身故保险金',
      data: {
        company: '测试保险',
        name: '安心一号',
      },
    },
    preferLocalKnowledgeAnswer: true,
    knowledgeRecords: [
      {
        company: '泄漏保险',
        productName: '泄漏产品',
        title: '泄漏产品条款',
        url: 'https://leak.example.test/leak.pdf',
        pageText: '泄漏产品保险责任正文。',
        official: true,
        sourceType: 'pdf',
        materialType: 'terms',
      },
    ],
    query: async (input) => {
      calls.push(input);
      return {
        coverageTable: [
          {
            coverageType: '身故保险金',
            scenario: '被保险人身故',
            payout: '按合同约定给付',
          },
        ],
        sources: [],
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].knowledgeRecords, []);
  assert.notEqual(result.rawAnalysis.generatedBy, 'local_knowledge_fast_path');
  assert.equal(result.coverageTable[0].coverageType, '身故保险金');
  assert.equal(result.sources.some((source) => source.url === 'https://leak.example.test/leak.pdf'), false);
});

test('multi-plan responsibility query tags local knowledge sources with each plan product', async () => {
  let modelCalled = false;
  const mainProductName = '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）';
  const linkedProductName = '新华人寿保险股份有限公司鑫天利卓越版养老年金保险（万能型）';
  const result = await queryPolicyAndPlanResponsibilities({
    scan: {
      ocrText: '新华保险 盛世恒盈年金保险 鑫天利卓越版养老年金保险',
      data: {
        company: '新华保险',
        name: mainProductName,
        plans: [
          {
            role: 'main',
            name: '盛世恒盈年金保险（分红型）',
            matchedProductName: mainProductName,
          },
          {
            role: 'linked_account',
            name: '鑫天利卓越版养老年金保险（万能型）',
            matchedProductName: linkedProductName,
          },
        ],
      },
    },
    preferLocalKnowledgeAnswer: true,
    knowledgeRecords: [
      {
        company: '新华保险',
        productName: mainProductName,
        title: `${mainProductName}条款`,
        url: 'https://static-cdn.newchinalife.com/ncl/pdf/main.pdf',
        pageText: '保险责任 在本合同保险期间内，我们承担生存保险金责任。',
        official: true,
        sourceType: 'pdf',
      },
      {
        company: '新华保险',
        productName: linkedProductName,
        title: `${linkedProductName}条款`,
        url: 'https://static-cdn.newchinalife.com/ncl/pdf/linked.pdf',
        pageText: '保险责任 在本合同保险期间内，我们承担养老年金和身故保险金责任。',
        official: true,
        sourceType: 'pdf',
      },
    ],
    query: async () => {
      modelCalled = true;
      return { coverageTable: [] };
    },
  });

  assert.equal(modelCalled, false);
  assert.equal(result.coverageTable.length, 2);
  assert.deepEqual(
    result.sources.map((source) => source.productName),
    [mainProductName, linkedProductName],
  );
});

test('local knowledge responsibility analysis falls back to a single row for unsegmented text', () => {
  const result = buildLocalKnowledgeResponsibilityAnalysis([
    {
      productName: '测试产品',
      title: '测试产品条款',
      url: 'https://official.example.test/policy.pdf',
      pageText: '保险责任 在本合同保险期间内，本公司按照合同约定承担保险责任并给付保险金。',
      official: true,
    },
  ]);

  assert.equal(result.coverageTable.length, 1);
  assert.equal(result.coverageTable[0].coverageType, '保险责任');
  assert.equal(result.coverageTable[0].scenario, '保险责任\n\n在本合同保险期间内，本公司按照合同约定承担保险责任并给付保险金。');
  assert.equal(result.coverageTable[0].payout, '');
  assert.equal(result.coverageTable[0].sourceUrl, 'https://official.example.test/policy.pdf');
  assert.equal(result.coverageTable[0].sourceTitle, '测试产品条款');
  assert.equal(result.officialResponsibilityText, '保险责任 在本合同保险期间内，本公司按照合同约定承担保险责任并给付保险金。');
});
