export const POLICY_FIELD_SCHEMA = {
  company: {
    label: '保险公司',
    type: 'text',
    aliases: ['保险公司', '承保公司', '投保公司', '公司名称', '保险机构', '承保机构', '承保单位', '保险公司全称'],
  },
  name: {
    label: '产品名称',
    type: 'text',
    aliases: ['产品名称', '险种名称', '保险名称', '合同名称', '主险名称', '主合同名称', '保险险种', '保险项目', '产品计划', '保险产品名称', '险种计划', '险种/名称'],
  },
  applicant: {
    label: '投保人',
    type: 'person',
    aliases: ['投保人', '投保人姓名', '投保人名称', '要保人', '要保人姓名', '设保人', '设保人姓名'],
  },
  insured: {
    label: '被保险人',
    type: 'person',
    aliases: ['被保险人', '被保险人姓名', '被保险入', '被保险入姓名', '披保险人', '披保险人姓名', '受保人', '受保人姓名', '被保人'],
  },
  effectiveDate: {
    label: '合同生效日期',
    type: 'date',
    aliases: ['合同生效日期', '合同生效日', '投保/生效日期', '投保日期', '合同成立日期', '合同成立日', '承保日期', '生效日期', '生效时间', '保险起期', '起保日期', '起保日', '保险合同成立及生效日'],
  },
  paymentMode: {
    label: '交费方式',
    type: 'enum',
    aliases: ['交费方式', '缴费方式', '交费频率', '缴费频率'],
  },
  paymentPeriod: {
    label: '交费期间',
    type: 'duration',
    aliases: ['交费方式', '缴费方式', '交费期间', '缴费期间', '交费年期', '缴费年期', '交费年限', '缴费年限', '交费期限', '缴费期限'],
  },
  coveragePeriod: {
    label: '保险期间',
    type: 'duration',
    aliases: ['保险期间', '保障期间', '保险期限', '保障期限', '保险责任期间', '合同期限', '保险年期', '保障年期'],
  },
  amount: {
    label: '基本保险金额',
    type: 'money',
    aliases: ['基本保险金额', '基本保额', '保险金额', '保额', '基本保险金额/份数/档次', '基本保险金额／份数／档次', '保险金额/份数', '保额/份数', '金额/份数', '保险金颔'],
  },
  firstPremium: {
    label: '首期保险费',
    type: 'money',
    aliases: ['首期保险费', '首期保费', '首期保险费合计', '首年保费', '标准保险费', '标准保费', '标准保费（元）', '合计保费', '保险费金额', '保险费', '保费', '年交保费', '年缴保费', '应交保费', '应缴保费', '交费标准', '缴费标准', '首期应交保险费', '首期应交保费', '首次保费', '首次保险费', '首年应交保费', '首年应交保险费', '总保费', '总保费(人民币)', '总保险费'],
  },
  beneficiary: {
    label: '身故受益人',
    type: 'text',
    aliases: ['身故保险金受益人', '身故受益人', '受益人'],
  },
  policyNumber: {
    label: '保险合同号',
    type: 'text',
    aliases: ['保险合同号', '保单合同号', '保险单号码', '保险单号', '保单号码', '保单号', '合同号'],
  },
};

export const POLICY_FIELD_KEYS = Object.keys(POLICY_FIELD_SCHEMA);

function uniqueText(values = []) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

export function getPolicyFieldAliases(field, extraAliases = []) {
  const schema = POLICY_FIELD_SCHEMA[field] || {};
  return uniqueText([schema.label, ...(schema.aliases || []), ...extraAliases]);
}

export function createEmptyPolicyFields() {
  return POLICY_FIELD_KEYS.reduce((acc, key) => {
    acc[key] = '';
    return acc;
  }, {});
}

export function createEmptyCandidateMap() {
  return POLICY_FIELD_KEYS.reduce((acc, key) => {
    acc[key] = [];
    return acc;
  }, {});
}
