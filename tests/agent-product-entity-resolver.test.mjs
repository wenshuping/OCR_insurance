import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createAgentProductEntityResolver } from '../server/agent-product-entity-resolver.service.mjs';
import { getDefaultOfficialDomainProfiles } from '../server/c-policy-analysis.service.mjs';
import { listProductCatalogCompanies, searchProductCatalog } from '../server/product-catalog-search.mjs';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (company TEXT, product_name TEXT, payload TEXT NOT NULL);
    CREATE TABLE insurance_products (
      canonical_product_id TEXT,
      tenant_id TEXT,
      company TEXT,
      official_name TEXT,
      product_code TEXT,
      status TEXT,
      payload TEXT NOT NULL DEFAULT '{}'
    );
  `);
  return db;
}

function addPublicKnowledge(db, company, productName) {
  db.prepare('INSERT INTO knowledge_records (company, product_name, payload) VALUES (?, ?, ?)').run(
    company,
    productName,
    JSON.stringify({ sourceKind: 'insurer_official' }),
  );
}

function addProduct(db, {
  canonicalProductId = '',
  company,
  officialName,
  status = 'active',
  payload = {},
  tenantId = 'tenant-default',
  productCode = '',
}) {
  db.prepare(`
    INSERT INTO insurance_products (canonical_product_id, tenant_id, company, official_name, product_code, status, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(canonicalProductId, tenantId, company, officialName, productCode, status, JSON.stringify(payload));
}

const OFFICIAL_DOMAIN_PROFILES = getDefaultOfficialDomainProfiles();

test('resolves an insurer-scoped short product mention to the active canonical product', () => {
  const db = makeDb();
  try {
    const officialName = '新华人寿保险股份有限公司康健无忧两全保险';
    addPublicKnowledge(db, '新华保险', officialName);
    addProduct(db, {
      canonicalProductId: 'product-kjwy',
      company: '新华保险',
      officialName,
    });

    const resolver = createAgentProductEntityResolver({ db, officialDomainProfiles: OFFICIAL_DOMAIN_PROFILES });
    assert.deepEqual(resolver.resolve({
      mentions: [
        { type: 'insurer', rawText: '新华人寿保险股份有限公司' },
        { type: 'product', rawText: '康健无忧两全保险' },
      ],
    }), {
      status: 'resolved',
      entity: {
        canonicalProductId: 'product-kjwy',
        company: '新华保险',
        officialName,
        matchType: 'company_scoped_normalized',
        confidence: 1,
      },
      candidates: [],
    });
  } finally {
    db.close();
  }
});

test('does not resolve weak substring mentions even when the insurer has only one product', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-only',
      company: '新华保险',
      officialName: '新华人寿保险股份有限公司康健无忧两全保险',
    });
    const resolver = createAgentProductEntityResolver({
      db,
      officialDomainProfiles: OFFICIAL_DOMAIN_PROFILES,
    });

    for (const rawText of ['保险', '两全', '产品']) {
      const result = resolver.resolve({ mentions: [
        { type: 'insurer', rawText: '新华人寿保险股份有限公司' },
        { type: 'product', rawText },
      ] });
      assert.notEqual(result.status, 'resolved', rawText);
      assert.equal(result.entity, null, rawText);
    }
  } finally {
    db.close();
  }
});

test('does not collapse distinct insurer business lines during company normalization', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-pingan-life',
      company: '平安人寿',
      officialName: '平安人寿保险股份有限公司测试两全保险',
    });

    const result = createAgentProductEntityResolver({
      db,
      officialDomainProfiles: OFFICIAL_DOMAIN_PROFILES,
    }).resolve({
      mentions: [
        { type: 'insurer', rawText: '平安财产保险股份有限公司' },
        { type: 'product', rawText: '测试两全保险' },
      ],
    });

    assert.notEqual(result.status, 'resolved');
  } finally {
    db.close();
  }
});

test('returns ambiguity instead of choosing a shared short name across companies', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-a',
      company: '甲保险',
      officialName: '甲人寿保险股份有限公司康健无忧两全保险',
    });
    addProduct(db, {
      canonicalProductId: 'product-b',
      company: '乙保险',
      officialName: '乙人寿保险股份有限公司康健无忧两全保险',
    });

    const result = createAgentProductEntityResolver({ db }).resolve({
      mentions: [{ type: 'product', rawText: '康健无忧两全保险' }],
    });

    assert.equal(result.status, 'ambiguous');
    assert.equal(result.entity, null);
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(new Set(result.candidates.map((candidate) => candidate.canonicalProductId)), new Set(['product-a', 'product-b']));
  } finally {
    db.close();
  }
});

test('orders equal-confidence candidates by deterministic match precedence', () => {
  const db = makeDb();
  try {
    const productText = 'abcdefghijklmnopqrstuvwxy';
    addProduct(db, {
      canonicalProductId: 'product-normalized',
      company: '丙保险',
      officialName: `丙人寿保险股份有限公司${productText}`,
    });
    addProduct(db, {
      canonicalProductId: 'product-alias',
      company: '乙保险',
      officialName: '乙人寿保险股份有限公司另一款长期保险',
      payload: { aliases: [productText], aliasReviewStatus: 'approved' },
    });
    addProduct(db, {
      canonicalProductId: 'product-fuzzy',
      company: '丁保险',
      officialName: 'nopqrstuvwxyabcdefghijklm',
    });
    addProduct(db, {
      canonicalProductId: 'product-exact',
      company: '甲保险',
      officialName: productText,
    });

    const result = createAgentProductEntityResolver({ db }).resolve({
      mentions: [{ type: 'product', rawText: productText }],
    });

    assert.equal(result.status, 'ambiguous');
    assert.deepEqual(result.candidates.map((candidate) => candidate.matchType), [
      'exact_official_name',
      'approved_alias',
      'company_scoped_normalized',
      'unique_high_confidence',
    ]);
    assert.equal(result.candidates.slice(0, 3).every((candidate) => candidate.confidence === 1), true);
    assert.ok(result.candidates[3].confidence < 0.9);
  } finally {
    db.close();
  }
});

test('reuses only the bounded fields of an already confirmed active product', () => {
  const db = makeDb();
  try {
    const resolver = createAgentProductEntityResolver({ db });
    assert.deepEqual(resolver.resolve({
      activeProduct: {
        canonicalProductId: ' product-current ',
        company: ' 新华保险 ',
        officialName: ' 康健无忧两全保险 ',
        matchType: 'exact_official_name',
        confidence: 1,
        secret: 'must-not-leak',
      },
    }), {
      status: 'resolved',
      entity: {
        canonicalProductId: 'product-current',
        company: '新华保险',
        officialName: '康健无忧两全保险',
        matchType: 'exact_official_name',
        confidence: 1,
      },
      candidates: [],
    });
    assert.deepEqual(resolver.resolve(), { status: 'missing', entity: null, candidates: [] });
  } finally {
    db.close();
  }
});

test('reuses an active product only when an explicit insurer resolves to the same company', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-current',
      company: '新华保险',
      officialName: '新华人寿保险股份有限公司康健无忧两全保险',
    });
    addProduct(db, {
      canonicalProductId: 'product-other',
      company: '甲保险',
      officialName: '甲人寿保险股份有限公司其他保险',
    });
    const resolver = createAgentProductEntityResolver({ db, officialDomainProfiles: OFFICIAL_DOMAIN_PROFILES });
    const activeProduct = {
      canonicalProductId: 'product-current',
      company: '新华保险',
      officialName: '新华人寿保险股份有限公司康健无忧两全保险',
      matchType: 'company_scoped_normalized',
      confidence: 1,
    };

    assert.equal(resolver.resolve({
      mentions: [{ type: 'insurer', rawText: '新华人寿保险股份有限公司' }],
      activeProduct,
    }).status, 'resolved');
    assert.deepEqual(resolver.resolve({
      mentions: [{ type: 'insurer', rawText: '甲保险' }],
      activeProduct,
    }), { status: 'not_found', entity: null, candidates: [] });
    assert.deepEqual(resolver.resolve({
      mentions: [{ type: 'insurer', rawText: '不存在保险公司' }],
      activeProduct,
    }), { status: 'not_found', entity: null, candidates: [] });
  } finally {
    db.close();
  }
});

test('returns not_found for unresolved explicit insurers and unmatched products', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-kjwy',
      company: '新华保险',
      officialName: '新华人寿保险股份有限公司康健无忧两全保险',
    });
    const resolver = createAgentProductEntityResolver({ db, officialDomainProfiles: OFFICIAL_DOMAIN_PROFILES });

    assert.deepEqual(resolver.resolve({ mentions: [
      { type: 'insurer', rawText: '不存在保险公司' },
      { type: 'product', rawText: '康健无忧两全保险' },
    ] }), { status: 'not_found', entity: null, candidates: [] });
    assert.deepEqual(resolver.resolve({
      mentions: [{ type: 'product', rawText: '完全不存在的产品' }],
    }), { status: 'not_found', entity: null, candidates: [] });
  } finally {
    db.close();
  }
});

test('keeps high-overlap character recall below the execution threshold', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-overlap',
      company: '测试保险',
      officialName: 'nopqrstuvwxyabcdefghijklm',
    });

    const result = createAgentProductEntityResolver({ db }).resolve({
      mentions: [{ type: 'product', rawText: 'abcdefghijklmnopqrstuvwxy' }],
    });

    assert.notEqual(result.status, 'resolved');
    assert.ok(result.candidates[0].confidence < 0.9);
    assert.equal(result.candidates[0].matchType, 'unique_high_confidence');
  } finally {
    db.close();
  }
});

test('fails closed when duplicate tenant products disagree on canonical id', () => {
  const db = makeDb();
  try {
    const officialName = '新华人寿保险股份有限公司康健无忧两全保险';
    addProduct(db, {
      canonicalProductId: 'product-tenant-a',
      tenantId: 'tenant-a',
      company: '新华保险',
      officialName,
    });
    addProduct(db, {
      canonicalProductId: 'product-tenant-b',
      tenantId: 'tenant-b',
      company: '新华保险',
      officialName,
    });

    const result = createAgentProductEntityResolver({ db }).resolve({
      mentions: [{ type: 'product', rawText: officialName }],
    });

    assert.equal(result.status, 'ambiguous');
    assert.equal(result.entity, null);
    assert.equal(result.candidates[0].canonicalProductId, '');
    assert.ok(result.candidates[0].confidence < 0.9);
    assert.deepEqual(
      createAgentProductEntityResolver({ db }).resolveAllFromText({ question: `${officialName}主要保什么` })
        .entities.map((item) => item.canonicalProductId),
      ['product-tenant-a', 'product-tenant-b'],
    );
  } finally {
    db.close();
  }
});

test('public catalog excludes sources missing visibility columns instead of throwing', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE knowledge_records (company TEXT, product_name TEXT);
      CREATE TABLE product_customer_responsibility_summaries (company TEXT, product_name TEXT);
      CREATE TABLE insurance_products (
        canonical_product_id TEXT,
        company TEXT,
        official_name TEXT,
        payload TEXT
      );
    `);
    db.prepare('INSERT INTO knowledge_records (company, product_name) VALUES (?, ?)').run('甲保险', '缺少公开载荷保险');
    db.prepare('INSERT INTO product_customer_responsibility_summaries (company, product_name) VALUES (?, ?)').run('乙保险', '缺少状态保险');
    db.prepare('INSERT INTO insurance_products (canonical_product_id, company, official_name, payload) VALUES (?, ?, ?, ?)').run(
      'product-no-status',
      '丙保险',
      '缺少产品状态保险',
      JSON.stringify({ aliases: ['无状态别名'], aliasReviewStatus: 'approved' }),
    );

    assert.deepEqual(searchProductCatalog({ db, query: '保险', visibility: 'public' }), []);
    assert.deepEqual(listProductCatalogCompanies({ db, visibility: 'public' }), []);
    assert.deepEqual(createAgentProductEntityResolver({ db }).resolve({
      mentions: [{ type: 'product', rawText: '无状态别名' }],
    }), { status: 'not_found', entity: null, candidates: [] });
  } finally {
    db.close();
  }
});

test('public catalog excludes product documents when review status is unavailable', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE product_documents (
        source_authority TEXT,
        payload TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO product_documents (source_authority, payload) VALUES (?, ?)').run(
      'company_material',
      JSON.stringify({ company: '未审核保险', productNames: ['未审核文档保险'] }),
    );

    assert.deepEqual(searchProductCatalog({ db, query: '未审核文档保险', visibility: 'public' }), []);
    assert.deepEqual(listProductCatalogCompanies({ db, visibility: 'public' }), []);
  } finally {
    db.close();
  }
});

test('does not invent a canonical id when only public knowledge has the product', () => {
  const db = makeDb();
  try {
    addPublicKnowledge(db, '新华保险', '新华人寿保险股份有限公司康健无忧两全保险');
    const result = createAgentProductEntityResolver({ db }).resolve({
      mentions: [{ type: 'product', rawText: '康健无忧两全保险' }],
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.entity.canonicalProductId, '');
    assert.equal(result.entity.officialName, '新华人寿保险股份有限公司康健无忧两全保险');
  } finally {
    db.close();
  }
});

test('accepts only explicitly approved product aliases', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-approved',
      company: '新华保险',
      officialName: '新华人寿保险股份有限公司康健无忧两全保险',
      payload: { aliases: ['康无忧'], aliasReviewStatus: 'approved' },
    });
    addProduct(db, {
      canonicalProductId: 'product-pending',
      company: '新华保险',
      officialName: '新华人寿保险股份有限公司医药无忧医疗保险',
      payload: { aliases: ['医无忧'], aliasReviewStatus: 'pending' },
    });
    const resolver = createAgentProductEntityResolver({ db });

    const approved = resolver.resolve({ mentions: [{ type: 'product', rawText: '康无忧' }] });
    assert.equal(approved.status, 'resolved');
    assert.equal(approved.entity.canonicalProductId, 'product-approved');
    assert.equal(approved.entity.matchType, 'approved_alias');
    assert.equal(approved.entity.confidence, 1);
    const pending = resolver.resolve({ mentions: [{ type: 'product', rawText: '医无忧' }] });
    assert.notEqual(pending.status, 'resolved');
    assert.equal(pending.candidates.some((candidate) => candidate.matchType === 'approved_alias'), false);
  } finally {
    db.close();
  }
});

test('resolves exact active filing names and controlled product identifiers', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-filing',
      company: '甲保险',
      officialName: '甲保险正式产品',
      productCode: 'PRD-001',
      payload: {
        filingName: '甲保险备案产品',
        filingNames: ['甲保险历史备案产品'],
        clauseCode: 'CLAUSE-001',
        arbitraryCode: 'MUST-NOT-MATCH',
      },
    });
    const resolver = createAgentProductEntityResolver({ db });

    for (const rawText of ['甲保险备案产品', '甲保险历史备案产品', 'PRD-001', 'CLAUSE-001']) {
      const result = resolver.resolve({ mentions: [{ type: 'product', rawText }] });
      assert.equal(result.status, 'resolved', rawText);
      assert.equal(result.entity.canonicalProductId, 'product-filing', rawText);
      assert.equal(result.entity.matchType, 'filing_name', rawText);
      assert.equal(result.entity.confidence, 1, rawText);
    }
    assert.deepEqual(resolver.resolve({ mentions: [{ type: 'product', rawText: 'MUST-NOT-MATCH' }] }), {
      status: 'not_found', entity: null, candidates: [],
    });
    assert.notEqual(
      resolver.resolve({ mentions: [{ type: 'product', rawText: 'PRD-00' }] }).status,
      'resolved',
    );
  } finally {
    db.close();
  }
});

test('filing identifiers require insurer scope when shared and exclude inactive rows', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-a', company: '甲保险', officialName: '甲保险甲产品', productCode: 'SHARED-01',
    });
    addProduct(db, {
      canonicalProductId: 'product-b', company: '乙保险', officialName: '乙保险乙产品', productCode: 'SHARED-01',
    });
    addProduct(db, {
      canonicalProductId: 'product-disabled', company: '丙保险', officialName: '丙保险停用产品',
      status: 'disabled', productCode: 'DISABLED-01', payload: { filingName: '停用备案产品' },
    });
    const resolver = createAgentProductEntityResolver({ db });

    const ambiguous = resolver.resolve({ mentions: [{ type: 'product', rawText: 'SHARED-01' }] });
    assert.equal(ambiguous.status, 'ambiguous');
    assert.deepEqual(
      new Set(ambiguous.candidates.map((candidate) => candidate.canonicalProductId)),
      new Set(['product-a', 'product-b']),
    );
    const scoped = resolver.resolve({ mentions: [
      { type: 'insurer', rawText: '甲保险' },
      { type: 'product', rawText: 'SHARED-01' },
    ] });
    assert.equal(scoped.status, 'resolved');
    assert.equal(scoped.entity.canonicalProductId, 'product-a');
    for (const rawText of ['DISABLED-01', '停用备案产品']) {
      const inactive = resolver.resolve({ mentions: [{ type: 'product', rawText }] });
      assert.notEqual(inactive.status, 'resolved');
      assert.equal(inactive.entity, null);
      assert.equal(inactive.candidates.some((candidate) => candidate.canonicalProductId === 'product-disabled'), false);
    }
  } finally {
    db.close();
  }
});

test('duplicate tenant filing identifiers fail closed when canonical ids disagree', () => {
  const db = makeDb();
  try {
    for (const [tenantId, canonicalProductId] of [['tenant-a', 'product-a'], ['tenant-b', 'product-b']]) {
      addProduct(db, {
        tenantId,
        canonicalProductId,
        company: '甲保险',
        officialName: '甲保险正式产品',
        productCode: 'TENANT-CONFLICT-01',
      });
    }
    const result = createAgentProductEntityResolver({ db }).resolve({ mentions: [
      { type: 'insurer', rawText: '甲保险' },
      { type: 'product', rawText: 'TENANT-CONFLICT-01' },
    ] });

    assert.equal(result.status, 'ambiguous');
    assert.equal(result.entity, null);
    assert.deepEqual(
      new Set(result.candidates.map((candidate) => candidate.canonicalProductId)),
      new Set(['product-a', 'product-b']),
    );
  } finally {
    db.close();
  }
});

test('reverse catalog scan finds only controlled canonical product evidence', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-a',
      company: '甲保险',
      officialName: '甲人寿保险股份有限公司和美年金保险',
      payload: { aliases: ['和美', '保险'], aliasReviewStatus: 'approved' },
    });
    addProduct(db, {
      canonicalProductId: 'product-b',
      company: '乙保险',
      officialName: '乙人寿保险股份有限公司同心医疗保险',
      payload: {
        aliases: ['同心', '产品'], aliasReviewStatus: 'approved', filingName: '同心医疗保险备案款',
      },
    });
    addProduct(db, {
      canonicalProductId: 'product-inactive',
      company: '丙保险',
      officialName: '丙人寿保险股份有限公司停用医疗保险',
      status: 'disabled',
      payload: { filingName: '停用医疗保险备案款' },
    });
    const resolver = createAgentProductEntityResolver({ db });

    const aliases = resolver.resolveAllFromText({ question: '和美搭着同心哪个好' });
    assert.equal(aliases.overflow, false);
    assert.deepEqual(new Set(aliases.entities.map((item) => item.canonicalProductId)), new Set(['product-a', 'product-b']));
    assert.deepEqual(resolver.resolveAllFromText({
      question: '甲人寿保险股份有限公司和美年金保险与同心医疗保险备案款比较',
    }).entities.map((item) => item.canonicalProductId).sort(), ['product-a', 'product-b']);
    assert.deepEqual(resolver.resolveAllFromText({ question: '停用医疗保险备案款主要保什么' }), {
      entities: [], overflow: false,
    });

    for (const question of [
      '这个保险产品的责任和免责是什么',
      '两全保险主要保什么',
      '等待期、续保和赔付比例',
    ]) {
      assert.deepEqual(resolver.resolveAllFromText({ question }), { entities: [], overflow: false });
    }
  } finally {
    db.close();
  }
});

test('reverse catalog scan keeps the longest contained product term but retains separate mentions', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-base',
      company: '甲保险',
      officialName: '甲保险康健无忧保险',
      payload: { aliases: ['康健无忧'], aliasReviewStatus: 'approved' },
    });
    addProduct(db, {
      canonicalProductId: 'product-plus',
      company: '甲保险',
      officialName: '甲保险康健无忧加强版保险',
      payload: { aliases: ['康健无忧加强版'], aliasReviewStatus: 'approved' },
    });
    const resolver = createAgentProductEntityResolver({ db });

    assert.deepEqual(
      resolver.resolveAllFromText({ question: '康健无忧加强版主要保什么' }).entities
        .map((item) => item.canonicalProductId),
      ['product-plus'],
    );
    assert.deepEqual(
      resolver.resolveAllFromText({ question: '康健无忧和康健无忧加强版有什么区别' }).entities
        .map((item) => item.canonicalProductId),
      ['product-base', 'product-plus'],
    );
  } finally {
    db.close();
  }
});

test('reverse catalog scan uses a unique insurer only to disambiguate a shared occurrence', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-a',
      company: '甲保险',
      officialName: '甲保险和美年金保险',
      payload: { aliases: ['和美'], aliasReviewStatus: 'approved' },
    });
    addProduct(db, {
      canonicalProductId: 'product-b',
      company: '乙保险',
      officialName: '乙保险和美医疗保险',
      payload: { aliases: ['和美'], aliasReviewStatus: 'approved' },
    });
    const resolver = createAgentProductEntityResolver({
      db,
      officialDomainProfiles: [
        { company: '甲保险', aliases: ['共同保司'] },
        { company: '乙保险', aliases: ['共同保司'] },
      ],
    });

    assert.deepEqual(resolver.resolveAllFromText({
      question: '和美主要保什么',
      insurerMentions: [{ type: 'insurer', rawText: '甲保险' }],
    }).entities.map((item) => item.canonicalProductId), ['product-a']);
    assert.deepEqual(resolver.resolveAllFromText({ question: '甲保险的和美主要保什么' })
      .entities.map((item) => item.canonicalProductId), ['product-a']);
    assert.deepEqual(new Set(resolver.resolveAllFromText({ question: '和美主要保什么' })
      .entities.map((item) => item.canonicalProductId)), new Set(['product-a', 'product-b']));
    assert.deepEqual(new Set(resolver.resolveAllFromText({ question: '甲保险和乙保险的和美哪个好' })
      .entities.map((item) => item.canonicalProductId)), new Set(['product-a', 'product-b']));
    for (const insurer of ['未知保险', '共同保司']) {
      assert.deepEqual(resolver.resolveAllFromText({
        question: '和美主要保什么',
        insurerMentions: [{ type: 'insurer', rawText: insurer }],
      }), { entities: [], overflow: false, invalid: true, status: 'invalid_insurer' });
    }
  } finally {
    db.close();
  }
});

test('reverse catalog scan retains distinct products across insurer boundaries', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-a',
      company: '甲保险',
      officialName: '甲保险甲保障计划',
      payload: { aliases: ['甲计划'], aliasReviewStatus: 'approved' },
    });
    addProduct(db, {
      canonicalProductId: 'product-b',
      company: '乙保险',
      officialName: '乙保险乙保障计划',
      payload: { aliases: ['乙计划'], aliasReviewStatus: 'approved' },
    });
    const resolver = createAgentProductEntityResolver({ db });
    const question = '甲保险甲计划和乙保险乙计划主要保什么';

    for (const insurerMentions of [
      [{ type: 'insurer', rawText: '甲保险' }],
      [{ type: 'insurer', rawText: '甲保险' }, { type: 'insurer', rawText: '乙保险' }],
    ]) {
      assert.deepEqual(resolver.resolveAllFromText({ question, insurerMentions })
        .entities.map((item) => item.canonicalProductId), ['product-a', 'product-b']);
    }
    assert.deepEqual(resolver.resolveAllFromText({
      question: '甲计划和乙计划主要保什么',
      insurerMentions: [{ type: 'insurer', rawText: '甲保险' }],
    }).entities.map((item) => item.canonicalProductId), ['product-a', 'product-b']);
  } finally {
    db.close();
  }
});

test('does not resolve disabled or non-public catalog rows', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-disabled',
      company: '新华保险',
      officialName: '新华人寿保险股份有限公司停用保险',
      status: 'disabled',
      payload: { aliases: ['停用险'], aliasReviewStatus: 'approved' },
    });
    addPublicKnowledge(db, '新华保险', '外部参考保险');
    db.prepare('UPDATE knowledge_records SET payload = ? WHERE product_name = ?').run(
      JSON.stringify({ sourceKind: 'open_web_reference', materialType: 'external_reference' }),
      '外部参考保险',
    );
    const resolver = createAgentProductEntityResolver({ db });

    assert.deepEqual(resolver.resolve({ mentions: [{ type: 'product', rawText: '停用险' }] }), {
      status: 'not_found', entity: null, candidates: [],
    });
    assert.deepEqual(resolver.resolve({ mentions: [{ type: 'product', rawText: '外部参考保险' }] }), {
      status: 'not_found', entity: null, candidates: [],
    });
  } finally {
    db.close();
  }
});

test('requires a database', () => {
  assert.throws(() => createAgentProductEntityResolver(), TypeError);
});
