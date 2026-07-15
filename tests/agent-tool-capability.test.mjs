import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentToolCapabilityService } from '../server/agent-tool-capability.service.mjs';

function request(overrides = {}) {
  return {
    tenant: 'default',
    channel: 'dingtalk',
    channelUserId: 'ding-user-7',
    channelMobile: '13800138000',
    internalUserId: 7,
    conversationId: 'conversation-1',
    messageRef: 'message-1',
    allowedTools: ['ask_insurance_expert', 'ask_sales_champion'],
    maxCalls: 2,
    ttlMs: 1_000,
    ...overrides,
  };
}

test('issues an opaque capability and atomically consumes its bounded tool budget', () => {
  const service = createAgentToolCapabilityService({ clock: () => 1_000 });
  const issued = service.issue(request());

  assert.match(issued.token, /^[A-Za-z0-9_-]{40,}$/u);
  assert.equal(issued.token.includes('ding-user-7'), false);
  assert.equal(issued.token.includes('13800138000'), false);
  assert.equal(issued.claims.callCount, 0);

  const first = service.consume({ token: issued.token, tool: 'ask_insurance_expert' });
  const second = service.consume({ token: issued.token, tool: 'ask_sales_champion' });
  assert.equal(first.callCount, 1);
  assert.equal(second.callCount, 2);
  assert.equal(service.inspect(issued.token).callCount, 2);
  service.recordResult({
    token: issued.token,
    tool: 'ask_sales_champion',
    result: {
      status: 'ok',
      decision: 'execute',
      interaction: { type: 'answer', text: '受控结果', delivery: 'verbatim' },
      resolvedEntities: { product: {
        canonicalProductId: 'product-1', company: '新华人寿', officialName: '正式产品名称',
      } },
    },
  });
  assert.equal(service.inspect(issued.token).toolResults[0].result.interaction.text, '受控结果');
  assert.equal(service.inspect(issued.token).toolResults[0].result.interaction.delivery, 'verbatim');
  assert.equal(
    service.inspect(issued.token).toolResults[0].result.resolvedEntities.product.officialName,
    '正式产品名称',
  );
  assert.throws(
    () => service.consume({ token: issued.token, tool: 'ask_insurance_expert' }),
    { code: 'AGENT_TOOL_CAPABILITY_BUDGET_EXHAUSTED' },
  );
});

test('returns claims copies and rejects tools outside the issued allowlist', () => {
  const service = createAgentToolCapabilityService({ clock: () => 2_000, createToken: () => 'opaque-token-1' });
  const issued = service.issue(request({ allowedTools: ['ask_insurance_expert'] }));
  issued.claims.allowedTools.push('ask_sales_champion');
  issued.claims.internalUserId = 99;

  assert.throws(
    () => service.consume({ token: issued.token, tool: 'ask_sales_champion' }),
    { code: 'AGENT_TOOL_CAPABILITY_TOOL_FORBIDDEN' },
  );
  const consumed = service.consume({ token: issued.token, tool: 'ask_insurance_expert' });
  consumed.allowedTools.length = 0;
  assert.equal(consumed.internalUserId, 7);
  assert.deepEqual(
    service.consume({ token: issued.token, tool: 'ask_insurance_expert' }).allowedTools,
    ['ask_insurance_expert'],
  );
});

test('expires, revokes, and lazily cleans capabilities', () => {
  let now = 10_000;
  let tokenId = 0;
  const service = createAgentToolCapabilityService({
    clock: () => now,
    createToken: () => `opaque-token-${tokenId += 1}`,
    cleanupIntervalMs: 100,
  });
  const expired = service.issue(request({ ttlMs: 50 }));
  const revoked = service.issue(request({ messageRef: 'message-2' }));
  assert.equal(service.revoke(revoked.token), true);
  assert.equal(service.revoke(revoked.token), false);
  assert.throws(
    () => service.consume({ token: revoked.token, tool: 'ask_insurance_expert' }),
    { code: 'AGENT_TOOL_CAPABILITY_NOT_FOUND' },
  );

  now += 101;
  assert.throws(
    () => service.consume({ token: expired.token, tool: 'ask_insurance_expert' }),
    { code: 'AGENT_TOOL_CAPABILITY_EXPIRED' },
  );
});

test('strictly validates issue and consume inputs', () => {
  const service = createAgentToolCapabilityService({ clock: () => 3_000, createToken: () => 'opaque-token-valid' });
  for (const invalid of [
    request({ internalUserId: '7' }),
    request({ allowedTools: ['family_summary'] }),
    request({ allowedTools: ['ask_insurance_expert', 'ask_insurance_expert'] }),
    request({ maxCalls: 0 }),
    request({ ttlMs: 0 }),
    request({ extra: true }),
    request({ channelUserId: ' padded ' }),
  ]) {
    assert.throws(() => service.issue(invalid));
  }

  const issued = service.issue(request());
  assert.throws(() => service.consume({ token: issued.token, tool: 'family_summary' }), {
    code: 'AGENT_TOOL_CAPABILITY_TOOL_FORBIDDEN',
  });
  assert.throws(() => service.consume({ token: issued.token, tool: 'ask_insurance_expert', extra: true }), {
    code: 'AGENT_TOOL_CAPABILITY_CONSUME_INVALID',
  });
});
