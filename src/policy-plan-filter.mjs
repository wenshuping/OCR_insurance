function normalizePlanText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .trim();
}

const POLICY_PLAN_HEADER_NAMES = new Set([
  '险种名称',
  '子险种名称',
  '保单号',
  '险种性质',
  '保单生效日',
  '保单期满日',
  '合同成立日期',
  '每期交费日',
  '每期缴费日',
  '交费方式',
  '缴费方式',
  '交费期间',
  '缴费期间',
  '交费期满日',
  '缴费期满日',
  '保险金额',
  '保险金额元',
  '标准保费',
  '标准保费元',
  '加费',
  '加费元',
  '出生日期',
  '性别',
  '受益顺序',
  '受益人',
  '与被保险人关系',
  '受益份额',
  '证件名称',
  '证件号码',
  '币种',
  '特别约定',
  '可选责任',
  '可选责任的约定',
  '基本责任',
  '基本责任的约定',
  '营业单位代码',
  '销售人员代码',
  '营业单位名称',
  '销售人员姓名',
]);

const POLICY_PLAN_HEADER_PREFIXES = [
  /^保单(?:生效日|期满日|号|状态)[:：]/u,
  /^合同(?:成立日期|生效日期|终止日期)[:：]/u,
  /^险种性质[:：]/u,
  /^(?:每期)?[交缴]费日[:：]/u,
  /^[交缴]费(?:方式|期间|期满日)[:：]/u,
  /^被?保险人姓名[:：]/u,
  /^投保人姓名[:：]/u,
  /^保险金额(?:元)?[:：]/u,
  /^标准保费(?:元)?[:：]?/u,
  /^加费(?:元)?[:：]?/u,
  /^出生日期[:：]?/u,
  /^性别[:：]?/u,
  /^受益(?:顺序|人|份额)[:：]?/u,
  /^与被保险人关系[:：]?/u,
  /^证件(?:名称|号码)[:：]?/u,
  /^币种[:：]/u,
  /^特别约定[:：]/u,
  /^(?:可选责任|基本责任)(?:的约定)?[:：]?/u,
  /^营业单位(?:代码|名称)[:：]/u,
  /^销售人员(?:代码|姓名)[:：]/u,
];

const POLICY_PLAN_CLAUSE_PATTERNS = [
  /本合同/u,
  /保险期间内/u,
  /不得变更/u,
  /经确定/u,
];

export function isMetadataLikePolicyPlanName(value) {
  const normalized = normalizePlanText(value);
  if (!normalized) return true;
  if (POLICY_PLAN_HEADER_NAMES.has(normalized)) return true;
  if (POLICY_PLAN_CLAUSE_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  return POLICY_PLAN_HEADER_PREFIXES.some((pattern) => pattern.test(normalized));
}

export function shouldKeepPolicyPlan(plan = {}) {
  const name = normalizePlanText(plan?.name || plan?.productName || plan?.matchedProductName);
  const matchedProductName = normalizePlanText(plan?.matchedProductName);
  const effectiveName = name || matchedProductName;
  if (!effectiveName) return false;
  if (isMetadataLikePolicyPlanName(name || effectiveName)) return false;
  return true;
}
