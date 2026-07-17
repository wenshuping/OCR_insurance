import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentQuestionRouter } from '../server/agent-question-router.service.mjs';
import {
  interpretSalesChampionShadowTurn,
  routeSalesChampionShadowTurn,
} from '../server/sales-champion-shadow-interpreter.service.mjs';

function createRouter() {
  const audits = [];
  const store = {
    async load() { return { familyProfiles: [], policies: [] }; },
    async getPublishedAgentQuestionPolicyVersion() { return null; },
    async recordAgentRouteAudit(audit) { audits.push(audit); },
  };
  const router = createAgentQuestionRouter({
    store,
    handlers: {
      sales_champion: async () => ({ interaction: { type: 'answer', text: '保持原来的 DeepSeek 回答。' } }),
    },
  });
  return { router, audits };
}

test('shadow interpreter produces a grounded fact-sensitive route', () => {
  const question = '客户问退保时现金价值是多少';
  const proposal = interpretSalesChampionShadowTurn({ question });
  const route = routeSalesChampionShadowTurn({ question });
  assert.equal(proposal.customerStatements[0].text, question);
  assert.equal(route.status, 'routed');
  assert.equal(route.readiness.officialFactsRequired, true);
  assert.equal(route.selection.primary.key, 'tradeoff_disclosure');
  assert.deepEqual(route.selection.supporting, [{ key: 'fact_sensitive_routing', version: 1 }]);
});

test('sales coaching persists the shadow decision without changing the customer answer', async () => {
  const { router, audits } = createRouter();
  const result = await router.route({
    internalUserId: 9,
    messageRef: 'sales-shadow-1',
    candidate: {
      intent: 'sales_coaching',
      question: '客户说太贵了，预算不够，应该怎么沟通',
      entities: {},
      contextRefs: [],
      confidence: 0.95,
      requestedOperation: 'read',
    },
  });
  assert.equal(result.interaction.text, '保持原来的 DeepSeek 回答。');
  assert.equal('salesChampionShadow' in result, false);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].salesChampionShadow.status, 'routed');
  assert.equal(audits[0].salesChampionShadow.selection.primary.key, 'five_question_diagnosis');
});

test('an explicit contact refusal is gated and never selects a skill', async () => {
  const { router, audits } = createRouter();
  await router.route({
    internalUserId: 9,
    messageRef: 'sales-shadow-2',
    candidate: {
      intent: 'sales_coaching',
      question: '客户说不要再联系我了',
      entities: {},
      contextRefs: [],
      confidence: 0.95,
      requestedOperation: 'read',
    },
  });
  assert.equal(audits[0].salesChampionShadow.status, 'gated');
  assert.equal(audits[0].salesChampionShadow.readiness.decision, 'stop_contact');
  assert.equal(audits[0].salesChampionShadow.selection, null);
});
