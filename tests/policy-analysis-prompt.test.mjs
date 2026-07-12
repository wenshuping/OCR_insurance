import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeInsurancePolicyResponsibilities } from '../server/c-policy-analysis.service.mjs';

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
    assert.match(prompts[1], /优先基于上传OCR逐条拆分保险责任/u);
    assert.equal(result.modelOutput.skillPlan.selectedBy, 'deepseek');
    assert.deepEqual(result.modelOutput.skillPlan.skills, [
      'responsibility_extraction',
      'indicator_quantification',
      'uploaded_ocr_fallback',
    ]);
    assert.equal(result.coverageTable[0].coverageType, '重大疾病保险金');
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
