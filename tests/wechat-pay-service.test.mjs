import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  createWechatPayJsapiPrepay,
  decryptWechatPayResource,
  resolveWechatPayConfig,
  signWechatPayMessage,
  verifyWechatPaySignature,
} from '../server/wechat-pay.service.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

test('resolveWechatPayConfig reports mock and live readiness', () => {
  assert.equal(resolveWechatPayConfig({ WECHAT_PAY_MODE: 'mock' }).mode, 'mock');
  assert.equal(resolveWechatPayConfig({ WECHAT_PAY_MODE: 'mock', NODE_ENV: 'production' }).ready, false);
  assert.equal(resolveWechatPayConfig({
    WECHAT_PAY_MODE: 'mock',
    NODE_ENV: 'production',
    WECHAT_PAY_ALLOW_MOCK_IN_PRODUCTION: 'true',
  }).ready, true);
  const live = resolveWechatPayConfig({
    WECHAT_PAY_MODE: 'live',
    WECHAT_H5_APP_ID: 'wx123',
    WECHAT_PAY_MCH_ID: 'mch123',
    WECHAT_PAY_API_V3_KEY: '12345678901234567890123456789012',
    WECHAT_PAY_SERIAL_NO: 'serial123',
    WECHAT_PAY_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    WECHAT_PAY_PLATFORM_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
    WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID: 'PUB_KEY_ID_1',
    WECHAT_PAY_NOTIFY_URL: 'https://app.example.com/api/membership/wechatpay/notify',
  });
  assert.equal(live.ready, true);
});

test('signWechatPayMessage and verifyWechatPaySignature round trip', () => {
  const body = '{"id":"notify"}';
  const timestamp = '1790000000';
  const nonce = 'nonce-1';
  const signature = signWechatPayMessage(`${timestamp}\n${nonce}\n${body}\n`, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  assert.equal(verifyWechatPaySignature({ timestamp, nonce, body, signature, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }), true);
  assert.equal(verifyWechatPaySignature({
    timestamp,
    nonce,
    body,
    signature,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    maxAgeSeconds: 300,
    nowMs: (Number(timestamp) + 301) * 1000,
  }), false);
  assert.equal(verifyWechatPaySignature({ timestamp, nonce, body: '{}', signature, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }), false);
});

test('decryptWechatPayResource decrypts AES-256-GCM resource payload', () => {
  const apiV3Key = '12345678901234567890123456789012';
  const nonce = '0123456789ab';
  const associatedData = 'transaction';
  const plain = JSON.stringify({ out_trade_no: 'mem_1', trade_state: 'SUCCESS', amount: { total: 30000 } });
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData));
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, authTag]).toString('base64');
  assert.deepEqual(decryptWechatPayResource({ apiV3Key, nonce, associatedData, ciphertext }), JSON.parse(plain));
});

test('createWechatPayJsapiPrepay signs request and returns signed jsapi pay params', async () => {
  const requests = [];
  const config = resolveWechatPayConfig({
    WECHAT_PAY_MODE: 'live',
    WECHAT_H5_APP_ID: 'wx123',
    WECHAT_PAY_MCH_ID: 'mch123',
    WECHAT_PAY_API_V3_KEY: '12345678901234567890123456789012',
    WECHAT_PAY_SERIAL_NO: 'serial123',
    WECHAT_PAY_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    WECHAT_PAY_PLATFORM_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
    WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID: 'PUB_KEY_ID_1',
    WECHAT_PAY_NOTIFY_URL: 'https://app.example.com/api/membership/wechatpay/notify',
  });
  const result = await createWechatPayJsapiPrepay({
    config,
    openid: 'openid-1',
    order: {
      outTradeNo: 'order-1',
      expiresAt: '2026-06-11T08:30:00.000Z',
      amountCents: 30000,
      currency: 'CNY',
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ prepay_id: 'prepay-1' }) };
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi');
  assert.match(requests[0].init.headers.authorization, /^WECHATPAY2-SHA256-RSA2048 /);
  assert.equal(requests[0].body.payer.openid, 'openid-1');
  assert.equal(requests[0].body.amount.total, 30000);
  assert.equal(result.prepayId, 'prepay-1');
  assert.equal(result.payParams.package, 'prepay_id=prepay-1');
  const jsapiMessage = [
    result.payParams.appId,
    result.payParams.timeStamp,
    result.payParams.nonceStr,
    result.payParams.package,
    '',
  ].join('\n');
  assert.equal(
    crypto.createVerify('RSA-SHA256').update(jsapiMessage).verify(publicKey.export({ type: 'spki', format: 'pem' }), result.payParams.paySign, 'base64'),
    true,
  );
});
