import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachDomainAgentProvenance,
  buildDomainAgentEnvelope,
} from '../server/domain-agent-tool-contract.service.mjs';

test('domain agent envelope keeps evidence and removes unsafe channel data', () => {
  const envelope = buildDomainAgentEnvelope({
    agent: 'insurance_expert',
    requestId: 'req-1',
    taskId: 'task-1',
    answer: '客户手机号 13800138000，结论以条款为准。',
    evidence: [
      { label: '官方条款', url: 'https://official.test/terms.pdf', version: '2026-07' },
      { label: '原图', url: 'data:image/png;base64,secret' },
      { label: '本地文件', ref: '/Users/a/private/raw-ocr.json' },
    ],
    limitations: ['健康告知待核实', '身份证 330102199001011234'],
    missingInformation: ['现金价值表'],
    hiddenPrompt: 'drop',
    toolTrace: ['drop'],
  });
  assert.equal(envelope.agent, 'insurance_expert');
  assert.equal(envelope.requestId, 'req-1');
  assert.match(envelope.answer, /已脱敏/u);
  assert.doesNotMatch(envelope.answer, /13800138000/u);
  assert.deepEqual(envelope.evidence, [{
    label: '官方条款', url: 'https://official.test/terms.pdf', version: '2026-07',
  }]);
  assert.equal(JSON.stringify(envelope).includes('330102199001011234'), false);
  assert.equal(JSON.stringify(envelope).includes('hiddenPrompt'), false);
  assert.equal(JSON.stringify(envelope).includes('toolTrace'), false);
});

test('domain agent envelope rejects unknown agents and empty answers', () => {
  assert.throws(() => buildDomainAgentEnvelope({ agent: 'system', answer: 'x' }), TypeError);
  assert.throws(() => buildDomainAgentEnvelope({ agent: 'sales_champion', answer: '' }), TypeError);
});

test('domain agent provenance marks a validated handler result', () => {
  const result = attachDomainAgentProvenance({
    facts: { certainty: 'supported' },
    provenance: { source: 'official' },
    presentation: { message: '结论' },
    interaction: { type: 'answer', text: '结论' },
  }, 'insurance_expert');
  assert.deepEqual(result.provenance, {
    source: 'official', domainAgent: 'insurance_expert', agentAsTool: true,
  });
});
