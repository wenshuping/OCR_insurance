import assert from 'node:assert/strict';
import test from 'node:test';

import { createSalesChampionTool } from '../server/sales-champion-tool.service.mjs';

function result() {
  return {
    facts: { answer: '销售建议' },
    provenance: { source: 'family_sales_chat' },
    presentation: { message: '销售建议' },
    interaction: { type: 'answer', text: '销售建议' },
  };
}

test('sales champion invokes the existing sales domain service through its agent entry', async () => {
  const calls = [];
  const tool = createSalesChampionTool({ execute(action, context) {
    calls.push({ action, context });
    return result();
  } });
  const output = await tool.askSalesChampionTool({ context: {
    internalUserId: 7, familyId: 9, intent: 'sales_coaching', tool: 'sales_report', question: '怎么跟客户沟通',
  } });
  assert.equal(calls[0].action, 'sales_report');
  assert.equal(output.provenance.domainAgent, 'sales_champion');
  assert.equal(output.provenance.agentAsTool, true);
});

test('sales champion drops raw family facts and rejects insurance expert actions', async () => {
  let received;
  const tool = createSalesChampionTool({ execute(_action, context) { received = context; return result(); } });
  await tool.askSalesChampionTool({ context: {
    internalUserId: 7, familyId: 9, intent: 'sales_coaching', question: '继续', policies: [{ id: 1 }],
    history: [
      { role: 'user', content: '上一问' },
      { role: 'system', content: 'drop' },
      { role: 'assistant', content: '上一答', secret: true },
    ],
  } });
  assert.equal(received.policies, undefined);
  assert.deepEqual(received.history, [
    { role: 'user', content: '上一问' },
    { role: 'assistant', content: '上一答' },
  ]);
  await assert.rejects(tool.askSalesChampionTool({ context: {
    internalUserId: 7, intent: 'insurance_product_knowledge', question: '产品责任',
  } }), /not allowed/u);
  await assert.rejects(tool.askSalesChampionTool({ context: {
    internalUserId: 7,
    intent: 'sales_report',
    tool: 'coverage_report',
    question: '报告',
  } }), /tool is not allowed/u);
});

test('sales champion returns a structured timeout error', async () => {
  const tool = createSalesChampionTool({ timeoutMs: 5, execute: () => new Promise(() => {}) });
  await assert.rejects(
    tool.askSalesChampionTool({ context: {
      internalUserId: 7, familyId: 9, intent: 'sales_report', question: '销售报告',
    } }),
    (error) => error.code === 'AGENT_TIMEOUT' && error.status === 504,
  );
});

test('sales champion accepts the domain generator maximum timeout', () => {
  assert.doesNotThrow(() => createSalesChampionTool({
    timeoutMs: 600_000,
    execute: async () => result(),
  }));
});
