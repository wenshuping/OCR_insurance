import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeInsurancePolicyResponsibilities,
  mergeResponsibilityConditionBranches,
  mergeResponsibilityAnalysisWorkerRows,
  responsibilityAnalysisWorkerPlan,
  validateResponsibilityPreviewRows,
} from '../server/c-policy-analysis.service.mjs';

function withPolicyAnalysisEnv(fn, { smartSearchEnabled = false } = {}) {
  const previous = {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
    DEEPSEEK_FALLBACK_MODEL: process.env.DEEPSEEK_FALLBACK_MODEL,
    POLICY_ANALYSIS_SMART_SEARCH_ENABLED: process.env.POLICY_ANALYSIS_SMART_SEARCH_ENABLED,
  };
  process.env.DEEPSEEK_API_KEY = 'test-key';
  process.env.DEEPSEEK_BASE_URL = 'https://deepseek.test';
  process.env.DEEPSEEK_MODEL = 'deepseek-chat';
  process.env.DEEPSEEK_FALLBACK_MODEL = '';
  process.env.POLICY_ANALYSIS_SMART_SEARCH_ENABLED = smartSearchEnabled ? 'true' : 'false';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

function textResponse(body, { contentType = 'text/html; charset=utf-8' } = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return {
    ok: true,
    headers: {
      get(name) {
        const key = String(name || '').toLowerCase();
        if (key === 'content-type') return contentType;
        if (key === 'content-length') return String(buffer.length);
        return '';
      },
    },
    text: async () => buffer.toString('utf8'),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

function emptyHtmlResponse() {
  return textResponse('<html><body></body></html>');
}

function utf16beHex(text) {
  const bytes = [0xfe, 0xff];
  for (const char of String(text || '')) {
    const code = char.charCodeAt(0);
    bytes.push((code >> 8) & 0xff, code & 0xff);
  }
  return Buffer.from(bytes).toString('hex').toUpperCase();
}

function actualTextPdfResponse(text) {
  return textResponse(Buffer.from(`/ActualText <${utf16beHex(text)}>`, 'latin1'), {
    contentType: 'application/pdf',
  });
}

function createChatResponse(content) {
  return {
    ok: true,
    json: async () => ({
      model: 'deepseek-chat',
      choices: [
        {
          message: {
            content: typeof content === 'string' ? content : JSON.stringify(content),
          },
        },
      ],
    }),
  };
}

function requestPrompt(options = {}) {
  return JSON.parse(options.body).messages.map((message) => message.content).join('\n');
}

function isSkillRouterPrompt(prompt = '') {
  return /policy_analysis_skill_router/u.test(prompt);
}

function isResponsibilityPrompt(prompt = '') {
  return /请只输出保险责任 coverageTable/u.test(prompt);
}

test('fresh PDF analysis treats local responsibilities and indicators as a recall reference', async () => {
  await withPolicyAnalysisEnv(async () => {
    const prompts = [];
    const fetchImpl = async (_url, options = {}) => {
      const prompt = requestPrompt(options);
      prompts.push(prompt);
      return createChatResponse({
        coverageTable: [{
          coverageType: '养老年金',
          scenario: '达到合同约定领取日',
          payout: '基本保险金额×月领折算系数',
          formulaText: '基本保险金额×月领折算系数',
          requiredInputs: ['monthlyConversionFactor'],
          sourceExcerpt: '每月领取金额为基本保险金额乘以月领折算系数。',
        }],
      });
    };

    await analyzeInsurancePolicyResponsibilities({
      policy: {
        company: '测试人寿',
        name: '测试养老年金保险',
        responsibilities: [{
          coverageType: '养老年金',
          scenario: '旧领取条件',
          payout: '旧给付规则',
          formulaText: '基本保险金额×月领折算系数',
          requiredInputs: ['monthlyConversionFactor'],
        }],
      },
      knowledgeRecords: [{
        company: '测试人寿',
        productName: '测试养老年金保险',
        title: '测试养老年金保险条款',
        url: 'https://official.test/annuity.pdf',
        pageText: '每月领取金额为基本保险金额乘以月领折算系数。',
        official: true,
        sourceType: 'pdf',
      }],
      fetchImpl,
    });

    const primaryPrompt = prompts.find((prompt) => isResponsibilityPrompt(prompt));
    assert.match(primaryPrompt, /本地库已有责任与指标/u);
    assert.match(primaryPrompt, /养老年金/u);
    assert.match(primaryPrompt, /基本保险金额×月领折算系数/u);
    assert.match(primaryPrompt, /只能作为召回参考/u);
    assert.match(primaryPrompt, /产品资料（后端搜索获得）/u);
  });
});

test('responsibility worker plan uses configurable counts by insurance category', () => {
  const emptyEnv = {};
  assert.deepEqual(
    responsibilityAnalysisWorkerPlan({ policy: { name: '安心定期寿险' }, env: emptyEnv }),
    {
      productCategory: 'term_life',
      categoryLabel: '定期寿险',
      featureTags: [],
      modelTier: 'flash',
      workerCount: 2,
      detailRoles: ['calculation'],
    },
  );

  for (const name of ['少儿重大疾病保险', '附加住院医疗保险', '综合意外伤害保险', '长期护理保险']) {
    const plan = responsibilityAnalysisWorkerPlan({ policy: { name }, env: emptyEnv });
    assert.equal(plan.workerCount, 4, name);
    assert.deepEqual(plan.detailRoles, ['facts', 'calculation', 'topology'], name);
  }

  const medical = responsibilityAnalysisWorkerPlan({
    policy: { name: '附加住院医疗保险' },
    env: {
      POLICY_ANALYSIS_WORKERS_COMPLEX: '2',
      POLICY_ANALYSIS_WORKERS_MEDICAL: '3',
    },
  });
  assert.equal(medical.workerCount, 3);
  assert.deepEqual(medical.detailRoles, ['facts', 'calculation']);

  const simple = responsibilityAnalysisWorkerPlan({
    policy: { name: '安心定期寿险' },
    env: { POLICY_ANALYSIS_WORKERS_SIMPLE: '1' },
  });
  assert.equal(simple.workerCount, 1);
  assert.deepEqual(simple.detailRoles, []);

  assert.equal(responsibilityAnalysisWorkerPlan({
    policy: { name: '少儿重大疾病保险' },
    env: { POLICY_ANALYSIS_WORKERS_CRITICAL_ILLNESS: '99' },
  }).workerCount, 4);
});

test('responsibility worker merge enriches locked titles and ignores invented responsibilities', () => {
  const merged = mergeResponsibilityAnalysisWorkerRows([
    { coverageType: '重大疾病保险金', payout: '按合同约定给付' },
  ], [{
    role: 'calculation',
    rows: [{
      coverageType: '重大疾病保险金',
      formulaText: '基本保险金额×100%',
      requiredInputs: ['basic_sum_insured'],
    }, {
      coverageType: '等待期',
      formulaText: '不承担责任',
    }],
  }, {
    role: 'facts',
    rows: [{
      coverageType: '重大疾病保险金',
      triggerCondition: '初次确诊合同约定的重大疾病',
    }],
  }]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].coverageType, '重大疾病保险金');
  assert.equal(merged[0].formulaText, '基本保险金额×100%');
  assert.deepEqual(merged[0].requiredInputs, ['basic_sum_insured']);
  assert.equal(merged[0].triggerCondition, '初次确诊合同约定的重大疾病');
});

test('responsibility worker merge keeps duplicate-title condition rows aligned by source order', () => {
  const merged = mergeResponsibilityAnalysisWorkerRows([
    { coverageType: '身故保险金', scenario: '等待期内' },
    { coverageType: '身故保险金', scenario: '等待期后' },
  ], [{
    role: 'calculation',
    rows: [
      { coverageType: '身故保险金', payout: '给付实际交纳的保险费' },
      { coverageType: '身故保险金', payout: '给付年度有效保额' },
    ],
  }]);

  assert.equal(merged[0].payout, '给付实际交纳的保险费');
  assert.equal(merged[1].payout, '给付年度有效保额');
});

test('same responsibility conditions merge into one customer row instead of duplicate cards', () => {
  const merged = mergeResponsibilityConditionBranches([
    {
      coverageType: '身故保险金',
      scenario: '90日内非意外身故',
      payout: '给付实际交纳的保险费',
      note: '合同终止',
      formulaText: '实际交纳的保险费',
      requiredInputs: ['totalPaidPremium'],
    },
    {
      coverageType: '身故保险金',
      scenario: '意外身故或90日后非意外身故',
      payout: '给付身故时的年度有效保额',
      note: '合同终止',
      formulaText: '基本保险金额÷10000×年度有效保额基数',
      requiredInputs: ['basicAmount', 'policyScheduleTable'],
    },
    {
      coverageType: '身体全残保险金',
      scenario: '达到条款约定的身体全残状态',
      payout: '按条款约定给付',
      note: '合同终止',
    },
  ]);

  assert.equal(merged.length, 2);
  assert.match(merged[0].scenario, /情形1：90日内非意外身故/u);
  assert.match(merged[0].scenario, /情形2：意外身故或90日后非意外身故/u);
  assert.deepEqual(merged[0].requiredInputs, ['totalPaidPremium', 'basicAmount', 'policyScheduleTable']);
  assert.equal(validateResponsibilityPreviewRows(merged).ok, true);
});

test('DeepSeek v4 runtime uses one primary plus configured specialist workers', async () => {
  await withPolicyAnalysisEnv(async () => {
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-flash';
    const run = async ({ productName, responsibilityTitle, expectedWorkerCount }) => {
      const prompts = [];
      const fetchImpl = async (_url, options = {}) => {
        const prompt = requestPrompt(options);
        prompts.push(prompt);
        if (isSkillRouterPrompt(prompt)) {
          return createChatResponse({
            documentType: 'responsibility_page',
            skills: ['responsibility_extraction', 'indicator_quantification'],
            confidence: 0.99,
          });
        }
        if (/专项复核worker/u.test(prompt)) {
          return createChatResponse({
            coverageTable: [{
              coverageType: responsibilityTitle,
              triggerCondition: `达到${responsibilityTitle}约定条件`,
              formulaText: '基本保险金额×100%',
              requiredInputs: ['basic_sum_insured'],
              responsibilityScope: 'base',
            }],
          });
        }
        return createChatResponse({
          coverageTable: [{
            coverageType: responsibilityTitle,
            scenario: `发生${responsibilityTitle}保险事故`,
            payout: '按合同约定给付',
            sourceExcerpt: `${responsibilityTitle}按合同约定给付。`,
          }],
        });
      };

      const result = await analyzeInsurancePolicyResponsibilities({
        policy: { company: '中国平安保险', name: productName },
        knowledgeRecords: [{
          company: '中国平安保险',
          productName,
          title: `${productName}条款`,
          url: 'https://life.pingan.com/products/worker-test-terms.pdf',
          pageText: `保险责任 ${responsibilityTitle} 按合同约定给付。`,
          official: true,
          sourceType: 'pdf',
        }],
        fetchImpl,
      });

      assert.equal(result.modelOutput.workerPlan.workerCount, expectedWorkerCount);
      assert.equal(result.modelOutput.workers.length, expectedWorkerCount - 1);
      assert.ok(result.modelOutput.workers.every((worker) => worker.status === 'passed'));
      assert.equal(prompts.length, expectedWorkerCount + 1);
      assert.equal(result.coverageTable.length, 1);
      return result;
    };

    const simple = await run({
      productName: '平安安心定期寿险',
      responsibilityTitle: '身故或全残保险金',
      expectedWorkerCount: 2,
    });
    assert.equal(simple.coverageTable[0].formulaText, '基本保险金额×100%');

    const complex = await run({
      productName: '平安少儿重大疾病保险',
      responsibilityTitle: '重大疾病保险金',
      expectedWorkerCount: 4,
    });
    assert.equal(complex.coverageTable[0].triggerCondition, '达到重大疾病保险金约定条件');
  });
});

test('an empty specialist response does not discard the primary responsibility result', async () => {
  await withPolicyAnalysisEnv(async () => {
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-flash';
    const fetchImpl = async (_url, options = {}) => {
      const prompt = requestPrompt(options);
      if (isSkillRouterPrompt(prompt)) {
        return createChatResponse({
          documentType: 'responsibility_page',
          skills: ['responsibility_extraction', 'indicator_quantification'],
          confidence: 0.99,
        });
      }
      if (/专项复核worker/u.test(prompt)) return createChatResponse('');
      return createChatResponse({
        coverageTable: [{
          coverageType: '身故保险金',
          scenario: '被保险人身故',
          payout: '按合同约定给付',
          sourceExcerpt: '身故保险金按合同约定给付。',
        }],
      });
    };

    const result = await analyzeInsurancePolicyResponsibilities({
      policy: { company: '中国平安保险', name: '平安安心定期寿险' },
      knowledgeRecords: [{
        company: '中国平安保险',
        productName: '平安安心定期寿险',
        title: '平安安心定期寿险条款',
        url: 'https://life.pingan.com/products/worker-empty-terms.pdf',
        pageText: '保险责任 身故保险金 按合同约定给付。',
        official: true,
        sourceType: 'pdf',
      }],
      fetchImpl,
    });

    assert.equal(result.coverageTable.length, 1);
    assert.equal(result.coverageTable[0].coverageType, '身故保险金');
    assert.equal(result.modelOutput.workers[0].status, 'failed');
    assert.equal(result.modelOutput.workers[0].errorCode, 'POLICY_ANALYSIS_EMPTY');
  });
});

test('responsibility validation returns failure reasons to the model for at most five attempts', async () => {
  await withPolicyAnalysisEnv(async () => {
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-flash';
    let repairCalls = 0;
    const fetchImpl = async (_url, options = {}) => {
      const prompt = requestPrompt(options);
      if (isSkillRouterPrompt(prompt)) {
        return createChatResponse({
          documentType: 'responsibility_page',
          skills: ['responsibility_extraction', 'indicator_quantification'],
          confidence: 0.99,
        });
      }
      if (/保险责任校验修复worker/u.test(prompt)) {
        repairCalls += 1;
        assert.match(prompt, /NON_RESPONSIBILITY_TITLE/u);
        return createChatResponse({
          coverageTable: [{
            coverageType: repairCalls === 4 ? '身故保险金' : '等待期',
            scenario: '被保险人身故',
            payout: '按合同约定给付',
            note: '具体以合同为准',
          }],
        });
      }
      if (/专项复核worker/u.test(prompt)) {
        return createChatResponse({ coverageTable: [] });
      }
      return createChatResponse({
        coverageTable: [{
          coverageType: '等待期',
          scenario: '合同生效后等待90日',
          payout: '等待期内不承担保险责任',
          note: '等待期不是保险责任',
        }],
      });
    };

    const result = await analyzeInsurancePolicyResponsibilities({
      policy: { company: '中国平安保险', name: '平安安心定期寿险' },
      knowledgeRecords: [{
        company: '中国平安保险',
        productName: '平安安心定期寿险',
        title: '平安安心定期寿险条款',
        url: 'https://life.pingan.com/products/validation-repair-terms.pdf',
        pageText: '保险责任 身故保险金 被保险人身故，按合同约定给付。等待期为90日。',
        official: true,
        sourceType: 'pdf',
      }],
      fetchImpl,
    });

    assert.equal(repairCalls, 4);
    assert.equal(result.modelOutput.responsibilityValidation.status, 'passed');
    assert.equal(result.modelOutput.responsibilityValidation.maxAttempts, 5);
    assert.equal(result.modelOutput.responsibilityValidation.attempts.length, 5);
    assert.equal(result.modelOutput.responsibilityValidation.repairWorkers.length, 4);
    assert.equal(result.coverageTable[0].coverageType, '身故保险金');
  });
});

test('policy analysis searches the current New China disclosure page when the old entry misses the product', async () => {
  await withPolicyAnalysisEnv(
    async () => {
      const calls = [];
      let deepSeekPrompt = '';
      const productName = '盛世荣耀庆典版终身寿险（分红型）';
      const fetchImpl = async (url, options = {}) => {
        const href = String(url);
        calls.push(href);
        if (href.startsWith('https://deepseek.test/')) {
          deepSeekPrompt = JSON.parse(options.body).messages.map((message) => message.content).join('\n');
          return createChatResponse({
            coverageTable: [
              {
                coverageType: '身故或身体全残保险金',
                scenario: '被保险人身故或身体全残',
                payout: '按合同约定给付',
                note: '给付后合同终止。',
              },
            ],
          });
        }
        if (href.includes('/info/4596')) {
          return textResponse(`
            <table><tr><td>其他产品</td><td><a href="/node/670">产品说明书</a></td></tr></table>
          `);
        }
        if (href.includes('/info/3279_23')) {
          return textResponse(`
            <table>
              <tr>
                <td>${productName}</td>
                <td><a href="/node/670?doc=ssryqd">产品说明书</a></td>
              </tr>
            </table>
          `);
        }
        if (href.includes('/node/670')) {
          return textResponse(`
            <a href="https://static-cdn.newchinalife.com/ncl/pdf/20251110/product.pdf">
              ${productName}产品说明书
            </a>
          `);
        }
        if (href.includes('static-cdn.newchinalife.com/ncl/pdf/20251110/product.pdf')) {
          return actualTextPdfResponse('保险责任 身故或身体全残保险金 按合同约定给付 责任免除');
        }
        return emptyHtmlResponse();
      };

      const result = await analyzeInsurancePolicyResponsibilities({
        policy: {
          company: '新华保险',
          name: productName,
          amount: 127100,
        },
        ocrText: '保单号码 产品名称 基本保险金额 保险期间 终身',
        fetchImpl,
      });

      assert.ok(calls.some((href) => href.includes('/info/4596')));
      assert.ok(calls.some((href) => href.includes('/info/3279_23')));
      assert.match(deepSeekPrompt, /产品资料（后端搜索获得）/u);
      assert.match(deepSeekPrompt, /身故或身体全残保险金/u);
      assert.equal(result.coverageTable.length, 1);
    },
    { smartSearchEnabled: true },
  );
});

test('policy analysis prompt only asks DeepSeek for the responsibility table', async () => {
  await withPolicyAnalysisEnv(async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return createChatResponse({
        coverageTable: [
          {
            coverageType: '身故保险金',
            scenario: '被保险人身故',
            payout: '按基本保额给付',
            note: '给付后合同终止',
          },
        ],
      });
    };

    await analyzeInsurancePolicyResponsibilities({
      policy: {
        company: '新华保险',
        name: '盛世荣耀臻享版终身寿险（分红型）',
        amount: 300000,
      },
      ocrText: '身故保险金 全残保险金 特定公共交通工具意外额外给付',
      fetchImpl,
    });

    assert.equal(calls.length, 2);
    const routerPrompt = calls[0].body.messages.map((message) => message.content).join('\n');
    const prompt = calls.find((call) => isResponsibilityPrompt(call.body.messages.map((message) => message.content).join('\n')))
      .body.messages.map((message) => message.content).join('\n');
    assert.match(routerPrompt, /policy_analysis_skill_router/u);
    assert.match(prompt, /本次解析技能计划/u);
    assert.match(prompt, /JSON 字段只包含：coverageTable/);
    assert.match(prompt, /不要输出 report、notes、summary、overview、disclaimer/);
    assert.match(prompt, /每一条保险责任.*单独.*coverageTable/);
    assert.match(prompt, /coverageTable 是保险责任表/);
    assert.match(prompt, /指标拆解字段 liability、triggerCondition、formulaText、basis、value、unit/);
    assert.match(prompt, /计算字段统一规则/);
    assert.match(prompt, /calculationEligible=false/);
    assert.match(prompt, /分红、红利领取方式、现金价值.*不要作为 coverageTable 的独立行/);
    assert.doesNotMatch(
      prompt,
      /productOverview|productAdvantages|mainGuarantees|dividendMechanism|dividendOptions|dividendImpact|coreFeature|exclusions|purchaseAdvice/,
    );
  });
});

test('external responsibility analysis keeps product overview, quantitative responsibility details, and general rules', async () => {
  await withPolicyAnalysisEnv(async () => {
    let analysisPrompt = '';
    const fetchImpl = async (_url, options = {}) => {
      const prompt = requestPrompt(options);
      if (isSkillRouterPrompt(prompt)) {
        return createChatResponse({
          documentType: 'product_page',
          skills: ['responsibility_extraction', 'indicator_quantification'],
          confidence: 0.9,
        });
      }
      analysisPrompt = prompt;
      return createChatResponse({
        productOverview: {
          productType: '城市定制型商业补充医疗保险',
          purpose: '补充基本医保后的个人医疗费用负担。',
          positioning: '基本医保之上的补充保障。',
          planOptions: [
            { name: '基础方案', premium: '150元/年', totalCoverage: '320万元', relationship: '包含4项基础责任', sourceExcerpt: '资料1：基础方案。' },
            { name: '升级方案', premium: '300元/年', totalCoverage: '470万元', relationship: '包含基础方案责任并新增责任', sourceExcerpt: '资料1：升级方案。' },
          ],
          sourceExcerpt: '资料1：本产品为商业补充医疗保险。',
        },
        coverageTable: [{
          coverageType: '院内费用超额补偿',
          scenario: '基础责任报销后剩余的院内个人负担费用。',
          payout: {
            scheme: '升级版',
            deductible: '3万元',
            reimbursementRate: '20%',
            annualLimit: '20万元',
          },
          responsibilityNumber: '5',
          introducedInPlan: '升级方案',
          applicablePlans: ['升级方案'],
          note: '非官方资料待保险公司确认',
          sourceExcerpt: '资料1：超过3万元部分按20%报销，年度限额20万元。',
        }],
        generalRules: [{
          title: '断保影响',
          detail: '中断后重新参保，各档报销比例下降50%。',
          sourceExcerpt: '资料2：各档报销比例下降50%。',
        }],
        exclusions: [{ title: '非治疗性项目', detail: '美容、体检不予赔付。', sourceExcerpt: '资料2：美容、体检不予赔付。' }],
        valueAddedServices: [{ title: '就医服务', detail: '提供陪诊服务。', sourceExcerpt: '资料2：提供陪诊服务。' }],
      });
    };

    const result = await analyzeInsurancePolicyResponsibilities({
      policy: { company: '测试联合承保公司', name: '城市惠民医疗险' },
      knowledgeRecords: [
        {
          company: '测试联合承保公司', productName: '城市惠民医疗险',
          title: '完整保障方案', url: 'https://reference.test/coverage',
          pageText: '本产品为商业补充医疗保险。超过3万元部分按20%报销，年度限额20万元。',
          official: false, referenceOnly: true, sourceKind: 'open_web_reference', evidenceLevel: 'external_legacy_reference',
        },
        {
          company: '测试联合承保公司', productName: '城市惠民医疗险',
          title: '投保须知', url: 'https://reference.test/notice',
          pageText: '中断后重新参保，各档报销比例下降50%。',
          official: false, referenceOnly: true, sourceKind: 'open_web_reference', evidenceLevel: 'external_legacy_reference',
        },
      ],
      allowExternalReferences: true,
      fetchImpl,
    });

    assert.match(analysisPrompt, /JSON 字段只包含 productOverview、coverageTable、generalRules、exclusions、valueAddedServices/u);
    assert.match(analysisPrompt, /起付线、免赔额、报销\/给付比例、年度限额/u);
    assert.match(analysisPrompt, /既往症、断保续保、就诊范围/u);
    assert.match(analysisPrompt, /每个 coverageTable 行只能包含 coverageType、scenario、payout、note、responsibilityNumber、introducedInPlan、applicablePlans、sourceExcerpt/u);
    assert.match(analysisPrompt, /relationship 只描述方案之间的包含或新增关系/u);
    assert.match(analysisPrompt, /scenario 不超过80个汉字，payout 不超过260个汉字，sourceExcerpt 不超过60个汉字/u);
    assert.match(analysisPrompt, /用户未指定产品年度或条款版本，不得把当前年份当成产品版本/u);
    assert.match(analysisPrompt, /互斥的保险期间、责任名称或给付规则/u);
    assert.equal(result.productOverview.productType, '城市定制型商业补充医疗保险');
    assert.equal(result.productOverview.planOptions.length, 2);
    assert.equal(result.coverageTable[0].introducedInPlan, '升级方案');
    assert.deepEqual(result.coverageTable[0].applicablePlans, ['升级方案']);
    assert.match(result.coverageTable[0].payout, /适用方案：升级版.*起付线\/免赔额：3万元.*报销比例：20%.*年度限额：20万元/u);
    assert.doesNotMatch(result.coverageTable[0].payout, /\[object Object\]/u);
    assert.equal(result.generalRules[0].title, '断保影响');
    assert.equal(result.exclusions[0].title, '非治疗性项目');
    assert.equal(result.valueAddedServices[0].title, '就医服务');
  });
});

test('policy analysis uses DeepSeek skill router to compile the next responsibility prompt', async () => {
  await withPolicyAnalysisEnv(async () => {
    const prompts = [];
    const fetchImpl = async (url, options = {}) => {
      const prompt = requestPrompt(options);
      prompts.push(prompt);
      if (isSkillRouterPrompt(prompt)) {
        return createChatResponse({
          documentType: 'responsibility_page',
          skills: [
            'responsibility_extraction',
            'indicator_quantification',
            'uploaded_ocr_fallback',
          ],
          promptDirectives: ['优先基于上传OCR逐条拆分保险责任，并为每条责任写 sourceExcerpt'],
          reason: 'OCR包含保险责任和给付比例',
        });
      }
      return createChatResponse({
        coverageTable: [
          {
            coverageType: '重大疾病保险金',
            scenario: '被保险人确诊合同约定重大疾病',
            payout: '按基本保险金额给付',
            formulaText: '重大疾病保险金 = 基本保险金额',
            basis: '基本保险金额',
            sourceExcerpt: '重大疾病保险金按基本保险金额给付。',
            note: '给付后该项责任终止。',
          },
        ],
      });
    };

    const result = await analyzeInsurancePolicyResponsibilities({
      policy: {
        company: '华夏人寿',
        name: '常青树重大疾病保险',
        amount: 500000,
      },
      ocrText: '保险责任 重大疾病保险金 按基本保险金额给付 轻症疾病保险金 按基本保险金额的30%给付',
      fetchImpl,
    });

    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /policy_analysis_skill_router/u);
    assert.match(prompts[1], /uploaded_ocr_fallback/u);
    assert.match(prompts[1], /indicator_quantification/u);
    assert.match(prompts[1], /critical_illness_domain/u);
    assert.match(prompts[1], /优先基于上传OCR逐条拆分保险责任/u);
    assert.equal(result.modelOutput.skillPlan.selectedBy, 'deepseek');
    assert.deepEqual(result.modelOutput.skillPlan.skills, [
      'responsibility_extraction',
      'indicator_quantification',
      'uploaded_ocr_fallback',
      'critical_illness_domain',
    ]);
    assert.equal(result.coverageTable[0].coverageType, '重大疾病保险金');
  });
});

test('policy analysis always adds the deterministic product domain skill', async () => {
  await withPolicyAnalysisEnv(async () => {
    const prompts = [];
    const fetchImpl = async (_url, options = {}) => {
      const prompt = requestPrompt(options);
      prompts.push(prompt);
      if (isSkillRouterPrompt(prompt)) {
        return createChatResponse({
          documentType: 'responsibility_page',
          skills: [
            'responsibility_extraction',
            'indicator_quantification',
            'official_rag_grounding',
          ],
          promptDirectives: [],
          reason: '官方责任条款可用',
        });
      }
      return createChatResponse({
        coverageTable: [{
          coverageType: '身故保险金',
          scenario: '被保险人身故',
          payout: '按账户价值与基本保险金额的较大者给付',
          formulaText: '身故保险金 = max(账户价值, 基本保险金额)',
          basis: '账户价值、基本保险金额',
          requiredInputs: ['accountValue', 'basicSumInsured'],
          sourceExcerpt: '身故保险金为账户价值与基本保险金额的较大者。',
        }],
      });
    };

    const result = await analyzeInsurancePolicyResponsibilities({
      policy: {
        company: '中国平安',
        name: '平安招财宝终身寿险（万能型）',
      },
      knowledgeRecords: [{
        company: '中国平安',
        productName: '平安招财宝终身寿险（万能型）',
        title: '平安招财宝终身寿险（万能型）条款',
        url: 'https://life.pingan.com/test.pdf',
        pageText: '最低保证利率为年利率1.75%。结算利率按月公布。趸交保险费扣除初始费用后进入保单账户。部分领取后账户价值相应减少。身故保险金为账户价值与基本保险金额的较大者。',
        official: true,
        evidenceLevel: 'insurer_official',
      }],
      fetchImpl,
    });

    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /universal_account_domain/u);
    assert.match(prompts[1], /最低保证利率/u);
    assert.match(prompts[1], /初始费用/u);
    assert.match(prompts[1], /部分领取/u);
    assert.equal(result.modelOutput.skillPlan.selectedBy, 'deepseek');
    assert.ok(result.modelOutput.skillPlan.skills.includes('universal_account_domain'));
  });
});

test('policy analysis falls back to uploaded OCR skills when official RAG is missing', async () => {
  await withPolicyAnalysisEnv(
    async () => {
      const prompts = [];
      const fetchImpl = async (url, options = {}) => {
        const href = String(url);
        if (href.startsWith('https://deepseek.test/')) {
          const prompt = requestPrompt(options);
          prompts.push(prompt);
          if (/只查找保险公司官方资料/u.test(prompt)) {
            return createChatResponse({
              companyOfficialDomainHints: [],
              sources: [],
            });
          }
          if (isSkillRouterPrompt(prompt)) {
            return createChatResponse({
              documentType: 'responsibility_page',
              skills: [
                'responsibility_extraction',
                'indicator_quantification',
                'uploaded_ocr_fallback',
              ],
              promptDirectives: ['官方资料未命中时，仍以上传OCR中的责任条款生成指标候选'],
              reason: '责任页OCR可用',
            });
          }
          return createChatResponse({
            coverageTable: [
              {
                coverageType: '轻症疾病保险金',
                scenario: '被保险人确诊合同约定轻症疾病',
                payout: '按基本保险金额的30%给付',
                formulaText: '轻症疾病保险金 = 基本保险金额 × 30%',
                basis: '基本保险金额',
                value: 30,
                unit: '%',
                sourceExcerpt: '轻症疾病保险金按基本保险金额的30%给付。',
                note: '以上传条款页为证据生成，需结合完整合同核对。',
              },
            ],
          });
        }
        return emptyHtmlResponse();
      };

      const result = await analyzeInsurancePolicyResponsibilities({
        policy: {
          company: '华夏人寿',
          name: '常青树重大疾病保险',
          amount: 500000,
        },
        ocrText: '保险责任 轻症疾病保险金 按基本保险金额的30%给付',
        fetchImpl,
      });

      const finalPrompt = prompts.find(isResponsibilityPrompt);
      assert.ok(finalPrompt);
      assert.match(finalPrompt, /uploaded_ocr_fallback/u);
      assert.match(finalPrompt, /官方资料未命中时，仍以上传OCR中的责任条款生成指标候选/u);
      assert.equal(result.coverageTable[0].coverageType, '轻症疾病保险金');
      assert.equal(result.coverageTable[0].value, 30);
    },
    { smartSearchEnabled: true },
  );
});

test('policy analysis accepts coverageTable-only response without report or notes', async () => {
  await withPolicyAnalysisEnv(async () => {
    const fetchImpl = async () =>
      createChatResponse({
        coverageTable: [
          {
            coverageType: '身故或全残保险金',
            liability: '身故或全残保险金',
            scenario: '被保险人身故或全残',
            payout: '按合同约定取较大值给付',
            formulaText: '身故或全残保险金 = 基本保险金额',
            basis: '基本保险金额',
            unit: '公式',
            sourceExcerpt: '被保险人身故或全残，本公司按基本保险金额给付身故或全残保险金。',
            note: '给付后合同终止',
          },
        ],
      });

    const result = await analyzeInsurancePolicyResponsibilities({
      policy: {
        company: '新华保险',
        name: '盛世荣耀臻享版终身寿险（分红型）',
        amount: 300000,
      },
      ocrText: '分红型 红利不保证 身故或全残保险金',
      fetchImpl,
    });

    assert.equal(result.coverageTable.length, 1);
    assert.equal(result.coverageTable[0].formulaText, '身故或全残保险金 = 基本保险金额');
    assert.equal(result.coverageTable[0].basis, '基本保险金额');
    assert.match(result.coverageTable[0].sourceExcerpt, /基本保险金额给付/u);
    assert.equal(result.report, '');
    assert.deepEqual(result.notes, []);
  });
});

test('policy analysis does not send customer names, id numbers, or mobile numbers to DeepSeek', async () => {
  await withPolicyAnalysisEnv(async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return createChatResponse({
        coverageTable: [
          {
            coverageType: '身故保险金',
            scenario: '被保险人身故',
            payout: '按合同约定给付',
            note: '给付后合同终止。',
          },
        ],
      });
    };

    await analyzeInsurancePolicyResponsibilities({
      policy: {
        company: '新华保险',
        name: '测试终身寿险',
        applicant: '张三',
        insured: '李四',
        applicantRelation: '本人',
        insuredRelation: '子女',
        amount: 300000,
      },
      ocrText: [
        '投保人：张三',
        '被保险人：李四',
        '证件号码：110101199001011234',
        '手机号：13800138000',
        '身故保险金 按合同约定给付',
      ].join('\n'),
      fetchImpl,
    });

    assert.equal(calls.length, 2);
    const prompt = calls.map((call) => call.body.messages.map((message) => message.content).join('\n')).join('\n');
    assert.doesNotMatch(prompt, /张三/);
    assert.doesNotMatch(prompt, /李四/);
    assert.doesNotMatch(prompt, /110101199001011234/);
    assert.doesNotMatch(prompt, /13800138000/);
    assert.match(prompt, /\[已脱敏\]|\[身份证号已脱敏\]|\[手机号已脱敏\]/);
  });
});

test('policy analysis removes internal OCR source wording from coverage notes', async () => {
  await withPolicyAnalysisEnv(async () => {
    const fetchImpl = async () =>
      createChatResponse({
        coverageTable: [
          {
            coverageType: '身故或身体全残保险金',
            scenario: '被保险人身故或身体全残',
            payout: '按合同约定给付',
            note: '基于已上传条款页OCR整理，缺失字段已按未完整识别处理。',
          },
        ],
      });

    const result = await analyzeInsurancePolicyResponsibilities({
      policy: {
        company: '新华保险',
        name: '测试终身寿险',
      },
      ocrText: '身故或身体全残保险金',
      fetchImpl,
    });

    assert.equal(result.coverageTable.length, 1);
    assert.doesNotMatch(result.coverageTable[0].note, /OCR|已上传|未完整识别/u);
    assert.match(result.coverageTable[0].note, /完整合同条款/u);
  });
});

test('policy analysis uses Ping An official domains for smart-search context', async () => {
  await withPolicyAnalysisEnv(
    async () => {
      const officialUrl = 'https://www.pingan.com/official/productSeo/pinganfu-demo';
      const calls = [];
      let deepSeekPrompt = '';
      const fetchImpl = async (url, options = {}) => {
        const href = String(url);
        calls.push(href);
        if (href.startsWith('https://deepseek.test/')) {
          deepSeekPrompt = JSON.parse(options.body).messages.map((message) => message.content).join('\n');
          return createChatResponse({
            coverageTable: [
              {
                coverageType: '身故保险金',
                scenario: '被保险人身故',
                payout: '按合同约定给付',
                note: '以正式合同为准。',
              },
            ],
          });
        }
        if (href.includes('www.so.com/s')) {
          return textResponse(`
            <li class="res-list"><h3 class="res-title">
              <a href="https://www.so.com/link?m=official" data-mdurl="${officialUrl}">中国平安 平安福 保险条款与保险责任</a>
            </h3><p class="res-desc">平安福保险责任包括身故保险金、重大疾病保险金等，具体以合同条款为准。</p></li>
            <li class="res-list"><h3 class="res-title">
              <a href="https://www.so.com/link?m=third" data-mdurl="https://news.example.com/pinganfu">平安福产品介绍</a>
            </h3><p class="res-desc">第三方介绍平安福保障责任。</p></li>
          `);
        }
        if (href.includes('duckduckgo.com/html')) return emptyHtmlResponse();
        if (href === officialUrl) {
          return textResponse(`
            <article>
              <h1>平安福保险条款</h1>
              <p>平安福保险责任包括身故保险金、重大疾病保险金、轻症疾病保险金，责任免除以正式合同为准。</p>
            </article>
          `);
        }
        return emptyHtmlResponse();
      };

      const result = await analyzeInsurancePolicyResponsibilities({
        policy: {
          company: '中国平安保险',
          name: '平安福',
        },
        fetchImpl,
      });

      const searchCalls = calls.filter((href) => href.includes('www.so.com/s'));
      assert.ok(searchCalls.length > 0);
      assert.match(decodeURIComponent(searchCalls[0]), /site:pingan\.com/u);
      assert.match(deepSeekPrompt, /证据等级：保险公司官方资料/u);
      assert.match(deepSeekPrompt, /平安福保险责任包括身故保险金、重大疾病保险金/u);
      assert.doesNotMatch(deepSeekPrompt, /非官方辅助资料（未匹配到保险公司官方条款/u);
      assert.equal(result.sources[0]?.url, officialUrl);
      assert.equal(result.sources[0]?.official, true);
      assert.equal(result.sources[0]?.evidenceLevel, 'insurer_official');
    },
    { smartSearchEnabled: true },
  );
});

const OFFICIAL_DOMAIN_CASES = [
  ['中宏人寿', '宏悦万家', 'site:manulife-sinochem.com'],
  ['中意人寿', '悦享安康', 'site:generalichina.com'],
  ['中美联泰大都会人寿', '都会臻传', 'site:metlife.com.cn'],
  ['陆家嘴国泰人寿', '美添无忧', 'site:cathaylife.cn'],
  ['信泰人寿', '如意尊', 'site:sinatay.com'],
  ['君龙人寿', '小青龙', 'site:junlonglife.com.cn'],
  ['和泰人寿', '超级玛丽', 'site:htlic.com'],
  ['招商仁和人寿', '青云卫', 'site:cmrh.com'],
  ['太平洋人寿', '金佑人生', 'site:life.cpic.com.cn'],
  ['太保寿险', '长相伴', 'site:life.cpic.com.cn'],
  ['太平洋保险', '家庭综合保障', 'site:cpic.com.cn'],
];

for (const [company, productName, expectedSiteQuery] of OFFICIAL_DOMAIN_CASES) {
  test(`policy analysis uses official domain profile for ${company}`, async () => {
    await withPolicyAnalysisEnv(
      async () => {
        const officialUrl = `https://${expectedSiteQuery.replace('site:', 'www.')}/demo/${encodeURIComponent(productName)}.html`;
        const calls = [];
        let deepSeekPrompt = '';
        const fetchImpl = async (url, options = {}) => {
          const href = String(url);
          calls.push(href);
          if (href.startsWith('https://deepseek.test/')) {
            deepSeekPrompt = JSON.parse(options.body).messages.map((message) => message.content).join('\n');
            return createChatResponse({
              coverageTable: [
                {
                  coverageType: '身故保险金',
                  scenario: '被保险人身故',
                  payout: '按合同约定给付',
                  note: '以正式合同为准。',
                },
              ],
            });
          }
          if (href.includes('www.so.com/s')) {
            return textResponse(`
              <li class="res-list"><h3 class="res-title">
                <a href="https://www.so.com/link?m=official" data-mdurl="${officialUrl}">${company}${productName}保险条款</a>
              </h3><p class="res-desc">${productName}保险责任以正式合同条款为准。</p></li>
            `);
          }
          if (href.includes('duckduckgo.com/html')) return emptyHtmlResponse();
          if (href === officialUrl) {
            return textResponse(`<article><h1>${productName}保险条款</h1><p>${productName}保险责任包括身故保险金，具体以正式合同为准。</p></article>`);
          }
          return emptyHtmlResponse();
        };

        await analyzeInsurancePolicyResponsibilities({
          policy: {
            company,
            name: productName,
          },
          fetchImpl,
        });

        const searchCalls = calls.filter((href) => href.includes('www.so.com/s'));
        assert.ok(searchCalls.length > 0);
        assert.match(decodeURIComponent(searchCalls[0]), new RegExp(expectedSiteQuery.replace(/\./gu, '\\.')));
        assert.match(deepSeekPrompt, /证据等级：保险公司官方资料/u);
      },
      { smartSearchEnabled: true },
    );
  });
}

test('policy analysis fails closed when insurer official material is not found', async () => {
  await withPolicyAnalysisEnv(
    async () => {
      const auxiliaryUrl = 'https://www.wanyiwang.com/view/112860.html';
      const calls = [];
      let responsibilityPromptCount = 0;
      const fetchImpl = async (url, options = {}) => {
        const href = decodeURIComponent(String(url));
        calls.push(href);
        if (String(url).startsWith('https://deepseek.test/')) {
          const prompt = JSON.parse(options.body).messages.map((message) => message.content).join('\n');
          if (/请只输出保险责任 coverageTable/u.test(prompt)) {
            responsibilityPromptCount += 1;
          }
          return createChatResponse({
            companyOfficialDomainHints: [],
            sources: [],
          });
        }
        if (href.includes('www.so.com/s') && (href.includes('site:sinosig.com') || href.includes('site:life.sinosig.com'))) {
          return emptyHtmlResponse();
        }
        if (href.includes('www.so.com/s')) {
          return textResponse(`
            <li class="res-list"><h3 class="res-title">
              <a href="https://www.so.com/link?m=aux" data-mdurl="${auxiliaryUrl}">阳光人寿融和安心版长期医疗保险产品介绍</a>
            </h3><p class="res-desc">阳光人寿融和安心版长期医疗保险涉及一般医疗费用、重大疾病医疗费用等责任。</p></li>
          `);
        }
        if (href.includes('duckduckgo.com/html') || href.includes('baidu.com/s')) return emptyHtmlResponse();
        if (String(url) === auxiliaryUrl) {
          return textResponse(`
            <article>
              <h1>阳光人寿融和安心版长期医疗保险产品介绍</h1>
              <p>保险责任包括一般医疗费用保险责任、重大疾病医疗费用保险责任、质子重离子医疗费用保险责任。</p>
            </article>
          `);
        }
        return emptyHtmlResponse();
      };

      await assert.rejects(
        () =>
          analyzeInsurancePolicyResponsibilities({
            policy: {
              company: '阳光人寿',
              name: '融和安心版长期医疗保险',
            },
            fetchImpl,
          }),
        (error) => {
          assert.equal(error.code, 'POLICY_ANALYSIS_OFFICIAL_SOURCE_NOT_FOUND');
          return true;
        },
      );

      const searchCalls = calls.filter((href) => href.includes('www.so.com/s'));
      assert.ok(searchCalls.length > 2);
      assert.match(searchCalls[0], /site:sinosig\.com/u);
      assert.equal(responsibilityPromptCount, 0);
    },
    { smartSearchEnabled: true },
  );
});

test('policy analysis accepts official sources discovered by DeepSeek before generating responsibilities', async () => {
  await withPolicyAnalysisEnv(
    async () => {
      const officialUrl = 'https://www.example-life.com/products/安心一号条款.html';
      const calls = [];
      let discoveryPromptCount = 0;
      let responsibilityPrompt = '';
      const fetchImpl = async (url, options = {}) => {
        const href = String(url);
        calls.push(href);
        if (href.startsWith('https://deepseek.test/')) {
          const prompt = JSON.parse(options.body).messages.map((message) => message.content).join('\n');
          if (/只查找保险公司官方资料/u.test(prompt)) {
            discoveryPromptCount += 1;
            return createChatResponse({
              companyOfficialDomainHints: ['www.example-life.com'],
              sources: [
                {
                  title: '测试人寿安心一号保险条款',
                  url: officialUrl,
                  snippet: '安心一号保险责任包括身故保险金。',
                },
              ],
            });
          }
          responsibilityPrompt = prompt;
          return createChatResponse({
            coverageTable: [
              {
                coverageType: '身故保险金',
                scenario: '被保险人身故',
                payout: '按合同约定给付',
                note: '基于官方条款生成。',
              },
            ],
          });
        }
        if (href.includes('www.so.com/s') || href.includes('duckduckgo.com/html') || href.includes('baidu.com/s')) return emptyHtmlResponse();
        if (href === officialUrl) {
          return textResponse(`
            <article>
              <h1>测试人寿安心一号保险条款</h1>
              <p>安心一号保险责任包括身故保险金，给付规则以合同约定为准。</p>
            </article>
          `);
        }
        return emptyHtmlResponse();
      };

      const result = await analyzeInsurancePolicyResponsibilities({
        policy: {
          company: '测试人寿',
          name: '安心一号',
        },
        fetchImpl,
      });

      assert.equal(discoveryPromptCount, 1);
      assert.match(responsibilityPrompt, /证据等级：保险公司官方资料/u);
      assert.equal(result.sources[0]?.url, officialUrl);
      assert.equal(result.sources[0]?.official, true);
      assert.equal(result.sources[0]?.evidenceLevel, 'insurer_official');
    },
    { smartSearchEnabled: true },
  );
});

test('policy analysis uses admin maintained official domain profiles', async () => {
  await withPolicyAnalysisEnv(
    async () => {
      const officialUrl = 'https://official.example-life.test/products/winying-one.html';
      const calls = [];
      let deepSeekPrompt = '';
      const fetchImpl = async (url, options = {}) => {
        const href = String(url);
        calls.push(href);
        if (href.startsWith('https://deepseek.test/')) {
          deepSeekPrompt = JSON.parse(options.body).messages.map((message) => message.content).join('\n');
          return createChatResponse({
            coverageTable: [
              {
                coverageType: '身故保险金',
                scenario: '被保险人身故',
                payout: '按合同约定给付',
                note: '来自维护的官方域名。',
              },
            ],
          });
        }
        if (href.includes('www.so.com/s')) {
          return textResponse(`
            <li class="res-list"><h3 class="res-title">
              <a href="https://www.so.com/link?m=official" data-mdurl="${officialUrl}">测试保险稳赢一号保险条款</a>
            </h3><p class="res-desc">稳赢一号保险责任包括身故保险金。</p></li>
          `);
        }
        if (href.includes('duckduckgo.com/html') || href.includes('baidu.com/s')) return emptyHtmlResponse();
        if (href === officialUrl) {
          return textResponse('<article>稳赢一号保险责任包括身故保险金。</article>');
        }
        return emptyHtmlResponse();
      };

      const result = await analyzeInsurancePolicyResponsibilities({
        policy: {
          company: '测试保险',
          name: '稳赢一号',
        },
        officialDomainProfiles: [
          {
            id: 'example_life',
            aliases: ['测试保险'],
            companyAliases: ['测试保险'],
            siteDomains: ['official.example-life.test'],
            officialDomains: ['official.example-life.test'],
          },
        ],
        fetchImpl,
      });

      const searchCalls = calls.filter((href) => href.includes('www.so.com/s'));
      assert.ok(searchCalls.length > 0);
      assert.match(decodeURIComponent(searchCalls[0]), /site:official\.example-life\.test/u);
      assert.match(deepSeekPrompt, /证据等级：保险公司官方资料/u);
      assert.equal(result.sources[0]?.official, true);
      assert.equal(result.sources[0]?.url, officialUrl);
    },
    { smartSearchEnabled: true },
  );
});

test('policy analysis rejects discovered sources outside a matched insurer official profile', async () => {
  await withPolicyAnalysisEnv(
    async () => {
      const wrongOfficialUrl = 'https://static-cdn.newchinalife.com/ncl/pdf/20260106/255be430-6330-4b85-a50e-829ac5e86c18.pdf';
      let responsibilityPromptCount = 0;
      const fetchImpl = async (url, options = {}) => {
        const href = String(url);
        if (href.startsWith('https://deepseek.test/')) {
          const prompt = JSON.parse(options.body).messages.map((message) => message.content).join('\n');
          if (/只查找保险公司官方资料/u.test(prompt)) {
            return createChatResponse({
              companyOfficialDomainHints: [],
              sources: [
                {
                  title: '新华人寿保险股份有限公司盛世荣耀臻享版终身寿险（分红型）',
                  url: wrongOfficialUrl,
                  snippet: '新华保险官网条款。',
                },
              ],
            });
          }
          responsibilityPromptCount += 1;
          return createChatResponse({
            coverageTable: [
              {
                coverageType: '身故保险金',
                scenario: '错误来源不应进入责任生成',
                payout: '以正式条款为准',
                note: '',
              },
            ],
          });
        }
        if (href.includes('www.so.com/s') || href.includes('duckduckgo.com/html') || href.includes('baidu.com/s')) return emptyHtmlResponse();
        if (href === wrongOfficialUrl) {
          return textResponse('保险责任 在本合同保险期间内，我们按下列规定承担保险责任。');
        }
        return emptyHtmlResponse();
      };

      await assert.rejects(
        () =>
          analyzeInsurancePolicyResponsibilities({
            policy: {
              company: '英大泰和人寿保险股份有限公司',
              name: '英大出行护身福两全保险',
            },
            fetchImpl,
          }),
        (error) => {
          assert.equal(error.code, 'POLICY_ANALYSIS_OFFICIAL_SOURCE_NOT_FOUND');
          return true;
        },
      );
      assert.equal(responsibilityPromptCount, 0);
    },
    { smartSearchEnabled: true },
  );
});

test('policy analysis can use Baidu search results when they point to an official insurer domain', async () => {
  await withPolicyAnalysisEnv(
    async () => {
      const officialUrl = 'https://life.pingan.com/products/pinganfu-baoxiantiaokuan.html';
      const calls = [];
      let deepSeekPrompt = '';
      const fetchImpl = async (url, options = {}) => {
        const href = String(url);
        calls.push(href);
        if (href.startsWith('https://deepseek.test/')) {
          deepSeekPrompt = JSON.parse(options.body).messages.map((message) => message.content).join('\n');
          return createChatResponse({
            coverageTable: [
              {
                coverageType: '身故保险金',
                scenario: '被保险人身故',
                payout: '按合同约定给付',
                note: '官方资料命中。',
              },
            ],
          });
        }
        if (href.includes('www.so.com/s') || href.includes('duckduckgo.com/html')) return emptyHtmlResponse();
        if (href.includes('baidu.com/s')) {
          return textResponse(`
            <div class="result c-container">
              <h3 class="t"><a href="${officialUrl}">平安福保险条款与保险责任</a></h3>
              <div class="c-abstract">平安福保险责任包括身故保险金、重大疾病保险金。</div>
            </div>
          `);
        }
        if (href === officialUrl) {
          return textResponse('<article>平安福保险责任包括身故保险金、重大疾病保险金。</article>');
        }
        return emptyHtmlResponse();
      };

      const result = await analyzeInsurancePolicyResponsibilities({
        policy: {
          company: '中国平安保险',
          name: '平安福',
        },
        fetchImpl,
      });

      assert.ok(calls.some((href) => href.includes('baidu.com/s')));
      assert.match(deepSeekPrompt, /证据等级：保险公司官方资料/u);
      assert.equal(result.sources[0]?.url, officialUrl);
      assert.equal(result.coverageTable[0]?.coverageType, '身故保险金');
    },
    { smartSearchEnabled: true },
  );
});

test('policy analysis uses local official knowledge before live smart search', async () => {
  await withPolicyAnalysisEnv(
    async () => {
      const calls = [];
      let deepSeekPrompt = '';
      const fetchImpl = async (url, options = {}) => {
        const href = String(url);
        calls.push(href);
        if (href.startsWith('https://deepseek.test/')) {
          deepSeekPrompt = JSON.parse(options.body).messages.map((message) => message.content).join('\n');
          return createChatResponse({
            coverageTable: [
              {
                coverageType: '身故保险金',
                scenario: '被保险人身故',
                payout: '按合同约定给付',
                note: '来自本地知识库。',
              },
            ],
          });
        }
        throw new Error(`unexpected live fetch: ${href}`);
      };

      const result = await analyzeInsurancePolicyResponsibilities({
        policy: {
          company: '中国平安保险',
          name: '平安福',
        },
        knowledgeRecords: [
          {
            company: '中国平安保险',
            productName: '平安福',
            title: '平安福保险条款',
            url: 'https://life.pingan.com/products/pinganfu-terms.pdf',
            pageText: '平安福保险责任包括身故保险金、重大疾病保险金。',
            official: true,
            sourceType: 'pdf',
          },
        ],
        fetchImpl,
      });

      assert.ok(!calls.some((href) => href.includes('www.so.com/s') || href.includes('duckduckgo.com/html') || href.includes('baidu.com/s')));
      assert.match(deepSeekPrompt, /证据等级：本地知识库官方资料/u);
      assert.match(deepSeekPrompt, /平安福保险责任包括身故保险金、重大疾病保险金/u);
      assert.equal(result.sources[0]?.url, 'https://life.pingan.com/products/pinganfu-terms.pdf');
      assert.equal(result.coverageTable[0]?.coverageType, '身故保险金');
    },
    { smartSearchEnabled: true },
  );
});

test('policy analysis does not reuse cached model output between requests', async () => {
  await withPolicyAnalysisEnv(async () => {
    let modelCalls = 0;
    const fetchImpl = async (_url, options = {}) => {
      const prompt = requestPrompt(options);
      if (isSkillRouterPrompt(prompt)) {
        return createChatResponse({
          documentType: 'responsibility_page',
          skills: [
            'responsibility_extraction',
            'indicator_quantification',
            'uploaded_ocr_fallback',
          ],
          promptDirectives: [],
          reason: '缓存测试',
        });
      }
      modelCalls += 1;
      return createChatResponse({
        coverageTable: [
          {
            coverageType: `责任${modelCalls}`,
            scenario: '达到合同约定条件',
            payout: '按合同约定给付',
            note: '缓存测试。',
          },
        ],
      });
    };

    const input = {
      policy: {
        company: '缓存测试保险',
        name: '不缓存一号',
      },
      ocrText: '责任条款',
      fetchImpl,
    };

    const first = await analyzeInsurancePolicyResponsibilities(input);
    const second = await analyzeInsurancePolicyResponsibilities(input);

    assert.equal(modelCalls, 2);
    assert.equal(first.coverageTable[0].coverageType, '责任1');
    assert.equal(second.coverageTable[0].coverageType, '责任2');
  });
});

test('policy analysis removes product mechanisms from coverage table without adding other output', async () => {
  await withPolicyAnalysisEnv(async () => {
    const fetchImpl = async () =>
      createChatResponse({
        coverageTable: [
          {
            coverageType: '身故或全残保险金',
            scenario: '被保险人身故或全残',
            payout: '缴费期满后取已交保费×给付系数、现金价值、基本保额×1.0175^(n-1)三者较大者',
            note: '给付后合同终止。',
          },
          {
            coverageType: '有效保险金额递增',
            scenario: '保单年度递增',
            payout: '按 1.75% 年复利递增',
            note: '这是给付计算口径，不是单独保险事故责任。',
          },
          {
            coverageType: '保单红利',
            scenario: '保险公司每年进行红利分配',
            payout: '红利不保证，可能为零',
            note: '可按合同约定选择领取或累积生息。',
          },
        ],
      });

    const result = await analyzeInsurancePolicyResponsibilities({
      policy: {
        company: '新华保险',
        name: '某分红型终身寿险',
        amount: 300000,
      },
      ocrText: '身故或全残保险金 有效保险金额递增 1.75% 红利不保证',
      fetchImpl,
    });

    assert.equal(result.coverageTable.length, 1);
    assert.equal(result.coverageTable[0].coverageType, '身故或全残保险金');
    assert.match(result.coverageTable[0].payout, /1\.0175/);
    assert.ok(!result.coverageTable.some((row) => /有效保险金额递增|保单红利/.test(row.coverageType)));
    assert.equal(result.report, '');
    assert.deepEqual(result.notes, []);
  });
});
