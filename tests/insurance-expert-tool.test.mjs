import assert from 'node:assert/strict';
import test from 'node:test';

import { createInsuranceExpertTool } from '../server/insurance-expert-tool.service.mjs';

function result() {
  return {
    facts: { certainty: 'supported' },
    provenance: { source: 'official' },
    presentation: { message: '保险结论' },
    interaction: { type: 'answer', text: '保险结论' },
  };
}

test('insurance expert invokes only an allowed private domain action', async () => {
  const calls = [];
  const tool = createInsuranceExpertTool({ execute(action, context) {
    calls.push({ action, context });
    return result();
  } });
  const output = await tool.askInsuranceExpertTool({ context: {
    internalUserId: 7,
    intent: 'insurance_product_knowledge',
    question: '比较两款产品',
    resolvedProducts: [
      { canonicalProductId: 'a', company: '甲保险', officialName: '甲产品' },
      { canonicalProductId: 'b', company: '乙保险', officialName: '乙产品' },
    ],
    queryAspects: ['comparison'],
    tool: 'product_knowledge_search',
  } });
  assert.equal(calls[0].action, 'product_knowledge_search');
  assert.equal(output.provenance.domainAgent, 'insurance_expert');
  assert.equal(output.provenance.agentAsTool, true);
});

test('insurance expert drops caller-supplied raw facts and rejects other agent intents', async () => {
  let received;
  const tool = createInsuranceExpertTool({ execute(_action, context) { received = context; return result(); } });
  await tool.askInsuranceExpertTool({ context: {
    internalUserId: 7, intent: 'insurance_product_knowledge', question: '查询', rawOcr: 'secret',
  } });
  assert.equal(received.rawOcr, undefined);
  await assert.rejects(tool.askInsuranceExpertTool({ context: {
    internalUserId: 7, intent: 'sales_coaching', question: '话术',
  } }), /not allowed/u);
  await assert.rejects(tool.askInsuranceExpertTool({ context: {
    internalUserId: 7,
    intent: 'insurance_product_knowledge',
    tool: 'create_upload_link',
    question: '查询',
  } }), /tool is not allowed/u);
});

test('insurance expert returns a structured timeout error', async () => {
  const tool = createInsuranceExpertTool({
    timeoutMs: 5,
    execute: () => new Promise(() => {}),
  });
  await assert.rejects(
    tool.askInsuranceExpertTool({ context: {
      internalUserId: 7, intent: 'coverage_report', question: '保障报告', familyId: 1,
    } }),
    (error) => error.code === 'AGENT_TIMEOUT' && error.status === 504,
  );
});
