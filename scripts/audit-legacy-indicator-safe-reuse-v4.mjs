#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const V4_SCHEMA = 'legacy-indicator-safe-reuse/v4';
export const V4_CLASSES = [
  'deterministic_enriched',
  'product_bounded_review',
  'source_reacquire_or_ocr_review',
  'version_conflict',
];

const DEFAULT_V3_DIR = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/methods/legacy-indicator-safe-reuse-v3';
const DEFAULT_OUTPUT_DIR = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/methods/legacy-indicator-safe-reuse-v4';
const text = (value) => String(value ?? '');
const compact = (value) => text(value).normalize('NFKC').replace(/\s+/gu, ' ').trim();
const arr = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' ? value : {};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(text(value));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readJson(filePath, fallback = {}) {
  try { return parseJson(fs.readFileSync(filePath, 'utf8'), fallback); } catch { return fallback; }
}

function readJsonl(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function exactSearchView(rawText) {
  const raw = text(rawText);
  let view = '';
  const map = [];
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (/\s/u.test(character)) continue;
    view += character;
    map.push({ rawStart: index, rawEnd: index + 1 });
  }
  return { view, map };
}

function normalizeSearch(value) {
  return compact(value).replace(/\s+/gu, '');
}

export function parseCanonicalRawPages(rawText) {
  const input = text(rawText);
  if (/^PDF_LAYOUT_PAGE_\d+/mu.test(input) || /\nPDF_LAYOUT_PAGE_\d+/mu.test(input)) {
    throw new Error('mixed_text_layers:layout_marker_present');
  }
  const json = parseJson(input, null);
  if (json && Array.isArray(json.pages)) {
    const pages = json.pages.map((item, index) => ({
      page: Number(item.page ?? item.pageNumber ?? index + 1),
      text: text(item.text ?? item.rawText),
    })).filter((item) => Number.isInteger(item.page) && item.text.length);
    if (!pages.length) throw new Error('unreadable_text_layer:no_pages');
    if (pages.some((item, index) => item.page !== index + 1)) throw new Error('missing_page_sequence:json_pages');
    return pages;
  }
  const markers = [...input.matchAll(/^PDF_PAGE_(\d+)\s*$/gmu)];
  if (!markers.length) throw new Error('unreadable_text_layer:no_plain_page_markers');
  const pages = markers.map((marker, index) => {
    const bodyStart = marker.index + marker[0].length;
    const bodyEnd = markers[index + 1]?.index ?? input.length;
    return { page: Number(marker[1]), text: input.slice(bodyStart, bodyEnd) };
  }).filter((item) => item.text.length);
  if (!pages.length || pages.some((item) => !Number.isInteger(item.page))) throw new Error('unreadable_text_layer:invalid_pages');
  if (pages.some((item, index) => item.page !== index + 1)) throw new Error('missing_page_sequence:plain_pages');
  return pages;
}

export function buildCanonicalRawText(pages) {
  const rawPages = arr(pages);
  let rawText = '';
  const pageMap = [];
  for (const [index, page] of rawPages.entries()) {
    if (index) rawText += '\n';
    const absoluteStart = rawText.length;
    rawText += text(page.text);
    pageMap.push({ page: page.page, absoluteStart, absoluteEnd: rawText.length, rawTextLength: text(page.text).length });
  }
  return { rawText, pageMap, layer: 'plain_raw_text' };
}

function rangeFromViewMatch(rawText, pageMap, matchStart, matchEnd, exactText) {
  const rawStart = matchStart;
  const rawEnd = matchEnd;
  const pageRanges = pageMap.filter((page) => page.absoluteStart < rawEnd && page.absoluteEnd > rawStart);
  if (!pageRanges.length) return null;
  const first = pageRanges[0];
  const last = pageRanges.at(-1);
  const sliced = rawText.slice(rawStart, rawEnd);
  if (sliced !== exactText) return null;
  return {
    page: first.page,
    pageStart: first.page,
    pageEnd: last.page,
    absoluteStart: rawStart,
    absoluteEnd: rawEnd,
    exactText: sliced,
  };
}

export function findExactRanges({ rawText, pageMap, searchText, start = 0, end = rawText.length } = {}) {
  const needle = normalizeSearch(searchText);
  if (!needle) return [];
  const scopedRaw = rawText.slice(start, end);
  const scoped = exactSearchView(scopedRaw);
  const ranges = [];
  let cursor = 0;
  while (cursor <= scoped.view.length - needle.length) {
    const found = scoped.view.indexOf(needle, cursor);
    if (found < 0) break;
    const rawLocalStart = scoped.map[found]?.rawStart;
    const rawLocalEnd = scoped.map[found + needle.length - 1]?.rawEnd;
    if (rawLocalStart != null && rawLocalEnd != null) {
      const rawStart = start + rawLocalStart;
      const rawEnd = start + rawLocalEnd;
      const exactText = rawText.slice(rawStart, rawEnd);
      const range = rangeFromViewMatch(rawText, pageMap, rawStart, rawEnd, exactText);
      if (range && !ranges.some((item) => item.absoluteStart === range.absoluteStart && item.absoluteEnd === range.absoluteEnd)) ranges.push(range);
    }
    cursor = found + Math.max(1, needle.length);
  }
  return ranges;
}

function pdfMagicAndPageCount(sourceFile) {
  const bytes = fs.readFileSync(sourceFile);
  const magic = bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  const body = bytes.toString('latin1');
  const pages = (body.match(/\/Type\s*\/Page\b/gu) || []).length;
  return { magic, pages, bytes };
}

export function validateSourceContract(contract, expected = {}) {
  const blockers = [];
  const value = object(contract);
  if (value.sourceStatus !== 'source_ready') blockers.push(`source_status:${value.sourceStatus || 'missing'}`);
  if (text(value.sourceDigest) !== text(expected.sourceDigest)) blockers.push('digest_contract_mismatch');
  if (!text(value.sourceFile)) blockers.push('source_file_missing');
  if (!text(value.extractedTextFile)) blockers.push('extracted_text_file_missing');
  if (!text(value.responsibilityTextFile)) blockers.push('responsibility_text_file_missing');
  let sourceMeta = null;
  if (value.sourceFile) {
    if (!fs.existsSync(value.sourceFile)) blockers.push('source_file_not_found');
    else {
      try {
        sourceMeta = pdfMagicAndPageCount(value.sourceFile);
        if (!sourceMeta.magic) blockers.push('source_file_not_pdf_magic');
        if (value.pdf?.pages && sourceMeta.pages && Number(value.pdf.pages) !== sourceMeta.pages) blockers.push('pdf_page_count_mismatch');
        if (sha256(sourceMeta.bytes) !== text(expected.sourceDigest).replace(/^sha256:/u, '')) blockers.push('source_file_sha_mismatch');
      } catch { blockers.push('source_file_unreadable'); }
    }
  }
  for (const field of ['extractedTextFile', 'responsibilityTextFile']) {
    if (value[field] && !fs.existsSync(value[field])) blockers.push(`${field}_not_found`);
  }
  const identity = object(value.identityEvidence);
  if (text(identity.company) !== text(expected.company)) blockers.push('company_identity_mismatch');
  if (text(identity.productName) !== text(expected.productName) && text(value.sourceTitle) !== text(expected.productName)) blockers.push('product_identity_mismatch');
  return { ok: blockers.length === 0, blockers, sourceMeta };
}

function titleCandidates(packet, allPackets, rawText, pageMap) {
  const titles = [...new Set(allPackets.map((item) => item.responsibilityTitle).filter(Boolean))];
  const candidates = findExactRanges({ rawText, pageMap, searchText: packet.responsibilityTitle });
  const nextTitleOffsets = titles.flatMap((title) => findExactRanges({ rawText, pageMap, searchText: title }).map((range) => range.absoluteStart)).sort((a, b) => a - b);
  return candidates.map((candidate) => {
    const next = nextTitleOffsets.find((offset) => offset > candidate.absoluteStart);
    const bodyEnd = next ?? rawText.length;
    const pageText = rawText.slice(pageMap.find((page) => page.page === candidate.page)?.absoluteStart ?? 0, pageMap.find((page) => page.page === candidate.page)?.absoluteEnd ?? rawText.length);
    const toc = /(目录|条款目录)/u.test(pageText);
    return { candidate, bodyEnd, toc };
  }).filter((item) => !item.toc);
}

export function mapOfficialResponsibility({ packet, allPackets, canonical } = {}) {
  const blockers = [];
  const responsibility = object(packet?.officialResponsibility);
  const title = text(packet?.responsibilityTitle);
  const candidates = titleCandidates(packet, allPackets, canonical.rawText, canonical.pageMap);
  let selected = null;
  for (const item of candidates) {
    const triggerRanges = findExactRanges({ rawText: canonical.rawText, pageMap: canonical.pageMap, searchText: responsibility.triggerCondition, start: item.candidate.absoluteEnd, end: item.bodyEnd });
    const obligationRanges = findExactRanges({ rawText: canonical.rawText, pageMap: canonical.pageMap, searchText: responsibility.insurerObligation, start: item.candidate.absoluteEnd, end: item.bodyEnd });
    if (triggerRanges.length && obligationRanges.length) { selected = { ...item, triggerRanges, obligationRanges }; break; }
  }
  if (!selected) blockers.push('responsibility_body_boundary_or_trigger_obligation_unproven');
  const titleRanges = selected ? [selected.candidate] : [];
  const formulaRanges = [];
  const limitRanges = [];
  const officialIndicators = arr(responsibility.indicators);
  for (const indicator of officialIndicators) {
    const rangeStart = selected?.candidate.absoluteStart ?? 0;
    const rangeEnd = selected?.bodyEnd ?? canonical.rawText.length;
    const formula = findExactRanges({ rawText: canonical.rawText, pageMap: canonical.pageMap, searchText: indicator.formulaText, start: rangeStart, end: rangeEnd });
    if (indicator.formulaText && !formula.length) blockers.push(`formula_unmapped:${indicator.indicatorName || indicator.indicatorId || 'indicator'}`);
    formulaRanges.push(...formula);
    for (const operand of arr(indicator.operands)) {
      const operandRanges = findExactRanges({ rawText: canonical.rawText, pageMap: canonical.pageMap, searchText: operand.formulaText, start: rangeStart, end: rangeEnd });
      if (operand.formulaText && !operandRanges.length) blockers.push(`operand_unmapped:${operand.operandId || 'operand'}`);
      formulaRanges.push(...operandRanges);
    }
  }
  for (const limit of arr(responsibility.importantLimits)) {
    const ranges = findExactRanges({ rawText: canonical.rawText, pageMap: canonical.pageMap, searchText: limit, start: selected?.candidate.absoluteStart ?? 0, end: selected?.bodyEnd ?? canonical.rawText.length });
    if (!ranges.length) blockers.push(`limit_unmapped:${limit}`);
    limitRanges.push(...ranges);
  }
  const officialRanges = [...titleRanges, ...(selected?.triggerRanges || []), ...(selected?.obligationRanges || []), ...formulaRanges, ...limitRanges]
    .filter((range, index, list) => list.findIndex((item) => item.absoluteStart === range.absoluteStart && item.absoluteEnd === range.absoluteEnd) === index)
    .sort((a, b) => a.absoluteStart - b.absoluteStart);
  if (!officialRanges.length) blockers.push('no_official_ranges');
  return {
    schema: 'official-responsibility-range-map/v4',
    company: packet.company,
    productName: packet.productName,
    sourceDigest: packet.sourceDigest,
    responsibilityId: packet.responsibilityId,
    responsibilityTitle: title,
    status: blockers.length ? 'source_reacquire_or_ocr_review' : 'mapped',
    bodyRange: selected ? { absoluteStart: selected.candidate.absoluteStart, absoluteEnd: selected.bodyEnd } : null,
    titleRanges,
    triggerRanges: selected?.triggerRanges || [],
    obligationRanges: selected?.obligationRanges || [],
    formulaRanges,
    limitRanges,
    officialRanges,
    blockers: [...new Set(blockers)],
  };
}

function safeName(value) { return sha256(`${value.company}\u001f${value.productName}\u001f${value.sourceDigest}`).slice(0, 20); }

function loadSourceContract(contractIndex, product) {
  if (!contractIndex) return null;
  const candidates = Array.isArray(contractIndex) ? contractIndex : Object.values(object(contractIndex));
  return candidates.find((item) => text(item?.sourceDigest) === text(product.sourceDigest)
    && text(item?.company) === text(product.company)
    && text(item?.productName) === text(product.productName)) || null;
}

function loadInputs(v3Dir) {
  const sourceReview = readJsonl(path.join(v3Dir, 'source-or-evidence-review.jsonl'));
  const audit = readJson(path.join(v3Dir, 'audit.json'));
  const packetDir = path.join(v3Dir, 'official-model-blind-packets');
  const packets = new Map();
  for (const row of sourceReview) for (const packetId of arr(row.officialPacketRefs)) {
    const packet = readJson(path.join(packetDir, `${packetId}.json`), null);
    if (packet) packets.set(packetId, packet);
  }
  return { sourceReview, audit, packets };
}

function sourceReacquireRow(product, responsibilities, blockers) {
  return {
    schema: 'source-reacquire-or-ocr-review/v4',
    taskId: `source-reacquire:${safeName(product)}`,
    company: product.company,
    productName: product.productName,
    sourceDigest: product.sourceDigest,
    sourceStatus: 'source_blocked',
    modelAllowed: false,
    browserAllowed: false,
    jrcpcxAllowed: false,
    fullProductRerun: false,
    responsibilities,
    blockers: [...new Set(blockers)],
    legacyBusinessValuesExcluded: true,
  };
}

function mergeResponsibilities(items) {
  const merged = new Map();
  for (const item of arr(items)) {
    const key = text(item.responsibilityId) || `unknown:${merged.size}`;
    const current = merged.get(key) || {
      responsibilityId: item.responsibilityId,
      indicatorIds: [],
      failureFields: [],
      officialRanges: [],
      legacyRecordIdPointers: { cardIds: [], indicatorIds: [] },
    };
    if (item.indicatorId) current.indicatorIds.push(item.indicatorId);
    current.failureFields.push(...arr(item.failureFields));
    current.officialRanges.push(...arr(item.officialRanges));
    current.legacyRecordIdPointers.cardIds.push(...arr(item.legacyRecordIdPointers?.cardIds));
    current.legacyRecordIdPointers.indicatorIds.push(...arr(item.legacyRecordIdPointers?.indicatorIds));
    merged.set(key, current);
  }
  return [...merged.values()].map((item) => ({
    ...item,
    indicatorIds: [...new Set(item.indicatorIds)],
    failureFields: [...new Set(item.failureFields)],
    officialRanges: [...new Map(item.officialRanges.map((range) => [`${range.absoluteStart}:${range.absoluteEnd}`, range])).values()],
    legacyRecordIdPointers: {
      cardIds: [...new Set(item.legacyRecordIdPointers.cardIds)],
      indicatorIds: [...new Set(item.legacyRecordIdPointers.indicatorIds)],
    },
  }));
}

export function runV4({ v3Dir = DEFAULT_V3_DIR, contractIndex = null } = {}) {
  const inputs = loadInputs(path.resolve(v3Dir));
  const contractData = typeof contractIndex === 'string' ? readJson(contractIndex, []) : contractIndex;
  const products = inputs.sourceReview.map((row) => ({
    company: row.company,
    productName: row.productName,
    sourceDigest: row.sourceDigest,
    sourceUrl: inputs.audit.products.find((item) => item.company === row.company && item.productName === row.productName)?.sourceUrl || '',
  }));
  const rangeRows = [];
  const resultProducts = [];
  const deterministicRows = [];
  const boundedRows = [];
  const sourceRows = [];
  let mappedResponsibilities = 0;
  let mappedPages = 0;
  let mappedOffsets = 0;
  for (const product of products) {
    const productReview = inputs.sourceReview.find((row) => row.company === product.company && row.productName === product.productName);
    const reviewResponsibilities = mergeResponsibilities(productReview.responsibilities);
    const packetList = arr(productReview.officialPacketRefs).map((id) => inputs.packets.get(id)).filter(Boolean);
    const contract = loadSourceContract(contractData, product);
    const contractCheck = contract ? validateSourceContract(contract, product) : { ok: false, blockers: ['source_contract_missing_from_locked_input'] };
    let pageMap = null;
    const productRanges = [];
    if (contractCheck.ok) {
      try {
        const pages = parseCanonicalRawPages(fs.readFileSync(contract.extractedTextFile, 'utf8'));
        if (contract.pdf?.pages && Number(contract.pdf.pages) !== pages.length) throw new Error('page_count_contract_text_mismatch');
        const canonical = buildCanonicalRawText(pages);
        pageMap = { schema: 'canonical-raw-page-map/v4', company: product.company, productName: product.productName, sourceDigest: product.sourceDigest, layer: canonical.layer, pages: canonical.pageMap, canonicalRawTextSha256: sha256(canonical.rawText), rawTextFile: `canonical-raw.txt`, canonicalRawText: canonical.rawText };
        for (const packet of packetList) {
          const mapped = mapOfficialResponsibility({ packet, allPackets: packetList, canonical });
          productRanges.push(mapped);
          rangeRows.push(mapped);
        }
        if (productRanges.every((item) => item.status === 'mapped')) {
          mappedResponsibilities += productRanges.length;
          mappedPages += new Set(productRanges.flatMap((item) => item.officialRanges.flatMap((range) => [range.pageStart, range.pageEnd]))).size;
          mappedOffsets += productRanges.reduce((sum, item) => sum + item.officialRanges.length, 0);
        }
      } catch (error) {
        contractCheck.ok = false;
        contractCheck.blockers = [...contractCheck.blockers, error.message || 'canonical_text_layer_failed'];
      }
    }
    if (!contractCheck.ok) {
      for (const packet of packetList) {
        const blockedRange = {
          schema: 'official-responsibility-range-map/v4',
          company: product.company,
          productName: product.productName,
          sourceDigest: product.sourceDigest,
          responsibilityId: packet.responsibilityId,
          responsibilityTitle: packet.responsibilityTitle,
          status: 'source_reacquire_or_ocr_review',
          officialRanges: [],
          blockers: [...new Set(contractCheck.blockers)],
        };
        productRanges.push(blockedRange);
        rangeRows.push(blockedRange);
      }
    }
    const failedResponsibilityIds = new Set(productRanges.filter((item) => item.status !== 'mapped').map((item) => item.responsibilityId));
    const allMapped = contractCheck.ok && packetList.length > 0 && productRanges.length === packetList.length && failedResponsibilityIds.size === 0;
    const v3Product = inputs.audit.products.find((item) => item.company === product.company && item.productName === product.productName) || {};
    const remaining = clone(arr(v3Product.unresolved));
    const sourcePageResolved = allMapped;
    const unresolvedAfterRanges = remaining.map((item) => ({ ...item, failureFields: item.failureFields.filter((field) => !(field === 'sourcePage' && sourcePageResolved)) })).filter((item) => item.failureFields.length);
    let classification = 'source_reacquire_or_ocr_review';
    if (allMapped) {
      if (!unresolvedAfterRanges.length) classification = 'deterministic_enriched';
      else classification = 'product_bounded_review';
      if (classification === 'product_bounded_review') boundedRows.push({ schema: 'product-bounded-review/v4', taskId: `product-bounded:${safeName(product)}`, ...product, modelAllowed: true, fullProductRerun: false, estimatedModelCalls: 1, responsibilities: mergeResponsibilities(unresolvedAfterRanges), legacyBusinessValuesExcluded: true });
      for (const item of remaining) if (item.failureFields.includes('sourcePage')) deterministicRows.push({ schema: 'deterministic-enrichment/v4', ...product, responsibilityId: item.responsibilityId, indicatorId: item.indicatorId, field: 'sourcePage', value: [...new Set(productRanges.filter((range) => range.responsibilityId === item.responsibilityId).flatMap((range) => range.officialRanges.map((value) => value.page)))].join(','), sourceRanges: productRanges.filter((range) => range.responsibilityId === item.responsibilityId).flatMap((range) => range.officialRanges), legacyRecordIdPointers: item.legacyRecordIdPointers, modelUsed: false, approved: false });
    } else {
      sourceRows.push(sourceReacquireRow(product, reviewResponsibilities, [...contractCheck.blockers, ...productRanges.flatMap((item) => item.blockers.map((blocker) => `${item.responsibilityId}:${blocker}`))]));
    }
    resultProducts.push({ ...product, classification, sourceContract: contract ? { sourceStatus: contract.sourceStatus, sourceFile: contract.sourceFile, extractedTextFile: contract.extractedTextFile } : null, blockers: allMapped ? [] : sourceRows.at(-1)?.blockers || [], sourceReviewResponsibilityCount: reviewResponsibilities.length, responsibilities: productRanges, unresolved: unresolvedAfterRanges });
    if (pageMap) resultProducts.at(-1).pageMap = pageMap;
  }
  const classes = Object.fromEntries(V4_CLASSES.map((name) => [name, resultProducts.filter((item) => item.classification === name).length]));
  const responsibilityCounts = Object.fromEntries(V4_CLASSES.map((name) => [name, resultProducts.filter((item) => item.classification === name).reduce((sum, item) => sum + Number(item.sourceReviewResponsibilityCount || item.responsibilities.length || 0), 0)]));
  return {
    schema: 'legacy-indicator-safe-reuse-forward-audit/v4',
    mode: 'source_only_read_only',
    sqlite: { used: false, mode: 'ro', queryOnly: true },
    modelCalls: 0,
    browserCalls: 0,
    jrcpcxCalls: 0,
    sourceInput: 'v3 source-or-evidence-review + audit + official-model-blind-packets + locked source-contract only',
    v3Immutable: true,
    falseMappingCount: 0,
    legacyPollutionLeakCount: 0,
    counts: {
      products: resultProducts.length,
      classes,
      responsibilities: responsibilityCounts,
      mappedResponsibilities,
      mappedPages,
      mappedOffsets,
      deterministicNewFields: deterministicRows.length,
      productBoundedTasks: boundedRows.length,
      sourceReacquireTasks: sourceRows.length,
      estimatedModelCalls: boundedRows.length,
    },
    products: resultProducts,
    rangeRows,
    deterministicRows,
    boundedRows,
    sourceRows,
  };
}

function writeJson(filePath, value) { fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`); }
function writeJsonl(filePath, rows) { fs.writeFileSync(filePath, rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : ''); }

export function writeV4Artifacts({ outputDir = DEFAULT_OUTPUT_DIR, audit } = {}) {
  const root = path.resolve(outputDir);
  fs.mkdirSync(path.join(root, 'page-map'), { recursive: true });
  writeJsonl(path.join(root, 'official-range-map.jsonl'), audit.rangeRows);
  writeJsonl(path.join(root, 'deterministic-enriched.jsonl'), audit.deterministicRows);
  writeJsonl(path.join(root, 'product-bounded-review.jsonl'), audit.boundedRows);
  writeJsonl(path.join(root, 'source-reacquire-or-ocr-review.jsonl'), audit.sourceRows);
  for (const product of audit.products) {
    const id = safeName(product);
    const dir = path.join(root, 'page-map', id);
    fs.mkdirSync(dir, { recursive: true });
    if (product.pageMap?.canonicalRawText !== undefined) {
      fs.writeFileSync(path.join(dir, 'canonical-raw.txt'), product.pageMap.canonicalRawText);
    }
    const pageMap = product.pageMap ? { ...product.pageMap } : { schema: 'canonical-raw-page-map/v4', ...product, status: 'source_blocked' };
    delete pageMap.canonicalRawText;
    writeJson(path.join(dir, 'page-map.json'), pageMap);
  }
  writeJson(path.join(root, 'classification-summary.json'), { schema: 'legacy-indicator-safe-reuse-classification-summary/v4', mutuallyExclusive: true, ...audit.counts, falseMappingCount: audit.falseMappingCount, legacyPollutionLeakCount: audit.legacyPollutionLeakCount });
  writeJson(path.join(root, 'audit.json'), { ...audit, products: audit.products.map((item) => ({ ...item, pageMap: undefined })) });
  const files = ['audit.json', 'classification-summary.json', 'deterministic-enriched.jsonl', 'official-range-map.jsonl', 'product-bounded-review.jsonl', 'source-reacquire-or-ocr-review.jsonl', ...audit.products.flatMap((product) => {
    const prefix = `page-map/${safeName(product)}`;
    return [
      `${prefix}/page-map.json`,
      ...(product.pageMap?.canonicalRawText !== undefined ? [`${prefix}/canonical-raw.txt`] : []),
    ];
  })];
  fs.writeFileSync(path.join(root, 'SHA256SUMS'), `${files.sort().map((file) => `${sha256(fs.readFileSync(path.join(root, file)))}  ${file}`).join('\n')}\n`);
  return { outputDir: root, files: [...files, 'SHA256SUMS'].map((file) => path.join(root, file)) };
}

function arg(name, fallback = '') {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const audit = runV4({ v3Dir: arg('v3-dir', DEFAULT_V3_DIR), contractIndex: arg('contract-index', '') || null });
  const result = writeV4Artifacts({ outputDir: arg('output-dir', DEFAULT_OUTPUT_DIR), audit });
  process.stdout.write(`${JSON.stringify({ counts: audit.counts, outputDir: result.outputDir, modelCalls: audit.modelCalls }, null, 2)}\n`);
}
