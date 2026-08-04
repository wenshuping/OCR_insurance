import assert from 'node:assert/strict';
import test from 'node:test';
import { createDingtalkMediaDownloader } from '../server/dingtalk-media-runtime.mjs';

test('DingTalk media downloader exchanges a download code and returns bounded in-memory data', async () => {
  const requests = [];
  const downloader = createDingtalkMediaDownloader({
    client: { getAccessToken: async () => 'access-token' },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).includes('/messageFiles/download')) {
        return new Response(JSON.stringify({ downloadUrl: 'https://files.dingtalk.com/policy' }), { status: 200 });
      }
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    },
  });
  const result = await downloader({ msgtype: 'picture', robotCode: 'robot-code', content: { downloadCode: 'download-secret' } });
  assert.equal(result.name, 'dingtalk-policy.jpg');
  assert.match(result.uploadItem, /^data:image\/jpeg;base64,/);
  assert.deepEqual(JSON.parse(requests[0].options.body), { downloadCode: 'download-secret', robotCode: 'robot-code' });
  assert.equal(requests[0].options.headers['x-acs-dingtalk-access-token'], 'access-token');
});

test('DingTalk media downloader rejects untrusted URLs and oversized responses', async () => {
  const client = { getAccessToken: async () => 'access-token' };
  const message = { msgtype: 'file', robotCode: 'robot', content: { downloadCode: 'code', fileName: 'policy.pdf' } };
  const untrusted = createDingtalkMediaDownloader({ client, fetchImpl: async () => new Response(JSON.stringify({ downloadUrl: 'https://evil.example.test/file' }), { status: 200 }) });
  await assert.rejects(() => untrusted(message), { code: 'DINGTALK_DOWNLOAD_URL_FORBIDDEN' });

  let calls = 0;
  const oversized = createDingtalkMediaDownloader({
    client,
    maxBytes: 3,
    fetchImpl: async () => (++calls === 1
      ? new Response(JSON.stringify({ downloadUrl: 'https://files.dingtalk.com/file' }), { status: 200 })
      : new Response(Buffer.from('four'), { status: 200 })),
  });
  await assert.rejects(() => oversized(message), { code: 'DOCUMENT_SIZE_EXCEEDED' });
});

test('DingTalk media downloader accepts JSON-string and rich-text picture content', async () => {
  const bodies = [];
  const downloader = createDingtalkMediaDownloader({
    client: { getAccessToken: async () => 'access-token' },
    fetchImpl: async (url, options) => {
      if (String(url).includes('/messageFiles/download')) {
        bodies.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ downloadUrl: 'https://files.dingtalk.com/policy' }), { status: 200 });
      }
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    },
  });
  await downloader({ msgtype: 'picture', robotCode: 'robot', content: JSON.stringify({ downloadCode: 'string-code' }) });
  await downloader({ msgtype: 'richText', robotCode: 'robot', content: { richText: [{ type: 'picture', downloadCode: 'rich-code' }] } });
  assert.deepEqual(bodies.map((body) => body.downloadCode), ['string-code', 'rich-code']);
});
