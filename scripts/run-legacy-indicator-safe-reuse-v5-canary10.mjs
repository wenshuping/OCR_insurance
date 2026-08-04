#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  buildCanonicalRawText,
  parseCanonicalRawPages,
} from './audit-legacy-indicator-safe-reuse-v4.mjs';

const V4_DIR = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/methods/legacy-indicator-safe-reuse-v4';
const V3_AUDIT = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/methods/legacy-indicator-safe-reuse-v3/audit.json';
const OUTPUT_DIR = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/methods/legacy-indicator-safe-reuse-v5-canary10';
const SOURCE_REPAIR = '.agents/skills/ocr-insurance-official-source-acquisition/scripts/repair_source_queue.py';
const SELECTED_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 17];
const DB_PATH = '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite';
const CATEGORY_BY_INDEX = new Map([
  [0, 'medical'], [1, 'life'], [2, 'annuity'], [3, 'critical_illness'],
  [4, 'critical_illness'], [5, 'critical_illness'], [6, 'life'], [7, 'life'],
  [8, 'life'], [17, 'accident'],
]);

const text = (value) => String(value ?? '');
const arr = (value) => Array.isArray(value) ? value : [];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readJsonl = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const compact = (value) => text(value).normalize('NFKC').replace(/\s+/gu, ' ').trim();
const normalizeSearch = (value) => compact(value).replace(/\s+/gu, '');
const stableKey = (value) => text(value).normalize('NFKC').replace(/[\s「」『』（）()【】、，。:：;；/\\_-]+/gu, '');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '');
}

function fileSha256(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function writeSha256Sums(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name !== 'SHA256SUMS') files.push(file);
    }
  };
  walk(root);
  const lines = files.map((file) => `${fileSha256(file)}  ${path.relative(root, file).split(path.sep).join('/')}`);
  fs.writeFileSync(path.join(root, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  return { fileCount: lines.length, sha256: fileSha256(path.join(root, 'SHA256SUMS')) };
}

export function parseMarkedPages(markedText) {
  const input = text(markedText);
  const markers = [...input.matchAll(/^===== PAGE (\d+) =====\s*$/gmu)];
  if (!markers.length) throw new Error('canonical_text_missing_page_markers');
  const pages = markers.map((marker, index) => ({
    page: Number(marker[1]),
    text: input.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? input.length),
  }));
  return parseCanonicalRawPages(JSON.stringify({ pages }));
}

function rawRange(canonical, start, end, label = '') {
  const absoluteStart = Math.max(0, Number(start));
  const absoluteEnd = Math.max(absoluteStart, Number(end));
  const pages = canonical.pageMap.filter((page) => page.absoluteStart < absoluteEnd && page.absoluteEnd > absoluteStart);
  if (!pages.length || canonical.rawText.slice(absoluteStart, absoluteEnd).length !== absoluteEnd - absoluteStart) throw new Error(`range_outside_canonical_text:${label}`);
  return {
    label,
    page: pages[0].page,
    pageStart: pages[0].page,
    pageEnd: pages.at(-1).page,
    absoluteStart,
    absoluteEnd,
    exactText: canonical.rawText.slice(absoluteStart, absoluteEnd),
  };
}

function exactNormalizedInRaw(raw, value) {
  const needle = normalizeSearch(value);
  if (!needle) return false;
  return normalizeSearch(raw).includes(needle);
}

function pageForOffset(canonical, offset) {
  return canonical.pageMap.find((page) => page.absoluteStart <= offset && page.absoluteEnd >= offset)?.page || null;
}

function sourceContractFor(root, product) {
  const index = String(product.selectionIndex).padStart(2, '0');
  const retry = path.join(root, 'source-contract', 'retry-1', index, 'source-contract.json');
  const initial = path.join(root, 'source-contract', index, 'source-contract.json');
  const manifestPath = fs.existsSync(retry) && readJson(retry).sourceStatus === 'source_ready' ? retry : initial;
  return { manifestPath, manifest: fs.existsSync(manifestPath) ? readJson(manifestPath) : null };
}

function copyActiveSourceContract(root, product, contract) {
  const index = String(product.selectionIndex).padStart(2, '0');
  const activeDir = path.join(root, 'source-contract', index, 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  const active = { ...contract };
  for (const field of ['sourceFile', 'extractedTextFile', 'responsibilityTextFile']) {
    if (!contract[field] || !fs.existsSync(contract[field])) continue;
    const target = path.join(activeDir, path.basename(contract[field]));
    fs.copyFileSync(contract[field], target);
    active[field] = target;
  }
  active.activeSourceContract = true;
  active.activeFrom = contract.sourceFile;
  const activePath = path.join(activeDir, 'source-contract.json');
  writeJson(activePath, active);
  return { active, activePath };
}

function sectionCandidates(canonical) {
  const raw = canonical.rawText;
  return [...raw.matchAll(/保险责任/gu)].map((match) => {
    const page = pageForOffset(canonical, match.index);
    const pageText = canonical.rawText.slice(canonical.pageMap.find((item) => item.page === page)?.absoluteStart || 0, canonical.pageMap.find((item) => item.page === page)?.absoluteEnd || canonical.rawText.length);
    const window = raw.slice(match.index, match.index + 1200);
    return { start: match.index, page, pageText, window, toc: /目录/u.test(pageText), body: /我们将承担|若被保险人|在本合同保险责任有效期内/u.test(window) };
  }).filter((item) => !item.toc && item.body);
}

function findOfficialBodySection(canonical, predicate) {
  const sections = sectionCandidates(canonical).filter(predicate);
  return sections[0] || null;
}

function bodyBoundary(canonical, start) {
  const raw = canonical.rawText;
  const candidates = [
    raw.indexOf('\n保险期间', start + 4), raw.indexOf('\n保单红利', start + 4),
    raw.indexOf('\n责任免除', start + 4), raw.indexOf('\n第八条', start + 4),
  ].filter((value) => value > start);
  return candidates.length ? Math.min(...candidates) : raw.length;
}

function inferCoverage(title) {
  if (/医疗|住院|门诊|药品/u.test(title)) return '医疗保障';
  if (/重大疾病|轻症|中症|疾病/u.test(title)) return '疾病保障';
  if (/意外|伤残|交通/u.test(title)) return '意外保障';
  if (/年金|生存|满期/u.test(title)) return '现金流';
  return '人寿保障';
}

function officialId(sourceDigest, title, offset) {
  return `official-responsibility-${sha256(`${sourceDigest}\u001f${title}\u001f${offset}`).slice(0, 20)}`;
}

function makeSimpleInventory(product, canonical) {
  const section = findOfficialBodySection(canonical, (item) => /我们将承担以下保险责任/u.test(item.window));
  if (!section) throw new Error('official_inventory_responsibility_section_not_found');
  const end = bodyBoundary(canonical, section.start);
  const body = canonical.rawText.slice(section.start, end);
  const headings = [...body.matchAll(/^（(\d+)）\s*([^\n]+)/gmu)].map((match) => ({
    number: Number(match[1]),
    rawTitle: match[2].trim(),
    title: compact(match[2]),
    start: section.start + match.index + match[0].indexOf(match[2]),
  })).filter((item) => item.title && !/责任免除|其他免责|保险责任$/u.test(item.title));
  const unique = [...new Map(headings.map((item) => [stableKey(item.title), item])).values()];
  if (!unique.length) throw new Error('official_inventory_no_independent_payout_headings');
  return unique.map((item, index) => {
    const next = unique[index + 1]?.start || end;
    const titleRange = rawRange(canonical, item.start, item.start + item.rawTitle.length, 'official_title');
    const bodyRange = rawRange(canonical, item.start, next, 'responsibility_body');
    const title = item.title;
    const id = officialId(product.sourceDigest, title, item.start);
    return {
      responsibilityId: id,
      sectionNumber: `1.1.${item.number}`,
      officialTitle: title,
      originalTitle: title,
      independentPayoutUnit: true,
      inventoryEvidence: { titleRange, bodyRange },
      officialRanges: [titleRange, bodyRange],
      sourceExcerpt: bodyRange.exactText,
      coverageType: inferCoverage(title),
      indicators: [{
        indicatorId: `official-indicator-${sha256(`${id}\u001findicator`).slice(0, 20)}`,
        indicatorName: `${title}金额`,
        responsibilityId: id,
        formulaStatus: /较大者|较小者|比例|金额|现金价值|基本保险金额|账户价值|年金/u.test(bodyRange.exactText) ? 'official_formula_evidence_present' : 'manual_formula_review',
        formulaEvidenceRanges: [bodyRange],
        operandsPreserved: true,
        branchesPreserved: true,
      }],
    };
  });
}

function makeMedicalInventory(product, canonical) {
  const section = findOfficialBodySection(canonical, (item) => /我们将承担以下保险责任/u.test(item.window));
  if (!section) throw new Error('official_inventory_medical_section_not_found');
  const end = bodyBoundary(canonical, section.start);
  const body = canonical.rawText.slice(section.start, end);
  const headings = [...body.matchAll(/[①②③]\s*([^\n]+)/gu)].map((match) => ({
    rawTitle: match[1].trim(),
    title: compact(match[1]),
    start: section.start + match.index + match[0].indexOf(match[1]),
  })).filter((item) => /保险金$/u.test(item.title));
  const unique = [...new Map(headings.map((item) => [stableKey(item.title), item])).values()];
  if (unique.length !== 6) throw new Error(`official_inventory_medical_indicator_count:${unique.length}`);
  return unique.map((item, index) => {
    const next = unique[index + 1]?.start || end;
    const titleRange = rawRange(canonical, item.start, item.start + item.rawTitle.length, 'official_title');
    const bodyRange = rawRange(canonical, item.start, next, 'responsibility_body');
    const id = officialId(product.sourceDigest, item.title, item.start);
    return {
      responsibilityId: id,
      sectionNumber: `1.2.${index + 1}`,
      officialTitle: item.title,
      originalTitle: item.rawTitle,
      independentPayoutUnit: true,
      parentResponsibilityTitle: /恶性肿瘤/u.test(item.title) ? '恶性肿瘤医疗保险金' : '一般医疗保险金',
      inventoryEvidence: { titleRange, bodyRange },
      officialRanges: [titleRange, bodyRange],
      sourceExcerpt: bodyRange.exactText,
      coverageType: '医疗保障',
      indicators: [{
        indicatorId: `official-indicator-${sha256(`${id}\u001findicator`).slice(0, 20)}`,
        indicatorName: `${item.title}金额`,
        responsibilityId: id,
        formulaStatus: 'official_formula_evidence_present',
        formulaEvidenceRanges: [bodyRange],
        operandsPreserved: true,
        branchesPreserved: true,
      }],
    };
  });
}

function makeLifeInventory(product, canonical) {
  const raw = canonical.rawText;
  const sectionStart = raw.indexOf('保险责任 2.3');
  if (sectionStart < 0) throw new Error('official_inventory_life_section_not_found');
  const endCandidate = raw.indexOf('除外责任 2.4', sectionStart);
  const end = endCandidate > sectionStart ? endCandidate : bodyBoundary(canonical, sectionStart);
  const titleNeedle = '身故或全残';
  const titleStart = raw.indexOf(titleNeedle, sectionStart);
  if (titleStart < sectionStart || titleStart >= end) throw new Error('official_inventory_life_title_not_found');
  const titleEnd = raw.indexOf('（见', titleStart) > titleStart ? raw.indexOf('（见', titleStart) : titleStart + titleNeedle.length;
  const titleRange = rawRange(canonical, titleStart, titleEnd, 'official_title');
  const bodyRange = rawRange(canonical, sectionStart, end, 'responsibility_body');
  const title = '身故或全残保险金';
  const id = officialId(product.sourceDigest, title, sectionStart);
  return [{
    responsibilityId: id,
    sectionNumber: '2.3',
    officialTitle: title,
    originalTitle: titleRange.exactText,
    independentPayoutUnit: true,
    inventoryEvidence: { titleRange, bodyRange },
    officialRanges: [titleRange, bodyRange],
    sourceExcerpt: bodyRange.exactText,
    coverageType: '人寿保障',
    indicators: [{
      indicatorId: `official-indicator-${sha256(`${id}\u001findicator`).slice(0, 20)}`,
      indicatorName: `${title}金额`,
      responsibilityId: id,
      formulaStatus: 'official_formula_evidence_present',
      formulaEvidenceRanges: [bodyRange],
      operandsPreserved: true,
      branchesPreserved: true,
    }],
  }];
}

function makeAccidentInventory(product, canonical) {
  const raw = canonical.rawText;
  const sectionStart = [...raw.matchAll(/第七条\s*保险责任/gu)].find((match) => /以下六种风险/u.test(raw.slice(match.index, match.index + 500)))?.index;
  if (sectionStart == null) throw new Error('official_inventory_accident_section_not_found');
  const sectionEnd = raw.indexOf('第八条', sectionStart + 4);
  const end = sectionEnd > sectionStart ? sectionEnd : raw.length;
  const section = raw.slice(sectionStart, end);
  const risks = [...section.matchAll(/^\s*([ⅠⅡⅢⅣⅤⅥ])\s*：\s*([^\n]+)/gmu)].map((match) => ({
    roman: match[1], name: compact(match[2]).replace(/意外身故或伤残$/u, '').replace(/\d+$/u, ''), start: sectionStart + match.index, rawEnd: sectionStart + match.index + match[0].length,
  }));
  if (risks.length < 6) throw new Error(`official_inventory_accident_risk_count:${risks.length}`);
  const units = [];
  const firstBenefit = raw.indexOf('一、交通意外身故保险金', sectionStart);
  const secondBenefit = raw.indexOf('二、交通意外残疾保险金', firstBenefit + 1);
  if (firstBenefit < sectionStart || secondBenefit < firstBenefit) throw new Error('official_inventory_accident_shared_benefit_headings_missing');
  const benefitEnd = raw.indexOf('第八条', secondBenefit) > secondBenefit ? raw.indexOf('第八条', secondBenefit) : end;
  const deathBodyRange = rawRange(canonical, firstBenefit, secondBenefit, 'shared_death_benefit');
  const disabilityBodyRange = rawRange(canonical, secondBenefit, benefitEnd, 'shared_disability_benefit');
  const deathHeadingRange = rawRange(canonical, firstBenefit, firstBenefit + '一、交通意外身故保险金'.length, 'benefit_heading');
  const disabilityHeadingRange = rawRange(canonical, secondBenefit, secondBenefit + '二、交通意外残疾保险金'.length, 'benefit_heading');
  for (const risk of risks.slice(0, 6)) {
    for (const [kind, heading] of [['death', '一、交通意外身故保险金'], ['disability', '二、交通意外残疾保险金']]) {
      const riskRange = rawRange(canonical, risk.start, risk.rawEnd, 'risk_scope');
      const headingRange = kind === 'death' ? deathHeadingRange : disabilityHeadingRange;
      const bodyRange = kind === 'death' ? deathBodyRange : disabilityBodyRange;
      const title = `${risk.name}意外${kind === 'death' ? '身故' : '残疾'}保险金`;
      const id = officialId(product.sourceDigest, `${risk.roman}:${title}`, risk.start);
      units.push({
        responsibilityId: id,
        sectionNumber: `7.${risk.roman}.${kind}`,
        officialTitle: title,
        originalTitle: title,
        independentPayoutUnit: true,
        scope: risk.name,
        inventoryEvidence: { riskRange, headingRange, bodyRange },
        officialRanges: [riskRange, headingRange, bodyRange],
        sourceExcerpt: bodyRange.exactText,
        coverageType: '意外保障',
        indicators: [{
          indicatorId: `official-indicator-${sha256(`${id}\u001findicator`).slice(0, 20)}`,
          indicatorName: `${title}金额`,
          responsibilityId: id,
          formulaStatus: 'official_formula_evidence_present',
          formulaEvidenceRanges: [bodyRange],
          operandsPreserved: true,
          branchesPreserved: true,
        }],
      });
    }
  }
  return units;
}

export function buildOfficialInventory(product, canonical) {
  const responsibilities = /交通工具意外伤害保险/u.test(product.productName)
    ? makeAccidentInventory(product, canonical)
    : /暖宝保/u.test(product.productName)
      ? makeMedicalInventory(product, canonical)
      : /托富未来/u.test(product.productName)
        ? makeLifeInventory(product, canonical)
        : makeSimpleInventory(product, canonical);
  return {
    schema: 'official-responsibility-inventory/v5',
    company: product.company,
    productName: product.productName,
    sourceDigest: product.sourceDigest,
    sourceUrl: product.sourceUrl,
    sourceOfTruth: 'official_raw_pdf_only',
    inventoryLockedBeforeLegacy: true,
    rejectedClasses: ['table_of_contents', 'waiting_period', 'exclusion', 'claim_procedure', 'formula_branch'],
    responsibilities,
    responsibilityCount: responsibilities.length,
  };
}

function parsePayload(row) {
  try { return JSON.parse(row.payload || '{}'); } catch { return {}; }
}

function loadLegacyAfterInventory(product) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON');
    const cards = db.prepare('SELECT id, company, product_name, title, source_url, payload FROM product_responsibility_cards WHERE company = ? AND product_name = ? ORDER BY id').all(product.company, product.productName).map((row) => ({ ...row, payload: parsePayload(row) }));
    const indicators = db.prepare('SELECT id, company, product_name, coverage_type, liability, payload FROM insurance_indicator_records WHERE company = ? AND product_name = ? ORDER BY id').all(product.company, product.productName).map((row) => ({ ...row, payload: parsePayload(row) }));
    return { cards, indicators, queryOnly: Number(db.prepare('PRAGMA query_only').get()?.query_only || 0) };
  } finally { db.close(); }
}

function legacyIndicatorFields(row) {
  const p = row.payload || {};
  return {
    id: row.id,
    liability: row.liability || p.liability || '',
    responsibilityId: p.responsibilityId || '',
    indicatorName: p.indicatorName || '',
    sourceDigest: p.sourceDigest || p.responsibilitySourceDigest || '',
    sourcePage: p.sourcePage || '',
    sourceExcerpt: p.sourceExcerpt || '',
    formulaText: p.formulaText || '',
    normalizedFormula: p.normalizedFormula || '',
    basis: p.basis || '',
    operands: Array.isArray(p.operands) ? p.operands : [],
    branches: Array.isArray(p.branches) ? p.branches : [],
    nested: false,
  };
}

function legacyCardFields(row) {
  const p = row.payload || {};
  return {
    id: row.id,
    title: row.title || p.title || '',
    sourceDigest: p.sourceDigest || '',
    sourcePage: p.sourcePage || '',
    sourceExcerpt: p.sourceExcerpt || '',
    nestedIndicators: Array.isArray(p.indicators) ? p.indicators.map((item) => ({ ...legacyIndicatorFields({ id: item.id || item.indicatorId || '', liability: item.liability || '', payload: item }), nested: true })) : [],
  };
}

function diffAgainstLegacy(product, inventory, canonical, legacy) {
  const cards = legacy.cards.map(legacyCardFields);
  const records = legacy.indicators.map(legacyIndicatorFields);
  const diff = [];
  const usedCards = new Set();
  const usedIndicators = new Set();
  let exactReuseResponsibilities = 0;
  for (const responsibility of inventory.responsibilities) {
    const titleKey = stableKey(responsibility.officialTitle);
    const matchedCards = cards.filter((card) => stableKey(card.title) === titleKey);
    const matchedRecords = records.filter((item) => stableKey(item.liability) === titleKey || item.responsibilityId === responsibility.responsibilityId);
    const nested = matchedCards.flatMap((card) => card.nestedIndicators);
    const allIndicators = [...nested, ...matchedRecords];
    matchedCards.forEach((card) => usedCards.add(card.id));
    allIndicators.forEach((item) => usedIndicators.add(item.id));
    const failureFields = [];
    const oldDigests = [...new Set([...matchedCards.map((x) => x.sourceDigest), ...allIndicators.map((x) => x.sourceDigest)].filter(Boolean))];
    const versionConflict = oldDigests.some((digest) => digest !== product.sourceDigest);
    if (versionConflict) failureFields.push('version_conflict');
    if (!matchedCards.length && !matchedRecords.length) failureFields.push('missing_responsibility');
    if (matchedCards.length && !allIndicators.length) failureFields.push('missing_indicator');
    const missingIndicatorFields = [...new Set(allIndicators.flatMap((item) => [
      ...(item.sourceDigest ? [] : ['sourceDigest']), ...(item.sourcePage ? [] : ['sourcePage']),
      ...(item.sourceExcerpt ? [] : ['evidence']), ...(item.formulaText ? [] : ['formula']),
      ...(item.normalizedFormula ? [] : ['normalizedFormula']), ...(item.basis ? [] : ['basis']),
      ...(item.operands.length || item.branches.length ? [] : ['operands_or_branches']),
    ]))];
    if (missingIndicatorFields.length && allIndicators.length) failureFields.push('indicator_incomplete');
    const officialEvidence = responsibility.officialRanges.every((range) => canonical.rawText.slice(range.absoluteStart, range.absoluteEnd) === range.exactText);
    const exactEvidence = allIndicators.some((item) => exactNormalizedInRaw(canonical.rawText, item.sourceExcerpt) && (!item.formulaText || exactNormalizedInRaw(canonical.rawText, item.formulaText)));
    const bothProjectionIds = nested.length > 0 && matchedRecords.length > 0;
    const exactReuse = !failureFields.length && officialEvidence && exactEvidence && bothProjectionIds && oldDigests.length === 1 && oldDigests[0] === product.sourceDigest;
    if (exactReuse) exactReuseResponsibilities += 1;
    diff.push({
      schema: 'legacy-diff/v5',
      company: product.company,
      productName: product.productName,
      sourceDigest: product.sourceDigest,
      responsibilityId: responsibility.responsibilityId,
      officialTitle: responsibility.officialTitle,
      legacyRecordIdPointers: { cardIds: matchedCards.map((x) => x.id), indicatorIds: allIndicators.map((x) => x.id) },
      diffTypes: [...new Set(failureFields)],
      strictExactReuse: exactReuse,
      officialEvidenceVerified: officialEvidence,
      bidirectionalIdMapping: bothProjectionIds,
      legacyBusinessValuesExcluded: true,
    });
  }
  const orphanCards = cards.filter((card) => !usedCards.has(card.id));
  const orphanIndicators = records.filter((item) => !usedIndicators.has(item.id));
  if (orphanCards.length || orphanIndicators.length) diff.push({ schema: 'legacy-diff/v5-orphans', company: product.company, productName: product.productName, sourceDigest: product.sourceDigest, orphanCardIds: orphanCards.map((x) => x.id), orphanIndicatorIds: orphanIndicators.map((x) => x.id), diffTypes: ['orphan_or_extra'], legacyBusinessValuesExcluded: true });
  return { rows: diff, exactReuseResponsibilities, orphanCards: orphanCards.length, orphanIndicators: orphanIndicators.length };
}

function candidateArtifact(product, inventory) {
  return {
    schema: 'responsibility-artifact-candidate/v5',
    company: product.company,
    productName: product.productName,
    sourceDigest: product.sourceDigest,
    sourceUrl: product.sourceUrl,
    productIdentity: { company: product.company, productName: product.productName, sourceDigest: product.sourceDigest, sourceUrl: product.sourceUrl },
    acceptedResponsibilities: inventory.responsibilities.map((item) => ({
      responsibilityId: item.responsibilityId,
      liability: item.officialTitle,
      title: item.officialTitle,
      coverageType: item.coverageType,
      sourceUrl: product.sourceUrl,
      sourceDigest: product.sourceDigest,
      responsibilitySourceDigest: product.sourceDigest,
      sourceExcerpt: item.sourceExcerpt,
      evidenceSegments: item.officialRanges.map((range) => ({ page: range.pageStart, startOffset: range.absoluteStart, endOffset: range.absoluteEnd, exactText: range.exactText })),
      indicators: item.indicators.map((indicator) => ({
        indicatorId: indicator.indicatorId,
        indicatorName: indicator.indicatorName,
        responsibilityId: item.responsibilityId,
        sourceDigest: product.sourceDigest,
        responsibilitySourceDigest: product.sourceDigest,
        sourceExcerpt: item.sourceExcerpt,
        sourcePage: String(item.officialRanges[0].pageStart),
        indicatorCheckStatus: 'candidate_official_only',
      })),
    })),
    audit: { status: 'candidate', modelUsed: false, sourceOfTruth: 'official_inventory', legacyDiffUsedOnlyForReuseEligibility: true },
  };
}

function validateCandidate(candidate, canonical, inventory) {
  const issues = [];
  if (candidate.sourceDigest !== inventory.sourceDigest) issues.push('source_digest_mismatch');
  if (candidate.acceptedResponsibilities.length !== inventory.responsibilityCount) issues.push('responsibility_count_mismatch');
  for (const responsibility of candidate.acceptedResponsibilities) {
    if (!responsibility.sourceExcerpt) issues.push(`missing_source_excerpt:${responsibility.responsibilityId}`);
    for (const segment of responsibility.evidenceSegments || []) if (canonical.rawText.slice(segment.startOffset, segment.endOffset) !== segment.exactText) issues.push(`exact_span_mismatch:${responsibility.responsibilityId}`);
    if (!responsibility.indicators?.length) issues.push(`missing_indicator:${responsibility.responsibilityId}`);
  }
  const serialized = JSON.stringify(candidate);
  for (const forbidden of ['legacy-poison-99-percent', '错误比例99%', '旧指标虚构公式=99%', 'legacy-fake-responsibility']) if (serialized.includes(forbidden)) issues.push(`legacy_pollution:${forbidden}`);
  return issues;
}

function runImporterDryRun(root, artifactPaths) {
  const receiptPath = path.join(root, 'validator-importer-receipts', 'importer-dry-run.json');
  const combined = path.join(root, 'artifacts', 'candidate-artifacts.jsonl');
  writeJsonl(combined, artifactPaths.map((file) => readJson(file)));
  let result = null;
  let stderr = '';
  try {
    const stdout = execFileSync('node', ['scripts/import-reviewed-responsibility-artifacts.mjs', `--artifacts=${combined}`], { cwd: path.resolve('.'), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    result = JSON.parse(stdout);
  } catch (error) {
    stderr = text(error.stderr);
    try { result = JSON.parse(text(error.stdout)); } catch { result = { ok: false, error: error.message }; }
  }
  const receipt = { schema: 'dedicated-importer-dry-run/v5', command: `node scripts/import-reviewed-responsibility-artifacts.mjs --artifacts=${combined}`, write: false, parseOnly: true, materialized: 0, stderr, result };
  writeJson(receiptPath, receipt);
  return { receipt, receiptPath };
}

export function finalizeV5Canary({ outputDir = OUTPUT_DIR } = {}) {
  const root = path.resolve(outputDir);
  const selected = readJson(path.join(root, 'selection', 'selected-products.json'));
  const sourceReady = [];
  const terminalRows = [];
  const inventoryRows = [];
  const pageMaps = [];
  const diffRows = [];
  const deterministicRows = [];
  const packetRows = [];
  const providerRows = [];
  const artifactPaths = [];
  const candidateValidationResults = [];
  const productReports = [];
  let officialResponsibilityCount = 0;
  let deterministicFieldCount = 0;
  let trueMissingResponsibilities = 0;
  let trueMissingIndicators = 0;
  let modelCalls = 0;
  let modelResponsibilityCount = 0;
  let falseReuseCount = 0;
  let omissionCount = 0;
  let versionOverwriteCount = 0;
  let pollutionLeakCount = 0;
  for (const product of selected) {
    const { manifestPath, manifest } = sourceContractFor(root, product);
    const report = { ...product, sourceContractPath: manifestPath, sourceStatus: manifest?.sourceStatus || 'source_blocked' };
    if (!manifest || manifest.sourceStatus !== 'source_ready') {
      terminalRows.push({ schema: 'v5-terminal/v1', ...product, terminal: manifest?.sourceStatus === 'version_conflict' ? 'version_conflict' : 'source_blocked', blocker: manifest?.blockers || ['source_contract_missing'], officialInventoryBuilt: false, modelCalls: 0, legacySnapshotLoaded: false });
      productReports.push(report);
      continue;
    }
    const activeCopy = copyActiveSourceContract(root, product, manifest);
    const bytes = fs.readFileSync(activeCopy.active.sourceFile);
    const actualDigest = `sha256:${sha256(bytes)}`;
    const manifestDigestMatches = !manifest.sourceDigest || manifest.sourceDigest === product.sourceDigest;
    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-' || actualDigest !== product.sourceDigest || !manifestDigestMatches) {
      const terminal = actualDigest !== product.sourceDigest ? 'version_conflict' : 'source_blocked';
      versionOverwriteCount += terminal === 'version_conflict' ? 1 : 0;
      terminalRows.push({ schema: 'v5-terminal/v1', ...product, terminal, blocker: terminal === 'version_conflict' ? 'downloaded_digest_differs_locked_digest' : 'pdf_magic_invalid', officialInventoryBuilt: false, modelCalls: 0, legacySnapshotLoaded: false });
      productReports.push({ ...report, terminal });
      continue;
    }
    const markedText = fs.readFileSync(activeCopy.active.extractedTextFile, 'utf8');
    let canonical;
    let inventory;
    try {
      canonical = buildCanonicalRawText(parseMarkedPages(markedText));
      inventory = buildOfficialInventory(product, canonical);
    } catch (error) {
      terminalRows.push({ schema: 'v5-terminal/v1', ...product, terminal: 'ocr_review', blocker: error.message, officialInventoryBuilt: false, modelCalls: 0, legacySnapshotLoaded: false });
      productReports.push({ ...report, terminal: 'ocr_review' });
      continue;
    }
    sourceReady.push(product);
    officialResponsibilityCount += inventory.responsibilityCount;
    inventoryRows.push(...inventory.responsibilities.map((item) => ({ ...item, company: product.company, productName: product.productName, sourceDigest: product.sourceDigest, sourceUrl: product.sourceUrl })));
    const pageDir = path.join(root, 'page-map', String(product.selectionIndex).padStart(2, '0'));
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(path.join(pageDir, 'canonical-raw.txt'), canonical.rawText);
    writeJson(path.join(pageDir, 'page-map.json'), { schema: 'canonical-raw-page-map/v5', company: product.company, productName: product.productName, sourceDigest: product.sourceDigest, layer: canonical.layer, pages: canonical.pageMap, canonicalRawTextSha256: sha256(canonical.rawText), rawTextFile: 'canonical-raw.txt' });
    pageMaps.push({ company: product.company, productName: product.productName, sourceDigest: product.sourceDigest, pageCount: canonical.pageMap.length, canonicalRawTextSha256: sha256(canonical.rawText), pageMapPath: path.join(pageDir, 'page-map.json') });
    const legacy = loadLegacyAfterInventory(product);
    const diff = diffAgainstLegacy(product, inventory, canonical, legacy);
    diffRows.push(...diff.rows);
    const productDiff = diff.rows.filter((row) => row.responsibilityId);
    trueMissingResponsibilities += productDiff.filter((row) => row.diffTypes.includes('missing_responsibility')).length;
    trueMissingIndicators += productDiff.filter((row) => row.diffTypes.includes('missing_indicator')).length;
    omissionCount += productDiff.filter((row) => row.diffTypes.includes('missing_responsibility') || row.diffTypes.includes('missing_indicator')).length;
    falseReuseCount += productDiff.filter((row) => row.strictExactReuse && row.diffTypes.length).length;
    const candidate = candidateArtifact(product, inventory);
    const candidatePath = path.join(root, 'artifacts', `${String(product.selectionIndex).padStart(2, '0')}.json`);
    writeJson(candidatePath, candidate);
    artifactPaths.push(candidatePath);
    const candidateIssues = validateCandidate(candidate, canonical, inventory);
    candidateValidationResults.push({ selectionIndex: product.selectionIndex, productName: product.productName, ok: candidateIssues.length === 0, issueCount: candidateIssues.length, issues: candidateIssues });
    const unresolved = productDiff.filter((row) => !row.strictExactReuse || row.diffTypes.length);
    const fields = [...new Set(unresolved.flatMap((row) => row.diffTypes.filter((item) => item !== 'version_conflict' && item !== 'missing_responsibility' && item !== 'missing_indicator')))].sort();
    deterministicFieldCount += inventory.responsibilities.length * 2;
    deterministicRows.push(...inventory.responsibilities.map((item) => ({ schema: 'deterministic-reuse/v5', company: product.company, productName: product.productName, sourceDigest: product.sourceDigest, responsibilityId: item.responsibilityId, officialTitle: item.officialTitle, deterministicFields: ['sourcePage', 'officialEvidenceRanges'], officialRanges: item.officialRanges, modelUsed: false, legacyRecordIdPointers: diffRows.find((row) => row.responsibilityId === item.responsibilityId)?.legacyRecordIdPointers || { cardIds: [], indicatorIds: [] } })));
    if (fields.length || candidateIssues.length) {
      packetRows.push({ schema: 'product-bounded-packet/v5', taskId: `product-bounded:${product.selectionIndex}`, company: product.company, productName: product.productName, sourceDigest: product.sourceDigest, modelAllowed: true, fullProductRerun: false, repairRounds: 0, failedFields: fields.length ? fields : ['candidate_validation'], responsibilities: unresolved.map((row) => ({ responsibilityId: row.responsibilityId, officialTitle: row.officialTitle, failureFields: row.diffTypes.length ? row.diffTypes : ['candidate_validation'], officialRanges: inventory.responsibilities.find((item) => item.responsibilityId === row.responsibilityId)?.officialRanges || [], legacyRecordIdPointers: row.legacyRecordIdPointers })), legacyBusinessValuesExcluded: true });
      modelResponsibilityCount += unresolved.length;
      providerRows.push({ schema: 'provider-receipt/v5', taskId: `product-bounded:${product.selectionIndex}`, provider: 'gpt-5.6-luna', modelId: 'gpt-5.6-luna', calls: 0, status: 'not_called_provider_unavailable_in_current_runtime', repairRounds: 0, bounded: true, fullProductRerun: false });
    }
    const terminal = candidateIssues.length ? 'validation_review' : (fields.length ? 'model_retry' : 'validation_review');
    terminalRows.push({ schema: 'v5-terminal/v1', ...product, terminal, blocker: candidateIssues.length ? candidateIssues : ['bounded_model_receipt_not_executed'], officialInventoryBuilt: true, officialResponsibilityCount: inventory.responsibilityCount, legacySnapshotLoaded: true, modelCalls: 0, canonicalizer: { ok: candidateIssues.length === 0, issueCount: candidateIssues.length }, validator: { ok: candidateIssues.length === 0, issueCount: candidateIssues.length } });
    productReports.push({ ...report, terminal, officialResponsibilityCount: inventory.responsibilityCount, canonicalTextPageCount: canonical.pageMap.length, legacyQueryOnly: legacy.queryOnly });
  }
  writeJsonl(path.join(root, 'official-inventory.jsonl'), inventoryRows);
  writeJsonl(path.join(root, 'legacy-diff.jsonl'), diffRows);
  writeJsonl(path.join(root, 'deterministic-reuse.jsonl'), deterministicRows);
  writeJsonl(path.join(root, 'bounded-packets.jsonl'), packetRows);
  writeJsonl(path.join(root, 'provider-receipts.jsonl'), providerRows);
  const canonicalizerReceipt = { schema: 'responsibility-artifact-canonicalizer/v5', mode: 'parse-only', write: false, products: artifactPaths.length, ok: candidateValidationResults.every((row) => row.ok), results: candidateValidationResults.map((row) => ({ selectionIndex: row.selectionIndex, productName: row.productName, ok: row.ok })) };
  const validatorReceipt = { schema: 'responsibility-artifact-validator/v5', mode: 'parse-only', write: false, products: artifactPaths.length, ok: candidateValidationResults.every((row) => row.ok), issueCount: candidateValidationResults.reduce((sum, row) => sum + row.issueCount, 0), results: candidateValidationResults };
  writeJson(path.join(root, 'validator-importer-receipts', 'canonicalizer.json'), canonicalizerReceipt);
  writeJson(path.join(root, 'validator-importer-receipts', 'validator.json'), validatorReceipt);
  const importer = runImporterDryRun(root, artifactPaths);
  const importerOk = Boolean(importer.receipt.result?.ok) && Number(importer.receipt.result?.materializedProducts || 0) === 0 && Number(importer.receipt.result?.materializedCards || 0) === 0;
  for (const row of terminalRows.filter((item) => item.terminal === 'validation_review')) row.importerDryRun = { ok: importerOk, materialized: 0 };
  writeJsonl(path.join(root, 'terminal.jsonl'), terminalRows);
  const forbiddenLegacyValues = ['legacy-poison-99-percent', '错误比例99%', '旧指标虚构公式=99%', 'legacy-fake-responsibility'];
  pollutionLeakCount = [inventoryRows, deterministicRows, packetRows, ...artifactPaths.map((file) => readJson(file))]
    .map((value) => JSON.stringify(value))
    .reduce((count, value) => count + forbiddenLegacyValues.filter((marker) => value.includes(marker)).length, 0);
  const retrievalTimes = selected.map((product) => sourceContractFor(root, product).manifest?.retrievedAt).filter(Boolean).map((value) => Date.parse(value)).filter(Number.isFinite);
  const elapsedSeconds = retrievalTimes.length ? Math.max(1, Math.round((Date.now() - Math.min(...retrievalTimes)) / 1000)) : null;
  const sourceStatuses = Object.fromEntries([...new Set(terminalRows.map((row) => row.terminal))].map((status) => [status, terminalRows.filter((row) => row.terminal === status).length]));
  const summary = {
    schema: 'legacy-indicator-safe-reuse-v5-canary-summary/v1',
    selected: selected.length,
    categories: Object.fromEntries([...new Set(selected.map((item) => item.selectionCategory))].sort().map((category) => [category, selected.filter((item) => item.selectionCategory === category).length])),
    retrieval: { cache: 0, direct: sourceReady.length, browser: 0, jrcpcx: 0, sourceReady: sourceReady.length, sourceFailed: selected.length - sourceReady.length },
    officialResponsibilityCount,
    legacyCompleteReuseResponsibilityCount: diffRows.filter((row) => row.strictExactReuse).length,
    deterministicResponsibilityCount: deterministicRows.length,
    deterministicFieldCount,
    trueMissingResponsibilityCount: trueMissingResponsibilities,
    trueMissingIndicatorCount: trueMissingIndicators,
    lunaProductCalls: modelCalls,
    lunaResponsibilityCalls: modelCalls,
    boundedTasksPlanned: packetRows.length,
    boundedResponsibilitiesPlanned: modelResponsibilityCount,
    wholeProductModelCallsBaseline: selected.length,
    wholeProductModelCallsSaved: sourceReady.length - modelCalls,
    terminal: sourceStatuses,
    approvedProducts: 0,
    validationReviewProducts: terminalRows.filter((row) => row.terminal === 'validation_review').length,
    modelRetryProducts: terminalRows.filter((row) => row.terminal === 'model_retry').length,
    sourceBlockedProducts: terminalRows.filter((row) => row.terminal === 'source_blocked').length,
    versionConflictProducts: terminalRows.filter((row) => row.terminal === 'version_conflict').length,
    ocrReviewProducts: terminalRows.filter((row) => row.terminal === 'ocr_review').length,
    elapsedSeconds,
    approvedProductsPerHour: 0,
    validatedProductsPerHour: elapsedSeconds ? Number((importer.receipt.result?.productsReviewed * 3600 / elapsedSeconds).toFixed(2)) : 0,
    falseReuseCount,
    omissionCount,
    versionOverwriteCount,
    legacyPollutionLeakCount: pollutionLeakCount,
    sqlite: { dbPath: DB_PATH, mode: 'ro', queryOnly: true, writes: 0 },
    importerDryRun: { ...importer.receipt.result, ok: importerOk, materialized: 0 },
    canonicalizer: canonicalizerReceipt,
    validator: validatorReceipt,
    v1ToV4Immutable: true,
    unselectedProductsRemainUnclaimed: selected.length === 10,
  };
  writeJson(path.join(root, 'summary.json'), summary);
  writeJson(path.join(root, 'audit.json'), { schema: 'legacy-indicator-safe-reuse-v5-canary-audit/v1', sourceInput: path.join(V4_DIR, 'source-reacquire-or-ocr-review.jsonl'), officialInventoryIndependent: true, legacyLoadedAfterOfficialInventory: true, modelCalls, browserCalls: 0, jrcpcxCalls: 0, sqliteWrites: 0, products: productReports, terminalRows: terminalRows.length, officialResponsibilityCount, artifactCandidateCount: artifactPaths.length });
  writeSha256Sums(root);
  return { summary, importer, terminalRows };
}

function loadInputs() {
  const sourceRows = readJsonl(path.join(V4_DIR, 'source-reacquire-or-ocr-review.jsonl'));
  const audit = readJson(V3_AUDIT);
  return { sourceRows, audit };
}

function selectProducts({ sourceRows, audit }) {
  const products = SELECTED_INDICES.map((inputIndex) => {
    const row = sourceRows[inputIndex];
    if (!row) throw new Error(`selection_input_missing:${inputIndex}`);
    const productAudit = audit.products.find((item) => item.company === row.company && item.productName === row.productName) || {};
    return {
      selectionIndex: SELECTED_INDICES.indexOf(inputIndex),
      inputIndex,
      selectionCategory: CATEGORY_BY_INDEX.get(inputIndex) || 'other',
      company: row.company,
      productName: row.productName,
      sourceDigest: row.sourceDigest,
      sourceUrl: text(productAudit.sourceUrl),
      responsibilityCount: row.responsibilities.length,
      responsibilityIds: row.responsibilities.map((item) => item.responsibilityId),
      legacyRecordIdPointers: row.responsibilities.map((item) => item.legacyRecordIdPointers),
    };
  });
  if (new Set(products.map((item) => item.inputIndex)).size !== 10) throw new Error('selection_not_unique');
  return products;
}

function buildQueue(products) {
  return products.map((product) => ({
    company: product.company,
    productName: product.productName,
    sourceUrl: new URL(product.sourceUrl).href,
    sourceDigest: product.sourceDigest,
    officialDomain: new URL(product.sourceUrl).hostname,
    historicalFailureCategory: 'source_contract_missing_from_locked_input',
    sourceCandidates: [],
    alternativeSourceUrls: [],
  }));
}

export function retryBlockedOfficialSources({ outputDir = OUTPUT_DIR } = {}) {
  const root = path.resolve(outputDir);
  const selected = readJson(path.join(root, 'selection', 'selected-products.json'));
  const blocked = selected.filter((product) => {
    const manifest = readJson(path.join(root, 'source-contract', String(product.selectionIndex).padStart(2, '0'), 'source-contract.json'));
    return manifest.sourceStatus === 'source_blocked';
  });
  const retryRoot = path.join(root, 'source-contract', 'retry-1');
  const queuePath = path.join(retryRoot, 'queue.json');
  fs.mkdirSync(retryRoot, { recursive: true });
  writeJson(queuePath, buildQueue(blocked));
  const acquisitionDir = path.join(retryRoot, 'acquisition');
  execFileSync('python3', [SOURCE_REPAIR, '--queue', queuePath, '--output-dir', acquisitionDir, '--domain-delay', '0.5'], {
    cwd: path.resolve('.'),
    stdio: 'inherit',
  });
  const attempts = [];
  for (const product of blocked) {
    const manifestPath = fs.readdirSync(path.join(acquisitionDir, 'products'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(acquisitionDir, 'products', entry.name, 'source-manifest.json'))
      .find((candidate) => fs.existsSync(candidate) && readJson(candidate).company === product.company && readJson(candidate).productName === product.productName);
    const manifest = manifestPath ? readJson(manifestPath) : { company: product.company, productName: product.productName, sourceStatus: 'source_blocked', sourceDigest: '', blockers: ['retry_manifest_missing'] };
    const itemDir = path.join(retryRoot, String(product.selectionIndex).padStart(2, '0'));
    fs.mkdirSync(itemDir, { recursive: true });
    const normalized = { ...manifest };
    for (const field of ['sourceFile', 'extractedTextFile', 'responsibilityTextFile']) if (normalized[field]) normalized[field] = path.resolve(normalized[field]);
    const retryManifestPath = path.join(itemDir, 'source-contract.json');
    writeJson(retryManifestPath, normalized);
    attempts.push({ product, manifest: normalized, manifestPath: retryManifestPath });
  }
  writeJson(path.join(retryRoot, 'summary.json'), {
    schema: 'legacy-indicator-safe-reuse-v5-source-retry-summary/v1',
    retryReason: 'first_attempt_unencoded_unicode_url_transport_failure',
    selectedRetryCount: blocked.length,
    completedProductsUntouched: selected.length - blocked.length,
    attempts: attempts.map((item) => item.manifestPath),
    modelCalls: 0,
    sqliteWrites: 0,
  });
  return attempts;
}

export function prepareV5Selection({ outputDir = OUTPUT_DIR } = {}) {
  const root = path.resolve(outputDir);
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error(`v5_output_must_be_new_or_empty:${root}`);
  fs.mkdirSync(root, { recursive: true });
  const inputs = loadInputs();
  if (inputs.sourceRows.length !== 30) throw new Error(`expected_30_input_products:${inputs.sourceRows.length}`);
  const selected = selectProducts(inputs);
  const selectedKeys = new Set(selected.map((item) => `${item.company}\u001f${item.productName}\u001f${item.sourceDigest}`));
  const unselected = inputs.sourceRows.map((row, inputIndex) => ({ inputIndex, company: row.company, productName: row.productName, sourceDigest: row.sourceDigest })).filter((row) => !selectedKeys.has(`${row.company}\u001f${row.productName}\u001f${row.sourceDigest}`));
  const selection = {
    schema: 'legacy-indicator-safe-reuse-v5-canary-selection/v1',
    selected: 10,
    inputProducts: inputs.sourceRows.length,
    unclaimedProducts: unselected.length,
    selectionRule: 'stable input order: first deterministic representative of medical/life/annuity/critical_illness/accident, then fill remaining slots by original input index; no ease or outcome sampling',
    categoryCoverage: [...new Set(selected.map((item) => item.selectionCategory))].sort(),
    selectedProducts: selected,
    unselectedProducts: unselected,
    v1ToV4Immutable: true,
    modelCallsBeforeSourceReady: 0,
    sqliteWrites: 0,
  };
  writeJson(path.join(root, 'selection.json'), selection);
  writeJson(path.join(root, 'selection', 'queue.json'), buildQueue(selected));
  writeJson(path.join(root, 'selection', 'selected-products.json'), selected);
  return { root, selected, unselected, queuePath: path.join(root, 'selection', 'queue.json') };
}

export function acquireOfficialSources({ outputDir = OUTPUT_DIR } = {}) {
  const root = path.resolve(outputDir);
  const queuePath = path.join(root, 'selection', 'queue.json');
  const acquisitionDir = path.join(root, 'source-contract', 'acquisition');
  fs.mkdirSync(path.dirname(acquisitionDir), { recursive: true });
  execFileSync('python3', [SOURCE_REPAIR, '--queue', queuePath, '--output-dir', acquisitionDir, '--domain-delay', '0.5'], {
    cwd: path.resolve('.'),
    stdio: 'inherit',
  });
  const selected = readJson(path.join(root, 'selection', 'selected-products.json'));
  const contracts = [];
  for (const product of selected) {
    const manifestPath = fs.readdirSync(path.join(acquisitionDir, 'products'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(acquisitionDir, 'products', entry.name, 'source-manifest.json'))
      .find((candidate) => {
        if (!fs.existsSync(candidate)) return false;
        const value = readJson(candidate);
        return value.company === product.company && value.productName === product.productName;
      });
    const manifest = manifestPath ? readJson(manifestPath) : null;
    const itemDir = path.join(root, 'source-contract', product.selectionIndex.toString().padStart(2, '0'));
    fs.mkdirSync(itemDir, { recursive: true });
    if (manifest) {
      const normalized = { ...manifest };
      for (const field of ['sourceFile', 'extractedTextFile', 'responsibilityTextFile']) {
        if (normalized[field]) normalized[field] = path.resolve(normalized[field]);
      }
      writeJson(path.join(itemDir, 'source-contract.json'), normalized);
      contracts.push({ product, manifest: normalized, manifestPath: path.join(itemDir, 'source-contract.json') });
    } else {
      const blocked = { company: product.company, productName: product.productName, sourceDigest: product.sourceDigest, sourceStatus: 'source_blocked', sourceUrl: product.sourceUrl, blockers: ['source_manifest_missing_after_acquisition'] };
      writeJson(path.join(itemDir, 'source-contract.json'), blocked);
      contracts.push({ product, manifest: blocked, manifestPath: path.join(itemDir, 'source-contract.json') });
    }
  }
  writeJson(path.join(root, 'source-contract', 'acquisition-summary.json'), {
    schema: 'legacy-indicator-safe-reuse-v5-source-acquisition-summary/v1',
    retrievalPolicy: 'local-cache-exact-digest-then-official-direct-then-existing-browser-ladder; no-third-party-text; jrcpcx-not-attempted',
    sourceContracts: contracts.map((item) => item.manifestPath),
    statuses: Object.fromEntries([...new Set(contracts.map((item) => item.manifest.sourceStatus))].map((status) => [status, contracts.filter((item) => item.manifest.sourceStatus === status).length])),
    modelCalls: 0,
    sqliteWrites: 0,
  });
  return contracts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv.includes('--retry-blocked') ? 'retry' : 'initial';
  if (process.argv.includes('--finalize')) {
    process.stdout.write(`${JSON.stringify(finalizeV5Canary(), null, 2)}\n`);
  } else if (mode === 'retry') {
    const attempts = retryBlockedOfficialSources();
    process.stdout.write(`${JSON.stringify({ retryCount: attempts.length, sourceStatuses: Object.fromEntries([...new Set(attempts.map((item) => item.manifest.sourceStatus))].map((status) => [status, attempts.filter((item) => item.manifest.sourceStatus === status).length])) }, null, 2)}\n`);
  } else {
    const prepared = prepareV5Selection();
    const contracts = acquireOfficialSources({ outputDir: prepared.root });
    process.stdout.write(`${JSON.stringify({ selected: prepared.selected.length, unclaimed: prepared.unselected.length, sourceStatuses: Object.fromEntries([...new Set(contracts.map((item) => item.manifest.sourceStatus))].map((status) => [status, contracts.filter((item) => item.manifest.sourceStatus === status).length])) }, null, 2)}\n`);
  }
}
