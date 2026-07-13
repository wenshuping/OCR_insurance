import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import {
  buildAgentPolicyImportContext,
  createAgentPolicyImportTask,
  updateAgentPolicyImportTask,
} from '../server/agent-policy-import.service.mjs';
import { createPolicyOcrApp } from '../server/app.mjs';
import { createInitialState } from '../server/policy-ocr.domain.mjs';

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function jsonFetch(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  return { response, payload: await response.json() };
}

test('agent policy import context masks identifiers and enforces versioned field completion', () => {
  const task = createAgentPolicyImportTask({
    id: 10,
    familyId: 8,
    owner: { guestId: 'guest-agent' },
    channel: 'dingtalk',
    targetAgent: 'insurance_expert',
    scan: {
      data: {
        company: '新华保险',
        name: '测试重大疾病保险',
        insured: '张小明',
        policyNumber: 'PA202612345678',
        insuredIdNumber: '330106199001011234',
        amount: 300000,
      },
      ocrText: '张小明 身份证号330106199001011234 手机号13812345678',
    },
    uploadItems: [{ name: '张小明保单.jpg', type: 'image/jpeg', size: 1200 }],
    now: '2026-07-11T08:00:00.000Z',
  });
  const context = buildAgentPolicyImportContext(task);

  assert.equal(context.status, 'final_confirmation');
  assert.equal(context.policyDraft.insured, '张**');
  assert.match(context.policyDraft.policyNumber, /5678$/u);
  assert.match(context.policyDraft.insuredIdNumber, /1234$/u);
  assert.doesNotMatch(JSON.stringify(context), /330106199001011234|PA202612345678|13812345678|"ocrText"\s*:/u);
  assert.equal(context.privacy.originalImageIncluded, false);
  assert.equal(context.privacy.hermesMemoryAllowed, false);

  assert.throws(
    () => updateAgentPolicyImportTask(task, { stateVersion: 0, action: 'confirm' }),
    (error) => error.code === 'STALE_INTERACTION',
  );
  updateAgentPolicyImportTask(task, { stateVersion: 1, action: 'confirm', now: '2026-07-11T08:01:00.000Z' });
  assert.equal(task.status, 'completed');
  assert.equal(task.stateVersion, 2);
});

test('agent policy import API persists a masked task and supplies it to the sales champion agent', async () => {
  const state = createInitialState();
  state.familyProfiles.push({
    id: 8,
    ownerGuestId: 'guest-agent',
    familyName: '测试家庭',
    status: 'active',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  });
  state.nextId = 20;
  const persisted = [];
  const salesCalls = [];
  const app = createPolicyOcrApp({
    state,
    scanner: async () => ({
      data: {
        company: '新华保险',
        name: '测试终身寿险',
        insured: '李小红',
        policyNumber: 'POLICY99887766',
        insuredIdNumber: '330106199001011234',
        paymentPeriod: '20年',
        coveragePeriod: '终身',
        amount: 500000,
      },
      ocrText: '李小红 POLICY99887766 330106199001011234 手机13812345678',
      fieldEvidence: {},
      fieldConfidence: {},
    }),
    persistStateDocument: async ({ key, value }) => persisted.push({ key, value: structuredClone(value) }),
    persistFamilyState: async () => {},
    generateFamilySalesChatReply: async ({ context, question }) => {
      salesCalls.push({ context, question });
      return { content: '已根据脱敏保单草稿整理跟进建议', model: 'test-sales-agent', generatedAt: '2026-07-11T08:02:00.000Z' };
    },
    extractFamilySalesMemories: async () => [],
    allowDingTalkPolicyUpload: true,
    recomputeCashflowOnStartup: false,
  });
  const server = await listen(app);
  try {
    const created = await jsonFetch(server.baseUrl, '/api/family-profiles/8/agent-policy-imports?guestId=guest-agent', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-agent',
        channel: 'dingtalk',
        targetAgent: 'sales_champion',
        uploadItem: { name: '客户保单.jpg', type: 'image/jpeg', size: 100, dataUrl: 'data:image/jpeg;base64,AA==' },
      }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.task.status, 'final_confirmation');
    assert.equal(created.payload.task.policyDraft.insured, '李**');
    assert.doesNotMatch(JSON.stringify(created.payload), /330106199001011234|POLICY99887766|13812345678|"ocrText"\s*:|data:image/u);
    assert.equal(persisted.at(-1).key, 'agentPolicyImportTasks');
    assert.equal(persisted.at(-1).value.length, 1);

    const taskId = created.payload.task.taskId;
    const chat = await jsonFetch(server.baseUrl, '/api/family-profiles/8/sales-chat/threads?guestId=guest-agent', {
      method: 'POST',
      body: JSON.stringify({ guestId: 'guest-agent', message: '请给我跟进建议', policyImportTaskId: taskId }),
    });
    assert.equal(chat.response.status, 201);
    assert.equal(salesCalls.length, 1);
    assert.equal(salesCalls[0].context.policyImportContext.taskId, taskId);
    assert.equal(salesCalls[0].context.policyImportContext.policyDraft.insured, '李**');
    assert.doesNotMatch(JSON.stringify(salesCalls[0].context.policyImportContext), /330106199001011234|POLICY99887766|"ocrText"\s*:/u);
  } finally {
    await server.close();
  }
});
