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

function harness(identityResponses = [], options = {}) {
  const requests = [];
  const replies = [];
  const errors = [];
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
    errors,
    channel: createDingtalkStreamChannel({
      corpId: 'corp-1', serviceToken: 'service-token', fetchImpl, now: () => 1_000,
      reportError: (code) => errors.push(code),
      answerText: async () => '自然语言回答',
      ...options,
    }),
  };
}

test('channel silently verifies identity and never asks the advisor to bind', async () => {
  const h = harness([
    { status: 200, body: { status: 'active', maskedMobile: '138****8000' } },
  ]);
  await h.channel.handle({ ...BASE_MESSAGE, text: { content: '你好' } });
  assert.equal(h.replies[0], '自然语言回答');
  assert.equal(h.replies.join(' ').includes('绑定'), false);
  const auto = h.requests.find((request) => request.url.endsWith('/auto'));
  assert.equal(auto.options.headers.authorization, 'Bearer service-token');
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
  assert.deepEqual(mismatch.errors, ['MOBILE_MISMATCH']);
  assert.equal(mismatch.replies.join(' ').includes('raw detail'), false);
});

test('stream runtime registers the robot topic, acknowledges promptly, and fails closed without credentials', async () => {
  class FakeClient {
    static instance;
    constructor(options) { this.options = options; FakeClient.instance = this; }
    registerCallbackListener(topic, callback) { this.topic = topic; this.callback = callback; }
    socketCallBackResponse(messageId, result) { this.ack = { messageId, result }; }
    async getAccessToken() { return 'access-token'; }
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

test('policy upload requires consent before download and sends a masked OCR draft', async () => {
  let downloads = 0;
  const h = harness([
    { status: 200, body: { status: 'active', maskedMobile: '138****8000' } },
    { status: 200, body: { result: { families: [{ id: 10, displayLabel: '张**庭' }] } } },
    { status: 200, body: { result: { taskId: 101, stateVersion: 1 } } },
    { status: 200, body: { result: {
      taskId: 101,
      stateVersion: 4,
      documentSummary: { count: 1 },
      policyDraft: { company: '可信保险', productName: '安心保', insured: '张*' },
      missingFields: ['date'],
      nextInteraction: { type: 'set_field', field: 'date' },
    } } },
  ], {
    policyUploadEnabled: true,
    downloadAttachment: async () => {
      downloads += 1;
      return { uploadItem: 'data:image/jpeg;base64,/9j/2Q==', name: 'policy.jpg', mediaType: 'image/jpeg' };
    },
  });
  const picture = { ...BASE_MESSAGE, msgtype: 'picture', content: { downloadCode: 'secret-code' } };
  await h.channel.handle({ ...BASE_MESSAGE, text: { content: '上传保单' } });
  await h.channel.handle(picture);
  assert.equal(downloads, 0);
  assert.match(h.replies.at(-1), /同意上传/);
  await h.channel.handle({ ...BASE_MESSAGE, text: { content: '同意上传' } });
  await h.channel.handle(picture);
  assert.equal(downloads, 1);
  assert.match(h.replies.at(-1), /可信保险/);
  assert.match(h.replies.at(-1), /待补充字段：date/);
  assert.equal(h.replies.join(' ').includes('secret-code'), false);
});

test('an unregistered DingTalk user can request SMS verification and register without exposing the mobile', async () => {
  const h = harness([
    { status: 403, body: { code: 'REGISTRATION_REQUIRED' } },
    { status: 200, body: { mobile: '13800138000' } },
    { status: 200, body: { expiresInSeconds: 600, devCode: '123456' } },
    { status: 200, body: { mobile: '13800138000' } },
    { status: 200, body: { user: { id: 9 }, token: 'session-secret' } },
    { status: 200, body: { status: 'active', maskedMobile: '138****8000' } },
  ]);
  await h.channel.handle({ ...BASE_MESSAGE, text: { content: '你好' } });
  assert.match(h.replies.at(-1), /回复“注册”/);
  await h.channel.handle({ ...BASE_MESSAGE, text: { content: '注册' } });
  assert.match(h.replies.at(-1), /验证码已发送/);
  await h.channel.handle({ ...BASE_MESSAGE, text: { content: '123456' } });
  assert.match(h.replies.at(-1), /注册验证成功/);
  const replies = h.replies.join(' ');
  assert.equal(replies.includes('13800138000'), false);
  assert.equal(replies.includes('session-secret'), false);
});
