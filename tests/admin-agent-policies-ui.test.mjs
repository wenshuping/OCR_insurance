import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  createRequestMutex,
  policyValidationViewModel,
  createLatestRequestController,
  createLifecycleController,
  normalizePolicyIdentifier,
  unknownQuestionViewModel,
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
  assert.match(pageSource, /未知问题统计/u);
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

test('policy validation is gated until the policy request succeeds', () => {
  assert.deepEqual(policyValidationViewModel({ loading: true, loadError: '', policies: [] }), { ready: false, errors: [] });
  assert.deepEqual(policyValidationViewModel({ loading: false, loadError: '读取失败', policies: [] }), { ready: false, errors: [] });
  assert.deepEqual(policyValidationViewModel({ loading: false, loadError: '', loaded: false, policies: [] }), { ready: false, errors: [] });
  const loaded = policyValidationViewModel({ loading: false, loadError: '', loaded: true, policies: [] });
  assert.equal(loaded.ready, true);
  assert.match(loaded.errors[0], /至少需要一条/u);
});

test('latest request controller rejects stale and post-cleanup commits', () => {
  const controller = createLatestRequestController();
  const first = controller.begin();
  const second = controller.begin();
  let commits = 0;
  assert.equal(first.commit(() => { commits += 1; }), false);
  assert.equal(second.commit(() => { commits += 1; }), true);
  controller.dispose();
  assert.equal(second.commit(() => { commits += 1; }), false);
  assert.equal(commits, 1);
});

test('token lifecycle prevents stale save and simulation completions from interrupting the new token load', async () => {
  const lifecycle = createLifecycleController();
  const tokenA = lifecycle.activate('token-a');
  const saveA = lifecycle.capture('token-a');
  const simulationA = lifecycle.capture('token-a');
  let resolveSave;
  let resolveSimulation;
  let state = '';
  let reloads = 0;
  const savePending = new Promise((resolve) => { resolveSave = resolve; }).then(() => {
    saveA.commit(() => { state = 'stale-save'; });
    saveA.run(() => { reloads += 1; });
  });
  const simulationPending = new Promise((resolve) => { resolveSimulation = resolve; }).then(() => simulationA.commit(() => { state = 'stale-simulation'; }));
  const tokenB = lifecycle.activate('token-b');
  assert.equal(tokenB.commit(() => { state = 'token-b-load'; }), true);
  resolveSave();
  resolveSimulation();
  await Promise.all([savePending, simulationPending]);
  assert.equal(state, 'token-b-load');
  assert.equal(reloads, 0);
  tokenB.invalidate();
  assert.equal(tokenB.commit(() => { state = 'after-cleanup'; }), false);
  assert.equal(tokenA.commit(() => { state = 'old-token'; }), false);
});

test('unknown question view model never carries raw or normalized question text', () => {
  const model = unknownQuestionViewModel({ id: 1, userRef: 'user_01', question: '张三 北京 name@example.com 6222020202020202', normalizedQuestion: 'secret', category: 'unrecognized_question', fallbackDecision: 'manual_review', occurrenceCount: 3, status: 'open', createdAt: '2026-01-01' });
  assert.deepEqual(model, { id: 1, userRef: 'user_01', category: 'unrecognized_question', fallbackDecision: 'manual_review', occurrenceCount: 3, status: 'open', createdAt: '2026-01-01' });
  assert.equal(JSON.stringify(model).includes('张三'), false);
});

test('policy duplicate normalization mirrors backend intent normalization', () => {
  assert.equal(normalizePolicyIdentifier(' FOO BAR '), 'foo_bar');
  assert.equal(normalizePolicyIdentifier('foo-bar'), 'foo_bar');
  const base = { key: 'unknown_read', intent: 'unknown_read', decision: 'execute', handler: 'system', operation: 'read', confirmation: 'not_required', outputMode: 'direct', tool: null };
  const errors = validatePolicyDraft([base, { ...base, key: 'foo-bar', intent: 'Foo Bar' }, { ...base, key: 'FOO BAR', intent: 'foo-bar' }]).join(' ');
  assert.match(errors, /key 重复/u);
  assert.match(errors, /intent 重复/u);
});

test('page wires unload protection, validated publish, responsive layout and pagination parameters', () => {
  assert.match(pageSource, /beforeunload/u);
  assert.match(pageSource, /shouldDiscardDirty/u);
  assert.match(pageSource, /policyValidationViewModel/u);
  assert.match(pageSource, /disabled=\{[^}]*validationErrors\.length/u);
  assert.match(pageSource, /limit: UNKNOWN_LIMIT, offset/u);
  assert.match(pageSource, /sm:grid-cols-2/u);
  assert.match(appSource, /agentPoliciesDirty/u);
  assert.match(appSource, /window\.confirm/u);
});
