import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

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
