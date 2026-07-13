import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeSemanticProposal,
  SEMANTIC_CONTRACT_VERSION,
  SEMANTIC_DECISIONS,
  SEMANTIC_INTENTS,
  SEMANTIC_MENTION_TYPES,
  SEMANTIC_QUERY_ASPECTS,
  SEMANTIC_REFERENCE_TYPES,
} from '../server/agent-semantic-contract.mjs';
import { preparseAgentMessage } from '../server/agent-semantic-preparser.mjs';

function validProposal(overrides = {}) {
  return {
    semanticContractVersion: 1,
    intent: 'insurance_product_knowledge',
    operation: 'read',
    queryAspects: ['main_responsibilities'],
    mentions: [],
    references: [],
    requestedSteps: ['lookup'],
    confidence: { intent: 0.98, mentions: 0.95, references: 0.92 },
    ...overrides,
  };
}

function assertInvalid(proposal, question = '这个保险主要保什么') {
  assert.throws(
    () => normalizeSemanticProposal(proposal, question),
    (error) => error?.message === 'SEMANTIC_PROPOSAL_INVALID'
      && error?.code === 'SEMANTIC_PROPOSAL_INVALID',
  );
}

test('semantic contract exports the versioned controlled vocabularies', () => {
  assert.equal(SEMANTIC_CONTRACT_VERSION, 1);
  assert.deepEqual(SEMANTIC_INTENTS, [
    'chat', 'family_list', 'family_summary', 'coverage_report', 'sales_report',
    'sales_coaching', 'upload_link', 'insurance_product_knowledge',
  ]);
  assert.deepEqual(SEMANTIC_QUERY_ASPECTS, [
    'main_responsibilities', 'exclusions', 'waiting_period', 'deductible',
    'reimbursement_ratio', 'renewal', 'sales_status', 'comparison',
    'family_overview', 'coverage_gap', 'report_status', 'sales_guidance', 'upload',
  ]);
  assert.deepEqual(SEMANTIC_MENTION_TYPES, ['insurer', 'product', 'family']);
  assert.deepEqual(SEMANTIC_REFERENCE_TYPES, [
    'current_product', 'current_family', 'candidate_index', 'previous_result',
    'comparison_left', 'comparison_right',
  ]);
  assert.deepEqual(SEMANTIC_DECISIONS, ['execute', 'clarify', 'reject', 'retry_later']);
  assert.ok(Object.isFrozen(SEMANTIC_INTENTS));
});

test('semantic proposal preserves exact mentions and separate confidence scores', () => {
  const question = '新华人寿保险股份有限公司康健无忧两全保险，这个保险主要保啥的';
  const proposal = normalizeSemanticProposal(validProposal({
    mentions: [
      { type: 'insurer', rawText: '新华人寿保险股份有限公司' },
      { type: 'product', rawText: '康健无忧两全保险' },
    ],
    references: [{ type: 'current_product', rawText: '这个保险' }],
  }), question);

  assert.deepEqual(proposal, validProposal({
    mentions: [
      { type: 'insurer', rawText: '新华人寿保险股份有限公司' },
      { type: 'product', rawText: '康健无忧两全保险' },
    ],
    references: [{ type: 'current_product', rawText: '这个保险' }],
  }));
  assert.deepEqual(proposal.confidence, {
    intent: 0.98,
    mentions: 0.95,
    references: 0.92,
  });
});

test('semantic proposal rejects invented mention text and extra root fields', () => {
  assertInvalid(validProposal({
    intent: 'family_summary',
    queryAspects: ['family_overview'],
    mentions: [{ type: 'family', rawText: '不存在家庭' }],
    internalUserId: 7,
  }), '看看张三家庭');

  assertInvalid(validProposal({
    mentions: [{ type: 'product', rawText: '不存在的保险' }],
  }));
});

test('semantic proposal rejects invalid enums and unknown nested fields', () => {
  assertInvalid(validProposal({ intent: 'invented_intent' }));
  assertInvalid(validProposal({ operation: 'delete' }));
  assertInvalid(validProposal({ queryAspects: ['invented_aspect'] }));
  assertInvalid(validProposal({ requestedSteps: ['answer'] }));
  assertInvalid(validProposal({
    mentions: [{ type: 'product', rawText: '这个保险', canonicalId: 'secret' }],
  }));
  assertInvalid(validProposal({
    references: [{ type: 'current_product', rawText: '这个保险', productId: 'secret' }],
  }));
  assertInvalid(validProposal({
    confidence: { intent: 1, mentions: 1, references: 1, overall: 1 },
  }));
});

test('semantic proposal rejects invalid confidence values', () => {
  for (const score of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, '0.9']) {
    assertInvalid(validProposal({
      confidence: { intent: score, mentions: 1, references: 1 },
    }));
  }
  assertInvalid(validProposal({ confidence: { intent: 1, mentions: 1 } }));
});

test('semantic proposal rejects version, length, and collection bound violations', () => {
  assertInvalid(validProposal({ semanticContractVersion: 2 }));
  assertInvalid(validProposal({ semanticContractVersion: '1' }));
  assertInvalid(validProposal(), '保'.repeat(1_001));
  assertInvalid(validProposal({ queryAspects: Array(9).fill('renewal') }));
  assertInvalid(validProposal({ requestedSteps: Array(5).fill('lookup') }));
  assertInvalid(validProposal({
    mentions: Array.from({ length: 21 }, () => ({ type: 'product', rawText: '这个保险' })),
  }));
  assertInvalid(validProposal({
    references: Array.from({ length: 21 }, () => ({ type: 'current_product', rawText: '这个保险' })),
  }));
});

test('semantic proposal rejects sparse arrays in every collection field', () => {
  const sparseCollections = [
    ['queryAspects', Array(1)],
    ['queryAspects', ['renewal', , 'exclusions']],
    ['mentions', Array(1)],
    ['mentions', [{ type: 'product', rawText: '这个保险' }, ,]],
    ['references', Array(1)],
    ['references', [{ type: 'current_product', rawText: '这个保险' }, ,]],
    ['requestedSteps', Array(1)],
    ['requestedSteps', ['lookup', , 'continue']],
  ];

  for (const [field, value] of sparseCollections) {
    assertInvalid(validProposal({ [field]: value }));
  }
});

test('semantic proposal rejects oversized dense and sparse arrays', () => {
  assertInvalid(validProposal({ queryAspects: Array(10_000).fill('renewal') }));
  assertInvalid(validProposal({ requestedSteps: Array(10_000) }));
});

test('semantic proposal de-duplicates controlled string lists in encounter order', () => {
  const proposal = normalizeSemanticProposal(validProposal({
    queryAspects: ['renewal', 'renewal', 'exclusions'],
    requestedSteps: ['lookup', 'lookup', 'continue'],
  }), '这个保险主要保什么');

  assert.deepEqual(proposal.queryAspects, ['renewal', 'exclusions']);
  assert.deepEqual(proposal.requestedSteps, ['lookup', 'continue']);
});

test('pre-parser recognizes only high-certainty selection and upload signals', () => {
  assert.deepEqual(preparseAgentMessage('选择 2'), {
    candidateSelection: { index: 1, rawText: '选择 2' },
    operationHint: null,
  });
  assert.deepEqual(preparseAgentMessage('上传保单'), {
    candidateSelection: null,
    operationHint: 'upload_link',
  });
  assert.deepEqual(preparseAgentMessage('这个保险主要保什么'), {
    candidateSelection: null,
    operationHint: null,
  });
});

test('pre-parser accepts bounded complete selections and rejects weak or out-of-range forms', () => {
  for (const [input, index] of [
    ['选2', 1],
    ['第2款', 1],
    ['选择第2款', 1],
    ['选第2个', 1],
    ['1', 0],
    ['20', 19],
  ]) {
    assert.deepEqual(preparseAgentMessage(input), {
      candidateSelection: { index, rawText: input },
      operationHint: null,
    });
  }
  for (const input of [
    '选择 0',
    '选择 21',
    '01',
    '第01款',
    '我选择 2',
    '2号产品怎么样',
  ]) {
    assert.deepEqual(preparseAgentMessage(input), {
      candidateSelection: null,
      operationHint: null,
    });
  }
});

test('pre-parser requires both an upload action and an upload subject', () => {
  assert.equal(preparseAgentMessage('录入资料').operationHint, 'upload_link');
  assert.equal(preparseAgentMessage('上传一下').operationHint, null);
  assert.equal(preparseAgentMessage('看看保单').operationHint, null);
});

test('pre-parser does not treat explicitly negated upload actions as an operation hint', () => {
  for (const input of [
    '不上传保单',
    '不要上传保单',
    '请勿上传保单',
    '禁止录入资料',
    '暂时别录入资料',
    '不用再上传保单',
    '无需把资料录入',
    '暂不上传保单',
    '不知道怎么上传保单',
    '拒绝上传保单',
    '取消上传保单',
    '停止上传保单',
    '无法上传保单',
  ]) {
    assert.equal(preparseAgentMessage(input).operationHint, null);
  }
});

test('pre-parser preserves explicit positive upload expressions containing 不', () => {
  assert.equal(preparseAgentMessage('不得不上传保单').operationHint, 'upload_link');
  assert.equal(preparseAgentMessage('不但要上传保单').operationHint, 'upload_link');
});
