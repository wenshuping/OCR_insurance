import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  createRequestMutex,
  simulationViewModel,
  shouldDiscardDirty,
  validatePolicyDraft,
} from '../src/apps/admin/pages/adminAgentPolicies.mjs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const apiSource = read('../src/api/contracts/admin.ts');
const pagesSource = read('../src/apps/admin/adminPages.ts');
const appSource = read('../src/apps/admin/AdminApp.tsx');
const pageSource = read('../src/apps/admin/pages/AdminAgentPoliciesPage.tsx');

test('admin navigation exposes Agent strategy management while page state stays outside AdminApp', () => {
  assert.match(pagesSource, /key: 'agentPolicies'/u);
  assert.match(pagesSource, /label: 'Agent 策略管理'/u);
  assert.match(appSource, /<AdminAgentPoliciesPage adminToken=\{adminToken\}/u);
  assert.doesNotMatch(appSource, /agentPolicyDraft/u);
});

test('agent strategy API contract covers versions, simulation, rollback, and redacted unknown questions', () => {
  for (const helper of [
    'getAdminAgentQuestionPolicies',
    'createAdminAgentQuestionPolicyDraft',
    'updateAdminAgentQuestionPolicyDraft',
    'simulateAdminAgentQuestionPolicy',
    'publishAdminAgentQuestionPolicyDraft',
    'rollbackAdminAgentQuestionPolicyVersion',
    'getAdminAgentUnknownQuestions',
  ]) assert.match(apiSource, new RegExp(`export function ${helper}\\b`, 'u'));
  assert.match(apiSource, /'\/api\/admin\/agent-question-policies'/u);
  assert.match(apiSource, /\/agent-unknown-questions\?/u);
  assert.match(apiSource, /policySource/u);
  assert.match(apiSource, /familyResolved/u);
  assert.match(apiSource, /previewOnly/u);
});

test('agent strategy page provides constrained editing and explicit guarded lifecycle actions', () => {
  assert.match(pageSource, /只预览、不执行/u);
  assert.match(pageSource, /未保存草稿/u);
  assert.match(pageSource, /保存草稿/u);
  assert.match(pageSource, /发布/u);
  assert.match(pageSource, /回滚/u);
  assert.match(pageSource, /window\.confirm/u);
  assert.match(pageSource, /confidenceThreshold/u);
  assert.match(pageSource, /confirmation/u);
  assert.match(pageSource, /outputMode/u);
  assert.match(pageSource, /ALLOWED_TOOLS/u);
  assert.doesNotMatch(pageSource, /system prompt|系统提示词|Prompt 编辑/iu);
});

test('simulation and unknown-question views show safe operational detail and pagination', () => {
  assert.match(pageSource, /candidateIntent/u);
  assert.match(pageSource, /requestedOperation/u);
  assert.match(pageSource, /familyResolved/u);
  assert.match(pageSource, /policySource/u);
  assert.match(pageSource, /低置信度/u);
  assert.match(pageSource, /写操作预览/u);
  assert.match(pageSource, /脱敏未知问题/u);
  assert.match(pageSource, /unknownOffset/u);
  assert.match(pageSource, /上一页/u);
  assert.match(pageSource, /下一页/u);
  assert.doesNotMatch(pageSource, /messageRef|rawQuestion/u);
});

test('dirty work is discarded only after explicit confirmation', () => {
  let confirmations = 0;
  assert.equal(shouldDiscardDirty(true, () => { confirmations += 1; return false; }), false);
  assert.equal(shouldDiscardDirty(true, () => { confirmations += 1; return true; }), true);
  assert.equal(shouldDiscardDirty(false, () => { confirmations += 1; return false; }), true);
  assert.equal(confirmations, 2);
});

test('safe fallback policies cannot be disabled or weakened', () => {
  const base = { key: 'unknown_read', intent: 'unknown_read', enabled: true, decision: 'execute', handler: 'system', operation: 'read', confirmation: 'not_required', outputMode: 'direct', tool: null, confidenceThreshold: 0 };
  assert.deepEqual(validatePolicyDraft([base, { ...base, key: 'unknown_write', intent: 'unknown_write', decision: 'reject', operation: 'write', confirmation: 'required' }]), []);
  assert.match(validatePolicyDraft([{ ...base, enabled: false }])[0], /unknown_read.*启用/u);
  assert.match(validatePolicyDraft([{ ...base, operation: 'write' }]).join(' '), /unknown_read.*read/u);
  assert.match(validatePolicyDraft([{ ...base, key: 'unknown_write', intent: 'unknown_write', decision: 'execute', operation: 'write', confirmation: 'required' }]).join(' '), /unknown_write.*reject/u);
  assert.match(validatePolicyDraft([{ ...base, confidenceThreshold: 2 }]).join(' '), /0.*1/u);
});

test('request mutex rejects double click and releases after errors', async () => {
  const mutex = createRequestMutex();
  let release;
  const pending = mutex.run(() => new Promise((resolve) => { release = resolve; }));
  assert.equal(await mutex.run(async () => 'duplicate'), undefined);
  release('done');
  assert.equal(await pending, 'done');
  await assert.rejects(mutex.run(async () => { throw new Error('save failed'); }), /save failed/u);
  assert.equal(await mutex.run(async () => 'retry'), 'retry');
});

test('simulation view model retains only safe result fields', () => {
  const model = simulationViewModel({ previewOnly: true, decision: { intent: 'coverage_report', policySource: 'draft', familyResolved: false, handler: 'insurance_expert', tool: 'coverage_report', decision: 'clarify', confirmationRequired: false, outputMode: 'structured', result: 'low_confidence', explanation: 'safe', entities: { familyName: 'secret' } } });
  assert.equal(model.lowConfidence, true);
  assert.equal(model.writePreview, false);
  assert.equal(JSON.stringify(model).includes('secret'), false);
});

test('page wires unload protection, validated publish, responsive layout and pagination parameters', () => {
  assert.match(pageSource, /beforeunload/u);
  assert.match(pageSource, /shouldDiscardDirty/u);
  assert.match(pageSource, /validatePolicyDraft/u);
  assert.match(pageSource, /disabled=\{[^}]*validationErrors\.length/u);
  assert.match(pageSource, /limit: UNKNOWN_LIMIT, offset/u);
  assert.match(pageSource, /sm:grid-cols-2/u);
  assert.match(appSource, /agentPoliciesDirty/u);
  assert.match(appSource, /window\.confirm/u);
});
