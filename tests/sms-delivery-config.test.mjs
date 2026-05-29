import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSmsDeliveryPlan, resolveSmsDeliveryRuntime } from '../server/sms-delivery.mjs';

test('aliyun real sms mode generates random codes and does not expose a local dev code', () => {
  const env = {
    SMS_MODE: 'real',
    SMS_REAL_PROVIDER: 'aliyun',
    ALIYUN_SMS_ACCESS_KEY_ID: 'ak',
    ALIYUN_SMS_ACCESS_KEY_SECRET: 'secret',
    ALIYUN_SMS_SIGN_NAME: '签名',
    ALIYUN_SMS_TEMPLATE_CODE: 'SMS_123456',
    ALIYUN_SMS_TEMPLATE_PARAM_KEY: 'code',
  };

  const runtime = resolveSmsDeliveryRuntime(env);
  assert.equal(runtime.realProviderReady, true);
  assert.equal(runtime.realProvider, 'aliyun');

  const first = resolveSmsDeliveryPlan({ mobile: '13800000000', env });
  const second = resolveSmsDeliveryPlan({ mobile: '13800000000', env });

  assert.equal(first.deliveryMode, 'real');
  assert.equal(first.exposeDevCode, false);
  assert.match(first.code, /^\d{6}$/);
  assert.match(second.code, /^\d{6}$/);
  assert.notEqual(first.code, '123456');
});
