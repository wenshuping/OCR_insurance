import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  createAgentProductEntityResolver as createResolverService,
  resolveAgentProductWithResponsibilityMatch,
} from '../server/agent-product-entity-resolver.service.mjs';
import { createAgentSemanticResolver } from '../server/agent-semantic-resolver.service.mjs';
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
    CREATE TABLE product_customer_responsibility_summaries (
      company TEXT,
      product_name TEXT,
      status TEXT,
      updated_at TEXT
    );
  `);
  return db;
}

function addReadySummary(db, company, productName) {
  db.prepare(`
    INSERT INTO product_customer_responsibility_summaries (company, product_name, status, updated_at)
    VALUES (?, ?, 'ready', '2026-07-14T00:00:00.000Z')
  `).run(company, productName);
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

function createAgentProductEntityResolver(options = {}) {
  return createResolverService({ tenantId: 'tenant-default', ...options });
}

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

test('revalidates an active product against the current tenant active catalog', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-current', company: '新华保险', officialName: '康健无忧两全保险',
    });
    const resolver = createAgentProductEntityResolver({
      db,
      officialDomainProfiles: OFFICIAL_DOMAIN_PROFILES,
    });
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
    assert.deepEqual(resolver.resolve({
      activeProduct: { company: '新华保险', officialName: '康健无忧两全保险' },
    }), { status: 'missing', entity: null, candidates: [] });
    assert.deepEqual(resolver.resolve(), { status: 'missing', entity: null, candidates: [] });
    db.prepare("UPDATE insurance_products SET status = 'inactive' WHERE canonical_product_id = 'product-current'").run();
    assert.deepEqual(resolver.resolve({ activeProduct: {
      canonicalProductId: 'product-current', company: '新华保险', officialName: '康健无忧两全保险',
    } }), { status: 'not_found', entity: null, candidates: [] });
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

test('online fallback reuses responsibility assistant matching and excludes rejected local candidates', async () => {
  const localCandidate = {
    canonicalProductId: 'local-product',
    company: '新华保险',
    officialName: '康健华尊医疗保险（本地候选）',
    matchType: 'unique_high_confidence',
    confidence: 0.8,
  };
  const calls = [];
  const result = await resolveAgentProductWithResponsibilityMatch({
    localResolver: {
      resolve() {
        return { status: 'ambiguous', entity: null, candidates: [localCandidate] };
      },
    },
    matchResponsibilityProducts: async (input) => {
      calls.push(input);
      return {
        status: 'candidates',
        matches: [
          { company: localCandidate.company, productName: localCandidate.officialName },
          { company: '新华保险', productName: '新华人寿保险股份有限公司康健华尊医疗保险' },
        ],
      };
    },
    input: {
      mentions: [
        { type: 'insurer', rawText: '新华保险' },
        { type: 'product', rawText: '康健华尊' },
      ],
      allowOnline: true,
    },
  });

  assert.deepEqual(calls, [{
    company: '新华保险', name: '康健华尊', limit: 8, minScore: 0.1, includeOnline: true,
  }]);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].officialName, '新华人寿保险股份有限公司康健华尊医疗保险');
});

test('online fallback excludes server-recorded rejected candidates even when local matching changes', async () => {
  const rejected = {
    canonicalProductId: 'local-a',
    company: '中国人寿',
    officialName: '国寿金彩明天两全保险（A款）（分红型）',
  };
  const result = await resolveAgentProductWithResponsibilityMatch({
    localResolver: {
      resolve() { return { status: 'not_found', entity: null, candidates: [] }; },
    },
    matchResponsibilityProducts: async () => ({
      status: 'candidates',
      matches: [
        { company: '中国人寿保险股份有限公司', productName: rejected.officialName },
        { company: '中国人寿保险股份有限公司', productName: '国寿潇洒明天两全保险（分红型）' },
      ],
    }),
    input: {
      mentions: [{ type: 'product', rawText: '潇洒明天' }],
      allowOnline: true,
      rejectedProductCandidates: [rejected],
    },
  });

  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.candidates.map((candidate) => candidate.officialName), [
    '国寿潇洒明天两全保险（分红型）',
  ]);
});

test('online fallback returns not found when search only repeats every rejected candidate', async () => {
  const rejectedProductCandidates = [
    {
      canonicalProductId: 'local-a', company: '中国人寿',
      officialName: '国寿金彩明天两全保险（A款）（分红型）',
    },
    {
      canonicalProductId: 'local-b', company: '中国人寿',
      officialName: '国寿金彩明天两全保险（B款）（分红型）',
    },
  ];
  const result = await resolveAgentProductWithResponsibilityMatch({
    localResolver: {
      resolve() { return { status: 'not_found', entity: null, candidates: [] }; },
    },
    matchResponsibilityProducts: async () => ({
      status: 'candidates',
      matches: rejectedProductCandidates.map((candidate) => ({
        company: '中国人寿保险股份有限公司', productName: candidate.officialName,
      })),
    }),
    input: {
      mentions: [{ type: 'product', rawText: '潇洒明天' }],
      allowOnline: true,
      rejectedProductCandidates,
    },
  });

  assert.deepEqual(result, { status: 'not_found', entity: null, candidates: [] });
});

test('initial local miss offers online search without starting it, then searches without an insurer', async () => {
  const calls = [];
  const localResolver = {
    resolve() { return { status: 'not_found', entity: null, candidates: [] }; },
  };
  const matchResponsibilityProducts = async (input) => {
    calls.push(input);
    return {
      status: 'candidates',
      matches: [{ company: '联合承保机构', productName: '西湖益联保', needsConfirmation: true }],
    };
  };
  const input = { mentions: [{ type: 'product', rawText: '西湖益联保' }] };

  const local = await resolveAgentProductWithResponsibilityMatch({
    localResolver, matchResponsibilityProducts, input,
  });
  assert.deepEqual(local, { status: 'ambiguous', entity: null, candidates: [] });
  assert.equal(calls.length, 0);

  const online = await resolveAgentProductWithResponsibilityMatch({
    localResolver,
    matchResponsibilityProducts,
    input: { ...input, allowOnline: true },
  });
  assert.equal(online.status, 'ambiguous');
  assert.equal(online.candidates[0].officialName, '西湖益联保');
  assert.deepEqual(calls, [{
    company: '', name: '西湖益联保', limit: 8, minScore: 0.1, includeOnline: true,
  }]);
});

test('a confirmed online responsibility candidate resolves to a canonical product', async () => {
  const officialName = '新华人寿保险股份有限公司康健华尊医疗保险';
  const result = await resolveAgentProductWithResponsibilityMatch({
    localResolver: { resolve() { return { status: 'not_found', entity: null, candidates: [] }; } },
    matchResponsibilityProducts: async () => ({
      status: 'candidates',
      matches: [{ company: '新华保险', productName: officialName, needsConfirmation: true }],
    }),
    input: {
      mentions: [
        { type: 'insurer', rawText: '新华保险' },
        { type: 'product', rawText: '康健华尊' },
      ],
      confirmedCandidate: { company: '新华保险', officialName },
    },
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.entity.matchType, 'confirmed_candidate');
  assert.equal(result.entity.officialName, officialName);
  assert.match(result.entity.canonicalProductId, /^product_/u);
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

test('same official product in another tenant does not create a canonical conflict', () => {
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

    const resolver = createResolverService({ db, tenantId: 'tenant-a' });
    const result = resolver.resolve({
      mentions: [{ type: 'product', rawText: officialName }],
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.entity.canonicalProductId, 'product-tenant-a');
    assert.deepEqual(
      resolver.resolveAllFromText({ question: `${officialName}主要保什么` })
        .entities.map((item) => item.canonicalProductId),
      ['product-tenant-a'],
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

test('offers an official public knowledge product when the canonical catalog has not been backfilled', () => {
  const db = makeDb();
  try {
    const officialName = '新华人寿保险股份有限公司康健无忧两全保险';
    addPublicKnowledge(db, '新华保险', officialName);
    addPublicKnowledge(db, '新华保险', '新华人寿保险股份有限公司康健无忧重大疾病保险');
    addPublicKnowledge(db, '新华保险', '新华人寿保险股份有限公司康健长佑医疗保险');
    const resolver = createAgentProductEntityResolver({ db });
    const result = resolver.resolve({
      mentions: [{ type: 'product', rawText: '康健无忧两全保险' }],
    });

    assert.equal(result.status, 'ambiguous');
    assert.equal(result.entity, null);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].company, '新华保险');
    assert.equal(result.candidates[0].officialName, officialName);
    assert.match(result.candidates[0].canonicalProductId, /^product_[a-f0-9]{16}$/u);

    const confirmed = resolver.resolve({
      mentions: [{ type: 'product', rawText: officialName }],
      confirmedCandidate: result.candidates[0],
    });
    assert.equal(confirmed.status, 'resolved');
    assert.equal(confirmed.entity.officialName, officialName);
    assert.equal(confirmed.entity.matchType, 'confirmed_candidate');
    assert.equal(confirmed.entity.confidence, 1);
  } finally {
    db.close();
  }
});

test('narrows a dominant shorthand public-catalog match to one explicit confirmation choice', () => {
  const db = makeDb();
  try {
    const officialName = '新华人寿保险股份有限公司寰宇尊悦高端医疗保险';
    addPublicKnowledge(db, '新华保险', officialName);
    addPublicKnowledge(db, '农银人寿', '农银寰宇至尊高端医疗保险');
    addPublicKnowledge(db, '民生人寿', '民生尊悦人生定期寿险');
    addPublicKnowledge(db, '泰康人寿', '泰康尊悦人生年金保险');

    const resolver = createAgentProductEntityResolver({
      db,
      officialDomainProfiles: OFFICIAL_DOMAIN_PROFILES,
    });
    const result = resolver.resolve({
      mentions: [{ type: 'product', rawText: '寰宇尊悦' }],
    });

    assert.equal(result.status, 'ambiguous');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].officialName, officialName);

    const confirmed = resolver.resolve({
      mentions: [{ type: 'product', rawText: result.candidates[0].officialName }],
      confirmedCandidate: result.candidates[0],
    });
    assert.equal(confirmed.status, 'resolved');
    assert.equal(confirmed.entity.matchType, 'confirmed_candidate');
    assert.equal(confirmed.entity.confidence, 1);
  } finally {
    db.close();
  }
});

test('a numbered shorthand confirmation crosses the semantic boundary as a resolved product', async () => {
  const db = makeDb();
  try {
    const officialName = '新华人寿保险股份有限公司寰宇尊悦高端医疗保险';
    addPublicKnowledge(db, '新华保险', officialName);
    addPublicKnowledge(db, '农银人寿', '农银寰宇至尊高端医疗保险');
    const productResolver = createAgentProductEntityResolver({
      db,
      officialDomainProfiles: OFFICIAL_DOMAIN_PROFILES,
    });
    const semanticResolver = createAgentSemanticResolver({
      productResolver,
      familyResolver: { resolve: async () => ({ status: 'not_found', entity: null, candidates: [] }) },
      clock: () => 1_800_000_000_000,
    });
    const first = await semanticResolver.resolve({
      internalUserId: 7,
      question: '寰宇尊悦',
      runtime: 'hermes',
      proposal: {
        semanticContractVersion: 1,
        intent: 'insurance_product_knowledge',
        operation: 'read',
        queryAspects: ['main_responsibilities'],
        mentions: [{ type: 'product', rawText: '寰宇尊悦' }],
        references: [],
        requestedSteps: ['lookup'],
        confidence: { intent: 1, mentions: 1, references: 1 },
      },
    });
    assert.equal(first.decision, 'clarify');
    assert.equal(first.nextTaskState.candidateSets.product.length, 1);

    const selected = await semanticResolver.resolve({
      internalUserId: 7,
      question: '1',
      runtime: 'rule',
      proposal: null,
      context: { taskState: first.nextTaskState },
    });
    assert.equal(selected.decision, 'execute');
    assert.equal(selected.resolvedEntities.product.officialName, officialName);
    assert.equal(selected.resolvedEntities.product.matchType, 'confirmed_candidate');
    assert.deepEqual(selected.proposal.queryAspects, ['main_responsibilities']);
  } finally {
    db.close();
  }
});

test('offers a public catalog match backed by a draft canonical product for explicit confirmation', () => {
  const db = makeDb();
  try {
    const officialName = '医药安欣（易核版）医疗保险';
    addProduct(db, {
      canonicalProductId: 'product-medical-anxin',
      company: '新华保险',
      officialName,
      status: 'draft',
    });
    addProduct(db, {
      canonicalProductId: 'product-private-draft',
      company: '新华保险',
      officialName: '未公开草稿保险',
      status: 'draft',
    });
    const resolver = createAgentProductEntityResolver({ db });

    assert.deepEqual(resolver.resolve({
      mentions: [{ type: 'product', rawText: '未公开草稿保险' }],
    }), { status: 'not_found', entity: null, candidates: [] });

    addPublicKnowledge(db, '新华保险', officialName);
    const result = resolver.resolve({
      mentions: [{ type: 'product', rawText: '医药安欣' }],
    });

    assert.equal(result.status, 'ambiguous');
    assert.equal(result.entity, null);
    assert.deepEqual(result.candidates, [{
      canonicalProductId: 'product-medical-anxin',
      company: '新华保险',
      officialName,
      matchType: 'unique_high_confidence',
      confidence: 0.793,
    }]);

    const confirmed = resolver.resolve({
      mentions: [
        { type: 'insurer', rawText: '新华保险' },
        { type: 'product', rawText: officialName },
      ],
      confirmedCandidate: {
        ...result.candidates[0],
        canonicalProductId: 'untrusted-stored-id',
      },
    });
    assert.equal(confirmed.status, 'resolved');
    assert.equal(confirmed.entity.canonicalProductId, 'product-medical-anxin');
    assert.equal(confirmed.entity.officialName, officialName);
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
      status: ' ACTIVE ',
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
    for (const rawText of ['PRD001', 'CLAUSE001']) {
      assert.notEqual(resolver.resolve({ mentions: [{ type: 'product', rawText }] }).status, 'resolved');
    }
  } finally {
    db.close();
  }
});

test('identifier matching preserves punctuation and ignores malformed payload identity fields', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-code', company: '甲保险', officialName: '甲保险代码产品',
      productCode: 'ABC-(01)',
      payload: {
        filingName: 123,
        filingNames: ['合法备案名', false],
        clauseCode: { value: 'OBJECT-01' },
      },
    });
    const resolver = createAgentProductEntityResolver({ db });
    assert.equal(resolver.resolve({ mentions: [{ type: 'product', rawText: 'abc-(01)' }] }).status, 'resolved');
    for (const rawText of ['ABC01', '合法备案名', '123', 'OBJECT-01']) {
      assert.notEqual(resolver.resolve({ mentions: [{ type: 'product', rawText }] }).status, 'resolved');
    }
  } finally {
    db.close();
  }
});

test('product resolution is isolated to the configured tenant', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      tenantId: 'tenant-default', canonicalProductId: 'shared-canonical', company: '甲保险',
      officialName: '甲保险默认产品', productCode: 'DEFAULT-01',
    });
    addProduct(db, {
      tenantId: 'tenant-other', canonicalProductId: 'shared-canonical', company: '乙保险',
      officialName: '乙保险其他产品', productCode: 'OTHER-01', payload: { filingName: '其他租户备案名' },
    });
    const resolver = createAgentProductEntityResolver({ db });
    assert.equal(resolver.resolve({ mentions: [{ type: 'product', rawText: 'DEFAULT-01' }] }).status, 'resolved');
    for (const rawText of ['OTHER-01', '其他租户备案名', '乙保险其他产品']) {
      const result = resolver.resolve({ mentions: [{ type: 'product', rawText }] });
      assert.notEqual(result.status, 'resolved');
      assert.equal(result.candidates.some((candidate) => candidate.company === '乙保险'), false);
    }
    assert.deepEqual(resolver.resolveAllFromText({ question: '其他租户备案名主要保什么' }), {
      entities: [], overflow: false,
    });
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
    addProduct(db, {
      canonicalProductId: 'product-archived', company: '丙保险', officialName: '丙保险归档产品',
      status: 'archived', productCode: 'ARCHIVED-01', payload: { clauseCode: 'ARCHIVED-CLAUSE-01' },
    });
    addProduct(db, {
      canonicalProductId: 'product-unknown', company: '丙保险', officialName: '丙保险未知产品',
      status: 'unknown', payload: { filingName: '未知状态备案产品' },
    });
    addProduct(db, {
      canonicalProductId: 'product-blank', company: '丙保险', officialName: '丙保险空状态产品',
      status: '', productCode: 'BLANK-01', payload: { clauseCode: 'BLANK-CLAUSE-01' },
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
    for (const rawText of [
      'DISABLED-01', '停用备案产品',
      'ARCHIVED-01', 'ARCHIVED-CLAUSE-01',
      '未知状态备案产品', 'BLANK-01', 'BLANK-CLAUSE-01',
    ]) {
      const inactive = resolver.resolve({ mentions: [{ type: 'product', rawText }] });
      assert.notEqual(inactive.status, 'resolved');
      assert.equal(inactive.entity, null);
      assert.equal(inactive.candidates.some((candidate) => (
        ['product-disabled', 'product-archived', 'product-unknown', 'product-blank']
          .includes(candidate.canonicalProductId)
      )), false);
    }
  } finally {
    db.close();
  }
});

test('same filing identifier in another tenant stays isolated', () => {
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
    const result = createResolverService({ db, tenantId: 'tenant-a' }).resolve({ mentions: [
      { type: 'insurer', rawText: '甲保险' },
      { type: 'product', rawText: 'TENANT-CONFLICT-01' },
    ] });

    assert.equal(result.status, 'resolved');
    assert.equal(result.entity.canonicalProductId, 'product-a');
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

test('reverse catalog scan resolves unique short names in a natural two-product comparison', () => {
  const db = makeDb();
  try {
    addProduct(db, {
      canonicalProductId: 'product-medical-anxin',
      company: '新华保险',
      officialName: '医药安欣（易核版）医疗保险',
      status: 'draft',
    });
    addReadySummary(db, '新华保险', '医药安欣（易核版）医疗保险');
    addReadySummary(db, '新华保险', '新华人寿保险股份有限公司康健无忧两全保险');
    const resolver = createAgentProductEntityResolver({
      db,
      officialDomainProfiles: OFFICIAL_DOMAIN_PROFILES,
    });

    const entities = resolver.resolveAllFromText({
      question: '你对比一下 医药安欣和康健无忧产品的优劣',
    }).entities;
    assert.deepEqual(entities.map((item) => item.officialName), [
      '医药安欣（易核版）医疗保险',
      '新华人寿保险股份有限公司康健无忧两全保险',
    ]);
    for (const entity of entities) {
      assert.equal(resolver.resolve({
        mentions: [
          { type: 'insurer', rawText: entity.company },
          { type: 'product', rawText: entity.officialName },
        ],
      }).status, 'resolved');
    }
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
  const db = makeDb();
  try {
    assert.throws(() => createResolverService({ db }), /tenantId/u);
  } finally {
    db.close();
  }
});
