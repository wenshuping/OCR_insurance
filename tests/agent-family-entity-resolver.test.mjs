import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentFamilyEntityResolver } from '../server/agent-family-entity-resolver.service.mjs';
import { decideSemanticReadiness } from '../server/agent-semantic-readiness.service.mjs';

function familyProposal(overrides = {}) {
  return {
    intent: 'family_summary',
    operation: 'read',
    confidence: { intent: 0.95 },
    ...overrides,
  };
}

test('family resolver requires an injected authorization loader and a positive user id', async () => {
  assert.throws(() => createAgentFamilyEntityResolver(), TypeError);
  const resolver = createAgentFamilyEntityResolver({ listAuthorizedFamilies: async () => [] });
  await assert.rejects(() => resolver.resolve({ internalUserId: 0 }), TypeError);
});

test('resolves one exact normalized family name from the current authorized set', async () => {
  let calls = 0;
  const resolver = createAgentFamilyEntityResolver({
    listAuthorizedFamilies: async ({ internalUserId }) => {
      calls += 1;
      assert.equal(internalUserId, 7);
      return [{ id: 12, familyName: '张三家庭', secret: 'not-public' }];
    },
  });

  assert.deepEqual(await resolver.resolve({
    internalUserId: 7,
    mentions: [{ type: 'family', rawText: ' 张三，家庭 ' }],
  }), {
    status: 'resolved',
    entity: { familyId: 12, displayName: '张三家庭', matchType: 'exact', confidence: 1 },
    candidates: [],
  });
  assert.equal(calls, 1);
});

test('never returns an unauthorized family and does not trust caller family ids', async () => {
  const resolver = createAgentFamilyEntityResolver({
    listAuthorizedFamilies: async () => [{ familyId: 1, displayName: '李四家庭' }],
  });

  assert.deepEqual(await resolver.resolve({
    internalUserId: 3,
    mentions: [{ type: 'family', rawText: '王五家庭', familyId: 999 }],
  }), { status: 'not_found', entity: null, candidates: [] });
});

test('keeps a single prefix recall ambiguous instead of auto executing it', async () => {
  const resolver = createAgentFamilyEntityResolver({
    listAuthorizedFamilies: async () => [{ id: 8, familyName: '王小明家庭' }],
  });

  assert.deepEqual(await resolver.resolve({
    internalUserId: 3,
    mentions: [{ type: 'family', rawText: '王小明家' }],
  }), {
    status: 'ambiguous',
    entity: null,
    candidates: [{ familyId: 8, displayName: '王小明家庭', matchType: 'prefix', confidence: 0.8 }],
  });
});

test('reauthorizes active family context on every turn and rejects stale context', async () => {
  let authorized = true;
  const resolver = createAgentFamilyEntityResolver({
    listAuthorizedFamilies: async () => authorized ? [{ id: 22, familyName: '赵六家庭' }] : [],
  });
  const activeFamily = { familyId: 22, displayName: 'untrusted stale label', secret: true };

  assert.deepEqual(await resolver.resolve({ internalUserId: 9, activeFamily }), {
    status: 'resolved',
    entity: { familyId: 22, displayName: '赵六家庭', matchType: 'contextual', confidence: 1 },
    candidates: [],
  });
  authorized = false;
  assert.deepEqual(await resolver.resolve({ internalUserId: 9, activeFamily }), {
    status: 'missing', entity: null, candidates: [],
  });
});

test('filters invalid, archived, and duplicate rows and bounds public candidates', async () => {
  const rows = [
    { id: 1, familyName: '测试甲家庭', extra: 'private' },
    { id: 1, familyName: '测试甲家庭副本' },
    { id: 2, familyName: '测试二家庭', status: 'archived' },
    { id: -1, familyName: '测试坏家庭' },
    { id: 3, familyName: '' },
    ...Array.from({ length: 14 }, (_, index) => ({ id: 10 + index, familyName: `测试${index}家庭` })),
  ];
  const resolver = createAgentFamilyEntityResolver({ listAuthorizedFamilies: async () => rows });
  const result = await resolver.resolve({
    internalUserId: 1,
    mentions: [{ type: 'family', rawText: '测试' }],
  });

  assert.equal(result.status, 'ambiguous');
  assert.equal(result.entity, null);
  assert.equal(result.candidates.length, 10);
  assert.equal(new Set(result.candidates.map((candidate) => candidate.familyId)).size, 10);
  for (const candidate of result.candidates) {
    assert.deepEqual(Object.keys(candidate), ['familyId', 'displayName', 'matchType', 'confidence']);
    assert.notEqual(candidate.familyId, 2);
  }
});

test('treats a non-array loader response as no authorized families', async () => {
  const resolver = createAgentFamilyEntityResolver({ listAuthorizedFamilies: async () => ({ id: 1 }) });
  assert.deepEqual(await resolver.resolve({
    internalUserId: 1,
    mentions: [{ type: 'family', rawText: '张三' }],
  }), { status: 'not_found', entity: null, candidates: [] });
});

test('readiness clarifies when a required product is missing despite high intent confidence', () => {
  assert.deepEqual(decideSemanticReadiness({
    proposal: familyProposal({ intent: 'insurance_product_knowledge' }),
    resolutions: { product: { status: 'missing' } },
    runtime: 'hermes',
  }), {
    decision: 'clarify', decisionReason: 'product_required', missingFields: ['product'], ambiguities: [],
  });
});

test('readiness prioritizes ambiguity over another missing required resolution', () => {
  assert.deepEqual(decideSemanticReadiness({
    proposal: familyProposal(),
    resolutions: { family: { status: 'ambiguous' }, product: { status: 'missing' } },
    runtime: 'hermes',
  }), {
    decision: 'clarify', decisionReason: 'entity_ambiguous', missingFields: [], ambiguities: ['family'],
  });
});

test('direct and rule runtimes cannot advance write operations', () => {
  for (const runtime of ['direct', 'rule']) {
    assert.deepEqual(decideSemanticReadiness({
      proposal: familyProposal({ operation: 'write' }),
      resolutions: { family: { status: 'resolved' } },
      runtime,
    }), {
      decision: 'clarify', decisionReason: 'unsafe_fallback_operation', missingFields: [], ambiguities: [],
    });
  }
});

test('Hermes write proposals may advance only to the existing confirmation router', () => {
  assert.deepEqual(decideSemanticReadiness({
    proposal: familyProposal({ operation: 'write' }),
    resolutions: { family: { status: 'resolved' } },
    runtime: 'hermes',
  }), {
    decision: 'execute', decisionReason: 'unique_authorized_entity', missingFields: [], ambiguities: [],
  });
});

test('low or invalid intent confidence cannot execute', () => {
  for (const confidence of [0.69, Number.NaN, Number.POSITIVE_INFINITY, -1, 2]) {
    assert.deepEqual(decideSemanticReadiness({
      proposal: familyProposal({ confidence: { intent: confidence } }),
      resolutions: { family: { status: 'resolved' } },
      runtime: 'hermes',
    }), {
      decision: 'clarify', decisionReason: 'low_intent_confidence', missingFields: [], ambiguities: [],
    });
  }
});

test('missing proposal and unsupported runtime fail closed', () => {
  assert.deepEqual(decideSemanticReadiness({}), {
    decision: 'retry_later', decisionReason: 'semantic_proposal_unavailable', missingFields: [], ambiguities: [],
  });
  assert.deepEqual(decideSemanticReadiness({ proposal: familyProposal(), runtime: 'other' }), {
    decision: 'retry_later', decisionReason: 'unsupported_runtime', missingFields: [], ambiguities: [],
  });
});

test('unsupported intent is rejected and entity-free intents are ready', () => {
  assert.deepEqual(decideSemanticReadiness({
    proposal: familyProposal({ intent: 'invented_intent' }), runtime: 'hermes',
  }), {
    decision: 'reject', decisionReason: 'unsupported_intent', missingFields: [], ambiguities: [],
  });
  for (const intent of ['chat', 'family_list', 'upload_link']) {
    assert.deepEqual(decideSemanticReadiness({
      proposal: familyProposal({ intent }), runtime: 'hermes',
    }), {
      decision: 'execute', decisionReason: 'semantic_ready', missingFields: [], ambiguities: [],
    });
  }
});
