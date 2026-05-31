import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(projectRoot, '.runtime', 'policy-ocr.sqlite');

function trim(value) {
  return String(value ?? '').trim();
}

function normalizeLookupText(value) {
  return trim(value).normalize('NFKC').replace(/\s+/gu, '');
}

function parsePayload(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeIndicatorRows(indicatorRows = []) {
  return indicatorRows.map((row) => {
    const payload = parsePayload(row.payload);
    return {
      id: trim(row.id),
      company: trim(row.company || payload.company),
      productName: trim(row.productName || row.product_name || payload.productName),
      coverageType: trim(row.coverageType || row.coverage_type || payload.coverageType),
      liability: trim(row.liability || payload.liability),
      payload,
    };
  });
}

function normalizeOptionalRows(optionalRows = []) {
  return optionalRows.map((row) => {
    const payload = parsePayload(row.payload);
    return {
      id: trim(row.id),
      company: trim(row.company || payload.company),
      productName: trim(row.productName || row.product_name || payload.productName),
      liability: trim(row.liability || payload.liability),
      payload,
    };
  });
}

function cleanDocumentProductName(value = '') {
  let productName = trim(value)
    .replace(/\s+/gu, ' ')
    .replace(/(?:产品)?(?:条款|保险条款|利益条款|产品说明书|产品说明)(?:\.(?:pdf|PDF))?$/u, '')
    .replace(/(?:产品)?(?:条款|保险条款|利益条款|产品说明书|产品说明)$/u, '')
    .trim();
  productName = productName.replace(/(?:产品)?条款$/u, '').trim();
  return productName || trim(value);
}

function resolveMultiProductName(row = {}) {
  const productName = trim(row.productName || row.payload?.productName);
  if (!/^\d+[.．、]/u.test(productName) || !/\s+\d+[.．、]/u.test(productName)) return '';
  const text = normalizeLookupText(row.payload?.sourceExcerpt);
  const liability = normalizeLookupText(row.liability || row.payload?.liability);
  if (/水陆公共交通|公共交通工具/u.test(text)) return '交银人寿附加交银水陆公共交通工具意外伤害保险';
  if (/航空|民航/u.test(text)) return '交银人寿附加交银航空意外伤害保险（A）';
  if (/驾乘|非营业车辆|公务车/u.test(text)) return '交银人寿附加驾乘A意外伤害保险';
  if (/医疗|医保|报销/u.test(text) || /医疗|医保/u.test(liability)) return '交银人寿附加意外A医疗保险';
  if (/生活补贴|津贴/u.test(text)) return '交银人寿附加交银生活补贴意外伤害保险';
  return '';
}

function sourceText(row = {}) {
  return normalizeLookupText(row.payload?.sourceExcerpt);
}

function rowLiability(row = {}) {
  return trim(row.liability || row.payload?.liability);
}

function rowCoverageType(row = {}) {
  return trim(row.coverageType || row.payload?.coverageType);
}

function rowValue(row = {}) {
  return row.payload?.value ?? row.value;
}

function rowUnit(row = {}) {
  return trim(row.payload?.unit || row.unit);
}

function rowBasis(row = {}) {
  return trim(row.payload?.basis || row.basis);
}

function hasAccidentAnchor(text = '') {
  return /(意外伤害|遭受意外|意外事故|因意外|因遭受.{0,10}意外|交通|航空|驾乘|客运|公共交通|自驾|水陆|轮船|列车|电梯|自然灾害)/u.test(text);
}

function inferAccidentDisabilityCorrection(row = {}) {
  const text = sourceText(row);
  const liability = rowLiability(row);
  if (!/意外保障/u.test(rowCoverageType(row))) return null;
  if (!/意外.*(?:全残|伤残|残疾)|(?:全残|伤残|残疾).*意外/u.test(liability)) return null;
  if (hasAccidentAnchor(text)) return null;
  let nextLiability = liability.replace(/^意外/u, '').replace(/意外/u, '').trim();
  if (/高度残疾/u.test(text)) nextLiability = '高度残疾保险金';
  else if (/身体全残|全残/u.test(text)) nextLiability = nextLiability || '全残保险金';
  else if (/伤残|残疾/u.test(text)) nextLiability = nextLiability || '残疾保险金';
  if (!nextLiability) return null;
  if (!/保险金|给付/u.test(nextLiability)) nextLiability = `${nextLiability}保险金`;
  return { coverageType: '人寿保障', liability: nextLiability };
}

function inferCancerCorrection(row = {}) {
  const text = sourceText(row);
  const liability = rowLiability(row);
  if (!/癌|恶性肿瘤|防癌/u.test(liability)) return null;
  if (/(癌|恶性肿瘤|肿瘤|原位癌)/u.test(text)) return null;
  if (/重大疾病/u.test(text)) return { coverageType: '疾病保障', liability: '重大疾病保险金' };
  if (/特定疾病/u.test(text)) return { coverageType: '疾病保障', liability: '特定疾病保险金' };
  if (/(医疗费用|医疗保险金|年度最高给付限额|最高给付限额|医院接受治疗)/u.test(text)) {
    return { coverageType: '医疗保障', liability: '医疗保险金' };
  }
  if (/疾病/u.test(text)) return { coverageType: '疾病保障', liability: '疾病保险金' };
  return null;
}

function inferCombinedBranchCorrection(row = {}) {
  const text = sourceText(row);
  const liability = rowLiability(row);
  if (!/(身故\/?(?:或)?(?:身体)?(?:全残|伤残|高度残疾)|身故或身体全残|身故或高度残疾|身故\/高度残疾)/u.test(liability)) {
    return null;
  }
  const hasDeath = /身故/u.test(text);
  const hasDisability = /(全残|伤残|残疾|高度残疾|身体全残)/u.test(text);
  if (hasDeath && hasDisability) return null;
  if (!hasDeath && !hasDisability) return null;
  let nextLiability = liability;
  if (hasDeath) {
    nextLiability = nextLiability
      .replace(/身故\/?(?:或)?身体?全残/u, '身故')
      .replace(/身故\/?(?:或)?高度残疾/u, '身故')
      .replace(/身故\/?(?:或)?伤残/u, '身故')
      .replace(/\/全残|\/伤残|\/高度残疾/u, '');
  } else {
    const branch = /高度残疾/u.test(text) ? '高度残疾' : /伤残|残疾/u.test(text) ? '伤残' : '全残';
    nextLiability = nextLiability
      .replace(/身故\/?(?:或)?身体?全残/u, branch)
      .replace(/身故\/?(?:或)?高度残疾/u, branch)
      .replace(/身故\/?(?:或)?伤残/u, branch)
      .replace(/身故\//u, '');
  }
  nextLiability = nextLiability.trim();
  if (!nextLiability || nextLiability === liability) return null;
  if (!/保险金|给付/u.test(nextLiability)) nextLiability = `${nextLiability}保险金`;
  return { liability: nextLiability };
}

function inferMaturityCorrection(row = {}) {
  const text = sourceText(row);
  const liability = rowLiability(row);
  if (!/满期返还|满期保险金|满期生存/u.test(liability)) return null;
  if (/(满期|保险期间届满|期满|保险期满)/u.test(text)) return null;
  if (/养老年金/u.test(text)) return { coverageType: '现金流', liability: '养老年金' };
  if (/生存保险金/u.test(text)) return { coverageType: '现金流', liability: '生存保险金' };
  if (/年金/u.test(text)) return { coverageType: '现金流', liability: '年金' };
  return null;
}

function chineseNumber(value = '') {
  const text = trim(value);
  const direct = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (/^一百[一二两三四五六七八九]?十?$/u.test(text)) {
    const middle = text.match(/^一百([一二两三四五六七八九])?十?$/u)?.[1];
    return 100 + (middle ? direct[middle] * 10 : 0);
  }
  if (/^一百[一二两三四五六七八九]十[一二两三四五六七八九]?$/u.test(text)) {
    const match = text.match(/^一百([一二两三四五六七八九])十([一二两三四五六七八九])?$/u);
    return 100 + direct[match[1]] * 10 + (match[2] ? direct[match[2]] : 0);
  }
  if (/^[一二两三四五六七八九]十[一二两三四五六七八九]?$/u.test(text)) {
    const match = text.match(/^([一二两三四五六七八九])十([一二两三四五六七八九])?$/u);
    return direct[match[1]] * 10 + (match[2] ? direct[match[2]] : 0);
  }
  return direct[text] || null;
}

function inferZeroMultiple(row = {}) {
  if (Number(rowValue(row)) !== 0 || rowUnit(row) !== '倍') return null;
  const raw = trim(row.payload?.sourceExcerpt);
  const match = raw.match(/([一二两三四五六七八九十百]{1,8})倍/u);
  const value = match ? chineseNumber(match[1]) : null;
  if (!value) return null;
  let basis = rowBasis(row);
  if (/住院保险金日额/u.test(raw)) basis = '住院保险金日额';
  else if (/保险金额/u.test(raw)) basis = '保险金额';
  return {
    value,
    unit: '倍',
    basis,
    formulaText: `${basis} × ${value}倍`,
  };
}

function repeatedPercentCandidate(valueText = '') {
  const compact = valueText.replace(/\D/gu, '');
  if (!compact) return null;
  for (const width of [3, 2]) {
    if (compact.length >= width * 2 && compact.length % width === 0) {
      const chunk = compact.slice(0, width);
      if (chunk.repeat(compact.length / width) === compact) return Number(chunk);
    }
  }
  if (/^([1-9])\1+0+$/u.test(compact)) return Number(`${compact[0]}0`);
  if (/^10(?:10)+100$/u.test(compact)) return 100;
  return null;
}

function tablePercentCandidate(value) {
  const text = String(value);
  const decimal = text.match(/^(\d{1,2})(\d{2,3}\.\d+)$/u);
  if (decimal) {
    const candidate = Number(decimal[2]);
    if (candidate > 0 && candidate <= 300) return candidate;
  }
  const compact = text.replace(/\D/gu, '');
  const repeated = repeatedPercentCandidate(compact);
  if (repeated && repeated <= 300) return repeated;
  if (compact.length >= 4) {
    const tail3 = Number(compact.slice(-3));
    const tail2 = Number(compact.slice(-2));
    if (tail3 >= 50 && tail3 <= 300) return tail3;
    if (tail2 > 0 && tail2 <= 100) return tail2;
  }
  return null;
}

function inferSuspiciousPercent(row = {}) {
  const value = Number(rowValue(row));
  if (!Number.isFinite(value) || value <= 1000 || rowUnit(row) !== '%') return null;
  const source = trim(row.payload?.sourceExcerpt);
  if (/1500\s*%/u.test(source) && /基本保险金额/u.test(source)) {
    return {
      value: 15,
      unit: '倍',
      basis: rowBasis(row) || '基本保额',
      formulaText: `${rowBasis(row) || '基本保额'} × 15倍`,
      conversion: 'percent_to_multiple',
    };
  }
  const candidate = tablePercentCandidate(value);
  if (!candidate) return null;
  return {
    value: candidate,
    unit: '%',
    basis: rowBasis(row),
    formulaText: row.payload?.formulaText || `${rowBasis(row) || '条款载明基准'} × ${candidate}%`,
    conversion: 'table_percent',
  };
}

function inferFormulaText(row = {}) {
  if (rowUnit(row) !== '公式' || trim(row.payload?.formulaText)) return null;
  const raw = trim(row.payload?.sourceExcerpt);
  const text = normalizeLookupText(raw);
  if (/二者之和/u.test(text) && /实际交纳/u.test(text)) return '相关合同实际交纳保险费之和';
  if (/实际交纳的?保险费/u.test(text)) return '实际交纳保险费';
  if (/已交保险费|所交保险费/u.test(text)) return '已交保险费';
  if (/现金价值/u.test(text) && /(较大者|最大者)/u.test(text)) return 'max(现金价值, 条款约定金额)';
  return null;
}

function isClearWaitingRefund(row = {}) {
  if (rowLiability(row) === '赔付方式' || rowCoverageType(row) === '规则参数') return false;
  const text = sourceText(row);
  if (!text) return false;
  if (/等待期内.{0,80}按.{0,30}(?:已交保险费|所交保险费).{0,20}(?:给付|赔付).{0,20}(?:身故|全残)/u.test(text)) {
    return false;
  }
  return /(?:等待期内|生效之日起\d+日内|生效之日起\d+天内).{0,160}(?:不承担|退还|无息退还|返还).{0,60}(?:保险费|保费)/u.test(text);
}

function waitingRefundFormulaText(row = {}) {
  const text = sourceText(row);
  if (/累计已交保险费/u.test(text)) return '等待期内不承担原保险金责任，退还累计已交保险费';
  if (/实际交纳的?保险费|实际已交纳?保险费/u.test(text)) return '等待期内不承担原保险金责任，退还实际交纳保险费';
  if (/已交保险费|所交保险费|保费/u.test(text)) return '等待期内不承担原保险金责任，退还已交保险费';
  return '等待期内不承担原保险金责任，退还条款约定保险费';
}

function nonCalculableRulePatch(row = {}, now) {
  return {
    quantificationStatus: 'not_quantifiable',
    calculationEligible: false,
    excludeFromCalculation: true,
    responsibilityScope: row.payload?.responsibilityScope || 'rule_parameter',
    qualityStatus: 'non_calculable_rule_parameter',
    qualityReason: '赔付方式是保险责任机制说明，不作为可计算保险金指标',
    updatedAt: now,
  };
}

function waitingRefundPatch(row = {}, now) {
  const formulaText = waitingRefundFormulaText(row);
  return {
    coverageType: '规则参数',
    liability: '等待期退费处理',
    value: null,
    valueText: '',
    unit: '公式',
    basis: /累计已交保险费/u.test(formulaText) ? '累计已交保险费' : '已交保费',
    formulaText,
    condition: row.payload?.condition || '等待期内',
    originalCoverageType: row.payload?.originalCoverageType || rowCoverageType(row),
    originalLiability: row.payload?.originalLiability || rowLiability(row),
    originalValue: row.payload?.originalValue ?? rowValue(row) ?? null,
    originalUnit: row.payload?.originalUnit || rowUnit(row),
    quantificationStatus: 'not_quantifiable',
    calculationEligible: false,
    excludeFromCalculation: true,
    qualityStatus: 'reclassified_waiting_period_refund',
    qualityReason: '等待期内不承担原保险金责任并退还保费，不能作为保障给付指标',
    updatedAt: now,
  };
}

function cleanFormulaDisplayText(formulaText = '') {
  return trim(formulaText)
    .replace(/[，,、；;]?\s*现金价值不展示/gu, '')
    .replace(/[，,、；;]?\s*不展示现金价值/gu, '')
    .trim();
}

function cleanLeadingDe(value = '') {
  return trim(value).replace(/^的/u, '').trim();
}

function applyPatch(row, patch, reason, now) {
  const payload = {
    ...row.payload,
    ...patch,
    governanceReasons: [...new Set([...(Array.isArray(row.payload?.governanceReasons) ? row.payload.governanceReasons : []), reason])],
    updatedAt: patch.updatedAt || now,
  };
  return {
    id: row.id,
    company: patch.company || row.company,
    productName: patch.productName || payload.productName || row.productName,
    coverageType: patch.coverageType || payload.coverageType || row.coverageType,
    liability: patch.liability || payload.liability || row.liability,
    payload: {
      ...payload,
      company: patch.company || payload.company || row.company,
      productName: patch.productName || payload.productName || row.productName,
      coverageType: patch.coverageType || payload.coverageType || row.coverageType,
      liability: patch.liability || payload.liability || row.liability,
    },
  };
}

function optionalLogicalKey(row = {}) {
  return [
    row.company,
    row.productName,
    rowLiability(row),
    rowValue(row),
    rowUnit(row),
    rowBasis(row),
    trim(row.payload?.formulaText),
  ].map(normalizeLookupText).join('\u001f');
}

function isOptionalSectionSummary(row = {}) {
  return row.payload?.responsibilityScope === 'optional'
    && /本合同可选责任.{0,20}包含/u.test(trim(row.payload?.sourceExcerpt))
    && /包含/u.test(rowLiability(row));
}

export function buildRemainingIndicatorGovernancePlan({
  indicatorRows = [],
  optionalRows = [],
  now = new Date().toISOString(),
} = {}) {
  const indicators = normalizeIndicatorRows(indicatorRows);
  const optionalRecords = normalizeOptionalRows(optionalRows);
  const updates = new Map();
  const deleteIds = new Set();
  const optionalUpdates = new Map();
  const reasonCounts = {};
  const unresolved = [];

  function addUpdate(row, patch, reason) {
    const current = updates.get(row.id)?.row || row;
    const next = applyPatch(current, patch, reason, now);
    updates.set(row.id, {
      reasons: [...new Set([...(updates.get(row.id)?.reasons || []), reason])],
      row: next,
    });
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }

  function addOptionalUpdate(record, patch, reason) {
    const current = optionalUpdates.get(record.id)?.row || record;
    const payload = {
      ...current.payload,
      ...patch,
      governanceReasons: [...new Set([...(Array.isArray(current.payload?.governanceReasons) ? current.payload.governanceReasons : []), reason])],
      updatedAt: now,
    };
    optionalUpdates.set(record.id, {
      reasons: [...new Set([...(optionalUpdates.get(record.id)?.reasons || []), reason])],
      row: {
        ...current,
        productName: payload.productName || current.productName,
        liability: payload.liability || current.liability,
        payload,
      },
    });
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }

  for (const row of indicators) {
    if (isOptionalSectionSummary(row)) {
      deleteIds.add(row.id);
      reasonCounts.delete_optional_section_summary = (reasonCounts.delete_optional_section_summary || 0) + 1;
      continue;
    }

    if (rowLiability(row) === '赔付方式' && row.payload?.excludeFromCalculation !== true) {
      addUpdate(row, nonCalculableRulePatch(row, now), 'mark_payout_method_non_calculable');
    }

    const multiProductName = resolveMultiProductName(row);
    const cleanedProductName = multiProductName || cleanDocumentProductName(row.productName || row.payload?.productName);
    if (cleanedProductName && cleanedProductName !== row.productName) {
      addUpdate(row, {
        productName: cleanedProductName,
        originalProductName: row.payload?.originalProductName || row.productName,
      }, multiProductName ? 'split_multi_product_name' : 'clean_document_product_title');
    }

    const accidentCorrection = inferAccidentDisabilityCorrection(row);
    if (accidentCorrection) addUpdate(row, accidentCorrection, 'reclassify_non_accident_disability');

    const cancerCorrection = inferCancerCorrection(row);
    if (cancerCorrection) addUpdate(row, cancerCorrection, 'relabel_non_cancer_disease_indicator');

    const branchCorrection = inferCombinedBranchCorrection(row);
    if (branchCorrection) addUpdate(row, branchCorrection, 'align_combined_branch_label_to_excerpt');

    const maturityCorrection = inferMaturityCorrection(row);
    if (maturityCorrection) addUpdate(row, maturityCorrection, 'relabel_non_maturity_cashflow');

    const zeroMultiple = inferZeroMultiple(row);
    if (zeroMultiple) {
      addUpdate(row, {
        ...zeroMultiple,
        originalValue: row.payload?.originalValue ?? rowValue(row),
        originalUnit: row.payload?.originalUnit || rowUnit(row),
      }, 'repair_zero_multiple_from_chinese_text');
    }

    const percent = inferSuspiciousPercent(row);
    if (percent) {
      addUpdate(row, {
        value: percent.value,
        unit: percent.unit,
        basis: percent.basis,
        formulaText: percent.formulaText,
        originalValue: row.payload?.originalValue ?? rowValue(row),
        originalUnit: row.payload?.originalUnit || rowUnit(row),
      }, percent.conversion === 'percent_to_multiple' ? 'convert_high_percent_to_multiple' : 'repair_concatenated_percent');
    } else if (Number(rowValue(row)) > 1000 && rowUnit(row) === '%') {
      unresolved.push({ id: row.id, reason: 'high_percent_needs_review', value: rowValue(row) });
    }

    const formulaText = inferFormulaText(row);
    if (formulaText) addUpdate(row, { formulaText }, 'fill_formula_text_from_excerpt');

    if (isClearWaitingRefund(row) && row.payload?.qualityStatus !== 'reclassified_waiting_period_refund') {
      addUpdate(row, waitingRefundPatch(row, now), 'reclassify_remaining_waiting_refund');
    }

    const cleanedFormula = cleanFormulaDisplayText(row.payload?.formulaText);
    if (cleanedFormula && cleanedFormula !== trim(row.payload?.formulaText)) {
      addUpdate(row, { formulaText: cleanedFormula }, 'remove_display_text_from_formula');
    }

    const cleanedBasis = cleanLeadingDe(row.payload?.basis);
    const cleanedFormulaLeading = cleanLeadingDe(row.payload?.formulaText);
    if ((cleanedBasis && cleanedBasis !== trim(row.payload?.basis)) || (cleanedFormulaLeading && cleanedFormulaLeading !== trim(row.payload?.formulaText))) {
      addUpdate(row, {
        basis: cleanedBasis || row.payload?.basis,
        formulaText: cleanedFormulaLeading || row.payload?.formulaText,
      }, 'remove_leading_de_from_basis_formula');
    }
  }

  const optionalIndicators = indicators.filter((row) => row.payload?.responsibilityScope === 'optional' && !deleteIds.has(row.id));
  const referencedIds = new Set();
  for (const record of optionalRecords) {
    for (const id of Array.isArray(record.payload?.indicatorIds) ? record.payload.indicatorIds : []) {
      referencedIds.add(trim(id));
    }
  }
  const optionalById = new Map(optionalRecords.map((row) => [row.id, row]));
  const groups = new Map();
  for (const row of optionalIndicators) {
    const key = optionalLogicalKey(row);
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    if (list.length <= 1) continue;
    const ranked = [...list].sort((left, right) => {
      const score = (row) =>
        (referencedIds.has(row.id) ? 20 : 0)
        + (/我们除按|本合同可选责任|包含/u.test(rowLiability(row)) ? -10 : 0)
        + (String(row.payload?.sourceTitle || '').includes('条款') ? 3 : 0);
      return score(right) - score(left);
    });
    const keep = ranked[0];
    for (const duplicate of ranked.slice(1)) {
      deleteIds.add(duplicate.id);
      reasonCounts.delete_optional_duplicate = (reasonCounts.delete_optional_duplicate || 0) + 1;
    }
    const target = optionalById.get(keep.payload?.optionalResponsibilityId);
    if (target && !referencedIds.has(keep.id)) {
      const currentTarget = optionalUpdates.get(target.id)?.row || target;
      const ids = [...new Set([...(Array.isArray(currentTarget.payload?.indicatorIds) ? currentTarget.payload.indicatorIds : []), keep.id])];
      addOptionalUpdate(currentTarget, {
        indicatorIds: ids,
        quantificationStatus: 'quantified',
        quantificationReason: '',
      }, 'link_unreferenced_optional_indicator');
      referencedIds.add(keep.id);
    }
  }

  for (const row of optionalIndicators) {
    if (deleteIds.has(row.id) || referencedIds.has(row.id)) continue;
    const target = optionalById.get(row.payload?.optionalResponsibilityId);
    if (!target) {
      unresolved.push({ id: row.id, reason: 'optional_record_not_found' });
      continue;
    }
    const currentTarget = optionalUpdates.get(target.id)?.row || target;
    const ids = [...new Set([...(Array.isArray(currentTarget.payload?.indicatorIds) ? currentTarget.payload.indicatorIds : []), row.id])];
    addOptionalUpdate(currentTarget, {
      indicatorIds: ids,
      quantificationStatus: 'quantified',
      quantificationReason: '',
    }, 'link_unreferenced_optional_indicator');
    referencedIds.add(row.id);
  }

  if (deleteIds.size) {
    for (const record of optionalRecords) {
      const current = optionalUpdates.get(record.id)?.row || record;
      const currentIds = Array.isArray(current.payload?.indicatorIds) ? current.payload.indicatorIds : [];
      const ids = currentIds.filter((id) => !deleteIds.has(trim(id)));
      if (ids.length !== currentIds.length) {
        addOptionalUpdate(current, {
          indicatorIds: ids,
          quantificationStatus: ids.length ? current.payload?.quantificationStatus || 'quantified' : 'pending_review',
          quantificationReason: ids.length ? current.payload?.quantificationReason || '' : '结构化指标已治理为重复或段落摘要，需重新量化',
        }, 'remove_deleted_optional_indicator_reference');
      }
    }
  }

  return {
    summary: {
      indicatorUpdates: updates.size,
      indicatorDeletes: deleteIds.size,
      optionalRecordUpdates: optionalUpdates.size,
      reasonCounts,
      unresolved: unresolved.length,
      unresolvedSample: unresolved.slice(0, 20),
    },
    indicatorUpdates: [...updates.values()],
    indicatorDeletes: [...deleteIds],
    optionalRecordUpdates: [...optionalUpdates.values()],
  };
}

function loadRows(db) {
  return {
    indicatorRows: db.prepare('SELECT id, company, product_name, coverage_type, liability, payload FROM insurance_indicator_records').all(),
    optionalRows: db.prepare('SELECT id, company, product_name, liability, payload FROM optional_responsibility_records').all(),
  };
}

function applyPlan(db, plan) {
  const updateIndicator = db.prepare(`
    UPDATE insurance_indicator_records
       SET company = ?, product_name = ?, coverage_type = ?, liability = ?, payload = ?
     WHERE id = ?
  `);
  const deleteIndicator = db.prepare('DELETE FROM insurance_indicator_records WHERE id = ?');
  const updateOptional = db.prepare(`
    UPDATE optional_responsibility_records
       SET company = ?, product_name = ?, liability = ?, payload = ?
     WHERE id = ?
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { row } of plan.indicatorUpdates) {
      updateIndicator.run(row.company, row.productName, row.coverageType, row.liability, JSON.stringify(row.payload), row.id);
    }
    for (const id of plan.indicatorDeletes) {
      deleteIndicator.run(id);
    }
    for (const { row } of plan.optionalRecordUpdates) {
      updateOptional.run(row.company, row.productName, row.liability, JSON.stringify(row.payload), row.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function repairRemainingIndicatorGovernance({ dbPath = DEFAULT_DB_PATH, dryRun = false } = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    const plan = buildRemainingIndicatorGovernancePlan(loadRows(db));
    if (!dryRun) applyPlan(db, plan);
    return {
      dbPath,
      dryRun,
      summary: plan.summary,
      sample: {
        indicatorUpdates: plan.indicatorUpdates.slice(0, 10).map((item) => ({
          reasons: item.reasons,
          id: item.row.id,
          productName: item.row.productName,
          coverageType: item.row.coverageType,
          liability: item.row.liability,
          value: item.row.payload.value,
          unit: item.row.payload.unit,
        })),
        indicatorDeletes: plan.indicatorDeletes.slice(0, 10),
        optionalRecordUpdates: plan.optionalRecordUpdates.slice(0, 10).map((item) => ({
          reasons: item.reasons,
          id: item.row.id,
          productName: item.row.productName,
          liability: item.row.liability,
          indicatorIds: item.row.payload.indicatorIds,
        })),
      },
    };
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = path.resolve(readArg('db-path', DEFAULT_DB_PATH));
  const dryRun = hasFlag('dry-run');
  const result = repairRemainingIndicatorGovernance({ dbPath, dryRun });
  console.log(JSON.stringify(result, null, 2));
}
