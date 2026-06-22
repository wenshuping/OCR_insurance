function normalizeText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, '').trim();
}

function displayText(value) {
  return String(value || '').normalize('NFKC').trim();
}

function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function indicatorCoreText(indicator = {}) {
  return [
    indicator.coverageType,
    indicator.liability,
    indicator.formulaText,
    indicator.basis,
    indicator.unit,
    indicator.valueText,
    indicator.condition,
    indicator.sourceExcerpt,
  ].filter(Boolean).join(' ');
}

function numericSpec(indicator = {}) {
  const value = finiteNumber(indicator.value);
  const unit = displayText(indicator.unit);
  if (value !== null && unit) return { value, unit };

  const text = displayText([
    indicator.formulaText,
    indicator.valueText,
    indicator.sourceExcerpt,
  ].filter(Boolean).join(' '));
  const factor = text.match(/[×xX*]\s*(\d+(?:\.\d+)?)\s*(%|％|倍)/u)
    || text.match(/(?:基本保险金额|基本保额|保险金额|有效保险金额|保险费|保费)[^。；;，,]{0,24}?(\d+(?:\.\d+)?)\s*(%|％|倍)/u);
  if (factor) return { value: Number(factor[1]), unit: factor[2] === '％' ? '%' : factor[2] };

  const amount = text.match(/(\d+(?:\.\d+)?)\s*(万)?\s*(元|圆)/u);
  if (amount) {
    const multiplier = amount[2] ? 10000 : 1;
    return { value: Number(amount[1]) * multiplier, unit: '元' };
  }
  return { value: null, unit };
}

export function normalizeIndicatorCalculation(indicator = {}) {
  const basis = normalizeText(indicator.basis);
  const formulaText = normalizeText(indicator.formulaText);
  const formulaSignalText = formulaText.replace(/现金价值不展示|现金价值不统计|现金价值不参与展示/gu, '');
  const text = normalizeText(indicatorCoreText(indicator));
  const coverageType = displayText(indicator.coverageType);
  const liability = displayText(indicator.liability);
  const hasGeneratedCalculationMetadata = Boolean(displayText(indicator.calculationMetadataVersion));
  const explicitlyMarkedNotCalculable = indicator.calculationEligible === false && !hasGeneratedCalculationMetadata;
  const statusText = normalizeText([
    indicator.quantificationStatus,
    indicator.qualityStatus,
    indicator.responsibilityScope,
  ].filter(Boolean).join(' '));
  const { value, unit } = numericSpec(indicator);

  if (
    indicator.excludeFromCalculation === true
    || explicitlyMarkedNotCalculable
    || coverageType === '规则参数'
    || /rule_parameter|not_quantifiable|non_calculable|unquantifiable/u.test(statusText)
    || /^(等待期|赔付方式|领取起始年龄|开始领取年龄|领取年龄|缴费年期)$/u.test(liability)
    || /保险责任赔付机制/u.test(text)
    || /豁免后续应交保险费|后续应交保险费|后续保险费/u.test(text)
  ) {
    return {
      basisKey: 'rule_parameter',
      calculationKey: 'not_calculable',
      calculationEligible: false,
      calculationReason: '规则参数或不可量化责任，不进入金额计算',
      value,
      unit,
    };
  }

  let basisKey = '';
  if (/现金价值|现价/u.test(formulaSignalText)) {
    basisKey = 'cash_value';
  } else if (/账户价值|账户余额|个人账户|公共账户/u.test(formulaSignalText)) {
    basisKey = 'account_value';
  } else if (/首次.{0,20}(?:保险费|保费)|首期.{0,20}(?:保险费|保费)|首年.{0,20}(?:保险费|保费)/u.test(formulaSignalText)) {
    basisKey = /基本责任/u.test(formulaSignalText) ? 'first_basic_responsibility_premium' : 'first_premium';
  } else if (/已交|已支付|所交|实际交纳|累计.{0,8}(?:保险费|保费)|(?:保险费|保费)之和/u.test(formulaSignalText)) {
    basisKey = 'total_paid_premium';
  } else if (/基本责任保险金额|基本保险金额|基本保额|有效保险金额|保险金额|保额/u.test(formulaSignalText)) {
    basisKey = 'basic_amount';
  } else if (/条款载明|保险单载明|保单载明|约定领取比例|领取计划|领取频率|领取金额|给付比例|赔付比例|比例表|领取年龄/u.test(formulaSignalText || basis)) {
    basisKey = 'schedule_or_policy_table';
  } else if (/首次.{0,20}(?:保险费|保费)|首期.{0,20}(?:保险费|保费)|首年.{0,20}(?:保险费|保费)/u.test(text)) {
    basisKey = /基本责任/u.test(text) ? 'first_basic_responsibility_premium' : 'first_premium';
  } else if (/年交保费|年缴保费|年度保险费|每年.{0,10}(?:保险费|保费)/u.test(text)) {
    basisKey = 'annual_premium';
  } else if (/已交|已支付|所交|实际交纳|累计.{0,8}(?:保险费|保费)|(?:保险费|保费)之和/u.test(text)) {
    basisKey = 'total_paid_premium';
  } else if (/现金价值|现价/u.test(text)) {
    basisKey = 'cash_value';
  } else if (/账户价值|账户余额|个人账户|公共账户/u.test(text)) {
    basisKey = 'account_value';
  } else if (/基本责任保险金额|基本保险金额|基本保额|有效保险金额|保险金额|保额/u.test(basis || formulaText)) {
    basisKey = 'basic_amount';
  } else if (/条款载明|约定领取比例|领取计划|领取频率|领取金额|给付比例|赔付比例|比例表|领取年龄/u.test(text)) {
    basisKey = 'schedule_or_policy_table';
  } else if (/医疗费用|实际合理医疗费用|免赔额|报销|补偿/u.test(text)) {
    basisKey = 'medical_expense';
  } else if (/给付天数|日津贴额|住院日额|保险单位数/u.test(text)) {
    basisKey = 'daily_allowance';
  }

  const normalizedUnit = unit === '％' ? '%' : unit;
  let calculationKey = '';
  let calculationEligible = true;
  let calculationReason = '';

  if (value !== null && /^(?:元|圆)$/u.test(normalizedUnit)) {
    calculationKey = 'fixed_amount';
  } else if (/(?:max|较大者|较高者|最大者|取大|两者|三者)/iu.test(formulaSignalText || text)) {
    calculationKey = 'manual_formula';
    calculationEligible = false;
    calculationReason = '包含较大者/多基准比较，需要现金价值或条款表后才能计算';
  } else if (basisKey === 'cash_value' || basisKey === 'account_value') {
    calculationKey = basisKey;
    calculationEligible = false;
    calculationReason = '依赖现金价值或账户价值，不能只靠指标和保单基础字段计算';
  } else if (basisKey === 'schedule_or_policy_table') {
    calculationKey = 'schedule_or_policy_table';
    calculationEligible = false;
    calculationReason = '依赖领取计划、比例表或保单载明金额';
  } else if (basisKey === 'medical_expense') {
    calculationKey = 'medical_formula';
    calculationEligible = false;
    calculationReason = '医疗费用型责任依赖实际费用、免赔额和补偿数据';
  } else if (basisKey === 'daily_allowance') {
    calculationKey = 'daily_allowance';
    calculationEligible = false;
    calculationReason = '津贴型责任依赖实际天数或保险单位数';
  } else if (basisKey === 'basic_amount' && value !== null && normalizedUnit === '%') {
    calculationKey = 'percent_of_basic_amount';
  } else if (basisKey === 'basic_amount' && value !== null && normalizedUnit === '倍') {
    calculationKey = 'multiple_of_basic_amount';
  } else if (basisKey === 'basic_amount' && /公式|^$/u.test(normalizedUnit || '') && /基本保险金额|基本保额|保险金额/u.test(text)) {
    calculationKey = 'basic_amount';
  } else if ((basisKey === 'first_premium' || basisKey === 'first_basic_responsibility_premium' || basisKey === 'annual_premium') && value !== null && normalizedUnit === '%') {
    calculationKey = 'percent_of_first_premium';
  } else if ((basisKey === 'first_premium' || basisKey === 'first_basic_responsibility_premium' || basisKey === 'annual_premium') && value !== null && normalizedUnit === '倍') {
    calculationKey = 'multiple_of_first_premium';
  } else if (basisKey === 'first_premium' || basisKey === 'first_basic_responsibility_premium' || basisKey === 'annual_premium') {
    calculationKey = 'first_premium';
  } else if (basisKey === 'total_paid_premium' && value !== null && normalizedUnit === '%') {
    calculationKey = 'percent_of_total_paid_premium';
  } else if (basisKey === 'total_paid_premium' && value !== null && normalizedUnit === '倍') {
    calculationKey = 'multiple_of_total_paid_premium';
  } else if (basisKey === 'total_paid_premium') {
    calculationKey = 'total_paid_premium';
  } else {
    calculationKey = 'unknown';
    calculationEligible = false;
    calculationReason = '未识别到可计算基准';
  }

  return {
    basisKey: basisKey || 'unknown',
    calculationKey,
    calculationEligible,
    calculationReason,
    value,
    unit: normalizedUnit,
  };
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function formatMoney(value) {
  return roundMoney(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

export function resolveIndicatorAmountFromCalculation(indicator = {}, inputs = {}) {
  const meta = normalizeIndicatorCalculation(indicator);
  if (!meta.calculationEligible) return { resolved: false, amount: 0, meta, calculationText: meta.calculationReason };

  const baseAmount = Number(inputs.baseAmount || 0) || 0;
  const firstPremium = Number(inputs.firstPremium || 0) || 0;
  const paymentYears = Number(inputs.paymentYears || 0) > 0 ? Number(inputs.paymentYears) : 1;
  const totalPremium = firstPremium * paymentYears;
  const value = Number(meta.value || 0);

  let amount = 0;
  let calculationText = '';
  switch (meta.calculationKey) {
    case 'fixed_amount':
      amount = value;
      calculationText = `固定金额 = ${formatMoney(amount)}元`;
      break;
    case 'basic_amount':
      amount = baseAmount;
      calculationText = `基本保险金额${formatMoney(baseAmount)}元`;
      break;
    case 'percent_of_basic_amount':
      amount = baseAmount * value / 100;
      calculationText = `基本保险金额${formatMoney(baseAmount)}元 × ${value}% = ${formatMoney(amount)}元`;
      break;
    case 'multiple_of_basic_amount':
      amount = baseAmount * value;
      calculationText = `基本保险金额${formatMoney(baseAmount)}元 × ${value}倍 = ${formatMoney(amount)}元`;
      break;
    case 'first_premium':
      amount = firstPremium;
      calculationText = `首期/首年保费 = ${formatMoney(amount)}元`;
      break;
    case 'percent_of_first_premium':
      amount = firstPremium * value / 100;
      calculationText = `首期/首年保费${formatMoney(firstPremium)}元 × ${value}% = ${formatMoney(amount)}元`;
      break;
    case 'multiple_of_first_premium':
      amount = firstPremium * value;
      calculationText = `首期/首年保费${formatMoney(firstPremium)}元 × ${value}倍 = ${formatMoney(amount)}元`;
      break;
    case 'total_paid_premium':
      amount = totalPremium;
      calculationText = `年交保费${formatMoney(firstPremium)}元 × 缴费年期${paymentYears} = ${formatMoney(amount)}元`;
      break;
    case 'percent_of_total_paid_premium':
      amount = totalPremium * value / 100;
      calculationText = `累计已交保费${formatMoney(totalPremium)}元 × ${value}% = ${formatMoney(amount)}元`;
      break;
    case 'multiple_of_total_paid_premium':
      amount = totalPremium * value;
      calculationText = `累计已交保费${formatMoney(totalPremium)}元 × ${value}倍 = ${formatMoney(amount)}元`;
      break;
    default:
      return { resolved: false, amount: 0, meta, calculationText: meta.calculationReason || '未识别到可计算基准' };
  }

  amount = roundMoney(amount);
  if (amount <= 0) return { resolved: false, amount: 0, meta, calculationText };
  return { resolved: true, amount, meta, calculationText };
}

export function indicatorCalculationPayloadFields(indicator = {}) {
  const meta = normalizeIndicatorCalculation(indicator);
  return {
    basisKey: meta.basisKey,
    calculationKey: meta.calculationKey,
    calculationEligible: meta.calculationEligible,
    calculationReason: meta.calculationReason,
  };
}
