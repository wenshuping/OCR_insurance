import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCanonicalRawText,
  findExactRanges,
  mapOfficialResponsibility,
  parseCanonicalRawPages,
  runV4,
  validateSourceContract,
} from '../scripts/audit-legacy-indicator-safe-reuse-v4.mjs';
import { canonicalPages, fixtures } from './fixtures/legacy-indicator-safe-reuse-v4-fixtures.mjs';

function canonicalFixture(fixture) {
  const pages = parseCanonicalRawPages(JSON.stringify(canonicalPages(fixture.text)));
  return buildCanonicalRawText(pages);
}

test('v4 maps a cross-page responsibility with page and absolute offsets', () => {
  const fixture = fixtures.crossPage;
  const result = mapOfficialResponsibility({ packet: fixture.packets[0], allPackets: fixture.packets, canonical: canonicalFixture(fixture) });
  assert.equal(result.status, 'mapped');
  assert.ok(result.officialRanges.some((range) => range.page === 2));
  assert.ok(result.officialRanges.some((range) => range.page === 3));
  for (const range of result.officialRanges) assert.equal(canonicalFixture(fixture).rawText.slice(range.absoluteStart, range.absoluteEnd), range.exactText);
});

test('v4 maps multiple same-page responsibilities without merging them', () => {
  const fixture = fixtures.samePageMultiple;
  const canonical = canonicalFixture(fixture);
  const results = fixture.packets.map((packet) => mapOfficialResponsibility({ packet, allPackets: fixture.packets, canonical }));
  assert.deepEqual(results.map((item) => item.status), ['mapped', 'mapped']);
  assert.ok(results[0].bodyRange.absoluteEnd <= results[1].bodyRange.absoluteStart);
});

test('v4 rejects a contents-page duplicate and uses the body occurrence', () => {
  const fixture = fixtures.contentsDuplicate;
  const result = mapOfficialResponsibility({ packet: fixture.packets[0], allPackets: fixture.packets, canonical: canonicalFixture(fixture) });
  assert.equal(result.status, 'mapped');
  assert.equal(result.titleRanges[0].page, 2);
});

test('v4 whitespace search returns the original raw exact slice', () => {
  const fixture = fixtures.whitespaceRaw;
  const canonical = canonicalFixture(fixture);
  const ranges = findExactRanges({ ...canonical, searchText: '基本保险金额' });
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].exactText, '基本 \n保险金额');
  assert.equal(canonical.rawText.slice(ranges[0].absoluteStart, ranges[0].absoluteEnd), ranges[0].exactText);
});

test('v4 keeps non-contiguous evidence ranges separate', () => {
  const fixture = fixtures.nonContiguous;
  const result = mapOfficialResponsibility({ packet: fixture.packets[0], allPackets: fixture.packets, canonical: canonicalFixture(fixture) });
  assert.equal(result.status, 'mapped');
  assert.ok(result.limitRanges.length >= 2);
  assert.equal(result.limitRanges[0].absoluteEnd <= result.limitRanges[1].absoluteStart, true);
});

test('v4 rejects mixed plain and layout extraction layers', () => {
  assert.throws(() => parseCanonicalRawPages('PDF_PAGE_1\n正文\nPDF_LAYOUT_PAGE_1\n布局'), /mixed_text_layers/u);
});

test('v4 rejects a missing page instead of guessing offsets', () => {
  assert.throws(() => parseCanonicalRawPages('PDF_PAGE_1\n一页\nPDF_PAGE_3\n三页'), /missing_page_sequence/u);
});

test('v4 source contract digest mismatch is a blocker', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-contract-'));
  const sourceFile = path.join(temp, 'source.pdf');
  fs.writeFileSync(sourceFile, '%PDF-1.4\n/Type /Page\n');
  const result = validateSourceContract({ sourceStatus: 'source_ready', sourceDigest: 'sha256:' + 'b'.repeat(64), sourceFile, extractedTextFile: sourceFile, responsibilityTextFile: sourceFile, pdf: { pages: 1 }, identityEvidence: { company: '测试保险公司', productName: 'v4页码映射产品' } }, { sourceDigest: 'sha256:' + 'a'.repeat(64), company: '测试保险公司', productName: 'v4页码映射产品' });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('digest_contract_mismatch'));
  assert.ok(result.blockers.includes('source_file_sha_mismatch'));
  fs.rmSync(temp, { recursive: true, force: true });
});

test('v4 damaged formula/table stays in source review', () => {
  const fixture = fixtures.damagedTable;
  const result = mapOfficialResponsibility({ packet: fixture.packets[0], allPackets: fixture.packets, canonical: canonicalFixture(fixture) });
  assert.equal(result.status, 'source_reacquire_or_ocr_review');
  assert.ok(result.blockers.some((item) => item.startsWith('formula_unmapped:')));
});

test('v4 current 30-product input produces one merged source task per product and no legacy values', () => {
  const result = runV4();
  assert.equal(result.counts.products, 30);
  assert.equal(result.counts.classes.source_reacquire_or_ocr_review, 30);
  assert.equal(result.sourceRows.length, 30);
  assert.ok(result.sourceRows.some((row) => row.responsibilities.length > 1));
  assert.equal(result.modelCalls, 0);
  assert.equal(result.legacyPollutionLeakCount, 0);
  assert.doesNotMatch(JSON.stringify(result), /旧指标虚构公式|legacy-poison-99-percent|错误比例99%/u);
});
