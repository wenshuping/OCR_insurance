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

test('binds a trusted confirmed product to claims without exposing mutable state', () => {
  const service = createAgentToolCapabilityService({ clock: () => 2_100, createToken: () => 'opaque-token-product' });
  const issued = service.issue(request({ allowedTools: ['ask_insurance_expert'] }));
  const product = {
    canonicalProductId: 'product-zjy',
    company: '新华保险',
    officialName: '新华人寿保险股份有限公司尊佑金悦庆典版养老年金保险（分红型）',
  };

  const bound = service.bindConfirmedProduct(issued.token, product);
  bound.confirmedProduct.company = '被篡改';

  assert.deepEqual(service.inspect(issued.token).confirmedProduct, product);
  assert.deepEqual(
    service.consume({ token: issued.token, tool: 'ask_insurance_expert' }).confirmedProduct,
    product,
  );
  assert.throws(
    () => service.bindConfirmedProduct(issued.token, { ...product, company: '' }),
    { code: 'AGENT_TOOL_CAPABILITY_CONFIRMED_PRODUCT_COMPANY_INVALID' },
  );
});

test('binds online product search authority only after a server-controlled selection', () => {
  const service = createAgentToolCapabilityService({
    clock: () => 2_200,
    createToken: () => 'opaque-token-online-search',
  });
  const issued = service.issue(request({ allowedTools: ['ask_insurance_expert'] }));

  assert.equal(service.consume({
    token: issued.token, tool: 'ask_insurance_expert',
  }).onlineProductSearchAllowed, undefined);
  const rejectedCandidates = [{
    canonicalProductId: 'rejected-a', company: '中国人寿', officialName: '国寿金彩明天两全保险（A款）（分红型）',
  }];
  const authorized = service.authorizeOnlineProductSearch(issued.token, rejectedCandidates);
  authorized.onlineProductSearchAllowed = false;
  authorized.rejectedProductCandidates[0].officialName = 'tampered';

  assert.equal(service.inspect(issued.token).onlineProductSearchAllowed, true);
  assert.deepEqual(service.inspect(issued.token).rejectedProductCandidates, rejectedCandidates);
  assert.equal(service.consume({
    token: issued.token, tool: 'ask_insurance_expert',
  }).onlineProductSearchAllowed, true);
});

test('notifies a bounded waiter as soon as a domain tool records its result', async () => {
  const service = createAgentToolCapabilityService({ clock: () => 2_500, createToken: () => 'opaque-token-wait' });
  const issued = service.issue(request());
  const waiting = service.waitForResult(issued.token);
  service.consume({ token: issued.token, tool: 'ask_insurance_expert' });
  service.recordResult({
    token: issued.token,
    tool: 'ask_insurance_expert',
    result: {
      status: 'needs_clarification',
      decision: 'clarify',
      interaction: {
        type: 'clarification', text: '请确认正式产品。',
        candidates: [
          { ref: 'product-1', label: '新华保险《寰宇尊悦高端医疗保险》' },
          { ref: '', label: '无效候选' },
        ],
      },
    },
  });
  const claims = await waiting;
  assert.equal(claims.toolResults[0].result.interaction.text, '请确认正式产品。');
  assert.deepEqual(claims.toolResults[0].result.interaction.candidates, [
    { ref: 'product-1', label: '新华保险《寰宇尊悦高端医疗保险》' },
  ]);
});

test('preserves an empty insurance product candidate list as a context-clear signal', () => {
  const service = createAgentToolCapabilityService({
    clock: () => 2_550,
    createToken: () => 'opaque-token-empty-candidates',
  });
  const issued = service.issue(request({ allowedTools: ['ask_insurance_expert'] }));

  service.recordResult({
    token: issued.token,
    tool: 'ask_insurance_expert',
    result: {
      status: 'needs_clarification', decision: 'clarify',
      interaction: {
        type: 'clarification', text: '联网后仍未找到正式产品。', candidates: [],
      },
    },
  });

  assert.deepEqual(
    service.inspect(issued.token).toolResults[0].result.interaction.candidates,
    [],
  );
});

test('does not preserve candidates from the sales champion tool', () => {
  const service = createAgentToolCapabilityService({ clock: () => 2_600, createToken: () => 'opaque-token-sales' });
  const issued = service.issue(request());
  service.recordResult({
    token: issued.token,
    tool: 'ask_sales_champion',
    result: {
      status: 'needs_clarification', decision: 'clarify',
      interaction: {
        type: 'clarification', text: '请补充信息。',
        candidates: [{ ref: 'private-family', label: '不应透传' }],
      },
    },
  });
  assert.equal(service.inspect(issued.token).toolResults[0].result.interaction.candidates, undefined);
});

test('preserves only explicitly typed product candidates from the sales champion continuation', () => {
  const service = createAgentToolCapabilityService({ clock: () => 2_700, createToken: () => 'opaque-token-sales-product' });
  const issued = service.issue(request());
  service.recordResult({
    token: issued.token,
    tool: 'ask_sales_champion',
    result: {
      status: 'needs_clarification', decision: 'clarify', candidateType: 'product',
      interaction: {
        type: 'clarification', text: '请确认产品后继续销冠任务。',
        candidates: [{ ref: 'product-1', label: '新华保险《康健华尊医疗保险》' }],
      },
    },
  });
  assert.deepEqual(service.inspect(issued.token).toolResults[0].result.interaction.candidates, [
    { ref: 'product-1', label: '新华保险《康健华尊医疗保险》' },
  ]);
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
