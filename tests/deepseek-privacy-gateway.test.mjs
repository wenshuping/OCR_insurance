import assert from 'node:assert/strict';
import test from 'node:test';

import {
  redactDeepSeekDirectIdentifiers,
  sanitizeDeepSeekRequestBody,
} from '../server/deepseek-privacy-gateway.mjs';

test('DeepSeek privacy gateway removes direct identifiers but preserves insurance facts', () => {
  const original = '王小明，手机号138 1234 5678，地址：浙江省杭州市西湖区文三路88号2幢501室，38岁，甲状腺结节3级，每年预算2万元，保额100万元。';
  const redacted = redactDeepSeekDirectIdentifiers(original, { names: ['王小明'] });

  assert.doesNotMatch(redacted, /王小明|138\s*1234\s*5678|文三路|501室/u);
  assert.match(redacted, /客户姓名已脱敏/u);
  assert.match(redacted, /浙江省杭州市西湖区/u);
  assert.match(redacted, /38岁/u);
  assert.match(redacted, /甲状腺结节3级/u);
  assert.match(redacted, /预算2万元/u);
  assert.match(redacted, /保额100万元/u);
});

test('DeepSeek privacy gateway removes identity, account and contact values', () => {
  const redacted = redactDeepSeekDirectIdentifiers('身份证：330106199001011234，银行卡6222 0212 3456 7890，邮箱a.user@example.com，微信号：Abc_12345，保单号PA2026012345。');
  assert.doesNotMatch(redacted, /330106199001011234|6222\s*0212|a\.user@example\.com|Abc_12345|PA2026012345/u);
  assert.match(redacted, /身份证号已脱敏/u);
  assert.match(redacted, /银行卡号已脱敏/u);
  assert.match(redacted, /邮箱已脱敏/u);
});

test('DeepSeek privacy gateway sanitizes every message without mutating the source body', () => {
  const body = {
    model: 'test-model',
    messages: [
      { role: 'user', content: '张女士电话13912345678，预算3万元。' },
      { role: 'assistant', content: '收到。' },
    ],
  };
  const sanitized = sanitizeDeepSeekRequestBody(body);
  assert.match(body.messages[0].content, /13912345678/u);
  assert.doesNotMatch(sanitized.messages[0].content, /张女士|13912345678/u);
  assert.match(sanitized.messages[0].content, /预算3万元/u);
});

test('ordinary product numbers and financial amounts are not removed', () => {
  const redacted = redactDeepSeekDirectIdentifiers('产品代码A2026，等待期90天，年收入300000元，保费20000元。');
  assert.equal(redacted, '产品代码A2026，等待期90天，年收入300000元，保费20000元。');
});
