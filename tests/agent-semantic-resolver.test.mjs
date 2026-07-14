import assert from 'node:assert/strict';
import test from 'node:test';

import {
  semanticFrameToRouterCandidate,
} from '../server/agent-semantic-contract.mjs';
import { createAgentSemanticResolver } from '../server/agent-semantic-resolver.service.mjs';

const NOW = 1_800_000_000_000;
const PRODUCT = {
  canonicalProductId: 'product-kjwy',
  company: '新华保险',
  officialName: '新华人寿保险股份有限公司康健无忧两全保险',
  matchType: 'exact_official_name',
  confidence: 1,
};

function proposal(overrides = {}) {
  return {
    semanticContractVersion: 1,
    intent: 'insurance_product_knowledge',
    operation: 'read',
    queryAspects: ['main_responsibilities'],
    mentions: [],
    references: [],
    requestedSteps: ['lookup'],
    confidence: { intent: 0.98, mentions: 1, references: 1 },
    ...overrides,
  };
}

function harness({ productResult, productScanResult, familyResult } = {}) {
  const productCalls = [];
  const productScanCalls = [];
  const familyCalls = [];
  const productResolver = {
    resolve(input) {
      productCalls.push(input);
      return typeof productResult === 'function'
        ? productResult(input)
        : productResult || { status: 'resolved', entity: PRODUCT, candidates: [] };
    },
  };
  if (productScanResult !== undefined) {
    productResolver.resolveAllFromText = (input) => {
      productScanCalls.push(input);
      return typeof productScanResult === 'function' ? productScanResult(input) : productScanResult;
    };
  }
  const familyResolver = {
    async resolve(input) {
      familyCalls.push(input);
      return typeof familyResult === 'function'
        ? familyResult(input)
        : familyResult || {
        status: 'resolved',
        entity: { familyId: 12, displayName: '张三家庭', matchType: 'contextual', confidence: 1 },
        candidates: [],
      };
    },
  };
  return {
    resolver: createAgentSemanticResolver({ productResolver, familyResolver, clock: () => NOW }),
    productCalls,
    productScanCalls,
    familyCalls,
  };
}

function activeProduct(overrides = {}) {
  return { ...PRODUCT, updatedAt: NOW - 1_000, expiresAt: NOW + 60_000, ...overrides };
}

function canonicalProductResult({ mentions }) {
  const rawText = mentions.find((mention) => mention.type === 'product')?.rawText || '';
  if (/甲产品|康健无忧|康无忧/u.test(rawText)) {
    return { status: 'resolved', entity: { ...PRODUCT, canonicalProductId: 'product-a' }, candidates: [] };
  }
  if (/乙产品|健康福/u.test(rawText)) {
    return {
      status: 'resolved',
      entity: { ...PRODUCT, canonicalProductId: 'product-b', officialName: '健康福保险' },
      candidates: [],
    };
  }
  return { status: 'not_found', entity: null, candidates: [] };
}

function canonicalScanResult({ question }) {
  const entities = [];
  if (/甲产品|康健无忧|康无忧/u.test(question)) {
    entities.push({ ...PRODUCT, canonicalProductId: 'product-a' });
  }
  if (/乙产品|健康福/u.test(question)) {
    entities.push({ ...PRODUCT, canonicalProductId: 'product-b', officialName: '健康福保险' });
  }
  return { entities, overflow: false };
}

test('current_product uses a live confirmed product and projects its formal identity', async () => {
  const { resolver, productCalls } = harness();
  const question = '主要保啥的呀，这个保险';
  const result = await resolver.resolve({
    internalUserId: 7,
    question,
    runtime: 'hermes',
    proposal: proposal({ references: [{ type: 'current_product', rawText: '这个保险' }] }),
    context: { taskState: { activeEntities: { product: activeProduct({
      canonicalProductId: 'untrusted-state-id', secret: 'drop',
    }) } } },
  });

  assert.equal(result.decision, 'execute');
  assert.equal(productCalls.length, 1);
  assert.equal(productCalls[0].activeProduct, null);
  assert.deepEqual(productCalls[0].mentions, [
    { type: 'insurer', rawText: PRODUCT.company },
    { type: 'product', rawText: PRODUCT.officialName },
  ]);
  assert.deepEqual(result.candidate, {
    intent: 'insurance_product_knowledge',
    question,
    confidence: 0.98,
    requestedOperation: 'read',
    entities: {
      productName: PRODUCT.officialName,
      productCanonicalId: PRODUCT.canonicalProductId,
      productCompany: PRODUCT.company,
    },
  });
  assert.equal(JSON.stringify(result).includes('untrusted-state-id'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('current_product clarifies when authoritative product revalidation reports not found', async () => {
  const { resolver, productCalls } = harness({
    productResult: { status: 'not_found', entity: null, candidates: [] },
  });
  const result = await resolver.resolve({
    internalUserId: 7,
    question: '这个保险保什么',
    runtime: 'hermes',
    proposal: proposal({ references: [{ type: 'current_product', rawText: '这个保险' }] }),
    context: { taskState: { activeEntities: { product: activeProduct() } } },
  });
  assert.equal(result.decision, 'clarify');
  assert.equal(result.candidate, null);
  assert.equal(productCalls[0].activeProduct, null);
});

test('current_product preserves an explicit insurer instead of substituting the active company', async () => {
  const question = '平安保险的这个保险主要保什么';
  const { resolver, productCalls } = harness({
    productResult: ({ mentions, activeProduct: active }) => {
      assert.equal(active, null);
      assert.deepEqual(mentions, [
        { type: 'insurer', rawText: '平安保险' },
        { type: 'product', rawText: PRODUCT.officialName },
      ]);
      return { status: 'not_found', entity: null, candidates: [] };
    },
  });
  const result = await resolver.resolve({
    internalUserId: 7,
    question,
    runtime: 'hermes',
    proposal: proposal({
      mentions: [{ type: 'insurer', rawText: '平安保险' }],
      references: [{ type: 'current_product', rawText: '这个保险' }],
    }),
    context: { taskState: { activeEntities: { product: activeProduct() } } },
  });

  assert.equal(result.decision, 'clarify');
  assert.equal(result.decisionReason, 'product_required');
  assert.equal(result.candidate, null);
  assert.equal(productCalls.length, 1);
});

test('inherits and revalidates a live product for an omitted follow-up in the active product task', async () => {
  const { resolver, productCalls } = harness();
  const result = await resolver.resolve({
    internalUserId: 7,
    question: '主要保啥',
    runtime: 'hermes',
    proposal: proposal(),
    context: { taskState: {
      activeIntent: 'insurance_product_knowledge',
      activeEntities: { product: activeProduct() },
    } },
  });

  assert.equal(result.decision, 'execute');
  assert.deepEqual(productCalls[0], { mentions: [], activeProduct: activeProduct() });
  assert.equal(result.candidate.entities.productCanonicalId, PRODUCT.canonicalProductId);
});

test('does not inherit an active product across tasks or while clarification is pending', async () => {
  for (const taskState of [
    { activeIntent: 'chat', activeEntities: { product: activeProduct() } },
    {
      activeIntent: 'insurance_product_knowledge',
      activeEntities: { product: activeProduct() },
      candidateSets: { product: [{ ...PRODUCT, canonicalProductId: 'candidate' }] },
      pendingClarification: {
        entityType: 'product', proposal: proposal(), originalQuestion: '查哪款产品', expiresAt: NOW + 60_000,
      },
    },
  ]) {
    const { resolver, productCalls } = harness({
      productResult: { status: 'missing', entity: null, candidates: [] },
    });
    const result = await resolver.resolve({
      internalUserId: 7, question: '主要保啥', runtime: 'hermes', proposal: proposal(), context: { taskState },
    });
    assert.equal(result.decision, 'clarify');
    assert.equal(productCalls[0].activeProduct, null);
  }
});

test('explicit product mention takes priority over active context', async () => {
  const { resolver, productCalls } = harness();
  const question = '新华康健无忧两全保险主要保什么，这个保险';
  await resolver.resolve({
    internalUserId: 7,
    question,
    runtime: 'hermes',
    proposal: proposal({
      mentions: [{ type: 'product', rawText: '新华康健无忧两全保险' }],
      references: [{ type: 'current_product', rawText: '这个保险' }],
    }),
    context: { taskState: { activeEntities: { product: activeProduct() } } },
  });

  assert.equal(productCalls[0].activeProduct, null);
  assert.deepEqual(productCalls[0].mentions, [{ type: 'product', rawText: '新华康健无忧两全保险' }]);
});

test('passes formal and short product mentions to the product resolver unchanged', async () => {
  for (const productName of [PRODUCT.officialName, '康健无忧两全保险']) {
    const { resolver, productCalls } = harness({
      productResult: canonicalProductResult, productScanResult: canonicalScanResult,
    });
    const question = `${productName}主要保什么`;
    const result = await resolver.resolve({
      internalUserId: 7,
      question,
      runtime: 'hermes',
      proposal: proposal({ mentions: [{ type: 'product', rawText: productName }] }),
    });
    assert.equal(productCalls[0].mentions[0].rawText, productName);
    assert.equal(result.candidate.entities.productName, PRODUCT.officialName);
  }
});

test('product comparison resolves exactly two distinct canonical products', async () => {
  const question = '甲产品和乙产品有什么区别';
  const { resolver } = harness({ productResult: canonicalProductResult, productScanResult: canonicalScanResult });
  const result = await resolver.resolve({
    internalUserId: 7, question, runtime: 'hermes',
    proposal: proposal({
      queryAspects: ['comparison'],
      mentions: [{ type: 'product', rawText: '甲产品' }, { type: 'product', rawText: '乙产品' }],
      requestedSteps: ['compare'],
    }),
    context: { taskState: { activeIntent: 'insurance_product_knowledge', activeEntities: { product: activeProduct() } } },
  });
  assert.equal(result.decision, 'execute');
  assert.deepEqual(result.resolvedEntities.products.map((item) => item.canonicalProductId), ['product-a', 'product-b']);
  assert.equal(result.resolvedEntities.product, undefined);
  assert.deepEqual(result.candidate.entities, {
    product1Name: PRODUCT.officialName,
    product1CanonicalId: 'product-a',
    product1Company: PRODUCT.company,
    product2Name: '健康福保险',
    product2CanonicalId: 'product-b',
    product2Company: PRODUCT.company,
  });
  assert.equal(result.nextTaskState.activeEntities.product.canonicalProductId, PRODUCT.canonicalProductId);
});

test('clear multi-product wording executes only when two products can be confirmed', async () => {
  for (const question of [
    '甲产品和乙产品分别保什么',
    '甲产品、乙产品各自主要责任',
    '甲产品和乙产品主要保什么',
    '这两款主要保什么',
    '二者主要责任是什么',
  ]) {
    const mention = question.includes('甲产品')
      ? [{ type: 'product', rawText: '甲产品' }]
      : [];
    const { resolver, productCalls } = harness({
      productResult: canonicalProductResult, productScanResult: canonicalScanResult,
    });
    const result = await resolver.resolve({
      internalUserId: 7,
      question,
      runtime: 'hermes',
      proposal: proposal({ mentions: mention }),
    });
    const hasTwoConfirmed = /甲产品.*乙产品/u.test(question);
    assert.equal(result.decision, hasTwoConfirmed ? 'execute' : 'clarify', question);
    if (hasTwoConfirmed) assert.equal(result.resolvedEntities.products.length, 2, question);
    assert.ok(productCalls.length <= 8, question);
  }
});

test('catalog scan enables under-extracted two-product comparisons without misreading single-product aspects', async () => {
  for (const question of [
    '甲产品还有乙产品分别保什么',
    '甲产品/乙产品各自主要责任',
    '甲产品或者乙产品哪个好',
  ]) {
    const { resolver, productCalls } = harness({
      productResult: canonicalProductResult, productScanResult: canonicalScanResult,
    });
    const result = await resolver.resolve({
      internalUserId: 7,
      question,
      runtime: 'hermes',
      proposal: proposal({ mentions: [{ type: 'product', rawText: '甲产品' }] }),
    });
    assert.equal(result.decision, 'execute', question);
    assert.equal(result.resolvedEntities.products.length, 2, question);
    assert.ok(productCalls.length > 0 && productCalls.length <= 8, question);
  }

  for (const question of [
    '甲产品的身故及满期责任分别是什么',
    '甲产品的保险责任与免责条款有什么区别',
  ]) {
    const { resolver, productCalls } = harness();
    const result = await resolver.resolve({
      internalUserId: 7,
      question,
      runtime: 'hermes',
      proposal: proposal({ mentions: [{ type: 'product', rawText: '甲产品' }] }),
    });
    assert.equal(result.decision, 'execute', question);
    assert.equal(productCalls.length, 1, question);
  }
});

test('catalog scan resolves distinct products across arbitrary wording', async () => {
  const cases = [
    {
      question: '甲产品（以下简称甲保）和乙产品主要保什么',
      mentions: [
        { type: 'product', rawText: '甲产品' },
        { type: 'product', rawText: '乙产品' },
      ],
    },
    { question: '康健无忧和健康福哪个好', mentions: [{ type: 'product', rawText: '康健无忧' }] },
    { question: '康健无忧 VS 健康福哪个好', mentions: [{ type: 'product', rawText: '康健无忧' }] },
    { question: '康健无忧相比健康福哪个好', mentions: [{ type: 'product', rawText: '康健无忧' }] },
    { question: '康健无忧同健康福哪个划算', mentions: [{ type: 'product', rawText: '康健无忧' }] },
    { question: '康健无忧跟健康福哪个好', mentions: [{ type: 'product', rawText: '康健无忧' }] },
    { question: '康健无忧比健康福哪个好', mentions: [{ type: 'product', rawText: '康健无忧' }] },
    { question: '康健无忧+健康福哪个好', mentions: [{ type: 'product', rawText: '康健无忧' }] },
    { question: '康健无忧搭着健康福哪个好', mentions: [{ type: 'product', rawText: '康健无忧' }] },
  ];
  for (const item of cases) {
    const { resolver, productCalls } = harness({
      productResult: canonicalProductResult, productScanResult: canonicalScanResult,
    });
    const result = await resolver.resolve({
      internalUserId: 7,
      question: item.question,
      runtime: 'hermes',
      proposal: proposal({ mentions: item.mentions }),
    });
    assert.equal(result.decision, 'execute', item.question);
    assert.equal(result.resolvedEntities.products.length, 2, item.question);
    assert.ok(productCalls.length <= 8, item.question);
  }
});

test('catalog scan ignores ordinary single-product questions and fails closed on overflow', async () => {
  for (const suffix of ['适合老人吗', '值得买吗', '有什么优势', '癌症怎么赔', '什么时候生效', '在哪里买']) {
    const question = `康健无忧${suffix}`;
    const { resolver, productCalls } = harness({
      productResult: canonicalProductResult, productScanResult: canonicalScanResult,
    });
    const result = await resolver.resolve({
      internalUserId: 7,
      question,
      runtime: 'hermes',
      proposal: proposal({ mentions: [{ type: 'product', rawText: '康健无忧' }] }),
    });
    assert.equal(result.decision, 'execute', question);
    assert.equal(productCalls.length, 1, question);
  }

  const overflow = harness({
    productResult: canonicalProductResult,
    productScanResult: { entities: [], overflow: true },
  });
  const result = await overflow.resolver.resolve({
    internalUserId: 7,
    question: '康健无忧产品',
    runtime: 'hermes',
    proposal: proposal({ mentions: [{ type: 'product', rawText: '康健无忧' }] }),
  });
  assert.equal(result.decision, 'clarify');
  assert.equal(result.decisionReason, 'product_comparison_unsupported');
  assert.equal(result.candidate, null);
});

test('canonical evidence fails closed for unresolved explicit products and bounds resolver calls', async () => {
  const mixedQuestion = '甲产品和未知产品主要保什么';
  const mixed = harness({
    productResult: canonicalProductResult, productScanResult: canonicalScanResult,
  });
  const mixedResult = await mixed.resolver.resolve({
    internalUserId: 7,
    question: mixedQuestion,
    runtime: 'hermes',
    proposal: proposal({ mentions: [
      { type: 'product', rawText: '甲产品' },
      { type: 'product', rawText: '未知产品' },
    ] }),
  });
  assert.equal(mixedResult.decision, 'clarify');
  assert.equal(mixedResult.candidate, null);
  assert.equal(mixed.productCalls.length, 2);

  const names = Array.from({ length: 9 }, (_value, index) => `产品${index + 1}`);
  const bounded = harness({
    productResult: canonicalProductResult, productScanResult: canonicalScanResult,
  });
  const boundedResult = await bounded.resolver.resolve({
    internalUserId: 7,
    question: names.join('、'),
    runtime: 'hermes',
    proposal: proposal({ mentions: names.map((rawText) => ({ type: 'product', rawText })) }),
  });
  assert.equal(boundedResult.decision, 'clarify');
  assert.equal(boundedResult.candidate, null);
  assert.equal(bounded.productCalls.length, 0);
});

test('a formal product name and its parenthetical short name are not treated as two products', async () => {
  const question = `${PRODUCT.officialName}（以下简称康无忧）主要保什么`;
  const { resolver, productCalls, productScanCalls } = harness({
    productResult: canonicalProductResult, productScanResult: canonicalScanResult,
  });
  const result = await resolver.resolve({
    internalUserId: 7,
    question,
    runtime: 'hermes',
    proposal: proposal({ mentions: [
      { type: 'product', rawText: PRODUCT.officialName },
      { type: 'product', rawText: '康无忧' },
    ] }),
  });

  assert.equal(result.decision, 'execute');
  assert.ok(productCalls.length >= 2 && productCalls.length <= 4);
  assert.equal(productScanCalls.length, 1);
  assert.equal(result.candidate.entities.productName, PRODUCT.officialName);
});

test('current_product reference checks a residual second product before execution', async () => {
  const question = '这个保险跟乙产品哪个好';
  const { resolver, productCalls, productScanCalls } = harness({
    productResult: canonicalProductResult, productScanResult: canonicalScanResult,
  });
  const result = await resolver.resolve({
    internalUserId: 7,
    question,
    runtime: 'hermes',
    proposal: proposal({
      mentions: [],
      references: [{ type: 'current_product', rawText: '这个保险' }],
    }),
    context: { taskState: { activeEntities: { product: activeProduct({
      canonicalProductId: 'product-a',
    }) } } },
  });

  assert.equal(result.decision, 'clarify');
  assert.equal(result.decisionReason, 'product_comparison_unsupported');
  assert.equal(result.candidate, null);
  assert.equal(productCalls.length, 1);
  assert.equal(productScanCalls.length, 1);
});

test('current_family is reauthorized and family id never enters router candidate', async () => {
  const { resolver, familyCalls } = harness();
  const question = '这个家庭的保障报告';
  const result = await resolver.resolve({
    internalUserId: 7,
    question,
    runtime: 'hermes',
    proposal: proposal({
      intent: 'coverage_report',
      queryAspects: ['coverage_gap'],
      references: [{ type: 'current_family', rawText: '这个家庭' }],
      requestedSteps: ['generate'],
    }),
    context: { taskState: { activeEntities: { family: {
      familyId: 12, displayName: '旧标签', updatedAt: NOW - 1_000, expiresAt: NOW + 1_000,
      privateNotes: 'drop',
    } } } },
  });

  assert.deepEqual(familyCalls[0].activeFamily, { familyId: 12, displayName: '旧标签' });
  assert.deepEqual(result.candidate.entities, { familyName: '张三家庭' });
  assert.equal(JSON.stringify(result.candidate).includes('familyId'), false);
});

test('expired active references clarify instead of entering a resolver as context', async () => {
  const { resolver, productCalls } = harness({
    productResult: { status: 'missing', entity: null, candidates: [] },
  });
  const question = '这个保险保什么';
  const result = await resolver.resolve({
    internalUserId: 7,
    question,
    runtime: 'hermes',
    proposal: proposal({ references: [{ type: 'current_product', rawText: '这个保险' }] }),
    context: { taskState: { activeEntities: { product: activeProduct({ expiresAt: NOW }) } } },
  });

  assert.equal(result.decision, 'clarify');
  assert.equal(productCalls.length, 0);
});

test('future active timestamps and overlong expiry windows cannot restore current_product', async () => {
  const states = [
    activeProduct({ updatedAt: NOW + 1, expiresAt: undefined }),
    activeProduct({ updatedAt: NOW - 1_000, expiresAt: NOW + 300_001 }),
    activeProduct({ updatedAt: undefined, expiresAt: NOW + 300_001 }),
  ];
  for (const product of states) {
    const { resolver, productCalls } = harness();
    const result = await resolver.resolve({
      internalUserId: 7,
      question: '这个保险保什么',
      runtime: 'hermes',
      proposal: proposal({ references: [{ type: 'current_product', rawText: '这个保险' }] }),
      context: { taskState: { activeEntities: { product } } },
    });
    assert.equal(result.decision, 'clarify');
    assert.equal(result.candidate, null);
    assert.equal(productCalls.length, 0);
  }
});

test('far-future pending expiry is rejected before candidate resolution', async () => {
  const { resolver, productCalls, familyCalls } = harness();
  const result = await resolver.resolve({
    internalUserId: 7,
    question: '选择1',
    runtime: 'rule',
    context: { taskState: {
      candidateSets: { product: [PRODUCT] },
      pendingClarification: {
        entityType: 'product',
        proposal: proposal({ mentions: [{ type: 'product', rawText: '康健无忧' }] }),
        originalQuestion: '康健无忧保什么',
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
    } },
  });
  assert.equal(result.decision, 'clarify');
  assert.equal(result.decisionReason, 'candidate_selection_expired');
  assert.equal(result.candidate, null);
  assert.equal(productCalls.length, 0);
  assert.equal(familyCalls.length, 0);
});

test('ambiguous product selection revalidates formal identity and ignores stored canonical id', async () => {
  const candidates = [
    { ...PRODUCT, canonicalProductId: 'product-1', officialName: '第一款保险', extra: 'drop' },
    { ...PRODUCT, canonicalProductId: 'attacker-controlled-id', officialName: '第二款保险', extra: 'drop' },
  ];
  const first = harness({ productResult: { status: 'ambiguous', entity: null, candidates } });
  const originalQuestion = '康健无忧保什么';
  const originalProposal = proposal({ mentions: [{ type: 'product', rawText: '康健无忧' }] });
  const clarified = await first.resolver.resolve({
    internalUserId: 7, question: originalQuestion, runtime: 'hermes', proposal: originalProposal,
  });

  assert.equal(clarified.decision, 'clarify');
  assert.equal(clarified.nextTaskState.pendingClarification.entityType, 'product');
  assert.equal(clarified.nextTaskState.candidateSets.product.length, 2);
  assert.equal(JSON.stringify(clarified.nextTaskState).includes('extra'), false);

  const second = harness({
    productResult: ({ mentions, activeProduct: selectedActive }) => {
      assert.equal(selectedActive, null);
      assert.deepEqual(mentions, [
        { type: 'insurer', rawText: PRODUCT.company },
        { type: 'product', rawText: '第二款保险' },
      ]);
      return {
        status: 'resolved',
        entity: { ...PRODUCT, canonicalProductId: 'catalog-canonical-id', officialName: '第二款保险' },
        candidates: [],
      };
    },
  });
  const selected = await second.resolver.resolve({
    internalUserId: 7,
    question: '选择2',
    runtime: 'rule',
    proposal: null,
    context: { taskState: clarified.nextTaskState },
  });
  assert.equal(selected.decision, 'execute');
  assert.equal(selected.candidate.question, '选择2');
  assert.equal(selected.candidate.entities.productCanonicalId, 'catalog-canonical-id');
  assert.equal(JSON.stringify(selected).includes('attacker-controlled-id'), false);
  assert.equal(selected.nextTaskState.pendingClarification, null);
  assert.deepEqual(selected.nextTaskState.candidateSets.product, []);
});

test('Chinese ordinal product selection is consumed only by a live pending clarification', async () => {
  const savedProposal = proposal({ mentions: [{ type: 'product', rawText: '康健无忧' }] });
  const context = { taskState: {
    candidateSets: { product: [
      { ...PRODUCT, officialName: '第一款保险' },
      { ...PRODUCT, officialName: '第二款保险' },
    ] },
    pendingClarification: {
      entityType: 'product', proposal: savedProposal,
      originalQuestion: '康健无忧保什么', expiresAt: NOW + 10_000,
    },
  } };
  const { resolver, productCalls } = harness({
    productResult: { status: 'resolved', entity: { ...PRODUCT, officialName: '第二款保险' }, candidates: [] },
  });
  const selected = await resolver.resolve({
    internalUserId: 7, question: '选择第二款', runtime: 'rule', context,
  });
  assert.equal(selected.decision, 'execute');
  assert.equal(productCalls[0].mentions[1].rawText, '第二款保险');

  const unbound = await resolver.resolve({
    internalUserId: 7, question: '第二款', runtime: 'rule', context: {},
  });
  assert.equal(unbound.decision, 'clarify');
  assert.equal(unbound.decisionReason, 'candidate_selection_expired');
  assert.equal(unbound.candidate, null);
});

test('a stored product candidate that catalog revalidation cannot resolve never executes', async () => {
  const savedProposal = proposal({ mentions: [{ type: 'product', rawText: '伪造产品' }] });
  const { resolver, productCalls } = harness({
    productResult: { status: 'not_found', entity: null, candidates: [] },
  });
  const result = await resolver.resolve({
    internalUserId: 7,
    question: '选择1',
    runtime: 'hermes',
    context: { taskState: {
      candidateSets: { product: [{ ...PRODUCT, canonicalProductId: 'forged', officialName: '不存在保险' }] },
      pendingClarification: {
        entityType: 'product', proposal: savedProposal, originalQuestion: '伪造产品保什么', expiresAt: NOW + 10_000,
      },
    } },
  });

  assert.equal(result.decision, 'clarify');
  assert.equal(result.decisionReason, 'product_required');
  assert.equal(result.candidate, null);
  assert.equal(productCalls[0].activeProduct, null);
});

test('family selection is reauthorized through the family resolver', async () => {
  const savedProposal = proposal({
    intent: 'family_summary',
    mentions: [{ type: 'family', rawText: '张家' }],
    queryAspects: ['family_overview'],
  });
  const { resolver, familyCalls } = harness();
  const result = await resolver.resolve({
    internalUserId: 7,
    question: '第1个',
    runtime: 'hermes',
    context: { taskState: {
      activeEntities: { product: activeProduct() },
      candidateSets: { family: [{ familyId: 12, displayName: '张三家庭', secret: 'drop' }] },
      pendingClarification: {
        entityType: 'family', proposal: savedProposal, originalQuestion: '张家有几张保单', expiresAt: NOW + 10_000,
      },
    } },
  });

  assert.equal(result.decision, 'execute');
  assert.deepEqual(familyCalls[0].activeFamily, { familyId: 12, displayName: '张三家庭' });
  assert.deepEqual(result.nextTaskState.activeEntities.product, activeProduct());
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('expired, out-of-range, and unbound selections fail with candidate_selection_expired', async () => {
  const stored = {
    entityType: 'product',
    proposal: proposal({ mentions: [{ type: 'product', rawText: '康健无忧' }] }),
    originalQuestion: '康健无忧保什么',
    expiresAt: NOW + 1,
  };
  const contexts = [
    { taskState: { candidateSets: { product: [PRODUCT] }, pendingClarification: { ...stored, expiresAt: NOW } } },
    { taskState: { candidateSets: { product: [PRODUCT] }, pendingClarification: stored } },
    { taskState: { candidateSets: { product: [PRODUCT] }, pendingClarification: null } },
  ];
  const questions = ['选择1', '选择2', '2'];
  for (let index = 0; index < contexts.length; index += 1) {
    const { resolver } = harness();
    const result = await resolver.resolve({
      internalUserId: 7, question: questions[index], runtime: 'rule', proposal: null, context: contexts[index],
    });
    assert.equal(result.decision, 'clarify');
    assert.equal(result.decisionReason, 'candidate_selection_expired');
    assert.equal(result.candidate, null);
  }
});

test('candidate selection rejects product and family pending-intent type mismatches', async () => {
  const cases = [
    {
      entityType: 'product',
      savedProposal: proposal({
        intent: 'family_summary', mentions: [{ type: 'family', rawText: '张家' }], queryAspects: ['family_overview'],
      }),
      originalQuestion: '张家有几张保单',
      candidateSets: { product: [PRODUCT] },
    },
    {
      entityType: 'family',
      savedProposal: proposal({ mentions: [{ type: 'product', rawText: '康健无忧' }] }),
      originalQuestion: '康健无忧保什么',
      candidateSets: { family: [{ familyId: 12, displayName: '张三家庭' }] },
    },
  ];
  for (const item of cases) {
    const { resolver } = harness();
    const result = await resolver.resolve({
      internalUserId: 7,
      question: '选择1',
      runtime: 'rule',
      context: { taskState: {
        candidateSets: item.candidateSets,
        pendingClarification: {
          entityType: item.entityType,
          proposal: item.savedProposal,
          originalQuestion: item.originalQuestion,
          expiresAt: NOW + 10_000,
        },
      } },
    });
    assert.equal(result.decision, 'clarify');
    assert.equal(result.decisionReason, 'candidate_selection_expired');
    assert.equal(result.candidate, null);
  }
});

test('proposal-free fallback executes only an explicit positive upload signal', async () => {
  const { resolver, productCalls, familyCalls } = harness();
  const upload = await resolver.resolve({
    internalUserId: 7, question: '我要上传保单资料', runtime: 'rule', proposal: null,
  });
  assert.equal(upload.decision, 'execute');
  assert.equal(upload.candidate.intent, 'upload_link');

  const unavailable = await resolver.resolve({
    internalUserId: 7, question: '帮我看看产品', runtime: 'rule', proposal: null,
  });
  assert.equal(unavailable.decision, 'retry_later');
  assert.equal(unavailable.decisionReason, 'semantic_proposal_unavailable');
  assert.equal(productCalls.length, 0);
  assert.equal(familyCalls.length, 0);
});

test('upload rule synthesis is limited to truly unavailable proposals in rule runtime', async () => {
  for (const runtime of ['hermes', 'direct']) {
    const { resolver } = harness();
    const result = await resolver.resolve({
      internalUserId: 7, question: '我要上传保单资料', runtime, proposal: null,
    });
    assert.equal(result.decision, 'retry_later');
    assert.equal(result.candidate, null);
  }

  const { resolver } = harness();
  const invalid = await resolver.resolve({
    internalUserId: 7,
    question: '我要上传保单资料',
    runtime: 'rule',
    proposal: { intent: 'upload_link', authority: 'admin' },
  });
  assert.equal(invalid.decision, 'retry_later');
  assert.equal(invalid.candidate, null);
});

test('direct write readiness prevents execution', async () => {
  const { resolver } = harness();
  const result = await resolver.resolve({
    internalUserId: 7,
    question: '修改张三家庭',
    runtime: 'direct',
    proposal: proposal({
      intent: 'family_summary', operation: 'write', queryAspects: ['family_overview'],
      mentions: [{ type: 'family', rawText: '张三家庭' }],
    }),
  });
  assert.equal(result.decision, 'clarify');
  assert.equal(result.decisionReason, 'unsafe_fallback_operation');
  assert.equal(result.candidate, null);
});

test('preflight failures do not call domain resolvers', async () => {
  const cases = [
    {
      runtime: 'hermes',
      value: proposal({ confidence: { intent: 0.5, mentions: 1, references: 1 } }),
      reason: 'low_intent_confidence',
    },
    {
      runtime: 'direct',
      value: proposal({
        intent: 'family_summary', operation: 'write', queryAspects: ['family_overview'],
        mentions: [{ type: 'family', rawText: '张三家庭' }],
      }),
      reason: 'unsafe_fallback_operation',
      question: '修改张三家庭',
    },
    { runtime: 'invalid', value: proposal(), reason: 'unsupported_runtime' },
    { runtime: 'hermes', value: { ...proposal(), intent: 'invented' }, reason: 'semantic_proposal_unavailable' },
  ];
  for (const item of cases) {
    const { resolver, productCalls, familyCalls } = harness();
    const result = await resolver.resolve({
      internalUserId: 7,
      question: item.question || '产品保什么',
      runtime: item.runtime,
      proposal: item.value,
    });
    assert.equal(result.decisionReason, item.reason);
    assert.equal(productCalls.length, 0);
    assert.equal(familyCalls.length, 0);
  }
});

test('malformed resolved entities are treated as missing', async () => {
  const badProducts = [
    { ...PRODUCT, matchType: 'context', confidence: 1 },
    { ...PRODUCT, matchType: 'exact_official_name', confidence: 0.89 },
    { ...PRODUCT, matchType: 'invented', confidence: 1 },
    { ...PRODUCT, matchType: 'exact_official_name', confidence: Number.NaN },
    { ...PRODUCT, matchType: 'exact_official_name', confidence: 2 },
  ];
  for (const entity of badProducts) {
    const { resolver } = harness({ productResult: { status: 'resolved', entity, candidates: [] } });
    const result = await resolver.resolve({
      internalUserId: 7,
      question: '康健无忧保什么',
      runtime: 'hermes',
      proposal: proposal({ mentions: [{ type: 'product', rawText: '康健无忧' }] }),
    });
    assert.equal(result.decisionReason, 'product_required');
    assert.equal(result.candidate, null);
  }

  const badFamilies = [
    { familyId: true, displayName: '张三家庭', matchType: 'exact', confidence: 1 },
    { familyId: 12, displayName: '张三家庭', matchType: 'prefix', confidence: 1 },
    { familyId: 12, displayName: '张三家庭', matchType: 'exact', confidence: 0.99 },
    { familyId: 12, displayName: '张三家庭', matchType: 'exact', confidence: 2 },
  ];
  for (const entity of badFamilies) {
    const { resolver } = harness({ familyResult: { status: 'resolved', entity, candidates: [] } });
    const result = await resolver.resolve({
      internalUserId: 7,
      question: '张三家庭保单',
      runtime: 'hermes',
      proposal: proposal({
        intent: 'family_summary', queryAspects: ['family_overview'],
        mentions: [{ type: 'family', rawText: '张三家庭' }],
      }),
    });
    assert.equal(result.decisionReason, 'family_required');
    assert.equal(result.candidate, null);
  }
});

test('domain resolver exceptions retry without advancing projected task state', async () => {
  const activeFamily = {
    familyId: 12,
    displayName: '张三家庭',
    updatedAt: NOW - 1_000,
    expiresAt: NOW + 10_000,
    privateNotes: 'drop',
  };
  for (const type of ['product', 'family']) {
    const failing = () => { throw new Error('unavailable'); };
    const { resolver } = harness({
      productResult: type === 'product' ? failing : undefined,
      familyResult: type === 'family' ? failing : undefined,
    });
    const isProduct = type === 'product';
    const result = await resolver.resolve({
      internalUserId: 7,
      question: isProduct ? '康健无忧保什么' : '张三家庭保单',
      runtime: 'hermes',
      proposal: isProduct
        ? proposal({ mentions: [{ type: 'product', rawText: '康健无忧' }] })
        : proposal({
          intent: 'family_summary', queryAspects: ['family_overview'],
          mentions: [{ type: 'family', rawText: '张三家庭' }],
        }),
      context: { taskState: { activeEntities: { family: activeFamily } } },
    });
    assert.equal(result.decision, 'retry_later');
    assert.equal(result.decisionReason, 'entity_resolver_unavailable');
    assert.deepEqual(result.resolvedEntities, {});
    assert.equal(result.candidate, null);
    assert.equal(result.nextTaskState.activeEntities.family.privateNotes, undefined);
    assert.equal(result.nextTaskState.activeEntities.family.updatedAt, activeFamily.updatedAt);
  }
});

test('new ambiguity clears the previous pending entity candidates and preserves unrelated active entity', async () => {
  const familyPendingProposal = proposal({
    intent: 'family_summary', queryAspects: ['family_overview'],
    mentions: [{ type: 'family', rawText: '张家' }],
  });
  const activeFamily = {
    familyId: 12, displayName: '张三家庭', matchType: 'contextual', confidence: 1,
    updatedAt: NOW - 1_000, expiresAt: NOW + 10_000,
  };
  const { resolver } = harness({
    productResult: { status: 'ambiguous', entity: null, candidates: [PRODUCT] },
  });
  const result = await resolver.resolve({
    internalUserId: 7,
    question: '康健无忧保什么',
    runtime: 'hermes',
    proposal: proposal({ mentions: [{ type: 'product', rawText: '康健无忧' }] }),
    context: { taskState: {
      activeEntities: { family: activeFamily },
      candidateSets: { family: [{ familyId: 13, displayName: '张家二号' }] },
      pendingClarification: {
        entityType: 'family', proposal: familyPendingProposal,
        originalQuestion: '张家有几张保单', expiresAt: NOW + 10_000,
      },
    } },
  });
  assert.equal(result.decisionReason, 'entity_ambiguous');
  assert.deepEqual(result.nextTaskState.candidateSets.family, []);
  assert.equal(result.nextTaskState.candidateSets.product.length, 1);
  assert.deepEqual(result.nextTaskState.activeEntities.family, activeFamily);
});

test('constructor and clock enforce bounded safe timestamps', async () => {
  const dependencies = {
    productResolver: { resolve: () => ({ status: 'missing', entity: null, candidates: [] }) },
    familyResolver: { resolve: async () => ({ status: 'missing', entity: null, candidates: [] }) },
  };
  assert.throws(() => createAgentSemanticResolver({ ...dependencies, clock: null }), TypeError);
  for (const contextTtlMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, 86_400_001]) {
    assert.throws(() => createAgentSemanticResolver({ ...dependencies, contextTtlMs }), TypeError);
  }
  for (const now of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
    const resolver = createAgentSemanticResolver({ ...dependencies, clock: () => now });
    await assert.rejects(() => resolver.resolve({
      internalUserId: 7, question: '你好', runtime: 'hermes', proposal: proposal({ intent: 'chat' }),
    }), TypeError);
  }
});

test('router conversion is strict, bounded, and drops family authority fields', () => {
  const frame = {
    ...proposal({ intent: 'family_summary', queryAspects: ['family_overview'] }),
    resolvedEntities: {
      family: { familyId: 12, displayName: '张三家庭', secret: 'drop' },
    },
    authority: { admin: true },
  };
  assert.deepEqual(semanticFrameToRouterCandidate(frame, ' 查看家庭 '), {
    intent: 'family_summary', question: '查看家庭', confidence: 0.98, requestedOperation: 'read',
    entities: { familyName: '张三家庭' },
  });
  assert.throws(
    () => semanticFrameToRouterCandidate({ ...frame, intent: 'invented' }, '查看家庭'),
    (error) => error?.code === 'SEMANTIC_FRAME_INVALID',
  );
  assert.throws(() => semanticFrameToRouterCandidate(frame, '   '), /SEMANTIC_FRAME_INVALID/u);

  const productFrame = { ...proposal(), resolvedEntities: { product: PRODUCT } };
  const familyFrame = {
    ...proposal({ intent: 'family_summary', queryAspects: ['family_overview'] }),
    resolvedEntities: { family: { familyId: 12, displayName: '张三家庭' } },
  };
  const chatFrame = { ...proposal({ intent: 'chat' }), resolvedEntities: {} };
  for (const invalidFrame of [
    { ...productFrame, resolvedEntities: {} },
    { ...productFrame, resolvedEntities: { product: PRODUCT, family: familyFrame.resolvedEntities.family } },
    { ...familyFrame, resolvedEntities: {} },
    { ...familyFrame, resolvedEntities: { ...familyFrame.resolvedEntities, product: PRODUCT } },
    { ...chatFrame, resolvedEntities: { product: PRODUCT } },
  ]) {
    assert.throws(() => semanticFrameToRouterCandidate(invalidFrame, '查看'), /SEMANTIC_FRAME_INVALID/u);
  }
});
