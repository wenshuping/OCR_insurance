import { clusterBoxesIntoRows, normalizeOcrBoxes, rowText } from './policy-layout-boxes.mjs';

function compactText(value) {
  return String(value || '').replace(/\s+/gu, '');
}

function isBenefitHeader(text) {
  if (/保险利益表/u.test(text)) return true;
  return /险种名称|产品名称/u.test(text)
    && /基本保险金额|保险金额|保险期间|交费方式|缴费方式|交费期间|缴费期间|保险费/u.test(text);
}

function isFooter(text) {
  return /特别约定|保险单说明|保单制作日期|保险公司签章|业务员|第\d+页共\d+页/u.test(text);
}

function isRider(text) {
  return /附加|附加险|附加责任|附加医疗|附加意外/u.test(text);
}

function pushMany(target, row) {
  target.push(...(row?.items || []));
}

export function classifyPolicyLayoutRegions(rawBoxes = [], options = {}) {
  const boxes = normalizeOcrBoxes(rawBoxes);
  const rows = clusterBoxesIntoRows(boxes, { yThreshold: options.yThreshold || 14 });
  const regions = {
    header: [],
    basicInfo: [],
    benefitTable: [],
    riderTable: [],
    footer: [],
  };
  let mode = 'header';
  let seenBasicInfo = false;

  for (const row of rows) {
    const text = compactText(rowText(row));
    if (!text) continue;
    if (isFooter(text)) {
      mode = 'footer';
      pushMany(regions.footer, row);
      continue;
    }
    if (isBenefitHeader(text)) {
      mode = 'benefitTable';
      pushMany(regions.benefitTable, row);
      continue;
    }
    if (mode === 'benefitTable' && isRider(text)) {
      pushMany(regions.riderTable, row);
      continue;
    }
    if (/产品名称|投保人|设保人|被保险[人入]|披保险人|保险合同号|保单号|合同号|合同生效日期|生效日期|证件号码|身份证|受益人/u.test(text)) {
      seenBasicInfo = true;
      if (mode !== 'benefitTable' && mode !== 'footer') mode = 'basicInfo';
    }
    if (mode === 'header' && seenBasicInfo) mode = 'basicInfo';
    pushMany(regions[mode] || regions.basicInfo, row);
  }

  return {
    boxes,
    rows,
    regions,
    regionWarnings: boxes.length ? [] : ['OCR 未返回可用于版面分析的坐标'],
  };
}
