import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildIndex,
  createMasterLedger,
  matchRecord,
} from '../scripts/build-responsibility-full-backfill-ledger.mjs';

function alignmentRow({
  company,
  productName,
  digest = '',
  sourceUrl = '',
  category,
  cards = 1,
  indicators = 1,
  approvedArtifacts = 0,
}) {
  return {
    key: `product:${company}\u001f${productName}`,
    rawProducts: [`${company}\u001f${productName}`],
    sourceDigests: digest ? [digest] : [],
    sourceUrls: sourceUrl ? [sourceUrl] : [],
    cards,
    indicators,
    category,
    evidence: { approvedArtifacts },
  };
}

test('creates one mutually exclusive coordinator state per alignment product', () => {
  const ledger = [
    alignmentRow({ company: '甲公司', productName: '严格产品', category: 'strict_aligned' }),
    alignmentRow({
      company: '甲公司',
      productName: '待物化产品',
      category: 'artifact_backed_deterministic_rebuild_formula_or_multi_indicator',
      approvedArtifacts: 1,
    }),
    alignmentRow({ company: '乙公司', productName: '缺来源产品', category: 'missing_approved_artifact' }),
    alignmentRow({
      company: '乙公司',
      productName: '只有指标产品',
      category: 'other_blocked',
      cards: 0,
      indicators: 2,
    }),
  ];
  const master = createMasterLedger({ ledger });
  assert.deepEqual(master.map((row) => row.state), [
    'strict_aligned',
    'import_pending',
    'source_pending',
    'parse_pending',
  ]);
  assert.equal(new Set(master.map((row) => row.productKey)).size, 4);
});

test('shared source digest does not merge distinct products', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const ledger = [
    alignmentRow({ company: '甲公司', productName: '产品A', digest, category: 'missing_approved_artifact' }),
    alignmentRow({ company: '甲公司', productName: '产品B', digest, category: 'missing_approved_artifact' }),
  ];
  const index = buildIndex(ledger);
  assert.equal(matchRecord({ company: '甲公司', productName: '产品A', sourceDigest: digest }, index)?.key, ledger[0].key);
  assert.equal(matchRecord({ company: '甲公司', productName: '产品B', sourceDigest: digest }, index)?.key, ledger[1].key);
  assert.equal(matchRecord({ sourceDigest: digest }, index), null);
});

test('matches by digest, then URL, then normalized company and product', () => {
  const digest = `sha256:${'b'.repeat(64)}`;
  const sourceUrl = 'https://example.com/a.pdf';
  const row = alignmentRow({
    company: '甲人寿保险有限公司',
    productName: '甲产品（A款）',
    digest,
    sourceUrl,
    category: 'missing_approved_artifact',
  });
  const index = buildIndex([row]);
  assert.equal(matchRecord({ sourceDigest: digest }, index)?.key, row.key);
  assert.equal(matchRecord({ sourceUrl }, index)?.key, row.key);
  assert.equal(matchRecord({
    company: '甲人寿保险有限公司',
    productName: '甲产品 A款',
  }, index)?.key, row.key);
});
