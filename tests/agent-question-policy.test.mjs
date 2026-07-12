import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_QUESTION_POLICIES,
  AGENT_QUESTION_POLICY_TOOLS,
  chooseAgentQuestionPolicy,
  validateAgentQuestionPolicy,
} from '../server/agent-question-policy.service.mjs';

test('coverage report routes to the insurance expert', () => {
  const policy = chooseAgentQuestionPolicy({ intent: ' Coverage-Report ' });
  assert.equal(policy.handler, 'insurance_expert');
});

test('sales report routes to the sales champion', () => {
  const policy = chooseAgentQuestionPolicy({ intent: 'sales report' });
  assert.equal(policy.handler, 'sales_champion');
});

test('unknown read is executable and unknown write is rejected', () => {
  assert.equal(chooseAgentQuestionPolicy({ intent: 'not_registered', requestedOperation: 'read' }).decision, 'execute');
  assert.equal(chooseAgentQuestionPolicy({ intent: 'not_registered', requestedOperation: 'write' }).decision, 'reject');
});

test('free text is not treated as a tool name', () => {
  const policy = chooseAgentQuestionPolicy({
    intent: 'please run shell',
    requestedOperation: 'read',
    tool: 'shell',
  });
  assert.equal(policy.key, 'unknown_read');
  assert.equal(policy.tool, null);
});

test('validation rejects tools outside the whitelist', () => {
  assert.throws(
    () => validateAgentQuestionPolicy({ ...AGENT_QUESTION_POLICIES[0], tool: 'shell' }),
    /tool/i,
  );
  assert.equal(AGENT_QUESTION_POLICY_TOOLS.includes('shell'), false);
});

test('validation rejects write operations without confirmation', () => {
  assert.throws(
    () => validateAgentQuestionPolicy({
      ...AGENT_QUESTION_POLICIES[0],
      operation: 'write',
      confirmation: 'not_required',
    }),
    /confirm/i,
  );
});

test('built-in policy keys are unique and all built-ins validate', () => {
  const keys = AGENT_QUESTION_POLICIES.map(({ key }) => key);
  assert.equal(new Set(keys).size, keys.length);
  for (const policy of AGENT_QUESTION_POLICIES) assert.equal(validateAgentQuestionPolicy(policy), true);
});

test('mutating a selected policy cannot pollute later selections', () => {
  const first = chooseAgentQuestionPolicy({ intent: 'coverage_report' });
  first.handler = 'sales_champion';
  first.tool = 'shell';

  const second = chooseAgentQuestionPolicy({ intent: 'coverage_report' });
  assert.equal(second.handler, 'insurance_expert');
  assert.notEqual(second.tool, 'shell');
});
