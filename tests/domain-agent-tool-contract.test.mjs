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

test('rejects non-plain and proxied envelope roots with a stable error', () => {
  class Envelope extends Object {}
  const invalidRoots = [[], () => baseInput(), new Envelope(), new Proxy(baseInput(), {})];
  for (const input of invalidRoots) {
    assert.throws(
      () => buildDomainAgentEnvelope(input),
      (error) => error?.code === 'INVALID_DOMAIN_AGENT_ENVELOPE' && error?.field === 'envelope',
    );
  }
});

test('redacts sensitive text and exposes only projected evidence fields', () => {
  const result = buildDomainAgentEnvelope({
    ...baseInput('insurance_expert'),
    answer: '身份证 11010519491231002X，手机 13812345678。图片 data:image/png;base64,aGVsbG8=，路径 /Users/alice/.runtime/policy.png',
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

test('fails closed on multiline sensitive blocks without leaking continuations', () => {
  for (const answer of [
    '可展示结论\nraw OCR:\n第一行秘密\n第二行秘密\n结尾也不能泄漏',
    '可展示结论\nsystem prompt:\n秘密规则\nreasoning:\n私有推理\n普通尾行',
    'hidden prompt =\n秘密\ntool trace:\nSQL 和 token\n尾行',
    'chain-of-thought:\nstep one\nstep two',
  ]) {
    assert.throws(
      () => buildDomainAgentEnvelope({ ...baseInput(), answer }),
      (error) => error?.code === 'INVALID_DOMAIN_AGENT_ENVELOPE' && error?.field === 'answer',
    );
  }
});

test('evidence schema rejects non-arrays and every malformed entry with a stable error', () => {
  const invalidEvidence = [
    {}, null, 'not-an-array',
    [{ label: 'label', sourceRef: 'ref' }],
    [{ label: 'label', sourceRef: 'ref', version: 1 }],
    [{ label: '', sourceRef: 'ref', version: '1' }],
    [{ label: 'label', sourceRef: {}, version: '1' }],
  ];
  for (const evidence of invalidEvidence) {
    assert.throws(
      () => buildDomainAgentEnvelope({ ...baseInput(), evidence }),
      (error) => error?.code === 'INVALID_DOMAIN_AGENT_ENVELOPE' && error?.field === 'evidence',
    );
  }
});

test('only keeps URLs authorized by a server-configured exact or subdomain host policy', () => {
  const result = buildDomainAgentEnvelope({
    ...baseInput(),
    evidence: [
      { label: 'public', sourceRef: 'ref:1', version: '1', url: 'https://example.com/terms?a=1#part', approvedPublicEvidence: true },
      { label: 'subdomain', sourceRef: 'ref:2', version: '1', url: 'https://docs.insurer.test/terms' },
      { label: 'caller approval is insufficient', sourceRef: 'ref:3', version: '1', url: 'https://evil.test/private', approvedPublicEvidence: true },
    ],
  }, {
    allowedEvidenceHosts: [
      'example.com',
      { host: 'insurer.test', allowSubdomains: true },
    ],
  });

  assert.equal(result.evidence[0].url, 'https://example.com/terms?a=1');
  assert.equal(result.evidence[1].url, 'https://docs.insurer.test/terms');
  assert.equal('url' in result.evidence[2], false);
});

test('data URL detection is deterministic across repeated and reordered evidence URLs', () => {
  const unsafe = 'https://example.com/terms?image=data:image/png;base64,aGVsbG8=';
  for (const urls of [
    [unsafe, unsafe, 'https://example.com/safe'],
    ['https://example.com/safe', unsafe, unsafe],
  ]) {
    const result = buildDomainAgentEnvelope({
      ...baseInput(),
      evidence: urls.map((url, index) => ({ label: `item ${index}`, sourceRef: `ref:${index}`, version: '1', url })),
    }, { allowedEvidenceHosts: ['example.com'] });
    assert.equal(result.evidence.filter((item) => 'url' in item).length, 1);
    assert.equal(result.evidence.find((item) => item.url)?.url, 'https://example.com/safe');
  }
});

test('drops URLs by default and rejects URL metadata and non-public host forms', () => {
  const urls = [
    'https://example.com:8443/x',
    'https://user:pass@example.com/x',
    'http://example.com/x',
    'file:///etc/passwd',
    'https://127.0.0.1/x',
    'https://2130706433/x',
    'https://0x7f000001/x',
    'https://[::1]/x',
    'https://localhost/x',
    'https://service.local/x',
  ];
  const evidence = urls.map((url, index) => ({ label: `item ${index}`, sourceRef: `ref:${index}`, version: '1', url }));
  const noPolicy = buildDomainAgentEnvelope({ ...baseInput(), evidence });
  assert.equal(noPolicy.evidence.every((item) => !('url' in item)), true);

  const withPolicy = buildDomainAgentEnvelope({ ...baseInput(), evidence }, {
    allowedEvidenceHosts: ['example.com', '127.0.0.1', 'localhost', 'service.local'],
  });
  assert.equal(withPolicy.evidence.every((item) => !('url' in item)), true);
});

test('allows an explicit nonstandard port or a server URL resolver', () => {
  const input = {
    ...baseInput(),
    evidence: [
      { label: 'port', sourceRef: 'ref:1', version: '1', url: 'https://example.com:8443/x' },
      { label: 'resolver', sourceRef: 'ref:2', version: '1', url: 'https://resolver.test/x' },
    ],
  };
  const result = buildDomainAgentEnvelope(input, {
    allowedEvidenceHosts: [{ host: 'example.com', ports: [8443] }],
    approveEvidenceUrl: ({ hostname }) => hostname === 'resolver.test',
  });
  assert.equal(result.evidence[0].url, 'https://example.com:8443/x');
  assert.equal(result.evidence[1].url, 'https://resolver.test/x');
});

test('bounds arrays and strings and safely handles cyclic, BigInt, and hostile values', () => {
  const cyclic = { label: 'safe', sourceRef: 'ref', version: '1' };
  cyclic.self = cyclic;
  const evidence = Array.from({ length: 19 }, (_, index) => ({
    label: `label-${index}-${'x'.repeat(500)}`,
    sourceRef: `ref-${index}`,
    version: '1',
  }));
  evidence.unshift(cyclic);

  const result = buildDomainAgentEnvelope({
    ...baseInput(),
    answer: 'a'.repeat(20_000),
    evidence,
    limitations: Array.from({ length: 20 }, (_, index) => `limit-${index}-${'x'.repeat(1000)}`),
    missingInformation: ['safe'],
  });

  assert.ok(result.answer.length <= 8_000);
  assert.ok(result.evidence.length <= 20);
  assert.ok(result.limitations.length <= 20);
  assert.deepEqual(result.missingInformation, ['safe']);
  assert.doesNotThrow(() => JSON.stringify(result));

  const hostile = {};
  Object.defineProperty(hostile, 'label', { get() { throw new Error('getter secret'); } });
  assert.throws(
    () => buildDomainAgentEnvelope({ ...baseInput(), evidence: [hostile] }),
    (error) => error?.code === 'INVALID_DOMAIN_AGENT_ENVELOPE' && !String(error).includes('getter secret'),
  );

  const hostileEvidence = new Proxy([], {
    get(_target, property) {
      if (property === 'length') throw new Error('array secret');
      return undefined;
    },
  });
  assert.throws(
    () => buildDomainAgentEnvelope({ ...baseInput(), evidence: hostileEvidence }),
    (error) => error?.code === 'INVALID_DOMAIN_AGENT_ENVELOPE' && !String(error).includes('array secret'),
  );
});

test('limitations and missing information require bounded real string arrays', () => {
  for (const field of ['limitations', 'missingInformation']) {
    for (const value of [null, {}, ['safe', 1n], Array.from({ length: 21 }, () => 'safe'), new Proxy([], {})]) {
      assert.throws(
        () => buildDomainAgentEnvelope({ ...baseInput(), [field]: value }),
        (error) => error?.code === 'INVALID_DOMAIN_AGENT_ENVELOPE' && error?.field === field,
      );
    }

    const hostile = [];
    Object.defineProperty(hostile, 0, { get() { throw new Error('list getter secret'); } });
    assert.throws(
      () => buildDomainAgentEnvelope({ ...baseInput(), [field]: hostile }),
      (error) => error?.code === 'INVALID_DOMAIN_AGENT_ENVELOPE'
        && error?.field === field && !String(error).includes('list getter secret'),
    );
  }
});

test('rejects oversized strings before sanitizer regex work with one property read', () => {
  const huge = 'x'.repeat(40_000);
  for (const field of ['taskId', 'answer']) {
    let getterCount = 0;
    const input = { ...baseInput() };
    Object.defineProperty(input, field, {
      get() {
        getterCount += 1;
        return huge;
      },
    });
    assert.throws(
      () => buildDomainAgentEnvelope(input),
      (error) => error?.code === 'INVALID_DOMAIN_AGENT_ENVELOPE' && error?.field === field,
    );
    assert.equal(getterCount, 1);
  }

  for (const [field, value] of [
    ['evidence', [{ label: huge, sourceRef: 'ref', version: '1' }]],
    ['limitations', [huge]],
    ['missingInformation', [huge]],
  ]) {
    assert.throws(
      () => buildDomainAgentEnvelope({ ...baseInput(), [field]: value }),
      (error) => error?.code === 'INVALID_DOMAIN_AGENT_ENVELOPE' && error?.field === field,
    );
  }
});

test('rejects oversized or proxied evidence before unbounded indexed reads', () => {
  let indexedReads = 0;
  const oversized = Array.from({ length: 1_000 }, (_, index) => ({
    label: `label-${index}`,
    sourceRef: `ref-${index}`,
    version: '1',
  }));
  Object.defineProperty(oversized, 0, {
    configurable: true,
    get() {
      indexedReads += 1;
      return { label: 'unreachable', sourceRef: 'unreachable', version: '1' };
    },
  });
  assert.throws(
    () => buildDomainAgentEnvelope({ ...baseInput(), evidence: oversized }),
    (error) => error?.code === 'INVALID_DOMAIN_AGENT_ENVELOPE' && error?.field === 'evidence',
  );
  assert.equal(indexedReads, 0);

  for (const lengthValue of [Infinity, 1_000_000_000]) {
    let getterCount = 0;
    const hostile = new Proxy([], {
      get(_target, property) {
        getterCount += 1;
        if (property === 'length') return lengthValue;
        throw new Error('must not read index');
      },
    });
    assert.throws(
      () => buildDomainAgentEnvelope({ ...baseInput(), evidence: hostile }),
      (error) => error?.code === 'INVALID_DOMAIN_AGENT_ENVELOPE' && error?.field === 'evidence',
    );
    assert.equal(getterCount, 0);
  }
});
