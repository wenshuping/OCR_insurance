import assert from 'node:assert/strict';
import test from 'node:test';
import { createHermesTextAgent } from '../server/hermes-agent-runtime.service.mjs';

test('Hermes text agent uses an isolated hashed session and passes the principal only through environment', async () => {
  let received;
  const answer = createHermesTextAgent({
    identityKey: 'test-hermes-identity-key-32-bytes-long',
    policyUploadUrl: 'https://c.example.test/upload',
    execFileImpl: async (command, args, options) => {
      received = { command, args, options };
      return { stdout: '第六个家庭目前有 3 份保单。\n', stderr: '' };
    },
  });
  assert.equal(await answer({ dingUserId: 'raw-ding-id', text: '6号家庭有几个保单' }), '第六个家庭目前有 3 份保单。');
  assert.equal(received.command, 'insuranceagent');
  assert.equal(received.options.env.OCR_INSURANCE_DING_USER_ID, 'raw-ding-id');
  assert.equal(received.args.join(' ').includes('raw-ding-id'), false);
  assert.match(received.args[received.args.indexOf('--continue') + 1], /^dingtalk-insurance-[a-f0-9]{24}$/);
  assert.match(received.args[received.args.indexOf('--oneshot') + 1], /必须调用工具/);
  assert.match(received.args[received.args.indexOf('--oneshot') + 1], /https:\/\/c\.example\.test\/upload/);
  assert.match(received.args[received.args.indexOf('--oneshot') + 1], /不要查询或列出家庭/);
  assert.match(received.args[received.args.indexOf('--oneshot') + 1], /不要创建专属上传链接/);
});
