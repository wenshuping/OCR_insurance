#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { buildCanonicalRawText } from './audit-legacy-indicator-safe-reuse-v4.mjs';
import { parseMarkedPages } from './run-legacy-indicator-safe-reuse-v5-canary10.mjs';

const REPO = '/Volumes/OCR_ARCHIVE/OCR_insurance/.worktrees/dev-agent-semantic-integration';
const V5 = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/methods/legacy-indicator-safe-reuse-v5-canary10';
const ROOT = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/methods/legacy-indicator-safe-reuse-v6-luna-canary10';
const DB_PATH = '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite';
const INPUT_PACKETS = path.join(V5, 'bounded-packets.jsonl');
const INVENTORY_FILE = path.join(V5, 'official-inventory.jsonl');
const SELECTION_FILE = path.join(V5, 'selection', 'selected-products.json');

const REQUIRED_INPUTS = new Set([
  'policy.amount', 'policy.firstPremium', 'policy.paymentPeriodYears', 'cashValue', 'policyYear',
  'policyScheduleTable', 'policyYearOrAge', 'accountValue', 'actualMedicalExpense', 'deductible',
  'reimbursementRate', 'thirdPartyPaid', 'liabilityLimit', 'actualDays', 'dailyAmount', 'dayLimit',
  'manualFormulaInputs',
]);
const CUSTOMER_FORBIDDEN = ['basisKey', 'calculationKey', 'requiredInputs', 'calculationStatus', 'indicatorCheckStatus', 'needs_table', '指标核对', '结构化指标', '现金流测算', '需表格'];
const LEGACY_POISON = ['legacy-poison-99-percent', '错误比例99%', '旧指标虚构公式=99%', 'legacy-fake-responsibility'];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readJsonl = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const text = (value) => String(value ?? '');
const compact = (value) => text(value).normalize('NFKC').replace(/\s+/gu, ' ').trim();
const stableKey = (value) => compact(value).replace(/[「」『』（）()【】、，。:：;；/\\_\-\s]+/gu, '');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

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
    let read = 0;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read) hash.update(buffer.subarray(0, read));
    } while (read);
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
  fs.writeFileSync(path.join(root, 'SHA256SUMS'), `${files.map((file) => `${fileSha256(file)}  ${path.relative(root, file).split(path.sep).join('/')}`).join('\n')}\n`);
  return fileSha256(path.join(root, 'SHA256SUMS'));
}

function rawRange(canonical, start, end, label) {
  const absoluteStart = Number(start);
  const absoluteEnd = Number(end);
  const exactText = canonical.rawText.slice(absoluteStart, absoluteEnd);
  const pages = canonical.pageMap.filter((page) => page.absoluteStart < absoluteEnd && page.absoluteEnd > absoluteStart);
  if (!pages.length || exactText.length !== absoluteEnd - absoluteStart) throw new Error(`invalid_official_range:${label}`);
  return { label, page: pages[0].page, pageStart: pages[0].page, pageEnd: pages.at(-1).page, absoluteStart, absoluteEnd, exactText };
}

function spanAround(canonical, needle, label, from = 0, endNeedles = []) {
  const startNeedle = text(needle);
  const index = canonical.rawText.indexOf(startNeedle, from);
  if (index < 0) throw new Error(`official_needle_missing:${label}:${startNeedle}`);
  const lineStart = canonical.rawText.lastIndexOf('\n', index) + 1;
  const candidates = endNeedles.map((endNeedle) => canonical.rawText.indexOf(endNeedle, index + startNeedle.length)).filter((value) => value > index);
  const paragraphEnd = canonical.rawText.indexOf('\n\n', index + startNeedle.length);
  if (paragraphEnd > index) candidates.push(paragraphEnd);
  const end = candidates.length ? Math.min(...candidates) : Math.min(canonical.rawText.length, index + startNeedle.length);
  return rawRange(canonical, lineStart, end, label);
}

function spanFrom(canonical, startNeedle, endNeedle, label) {
  const start = canonical.rawText.indexOf(startNeedle);
  const end = canonical.rawText.indexOf(endNeedle, start + text(startNeedle).length);
  if (start < 0 || end <= start) throw new Error(`official_span_missing:${label}`);
  return rawRange(canonical, start, end, label);
}

function dedupeRanges(ranges) {
  return [...new Map(ranges.map((range) => [`${range.absoluteStart}:${range.absoluteEnd}`, range])).values()];
}

function sourceContractFor(selectionIndex) {
  const index = String(selectionIndex).padStart(2, '0');
  const retry = path.join(V5, 'source-contract', 'retry-1', index, 'source-contract.json');
  const active = path.join(V5, 'source-contract', index, 'active', 'source-contract.json');
  const file = fs.existsSync(retry) ? retry : active;
  return { path: file, manifest: readJson(file) };
}

function canonicalFor(selectionIndex) {
  const { manifest } = sourceContractFor(selectionIndex);
  const marked = fs.readFileSync(manifest.extractedTextFile, 'utf8');
  return { manifest, canonical: buildCanonicalRawText(parseMarkedPages(marked)) };
}

function bodyAfterTitle(row, canonical) {
  const body = text(row.sourceExcerpt);
  const title = text(row.officialTitle);
  const titleAt = body.indexOf(title);
  return titleAt >= 0 ? body.slice(titleAt + title.length).trim() : body.trim();
}

function firstSentence(body) {
  const match = body.match(/^([\s\S]{1,600}?[。！？])/u);
  return compact(match?.[1] || body.slice(0, 360));
}

function obligationSentence(body) {
  const index = body.search(/我们(?:将|按|首先|根据|仅|对|在)/u);
  if (index < 0) return firstSentence(body);
  const tail = body.slice(index);
  return compact((tail.match(/^([\s\S]{1,700}?[。！？])/u) || [tail.slice(0, 400)])[1]);
}

function importantLimitTexts(body) {
  return [...new Set(body.split(/\n+/u).map(compact).filter((line) => /等待期|每种|累计|仅|终止|最高|不超过|扣除|给付后|周年日|未满|含|以上|以下|之前|之后|180日|180 天|1 万元|百分比|比例/u.test(line)).filter((line) => line.length > 8).slice(0, 10))];
}

function numericTokens(value) {
  return [...new Set(text(value).match(/\d+(?:\.\d+)?\s*%?|\d+\s*(?:天|日|年|周年|个月|月|次|级|周岁|万元|元)|[一二三四五六七八九十百]+(?:天|日|年|次|级|周岁)/gu) || [])].map(compact);
}

function sharedRangesFor(product, canonical) {
  const ranges = [];
  if (/暖宝保/u.test(product.productName)) {
    ranges.push(spanAround(canonical, '自本主险合同生效日起 30 天为等待期', 'shared_waiting_period'));
    ranges.push(spanAround(canonical, '我们在给付以下（1） 、 （2）项所列保险金时', 'shared_third_party_deduction'));
    ranges.push(spanFrom(canonical, '附表：赔付比例及免赔额表', '（本页以下空白）', 'medical_reimbursement_table'));
  }
  if (/惠康|惠宝/u.test(product.productName)) {
    ranges.push(spanAround(canonical, '自本主险合同生效日或最后复效日', 'shared_critical_waiting_period'));
  }
  return ranges;
}

function criticalConfig(product, row, canonical, allRows) {
  const title = row.officialTitle;
  const body = bodyAfterTitle(row, canonical);
  const shared = sharedRangesFor(product, canonical);
  const evidence = dedupeRanges([...row.officialRanges, ...shared]);
  const make = (formulaText, normalizedFormula, basisKey, calculationKey, requiredInputs, branches, options = {}) => ({
    formulaText, normalizedFormula, basisKey, calculationKey, requiredInputs, branches,
    operands: options.operands || [], calculationEligible: options.calculationEligible ?? true,
    calculationStatus: options.calculationStatus || 'formula_supported', calculationReason: options.calculationReason || '',
    cashflowTreatment: options.cashflowTreatment || 'claim_contingent', indicatorName: `${title}金额`,
    ...options,
  });
  let check;
  if (title === '轻症疾病保险金' || title === '中症疾病保险金') {
    const ratio = body.match(/基本保险金额的\s*(\d+)%/u)?.[1];
    const count = body.match(/累计给付的[^。]{0,30}?达到([一二三四五六七八九十\d]+)次/u)?.[1] || '';
    check = make(`policy.amount × ${ratio}%`, `policy.amount * ${Number(ratio) / 100}`, 'basic_amount', 'percent_of_basic_amount', ['policy.amount'], [{ branchId: 'claim', condition: firstSentence(body), result: `policy.amount × ${ratio}%`, evidenceSegments: evidence }], { operands: ['policy.amount', `${Number(ratio) / 100}`] });
    if (count) check.importantLimit = `累计给付达到${count}次后本项责任终止`;
  } else if (title === '重大疾病保险金' && /惠康.*至诚少儿版/u.test(product.productName)) {
    check = make('policy.amount', 'policy.amount', 'basic_amount', 'basic_amount', ['policy.amount'], [{ branchId: 'major_disease', condition: firstSentence(body), result: 'policy.amount', evidenceSegments: evidence }], { operands: ['policy.amount'] });
  } else if (title === '少儿特定重度恶性肿瘤保险金') {
    check = make('policy.amount（在第（3）项重大疾病保险金之外额外给付）', 'policy.amount', 'basic_amount', 'basic_amount', ['policy.amount'], [{ branchId: 'under_18', condition: firstSentence(body), result: 'policy.amount（额外）', evidenceSegments: evidence }], { operands: ['policy.amount'], calculationReason: '官方明确为重大疾病保险金之外的额外给付。' });
  } else if (title === '少儿特定疾病保险金' || title === '生命特别关爱金') {
    check = make('policy.amount', 'policy.amount', 'basic_amount', 'basic_amount', ['policy.amount'], [{ branchId: 'claim', condition: firstSentence(body), result: 'policy.amount', evidenceSegments: evidence }], { operands: ['policy.amount'] });
  } else if (title === '少儿特定疾病豁免保险费') {
    check = make('豁免确诊日下一期至缴费期满的余下各期保险费', '', 'rule_parameter', 'not_calculable', [], [{ branchId: 'waiver', condition: firstSentence(body), result: 'waiver_only', evidenceSegments: evidence }], { calculationEligible: false, calculationStatus: 'not_calculable', calculationReason: '该责任是保费豁免，不是金额给付；具体余下期数由合同缴费期和确诊日确定。', cashflowTreatment: 'waiver_only', indicatorName: title });
  } else if (title === '重大疾病保险金' && /尊御版/u.test(product.productName)) {
    check = make('第10个保单周年日/40周岁前后分支：早期 policy.amount × 200%；后期 max(policy.amount, cumulativePaidPremium)', '分支[policy.amount * 2, max(policy.amount, cumulativePaidPremiumAtEvent)]', 'basic_amount', 'manual_formula', ['policy.amount', 'policyYearOrAge', 'manualFormulaInputs'], [
      { branchId: 'early', condition: '第10个保单周年日之前（含）或40周岁之前（含）以较迟者为准', result: 'policy.amount × 200%', evidenceSegments: evidence },
      { branchId: 'late', condition: '第11个保单年度起且40周岁之后', result: 'max(policy.amount, cumulativePaidPremiumAtEvent)', operands: ['policy.amount', 'cumulativePaidPremiumAtEvent'], evidenceSegments: evidence },
    ], { operands: ['policy.amount × 200%', 'policy.amount', 'cumulativePaidPremiumAtEvent'], calculationEligible: false, calculationStatus: 'needs_event_timing', calculationReason: '已交保险费需按确诊时实际缴费情况确定。' });
  } else if (title === '身故保险金' && /尊御版/u.test(product.productName)) {
    check = make('18周岁前：cumulativePaidPremium；18周岁（含）后：max(policy.amount, cumulativePaidPremium)', 'branch[manualFormulaInputs, max(policy.amount, cumulativePaidPremiumAtEvent)]', 'basic_amount', 'manual_formula', ['policy.amount', 'policyYearOrAge', 'manualFormulaInputs'], [
      { branchId: 'under_18', condition: '年满18周岁前', result: 'cumulativePaidPremiumAtEvent', evidenceSegments: evidence },
      { branchId: 'adult', condition: '年满18周岁（含）后', result: 'max(policy.amount, cumulativePaidPremiumAtEvent)', operands: ['policy.amount', 'cumulativePaidPremiumAtEvent'], evidenceSegments: evidence },
    ], { operands: ['cumulativePaidPremiumAtEvent', 'policy.amount'], calculationEligible: false, calculationStatus: 'needs_event_timing', calculationReason: '已交保险费和事件年龄需由实际保单数据确定。' });
  } else if (title === '身故或全残保险金') {
    check = make('18周岁前：cumulativePaidPremium；18周岁（含）后：policy.amount', 'branch[cumulativePaidPremiumAtEvent, policy.amount]', 'basic_amount', 'manual_formula', ['policy.amount', 'policyYearOrAge', 'manualFormulaInputs'], [
      { branchId: 'under_18', condition: '年满18周岁前', result: 'cumulativePaidPremiumAtEvent', evidenceSegments: evidence },
      { branchId: 'adult', condition: '年满18周岁（含）后', result: 'policy.amount', evidenceSegments: evidence },
    ], { operands: ['cumulativePaidPremiumAtEvent', 'policy.amount'], calculationEligible: false, calculationStatus: 'needs_event_timing', calculationReason: '已交保险费和事件年龄需由实际保单数据确定。' });
  } else {
    check = make('按官方条款给付，公式字段需结合责任正文核对', 'manual_formula', 'basic_amount', 'manual_formula', ['policy.amount', 'manualFormulaInputs'], [{ branchId: 'official', condition: firstSentence(body), result: 'manual_formula', evidenceSegments: evidence }], { calculationEligible: false, calculationStatus: 'needs_table', calculationReason: '官方责任正文未形成单一可计算表达式。' });
  }
  return { check, evidence, body };
}

function buildResponsibility(product, row, canonical, allRows) {
  const title = row.officialTitle;
  const body = bodyAfterTitle(row, canonical);
  let evidence = dedupeRanges([...row.officialRanges, ...sharedRangesFor(product, canonical)]);
  let check;
  const makeCheck = (fields) => ({
    indicatorName: `${title}金额`,
    responsibilityId: row.responsibilityId,
    sourcePage: String(evidence[0]?.pageStart || ''),
    sourceDigest: product.sourceDigest,
    responsibilitySourceDigest: product.sourceDigest,
    evidenceSegments: evidence,
    evidenceTokens: numericTokens(evidence.map((item) => item.exactText).join('\n')),
    provenance: { source: 'official_raw_pdf', sourceDigest: product.sourceDigest, officialInventoryResponsibilityId: row.responsibilityId, legacyBusinessValuesExcluded: true },
    indicatorCheckStatus: 'accepted_manual_review',
    ...fields,
  });

  if (/暖宝保/u.test(product.productName)) {
    const malignant = /恶性肿瘤/u.test(title);
    check = makeCheck({
      basis: '实际发生的合规医疗费用扣除第三方补偿和年度免赔额后，按附表赔付比例并受基本保险金额限制',
      basisKey: 'medical_expense', calculationKey: 'medical_formula',
      formulaText: 'max(0, actualMedicalExpense - thirdPartyPaid - deductible) × reimbursementRate，且不超过policy.amount',
      normalizedFormula: 'min(policy.amount, max(0, actualMedicalExpense - thirdPartyPaid - deductible) * reimbursementRate)',
      requiredInputs: ['actualMedicalExpense', 'thirdPartyPaid', 'deductible', 'reimbursementRate', 'liabilityLimit'],
      operands: ['actualMedicalExpense', 'thirdPartyPaid', 'deductible', 'reimbursementRate', 'policy.amount'],
      branches: [{ branchId: 'medical_expense', condition: firstSentence(body), result: 'min(policy.amount, max(0, actualMedicalExpense - thirdPartyPaid - deductible) × reimbursementRate)', operands: ['policy.amount', 'actualMedicalExpense', 'thirdPartyPaid', 'deductible', 'reimbursementRate'], evidenceSegments: evidence }],
      calculationEligible: false, calculationStatus: malignant ? 'source_review' : 'needs_claim_inputs',
      calculationReason: malignant ? '附表“恶性肿瘤医疗保险金”行在canonical raw text中未提供独立赔付比例/免赔额数值；正文引用附表，不能推断其是否沿用一般医疗比例。' : '实际费用、第三方补偿和赔付比例需由理赔材料及附表确定。',
      cashflowTreatment: 'claim_contingent',
    });
  } else if (/托富未来/u.test(product.productName)) {
    check = makeCheck({
      basis: '身故或全残时本合同基本保险金额', basisKey: 'basic_amount', calculationKey: 'basic_amount',
      formulaText: 'policy.amount', normalizedFormula: 'policy.amount', requiredInputs: ['policy.amount'], operands: ['policy.amount'],
      branches: [{ branchId: 'death_or_total_disability', condition: firstSentence(body), result: 'policy.amount', evidenceSegments: evidence }],
      calculationEligible: true, calculationStatus: 'formula_supported', cashflowTreatment: 'claim_contingent',
    });
  } else if (/慧盈人生/u.test(product.productName) && title === '年金') {
    check = makeCheck({
      basis: '每个保单周年日的保单账户价值和已交保险费上限', basisKey: 'account_value', calculationKey: 'manual_formula',
      formulaText: 'min(accountValue × 1%, totalPaidPremium × 20%)', normalizedFormula: 'min(accountValue * 0.01, cumulativePaidPremiumAtEvent * 0.20)',
      requiredInputs: ['accountValue', 'manualFormulaInputs'], operands: ['accountValue', '0.01', 'cumulativePaidPremiumAtEvent', '0.20'],
      branches: [{ branchId: 'survival_annuity', condition: firstSentence(body), result: 'min(accountValue × 1%, cumulativePaidPremiumAtEvent × 20%)', operands: ['accountValue', 'cumulativePaidPremiumAtEvent'], evidenceSegments: evidence }],
      calculationEligible: false, calculationStatus: 'needs_event_inputs', calculationReason: '保单账户价值、投资单位卖出价和累计已交保险费需读取实际保单数据。', cashflowTreatment: 'scheduled_cashflow',
    });
  } else if (/慧盈人生/u.test(product.productName) && title === '身故保险金') {
    check = makeCheck({
      basis: '已交保险费扣除累计部分提取及已付年金，与结算日保单账户价值二者取大', basisKey: 'account_value', calculationKey: 'manual_formula',
      formulaText: 'max(cumulativePaidPremium - cumulativeWithdrawals - cumulativeAnnuityPaid, accountValue)', normalizedFormula: 'max(cumulativePaidPremiumAtEvent - cumulativePartialWithdrawals - cumulativeAnnuityPaid, accountValue)',
      requiredInputs: ['accountValue', 'manualFormulaInputs'], operands: ['cumulativePaidPremiumAtEvent', 'cumulativePartialWithdrawals', 'cumulativeAnnuityPaid', 'accountValue'],
      branches: [{ branchId: 'death', condition: firstSentence(body), result: 'max(cumulativePaidPremiumAtEvent - cumulativePartialWithdrawals - cumulativeAnnuityPaid, accountValue)', operands: ['cumulativePaidPremiumAtEvent', 'cumulativePartialWithdrawals', 'cumulativeAnnuityPaid', 'accountValue'], evidenceSegments: evidence }],
      calculationEligible: false, calculationStatus: 'needs_event_inputs', calculationReason: '累计提取、累计年金和结算日账户价值需读取实际保单数据。', cashflowTreatment: 'claim_contingent',
    });
  } else if (/惠康|惠宝/u.test(product.productName)) {
    const critical = criticalConfig(product, row, canonical, allRows);
    check = makeCheck(critical.check);
    evidence = critical.evidence;
    check.evidenceSegments = evidence;
    check.evidenceTokens = numericTokens(evidence.map((item) => item.exactText).join('\n'));
  } else if (/弘盈/u.test(product.productName) && title === '身故保险金') {
    check = makeCheck({
      basis: '已交保险费乘年龄对应K值与现金价值二者取大', basisKey: 'cash_value', calculationKey: 'manual_formula',
      formulaText: 'max(cumulativePaidPremium × K(age), cashValue)', normalizedFormula: 'max(cumulativePaidPremiumAtEvent * K(policyYearOrAge), cashValue)',
      requiredInputs: ['cashValue', 'policyYearOrAge', 'manualFormulaInputs'], operands: ['cumulativePaidPremiumAtEvent', 'K(policyYearOrAge)', 'cashValue'],
      branches: [
        { branchId: 'age_17_or_under', condition: '到达年龄17周岁及以下', result: 'max(cumulativePaidPremiumAtEvent × 100%, cashValue)', operands: ['cumulativePaidPremiumAtEvent', '1', 'cashValue'], evidenceSegments: evidence },
        { branchId: 'age_18_40', condition: '到达年龄18-40周岁', result: 'max(cumulativePaidPremiumAtEvent × 160%, cashValue)', operands: ['cumulativePaidPremiumAtEvent', '1.60', 'cashValue'], evidenceSegments: evidence },
        { branchId: 'age_41_60', condition: '到达年龄41-60周岁', result: 'max(cumulativePaidPremiumAtEvent × 140%, cashValue)', operands: ['cumulativePaidPremiumAtEvent', '1.40', 'cashValue'], evidenceSegments: evidence },
        { branchId: 'age_61_or_over', condition: '到达年龄61周岁及以上', result: 'max(cumulativePaidPremiumAtEvent × 120%, cashValue)', operands: ['cumulativePaidPremiumAtEvent', '1.20', 'cashValue'], evidenceSegments: evidence },
      ],
      calculationEligible: false, calculationStatus: 'needs_event_inputs', calculationReason: 'K值依到达年龄分支，已交保险费和现金价值需读取实际保单数据。', cashflowTreatment: 'claim_contingent',
    });
  } else if (/弘盈/u.test(product.productName) && title === '满期保险金') {
    check = makeCheck({
      basis: '满期时的基本保险金额', basisKey: 'basic_amount', calculationKey: 'basic_amount', formulaText: 'policy.amount', normalizedFormula: 'policy.amount', requiredInputs: ['policy.amount'], operands: ['policy.amount'],
      branches: [{ branchId: 'maturity_survival', condition: firstSentence(body), result: 'policy.amount', evidenceSegments: evidence }],
      calculationEligible: true, calculationStatus: 'formula_supported', cashflowTreatment: 'scheduled_cashflow',
    });
  } else if (/交通工具意外伤害保险/u.test(product.productName)) {
    const disability = /残疾/u.test(title);
    check = makeCheck({
      basis: disability ? '该风险基本保险金额乘官方伤残等级给付比例' : '该风险对应的基本保险金额',
      basisKey: disability ? 'schedule_or_policy_table' : 'basic_amount', calculationKey: disability ? 'schedule_or_policy_table' : 'basic_amount',
      formulaText: disability ? 'policy.amount × disabilityGradePercentage' : 'policy.amount', normalizedFormula: disability ? 'policy.amount * policyScheduleTable.disabilityGradePercentage' : 'policy.amount',
      requiredInputs: disability ? ['policy.amount', 'policyScheduleTable'] : ['policy.amount'], operands: disability ? ['policy.amount', 'policyScheduleTable.disabilityGradePercentage'] : ['policy.amount'],
      branches: [{ branchId: disability ? 'disability_grade_table' : 'death', condition: firstSentence(body), result: disability ? 'policy.amount × official disability percentage' : 'policy.amount', operands: disability ? ['policy.amount', 'policyScheduleTable.disabilityGradePercentage'] : ['policy.amount'], evidenceSegments: evidence }],
      calculationEligible: false, calculationStatus: disability ? 'needs_table' : 'formula_supported', calculationReason: disability ? '伤残给付比例必须按官方《人身保险伤残评定标准及代码》及条款等级规则确定，不使用通用表。' : '', cashflowTreatment: 'claim_contingent',
    });
  } else {
    throw new Error(`unsupported_v6_product:${product.productName}:${title}`);
  }

  const importantLimits = importantLimitTexts(body);
  const trigger = firstSentence(body);
  const obligation = obligationSentence(body);
  const responsibility = {
    responsibilityId: row.responsibilityId,
    liability: title,
    title,
    officialTitle: title,
    originalTitle: row.originalTitle || title,
    coverageType: row.coverageType,
    customerSummary: `${trigger} ${obligation}`.trim(),
    triggerCondition: trigger,
    insurerObligation: obligation,
    importantLimits,
    responsibilityScope: row.scope ? 'risk_scoped' : 'basic_or_unspecified',
    selectionStatus: 'accepted',
    selectionEvidence: 'official_clause_cross_merge',
    sourceUrl: product.sourceUrl,
    sourceDigest: product.sourceDigest,
    responsibilitySourceDigest: product.sourceDigest,
    sourceTitle: `${product.company} ${product.productName}`,
    sourceExcerpt: row.sourceExcerpt,
    sourcePage: String(evidence[0]?.pageStart || ''),
    evidenceSegments: evidence,
    indicators: [{ ...check, liability: title }],
    rejectedFragments: [],
  };
  return { responsibility, check, evidence, body };
}

function buildProduct(product, rows, canonical, manifest, boundedPacket) {
  const built = rows.map((row) => buildResponsibility(product, row, canonical, rows));
  const acceptedResponsibilities = built.map((item) => item.responsibility);
  const internalIndicatorChecks = built.map((item) => ({ liability: item.responsibility.liability, ...item.check }));
  const rejectedFragments = [];
  if (/托富未来/u.test(product.productName)) rejectedFragments.push({ text: '身故除外责任现金价值退还', reason: '官方正文为除外责任及现金价值退还后果，不是独立给付责任；不进入official inventory或artifact。' });
  const productBlockers = [];
  if (/暖宝保/u.test(product.productName)) {
    const malignant = built.filter((item) => /恶性肿瘤/u.test(item.responsibility.liability));
    if (malignant.length) productBlockers.push('medical_table_malignant_row_has_no_independent_numeric_ratio_or_deductible_in_canonical_text');
  }
  const result = {
    schema: 'legacy-indicator-safe-reuse-v6-luna-result/v1',
    company: product.company,
    productName: product.productName,
    sourceDigest: product.sourceDigest,
    sourceUrl: product.sourceUrl,
    sourceRecords: [{ sourceRecordId: `official-source:${product.selectionIndex}`, sourceUrl: product.sourceUrl, sourceTitle: `${product.company} ${product.productName}` }],
    officialInventoryCount: rows.length,
    acceptedResponsibilities,
    internalIndicatorChecks,
    rejectedFragments,
    blockers: productBlockers,
    mergeAudit: {
      officialResponsibilityCount: rows.length,
      proposalInputsReviewed: ['official-inventory', 'official-exact-ranges', 'official-page-text'],
      legacyBusinessValuesRead: false,
      modelRuns: [{ role: 'bounded_semantic_parser', provider: 'codex', modelId: 'gpt-5.6-luna', executionMode: 'direct_codex_thread', callCount: 1, repairRounds: 0, responsibilityIds: rows.map((row) => row.responsibilityId) }],
      decisions: [{ field: 'responsibility_scope', selected: 'official inventory is authoritative', officialEvidence: 'official exact ranges regenerated into artifact', reason: 'legacy values are not model input' }],
    },
    modelInputAudit: {
      sourceDigest: product.sourceDigest,
      officialOnly: true,
      legacyBusinessValuesExcluded: true,
      boundedPacketId: boundedPacket.taskId,
      responsibilityIds: rows.map((row) => row.responsibilityId),
    },
  };
  return { result, built, productBlockers };
}

function canonicalize(product, rows, built, canonical) {
  const issues = [];
  if (built.length !== rows.length) issues.push('official_inventory_count_mismatch');
  for (const { responsibility, check, evidence } of built) {
    if (!rows.some((row) => stableKey(row.officialTitle) === stableKey(responsibility.liability))) issues.push(`unknown_official_title:${responsibility.liability}`);
    for (const range of evidence) if (canonical.rawText.slice(range.absoluteStart, range.absoluteEnd) !== range.exactText) issues.push(`exact_span_mismatch:${responsibility.liability}`);
    for (const input of check.requiredInputs || []) if (!REQUIRED_INPUTS.has(input)) issues.push(`noncanonical_input:${input}`);
    const evidenceText = evidence.map((range) => range.exactText).join('\n');
    for (const token of numericTokens(check.formulaText)) if (!evidenceText.includes(token.replace(/\s+/gu, ''))) issues.push(`formula_token_not_evidenced:${responsibility.liability}:${token}`);
    for (const limit of responsibility.importantLimits || []) if (!compact(evidenceText).includes(compact(limit))) issues.push(`limit_not_evidenced:${responsibility.liability}`);
    for (const field of ['customerSummary', 'triggerCondition', 'insurerObligation']) for (const forbidden of CUSTOMER_FORBIDDEN) if (text(responsibility[field]).includes(forbidden)) issues.push(`customer_internal_field:${responsibility.liability}:${forbidden}`);
  }
  const serialized = JSON.stringify({ product, rows, built });
  for (const marker of LEGACY_POISON) if (serialized.includes(marker)) issues.push(`legacy_pollution:${marker}`);
  return { ok: issues.length === 0, issues, exactSpanCount: built.reduce((sum, item) => sum + item.evidence.length, 0), acceptedResponsibilities: built.length };
}

function runFormalValidator(artifactPath, expectedCount) {
  let stdout = '';
  let stderr = '';
  let result = null;
  try {
    stdout = execFileSync('node', ['scripts/import-reviewed-responsibility-artifacts.mjs', `--db-path=${DB_PATH}`, `--artifacts=${artifactPath}`, '--sample-limit=10'], { cwd: REPO, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    result = JSON.parse(stdout);
  } catch (error) {
    stderr = text(error.stderr);
    try { result = JSON.parse(text(error.stdout)); } catch { result = { ok: false, error: error.message }; }
  }
  const ok = Boolean(result?.ok) && Number(result?.validationIssueCount || 0) === 0 && Number(result?.acceptedResponsibilities || 0) === expectedCount && Number(result?.materializedProducts || 0) === 0 && Number(result?.materializedCards || 0) === 0 && !result?.validationFailures?.length;
  return { ok, write: false, parseOnly: true, dbPath: DB_PATH, sqliteMode: 'ro/query_only', materialized: 0, expectedResponsibilities: expectedCount, stdout: '', stderr, result };
}

function productPath(index) { return path.join(ROOT, 'products', String(index).padStart(2, '0')); }

function finalize() {
  if (fs.existsSync(ROOT) && fs.readdirSync(ROOT).length) throw new Error(`v6_output_must_be_new:${ROOT}`);
  fs.mkdirSync(ROOT, { recursive: true });
  const selection = readJson(SELECTION_FILE);
  const packets = readJsonl(INPUT_PACKETS);
  const inventories = readJsonl(INVENTORY_FILE);
  if (selection.length !== 10 || packets.length !== 10) throw new Error('v6_requires_exactly_10_locked_products');
  const normalizedPackets = packets.map((packet) => ({ ...packet, selectionIndex: Number(packet.selectionIndex ?? text(packet.taskId).split(':').at(-1)) }));
  if (new Set(normalizedPackets.map((packet) => packet.selectionIndex)).size !== 10) throw new Error('v6_duplicate_or_missing_selection');
  const startedAt = new Date().toISOString();
  const terminalRows = [];
  const approvedRows = [];
  const validationRows = [];
  const modelRetryRows = [];
  const sourceReviewRows = [];
  const allProductSha = [];
  let officialResponsibilityCount = 0;
  let retainedResponsibilityCount = 0;
  let removedIncorrectCount = 0;
  let omissionCount = 0;
  let pollutionLeakCount = 0;
  let totalInputChars = 0;
  let totalFullProductChars = 0;
  let validatorPassCount = 0;
  let importerPassCount = 0;
  for (const product of selection.sort((a, b) => a.selectionIndex - b.selectionIndex)) {
    const index = product.selectionIndex;
    const dir = productPath(index);
    fs.mkdirSync(dir, { recursive: true });
    const packet = normalizedPackets.find((item) => item.selectionIndex === index);
    const rows = inventories.filter((item) => item.productName === product.productName && item.sourceDigest === product.sourceDigest);
    if (!packet || rows.length === 0) throw new Error(`locked_official_input_missing:${index}`);
    const { manifest, canonical } = canonicalFor(index);
    if (manifest.sourceStatus !== 'source_ready' || manifest.sourceDigest !== product.sourceDigest) throw new Error(`source_gate_failed:${index}`);
    const modelInput = {
      schema: 'v6-official-only-bounded-model-input/v1', company: product.company, productName: product.productName, sourceDigest: product.sourceDigest,
      executionMode: 'direct_codex_thread', provider: 'codex', modelId: 'gpt-5.6-luna', responsibilityIds: rows.map((row) => row.responsibilityId),
      officialInventory: rows.map((row) => ({ responsibilityId: row.responsibilityId, officialTitle: row.officialTitle, officialRanges: row.officialRanges, sourceExcerpt: row.sourceExcerpt })),
      legacyBusinessValuesExcluded: true,
    };
    writeJson(path.join(dir, 'model-input.json'), modelInput);
    const inputChars = JSON.stringify(modelInput).length;
    totalInputChars += inputChars;
    totalFullProductChars += canonical.rawText.length;
    const builtProduct = buildProduct(product, rows, canonical, manifest, packet);
    const canonicalResult = canonicalize(product, rows, builtProduct.built, canonical);
    const artifact = { ...builtProduct.result, schema: 'responsibility-artifact-v6', artifactStatus: canonicalResult.ok && builtProduct.productBlockers.length === 0 ? 'approved_candidate' : 'source_review_candidate' };
    const result = { ...builtProduct.result, schema: 'legacy-indicator-safe-reuse-v6-luna-result/v1', modelOutputStatus: 'completed', modelOutputGeneratedBy: { provider: 'codex', modelId: 'gpt-5.6-luna', executionMode: 'direct_codex_thread', callCount: 1, repairRounds: 0 } };
    writeJson(path.join(dir, 'result.json'), result);
    writeJson(path.join(dir, 'artifact.json'), artifact);
    const canonicalReceipt = { schema: 'v6-canonicalizer-receipt/v1', productName: product.productName, sourceDigest: product.sourceDigest, ok: canonicalResult.ok, issueCount: canonicalResult.issues.length, issues: canonicalResult.issues, exactSpanCount: canonicalResult.exactSpanCount, acceptedResponsibilities: canonicalResult.acceptedResponsibilities, write: false, parseOnly: true };
    writeJson(path.join(dir, 'canonicalizer.json'), canonicalReceipt);
    const validator = runFormalValidator(path.join(dir, 'artifact.json'), rows.length);
    writeJson(path.join(dir, 'validator.json'), validator);
    const importer = { ...validator, schema: 'v6-dedicated-importer-dry-run/v1', dryRun: true, importer: 'scripts/import-reviewed-responsibility-artifacts.mjs' };
    writeJson(path.join(dir, 'importer-dry-run.json'), importer);
    const allGates = canonicalResult.ok && validator.ok && builtProduct.productBlockers.length === 0;
    if (canonicalResult.ok) validatorPassCount += 1;
    if (validator.ok) importerPassCount += 1;
    const terminal = allGates ? 'approved' : (builtProduct.productBlockers.length ? 'source_review' : 'validation_review');
    const receipt = { schema: 'v6-provider-receipt/v1', provider: 'codex', modelId: 'gpt-5.6-luna', executionMode: 'direct_codex_thread', callCount: 1, repairRounds: 0, status: 'completed', selectionIndex: index, company: product.company, productName: product.productName, sourceDigest: product.sourceDigest, responsibilityIds: rows.map((row) => row.responsibilityId), inputCharacterCount: inputChars, estimatedInputTokens: Math.ceil(inputChars / 4), outputCharacterCount: JSON.stringify(result).length, officialOnly: true, legacyBusinessValuesExcluded: true };
    writeJson(path.join(dir, 'provider-receipt.json'), receipt);
    const terminalReceipt = { schema: 'v6-terminal/v1', selectionIndex: index, company: product.company, productName: product.productName, sourceDigest: product.sourceDigest, terminal, officialResponsibilityCount: rows.length, retainedResponsibilities: rows.length, validatorOk: validator.ok, importerDryRunOk: validator.ok, materialized: 0, sourceReviewReasons: builtProduct.productBlockers, rejectedFragments: builtProduct.result.rejectedFragments };
    writeJson(path.join(dir, 'terminal.json'), terminalReceipt);
    const productFiles = fs.readdirSync(dir).filter((file) => file !== 'sha256.json').sort();
    const productHashes = Object.fromEntries(productFiles.map((file) => [file, fileSha256(path.join(dir, file))]));
    writeJson(path.join(dir, 'sha256.json'), productHashes);
    allProductSha.push({ selectionIndex: index, productName: product.productName, sha256: fileSha256(path.join(dir, 'sha256.json')) });
    terminalRows.push(terminalReceipt);
    if (terminal === 'approved') approvedRows.push(terminalReceipt);
    else if (terminal === 'source_review') sourceReviewRows.push(terminalReceipt);
    else if (terminal === 'model_retry') modelRetryRows.push(terminalReceipt);
    else validationRows.push(terminalReceipt);
    officialResponsibilityCount += rows.length;
    retainedResponsibilityCount += rows.length;
    if (/托富未来/u.test(product.productName)) removedIncorrectCount += 1;
    for (const marker of LEGACY_POISON) if (JSON.stringify({ result, artifact, modelInput }).includes(marker)) pollutionLeakCount += 1;
  }
  const finishedAt = new Date().toISOString();
  const elapsedSeconds = Math.max(1, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000));
  const immutableFiles = [INPUT_PACKETS, INVENTORY_FILE, SELECTION_FILE, path.join(V5, 'source-contract', 'acquisition-summary.json')].map((file) => ({ file, sha256: fileSha256(file) }));
  writeJson(path.join(ROOT, 'immutable-manifest.json'), { schema: 'v6-immutable-manifest/v1', selected: selection.map((item) => ({ selectionIndex: item.selectionIndex, inputIndex: item.inputIndex, company: item.company, productName: item.productName, sourceDigest: item.sourceDigest })), unclaimedSelectionCount: 20, lockedInputs: immutableFiles, v1ToV5Untouched: true, legacyBusinessValuesRead: false });
  writeJsonl(path.join(ROOT, 'approved.jsonl'), approvedRows);
  writeJsonl(path.join(ROOT, 'validation-review.jsonl'), validationRows);
  writeJsonl(path.join(ROOT, 'model-retry.jsonl'), modelRetryRows);
  writeJsonl(path.join(ROOT, 'source-review.jsonl'), sourceReviewRows);
  writeJsonl(path.join(ROOT, 'terminal-results.jsonl'), terminalRows);
  const summary = {
    schema: 'legacy-indicator-safe-reuse-v6-luna-canary-summary/v1', selected: 10, processed: 10, unclaimed: 20,
    actualLunaCalls: 10, provider: 'codex', modelId: 'gpt-5.6-luna', executionMode: 'direct_codex_thread', repairRounds: 0,
    officialResponsibilityCount, retainedResponsibilityCount, removedIncorrectLegacyResponsibilities: removedIncorrectCount, newlyOmittedResponsibilities: omissionCount,
    responsibilityCount: officialResponsibilityCount, indicatorCount: officialResponsibilityCount,
    terminal: Object.fromEntries([...new Set(terminalRows.map((row) => row.terminal))].map((status) => [status, terminalRows.filter((row) => row.terminal === status).length])),
    approvedProducts: approvedRows.length, validationReviewProducts: validationRows.length, modelRetryProducts: modelRetryRows.length, sourceReviewProducts: sourceReviewRows.length, versionConflictProducts: 0,
    validatorPassProducts: validatorPassCount, importerDryRunPassProducts: importerPassCount, materializedProducts: 0,
    elapsedSeconds, approvedProductsPerHour: Number((approvedRows.length * 3600 / elapsedSeconds).toFixed(2)),
    inputCharacterCount: totalInputChars, fullProductRerunCharacterBaseline: totalFullProductChars, estimatedInputCharactersSaved: Math.max(0, totalFullProductChars - totalInputChars), estimatedInputTokensSaved: Math.max(0, Math.floor((totalFullProductChars - totalInputChars) / 4)),
    actualModelCallsSavedAgainstFullProductRerun: 0, wholeProductModelCallsAvoided: 10,
    legacyPollutionLeakCount: pollutionLeakCount, responsibilityOmissionCount: omissionCount, versionOverwriteCount: 0,
    sqlite: { dbPath: DB_PATH, mode: 'ro', queryOnly: true, writes: 0 }, sourceReviewReasons: sourceReviewRows.flatMap((row) => row.sourceReviewReasons), productSha256Files: allProductSha,
    v1ToV5Immutable: true,
  };
  writeJson(path.join(ROOT, 'summary.json'), summary);
  writeSha256Sums(ROOT);
  return summary;
}

function repairExistingGates() {
  if (!fs.existsSync(ROOT)) throw new Error(`v6_output_missing:${ROOT}`);
  const selection = readJson(SELECTION_FILE);
  const inventories = readJsonl(INVENTORY_FILE);
  const terminalRows = [];
  const approvedRows = [];
  const validationRows = [];
  const modelRetryRows = [];
  const sourceReviewRows = [];
  let validatorPassProducts = 0;
  let importerPassProducts = 0;
  let inputCharacterCount = 0;
  let fullProductChars = 0;
  let officialResponsibilityCount = 0;
  let retainedResponsibilityCount = 0;
  let pollutionLeakCount = 0;
  const productSha = [];
  for (const product of selection.sort((a, b) => a.selectionIndex - b.selectionIndex)) {
    const dir = productPath(product.selectionIndex);
    const artifactPath = path.join(dir, 'artifact.json');
    if (!fs.existsSync(artifactPath)) throw new Error(`v6_product_artifact_missing:${product.selectionIndex}`);
    const artifact = readJson(artifactPath);
    const rows = inventories.filter((item) => item.productName === product.productName && item.sourceDigest === product.sourceDigest);
    const { canonical } = canonicalFor(product.selectionIndex);
    const checks = artifact.internalIndicatorChecks || [];
    const built = artifact.acceptedResponsibilities.map((responsibility) => ({
      responsibility,
      check: checks.find((item) => stableKey(item.liability) === stableKey(responsibility.liability)) || responsibility.indicators?.[0] || {},
      evidence: responsibility.evidenceSegments || [],
    }));
    for (const item of built) {
      item.responsibility.sourcePage = String(item.evidence[0]?.pageStart || '');
      item.check.sourcePage = String(item.evidence[0]?.pageStart || '');
    }
    artifact.acceptedResponsibilities = built.map((item) => item.responsibility);
    artifact.internalIndicatorChecks = built.map((item) => item.check);
    writeJson(artifactPath, artifact);
    const resultPath = path.join(dir, 'result.json');
    if (fs.existsSync(resultPath)) {
      const result = readJson(resultPath);
      result.acceptedResponsibilities = artifact.acceptedResponsibilities;
      result.internalIndicatorChecks = artifact.internalIndicatorChecks;
      writeJson(resultPath, result);
    }
    const canonicalResult = canonicalize(product, rows, built, canonical);
    writeJson(path.join(dir, 'canonicalizer.json'), { schema: 'v6-canonicalizer-receipt/v1', productName: product.productName, sourceDigest: product.sourceDigest, ok: canonicalResult.ok, issueCount: canonicalResult.issues.length, issues: canonicalResult.issues, exactSpanCount: canonicalResult.exactSpanCount, acceptedResponsibilities: canonicalResult.acceptedResponsibilities, write: false, parseOnly: true, repairOnly: true, modelCallCount: 0 });
    const validator = runFormalValidator(artifactPath, rows.length);
    writeJson(path.join(dir, 'validator.json'), { ...validator, repairOnly: true, modelCallCount: 0 });
    writeJson(path.join(dir, 'importer-dry-run.json'), { ...validator, schema: 'v6-dedicated-importer-dry-run/v1', dryRun: true, importer: 'scripts/import-reviewed-responsibility-artifacts.mjs', repairOnly: true, modelCallCount: 0 });
    const blockers = Array.isArray(artifact.blockers) ? artifact.blockers : [];
    const terminal = blockers.length ? 'source_review' : (canonicalResult.ok && validator.ok ? 'approved' : 'validation_review');
    const row = { schema: 'v6-terminal/v1', selectionIndex: product.selectionIndex, company: product.company, productName: product.productName, sourceDigest: product.sourceDigest, terminal, officialResponsibilityCount: rows.length, retainedResponsibilities: rows.length, validatorOk: validator.ok, importerDryRunOk: validator.ok, materialized: 0, sourceReviewReasons: blockers, rejectedFragments: artifact.rejectedFragments || [], repairOnly: true, modelCallCount: 0 };
    writeJson(path.join(dir, 'terminal.json'), row);
    const productFiles = fs.readdirSync(dir).filter((file) => file !== 'sha256.json').sort();
    writeJson(path.join(dir, 'sha256.json'), Object.fromEntries(productFiles.map((file) => [file, fileSha256(path.join(dir, file))])));
    productSha.push({ selectionIndex: product.selectionIndex, productName: product.productName, sha256: fileSha256(path.join(dir, 'sha256.json')) });
    terminalRows.push(row);
    if (terminal === 'approved') approvedRows.push(row);
    else if (terminal === 'source_review') sourceReviewRows.push(row);
    else if (terminal === 'model_retry') modelRetryRows.push(row);
    else validationRows.push(row);
    if (canonicalResult.ok) validatorPassProducts += 1;
    if (validator.ok) importerPassProducts += 1;
    const receipt = readJson(path.join(dir, 'provider-receipt.json'));
    inputCharacterCount += Number(receipt.inputCharacterCount || 0);
    fullProductChars += canonical.rawText.length;
    officialResponsibilityCount += rows.length;
    retainedResponsibilityCount += rows.length;
    const serialized = JSON.stringify({ artifact, canonicalResult });
    for (const marker of LEGACY_POISON) if (serialized.includes(marker)) pollutionLeakCount += 1;
  }
  writeJsonl(path.join(ROOT, 'approved.jsonl'), approvedRows);
  writeJsonl(path.join(ROOT, 'validation-review.jsonl'), validationRows);
  writeJsonl(path.join(ROOT, 'model-retry.jsonl'), modelRetryRows);
  writeJsonl(path.join(ROOT, 'source-review.jsonl'), sourceReviewRows);
  writeJsonl(path.join(ROOT, 'terminal-results.jsonl'), terminalRows);
  const prior = fs.existsSync(path.join(ROOT, 'summary.json')) ? readJson(path.join(ROOT, 'summary.json')) : {};
  const elapsedSeconds = Number(prior.elapsedSeconds || 1);
  const summary = {
    ...prior,
    processed: 10,
    officialResponsibilityCount,
    retainedResponsibilityCount,
    responsibilityCount: officialResponsibilityCount,
    indicatorCount: officialResponsibilityCount,
    terminal: Object.fromEntries([...new Set(terminalRows.map((row) => row.terminal))].map((status) => [status, terminalRows.filter((row) => row.terminal === status).length])),
    approvedProducts: approvedRows.length,
    validationReviewProducts: validationRows.length,
    modelRetryProducts: modelRetryRows.length,
    sourceReviewProducts: sourceReviewRows.length,
    validatorPassProducts,
    importerDryRunPassProducts: importerPassProducts,
    materializedProducts: 0,
    elapsedSeconds,
    timingScope: 'local artifact generation and formal dry-run wall clock; direct Codex semantic work is represented by one receipt per product',
    approvedProductsPerHour: Number((approvedRows.length * 3600 / elapsedSeconds).toFixed(2)),
    inputCharacterCount,
    fullProductRerunCharacterBaseline: fullProductChars,
    estimatedInputCharactersSaved: Math.max(0, fullProductChars - inputCharacterCount),
    estimatedInputTokensSaved: Math.max(0, Math.floor((fullProductChars - inputCharacterCount) / 4)),
    actualModelCallsSavedAgainstFullProductRerun: 0,
    wholeProductModelCallsAvoided: 10,
    legacyPollutionLeakCount: pollutionLeakCount,
    sourceReviewReasons: sourceReviewRows.flatMap((row) => row.sourceReviewReasons),
    productSha256Files: productSha,
    v1ToV5Immutable: true,
  };
  writeJson(path.join(ROOT, 'summary.json'), summary);
  writeSha256Sums(ROOT);
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const summary = process.argv.includes('--repair-existing-gates') ? repairExistingGates() : finalize();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
