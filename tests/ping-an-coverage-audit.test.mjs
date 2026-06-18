import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPingAnIssuer,
  normalizeProductName,
  planCodeFromUrl,
} from '../scripts/audit-ping-an-coverage.mjs';

test('normalizeProductName handles spaces and bracket variants conservatively', () => {
  assert.equal(
    normalizeProductName(' 平安智富人生B （ 万能型，2004 ） '),
    '平安智富人生B(万能型,2004)',
  );
  assert.equal(
    normalizeProductName('平安附加少儿大学教育年金保险（分红型，外币版）'),
    '平安附加少儿大学教育年金保险(分红型,外币版)',
  );
});

test('isPingAnIssuer accepts Ping An life issuer names only', () => {
  assert.equal(isPingAnIssuer('中国平安人寿保险股份有限公司'), true);
  assert.equal(isPingAnIssuer('中国平安'), true);
  assert.equal(isPingAnIssuer('平安健康保险股份有限公司'), true);
  assert.equal(isPingAnIssuer('安盛天平财产保险有限公司'), false);
});

test('planCodeFromUrl extracts Ping An plan code query parameter', () => {
  assert.equal(
    planCodeFromUrl('https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=893&versionNo=893-2&attachmentType=1'),
    '893',
  );
  assert.equal(planCodeFromUrl('https://example.test/no-plan-code'), '');
});
