import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentPolicyImportTask } from '../server/agent-policy-import.service.mjs';
import { createSalesChampionTool } from '../server/sales-champion-tool.service.mjs';
import { createWukongMcpGateway } from '../server/wukong-mcp-gateway.service.mjs';

function stateFor() {
  return {
    users: [{ id: 7, name: '顾问', status: 'active' }],
    userDingtalkIdentities: [{ corpId: 'corp', dingUserId: 'ding', userId: 7, status: 'active' }],
    familyProfiles: [{ id: 11, ownerUserId: 7, status: 'active', planningProfile: {} }, { id: 12, ownerUserId: 8, status: 'active' }],
    familyMembers: [{ id: 21, familyId: 11, name: '张先生', status: 'active' }],
    policies: [{ id: 31, familyId: 11, userId: 7, name: '安心保', insured: '张先生' }],
    familyReports: [], familySalesReviews: [], agentPolicyImportTasks: [],
    knowledgeRecords: [], insuranceIndicatorRecords: [], optionalResponsibilityRecords: [],
    familySalesMemories: [
      { id: 41, familyId: 11, ownerUserId: 7, kind: 'preference', content: '偏好简洁说明', status: 'confirmed' },
      { id: 42, familyId: 11, ownerUserId: 7, kind: 'todo', content: '候选记忆', status: 'candidate' },
      { id: 43, familyId: 11, ownerUserId: 8, kind: 'todo', content: '他人记忆', status: 'confirmed' },
    ],
  };
}

test('resolves owned facts and injects only current confirmed memories', async () => {
  let received;
  const ask = createSalesChampionTool({ state: stateFor(), generateReply: async (input) => { received = input; return { content: '建议先核实预算。' }; } });
  const result = await ask({ owner: { userId: 7 }, familyRef: 11, question: '如何推进？', requestId: 'req-1' });
  assert.equal(result.taskId, 'req-1');
  assert.match(JSON.stringify(received.context), /偏好简洁说明/);
  assert.doesNotMatch(JSON.stringify(received.context), /候选记忆|他人记忆/);
});

test('rejects foreign families, mismatched tasks, and caller-forged facts', async () => {
  const state = stateFor();
  state.agentPolicyImportTasks.push({ id: 51, familyId: 12, ownerUserId: 7 });
  const ask = createSalesChampionTool({ state, generateReply: async () => ({ content: 'ok' }) });
  await assert.rejects(ask({ owner: { userId: 7 }, familyRef: 12, question: '问题' }), { code: 'FAMILY_NOT_FOUND' });
  await assert.rejects(ask({ owner: { userId: 7 }, familyRef: 11, policyImportTaskId: 51, question: '问题' }), { code: 'POLICY_IMPORT_NOT_FOUND' });
  const gateway = createWukongMcpGateway({ state, salesChampion: ask });
  await assert.rejects(gateway.invoke({ corpId: 'corp', dingUserId: 'ding', conversationType: 'direct', requestId: 'forged', tool: 'ask_sales_champion', input: { familyRef: 11, question: '问题', familyFacts: {} } }), { code: 'INVALID_TOOL_INPUT' });
});

test('injects only the masked policy import projection', async () => {
  const state = stateFor();
  state.agentPolicyImportTasks.push(createAgentPolicyImportTask({
    id: 51, familyId: 11, owner: { userId: 7 },
    draft: { company: '可信保险', name: '安心保', insured: '张小明', policyNumber: 'POLICY-SECRET-7788', insuredIdNumber: '110101199001011234', plans: [] },
  }));
  let serializedContext = '';
  const ask = createSalesChampionTool({ state, generateReply: async ({ context }) => { serializedContext = JSON.stringify(context); return { content: '请核实草稿。' }; } });
  await ask({ owner: { userId: 7 }, familyRef: 11, policyImportTaskId: 51, question: '核实草稿' });
  assert.match(serializedContext, /maskedForChannel/);
  assert.doesNotMatch(serializedContext, /张小明|POLICY-SECRET-7788|110101199001011234|rawOcr|documents/);
});

test('timeout is stable and does not mutate tasks or memories', async () => {
  const state = stateFor();
  const before = structuredClone([state.agentPolicyImportTasks, state.familySalesMemories]);
  const ask = createSalesChampionTool({ state, timeoutMs: 5, generateReply: () => new Promise(() => {}) });
  await assert.rejects(ask({ owner: { userId: 7 }, familyRef: 11, question: '问题' }), { code: 'AGENT_TIMEOUT', status: 504 });
  assert.deepEqual([state.agentPolicyImportTasks, state.familySalesMemories], before);
});

test('MCP uses strict schema and injects the outer request id', async () => {
  const state = stateFor();
  let received;
  const gateway = createWukongMcpGateway({ state, salesChampion: async (input) => { received = input; return { answer: 'ok' }; } });
  await gateway.invoke({ corpId: 'corp', dingUserId: 'ding', conversationType: 'direct', requestId: 'outer', tool: 'ask_sales_champion', input: { familyRef: 11, question: '问题' } });
  assert.equal(received.requestId, 'outer');
  assert.deepEqual(Object.keys(received).sort(), ['familyRef', 'owner', 'question', 'requestId']);
  await assert.rejects(gateway.invoke({ corpId: 'corp', dingUserId: 'ding', conversationType: 'direct', requestId: 'forged-id', tool: 'ask_sales_champion', input: { familyRef: 11, question: '问题', requestId: 'caller' } }), { code: 'INVALID_TOOL_INPUT' });
});
