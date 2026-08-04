import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyProgressEvents,
  matchProgressEvent,
} from '../scripts/reconcile-responsibility-full-backfill-progress.mjs';

function row(overrides = {}) {
  return {
    productKey: 'product:测试人寿\u001f测试产品',
    company: '测试人寿保险有限公司',
    productName: '测试产品',
    sourceDigest: `sha256:${'a'.repeat(64)}`,
    sourceUrl: 'https://official.example.com/policy.pdf',
    sourceStatus: 'unknown',
    state: 'source_pending',
    lane: 'SOURCE',
    terminalStatus: '',
    databaseStatus: 'legacy_non_strict',
    receipts: [],
    ...overrides,
  };
}

test('progress reconciliation matches digest before URL and name', () => {
  const first = row();
  const second = row({
    productKey: 'product:测试人寿\u001f另一产品',
    productName: '另一产品',
    sourceDigest: `sha256:${'b'.repeat(64)}`,
    sourceUrl: 'https://official.example.com/other.pdf',
  });
  const index = {
    byKey: new Map([[first.productKey, first], [second.productKey, second]]),
    byDigest: new Map([[first.sourceDigest, [first]], [second.sourceDigest, [second]]]),
    byUrl: new Map([[first.sourceUrl, [first]], [second.sourceUrl, [second]]]),
    byName: new Map(),
  };

  assert.equal(matchProgressEvent({
    company: '测试人寿',
    productName: '测试产品',
    sourceDigest: first.sourceDigest,
    sourceUrl: second.sourceUrl,
  }, index), first);
});

test('progress reconciliation updates one product and preserves total', () => {
  const base = [row()];
  const result = applyProgressEvents(base, [{
    label: 'source-canary',
    path: '/tmp/source.jsonl',
    state: 'parse_pending',
    lane: 'LUNA',
    records: [{
      productKey: base[0].productKey,
      sourceStatus: 'source_ready',
      sourceDigest: base[0].sourceDigest,
    }],
  }]);

  assert.equal(result.ledger.length, 1);
  assert.equal(result.ledger[0].state, 'parse_pending');
  assert.equal(result.ledger[0].sourceStatus, 'source_ready');
  assert.equal(result.counts.nonTerminal, 1);
  assert.equal(result.audit[0].matched, 1);
});

test('progress reconciliation reads source identity from canonical artifact', () => {
  const base = [row()];
  const result = applyProgressEvents(base, [{
    label: 'materializer-canary',
    path: '/tmp/materializer.json',
    state: 'import_pending',
    lane: 'IMPORT',
    records: [{
      company: base[0].company,
      productName: base[0].productName,
      productIdentity: {
        sourceDigest: base[0].sourceDigest,
        sourceUrl: base[0].sourceUrl,
      },
    }],
  }]);

  assert.equal(result.audit[0].matched, 1);
  assert.equal(result.ledger[0].lane, 'IMPORT');
});

test('progress reconciliation rejects overlapping event groups', () => {
  const base = [row()];
  assert.throws(
    () => applyProgressEvents(base, [
      {
        label: 'first',
        path: '/tmp/first.jsonl',
        state: 'parse_pending',
        records: [{ productKey: base[0].productKey }],
      },
      {
        label: 'second',
        path: '/tmp/second.jsonl',
        state: 'validation_review',
        records: [{ productKey: base[0].productKey }],
      },
    ]),
    /progress event overlap/,
  );
});

test('progress reconciliation protects strict aligned products', () => {
  const base = [row({ state: 'strict_aligned', terminalStatus: 'strict_aligned' })];
  const result = applyProgressEvents(base, [{
    label: 'stale-source',
    path: '/tmp/stale.jsonl',
    state: 'parse_pending',
    records: [{ productKey: base[0].productKey }],
  }]);

  assert.equal(result.ledger[0].state, 'strict_aligned');
  assert.equal(result.audit[0].excluded[0].reason, 'protected_strict_aligned');
});
