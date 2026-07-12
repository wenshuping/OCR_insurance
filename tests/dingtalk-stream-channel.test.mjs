import assert from 'node:assert/strict';
import test from 'node:test';
import { createDingtalkStreamChannel } from '../server/dingtalk-stream-channel.service.mjs';
import { startDingtalkStream } from '../server/dingtalk-stream.mjs';

const BASE_MESSAGE = {
  senderCorpId: 'corp-1',
  senderStaffId: 'ding-1',
  conversationType: '1',
  sessionWebhook: 'https://reply.example.test/session',
  msgtype: 'text',
  text: { content: '绑定' },
};

function harness(identityResponses = []) {
  const requests = [];
  const replies = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url === BASE_MESSAGE.sessionWebhook) {
      replies.push(JSON.parse(options.body).text.content);
      return new Response('{}', { status: 200 });
    }
    const next = identityResponses.shift();
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return {
    requests,
    replies,
    channel: createDingtalkStreamChannel({
      corpId: 'corp-1', serviceToken: 'service-token', fetchImpl, now: () => 1_000,
    }),
  };
}

test('bind and confirm use the authenticated identity API without exposing the challenge token', async () => {
  const token = 'secret-challenge-token';
  const h = harness([
    { status: 200, body: { maskedMobile: '138****8000', challenge: { token, expiresAt: '2099-01-01T00:00:00.000Z' } } },
    { status: 200, body: { maskedMobile: '138****8000' } },
  ]);
  await h.channel.handle(BASE_MESSAGE);
  await h.channel.handle({ ...BASE_MESSAGE, text: { content: '确认绑定' } });
  assert.match(h.replies[0], /138\*{4}8000/);
  assert.match(h.replies[1], /绑定成功/);
  assert.equal(h.replies.join(' ').includes(token), false);
  const candidate = h.requests.find((request) => request.url.endsWith('/candidate'));
  assert.equal(candidate.options.headers.authorization, 'Bearer service-token');
  const confirmation = JSON.parse(h.requests.find((request) => request.url.endsWith('/confirm')).options.body);
  assert.equal(confirmation.token, token);
});

test('channel rejects groups, ignores foreign corps, and masks identity failures', async () => {
  const group = harness();
  await group.channel.handle({ ...BASE_MESSAGE, conversationType: '2' });
  assert.deepEqual(group.replies, ['当前仅支持单聊，请直接打开机器人对话。']);

  const foreign = harness();
  await foreign.channel.handle({ ...BASE_MESSAGE, senderCorpId: 'other-corp' });
  assert.deepEqual(foreign.requests, []);

  const mismatch = harness([{ status: 403, body: { code: 'MOBILE_MISMATCH', detail: 'raw detail' } }]);
  await mismatch.channel.handle(BASE_MESSAGE);
  assert.deepEqual(mismatch.replies, ['当前钉钉手机号与平台注册手机号不一致，无法登录。']);
  assert.equal(mismatch.replies.join(' ').includes('raw detail'), false);
});

test('expired confirmation requires a fresh binding challenge', async () => {
  const h = harness([{ status: 200, body: {
    maskedMobile: '138****8000',
    challenge: { token: 'token', expiresAt: '1970-01-01T00:00:00.500Z' },
  } }]);
  await h.channel.handle(BASE_MESSAGE);
  await h.channel.handle({ ...BASE_MESSAGE, text: { content: '确认绑定' } });
  assert.equal(h.replies.at(-1), '绑定确认已过期，请重新发送“绑定”。');
  assert.equal(h.requests.filter((request) => request.url.endsWith('/confirm')).length, 0);
});

test('stream runtime registers the robot topic, acknowledges promptly, and fails closed without credentials', async () => {
  class FakeClient {
    static instance;
    constructor(options) { this.options = options; FakeClient.instance = this; }
    registerCallbackListener(topic, callback) { this.topic = topic; this.callback = callback; }
    socketCallBackResponse(messageId, result) { this.ack = { messageId, result }; }
    async connect() { this.connected = true; }
  }
  const env = {
    DINGTALK_APP_KEY: 'client-id',
    DINGTALK_APP_SECRET: 'client-secret',
    DINGTALK_CORP_ID: 'corp-1',
    DINGTALK_IDENTITY_SERVICE_TOKEN: 'service-token',
  };
  const client = await startDingtalkStream({ env, Client: FakeClient });
  assert.equal(client.connected, true);
  assert.equal(client.options.clientId, 'client-id');
  client.callback({ headers: { messageId: 'message-1' }, data: '{invalid' });
  assert.deepEqual(client.ack, { messageId: 'message-1', result: 'OK' });
  await assert.rejects(() => startDingtalkStream({ env: {}, Client: FakeClient }), /DINGTALK_APP_KEY_REQUIRED/);
});
