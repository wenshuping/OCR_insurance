export const SALES_CHAMPION_CUSTOMER_LABEL_TAXONOMY = Object.freeze({
  source: Object.freeze(['SRC0', 'SRC1', 'SRC2', 'SRC3', 'SRC4', 'SRC5', 'SRC6', 'SRC7', 'SRC8', 'SRC9']),
  customer_status: Object.freeze(['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9']),
  family_stage: Object.freeze([
    '单身', '已婚', '育儿家庭', '子女教育期', '子女成年', '养老准备期', '退休期',
    '多代家庭', '单亲家庭', '企业主家庭', '家庭情况未知',
  ]),
  income_type: Object.freeze([
    '固定工资', '绩效／佣金收入', '自由职业', '个体经营', '企业经营', '投资性收入',
    '退休收入', '多收入来源', '收入暂不稳定', '职业及收入类型未知',
  ]),
  economic_capacity: Object.freeze(['E0', 'E1', 'E2', 'E3', 'E4', 'E5']),
  relationship_maturity: Object.freeze(['G0', 'G1', 'G2', 'G3', 'G4']),
  demand_maturity: Object.freeze(['N0', 'N1', 'N2', 'N3', 'N4']),
  purchase_intent: Object.freeze(['I0', 'I1', 'I2', 'I3', 'I4', 'I5']),
  resistance: Object.freeze(['K0', 'K1', 'K2', 'K3', 'K4', 'K5']),
  decision_maturity: Object.freeze(['D0', 'D1', 'D2', 'D3', 'D4', 'D5']),
  customer_journey: Object.freeze(['J1', 'J2', 'J3', 'J4', 'J5']),
  policy_relationship: Object.freeze(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9']),
  service_status: Object.freeze([
    '无待办', '客户资料待补充', '顾问处理中', '保险公司处理中', '第三方专业人员处理中',
    '等待客户确认', '已完成待回访', '已闭环', '无法继续处理',
  ]),
  marketing_grade: Object.freeze(['M0', 'M1', 'M2', 'M3', 'M4']),
  service_priority: Object.freeze(['S0', 'S1', 'S2', 'S3']),
  contact_permission: Object.freeze(['B0', 'B1', 'B2', 'B3', 'B4', 'B5']),
  communication_preference: Object.freeze([
    '微信', '电话', '短信', '面谈', '视频会议', '仅工作日', '仅指定时段',
    '只接收必要提醒', '接受定期复盘', '不参加客户活动', '资料偏好摘要版', '资料偏好完整版',
  ]),
  current_concern: Object.freeze([
    '不信任保险', '不信任销售人员', '理赔顾虑', '合同理解困难', '收益顾虑',
    '流动性顾虑', '缴费持续性顾虑', '家庭意见不一致', '需要比较其他方案',
    '需要共同决策人参与', '暂无紧迫性', '过去存在不良经历', '顾虑尚未明确',
  ]),
  next_action: Object.freeze([
    '取得联系许可', '初次沟通', '需求访谈', '收集授权资料', '保单整理', '核验合同事实',
    '准备分析摘要', '方案沟通', '处理核心顾虑', '邀请共同决策人', '确认客户决定',
    '投保协助', '交付服务', '续期／保全／理赔协助', '定期复盘', '暂停跟进', '停止营销',
  ]),
});

export const SALES_CHAMPION_CUSTOMER_LABEL_DIMENSIONS = Object.freeze(
  Object.keys(SALES_CHAMPION_CUSTOMER_LABEL_TAXONOMY),
);

const VALID_DIMENSIONS = new Set(SALES_CHAMPION_CUSTOMER_LABEL_DIMENSIONS);
const VALID_VALUES = new Map(Object.entries(SALES_CHAMPION_CUSTOMER_LABEL_TAXONOMY)
  .map(([dimension, values]) => [dimension, new Set(values)]));
const CONDITION_FIELDS = Object.freeze([
  'requiredLabels',
  'preferredLabels',
  'probeLabels',
  'excludedLabels',
  'notTriggeredBy',
]);

function validateConditionMap(value, path, readsLabels) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  for (const [dimension, labels] of Object.entries(value)) {
    if (!VALID_DIMENSIONS.has(dimension)) throw new TypeError(`${path} has unknown dimension: ${dimension}`);
    if (!readsLabels.includes(dimension)) throw new TypeError(`${path}.${dimension} is not declared in readsLabels`);
    if (!Array.isArray(labels) || !labels.length || new Set(labels).size !== labels.length) {
      throw new TypeError(`${path}.${dimension} must be a unique non-empty array`);
    }
    if (labels.some((label) => !VALID_VALUES.get(dimension).has(label))) {
      throw new TypeError(`${path}.${dimension} contains an unregistered label`);
    }
  }
}

export function validateSalesChampionCustomerLabelApplicability(value, path = 'labelApplicability') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const allowedFields = new Set(['readsLabels', ...CONDITION_FIELDS]);
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) throw new TypeError(`${path} contains unknown field: ${field}`);
  }
  if (!Array.isArray(value.readsLabels) || !value.readsLabels.length
    || value.readsLabels.some((dimension) => !VALID_DIMENSIONS.has(dimension))
    || new Set(value.readsLabels).size !== value.readsLabels.length) {
    throw new TypeError(`${path}.readsLabels must be a unique non-empty registered array`);
  }
  for (const field of CONDITION_FIELDS) validateConditionMap(value[field], `${path}.${field}`, value.readsLabels);

  for (const [dimension, required] of Object.entries(value.requiredLabels)) {
    const excluded = value.excludedLabels[dimension] || [];
    if (required.some((label) => excluded.includes(label))) {
      throw new TypeError(`${path} requires and excludes the same label in ${dimension}`);
    }
  }
  return true;
}

function freezeConditionMap(value) {
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([dimension, labels]) => [dimension, Object.freeze([...labels])]),
  ));
}

export function createSalesChampionCustomerLabelApplicability({
  readsLabels,
  requiredLabels = {},
  preferredLabels = {},
  probeLabels = {},
  excludedLabels = {},
  notTriggeredBy = {},
}) {
  const applicability = {
    readsLabels: [...readsLabels],
    requiredLabels: { ...requiredLabels },
    preferredLabels: { ...preferredLabels },
    probeLabels: { ...probeLabels },
    excludedLabels: { ...excludedLabels },
    notTriggeredBy: { ...notTriggeredBy },
  };
  validateSalesChampionCustomerLabelApplicability(applicability);
  return Object.freeze({
    readsLabels: Object.freeze(applicability.readsLabels),
    requiredLabels: freezeConditionMap(applicability.requiredLabels),
    preferredLabels: freezeConditionMap(applicability.preferredLabels),
    probeLabels: freezeConditionMap(applicability.probeLabels),
    excludedLabels: freezeConditionMap(applicability.excludedLabels),
    notTriggeredBy: freezeConditionMap(applicability.notTriggeredBy),
  });
}
