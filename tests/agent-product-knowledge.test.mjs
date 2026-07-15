import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createAgentProductKnowledgeSearch } from '../server/agent-product-knowledge.service.mjs';
import { catalogProductScore } from '../server/product-catalog-search.mjs';

test('Agent product knowledge answers a natural responsibility question from a ready verified summary', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (id INTEGER, company TEXT, product_name TEXT, url TEXT, payload TEXT);
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT, product_name TEXT, status TEXT, updated_at TEXT, summary_json TEXT, source_urls_json TEXT
    );
  `);
  db.prepare('INSERT INTO knowledge_records VALUES (1, ?, ?, ?, ?)').run(
    '新华保险', '尊享人生年金保险（分红型）', 'https://official.test/terms.pdf', JSON.stringify({ official: true }),
  );
  db.prepare('INSERT INTO knowledge_records VALUES (2, ?, ?, ?, ?)').run(
    '新华人寿保险股份有限公司', '尊享人生年金保险（分红型）', 'https://official.test/full-name.pdf', JSON.stringify({ official: true }),
  );
  db.prepare('INSERT INTO knowledge_records VALUES (3, ?, ?, ?, ?)').run(
    '新华人寿保险股份有限公司', '尊享人生年金保险（分红型）', 'https://official.test/full-name-2.pdf', JSON.stringify({ official: true }),
  );
  db.prepare('INSERT INTO product_customer_responsibility_summaries VALUES (?, ?, ?, ?, ?, ?)').run(
    '新华保险', '尊享人生年金保险（分红型）', 'ready', '2026-07-13T00:00:00.000Z',
    JSON.stringify({ headline: '提供年金和身故保障', mainResponsibilities: [{ title: '关爱年金', plainText: '每年按首年保费的1%给付。' }] }),
    JSON.stringify(['https://official.test/terms.pdf']),
  );
  const knowledge = createAgentProductKnowledgeSearch({ db });
  const result = await knowledge.search({ question: '新华保险 尊享人生的产品保险责任啥啊' });
  assert.match(result.answer, /尊享人生年金保险/u);
  assert.match(result.answer, /关爱年金/u);
  const followUp = await knowledge.search({
    question: '这个产品有啥优势呀',
    productName: '尊享人生年金保险（分红型）',
    company: '新华保险',
  });
  assert.match(followUp.answer, /尊享人生年金保险/u);
  assert.equal(followUp.candidates, undefined);
  assert.equal(result.sources[0].verified, true);
  assert.deepEqual(knowledge.allowedOrigins, ['https://official.test']);
  db.close();
});

test('Agent product knowledge compares two explicitly named products with verified evidence', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (id INTEGER, company TEXT, product_name TEXT, url TEXT, payload TEXT);
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT, product_name TEXT, status TEXT, updated_at TEXT, summary_json TEXT, source_urls_json TEXT
    );
  `);
  const insert = db.prepare('INSERT INTO product_customer_responsibility_summaries VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(
    '中国人寿', '国寿如E康悦百万医疗保险（A款）', 'ready', '2026-07-13T00:00:00.000Z',
    JSON.stringify({ headline: '一年期百万医疗保障', mainResponsibilities: [{ title: '一般医疗', plainText: '年度限额一百万元。' }] }),
    JSON.stringify(['https://life.test/rukangyue-a.pdf']),
  );
  insert.run(
    '新华保险', '康健长佑长期医疗保险（费率可调）', 'ready', '2026-07-13T00:00:00.000Z',
    JSON.stringify({ headline: '长期医疗保障', mainResponsibilities: [{ title: '一般医疗', plainText: '费率可以调整。' }] }),
    JSON.stringify(['https://newchinalife.test/kangjian-changyou.pdf']),
  );
  let requestBody;
  const knowledge = createAgentProductKnowledgeSearch({
    db,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test' },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, async json() { return { choices: [{ message: { content: '两款产品的主要差异是保障期限与费率机制。' } }] }; } };
    },
  });

  const result = await knowledge.search({
    question: '国寿如E康悦百万医疗保险（A款） 对比 新华保险的康健长佑',
  });

  assert.match(result.answer, /主要差异/u);
  assert.match(result.answer, /核心差异/u);
  assert.match(result.answer, /怎么选/u);
  assert.match(result.answer, /一般医疗/u);
  assert.match(result.answer, /费率可以调整/u);
  assert.match(result.answer, /两款产品完整已核验责任/u);
  assert.equal(result.sources.length, 2);
  assert.match(JSON.stringify(requestBody.messages), /国寿如E康悦百万医疗保险（A款）/u);
  assert.match(JSON.stringify(requestBody.messages), /康健长佑长期医疗保险（费率可调）/u);
  assert.match(JSON.stringify(requestBody.messages), /完整责任将由程序原样附在答案末尾/u);
  assert.equal(requestBody.max_tokens, 3_000);
  db.close();
});

test('resolved product search does not reparse the full comparison question', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (id INTEGER, company TEXT, product_name TEXT, url TEXT, payload TEXT);
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT, product_name TEXT, status TEXT, updated_at TEXT, summary_json TEXT, source_urls_json TEXT
    );
  `);
  const insert = db.prepare('INSERT INTO product_customer_responsibility_summaries VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(
    '新华保险', '医药安欣（易核版）医疗保险', 'ready', '2026-07-13T00:00:00.000Z',
    JSON.stringify({ headline: '医疗保障', mainResponsibilities: [{ title: '一般医疗', plainText: '医疗费用报销。' }] }),
    JSON.stringify(['https://official.test/medical.pdf']),
  );
  insert.run(
    '新华保险', '新华人寿保险股份有限公司康健无忧两全保险', 'ready', '2026-07-13T00:00:00.000Z',
    JSON.stringify({ headline: '两全保障', mainResponsibilities: [{ title: '满期生存保险金', plainText: '满期给付。' }] }),
    JSON.stringify(['https://official.test/endowment.pdf']),
  );
  const knowledge = createAgentProductKnowledgeSearch({ db });
  const result = await knowledge.search({
    question: '医药安欣和康健无忧哪个好',
    product: {
      canonicalProductId: 'medical', company: '新华保险',
      officialName: '医药安欣（易核版）医疗保险',
    },
  });
  assert.match(result.answer, /一般医疗/u);
  assert.doesNotMatch(result.answer, /满期生存保险金/u);
  assert.equal(result.sources[0].url, 'https://official.test/medical.pdf');
  db.close();
});

test('product catalog tolerates one adjacent-character transposition in a natural product name', () => {
  const productName = '新华人寿保险股份有限公司康健长佑长期医疗保险（费率可调）';
  assert.ok(catalogProductScore('健康长佑', productName) >= 700);
  assert.ok(catalogProductScore('健康长佑', productName) > catalogProductScore('健康长佑', '健康福享重大疾病保险'));
});

test('Agent product knowledge asks for confirmation before correcting a transposed product name', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (id INTEGER, company TEXT, product_name TEXT, url TEXT, payload TEXT);
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT, product_name TEXT, status TEXT, updated_at TEXT, summary_json TEXT, source_urls_json TEXT
    );
  `);
  const productName = '新华人寿保险股份有限公司康健长佑长期医疗保险（费率可调）';
  db.prepare('INSERT INTO product_customer_responsibility_summaries VALUES (?, ?, ?, ?, ?, ?)').run(
    '新华保险', productName, 'ready', '2026-07-13T00:00:00.000Z',
    JSON.stringify({ headline: '医疗保障' }), JSON.stringify(['https://official.test/terms.pdf']),
  );
  const knowledge = createAgentProductKnowledgeSearch({ db });

  const result = await knowledge.search({ question: '新华保险健康长佑保险是啥内容', productName: '新华保险健康长佑' });

  assert.equal(result.answer, '');
  assert.equal(result.candidates.length, 1);
  assert.match(result.candidates[0].label, /康健长佑长期医疗保险/u);
  db.close();
});

test('Agent product knowledge lists only products with verified on-sale status', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (id INTEGER, company TEXT, product_name TEXT, url TEXT, payload TEXT);
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT, product_name TEXT, status TEXT, updated_at TEXT, summary_json TEXT, source_urls_json TEXT
    );
  `);
  const insert = db.prepare('INSERT INTO knowledge_records VALUES (?, ?, ?, ?, ?)');
  insert.run(1, '中国人寿', '国寿百万医疗保险（在售版）', 'https://official.test/on-sale.pdf', JSON.stringify({
    evidenceLevel: 'insurer_official', salesStatus: '在售', pageText: '官方在售产品资料，包含医疗保险责任说明。',
  }));
  insert.run(2, '中国人寿', '国寿百万医疗保险（停售版）', 'https://official.test/off-sale.pdf', JSON.stringify({
    evidenceLevel: 'insurer_official', salesStatus: '停售', pageText: '官方历史产品资料，包含医疗保险责任说明。',
  }));
  const knowledge = createAgentProductKnowledgeSearch({ db });

  const result = await knowledge.search({ question: '在售的有哪些', productName: '中国人寿百万医疗' });

  assert.match(result.answer, /在售版/u);
  assert.doesNotMatch(result.answer, /停售版/u);
  assert.match(result.answer, /联网未找到官网明确标注/u);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].verified, true);
  db.close();
});

test('Agent product knowledge prefers a live official sales-status check', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (id INTEGER, company TEXT, product_name TEXT, url TEXT, payload TEXT);
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT, product_name TEXT, status TEXT, updated_at TEXT, summary_json TEXT, source_urls_json TEXT
    );
  `);
  const insert = db.prepare('INSERT INTO knowledge_records VALUES (?, ?, ?, ?, ?)');
  insert.run(1, '中国人寿', '国寿百万医疗保险（A款）', 'https://official.test/a.pdf', JSON.stringify({
    evidenceLevel: 'insurer_official', salesStatus: '在售', pageText: '历史官方产品资料。',
  }));
  insert.run(2, '中国人寿', '国寿百万医疗保险（B款）', 'https://official.test/b.pdf', JSON.stringify({
    evidenceLevel: 'insurer_official', salesStatus: '在售', pageText: '历史官方产品资料。',
  }));
  let lookupInput;
  const knowledge = createAgentProductKnowledgeSearch({
    db,
    salesStatusLookup: async (input) => {
      lookupInput = input;
      return [{
        company: '中国人寿',
        productName: '国寿百万医疗保险（B款）',
        status: '在售',
        source: { title: '中国人寿官网当前产品页', url: 'https://official.test/current-b' },
      }];
    },
  });

  const result = await knowledge.search({ question: '在售的有哪些', productName: '中国人寿百万医疗' });

  assert.equal(lookupInput.company, '中国人寿');
  assert.equal(lookupInput.productNames.length, 2);
  assert.equal(lookupInput.discoveryQuery, '百万医疗');
  assert.match(result.answer, /已核验 2 款候选产品/u);
  assert.match(result.answer, /官网确认在售 1 款/u);
  assert.match(result.answer, /B款/u);
  assert.match(result.answer, /待官网核验/u);
  assert.match(result.answer, /A款/u);
  assert.equal(result.sources[0].url, 'https://official.test/current-b');
  db.close();
});

test('Agent product knowledge includes newly discovered products as pending official verification', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (id INTEGER, company TEXT, product_name TEXT, url TEXT, payload TEXT);
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT, product_name TEXT, status TEXT, updated_at TEXT, summary_json TEXT, source_urls_json TEXT
    );
  `);
  db.prepare('INSERT INTO knowledge_records VALUES (1, ?, ?, ?, ?)').run(
    '中国人寿', '国寿如E康悦百万医疗保险（A款）', 'https://official.test/old.pdf',
    JSON.stringify({ evidenceLevel: 'insurer_official', salesStatus: '在售', pageText: '历史官方产品资料。' }),
  );
  const knowledge = createAgentProductKnowledgeSearch({
    db,
    salesStatusLookup: async () => [{
      company: '中国人寿', productName: '国寿康悦臻享医疗保险（费率可调）', status: '待核验',
      evidenceLevel: 'open_web_reference', source: { title: '新品报道', url: 'https://media.test/new-product' },
    }],
  });

  const result = await knowledge.search({ question: '有哪些在售的百万医疗', productName: '中国人寿百万医疗' });

  assert.match(result.answer, /全网发现/u);
  assert.match(result.answer, /国寿康悦臻享医疗保险（费率可调）/u);
  assert.match(result.answer, /第三方线索/u);
  assert.match(result.answer, /国寿如E康悦百万医疗保险（A款）/u);
  db.close();
});

test('Agent product knowledge stays disabled for lightweight databases without summary tables', () => {
  const db = new DatabaseSync(':memory:');
  assert.equal(createAgentProductKnowledgeSearch({ db }), null);
  db.close();
});

test('Agent product knowledge falls back to exact-product official terms when a customer summary is missing', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (id INTEGER, company TEXT, product_name TEXT, url TEXT, payload TEXT);
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT, product_name TEXT, status TEXT, updated_at TEXT, summary_json TEXT, source_urls_json TEXT
    );
  `);
  db.prepare('INSERT INTO knowledge_records VALUES (1, ?, ?, ?, ?)').run(
    '新华保险', '新华人寿保险股份有限公司荣耀鑫享终身寿险', 'https://official.test/base.pdf',
    JSON.stringify({ evidenceLevel: 'insurer_official', pageText: '保险责任：被保险人身故或身体全残，本公司按合同约定给付身故或身体全残保险金。特定公共交通工具意外伤害导致身故或全残时，按基本保险金额的1.5倍额外给付。' }),
  );
  const knowledge = createAgentProductKnowledgeSearch({ db });

  const result = await knowledge.search({
    question: '这个产品的保险责任',
    productName: '新华人寿保险股份有限公司荣耀鑫享终身寿险',
  });

  assert.match(result.answer, /身故或身体全残/u);
  assert.equal(result.sources[0].verified, true);
  assert.equal(result.sources[0].url, 'https://official.test/base.pdf');
  assert.deepEqual(knowledge.allowedOrigins, ['https://official.test']);
  db.close();
});

test('Agent product knowledge returns the complete enriched C-end responsibility view without regenerating it', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (id INTEGER, company TEXT, product_name TEXT, url TEXT, payload TEXT);
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT, product_name TEXT, status TEXT, updated_at TEXT, summary_json TEXT, source_urls_json TEXT
    );
    CREATE TABLE insurance_products (
      canonical_product_id TEXT, company TEXT, official_name TEXT, status TEXT
    );
  `);
  db.prepare('INSERT INTO knowledge_records VALUES (1, ?, ?, ?, ?)').run(
    '新华保险', '测试终身寿险', 'https://official.test/terms.pdf',
    JSON.stringify({ evidenceLevel: 'insurer_official', pageText: '这是用于目录精确匹配的官方条款文本，具体保险责任由共享保险责任助手返回。' }),
  );
  db.prepare('INSERT INTO insurance_products VALUES (?, ?, ?, ?)').run(
    'product_test_life', '新华保险', '测试终身寿险', 'active',
  );
  const calls = [];
  const summaryCalls = [];
  let modelCalls = 0;
  const knowledge = createAgentProductKnowledgeSearch({
    db,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test' },
    fetchImpl: async (_url, options) => {
      modelCalls += 1;
      return { ok: true, async json() { return { choices: [] }; } };
    },
    responsibilityQuery: async (input) => {
      calls.push(input);
      return { analysis: {
        report: '共享保险责任助手结果',
        coverageTable: [{ coverageType: '身故保险金', scenario: '被保险人身故', payout: '按合同约定给付' }],
        sources: [{ title: '官方条款', url: 'https://official.test/terms.pdf', evidenceLevel: 'insurer_official', official: true }],
      } };
    },
    responsibilitySummaryQuery: async (input) => {
      summaryCalls.push(input);
      return {
        ok: true,
        source: 'database',
        summary: {
          headline: '客户可读责任摘要',
          contentBlocks: [
            { blockKey: 'productPurpose', title: '产品主要做什么', content: '用于提供终身身故保障。', enabled: true, order: 1 },
            { blockKey: 'responsibilities', title: '主要保险责任', content: '提供身故保障。', enabled: true, order: 2 },
            { blockKey: 'productFunctions', title: '产品功能', content: '不展示。', enabled: false, order: 3 },
            { blockKey: 'attentionNotes', title: '注意事项', content: '具体金额以保险合同为准。', enabled: true, order: 4 },
            { blockKey: 'uploadedMaterial1', title: '家庭保障场景', content: '培训资料补充了家庭责任拆解说明。', enabled: true, order: 5, sourceRefs: ['M1'] },
          ],
          mainResponsibilities: [{
            title: '身故保险金',
            plainText: '被保险人身故后按合同约定给付。',
            triggerCondition: '被保险人身故',
            howItPays: '按合同约定金额给付',
            calculationStatus: 'claim_contingent',
            requiredPolicyFields: ['基本保险金额'],
            sourceRefs: ['src_1'],
          }],
          notices: ['具体金额以保险合同为准。'],
          sourceUrls: ['https://official.test/terms.pdf'],
          materialSources: [{ evidenceId: 'M1', fileName: '客户上传资料.pdf', pageStart: 3, pageEnd: 3 }],
        },
      };
    },
  });

  const result = await knowledge.search({ question: '保什么', productName: '测试终身寿险' });

  assert.deepEqual(calls, [{ company: '新华保险', name: '测试终身寿险' }]);
  assert.deepEqual(summaryCalls, [{ company: '新华保险', name: '测试终身寿险' }]);
  assert.match(result.answer, /### 产品主要做什么\n用于提供终身身故保障/u);
  assert.match(result.answer, /### 主要保险责任\n提供身故保障/u);
  assert.match(result.answer, /### 责任明细（1项）/u);
  assert.match(result.answer, /1\. \*\*身故保险金\*\*/u);
  assert.match(result.answer, /触发条件：被保险人身故/u);
  assert.match(result.answer, /calculationStatus: claim_contingent/u);
  assert.match(result.answer, /来源：src_1/u);
  assert.match(result.answer, /计算所需保单信息：基本保险金额/u);
  assert.match(result.answer, /### 家庭保障场景/u);
  assert.match(result.answer, /培训资料补充了家庭责任拆解说明/u);
  assert.match(result.answer, /来源：M1/u);
  assert.match(result.answer, /M1：客户上传资料.pdf（第3页）/u);
  assert.doesNotMatch(result.answer, /不展示/u);
  assert.doesNotMatch(result.answer, /共享保险责任助手结果/u);
  assert.equal(modelCalls, 0);
  assert.equal(result.sources[0].provenance, 'insurer_official');
  db.close();
});

test('Agent product knowledge falls back to the complete C-end responsibility set without uploaded additions', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (id INTEGER, company TEXT, product_name TEXT, url TEXT, payload TEXT);
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT, product_name TEXT, status TEXT, updated_at TEXT, summary_json TEXT, source_urls_json TEXT
    );
    CREATE TABLE insurance_products (
      canonical_product_id TEXT, company TEXT, official_name TEXT, status TEXT
    );
  `);
  db.prepare('INSERT INTO knowledge_records VALUES (1, ?, ?, ?, ?)').run(
    '新华保险', '康健无忧两全保险', 'https://official.test/terms.pdf',
    JSON.stringify({ evidenceLevel: 'insurer_official', pageText: '康健无忧两全保险正式条款。' }),
  );
  db.prepare('INSERT INTO insurance_products VALUES (?, ?, ?, ?)').run(
    'product_kangjian', '新华保险', '康健无忧两全保险', 'active',
  );
  const responsibilities = [
    ['满期生存保险金', '保险期间届满时按合同约定给付。'],
    ['疾病身故保险金（180日内）', '合同生效后180日内因疾病身故。'],
    ['意外伤害身故保险金（180日内）', '合同生效后180日内因意外伤害身故。'],
    ['身故保险金（180日后）', '合同生效后180日后身故。'],
  ];
  const knowledge = createAgentProductKnowledgeSearch({
    db,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test' },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { choices: [{ message: { content: '额外营销责任：按培训资料宣传口径提供扩展保障【培训资料M1·第8页】。' } }] };
      },
    }),
    responsibilityQuery: async () => ({ analysis: {
      report: '责任卡结果',
      coverageTable: [{ coverageType: '额外营销责任', scenario: '培训资料场景', payout: '宣传口径' }],
      sources: [{ title: '正式条款', url: 'https://official.test/terms.pdf', evidenceLevel: 'insurer_official', official: true }],
    } }),
    responsibilitySummaryQuery: async () => ({
      ok: true,
      summary: {
        headline: '本产品包含满期生存和身故保障。',
        mainResponsibilities: responsibilities.map(([title, plainText]) => ({ title, plainText })),
        sourceUrls: ['https://official.test/terms.pdf'],
      },
    }),
    productRagRetrieve: async () => ({
      evidenceChunks: [{
        evidenceId: 'M1',
        documentId: 'training',
        content: '额外营销责任：宣传资料中的扩展说法。',
        sourceAuthority: 'company_material',
        reviewStatus: 'published',
        citation: { fileName: '培训资料.pptx', pageStart: 8, pageEnd: 8 },
      }],
    }),
  });

  const result = await knowledge.search({ question: '保险责任是什么', productName: '康健无忧两全保险' });

  for (const [title] of responsibilities) assert.match(result.answer, new RegExp(title, 'u'));
  assert.doesNotMatch(result.answer, /额外营销责任/u);
  db.close();
});

test('Agent product knowledge waits for the shared customer summary instead of returning a different fallback', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (id INTEGER, company TEXT, product_name TEXT, url TEXT, payload TEXT);
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT, product_name TEXT, status TEXT, updated_at TEXT, summary_json TEXT, source_urls_json TEXT
    );
  `);
  db.prepare('INSERT INTO knowledge_records VALUES (1, ?, ?, ?, ?)').run(
    '中国人寿', '国寿惠享保百万医疗险', 'https://official.test/terms.pdf',
    JSON.stringify({ evidenceLevel: 'insurer_official', pageText: '这是用于目录精确匹配的官方保险条款责任正文。' }),
  );
  let summaryResolved = false;
  const knowledge = createAgentProductKnowledgeSearch({
    db,
    responsibilityQuery: async () => ({ analysis: {
      report: '官方条款责任结果',
      coverageTable: [{ coverageType: '一般医疗保险金', scenario: '被保险人住院治疗', payout: '按合同约定报销' }],
      sources: [{ title: '官方条款', url: 'https://official.test/terms.pdf', evidenceLevel: 'insurer_official', official: true }],
    } }),
    responsibilitySummaryQuery: () => new Promise((resolve) => {
      setTimeout(() => {
        summaryResolved = true;
        resolve({ summary: { headline: '迟到的摘要' } });
      }, 100);
    }),
  });

  const startedAt = Date.now();
  const result = await knowledge.search({ question: '保险责任', productName: '国寿惠享保百万医疗险' });

  assert.ok(Date.now() - startedAt >= 90);
  assert.match(result.answer, /迟到的摘要/u);
  assert.doesNotMatch(result.answer, /一般医疗保险金/u);
  assert.equal(result.sources[0].verified, true);
  assert.equal(summaryResolved, true);
  db.close();
});

test('Agent product knowledge resolves insurer aliases before ranking similar products', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (id INTEGER, company TEXT, product_name TEXT, url TEXT, payload TEXT);
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT, product_name TEXT, status TEXT, updated_at TEXT, summary_json TEXT, source_urls_json TEXT
    );
  `);
  const insert = db.prepare('INSERT INTO product_customer_responsibility_summaries VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('中国人寿', '国寿如E康悦百万医疗保险（A款）', 'ready', '2026-07-13T00:00:00.000Z',
    JSON.stringify({ headline: '中国人寿产品' }), JSON.stringify(['https://official.test/china-life.pdf']));
  insert.run('中邮人寿', '中邮年年好邮保百万医疗保险', 'ready', '2026-07-13T00:00:00.000Z',
    JSON.stringify({ headline: '中邮人寿产品' }), JSON.stringify(['https://official.test/china-post.pdf']));
  const knowledge = createAgentProductKnowledgeSearch({
    db,
    officialDomainProfiles: [{ company: '中国人寿', aliases: ['中国人寿', '国寿'], companyAliases: ['中国人寿'] }],
  });

  const result = await knowledge.search({
    question: '国寿惠享保百万医疗险 保险责任',
    productName: '国寿惠享保百万医疗险',
  });

  assert.doesNotMatch(result.answer || '', /中邮/u);
  assert.deepEqual(result.candidates, undefined);
  assert.deepEqual(result.sources, []);
  assert.equal(result.guidance, true);
  assert.match(result.answer, /中国人寿财产保险股份有限公司/u);
  assert.match(result.answer, /个人住院医疗保险E/u);
  assert.match(result.answer, /精选版还是尊享版/u);
  db.close();
});

test('Agent product knowledge asks the customer to choose between equally matched products', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (id INTEGER, company TEXT, product_name TEXT, url TEXT, payload TEXT);
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT, product_name TEXT, status TEXT, updated_at TEXT, summary_json TEXT, source_urls_json TEXT
    );
  `);
  const insert = db.prepare('INSERT INTO product_customer_responsibility_summaries VALUES (?, ?, ?, ?, ?, ?)');
  for (const productName of ['新华人寿保险股份有限公司荣耀鑫享赢家版终身寿险', '新华人寿保险股份有限公司荣耀鑫享智赢版终身寿险']) {
    insert.run('新华保险', productName, 'ready', '2026-07-13T00:00:00.000Z',
      JSON.stringify({ headline: `${productName}保险责任` }), JSON.stringify(['https://official.test/terms.pdf']));
  }
  const insertKnowledge = db.prepare('INSERT INTO knowledge_records VALUES (?, ?, ?, ?, ?)');
  ['新华人寿保险股份有限公司荣耀鑫享庆典版终身寿险', '新华人寿保险股份有限公司荣耀鑫享智享版终身寿险', '新华人寿保险股份有限公司荣耀鑫享终身寿险']
    .forEach((productName, index) => insertKnowledge.run(index + 1, '新华保险', productName, 'https://official.test/terms.pdf', '{}'));

  const knowledge = createAgentProductKnowledgeSearch({ db });
  const result = await knowledge.search({ question: '新华的荣耀鑫享保险责任', productName: '新华的荣耀鑫享' });

  assert.equal(result.answer, '');
  assert.equal(result.candidates.length, 5);
  assert.ok(result.candidates.some((candidate) => /庆典版/u.test(candidate.label)));
  assert.ok(result.candidates.some((candidate) => /赢家版/u.test(candidate.label)));
  assert.ok(result.candidates.some((candidate) => /智享版/u.test(candidate.label)));
  assert.ok(result.candidates.some((candidate) => /智赢版/u.test(candidate.label)));
  db.close();
});

test('Agent product knowledge asks DeepSeek to answer the actual question from verified evidence', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (id INTEGER, company TEXT, product_name TEXT, url TEXT, payload TEXT);
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT, product_name TEXT, status TEXT, updated_at TEXT, summary_json TEXT, source_urls_json TEXT
    );
  `);
  db.prepare('INSERT INTO knowledge_records VALUES (1, ?, ?, ?, ?)').run(
    '新华保险', '尊享人生年金保险（分红型）', 'https://official.test/terms.pdf', JSON.stringify({ official: true }),
  );
  db.prepare('INSERT INTO product_customer_responsibility_summaries VALUES (?, ?, ?, ?, ?, ?)').run(
    '新华保险', '尊享人生年金保险（分红型）', 'ready', '2026-07-13T00:00:00.000Z',
    JSON.stringify({ headline: '提供年金、身故保障及非保证分红', mainResponsibilities: [{ title: '关爱年金', plainText: '按首年保费的1%给付。' }] }),
    JSON.stringify(['https://official.test/terms.pdf']),
  );
  let requestBody;
  const knowledge = createAgentProductKnowledgeSearch({
    db,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test', DINGTALK_PRODUCT_EXPERT_MODEL: 'test-model' },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, async json() { return { choices: [{ message: { content: '主要优势是兼顾年金现金流与身故保障；分红属于非保证利益。' } }] }; } };
    },
  });

  const result = await knowledge.search({
    question: '这个产品有啥优势呀',
    productName: '尊享人生年金保险（分红型）',
  });

  assert.match(result.answer, /主要优势/u);
  assert.match(result.answer, /非保证利益/u);
  assert.equal(requestBody.model, 'test-model');
  assert.match(JSON.stringify(requestBody.messages), /这个产品有啥优势呀/u);
  assert.match(JSON.stringify(requestBody.messages), /按首年保费的1%给付/u);
  assert.doesNotMatch(JSON.stringify(requestBody.messages), /familyName|家庭数据/u);
  db.close();
});

test('Agent product knowledge asks DeepSeek to fuse official and approved uploaded evidence', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (id INTEGER, company TEXT, product_name TEXT, url TEXT, payload TEXT);
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT, product_name TEXT, status TEXT, updated_at TEXT, summary_json TEXT, source_urls_json TEXT
    );
    CREATE TABLE insurance_products (
      canonical_product_id TEXT, company TEXT, official_name TEXT, status TEXT
    );
  `);
  const productName = '医药安欣（易核版）医疗保险';
  db.prepare('INSERT INTO product_customer_responsibility_summaries VALUES (?, ?, ?, ?, ?, ?)').run(
    '新华保险', productName, 'ready', '2026-07-13T00:00:00.000Z',
    JSON.stringify({ headline: '提供医疗费用保障', mainResponsibilities: [{ title: '一般医疗费用保险金', plainText: '按正式条款约定报销。' }] }),
    JSON.stringify(['https://official.test/medical-anxin']),
  );
  db.prepare('INSERT INTO insurance_products VALUES (?, ?, ?, ?)').run('product_medical_anxin', '新华保险', productName, 'active');
  let ragInput;
  let requestBody;
  const knowledge = createAgentProductKnowledgeSearch({
    db,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test' },
    productRagRetrieve(input) {
      ragInput = input;
      return {
        evidenceChunks: [{
          documentId: 'doc-training',
          canonicalProductId: 'product_medical_anxin',
          content: '健告宽松、高龄可投、次标可保，并可搭配外购药械与康护责任。',
          contextualPrefix: '切片主题：产品优势、投保规则',
          pageStart: 14,
          pageEnd: 14,
          sourceAuthority: 'company_material',
          reviewStatus: 'published',
          citation: { fileName: '健康险产品培训课件.pptx', pageStart: 14, pageEnd: 14 },
        }],
      };
    },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, async json() { return { choices: [{ message: { content: '综合来看，产品兼顾医疗费用保障【官方资料O1】，并具有健告宽松、高龄可投等特点【培训资料M1·第14页】。' } }] }; } };
    },
  });

  const result = await knowledge.search({ question: '医药安欣有什么优势', productName });
  const prompt = JSON.stringify(requestBody.messages);

  assert.equal(ragInput.canonicalProductId, 'product_medical_anxin');
  assert.match(prompt, /一般医疗费用保险金/u);
  assert.match(prompt, /健告宽松、高龄可投/u);
  assert.match(prompt, /officialEvidence/u);
  assert.match(prompt, /approvedCompanyMaterialEvidence/u);
  assert.match(prompt, /evidenceId/u);
  assert.match(prompt, /每项结论/u);
  assert.match(result.answer, /综合来看/u);
  assert.equal(result.sources.some((source) => source.provenance === 'insurer_official'), true);
  assert.equal(result.sources.some((source) => source.provenance === 'company_material'), true);
  db.close();
});

test('Agent product knowledge automatically chunks official terms and balances advantage evidence four to four', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (id INTEGER, company TEXT, product_name TEXT, url TEXT, payload TEXT);
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT, product_name TEXT, status TEXT, updated_at TEXT, summary_json TEXT, source_urls_json TEXT
    );
    CREATE TABLE insurance_products (
      canonical_product_id TEXT, company TEXT, official_name TEXT, status TEXT
    );
  `);
  const productName = '平衡测试医疗保险';
  db.prepare('INSERT INTO knowledge_records VALUES (?, ?, ?, ?, ?)').run(
    1,
    '测试保险',
    productName,
    'https://official.test/balanced-terms.pdf',
    JSON.stringify({
      evidenceLevel: 'insurer_official',
      pageText: [
        '第六条 保险责任',
        '本产品等待期为60天。',
        '20261 第 2 页',
        '第七条 一般医疗费用保险金',
        '一般医疗费用保险金年度给付限额为200万元。',
        '20261 第 3 页',
        '第八条 外购药械医疗费用保险金',
        '符合条件的外购药械医疗费用可以按合同约定给付。',
        '第九条 特定先进医疗费用保险金',
        '符合条件的质子重离子和细胞免疫治疗费用可以按合同约定给付。',
        '第十条 续保',
        '续保条件以本条约定为准。',
      ].join('\n'),
    }),
  );
  db.prepare('INSERT INTO product_customer_responsibility_summaries VALUES (?, ?, ?, ?, ?, ?)').run(
    '测试保险', productName, 'ready', '2026-07-13T00:00:00.000Z',
    JSON.stringify({
      headline: '正式保险条款',
      mainResponsibilities: [{
        title: '官方条款保险责任',
        plainText: [
          '第六条 保险责任',
          '本产品等待期为60天。',
          '20261 第 2 页',
          '第七条 一般医疗费用保险金',
          '一般医疗费用保险金年度给付限额为200万元。',
          '20261 第 3 页',
          '第八条 外购药械医疗费用保险金',
          '符合条件的外购药械医疗费用可以按合同约定给付。',
          '第九条 特定先进医疗费用保险金',
          '符合条件的质子重离子和细胞免疫治疗费用可以按合同约定给付。',
          '第十条 续保',
          '续保条件以本条约定为准。',
        ].join('\n'),
      }],
    }),
    JSON.stringify(['https://official.test/balanced-terms.pdf']),
  );
  db.prepare('INSERT INTO insurance_products VALUES (?, ?, ?, ?)').run('product-balanced', '测试保险', productName, 'active');
  let requestBody;
  const knowledge = createAgentProductKnowledgeSearch({
    db,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test' },
    responsibilityQuery: async () => ({ analysis: {
      responsibilityCards: Array.from({ length: 8 }, (_, index) => ({
        title: `结构化责任${index + 1}`,
        payoutSummary: `按第${index + 1}项结构化规则给付`,
        sourceExcerpt: `正式条款责任${index + 1}`,
        sourceTitle: '官方条款',
        sourceUrl: 'https://official.test/balanced-terms.pdf',
        evidenceLevel: 'insurer_official',
        official: true,
        indicatorCheckStatus: index === 7 ? 'needs_indicator_review' : 'requires_table_or_policy_data',
        indicatorCheckIssues: index === 7 ? ['missing_structured_indicator'] : ['requires_table_or_policy_data'],
      })),
      sources: [{ title: '官方条款', url: 'https://official.test/balanced-terms.pdf', evidenceLevel: 'insurer_official', official: true }],
    } }),
    productRagRetrieve() {
      return {
        queryType: 'product_advantage',
        evidenceChunks: Array.from({ length: 6 }, (_, index) => ({
          evidenceId: `M${index + 1}`,
          documentId: 'doc-training',
          content: `培训资料优势${index + 1}`,
          contextualPrefix: '切片主题：产品优势',
          pageStart: index + 10,
          pageEnd: index + 10,
          sourceAuthority: 'company_material',
          reviewStatus: 'published',
          citation: { fileName: '测试课件.pptx', pageStart: index + 10, pageEnd: index + 10 },
        })),
      };
    },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, async json() { return { choices: [{ message: { content: '综合优势【官方资料O1·第1页】【培训资料M1·第10页】。' } }] }; } };
    },
  });

  const result = await knowledge.search({ question: '这个产品有什么优势？', productName });
  const evidence = JSON.parse(requestBody.messages[1].content).verifiedEvidence;

  assert.equal(evidence.responsibilityCardEvidence.length, 6);
  assert.deepEqual(evidence.responsibilityCardEvidence.map((item) => item.evidenceId), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
  assert.equal(evidence.officialEvidence.length, 4);
  assert.deepEqual(evidence.officialEvidence.map((item) => item.evidenceId), ['O1', 'O2', 'O3', 'O4']);
  assert.equal(evidence.approvedCompanyMaterialEvidence.length, 4);
  assert.deepEqual(evidence.approvedCompanyMaterialEvidence.map((item) => item.evidenceId), ['M1', 'M2', 'M3', 'M4']);
  assert.deepEqual(
    result.sources.find((source) => source.provenance === 'insurer_official').evidenceIds,
    ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'O1', 'O2', 'O3', 'O4'],
  );
  db.close();
});

test('Agent product knowledge reports critical conflicts and silently removes unknown evidence references', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (id INTEGER, company TEXT, product_name TEXT, url TEXT, payload TEXT);
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT, product_name TEXT, status TEXT, updated_at TEXT, summary_json TEXT, source_urls_json TEXT
    );
    CREATE TABLE insurance_products (
      canonical_product_id TEXT, company TEXT, official_name TEXT, status TEXT
    );
  `);
  const productName = '测试医疗保险';
  db.prepare('INSERT INTO product_customer_responsibility_summaries VALUES (?, ?, ?, ?, ?, ?)').run(
    '测试保险', productName, 'ready', '2026-07-13T00:00:00.000Z',
    JSON.stringify({ headline: '正式条款等待期为90天。' }),
    JSON.stringify(['https://official.test/medical']),
  );
  db.prepare('INSERT INTO insurance_products VALUES (?, ?, ?, ?)').run('product-test', '测试保险', productName, 'active');
  let requestBody;
  const knowledge = createAgentProductKnowledgeSearch({
    db,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test' },
    productRagRetrieve() {
      return {
        evidenceChunks: [{
          evidenceId: 'M1',
          documentId: 'doc-training',
          content: '本产品等待期为30天。',
          contextualPrefix: '切片主题：投保规则',
          pageStart: 8,
          pageEnd: 8,
          sourceAuthority: 'company_material',
          reviewStatus: 'published',
          citation: { fileName: '测试课件.pptx', pageStart: 8, pageEnd: 8 },
        }],
      };
    },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, async json() { return { choices: [{ message: { content: '等待期以正式条款的90天为准【官方资料O1】，培训资料存在差异【培训资料M99】。' } }] }; } };
    },
  });

  const result = await knowledge.search({ question: '等待期多久？', productName });
  const prompt = JSON.stringify(requestBody.messages);

  assert.match(prompt, /等待期/u);
  assert.match(prompt, /90天/u);
  assert.match(prompt, /30天/u);
  assert.match(prompt, /conflicts/u);
  assert.doesNotMatch(result.answer, /M99/u);
  assert.doesNotMatch(result.answer, /资料引用已移除|引用已移除/u);
  assert.match(result.answer, /【官方资料O1】/u);
  db.close();
});

test('Agent product knowledge reads the matched official document when the stored excerpt misses the deductible values', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (id INTEGER, company TEXT, product_name TEXT, url TEXT, payload TEXT);
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT, product_name TEXT, status TEXT, updated_at TEXT, summary_json TEXT, source_urls_json TEXT
    );
  `);
  const productName = '康健长佑长期医疗保险（费率可调）';
  const officialUrl = 'https://official.test/kangjian-changyou-terms.pdf';
  db.prepare('INSERT INTO knowledge_records VALUES (1, ?, ?, ?, ?)').run(
    '新华保险',
    productName,
    officialUrl,
    JSON.stringify({
      evidenceLevel: 'insurer_official',
      title: '康健长佑长期医疗保险（费率可调）利益条款',
      pageText: '本保险提供一般医疗费用保险金，具体计算方法见利益条款第四款。',
    }),
  );
  db.prepare('INSERT INTO product_customer_responsibility_summaries VALUES (?, ?, ?, ?, ?, ?)').run(
    '新华保险',
    productName,
    'ready',
    '2026-07-13T00:00:00.000Z',
    JSON.stringify({ headline: '本保险提供长期医疗费用保障。' }),
    JSON.stringify([officialUrl]),
  );
  let officialFetchCount = 0;
  let requestBody;
  const knowledge = createAgentProductKnowledgeSearch({
    db,
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test' },
    officialDocumentFetchImpl: async (url) => {
      officialFetchCount += 1;
      assert.equal(url.href, officialUrl);
      return {
        ok: true,
        headers: { get: (name) => name === 'content-type' ? 'text/plain; charset=utf-8' : '' },
        async text() {
          return [
            '康健长佑长期医疗保险（费率可调）利益条款',
            '第四款 医疗费用保险金计算方法',
            '计划一的年度免赔额为1万元。',
            '计划二的年度免赔额为2万元。',
          ].join('\n');
        },
      };
    },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: '计划一年度免赔额为1万元，计划二为2万元【官方资料O1·第1页】。' } }] };
        },
      };
    },
  });

  const result = await knowledge.search({ question: '康健长佑的免赔额多少？', productName });
  const prompt = JSON.stringify(requestBody.messages);

  assert.equal(officialFetchCount, 1);
  assert.match(prompt, /计划一的年度免赔额为1万元/u);
  assert.match(prompt, /计划二的年度免赔额为2万元/u);
  assert.match(result.answer, /计划一年度免赔额为1万元/u);
  assert.match(result.answer, /计划二为2万元/u);
  assert.equal(result.sources[0].url, officialUrl);
  assert.equal(result.sources[0].verified, true);
  db.close();
});
