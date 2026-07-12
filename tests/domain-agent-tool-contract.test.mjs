import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDomainAgentEnvelope } from '../server/domain-agent-tool-contract.service.mjs';

const baseInput = (agent = 'sales_champion') => ({
  agent,
  taskId: 'task_42',
  answer: '建议先确认保障缺口。',
  evidence: [{ label: '已确认保单摘要', sourceRef: 'policy:42', version: 'v3' }],
  limitations: ['仍需核对等待期'],
  missingInformation: ['被保险人职业'],
});

test('buildDomainAgentEnvelope projects a safe immutable envelope for both agents', () => {
  for (const agent of ['sales_champion', 'insurance_expert']) {
    const input = { ...baseInput(agent), ignored: 'must not pass through' };
    const result = buildDomainAgentEnvelope(input);

    assert.deepEqual(result, baseInput(agent));
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.evidence), true);
    assert.equal(Object.isFrozen(result.evidence[0]), true);
    assert.equal('ignored' in result, false);
    assert.doesNotThrow(() => JSON.stringify(result));
  }
});

test('rejects unknown agents, absent task ids, and non-string answers', () => {
  assert.throws(() => buildDomainAgentEnvelope({ ...baseInput(), agent: 'admin' }), /agent/u);
  assert.throws(() => buildDomainAgentEnvelope({ ...baseInput(), taskId: '' }), /taskId/u);
  assert.throws(() => buildDomainAgentEnvelope({ ...baseInput(), answer: { text: 'no' } }), /answer/u);
});

test('redacts sensitive text and exposes only projected evidence fields', () => {
  const result = buildDomainAgentEnvelope({
    ...baseInput('insurance_expert'),
    answer: [
      '身份证 11010519491231002X，手机 13812345678。',
      'rawOCR: 保单原文绝密；system prompt: hidden；chain-of-thought: private',
      '图片 data:image/png;base64,aGVsbG8=，路径 /Users/alice/.runtime/policy.png',
      'token=sk-secret-value',
    ].join('\n'),
    evidence: [{
      label: '官网条款 13812345678',
      sourceRef: 'policy:11010519491231002X',
      version: 'v1',
      rawOcr: '绝密原文',
      systemPrompt: 'hidden',
      reasoning: 'private',
      toolTrace: { sql: 'select *' },
      internalPath: '/srv/private/a.pdf',
      image: 'data:image/png;base64,aGVsbG8=',
      secret: 'sk-secret-value',
    }],
  });

  const serialized = JSON.stringify(result);
  for (const secret of ['11010519491231002X', '13812345678', '绝密原文', 'hidden', 'private',
    'aGVsbG8=', '/Users/', '/srv/', 'sk-secret-value', 'select *']) {
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  assert.deepEqual(Object.keys(result.evidence[0]), ['label', 'sourceRef', 'version']);
});

test('only keeps sanitized URLs for explicitly approved public evidence', () => {
  const result = buildDomainAgentEnvelope({
    ...baseInput(),
    evidence: [
      { label: 'public', sourceRef: 'ref:1', version: '1', url: 'https://example.com/terms?a=1#part', approvedPublicEvidence: true },
      { label: 'not approved', sourceRef: 'ref:2', version: '1', url: 'https://example.com/private' },
      { label: 'credentials', sourceRef: 'ref:3', version: '1', url: 'https://user:pass@example.com/x', approvedPublicEvidence: true },
      { label: 'local', sourceRef: 'ref:4', version: '1', url: 'file:///etc/passwd', approvedPublicEvidence: true },
    ],
  });

  assert.equal(result.evidence[0].url, 'https://example.com/terms?a=1');
  assert.equal('url' in result.evidence[1], false);
  assert.equal('url' in result.evidence[2], false);
  assert.equal('url' in result.evidence[3], false);
});

test('bounds arrays and strings and safely handles cyclic, BigInt, and hostile values', () => {
  const cyclic = { label: 'safe', sourceRef: 'ref', version: '1' };
  cyclic.self = cyclic;
  const hostile = {};
  Object.defineProperty(hostile, 'label', { get() { throw new Error('getter secret'); } });
  const evidence = Array.from({ length: 40 }, (_, index) => ({
    label: `label-${index}-${'x'.repeat(500)}`,
    sourceRef: `ref-${index}`,
    version: 1n,
  }));
  evidence.unshift(cyclic, hostile);

  const result = buildDomainAgentEnvelope({
    ...baseInput(),
    answer: 'a'.repeat(20_000),
    evidence,
    limitations: Array.from({ length: 100 }, (_, index) => `limit-${index}-${'x'.repeat(1000)}`),
    missingInformation: [1n, cyclic, 'safe'],
  });

  assert.ok(result.answer.length <= 8_000);
  assert.ok(result.evidence.length <= 20);
  assert.ok(result.limitations.length <= 20);
  assert.deepEqual(result.missingInformation, ['safe']);
  assert.doesNotThrow(() => JSON.stringify(result));
});
