import assert from 'node:assert/strict';
import test from 'node:test';

import { guardAgentFinalReply } from '../server/agent-final-response-guard.service.mjs';

const toolResults = [{ result: { interaction: { type: 'answer', text: '计划一免赔额为1万元，计划二为2万元。' } } }];

test('final response guard accepts wording that preserves verified numeric facts', () => {
  assert.deepEqual(guardAgentFinalReply({ finalReply: '计划一是1万元，计划二是2万元。', toolResults }), {
    reply: '计划一是1万元，计划二是2万元。', fallbackUsed: false,
  });
});

test('final response guard falls back to the verified tool answer for invented numeric facts', () => {
  assert.deepEqual(guardAgentFinalReply({ finalReply: '计划一免赔额为5万元。', toolResults }), {
    reply: '计划一免赔额为1万元，计划二为2万元。',
    fallbackUsed: true,
    reason: 'unsupported_numeric_fact',
  });
});

test('final response guard preserves authoritative tool output marked for verbatim delivery', () => {
  const authoritative = [
    '### 责任明细（1项）',
    '1. **身故保险金**',
    '触发条件：被保险人身故',
    'calculationStatus: claim_contingent',
    '来源：src_1',
    '计算所需保单信息：基本保险金额',
  ].join('\n');
  const result = guardAgentFinalReply({
    finalReply: '身故时按合同约定给付。',
    toolResults: [{ result: { interaction: {
      type: 'answer',
      text: authoritative,
      delivery: 'verbatim',
    } } }],
  });

  assert.deepEqual(result, {
    reply: authoritative,
    fallbackUsed: true,
    reason: 'authoritative_tool_output',
  });
});
