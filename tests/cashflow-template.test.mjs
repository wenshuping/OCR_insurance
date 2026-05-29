// tests/cashflow-template.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { findProductCashflowTemplate } from '../server/cashflow-template.mjs';

// ── Test fixtures ──

const sampleTemplate = {
  rules: [
    {
      timing: { type: 'range', start: { policyYear: 1 }, end: { policyYear: 10 } },
      amount: { basis: '基本保额', factor: 1 },
      liability: '生存保险金',
    },
  ],
  params: { pensionAge: 55 },
};

const basePolicy = {
  id: 500549,
  name: '盛世恒盈年金保险',
  company: '新华保险',
  productName: '盛世恒盈年金保险',
};

// ── 1. Matches by company + productName ──

test('findProductCashflowTemplate: matches by company + productName', () => {
  const records = [
    {
      company: '新华保险',
      productName: '盛世恒盈年金保险',
      payload: { cashflowTemplate: sampleTemplate },
    },
  ];
  const result = findProductCashflowTemplate(basePolicy, records);
  assert.deepEqual(result, sampleTemplate);
});

test('findProductCashflowTemplate: matches using policy.name when productName is absent', () => {
  const policy = { name: '盛世恒盈年金保险', company: '新华保险' };
  const records = [
    {
      company: '新华保险',
      productName: '盛世恒盈年金保险',
      payload: { cashflowTemplate: sampleTemplate },
    },
  ];
  const result = findProductCashflowTemplate(policy, records);
  assert.deepEqual(result, sampleTemplate);
});

test('findProductCashflowTemplate: matches using policy.productName', () => {
  const policy = { productName: '盛世恒盈年金保险', company: '新华保险' };
  const records = [
    {
      company: '新华保险',
      productName: '盛世恒盈年金保险',
      payload: { cashflowTemplate: sampleTemplate },
    },
  ];
  const result = findProductCashflowTemplate(policy, records);
  assert.deepEqual(result, sampleTemplate);
});

// ── 2. Returns null when no match ──

test('findProductCashflowTemplate: returns null when no record matches', () => {
  const records = [
    {
      company: '中国人寿',
      productName: '国寿福',
      payload: { cashflowTemplate: sampleTemplate },
    },
  ];
  const result = findProductCashflowTemplate(basePolicy, records);
  assert.equal(result, null);
});

test('findProductCashflowTemplate: returns null when records array is empty', () => {
  const result = findProductCashflowTemplate(basePolicy, []);
  assert.equal(result, null);
});

// ── 3. Returns null when record has no cashflowTemplate field ──

test('findProductCashflowTemplate: returns null when record payload has no cashflowTemplate', () => {
  const records = [
    {
      company: '新华保险',
      productName: '盛世恒盈年金保险',
      payload: { someOtherField: 'value' },
    },
  ];
  const result = findProductCashflowTemplate(basePolicy, records);
  assert.equal(result, null);
});

test('findProductCashflowTemplate: returns null when record payload is empty object', () => {
  const records = [
    {
      company: '新华保险',
      productName: '盛世恒盈年金保险',
      payload: {},
    },
  ];
  const result = findProductCashflowTemplate(basePolicy, records);
  assert.equal(result, null);
});

// ── 4. Normalizes company name for matching ──

test('findProductCashflowTemplate: normalizes company name — strips 股份有限公司', () => {
  const policy = { name: '某产品', company: '新华保险' };
  const records = [
    {
      company: '新华保险股份有限公司',
      productName: '某产品',
      payload: { cashflowTemplate: sampleTemplate },
    },
  ];
  const result = findProductCashflowTemplate(policy, records);
  assert.deepEqual(result, sampleTemplate);
});

test('findProductCashflowTemplate: normalizes company name — strips 有限责任公司', () => {
  const policy = { name: '某产品', company: '某某保险' };
  const records = [
    {
      company: '某某保险有限责任公司',
      productName: '某产品',
      payload: { cashflowTemplate: sampleTemplate },
    },
  ];
  const result = findProductCashflowTemplate(policy, records);
  assert.deepEqual(result, sampleTemplate);
});

test('findProductCashflowTemplate: normalizes company name — strips 有限公司', () => {
  const policy = { name: '某产品', company: '太平保险' };
  const records = [
    {
      company: '太平保险有限公司',
      productName: '某产品',
      payload: { cashflowTemplate: sampleTemplate },
    },
  ];
  const result = findProductCashflowTemplate(policy, records);
  assert.deepEqual(result, sampleTemplate);
});

test('findProductCashflowTemplate: normalizes with whitespace and case differences', () => {
  const policy = { name: 'ABC Product', company: 'Some Company' };
  const records = [
    {
      company: '  some   company  ',
      productName: '  abc  product  ',
      payload: { cashflowTemplate: sampleTemplate },
    },
  ];
  const result = findProductCashflowTemplate(policy, records);
  assert.deepEqual(result, sampleTemplate);
});

// ── 5. Handles payload as both string (JSON) and object ──

test('findProductCashflowTemplate: parses payload when it is a JSON string', () => {
  const records = [
    {
      company: '新华保险',
      productName: '盛世恒盈年金保险',
      payload: JSON.stringify({ cashflowTemplate: sampleTemplate }),
    },
  ];
  const result = findProductCashflowTemplate(basePolicy, records);
  assert.deepEqual(result, sampleTemplate);
});

test('findProductCashflowTemplate: handles payload as object directly', () => {
  const records = [
    {
      company: '新华保险',
      productName: '盛世恒盈年金保险',
      payload: { cashflowTemplate: sampleTemplate },
    },
  ];
  const result = findProductCashflowTemplate(basePolicy, records);
  assert.deepEqual(result, sampleTemplate);
});

test('findProductCashflowTemplate: skips record with invalid JSON string payload', () => {
  const records = [
    {
      company: '新华保险',
      productName: '盛世恒盈年金保险',
      payload: '{ invalid json !!!',
    },
  ];
  const result = findProductCashflowTemplate(basePolicy, records);
  assert.equal(result, null);
});

test('findProductCashflowTemplate: skips invalid JSON record and matches next valid one', () => {
  const records = [
    {
      company: '新华保险',
      productName: '盛世恒盈年金保险',
      payload: '{ bad json',
    },
    {
      company: '新华保险',
      productName: '盛世恒盈年金保险',
      payload: JSON.stringify({ cashflowTemplate: sampleTemplate }),
    },
  ];
  const result = findProductCashflowTemplate(basePolicy, records);
  assert.deepEqual(result, sampleTemplate);
});

// ── 6. Handles null/undefined inputs gracefully ──

test('findProductCashflowTemplate: returns null when policy is null', () => {
  const result = findProductCashflowTemplate(null, []);
  assert.equal(result, null);
});

test('findProductCashflowTemplate: returns null when policy is undefined', () => {
  const result = findProductCashflowTemplate(undefined, []);
  assert.equal(result, null);
});

test('findProductCashflowTemplate: returns null when knowledgeRecords is null', () => {
  const result = findProductCashflowTemplate(basePolicy, null);
  assert.equal(result, null);
});

test('findProductCashflowTemplate: returns null when knowledgeRecords is undefined', () => {
  const result = findProductCashflowTemplate(basePolicy, undefined);
  assert.equal(result, null);
});

test('findProductCashflowTemplate: returns null when both args are null', () => {
  const result = findProductCashflowTemplate(null, null);
  assert.equal(result, null);
});

test('findProductCashflowTemplate: returns null when policy has no company', () => {
  const policy = { name: '盛世恒盈年金保险' };
  const records = [
    {
      company: '新华保险',
      productName: '盛世恒盈年金保险',
      payload: { cashflowTemplate: sampleTemplate },
    },
  ];
  const result = findProductCashflowTemplate(policy, records);
  assert.equal(result, null);
});

test('findProductCashflowTemplate: returns null when policy has no name or productName', () => {
  const policy = { company: '新华保险' };
  const records = [
    {
      company: '新华保险',
      productName: '盛世恒盈年金保险',
      payload: { cashflowTemplate: sampleTemplate },
    },
  ];
  const result = findProductCashflowTemplate(policy, records);
  assert.equal(result, null);
});
