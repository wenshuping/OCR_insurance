function text(value) {
  return String(value ?? '').trim();
}

const TOPIC_RULES = [
  { code: 'product_overview', label: '产品概览', pattern: /产品(?:定位|介绍|信息|概览)|产品名称|险种代码/u },
  { code: 'target_audience', label: '适用人群', pattern: /适(?:用|合)(?:人群|客户|对象)|目标客户|客户画像|哪些人|谁适合/u },
  { code: 'product_advantage', label: '产品优势', pattern: /产品(?:特色|优势|亮点|卖点)|核心优势|差异化|健告宽松|高龄可投|次标可保/u },
  { code: 'underwriting', label: '投保规则', pattern: /投保(?:年龄|规则|条件|范围)|健康告知|健告|职业类别|等待期|续保|保证续保|最高续保年龄/u },
  { code: 'coverage', label: '保障责任', pattern: /保险责任|保障责任|保障范围|保险金|医疗费用|给付|报销|外购药械|康护费用/u },
  { code: 'exclusions', label: '责任免除', pattern: /责任免除|除外责任|不承担|不予给付|免责/u },
  { code: 'plan_pricing', label: '计划与价格', pattern: /保障计划|计划[一二三1-3]|保险金额|保额|免赔额|费率|保费|价格/u },
  { code: 'health_services', label: '健康服务', pattern: /健康管理|健康服务|问诊|护工|绿通|就医服务|服务项目|服务次数|咨询服务/u },
  { code: 'claims', label: '理赔规则', pattern: /理赔|赔付流程|申请材料|保险金申请|索赔/u },
];

export function classifyChunkTopics(input = {}) {
  const content = [
    ...(Array.isArray(input.headingPath) ? input.headingPath : []),
    input.content,
  ].map(text).filter(Boolean).join('\n');
  const topics = TOPIC_RULES.filter((topic) => topic.pattern.test(content));
  const healthService = topics.some((topic) => topic.code === 'health_services');
  const productAudienceSignal = /(?:产品|本产品).{0,8}适用人群|目标客户|客户画像|适合(?:人群|客户|对象)|谁适合/u.test(content);
  const serviceAudienceTable = input.chunkType === 'table' && healthService;
  return serviceAudienceTable || (healthService && !productAudienceSignal)
    ? topics.filter((topic) => topic.code !== 'target_audience')
    : topics;
}

export function topicSearchTerms(query) {
  const normalized = text(query);
  if (/介绍|主要做什么|是什么产品|产品概览/u.test(normalized)) return ['产品概览'];
  if (/优势|亮点|卖点|竞争力|好在哪里|产品特色/u.test(normalized)) return ['产品优势', '产品特色'];
  if (/适合谁|适合什么人|适合哪些人|适用人群|目标客户|客户画像/u.test(normalized)) return ['适用人群', '投保规则'];
  if (/投保年龄|投保规则|投保条件|健康告知|职业类别|等待期|续保/u.test(normalized)) return ['投保规则'];
  if (/责任免除|除外责任|免责|不保什么/u.test(normalized)) return ['责任免除'];
  if (/保险责任|保障什么|保障范围|报销什么|赔什么|给付什么/u.test(normalized)) return ['保障责任'];
  if (/保障计划|计划区别|保额|免赔额|费率|保费|价格/u.test(normalized)) return ['计划与价格'];
  if (/健康管理|健康服务|问诊|护工|绿通|就医服务/u.test(normalized)) return ['健康服务'];
  if (/理赔|怎么赔|申请材料|索赔/u.test(normalized)) return ['理赔规则'];
  return [];
}
