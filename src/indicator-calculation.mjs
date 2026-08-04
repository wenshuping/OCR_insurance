function normalizeText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, '').trim();
}

function displayText(value) {
  return String(value || '').normalize('NFKC').trim();
}

export function hasQuantifiedCalculationSignal(value) {
  const text = displayText(value);
  if (!text) return false;
  return /(?:基本责任保险金额|基本保险金额|基本保险金|基本保额|有效保险金额|保险金额|保额|首期保费|首年保费|年交保费|已交保费|所交保费|保险费|保费|现金价值|账户价值|实际医疗费用|医疗费用|免赔额|给付比例|赔付比例|赔偿比例|伤残程度|伤残等级|给付天数|住院天数|日津贴额|住院日额|限额|\d+(?:\.\d+)?\s*(?:%|％|倍|元|圆|万元|天|日))/u.test(text);
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

function isExpenseReimbursementText(value = '') {
  return /医疗费用|实际合理医疗费用|实际合理[^。；;，,]{0,20}费用|实际[^。；;，,]{0,20}费用|免赔额|报销|补偿/u.test(value);
}

function isPolicyAnniversaryBasicAmount(value = '') {
  return /保单生效对应日(?:的)?基本责任(?:的)?保险金额/u.test(normalizeText(value));
}

function requiresClaimEventFacts(indicator = {}) {
  const liability = normalizeText(indicator.liability || indicator.coverageType);
  if (!/(?:身故|死亡|全残|伤残|残疾|重疾|重大疾病)/u.test(liability)) return false;
  const text = normalizeText(indicatorCoreText(indicator));
  return /(?:因疾病|因意外(?:伤害)?|出险原因|出险日期|事故原因|事故日期|合同生效(?:或复效)?之日起.{0,8}(?:年内|年后)|复效.{0,12}(?:年内|年后))/u.test(text);
}

const MODEL_CALCULATION_PAIRS = new Set([
  'basic_amount:basic_amount',
  'basic_amount:percent_of_basic_amount',
  'basic_amount:multiple_of_basic_amount',
  'first_premium:first_premium',
  'first_premium:percent_of_first_premium',
  'first_premium:multiple_of_first_premium',
  'first_basic_responsibility_premium:first_premium',
  'first_basic_responsibility_premium:percent_of_first_premium',
  'first_basic_responsibility_premium:multiple_of_first_premium',
  'annual_premium:first_premium',
  'annual_premium:percent_of_first_premium',
  'annual_premium:multiple_of_first_premium',
  'total_paid_premium:total_paid_premium',
  'total_paid_premium:percent_of_total_paid_premium',
  'total_paid_premium:multiple_of_total_paid_premium',
  'unknown:fixed_amount',
]);

export const CALCULATION_INPUT_SCHEMA_VERSION = '2026-07-03-canonical-calculation-inputs';

export function requiredCalculationInputsForMeta(meta = {}) {
  const calculationKey = displayText(meta.calculationKey);
  const basisKey = displayText(meta.basisKey);
  if (calculationKey === 'claim_event_facts') return ['eventCause', 'eventDate'];
  if (calculationKey === 'scheduled_branch_scenarios') return ['policy.amount', 'policyYearOrAge'];
  if (calculationKey === 'fixed_amount') return [];
  if (['basic_amount', 'percent_of_basic_amount', 'multiple_of_basic_amount'].includes(calculationKey) || basisKey === 'basic_amount') {
    return ['policy.amount'];
  }
  if (basisKey === 'effective_insured_amount') return ['effectiveInsuranceAmount', 'policyYearOrAge'];
  if (
    ['first_premium', 'percent_of_first_premium', 'multiple_of_first_premium'].includes(calculationKey) ||
    ['first_premium', 'first_basic_responsibility_premium', 'annual_premium'].includes(basisKey)
  ) {
    return ['policy.firstPremium'];
  }
  if (['total_paid_premium', 'percent_of_total_paid_premium', 'multiple_of_total_paid_premium'].includes(calculationKey) || basisKey === 'total_paid_premium') {
    return ['policy.firstPremium', 'policy.paymentPeriodYears'];
  }
  if (calculationKey === 'cash_value' || basisKey === 'cash_value') return ['cashValue', 'policyYear'];
  if (calculationKey === 'account_value' || basisKey === 'account_value') return ['accountValue'];
  if (calculationKey === 'schedule_or_policy_table' || basisKey === 'schedule_or_policy_table') {
    return ['policyScheduleTable', 'policyYearOrAge'];
  }
  if (calculationKey === 'medical_formula' || basisKey === 'medical_expense') {
    return ['actualMedicalExpense', 'deductible', 'reimbursementRate', 'thirdPartyPaid', 'liabilityLimit'];
  }
  if (calculationKey === 'daily_allowance' || basisKey === 'daily_allowance') return ['actualDays', 'dailyAmount', 'dayLimit'];
  if (calculationKey === 'manual_formula') return ['manualFormulaInputs'];
  return [];
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
  const ratioValues = new Set(
    [...text.matchAll(/(\d+(?:\.\d+)?)\s*(%|％|倍)/gu)]
      .map((match) => `${Number(match[1])}:${match[2] === '％' ? '%' : match[2]}`),
  );
  if (ratioValues.size > 1) return { value: null, unit };
  const factor = text.match(/[×xX*]\s*(\d+(?:\.\d+)?)\s*(%|％|倍)/u)
    || text.match(/(?:基本保险金额|基本保险金|基本保额|保险金额|有效保险金额|保险费|保费)[^。；;，,]{0,24}?(\d+(?:\.\d+)?)\s*(%|％|倍)/u)
    || text.match(/(\d+(?:\.\d+)?)\s*(%|％|倍)[^。；;，,]{0,12}?(?:基本保险金额|基本保险金|基本保额|保险金额|有效保险金额|保险费|保费)/u);
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
  const hasStructuredCalculationMetadata = Boolean(displayText(indicator.basisKey) || displayText(indicator.calculationKey));
  const explicitlyMarkedNotCalculable = indicator.calculationEligible === false
    && !hasGeneratedCalculationMetadata
    && !hasStructuredCalculationMetadata;
  const statusText = normalizeText([
    indicator.quantificationStatus,
    indicator.qualityStatus,
    indicator.responsibilityScope,
  ].filter(Boolean).join(' '));
  const { value, unit } = numericSpec(indicator);
  const hasStructuredEventBranches = Array.isArray(indicator.branches)
    && indicator.branches.length > 0
    && indicator.branches.every((branch) => displayText(branch?.normalizedFormula || branch?.formulaText));
  const hasStructuredScheduledBranches = hasStructuredEventBranches
    && /生存保险金|生存金|生存|年金|养老金|教育金|深造金|婚嫁金|祝寿金|满期/u.test(liability)
    && indicator.branches.every((branch) => (
      /周岁|保单生效对应日|合同生效满|保险期间届满/u.test(displayText([
        branch?.conditionText,
        branch?.condition,
      ].filter(Boolean).join(' ')))
      && !/(?:身故|死亡|全残|伤残|疾病|意外|出险|事故)/u.test(displayText([
        branch?.conditionText,
        branch?.condition,
      ].filter(Boolean).join(' ')))
    ));

  if (requiresClaimEventFacts(indicator)) {
    return {
      basisKey: 'claim_event_facts',
      calculationKey: 'claim_event_facts',
      calculationEligible: false,
      calculationReason: '需补充出险原因和出险日期后选择条款给付分支，暂不计算',
      decisionSource: 'code_safety_rule',
      value,
      unit: '公式',
    };
  }

  if (hasStructuredScheduledBranches) {
    return {
      basisKey: 'policy_anniversary_schedule',
      calculationKey: 'scheduled_branch_scenarios',
      calculationEligible: false,
      calculationReason: '按年龄或保单周年阶段分别测算',
      decisionSource: 'official_scheduled_benefit_branches',
      value,
      unit: '公式',
    };
  }

  if (hasStructuredEventBranches) {
    return {
      basisKey: 'event_condition',
      calculationKey: 'claim_event_facts',
      calculationEligible: false,
      calculationReason: '需补充出险原因和出险日期后选择条款给付分支，暂不计算',
      decisionSource: 'official_clause_branch_repair',
      value,
      unit: '公式',
    };
  }

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
      decisionSource: 'code_safety_rule',
      value,
      unit,
    };
  }

  let basisKey = '';
  if (isPolicyAnniversaryBasicAmount(formulaSignalText)) {
    basisKey = 'policy_anniversary_basic_amount';
  } else if (/现金价值|现价/u.test(formulaSignalText)) {
    basisKey = 'cash_value';
  } else if (/账户价值|账户余额|个人账户|公共账户|账户|帐户/u.test(formulaSignalText)) {
    basisKey = 'account_value';
  } else if (/首次.{0,20}(?:保险费|保费)|首期.{0,20}(?:保险费|保费)|首年.{0,20}(?:保险费|保费)/u.test(formulaSignalText)) {
    basisKey = /基本责任/u.test(formulaSignalText) ? 'first_basic_responsibility_premium' : 'first_premium';
  } else if (/已交|已支付|所交|实际交纳|累计.{0,8}(?:保险费|保费)|(?:保险费|保费)之和/u.test(formulaSignalText)) {
    basisKey = 'total_paid_premium';
  } else if (isExpenseReimbursementText(formulaSignalText)) {
    basisKey = 'medical_expense';
  } else if (/给付天数|给付日数|住院天数|住院日数|实际日数|入住.{0,8}(?:天数|日数)|日津贴额|住院日额|保险单位数/u.test(formulaSignalText)) {
    basisKey = 'daily_allowance';
  } else if (/有效保险金额/u.test(formulaSignalText)) {
    basisKey = 'effective_insured_amount';
  } else if (/基本责任保险金额|基本保险金额|基本保险金|基本保额|保险金额|保额/u.test(formulaSignalText)) {
    basisKey = 'basic_amount';
  } else if (/条款载明|条款表|保险单载明|保单载明|约定领取比例|领取计划|领取频率|领取金额|给付比例|赔付比例|赔偿比例|伤残等级|比例表|领取年龄/u.test(formulaSignalText || basis)) {
    basisKey = 'schedule_or_policy_table';
  } else if (/首次.{0,20}(?:保险费|保费)|首期.{0,20}(?:保险费|保费)|首年.{0,20}(?:保险费|保费)/u.test(text)) {
    basisKey = /基本责任/u.test(text) ? 'first_basic_responsibility_premium' : 'first_premium';
  } else if (/年交保费|年缴保费|年度保险费|每年.{0,10}(?:保险费|保费)/u.test(text)) {
    basisKey = 'annual_premium';
  } else if (/已交|已支付|所交|实际交纳|累计.{0,8}(?:保险费|保费)|(?:保险费|保费)之和/u.test(text)) {
    basisKey = 'total_paid_premium';
  } else if (/现金价值|现价/u.test(text)) {
    basisKey = 'cash_value';
  } else if (/账户价值|账户余额|个人账户|公共账户|账户|帐户/u.test(text)) {
    basisKey = 'account_value';
  } else if (isExpenseReimbursementText(text)) {
    basisKey = 'medical_expense';
  } else if (/给付天数|给付日数|住院天数|住院日数|实际日数|入住.{0,8}(?:天数|日数)|日津贴额|住院日额|保险单位数/u.test(basis || formulaText)) {
    basisKey = 'daily_allowance';
  } else if (isPolicyAnniversaryBasicAmount(basis || formulaText)) {
    basisKey = 'policy_anniversary_basic_amount';
  } else if (/有效保险金额/u.test(basis || formulaText)) {
    basisKey = 'effective_insured_amount';
  } else if (/基本责任保险金额|基本保险金额|基本保险金|基本保额|保险金额|保额/u.test(basis || formulaText)) {
    basisKey = 'basic_amount';
  } else if (/条款载明|条款表|约定领取比例|领取计划|领取频率|领取金额|给付比例|赔付比例|赔偿比例|伤残等级|比例表|领取年龄/u.test(text)) {
    basisKey = 'schedule_or_policy_table';
  } else if (isExpenseReimbursementText(text)) {
    basisKey = 'medical_expense';
  } else if (/给付天数|给付日数|住院天数|住院日数|实际日数|入住.{0,8}(?:天数|日数)|日津贴额|住院日额|保险单位数/u.test(text)) {
    basisKey = 'daily_allowance';
  }

  const normalizedUnit = unit === '％' ? '%' : unit;
  const modelBasisKey = displayText(indicator.basisKey);
  const modelCalculationKey = displayText(indicator.calculationKey);
  const hasStructuredDecision = Boolean(modelCalculationKey)
    && MODEL_CALCULATION_PAIRS.has(`${modelBasisKey || 'unknown'}:${modelCalculationKey}`)
    && (!basisKey || basisKey === modelBasisKey);
  if (hasStructuredDecision && !basisKey) basisKey = modelBasisKey || 'unknown';
  let calculationKey = '';
  let calculationEligible = true;
  let calculationReason = '';
  let decisionSource = hasStructuredDecision
    ? (displayText(indicator.calculationDecisionSource) === 'model_semantic' ? 'model_semantic' : 'structured_semantic')
    : 'code_inference';

  if (/(?:max|较大者|较高者|最大者|取大|两者|三者|条件给付|约定情形)/iu.test(formulaSignalText || text)) {
    calculationKey = 'manual_formula';
    calculationEligible = false;
    calculationReason = /条件给付|约定情形/u.test(formulaSignalText || text)
      ? '包含条件化给付，需要结合事故原因、合同生效时间或条款条件判断'
      : '包含较大者/多基准比较，需要现金价值或条款表后才能计算';
    decisionSource = 'code_safety_rule';
  } else if (basisKey === 'cash_value' || basisKey === 'account_value') {
    calculationKey = basisKey;
    calculationEligible = false;
    calculationReason = '依赖现金价值或账户价值，不能只靠指标和保单基础字段计算';
    decisionSource = 'code_safety_rule';
  } else if (basisKey === 'policy_anniversary_basic_amount') {
    calculationKey = 'schedule_or_policy_table';
    calculationEligible = false;
    calculationReason = '给付基数为对应保单生效日的基本责任保险金额；分红型增额红利会使各年度金额变化，需按该年度保额/红利记录核算';
    decisionSource = 'code_safety_rule';
  } else if (basisKey === 'schedule_or_policy_table') {
    calculationKey = 'schedule_or_policy_table';
    calculationEligible = false;
    calculationReason = '依赖领取计划、比例表或保单载明金额';
    decisionSource = 'code_safety_rule';
  } else if (basisKey === 'medical_expense') {
    calculationKey = 'medical_formula';
    calculationEligible = false;
    calculationReason = '医疗费用型责任依赖实际费用、免赔额和补偿数据';
    decisionSource = 'code_safety_rule';
  } else if (basisKey === 'daily_allowance') {
    calculationKey = 'daily_allowance';
    calculationEligible = false;
    calculationReason = '津贴型责任依赖实际天数或保险单位数';
    decisionSource = 'code_safety_rule';
  } else if (hasStructuredDecision) {
    calculationKey = modelCalculationKey;
    calculationEligible = indicator.calculationEligible !== false;
    calculationReason = calculationEligible ? '' : (displayText(indicator.calculationReason) || '模型判断当前信息不足，暂不计算');
  } else if (value !== null && /^(?:元|圆)$/u.test(normalizedUnit)) {
    calculationKey = 'fixed_amount';
  } else if (basisKey === 'basic_amount' && value !== null && normalizedUnit === '%') {
    calculationKey = 'percent_of_basic_amount';
  } else if (basisKey === 'basic_amount' && value !== null && normalizedUnit === '倍') {
    calculationKey = 'multiple_of_basic_amount';
  } else if (basisKey === 'basic_amount' && /公式|^$/u.test(normalizedUnit || '') && /基本保险金额|基本保险金|基本保额|保险金额/u.test(text)) {
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
    decisionSource,
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

const FORMULA_VARIABLE_LABELS = {
  basic_amount: '基本保险金额',
  basic_insured_amount: '基本保险金额',
  basic_insurance_amount: '基本保险金额',
  basic_sum_assured: '基本责任保险金额',
  basic_responsibility_insured_amount: '基本责任保险金额',
  initial_basic_insured_amount: '初始基本保险金额',
  effective_insured_amount: '有效保险金额',
  accumulated_dividend_insured_amount: '累计红利保险金额',
  accumulated_dividend_amount: '累计红利保险金额',
  first_premium: '首期保费',
  annual_premium: '年交保费',
  paid_premium: '已交保费',
  total_paid_premium: '累计已交保费',
  payment_years: '缴费年期',
  policy_year: '保单年度',
  cash_value: '现金价值',
  account_value: '账户价值',
  paid_benefit_amount: '已给付保险金',
  disability_payout_ratio: '伤残等级给付比例',
  payout_ratio: '给付比例',
  actual_medical_expense: '实际医疗费用',
  deductible: '免赔额',
  third_party_paid_amount: '其他途径已补偿金额',
  remaining_liability_limit: '剩余责任限额',
};

function formulaNumber(value) {
  const number = finiteNumber(value);
  return number === null ? null : number;
}

function formulaValueForVariable(name, inputs = {}) {
  const values = inputs.formulaVariables && typeof inputs.formulaVariables === 'object'
    ? inputs.formulaVariables
    : {};
  if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];

  if (['basic_amount', 'basic_insured_amount', 'basic_insurance_amount', 'basic_sum_assured', 'basic_responsibility_insured_amount', 'initial_basic_insured_amount'].includes(name)) return inputs.baseAmount;
  if (['first_premium', 'annual_premium'].includes(name)) return inputs.firstPremium;
  if (['total_paid_premium', 'paid_premium'].includes(name)) {
    const premium = formulaNumber(inputs.firstPremium);
    const years = formulaNumber(inputs.paymentYears);
    return premium !== null && years !== null ? premium * years : undefined;
  }
  if (name === 'payment_years') return inputs.paymentYears;
  if (name === 'policy_year' || name === 'n') return inputs.policyYear;
  return undefined;
}

function formulaLabel(name) {
  return FORMULA_VARIABLE_LABELS[name] || name.replace(/_/gu, ' ');
}

export function formulaVariablesFromIndicators(indicators = []) {
  const variables = {};
  for (const indicator of (Array.isArray(indicators) ? indicators : [])) {
    const source = displayText(indicator?.normalizedFormula);
    const match = source.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/u);
    if (!match || /(?:\bmax\b|\bmin\b|\bif\b|[,;])/iu.test(match[2])) continue;
    variables[match[1]] = match[2];
  }
  return variables;
}

function expandFormulaVariables(expression, inputs = {}, depth = 0) {
  if (depth > 6) return expression;
  return String(expression || '').replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/gu, (token, name) => {
    if (name === 'sqrt') return name;
    const value = formulaValueForVariable(name, inputs);
    const numeric = formulaNumber(value);
    if (numeric !== null) return String(numeric);
    if (typeof value === 'string' && value.trim()) {
      return `(${expandFormulaVariables(value, inputs, depth + 1)})`;
    }
    return name;
  });
}

function tokenizeFormula(expression) {
  const compact = String(expression || '')
    .normalize('NFKC')
    .replace(/[×xX*]/gu, '*')
    .replace(/[÷]/gu, '/')
    .replace(/[＋]/gu, '+')
    .replace(/[－]/gu, '-')
    .replace(/\s+/gu, '');
  const tokens = [];
  let index = 0;
  while (index < compact.length) {
    const rest = compact.slice(index);
    const number = rest.match(/^(?:\d+(?:\.\d+)?|\.\d+)/u);
    if (number) {
      tokens.push({ type: 'number', value: Number(number[0]) });
      index += number[0].length;
      continue;
    }
    const identifier = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/u);
    if (identifier) {
      tokens.push({ type: 'identifier', value: identifier[0] });
      index += identifier[0].length;
      continue;
    }
    if ('+-*/^()'.includes(rest[0])) {
      tokens.push({ type: rest[0], value: rest[0] });
      index += 1;
      continue;
    }
    return null;
  }
  return tokens;
}

function parseFormulaExpression(expression) {
  const tokens = tokenizeFormula(expression);
  if (!tokens?.length) return null;
  let index = 0;
  const peek = () => tokens[index];
  const take = (type) => peek()?.type === type ? tokens[index++] : null;

  function primary() {
    const number = take('number');
    if (number) return { type: 'number', value: number.value };
    const identifier = take('identifier');
    if (identifier) {
      if (identifier.value === 'sqrt' && take('(')) {
        const argument = additive();
        return argument && take(')') ? { type: 'sqrt', argument } : null;
      }
      return { type: 'variable', name: identifier.value };
    }
    if (take('(')) {
      const node = additive();
      return node && take(')') ? node : null;
    }
    return null;
  }

  function unary() {
    if (take('+')) return unary();
    if (take('-')) {
      const argument = unary();
      return argument ? { type: 'negate', argument } : null;
    }
    return primary();
  }

  function power() {
    const left = unary();
    if (!left) return null;
    if (take('^')) {
      const right = power();
      return right ? { type: 'binary', operator: '^', left, right } : null;
    }
    return left;
  }

  function multiplicative() {
    let node = power();
    while (node && (peek()?.type === '*' || peek()?.type === '/')) {
      const operator = tokens[index++].type;
      const right = power();
      if (!right) return null;
      node = { type: 'binary', operator, left: node, right };
    }
    return node;
  }

  function additive() {
    let node = multiplicative();
    while (node && (peek()?.type === '+' || peek()?.type === '-')) {
      const operator = tokens[index++].type;
      const right = multiplicative();
      if (!right) return null;
      node = { type: 'binary', operator, left: node, right };
    }
    return node;
  }

  const root = additive();
  return root && index === tokens.length ? root : null;
}

function evaluateFormulaAst(node) {
  if (!node) return { known: false };
  if (node.type === 'number') return { known: true, value: node.value };
  if (node.type === 'variable') return { known: false };
  if (node.type === 'negate') {
    const argument = evaluateFormulaAst(node.argument);
    return argument.known ? { known: true, value: -argument.value } : argument;
  }
  if (node.type === 'sqrt') {
    const argument = evaluateFormulaAst(node.argument);
    return argument.known && argument.value >= 0
      ? { known: true, value: Math.sqrt(argument.value) }
      : { known: false };
  }
  const left = evaluateFormulaAst(node.left);
  const right = evaluateFormulaAst(node.right);
  if (!left.known || !right.known) return { known: false };
  if (node.operator === '+') return { known: true, value: left.value + right.value };
  if (node.operator === '-') return { known: true, value: left.value - right.value };
  if (node.operator === '*') return { known: true, value: left.value * right.value };
  if (node.operator === '/') return right.value === 0 ? { known: false } : { known: true, value: left.value / right.value };
  if (node.operator === '^') return { known: true, value: left.value ** right.value };
  return { known: false };
}

// These variables are non-negative contract quantities. When a formula also
// contains one of them but its current value is unavailable, retain the exact
// lower bound from the known policy inputs instead of discarding the whole
// indicator. The UI marks this result as a minimum estimate.
const NON_NEGATIVE_FORMULA_VARIABLES = new Set([
  'accumulated_dividend_insured_amount',
  'accumulated_dividend_amount',
  'cash_value',
  'account_value',
  'paid_premium',
  'total_paid_premium',
  'first_premium',
  'annual_premium',
  'paid_benefit_amount',
  'disability_payout_ratio',
  'payout_ratio',
  'actual_medical_expense',
  'deductible',
  'third_party_paid_amount',
  'remaining_liability_limit',
]);

function formulaLowerBound(node) {
  if (!node) return { lower: null, exact: false, nonNegative: false, unresolved: new Set() };
  if (node.type === 'number') return { lower: node.value, exact: true, nonNegative: node.value >= 0, unresolved: new Set() };
  if (node.type === 'variable') {
    const safe = NON_NEGATIVE_FORMULA_VARIABLES.has(node.name);
    return { lower: safe ? 0 : null, exact: false, nonNegative: safe, unresolved: new Set([node.name]) };
  }
  if (node.type === 'negate') return { lower: null, exact: false, nonNegative: false, unresolved: formulaLowerBound(node.argument).unresolved };
  if (node.type === 'sqrt') {
    const argument = formulaLowerBound(node.argument);
    return argument.nonNegative && argument.lower !== null
      ? { lower: Math.sqrt(argument.lower), exact: argument.exact, nonNegative: true, unresolved: argument.unresolved }
      : { lower: null, exact: false, nonNegative: false, unresolved: argument.unresolved };
  }

  const left = formulaLowerBound(node.left);
  const right = formulaLowerBound(node.right);
  const unresolved = new Set([...left.unresolved, ...right.unresolved]);
  if (node.operator === '+' && left.lower !== null && right.lower !== null) {
    return { lower: left.lower + right.lower, exact: left.exact && right.exact, nonNegative: left.nonNegative && right.nonNegative, unresolved };
  }
  if (node.operator === '*' && left.lower !== null && right.lower !== null && left.nonNegative && right.nonNegative) {
    return { lower: left.lower * right.lower, exact: left.exact && right.exact, nonNegative: true, unresolved };
  }
  if (node.operator === '/' && left.lower !== null && left.nonNegative && right.exact && right.lower > 0) {
    return { lower: left.lower / right.lower, exact: left.exact, nonNegative: true, unresolved };
  }
  if (node.operator === '^' && left.lower !== null && left.nonNegative && right.exact && right.lower >= 0) {
    return { lower: left.lower ** right.lower, exact: left.exact, nonNegative: true, unresolved };
  }
  return { lower: null, exact: false, nonNegative: false, unresolved };
}

function formulaExpressionFromBasisDefinition(definition = {}) {
  const source = displayText(definition?.normalizedFormula || definition?.formulaText);
  if (!source) return '';
  const expression = source
    .normalize('NFKC')
    .replace(/基本责任保险金额|基本保险金额|基本保额/gu, 'basic_insured_amount')
    .replace(/累计红利保险金额|累积红利保险金额/gu, 'accumulated_dividend_insured_amount')
    .replace(/账户价值/gu, 'account_value')
    .replace(/现金价值/gu, 'cash_value')
    .replace(/两部分之和|之和/gu, '')
    .replace(/与/gu, '+')
    .replace(/×/gu, '*')
    .replace(/÷/gu, '/')
    .replace(/（/gu, '(')
    .replace(/）/gu, ')')
    .replace(/元/gu, '')
    .trim();
  return parseFormulaExpression(expression) ? expression : '';
}

function normalizedFormulaFromDisplayFormula(indicator = {}) {
  const formulaText = displayText(indicator.formulaText).normalize('NFKC');
  const equalsIndex = formulaText.indexOf('=');
  if (equalsIndex < 1 || formulaText.indexOf('=', equalsIndex + 1) >= 0) return '';

  let expression = formulaText.slice(equalsIndex + 1)
    .replace(/[（]/gu, '(')
    .replace(/[）]/gu, ')')
    .replace(/[×xX]/gu, '*')
    .replace(/[÷]/gu, '/')
    .replace(/[＋]/gu, '+')
    .replace(/[－]/gu, '-')
    .replace(/乘以/gu, '*')
    .replace(/除以/gu, '/')
    .replace(/扣除|减去/gu, '-')
    .replace(/加上/gu, '+')
    .replace(/(?:sqrt|√)\s*\(/gu, 'sqrt(')
    .replace(/(\d+(?:\.\d+)?)\s*[%％]/gu, (_match, value) => String(Number(value) / 100));

  const replacements = [
    [/其他(?:途径|来源)已补偿金额|已从其他途径(?:取得|获得)补偿金额/gu, 'third_party_paid_amount'],
    [/已给付(?:的)?(?:意外)?(?:伤残|残疾|全残)?保险金|已给付保险金/gu, 'paid_benefit_amount'],
    [/剩余(?:保险)?责任限额|剩余保险金额/gu, 'remaining_liability_limit'],
    [/实际(?:合理且必要的)?医疗费用|实际医疗费用/gu, 'actual_medical_expense'],
    [/累计红利保险金额|累积红利保险金额/gu, 'accumulated_dividend_insured_amount'],
    [/有效保险金额/gu, 'effective_insured_amount'],
    [/累计已交保险费|累计已交保费|实际交纳(?:的)?保险费|已交保险费|已交保费|所交保险费|所交保费/gu, 'total_paid_premium'],
    [/首期保险费|首期保费|首年保险费|首年保费|年交保险费|年交保费/gu, 'first_premium'],
    [/缴费年期|缴费期间|交费年期|交费期间/gu, 'payment_years'],
    [/伤残(?:等级|程度)?(?:对应)?(?:的)?(?:保险金)?给付比例|伤残\/残疾等级给付比例|残疾(?:等级|程度)?(?:对应)?(?:的)?(?:保险金)?给付比例/gu, 'disability_payout_ratio'],
    [/赔付比例|赔偿比例|给付比例/gu, 'payout_ratio'],
    [/免赔额/gu, 'deductible'],
    [/基本责任保险金额|基本责任保险金|基本保险金额|基本保险金|基本保额|保险金额|保额/gu, 'basic_insured_amount'],
  ];
  for (const [pattern, variable] of replacements) expression = expression.replace(pattern, variable);

  expression = expression
    .replace(/(?:元|圆)/gu, '')
    .replace(/\s+/gu, '')
    .replace(/的(?=\d)/gu, '*');
  if (!/^[A-Za-z0-9_+\-*/^().]+$/u.test(expression)) return '';
  return parseFormulaExpression(expression) ? `benefit_amount = ${expression}` : '';
}

function normalizedFormulaForIndicator(indicator = {}) {
  const stored = displayText(indicator.normalizedFormula);
  if (stored) return stored;
  const displayFormula = normalizedFormulaFromDisplayFormula(indicator);
  if (displayFormula) return displayFormula;
  const basisExpression = formulaExpressionFromBasisDefinition(indicator.basisDefinition);
  const value = finiteNumber(indicator.value);
  const unit = displayText(indicator.unit);
  if (!basisExpression) return '';
  if (value !== null && /%/u.test(unit)) return `(${basisExpression}) * ${value / 100}`;
  if (value !== null && /倍/u.test(unit)) return `(${basisExpression}) * ${value}`;

  // Older imported indicators keep the factor only in the official formula
  // text (for example “有效保险金额 × 100%”), with value/unit left empty.
  // Accept only a direct numeric factor so this stays a formula projection,
  // not a heuristic over the product name or arbitrary clause prose.
  const formulaText = displayText(indicator.formulaText).normalize('NFKC');
  const percentage = formulaText.match(/(?:×|\*)\s*(\d+(?:\.\d+)?)\s*%/u)
    || formulaText.match(/(?:的|按)\s*(\d+(?:\.\d+)?)\s*%/u);
  if (percentage) return `(${basisExpression}) * ${Number(percentage[1]) / 100}`;
  const multiple = formulaText.match(/(?:×|\*)\s*(\d+(?:\.\d+)?)(?:\s*倍)?/u)
    || formulaText.match(/(?:的|按)\s*(\d+(?:\.\d+)?)\s*倍/u);
  if (multiple) return `(${basisExpression}) * ${Number(multiple[1])}`;
  return '';
}

function displayFormulaExpression(expression) {
  return String(expression || '')
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/gu, (token, name) => name === 'sqrt' ? token : formulaLabel(name))
    .replace(/\b\d+(?:\.\d+)?\b/gu, (value) => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 8 }))
    .replace(/\*/gu, ' × ')
    .replace(/\//gu, ' ÷ ')
    .replace(/\^/gu, ' ^ ')
    .replace(/([+\-])/gu, ' $1 ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function partialFormulaExpression(expression) {
  return String(expression || '').replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/gu, (token, name) => {
    if (name === 'sqrt') return name;
    return `${formulaLabel(name)}（待补充）`;
  });
}

function resolveNormalizedFormula(indicator = {}, inputs = {}) {
  const source = normalizedFormulaForIndicator(indicator);
  if (!source || /(?:\bmax\b|\bmin\b|\bif\b|[,;])/iu.test(source)) return null;
  const parts = source.split('=');
  if (parts.length > 2) return null;
  const expression = expandFormulaVariables(parts.length === 2 ? parts[1] : source, inputs);
  const ast = parseFormulaExpression(expression);
  if (!ast) return null;
  const label = displayText(indicator.liability) || formulaLabel(parts.length === 2 ? parts[0].trim() : source);
  const evaluated = evaluateFormulaAst(ast);
  if (evaluated.known && Number.isFinite(evaluated.value)) {
    const amount = roundMoney(evaluated.value);
    return {
      resolved: amount > 0,
      partial: false,
      amount,
      calculationText: `${displayFormulaExpression(expression)} = ${formatMoney(amount)}元`,
    };
  }
  const displayExpression = partialFormulaExpression(expression);
  const lowerBound = formulaLowerBound(ast);
  const minimumAmount = lowerBound.lower !== null && lowerBound.lower > 0
    ? roundMoney(lowerBound.lower)
    : 0;
  const unresolvedLabels = [...lowerBound.unresolved].map(formulaLabel).join('、');
  return {
    resolved: false,
    partial: true,
    amount: 0,
    minimumAmount,
    isMinimumEstimate: minimumAmount > 0,
    calculationText: `${label} = ${displayFormulaExpression(displayExpression)}${minimumAmount > 0 ? `；最低可确认金额 ${formatMoney(minimumAmount)}元（未计入${unresolvedLabels || '待补充金额'}）` : `；缺少${unresolvedLabels || '待补充输入'}，暂不计算`}`,
  };
}

const POLICY_FORMULA_INPUTS = [
  { pattern: /基本责任保险金额|基本保险金额|基本保险金|基本保额|保险金额|保额/u, label: '基本保险金额', value: (inputs) => inputs.baseAmount },
  { pattern: /首期保费|首年保费|年交保费|年度保险费/u, label: '首期/首年保费', value: (inputs) => inputs.firstPremium },
  { pattern: /累计已交保费|实际交纳保险费|实际交纳保费|已交保险费|已交保费|所交保费/u, label: '累计已交保费', value: (inputs) => {
    const premium = formulaNumber(inputs.firstPremium);
    const years = formulaNumber(inputs.paymentYears);
    return premium !== null && years !== null ? premium * years : undefined;
  } },
];

function formulaNeedsExternalOperand(formulaText = '') {
  const text = displayText(formulaText);
  if (!text) return false;
  return /(?:给付|赔付|赔偿)比例|伤残(?:等级|程度)|残疾(?:等级|程度)|实际(?:医疗)?费用|免赔额|住院(?:天数|日数)|给付(?:天数|日数)|现金价值|账户价值|红利保险金额|比例表|领取计划/u.test(text)
    && !/(?:给付|赔付|赔偿)比例[^。；;，,]{0,12}\d+(?:\.\d+)?\s*%/u.test(text);
}

function pendingFormulaProjection(indicator = {}, inputs = {}, meta = {}) {
  const formulaText = displayText(indicator.formulaText || indicator.basis)
    .replace(/现金价值不展示|现金价值不统计|现金价值不参与展示/gu, '')
    .trim();
  if (!formulaText) return null;
  if (/(?:\bmax\b|\bmin\b|较大者|较小者|最大者|最小者)/iu.test(formulaText)) return null;
  const substitutions = POLICY_FORMULA_INPUTS
    .filter(({ pattern }) => pattern.test(formulaText))
    .map(({ label, value }) => ({ label, value: formulaNumber(value(inputs)) }))
    .filter(({ value }) => value !== null && value > 0);
  const hasUnresolvedOperand = formulaNeedsExternalOperand(formulaText)
    || meta.calculationEligible === false;
  if (!substitutions.length || !hasUnresolvedOperand) return null;
  const required = Array.isArray(indicator.requiredInputs)
    ? indicator.requiredInputs.map(displayText).filter(Boolean)
    : [];
  const reason = displayText(meta.calculationReason)
    || (required.length ? `缺少${required.join('、')}` : '仍缺少条款公式中的事件或表格变量');
  return {
    resolved: false,
    partial: true,
    amount: 0,
    meta,
    calculationText: `条款公式：${formulaText}；已代入：${substitutions.map(({ label, value }) => `${label}${formatMoney(value)}元`).join('，')}；${reason}`,
  };
}

function officialClauseForLiability(indicator = {}) {
  const liability = normalizeText(indicator.liability || indicator.coverageType);
  const excerpt = normalizeText(indicator.sourceExcerpt);
  if (!liability || !excerpt) return '';
  const start = excerpt.indexOf(liability);
  if (start < 0) return '';
  const tail = excerpt.slice(start);
  const nextResponsibility = tail.match(/[。；](?:\d{1,2}[、.．])(?=[^。；]{0,36}(?:保险金|年金|津贴|责任))/u);
  return nextResponsibility ? tail.slice(0, nextResponsibility.index + 1) : tail;
}

function effectiveInsuredAmountDefinition(indicator = {}) {
  return {
    key: 'contract_defined_effective_insured_amount',
    label: '有效保险金额',
    formulaText: '基本保险金额 + 累计红利保险金额',
    requiredInputs: ['policy.basicInsuredAmount', 'policy.accumulatedDividendInsuredAmount'],
    sourceUrl: displayText(indicator.sourceUrl),
    sourceExcerpt: displayText(indicator.sourceExcerpt),
  };
}

function repairIndicatorFormulaFromOfficialExcerpt(indicator = {}) {
  if (indicator.__skipOfficialFormulaRepair === true || !displayText(indicator.sourceUrl)) return indicator;
  const liability = displayText(indicator.liability || indicator.coverageType);
  const clause = officialClauseForLiability(indicator);
  if (!liability || !clause) return indicator;
  const hasEffectiveAmountSum = /(?:基本保险金额|基本保险金|基本保额)(?:与|及|和)(?:累计|累积)红利保险金额(?:二者)?之和/u.test(clause);
  const isScheduledBenefit = /满期|生存|年金|祝寿|教育|婚嫁|关爱|养老/u.test(liability);
  if (isScheduledBenefit) {
    if (!hasEffectiveAmountSum) return indicator;
    return {
      ...indicator,
      basis: '有效保险金额',
      formulaText: `${liability} = 基本保险金额 + 累计红利保险金额`,
      payoutSummary: `${liability} = 基本保险金额 + 累计红利保险金额`,
      normalizedFormula: 'benefit_amount = basic_insured_amount + accumulated_dividend_insured_amount',
      basisDefinition: effectiveInsuredAmountDefinition(indicator),
      value: null,
      valueText: '',
      unit: '公式',
      basisKey: 'effective_insured_amount',
      calculationKey: 'unknown',
      calculationEligible: true,
      calculationReason: '',
      responsibilityRepairVersion: '2026-07-31-official-clause-formula-repair',
    };
  }

  if (!/身故|全残|死亡/u.test(liability)) return indicator;
  const branches = [];
  const earlyDisease = clause.match(/(本合同生效(?:或复效)?之日起一年内因疾病导致(?:身故|身体?全残)[^。；]*?)本公司按(?:本合同)?基本保险金额的?(\d+(?:\.\d+)?)%与[^。；]*(?:实际交纳|已交)(?:的)?保险费(?:二者)?之和给付/u);
  if (earlyDisease) {
    branches.push({
      branchId: 'disease_within_first_year',
      condition: earlyDisease[1],
      formulaText: `基本保险金额 × ${earlyDisease[2]}% + 累计已交保费`,
      normalizedFormula: `benefit_amount = basic_insured_amount * ${Number(earlyDisease[2]) / 100} + total_paid_premium`,
    });
  }
  const laterDisease = clause.match(/(本合同生效(?:或复效)?之日起一年后因疾病导致(?:身故|身体?全残)[^。；]*?)本公司按(?:本合同)?基本保险金额与(?:累计|累积)红利保险金额(?:二者)?之和的?(两|二|\d+(?:\.\d+)?)倍给付/u);
  const accidental = clause.match(/(被保险人因意外伤害[^。；]*?(?:身故|身体?全残)[^。；]*?)本公司按(?:本合同)?基本保险金额与(?:累计|累积)红利保险金额(?:二者)?之和的?(两|二|\d+(?:\.\d+)?)倍给付/u);
  for (const [branchId, match] of [['disease_after_first_year', laterDisease], ['accidental', accidental]]) {
    if (!match) continue;
    const multiplier = /^(?:两|二)$/u.test(match[2]) ? 2 : Number(match[2]);
    if (!(multiplier > 0)) continue;
    branches.push({
      branchId,
      condition: match[1],
      formulaText: `(基本保险金额 + 累计红利保险金额) × ${multiplier}`,
      normalizedFormula: `benefit_amount = (basic_insured_amount + accumulated_dividend_insured_amount) * ${multiplier}`,
    });
  }
  if (!branches.length) return indicator;
  return {
    ...indicator,
    basis: '按出险条件分别计算',
    formulaText: `${liability} = 条件分支给付`,
    payoutSummary: `${liability}按首年疾病、满一年疾病或意外伤害的条款分支给付`,
    normalizedFormula: '',
    basisDefinition: effectiveInsuredAmountDefinition(indicator),
    value: null,
    valueText: '',
    unit: '公式',
    basisKey: 'event_condition',
    calculationKey: 'claim_event_facts',
    calculationEligible: false,
    calculationReason: '需补充出险原因和出险日期后选择条款给付分支，暂不计算',
    branches,
    branchSemanticContract: 'official-claim-event-branches',
    responsibilityRepairVersion: '2026-07-31-official-clause-formula-repair',
  };
}

export function repairIndicatorFormulaFromOfficialExcerptForDisplay(indicator = {}) {
  return repairIndicatorFormulaFromOfficialExcerpt(indicator);
}

function claimBranchLabel(branch = {}) {
  const labels = {
    disease_within_first_year: '首年疾病导致身故或全残',
    disease_after_first_year: '满一年后疾病导致身故或全残',
    accidental: '意外伤害导致身故或全残',
  };
  return labels[displayText(branch.branchId)]
    || displayText(branch.conditionText)
    || displayText(branch.condition)
    || '条款条件分支';
}

function claimBranchCalculationText(branch = {}, result = {}, inputs = {}) {
  const formula = displayText(branch.normalizedFormula);
  const baseAmount = Number(inputs.baseAmount || 0) || 0;
  const firstPremium = Number(inputs.firstPremium || 0) || 0;
  const paymentYears = Number(inputs.paymentYears || 0) > 0 ? Number(inputs.paymentYears) : 1;
  const earlyDisease = formula.match(/^benefit_amount\s*=\s*basic_insured_amount\s*\*\s*([\d.]+)\s*\+\s*total_paid_premium$/u);
  if (earlyDisease && result.resolved) {
    const percentage = Number(earlyDisease[1]) * 100;
    return `基本保险金额${formatMoney(baseAmount)}元 × ${formatMoney(percentage)}% + 当前累计已交保费${formatMoney(firstPremium * paymentYears)}元 = ${formatMoney(result.amount)}元`;
  }
  const effectiveAmount = formula.match(/^benefit_amount\s*=\s*\(basic_insured_amount\s*\+\s*accumulated_dividend_insured_amount\)\s*\*\s*([\d.]+)$/u);
  if (effectiveAmount && result.isMinimumEstimate) {
    return `（基本保险金额${formatMoney(baseAmount)}元 + 累计红利保险金额（待补充））× ${formatMoney(Number(effectiveAmount[1]))}；最低可确认金额 ${formatMoney(result.minimumAmount)}元（未计入累计红利保险金额）`;
  }
  return displayText(result.calculationText);
}

function resolveClaimEventBranchScenarios(indicator = {}, inputs = {}, meta = {}) {
  const branches = Array.isArray(indicator.branches) ? indicator.branches : [];
  if (!branches.length) return null;
  const lines = branches.map((branch) => {
    const result = resolveIndicatorAmountFromCalculation({
      ...indicator,
      ...branch,
      liability: '',
      coverageType: '',
      sourceExcerpt: '',
      condition: '',
      branches: [],
      branchSemanticContract: '',
      __skipOfficialFormulaRepair: true,
      value: null,
      valueText: '',
      unit: '公式',
      basisKey: '',
      calculationKey: '',
      calculationEligible: undefined,
    }, inputs);
    return `${claimBranchLabel(branch)}：${claimBranchCalculationText(branch, result, inputs)}`;
  });
  return {
    resolved: false,
    partial: true,
    amount: 0,
    meta,
    hasBranchScenarios: true,
    uncertaintyNote: '需补充出险原因和出险日期以选择实际给付分支；以下仅为按当前保单数据的分支情景测算，未计入统计。',
    calculationText: `条款分支情景测算（未计入统计）：\n${lines.join('\n')}`,
  };
}

function resolveScheduledBenefitBranchScenarios(indicator = {}, inputs = {}, meta = {}) {
  const branches = Array.isArray(indicator.branches) ? indicator.branches : [];
  const baseAmount = Number(inputs.baseAmount || 0) || 0;
  if (!branches.length || !(baseAmount > 0)) return null;
  const lines = branches.map((branch) => {
    const condition = displayText(branch.conditionText || branch.condition) || '约定领取阶段';
    const formula = displayText(branch.formulaText || branch.normalizedFormula);
    const percentage = formula.match(/(\d+(?:\.\d+)?)\s*[%％]/u);
    if (!percentage) return `${condition}：${formula}`;
    const rate = Number(percentage[1]);
    const amount = roundMoney(baseAmount * rate / 100);
    return `${condition}：基本责任保险金额${formatMoney(baseAmount)}元 × ${formatMoney(rate)}% = ${formatMoney(amount)}元`;
  });
  return {
    resolved: false,
    partial: true,
    amount: 0,
    meta,
    hasBranchScenarios: true,
    scenarioKind: 'scheduled_benefit',
    uncertaintyNote: '已按当前保单保险金额分别测算各领取阶段；不同年龄阶段适用比例不同，未合并为单笔金额，也未计入统计。',
    calculationText: `领取阶段测算（未合并统计）：\n${lines.join('\n')}`,
  };
}

export function resolveIndicatorAmountFromCalculation(indicator = {}, inputs = {}) {
  const repairedIndicator = repairIndicatorFormulaFromOfficialExcerpt(indicator);
  const meta = normalizeIndicatorCalculation(repairedIndicator);
  if (meta.calculationKey === 'scheduled_branch_scenarios') {
    const branchScenarios = resolveScheduledBenefitBranchScenarios(repairedIndicator, inputs, meta);
    if (branchScenarios) return branchScenarios;
  }
  if (meta.calculationKey === 'claim_event_facts') {
    const branchScenarios = resolveClaimEventBranchScenarios(repairedIndicator, inputs, meta);
    if (branchScenarios) return branchScenarios;
    return {
      resolved: false,
      partial: true,
      amount: 0,
      meta,
      uncertaintyNote: '需补充出险原因和出险日期以选择实际给付分支，未计入统计。',
      calculationText: `${displayText(repairedIndicator.liability || repairedIndicator.coverageType)}需根据出险原因和出险日期选择条款给付分支，当前未提供，暂不计算`,
    };
  }
  const normalizedFormulaResult = resolveNormalizedFormula(repairedIndicator, inputs);
  if (normalizedFormulaResult?.resolved) return { ...normalizedFormulaResult, meta };
  if (normalizedFormulaResult?.partial) return { ...normalizedFormulaResult, meta };

  const baseAmount = Number(inputs.baseAmount || 0) || 0;
  const firstPremium = Number(inputs.firstPremium || 0) || 0;
  const paymentYears = Number(inputs.paymentYears || 0) > 0 ? Number(inputs.paymentYears) : 1;
  const totalPremium = firstPremium * paymentYears;
  const value = Number(meta.value || 0);

  const pendingProjection = pendingFormulaProjection(repairedIndicator, { ...inputs, baseAmount, firstPremium, paymentYears }, meta);
  if (pendingProjection) return pendingProjection;

  if (!meta.calculationEligible) return { resolved: false, amount: 0, meta, calculationText: meta.calculationReason };

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

function currentAgeClause(indicator = {}, currentAge) {
  if (!Number.isFinite(currentAge)) return null;
  const text = normalizeText([
    indicator.formulaText,
    indicator.condition,
    indicator.sourceExcerpt,
  ].filter(Boolean).join(' '));
  if (!text) return null;

  const clauses = text
    .split(/(?=若(?:被保险人)?(?:于)?)/u)
    .map((item) => item.split(/[。；;]/u)[0].trim())
    .filter(Boolean);
  for (const clause of clauses) {
    const ageMatch = clause.match(/(\d{1,3})周岁[^。；;]{0,40}?(之前|以前|前|以后|及以后|后)/u);
    if (!ageMatch) continue;
    const thresholdAge = Number(ageMatch[1]);
    const direction = ageMatch[2];
    const applies = /之前|以前|前/u.test(direction) ? currentAge < thresholdAge : currentAge >= thresholdAge;
    if (applies) return { clause, thresholdAge, direction };
  }
  return null;
}

export function resolveIndicatorAmountForCurrentContext(indicator = {}, inputs = {}) {
  const currentAge = finiteNumber(inputs.currentAge);
  const conditional = currentAgeClause(indicator, currentAge);
  if (conditional) {
    const branchIndicator = {
      ...indicator,
      formulaText: conditional.clause,
      sourceExcerpt: conditional.clause,
      value: undefined,
      valueText: '',
      unit: '',
      basisKey: '',
      calculationKey: '',
      calculationEligible: undefined,
    };
    const branchResult = resolveIndicatorAmountFromCalculation(branchIndicator, inputs);
    if (branchResult.resolved) {
      return {
        ...branchResult,
        formula: conditional.clause,
        calculationText: `当前年龄${currentAge}周岁，适用“${conditional.clause}”：${branchResult.calculationText}`,
      };
    }
  }
  return resolveIndicatorAmountFromCalculation(indicator, inputs);
}

export function indicatorCalculationPayloadFields(indicator = {}) {
  const meta = normalizeIndicatorCalculation(indicator);
  return {
    basisKey: meta.basisKey,
    calculationKey: meta.calculationKey,
    calculationEligible: meta.calculationEligible,
    calculationReason: meta.calculationReason,
    requiredInputs: requiredCalculationInputsForMeta(meta),
    calculationInputSchemaVersion: CALCULATION_INPUT_SCHEMA_VERSION,
  };
}
