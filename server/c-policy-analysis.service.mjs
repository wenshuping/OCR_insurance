import { spawn } from 'node:child_process';
import { z } from 'zod';
import { buildKnowledgeSearchArtifacts } from './policy-knowledge.service.mjs';

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash';
const DEFAULT_FALLBACK_MODEL = 'deepseek-v4-flash';
const DEFAULT_DEEPSEEK_REASONING_EFFORT = 'high';
const DEEPSEEK_V4_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_ANALYSIS_MAX_TOKENS = 3200;
const DEFAULT_DISCOVERY_MAX_TOKENS = 1000;
const DEFAULT_POLICY_ANALYSIS_SMART_SEARCH_ENABLED = true;
const DEFAULT_POLICY_ANALYSIS_SMART_SEARCH_TIMEOUT_MS = 25_000;
const DEFAULT_POLICY_ANALYSIS_SMART_SEARCH_MAX_RESULTS = 5;
const DEFAULT_SKILL_ROUTER_MAX_TOKENS = 900;
const DEFAULT_DISCLAIMER = '本分析基于保单摘录和OCR识别结果生成，不替代完整条款、投保须知、健康告知及正式理赔审核结论。';
const MAX_OCR_PROMPT_CHARS = 4000;
const MAX_SEARCH_PAGE_TEXT_CHARS = 2600;
const MAX_SEARCH_PDF_BYTES = 1_500_000;
const POLICY_ANALYSIS_SKILLS = {
  responsibility_extraction: {
    label: '保险责任拆解',
    routerDescription: '从保险责任、条款、利益页中逐条拆出保险金/给付/赔付/报销责任。',
    promptRule:
      '逐条拆分保险责任；不同触发条件、阶段给付、额外给付、豁免责任不得合并成一行。',
  },
  indicator_quantification: {
    label: '指标量化',
    routerDescription: '把责任拆成可计算指标字段、公式、计算基准、比例/倍数和缺失输入。',
    promptRule:
      '每条责任必须尽量补齐 liability、triggerCondition、formulaText、basis、value、unit、cashflowTreatment、requiredInputs、calculationEligible、calculationReason。',
  },
  uploaded_ocr_fallback: {
    label: '上传OCR兜底',
    routerDescription: '产品名或RAG未命中时，仍基于用户上传OCR保守提炼责任。',
    promptRule:
      '若上传OCR中能看到责任名称、触发条件、给付规则、比例、倍数、等待期或领取条件，即使未命中官方RAG，也要基于OCR先生成责任和指标候选，并用 sourceExcerpt 摘录OCR证据。',
  },
  official_rag_grounding: {
    label: '官方RAG核对',
    routerDescription: '用保险公司官方资料核对产品责任和条款口径。',
    promptRule:
      '产品资料为保险公司官方或本地官方知识库时，用其核对责任名称和条款口径；个单保额、保费、缴费期、保险期间仍以结构化保单字段和上传OCR为准。',
  },
  external_reference_review: {
    label: '非官方资料审慎核验',
    routerDescription: '只有外部辅助资料时保守解析，并提示需保险公司确认。',
    promptRule:
      '只有非官方或外部辅助资料时，不推断金额、比例、等待期、领取年龄；note 必须说明需保险公司或正式合同确认。',
  },
  benefit_schedule: {
    label: '利益/领取计划拆解',
    routerDescription: '识别年金、生存金、满期金、祝寿金、养老金等领取型责任。',
    promptRule:
      '年金、生存金、满期金、祝寿金、养老金等领取责任要写明领取年龄/保单年度、领取频率、领取公式和需要的领取计划表输入。',
  },
  cash_value_reference: {
    label: '现金价值资料识别',
    routerDescription: '识别现金价值、减保、保单贷款等机制，但避免误作保险责任。',
    promptRule:
      '现金价值、减保、保单贷款、自动垫交等仅作为责任公式或客户参考资料，不得单独作为 coverageTable 责任行；若某责任公式依赖现金价值，写入 basis 和 requiredInputs。',
  },
};
const POLICY_ANALYSIS_SKILL_KEYS = Object.keys(POLICY_ANALYSIS_SKILLS);
const NEW_CHINA_PRODUCT_DISCLOSURE_URLS = [
  'https://www.newchinalife.com/info/4596',
  'https://www.newchinalife.com/info/3279_23',
];
const GENERIC_COVERAGE_PATTERN = /需以正式条款核对|条款页未完整识别|当前只识别到责任名称|缺失字段已按未完整识别处理/u;
const ACTUAL_COVERAGE_TYPE_PATTERN =
  /保险金(?!额)|豁免|给付|赔付|报销|津贴|身故|全残|重大疾病|重疾|轻症|中症|疾病|意外|医疗|住院|门诊|年金|生存金|满期|祝寿金|养老金|教育金/u;
const PRODUCT_MECHANISM_TYPE_PATTERN =
  /^(?:保单)?(?:红利|分红|红利分配|累积红利|现金红利)|^有效(?:保险金额|保额)|(?:保险金额|保额)(?:递增|增长)|现金价值|减保|保单贷款|自动垫交|减额交清|账户价值/u;
const INSURER_OFFICIAL_PROFILES = [
  {
    id: 'new_china_life',
    aliases: ['新华', '新华人寿', '新华保险'],
    companyAliases: ['新华人寿', '新华保险'],
    siteDomains: ['newchinalife.com', 'static-cdn.newchinalife.com'],
    officialDomains: ['newchinalife.com', 'static-cdn.newchinalife.com'],
  },
  {
    id: 'china_life',
    aliases: ['中国人寿', '国寿'],
    companyAliases: ['中国人寿', '中国人寿保险股份有限公司', '国寿'],
    siteDomains: ['e-chinalife.com'],
    officialDomains: ['e-chinalife.com'],
  },
  {
    id: 'china_united_life',
    aliases: ['中华人寿', '中华联合人寿', '中华保险'],
    companyAliases: ['中华人寿', '中华联合人寿', '中华联合人寿保险股份有限公司'],
    siteDomains: ['life.cic.cn', 'faos-static-prd.life.cic.cn'],
    officialDomains: ['life.cic.cn', 'faos-static-prd.life.cic.cn', 'static.life.cic.cn'],
  },
  {
    id: 'lian_life',
    aliases: ['利安人寿', '利安保险', '利安'],
    companyAliases: ['利安人寿', '利安人寿保险股份有限公司'],
    siteDomains: ['lianlife.com', 'www.lianlife.com'],
    officialDomains: ['lianlife.com', 'www.lianlife.com'],
  },
  {
    id: 'ping_an_life',
    aliases: ['中国平安', '平安人寿', '平安保险', '平安'],
    companyAliases: ['中国平安', '中国平安人寿', '平安人寿', '平安保险'],
    siteDomains: ['pingan.com', 'life.pingan.com'],
    officialDomains: ['pingan.com', 'life.pingan.com', 'health.pingan.com'],
  },
  {
    id: 'cpic_life',
    aliases: ['太保寿险', '太平洋人寿', '中国太平洋人寿'],
    companyAliases: ['太保寿险', '太平洋人寿', '中国太平洋人寿', '中国太平洋人寿保险股份有限公司'],
    siteDomains: ['life.cpic.com.cn'],
    officialDomains: ['life.cpic.com.cn'],
  },
  {
    id: 'cpic_group',
    aliases: ['中国太保', '太平洋保险', '太保'],
    companyAliases: ['中国太保', '太平洋保险', '中国太平洋保险集团'],
    siteDomains: ['cpic.com.cn'],
    officialDomains: ['cpic.com.cn'],
  },
  {
    id: 'taikang_life',
    aliases: ['泰康', '泰康人寿', '泰康保险'],
    companyAliases: ['泰康人寿', '泰康保险'],
    siteDomains: ['taikang.com', 'taikanglife.com'],
    officialDomains: ['taikang.com', 'taikanglife.com', 'www.taikanglife.com'],
  },
  {
    id: 'china_taiping_life',
    aliases: ['中国太平', '太平人寿', '太平保险', '太平'],
    companyAliases: ['中国太平', '太平人寿', '太平保险'],
    siteDomains: ['cntaiping.com', 'life.cntaiping.com'],
    officialDomains: ['cntaiping.com', 'life.cntaiping.com', 'tpwx.life.cntaiping.com'],
  },
  {
    id: 'picc_life',
    aliases: ['中国人民保险', '中国人民人寿', '人保寿险', '人保', 'PICC'],
    companyAliases: ['中国人民保险', '中国人民人寿', '人保寿险', '人保'],
    siteDomains: ['picclife.com', 'picc.com.cn', 'picc.com'],
    officialDomains: ['picclife.com', 'picc.com.cn', 'picc.com'],
  },
  {
    id: 'sunshine_life',
    aliases: ['阳光人寿', '阳光保险', '阳光'],
    companyAliases: ['阳光人寿', '阳光保险'],
    siteDomains: ['sinosig.com', 'life.sinosig.com', 'static.sinosig.com'],
    officialDomains: ['sinosig.com', 'life.sinosig.com', 'static.sinosig.com'],
  },
  {
    id: 'aia_china',
    aliases: ['友邦人寿', '友邦保险', '友邦', 'AIA'],
    companyAliases: ['友邦人寿', '友邦保险', '友邦'],
    siteDomains: ['aia.com.cn', 'mysit.aia.com.cn'],
    officialDomains: ['aia.com.cn', 'mysit.aia.com.cn'],
  },
  {
    id: 'china_post_life',
    aliases: ['中邮人寿', '中邮保险', '中邮', '中国邮政保险'],
    companyAliases: ['中邮人寿', '中邮保险'],
    siteDomains: ['chinapost-life.com'],
    officialDomains: ['chinapost-life.com'],
  },
  {
    id: 'dajia_life',
    aliases: ['大家人寿', '大家保险', '大家'],
    companyAliases: ['大家人寿', '大家保险'],
    siteDomains: ['djbx.com', 'life.djbx.com'],
    officialDomains: ['djbx.com', 'life.djbx.com'],
  },
  {
    id: 'funde_sino_life',
    aliases: ['富德生命', '富德生命人寿', '生命人寿'],
    companyAliases: ['富德生命人寿', '富德生命', '生命人寿'],
    siteDomains: ['sino-life.com'],
    officialDomains: ['sino-life.com', 'm.sino-life.com'],
  },
  {
    id: 'manulife_sinochem_life',
    aliases: ['中宏', '中宏人寿', '中宏保险'],
    companyAliases: ['中宏人寿', '中宏保险', '中宏人寿保险有限公司'],
    siteDomains: ['manulife-sinochem.com'],
    officialDomains: ['manulife-sinochem.com'],
  },
  {
    id: 'generali_china_life',
    aliases: ['中意', '中意人寿', '中意保险'],
    companyAliases: ['中意人寿', '中意保险', '中意人寿保险有限公司'],
    siteDomains: ['generalichina.com'],
    officialDomains: ['generalichina.com'],
  },
  {
    id: 'metlife_china_life',
    aliases: ['大都会', '大都会人寿', '中美联泰', '中美联泰大都会'],
    companyAliases: ['大都会人寿', '中美联泰大都会人寿', '中美联泰大都会人寿保险有限公司'],
    siteDomains: ['metlife.com.cn'],
    officialDomains: ['metlife.com.cn'],
  },
  {
    id: 'cathay_lujiazui_life',
    aliases: ['陆家嘴', '陆家嘴国泰', '国泰人寿'],
    companyAliases: ['陆家嘴国泰', '陆家嘴国泰人寿', '陆家嘴国泰人寿保险有限责任公司'],
    siteDomains: ['cathaylife.cn'],
    officialDomains: ['cathaylife.cn'],
  },
  {
    id: 'cigna_cmb_life',
    aliases: ['招商信诺', '信诺人寿'],
    companyAliases: ['招商信诺', '招商信诺人寿', '招商信诺人寿保险有限公司'],
    siteDomains: ['cignacmb.com'],
    officialDomains: ['cignacmb.com'],
  },
  {
    id: 'cmrh_life',
    aliases: ['招商仁和', '招商仁和人寿', '招商局仁和'],
    companyAliases: ['招商仁和人寿', '招商局仁和人寿', '招商局仁和人寿保险股份有限公司'],
    siteDomains: ['cmrh.com', 'cos.cmrh.com'],
    officialDomains: ['cmrh.com', 'cos.cmrh.com'],
  },
  {
    id: 'icbc_axa_life',
    aliases: ['工银安盛', '工银安盛人寿'],
    companyAliases: ['工银安盛', '工银安盛人寿', '工银安盛人寿保险有限公司'],
    siteDomains: ['icbc-axa.com'],
    officialDomains: ['icbc-axa.com'],
  },
  {
    id: 'aviva_cofco_life',
    aliases: ['中英', '中英人寿'],
    companyAliases: ['中英人寿', '中英人寿保险有限公司'],
    siteDomains: ['aviva-cofco.com.cn', 'static.aviva-cofco.com.cn'],
    officialDomains: ['aviva-cofco.com.cn', 'static.aviva-cofco.com.cn'],
  },
  {
    id: 'sunlife_everbright_life',
    aliases: ['光大永明', '光大永明人寿'],
    companyAliases: ['光大永明', '光大永明人寿', '光大永明人寿保险有限公司'],
    siteDomains: ['sunlife-everbright.com'],
    officialDomains: ['sunlife-everbright.com'],
  },
  {
    id: 'ccb_life',
    aliases: ['建信', '建信人寿'],
    companyAliases: ['建信人寿', '建信人寿保险股份有限公司'],
    siteDomains: ['ccb-life.com.cn'],
    officialDomains: ['ccb-life.com.cn'],
  },
  {
    id: 'haibao_life',
    aliases: ['海保', '海保人寿'],
    companyAliases: ['海保人寿', '海保人寿保险股份有限公司'],
    siteDomains: ['haibao-life.com', 'www.haibao-life.com'],
    officialDomains: ['haibao-life.com', 'www.haibao-life.com'],
  },
  {
    id: 'abc_life',
    aliases: ['农银', '农银人寿'],
    companyAliases: ['农银人寿', '农银人寿保险股份有限公司'],
    siteDomains: ['abchinalife.cn', 'abchinalife.com'],
    officialDomains: ['abchinalife.cn', 'abchinalife.com', 'www.abchinalife.com'],
  },
  {
    id: 'bocomm_life',
    aliases: ['交银', '交银人寿', '交银康联'],
    companyAliases: ['交银人寿', '交银康联', '交银人寿保险有限公司'],
    siteDomains: ['bocommlife.com'],
    officialDomains: ['bocommlife.com'],
  },
  {
    id: 'citic_prudential_life',
    aliases: ['中信保诚', '信诚人寿'],
    companyAliases: ['中信保诚', '中信保诚人寿', '信诚人寿'],
    siteDomains: ['citic-prudential.com.cn'],
    officialDomains: ['citic-prudential.com.cn', 'gwoss.citic-prudential.citic', 'ofcwbs-prd-bucket.oss-cn-beijing.aliyuncs.com'],
  },
  {
    id: 'hsbc_life_china',
    aliases: ['汇丰', '汇丰人寿'],
    companyAliases: ['汇丰人寿', '汇丰人寿保险有限公司'],
    siteDomains: ['hsbcinsurance.com.cn'],
    officialDomains: ['hsbcinsurance.com.cn'],
  },
  {
    id: 'huagui_life',
    aliases: ['华贵', '华贵人寿', '华贵保险'],
    companyAliases: ['华贵人寿', '华贵保险', '华贵人寿保险股份有限公司'],
    siteDomains: ['huaguilife.cn'],
    officialDomains: ['huaguilife.cn', 'www.huaguilife.cn'],
  },
  {
    id: 'huahui_life',
    aliases: ['华汇', '华汇人寿'],
    companyAliases: ['华汇人寿', '华汇人寿保险股份有限公司'],
    siteDomains: ['sciclife.com'],
    officialDomains: ['sciclife.com', 'www.sciclife.com'],
  },
  {
    id: 'rui_life',
    aliases: ['瑞众', '瑞众人寿', '华夏人寿'],
    companyAliases: ['瑞众人寿', '瑞众人寿保险有限责任公司', '华夏人寿'],
    siteDomains: ['ruiinsurance.com'],
    officialDomains: ['ruiinsurance.com'],
  },
  {
    id: 'union_life',
    aliases: ['合众', '合众人寿'],
    companyAliases: ['合众人寿', '合众人寿保险股份有限公司'],
    siteDomains: ['unionlife.com.cn'],
    officialDomains: ['unionlife.com.cn'],
  },
  {
    id: 'minsheng_life',
    aliases: ['民生', '民生人寿'],
    companyAliases: ['民生人寿', '民生人寿保险股份有限公司'],
    siteDomains: ['minshenglife.com'],
    officialDomains: ['minshenglife.com'],
  },
  {
    id: 'aeon_life',
    aliases: ['百年', '百年人寿'],
    companyAliases: ['百年人寿', '百年人寿保险股份有限公司'],
    siteDomains: ['aeonlife.com.cn'],
    officialDomains: ['aeonlife.com.cn'],
  },
  {
    id: 'greatwall_life',
    aliases: ['长城', '长城人寿'],
    companyAliases: ['长城人寿', '长城人寿保险股份有限公司'],
    siteDomains: ['greatlife.cn'],
    officialDomains: ['greatlife.cn'],
  },
  {
    id: 'happy_life',
    aliases: ['幸福', '幸福人寿'],
    companyAliases: ['幸福人寿', '幸福人寿保险股份有限公司'],
    siteDomains: ['happyinsurance.com.cn'],
    officialDomains: ['happyinsurance.com.cn'],
  },
  {
    id: 'xiaokang_life',
    aliases: ['小康', '小康人寿'],
    companyAliases: ['小康人寿', '小康人寿保险有限责任公司'],
    siteDomains: ['livit-life.com', 'www.livit-life.com'],
    officialDomains: ['livit-life.com', 'www.livit-life.com'],
  },
  {
    id: 'caixin_life',
    aliases: ['财信', '财信人寿', '财信吉祥', '财信吉祥人寿'],
    companyAliases: ['财信人寿', '财信吉祥人寿', '财信吉祥人寿保险股份有限公司'],
    siteDomains: ['life.hnchasing.com', 'hnchasing.com'],
    officialDomains: ['life.hnchasing.com', 'hnchasing.com'],
  },
  {
    id: 'guobao_life',
    aliases: ['国宝', '国宝人寿'],
    companyAliases: ['国宝人寿', '国宝人寿保险股份有限公司'],
    siteDomains: ['panda-assets.com'],
    officialDomains: ['panda-assets.com', 'www.panda-assets.com'],
  },
  {
    id: 'foresea_life',
    aliases: ['前海', '前海人寿'],
    companyAliases: ['前海人寿', '前海人寿保险股份有限公司'],
    siteDomains: ['foresealife.com'],
    officialDomains: ['foresealife.com'],
  },
  {
    id: 'pearl_river_life',
    aliases: ['珠江', '珠江人寿'],
    companyAliases: ['珠江人寿', '珠江人寿保险股份有限公司'],
    siteDomains: ['prlife.com.cn'],
    officialDomains: ['prlife.com.cn'],
  },
  {
    id: 'shanghai_life',
    aliases: ['上海人寿'],
    companyAliases: ['上海人寿', '上海人寿保险股份有限公司'],
    siteDomains: ['shanghailife.com.cn'],
    officialDomains: ['shanghailife.com.cn'],
  },
  {
    id: 'guohua_life',
    aliases: ['国华', '国华人寿'],
    companyAliases: ['国华人寿', '国华人寿保险股份有限公司'],
    siteDomains: ['95549.cn'],
    officialDomains: ['95549.cn'],
  },
  {
    id: 'sinatay_life',
    aliases: ['信泰', '信泰人寿'],
    companyAliases: ['信泰人寿', '信泰人寿保险股份有限公司'],
    siteDomains: ['sinatay.com', 'xintai.com'],
    officialDomains: ['sinatay.com', 'xintai.com'],
  },
  {
    id: 'yingda_life',
    aliases: ['英大', '英大人寿', '英大泰和'],
    companyAliases: ['英大人寿', '英大泰和人寿', '英大泰和人寿保险股份有限公司'],
    siteDomains: ['ydthlife.com', 'www.ydthlife.com'],
    officialDomains: ['ydthlife.com', 'www.ydthlife.com'],
  },
  {
    id: 'guolian_life',
    aliases: ['国联', '国联人寿'],
    companyAliases: ['国联人寿', '国联人寿保险股份有限公司'],
    siteDomains: ['guolian-life.com', 'eservice.guolian-life.com'],
    officialDomains: ['guolian-life.com', 'eservice.guolian-life.com'],
  },
  {
    id: 'pku_founder_life',
    aliases: ['北大方正', '方正人寿'],
    companyAliases: ['北大方正人寿', '北大方正人寿保险有限公司'],
    siteDomains: ['pkufi.com', 'wechat.pkufi.com', 'web-package.oss-cn-shanghai.aliyuncs.com'],
    officialDomains: ['pkufi.com', 'wechat.pkufi.com', 'web-package.oss-cn-shanghai.aliyuncs.com'],
  },
  {
    id: 'aegon_thtf_life',
    aliases: ['同方全球', '同方全球人寿'],
    companyAliases: ['同方全球人寿', '同方全球人寿保险有限公司'],
    siteDomains: ['aegonthtf.com'],
    officialDomains: ['aegonthtf.com', 'cmsweb.aegonthtf.com'],
  },
  {
    id: 'bobl_life',
    aliases: ['中荷', '中荷人寿'],
    companyAliases: ['中荷人寿', '中荷人寿保险有限公司'],
    siteDomains: ['bobl.com.cn', 'bob-cardif.com', 'www.bob-cardif.com'],
    officialDomains: ['bobl.com.cn', 'bob-cardif.com', 'www.bob-cardif.com'],
  },
  {
    id: 'hengansl_life',
    aliases: ['恒安标准', '恒安标准人寿'],
    companyAliases: ['恒安标准人寿', '恒安标准人寿保险有限公司'],
    siteDomains: ['hengansl.com'],
    officialDomains: ['hengansl.com'],
  },
  {
    id: 'hengqin_life',
    aliases: ['横琴', '横琴人寿'],
    companyAliases: ['横琴人寿', '横琴人寿保险有限公司'],
    siteDomains: ['hqins.cn', 'static.e-hqins.com', 'oss-cn-szfinance.aliyuncs.com'],
    officialDomains: ['hqins.cn', 'static.e-hqins.com', 'oss-cn-szfinance.aliyuncs.com'],
  },
  {
    id: 'hongkang_life',
    aliases: ['弘康', '弘康人寿'],
    companyAliases: ['弘康人寿', '弘康人寿保险股份有限公司'],
    siteDomains: ['hongkang-life.com'],
    officialDomains: ['hongkang-life.com'],
  },
  {
    id: 'fosun_prudential_life',
    aliases: ['复星保德信', '复星保德信人寿'],
    companyAliases: ['复星保德信人寿', '复星保德信人寿保险有限公司'],
    siteDomains: ['prudentialfosun.com.cn', 'pflife.com.cn', 'www.pflife.com.cn'],
    officialDomains: ['prudentialfosun.com.cn', 'pflife.com.cn', 'www.pflife.com.cn'],
  },
  {
    id: 'fosun_uhi_health',
    aliases: ['复星联合健康', '复星联合健康保险', '复星联合'],
    companyAliases: ['复星联合健康保险', '复星联合健康保险股份有限公司'],
    siteDomains: ['fosun-uhi.com', 'www.fosun-uhi.com', 'fosunuhi.com.cn', 'www.fosunuhi.com.cn'],
    officialDomains: ['fosun-uhi.com', 'www.fosun-uhi.com', 'fosunuhi.com.cn', 'www.fosunuhi.com.cn'],
  },
  {
    id: 'three_gorges_life',
    aliases: ['三峡', '三峡人寿'],
    companyAliases: ['三峡人寿', '三峡人寿保险股份有限公司'],
    siteDomains: ['tg-life.com'],
    officialDomains: ['tg-life.com'],
  },
  {
    id: 'beijing_life',
    aliases: ['北京人寿'],
    companyAliases: ['北京人寿', '北京人寿保险股份有限公司'],
    siteDomains: ['blife.com.cn', 'beijinglife.com.cn'],
    officialDomains: ['blife.com.cn', 'beijinglife.com.cn'],
  },
  {
    id: 'ruitai_life',
    aliases: ['瑞泰', '瑞泰人寿'],
    companyAliases: ['瑞泰人寿', '瑞泰人寿保险有限公司'],
    siteDomains: ['oldmutual-chnenergy.com', 'oldmutual-guodian.com'],
    officialDomains: ['oldmutual-chnenergy.com', 'oldmutual-guodian.com'],
  },
  {
    id: 'dingcheng_life',
    aliases: ['鼎诚', '鼎诚人寿'],
    companyAliases: ['鼎诚人寿', '鼎诚人寿保险有限责任公司'],
    siteDomains: ['dingchenglife.com.cn', 'www.dingchenglife.com.cn', 'dc-life.com.cn'],
    officialDomains: ['dingchenglife.com.cn', 'www.dingchenglife.com.cn', 'dc-life.com.cn'],
  },
  {
    id: 'boc_samsung_life',
    aliases: ['中银三星', '中银三星人寿'],
    companyAliases: ['中银三星人寿', '中银三星人寿保险有限公司'],
    siteDomains: ['boc-samsunglife.cn'],
    officialDomains: ['boc-samsunglife.cn'],
  },
  {
    id: 'soochow_life',
    aliases: ['东吴', '东吴人寿'],
    companyAliases: ['东吴人寿', '东吴人寿保险股份有限公司'],
    siteDomains: ['soochowlife.com', 'soochowlife.net', 'wx.e-soochowlife.com'],
    officialDomains: ['soochowlife.com', 'soochowlife.net', 'wx.e-soochowlife.com'],
  },
  {
    id: 'bohai_life',
    aliases: ['渤海', '渤海人寿'],
    companyAliases: ['渤海人寿', '渤海人寿保险股份有限公司'],
    siteDomains: ['bohailife.net'],
    officialDomains: ['bohailife.net'],
  },
  {
    id: 'junlong_life',
    aliases: ['君龙', '君龙人寿'],
    companyAliases: ['君龙人寿', '君龙人寿保险有限公司'],
    siteDomains: ['junlonglife.com.cn'],
    officialDomains: ['junlonglife.com.cn'],
  },
  {
    id: 'hetai_life',
    aliases: ['和泰', '和泰人寿'],
    companyAliases: ['和泰人寿', '和泰人寿保险股份有限公司'],
    siteDomains: ['htlic.com'],
    officialDomains: ['htlic.com'],
  },
  {
    id: 'guofu_life',
    aliases: ['国富', '国富人寿'],
    companyAliases: ['国富人寿', '国富人寿保险股份有限公司'],
    siteDomains: ['e-guofu.com', 'guofu-life.com.cn'],
    officialDomains: ['e-guofu.com', 'guofu-life.com.cn'],
  },
  {
    id: 'aixin_life',
    aliases: ['爱心', '爱心人寿'],
    companyAliases: ['爱心人寿', '爱心人寿保险股份有限公司'],
    siteDomains: ['aixin-ins.com'],
    officialDomains: ['aixin-ins.com'],
  },
  {
    id: 'zhongan_pnc',
    aliases: ['众安', '众安保险', '众安在线'],
    companyAliases: ['众安保险', '众安在线财产保险股份有限公司'],
    siteDomains: ['zhongan.com', 'www.zhongan.com'],
    officialDomains: ['zhongan.com', 'www.zhongan.com', 'static.zhongan.com'],
  },
];

function slugOfficialProfileId(value = '') {
  const normalized = trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/giu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 80);
  return normalized || `profile_${nowMs()}`;
}

export function normalizeOfficialDomainProfile(profile = {}) {
  const company = trimString(profile.company || profile.companyName || profile.name);
  const aliases = Array.from(
    new Set([
      company,
      ...(Array.isArray(profile.aliases) ? profile.aliases : []),
      ...(Array.isArray(profile.companyAliases) ? profile.companyAliases : []),
    ].map(trimString).filter(Boolean)),
  );
  const officialDomains = normalizeOfficialDomains(profile.officialDomains || profile.domains || profile.siteDomains);
  const siteDomains = normalizeOfficialDomains(profile.siteDomains || officialDomains);
  if (!aliases.length || !officialDomains.length) return null;
  return {
    id: trimString(profile.id) || slugOfficialProfileId(company || aliases[0]),
    company: company || aliases[0],
    aliases,
    companyAliases: Array.from(new Set([company || aliases[0], ...(profile.companyAliases || aliases)].map(trimString).filter(Boolean))),
    siteDomains: siteDomains.length ? siteDomains : officialDomains,
    officialDomains,
  };
}

export function getDefaultOfficialDomainProfiles() {
  return INSURER_OFFICIAL_PROFILES.map((profile) => normalizeOfficialDomainProfile(profile)).filter(Boolean);
}

export function mergeOfficialDomainProfiles(customProfiles = []) {
  const profilesById = new Map();
  for (const profile of getDefaultOfficialDomainProfiles()) {
    profilesById.set(profile.id, profile);
  }
  for (const profile of Array.isArray(customProfiles) ? customProfiles : []) {
    const normalized = normalizeOfficialDomainProfile(profile);
    if (normalized) profilesById.set(normalized.id, normalized);
  }
  return [...profilesById.values()];
}
const PUBLIC_AUTHORITY_OR_JUDICIAL_DOMAINS = ['gov.cn', 'court.gov.cn', 'cn.govopendata.com', 'pkulaw.com'];
const PUBLIC_AUTHORITY_SEARCH_DOMAINS = ['gov.cn', 'court.gov.cn', 'pkulaw.com'];

const analysisResponseSchema = z.object({
  report: z.string().trim().default(''),
  coverageTable: z
    .array(
      z.object({
        coverageType: z.string().trim().min(1),
        scenario: z.string().trim().min(1),
        payout: z.string().trim().min(1),
        note: z.string().trim().min(1),
      }).passthrough(),
    )
    .default([]),
  notes: z.array(z.string().trim().min(1)).default([]),
});

function isoNow() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function trimString(value) {
  return String(value || '').trim();
}

function toNumberString(value) {
  const raw = trimString(value);
  if (!raw) return '';
  const normalized = raw.replace(/[,\s]/g, '').replace(/[^\d.]/g, '');
  return normalized;
}

function normalizeOcrPromptText(value) {
  const raw = trimString(value);
  if (!raw) return '';
  if (raw.length <= MAX_OCR_PROMPT_CHARS) return raw;
  return `${raw.slice(0, MAX_OCR_PROMPT_CHARS)}\n...[OCR文本已截断，请以原图和正式条款核对]`;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendSensitiveTerm(terms, value) {
  const text = trimString(value)
    .replace(/[，。,；;].*$/u, '')
    .replace(/^(本人|配偶|子女|父母|先生|女士)$/u, '')
    .trim();
  if (!text || text.length < 2) return;
  if (/^(本人|配偶|子女|父母|先生|女士|终身|保险|保单|条款|责任)$/u.test(text)) return;
  terms.add(text);
}

function buildSensitiveTerms({ policy = {}, ocrText = '' } = {}) {
  const terms = new Set();
  appendSensitiveTerm(terms, policy?.applicant);
  appendSensitiveTerm(terms, policy?.insured);
  const raw = trimString(ocrText);
  if (!raw) return Array.from(terms);
  const patterns = [
    /投保人\s*[：:]\s*([^\n]+)/gu,
    /被保险人\s*[：:]\s*([^\n]+)/gu,
    /业务员\s*[：:]\s*([^\n]+)/gu,
    /投保人(?:和|、)?被保险人(?:均)?为([^\n，。,；;]+)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      appendSensitiveTerm(terms, match[1]);
    }
  }
  return Array.from(terms);
}

function redactSensitiveAnalysisText(value, sensitiveTerms = []) {
  const raw = trimString(value);
  if (!raw) return '';
  let redacted = raw
    .replace(/(投保人(?:和|、)?被保险人(?:均)?为)([^，。,；;\n]+)/gu, '$1[已脱敏]')
    .replace(/(投保人\s*[：:]\s*)([^\n]+)/gu, '$1[已脱敏]')
    .replace(/(被保险人\s*[：:]\s*)([^\n]+)/gu, '$1[已脱敏]')
    .replace(/(业务员\s*[：:]\s*)([^\n]+)/gu, '$1[已脱敏]')
    .replace(/((?:证件号码|身份证号?码?|居民身份证|身份证)\s*[：:]?\s*)([0-9Xx＊*]{8,})/gu, '$1[已脱敏]')
    .replace(/((?:手机号|手机号码|联系电话|联系电话号码|联系方式|电话)\s*[：:]?\s*)(1[3-9]\d{9}|\+?\d[\d\s-]{7,}\d)/gu, '$1[已脱敏]')
    .replace(/(?<!\d)(\d{17}[0-9Xx])(?!\d)/gu, '[身份证号已脱敏]')
    .replace(/(?<!\d)(1[3-9]\d{9})(?!\d)/gu, '[手机号已脱敏]');
  for (const term of sensitiveTerms) {
    if (!term) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(term), 'gu'), '[已脱敏]');
  }
  return redacted;
}

function normalizeLlmOcrPromptText(value, sensitiveTerms = []) {
  return normalizeOcrPromptText(redactSensitiveAnalysisText(value, sensitiveTerms));
}

function hasDetailedOcrEvidence(ocrText = '') {
  const normalized = normalizeLlmOcrPromptText(ocrText);
  if (!normalized) return false;
  return /【详情页\s*\d+/u.test(normalized) || /责任|保险金|给付|条款|赔付|豁免/u.test(normalized);
}

function hasExtendedPolicyContext(policy = {}, ocrText = '') {
  return Boolean(
    trimString(policy.participantSummary) ||
      trimString(policy.applicantRelation) ||
      trimString(policy.insuredRelation) ||
      trimString(policy.paymentPeriod) ||
      trimString(policy.coveragePeriod) ||
      normalizeLlmOcrPromptText(ocrText),
  );
}

function buildParticipantSummary(policy = {}) {
  const applicantRelation = trimString(policy.applicantRelation);
  const insuredRelation = trimString(policy.insuredRelation);
  if (!applicantRelation && !insuredRelation) return '';
  if (applicantRelation && insuredRelation && applicantRelation === insuredRelation) {
    return `投保人与被保险人与顶梁柱的关系均为${applicantRelation}`;
  }
  const parts = [];
  if (applicantRelation) parts.push(`投保人与顶梁柱的关系为${applicantRelation}`);
  if (insuredRelation) parts.push(`被保险人与顶梁柱的关系为${insuredRelation}`);
  return parts.join('；');
}

function normalizeComparableFact(value) {
  return trimString(value)
    .replace(/[（(][^）)]*[）)]/gu, '')
    .replace(/\s+/gu, '')
    .replace(/[：:]/gu, '')
    .replace(/[^\p{Script=Han}\p{Letter}\p{Number}]/gu, '')
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&#(\d+);/gu, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripHtml(value) {
  return trimString(
    decodeHtmlEntities(String(value || ''))
      .replace(/<script[\s\S]*?<\/script>/giu, ' ')
      .replace(/<style[\s\S]*?<\/style>/giu, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/giu, ' ')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/gu, ' '),
  );
}

function isCoreFactConflict(left, right) {
  const normalizedLeft = normalizeComparableFact(left);
  const normalizedRight = normalizeComparableFact(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return false;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return false;
  return true;
}

function parseComparableMoney(value) {
  const normalized = Number(toNumberString(value));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 0;
}

function isMoneyConflict(left, right) {
  const normalizedLeft = parseComparableMoney(left);
  const normalizedRight = parseComparableMoney(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return Math.abs(normalizedLeft - normalizedRight) > Math.max(1, normalizedLeft * 0.01);
}

function extractOcrProductName(raw = '') {
  const lines = String(raw || '')
    .split(/\r?\n/u)
    .map((line) => trimString(line))
    .filter(Boolean);
  const stopPattern =
    /^(保险利益表|保险期间|交费方式|缴费方式|基本保险金额|保险金额|投保人|被保险人|合同生效日期|证件号码|特别约定|保险单说明|服务电话|业务员|保单制作日期)/u;
  for (let index = 0; index < lines.length; index += 1) {
    if (!/(险种名称|保险产品名称|保险产品)/u.test(lines[index])) continue;
    const collected = [];
    for (let cursor = index + 1; cursor < lines.length && collected.length < 3; cursor += 1) {
      const candidate = lines[cursor];
      if (!candidate || stopPattern.test(candidate)) break;
      collected.push(candidate);
    }
    if (collected.length) return collected.join(' ');
  }
  return '';
}

function extractOcrField(raw = '', label = '') {
  if (!label) return '';
  const match = String(raw || '').match(new RegExp(`${label}\\s*[：:]\\s*([^\\n]+)`, 'u'));
  return trimString(match?.[1] || '');
}

function extractOcrAmount(raw = '') {
  const text = String(raw || '');
  const blockMatch =
    text.match(/基本保险金额[^\n]*\n([0-9.,]+)\s*元/u) ||
    text.match(/基本保险金额[^\n]*?([0-9.,]+)\s*元/u);
  return trimString(blockMatch?.[1] || '');
}

function extractOcrFirstPremium(raw = '') {
  const text = String(raw || '');
  const match =
    text.match(/首期保险费合计[^\n]*?([0-9.,]+)\s*元/u) ||
    text.match(/每年\s*([0-9.,]+)\s*元/u);
  return trimString(match?.[1] || '');
}

function summarizeOcrConflict(policy = {}, ocrText = '') {
  const raw = trimString(ocrText);
  if (!raw) return null;
  const conflicts = [];
  const ocrApplicant = extractOcrField(raw, '投保人');
  const ocrInsured = extractOcrField(raw, '被保险人');
  const ocrProductName = extractOcrProductName(raw);
  const ocrAmount = extractOcrAmount(raw);
  const ocrFirstPremium = extractOcrFirstPremium(raw);

  if (isCoreFactConflict(policy.name, ocrProductName)) conflicts.push('保险产品');
  if (isCoreFactConflict(policy.applicant, ocrApplicant)) conflicts.push('投保人');
  if (isCoreFactConflict(policy.insured, ocrInsured)) conflicts.push('被保险人');
  if (isMoneyConflict(policy.amount, ocrAmount)) conflicts.push('保额');
  if (isMoneyConflict(policy.firstPremium, ocrFirstPremium)) conflicts.push('保费');

  const uniqueConflicts = Array.from(new Set(conflicts));
  const severe =
    uniqueConflicts.length >= 2 ||
    (uniqueConflicts.includes('保险产品') &&
      (uniqueConflicts.includes('投保人') ||
        uniqueConflicts.includes('被保险人') ||
        uniqueConflicts.includes('保额') ||
        uniqueConflicts.includes('保费')));

  if (!severe) return null;
  return `检测到OCR与当前保单的${uniqueConflicts.join('、')}存在明显冲突，本次分析按当前保单已确认字段为准，忽略这份冲突OCR内容。`;
}

function normalizePolicyForPrompt(policy = {}) {
  return {
    company: trimString(policy.company),
    name: trimString(policy.name),
    applicant: trimString(policy.applicant),
    insured: trimString(policy.insured),
    date: trimString(policy.date || policy.periodStart),
    type: trimString(policy.type),
    amount: toNumberString(policy.amount),
    firstPremium: toNumberString(policy.firstPremium || policy.annualPremium),
    participantSummary: buildParticipantSummary(policy),
    applicantRelation: trimString(policy.applicantRelation),
    insuredRelation: trimString(policy.insuredRelation),
    paymentPeriod: trimString(policy.paymentPeriod),
    coveragePeriod: trimString(policy.coveragePeriod),
    responsibilities: Array.isArray(policy.responsibilities)
      ? policy.responsibilities
          .map((item) => ({
            name: trimString(item?.name),
            desc: trimString(item?.desc),
            limit: toNumberString(item?.limit),
          }))
          .filter((item) => item.name)
      : [],
  };
}

function stripSensitivePolicyForLlm(policy = {}) {
  return {
    ...policy,
    applicant: '',
    insured: '',
  };
}

function getConfig() {
  const timeoutCandidate = Number(process.env.DEEPSEEK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const model = trimString(process.env.DEEPSEEK_MODEL) || DEFAULT_DEEPSEEK_MODEL;
  const fallbackModel =
    trimString(process.env.DEEPSEEK_FALLBACK_MODEL) || (model === 'deepseek-reasoner' ? DEFAULT_FALLBACK_MODEL : '');
  const smartSearchTimeoutCandidate = Number(
    process.env.POLICY_ANALYSIS_SMART_SEARCH_TIMEOUT_MS || DEFAULT_POLICY_ANALYSIS_SMART_SEARCH_TIMEOUT_MS,
  );
  const smartSearchMaxResultsCandidate = Number(
    process.env.POLICY_ANALYSIS_SMART_SEARCH_MAX_RESULTS || DEFAULT_POLICY_ANALYSIS_SMART_SEARCH_MAX_RESULTS,
  );
  return {
    apiKey: trimString(process.env.DEEPSEEK_API_KEY),
    baseUrl: trimString(process.env.DEEPSEEK_BASE_URL) || DEFAULT_DEEPSEEK_BASE_URL,
    model,
    fallbackModel,
    timeoutMs: Number.isFinite(timeoutCandidate) ? Math.max(5_000, timeoutCandidate) : DEFAULT_TIMEOUT_MS,
    smartSearchEnabled:
      trimString(process.env.POLICY_ANALYSIS_SMART_SEARCH_ENABLED).toLowerCase() !== 'false'
      && DEFAULT_POLICY_ANALYSIS_SMART_SEARCH_ENABLED,
    smartSearchTimeoutMs: Number.isFinite(smartSearchTimeoutCandidate)
      ? Math.max(3_000, smartSearchTimeoutCandidate)
      : DEFAULT_POLICY_ANALYSIS_SMART_SEARCH_TIMEOUT_MS,
    smartSearchMaxResults: Number.isFinite(smartSearchMaxResultsCandidate)
      ? Math.max(1, Math.min(5, smartSearchMaxResultsCandidate))
      : DEFAULT_POLICY_ANALYSIS_SMART_SEARCH_MAX_RESULTS,
  };
}

function isDeepSeekV4Model(model) {
  return DEEPSEEK_V4_MODELS.has(trimString(model));
}

function usesDeepSeekThinkingMode(model) {
  const value = trimString(model);
  return value === 'deepseek-reasoner' || isDeepSeekV4Model(value);
}

function buildAnalysisResult({ analysis, modelOutput = null, sources = [] }) {
  return {
    ...(analysis || {}),
    analysis,
    modelOutput,
    sources: Array.isArray(sources) ? sources : [],
  };
}

function extractJson(content) {
  const raw = trimString(content);
  if (!raw) throw withCode(new Error('POLICY_ANALYSIS_EMPTY'), 'POLICY_ANALYSIS_EMPTY');
  try {
    return JSON.parse(raw);
  } catch {
    // Fall back to extracting the first JSON object from mixed model output.
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const candidate = raw.slice(start, end + 1);
    return JSON.parse(candidate);
  }
  throw withCode(new Error('POLICY_ANALYSIS_INVALID_JSON'), 'POLICY_ANALYSIS_INVALID_JSON');
}

function normalizeInsightList(items = []) {
  if (typeof items === 'string') {
    return trimString(items)
      .split(/\n+|(?=\d+[.、]\s*)|(?=[一二三四五六七八九十]+[、.]\s*)/u)
      .map((item) => trimString(item).replace(/^[-*•]\s*/u, '').replace(/^\d+[.、]\s*/u, '').replace(/^[一二三四五六七八九十]+[、.]\s*/u, ''))
      .filter(Boolean);
  }
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === 'string') return trimString(item);
      if (!item || typeof item !== 'object') return '';
      return trimString(item.text || item.detail || item.title || item.label || item.content || item.message || item.reason);
    })
    .filter(Boolean);
}

function redactAnalysisTextList(items = []) {
  return items.filter(Boolean);
}

function removeSourceDisclosureText(value) {
  const raw = trimString(value);
  if (!raw) return '';
  return raw
    .replace(/基于已上传条款页OCR整理[，,。]*缺失字段已按未完整识别处理[，,。]*/gu, '需结合完整合同条款核对。')
    .replace(/基于(?:已上传|上传的)?(?:条款页|保单)?OCR整理[，,。]*/gu, '')
    .replace(/缺失字段已按未完整识别处理[，,。]*/gu, '需结合完整合同条款核对。')
    .replace(/根据(?:联网|网络|网页|搜索|检索)(?:到的)?(?:产品资料|公开信息|资料摘要|摘要|结果)?[，,。]*/gu, '')
    .replace(/(?:联网|网络|网页)?(?:搜索|检索)到的(?:产品资料|公开信息|资料摘要|摘要|结果)(?:摘要)?/gu, '产品资料')
    .replace(/联网(?:产品资料|公开信息|资料摘要|摘要|结果)/gu, '产品资料')
    .replace(/(?:联网|网络|网页|搜索|检索)(?:到的)?(?:产品资料|公开信息|资料摘要|摘要|结果)/gu, '产品资料')
    .replace(/本分析基于产品资料[，,。]*不替代正式合同条款[，,。]*/gu, '本分析不替代正式合同条款。')
    .replace(/本分析基于已整理的产品资料和保单信息生成[，,。]*/gu, '本分析基于保单信息生成，')
    .replace(/[ \t]+/gu, ' ')
    .trim();
}

function normalizeParagraph(value) {
  if (typeof value === 'string') return trimString(value);
  if (Array.isArray(value)) return normalizeInsightList(value).join('\n');
  if (!value || typeof value !== 'object') return '';
  return trimString(value.text || value.detail || value.description || value.content || value.message || value.reason);
}

function normalizeAnalysisNotes(payload = {}) {
  return normalizeInsightList(
    payload.notes
      || payload.attentions
      || payload.customerNotes
      || payload.riskNotes
      || payload.riskAlerts
      || payload.risks
      || payload.riskWarnings
      || payload.exclusions
      || payload.purchaseAdvice
      || payload.advisorSuggestions
      || payload.serviceSuggestions
      || payload.nextActions
      || payload.disclaimer
      || payload.notice,
  ).slice(0, 6);
}

function appendNotesSection(report, notes = []) {
  const base = trimString(report);
  const cleanNotes = normalizeInsightList(notes).filter(Boolean);
  if (!base || !cleanNotes.length) return base;
  const missingNotes = cleanNotes.filter((note) => !base.includes(note));
  if (!missingNotes.length) return base;
  const existingNoteCount = (base.match(/(?:^|\n)\d+\./gu) || []).length;
  const formattedNotes = missingNotes.map((note, index) => `${existingNoteCount + index + 1}. ${note}`).join('\n');
  if (/注意事项|客户需关注|重要提醒/u.test(base)) return `${base}\n${formattedNotes}`;
  return `${base}\n\n注意事项\n${formattedNotes}`;
}

function buildReportFromStructuredPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return '';
  const notes = normalizeAnalysisNotes(payload);
  const overview = normalizeParagraph(
    payload.report
      || payload.reportText
      || payload.analysisReport
      || payload.reportMarkdown
      || payload.productOverview
      || payload.policyPositioning
      || payload.positioningSummary
      || payload.summary
      || payload.overview
      || payload.conclusion
      || payload.coreFeature
      || payload.policySummary
      || payload.coreSellingPoint
      || payload.positioning
      || payload.responsibilityHighlights,
  );
  const report = /^保单概览/u.test(overview) ? overview : `保单概览\n${overview}`;
  return appendNotesSection(report, notes);
}

function extractDetailPart(detail, label) {
  const raw = trimString(detail);
  if (!raw) return '';
  const match = raw.match(new RegExp(`${label}[：:]\\s*([^；;]+)`));
  return trimString(match?.[1] || '');
}

function normalizeCoverageNoteText(note, { scenario = '', payout = '' } = {}) {
  const text = trimString(note);
  if (!text) return '';
  if (/^(本)?合同终止$/.test(text)) {
    return `给付该项保险金后，合同终止，这张保单后续不再继续有效。${trimString(payout) ? `本次给付口径：${trimString(payout)}。` : ''}`;
  }
  if (/^(本)?合同中止$/.test(text)) {
    return '这通常表示保单暂时中止生效，在恢复合同前，相关保障不会继续生效。';
  }
  if (/^责任终止$/.test(text)) {
    return `给付完这一项责任后，这一项保障责任就结束了，后续不再重复按同一责任继续赔付。${trimString(scenario) ? `适用情形：${trimString(scenario)}。` : ''}`;
  }
  return text;
}

function normalizedCoverageRowExtras(item = {}) {
  const valueNumber = Number(item.value);
  const extras = {
    liability: trimString(item.liability || item.responsibilityName || item.benefitName),
    responsibilityName: trimString(item.responsibilityName),
    benefitName: trimString(item.benefitName),
    triggerCondition: trimString(item.triggerCondition || item.condition),
    condition: trimString(item.condition),
    formulaText: trimString(item.formulaText || item.formula || item.calculationFormula),
    basis: trimString(item.basis || item.calculationBasis),
    basisKey: trimString(item.basisKey),
    calculationKey: trimString(item.calculationKey),
    value: Number.isFinite(valueNumber) ? valueNumber : undefined,
    valueText: trimString(item.valueText),
    unit: trimString(item.unit),
    requiredInputs: Array.isArray(item.requiredInputs) ? item.requiredInputs.map(trimString).filter(Boolean) : undefined,
    cashflowTreatment: trimString(item.cashflowTreatment),
    calculationStatus: trimString(item.calculationStatus),
    calculationEligible: typeof item.calculationEligible === 'boolean' ? item.calculationEligible : undefined,
    calculationReason: trimString(item.calculationReason),
    sourceExcerpt: trimString(item.sourceExcerpt || item.sourceText || item.evidenceExcerpt),
    responsibilityScope: trimString(item.responsibilityScope),
    selectionStatus: trimString(item.selectionStatus),
    selectionEvidence: trimString(item.selectionEvidence),
  };
  return Object.fromEntries(
    Object.entries(extras).filter(([, value]) => value !== undefined && value !== ''),
  );
}

function sanitizeModelCoverageRow(row = {}, sensitiveTerms = []) {
  const cleanText = (value) => removeSourceDisclosureText(redactSensitiveAnalysisText(value, sensitiveTerms));
  const output = {
    coverageType: cleanText(row.coverageType),
    scenario: cleanText(row.scenario),
    payout: cleanText(row.payout),
    note: cleanText(row.note),
  };
  for (const key of [
    'liability',
    'responsibilityName',
    'benefitName',
    'triggerCondition',
    'condition',
    'formulaText',
    'basis',
    'basisKey',
    'calculationKey',
    'valueText',
    'unit',
    'cashflowTreatment',
    'calculationStatus',
    'calculationReason',
    'sourceExcerpt',
    'responsibilityScope',
    'selectionStatus',
    'selectionEvidence',
  ]) {
    const value = trimString(row[key]);
    if (value) output[key] = cleanText(value);
  }
  if (typeof row.value === 'number' && Number.isFinite(row.value)) output.value = row.value;
  if (Array.isArray(row.requiredInputs)) output.requiredInputs = row.requiredInputs.map(trimString).filter(Boolean);
  if (typeof row.calculationEligible === 'boolean') output.calculationEligible = row.calculationEligible;
  return output;
}

function normalizeCoverageTable(items = [], { preferDirectContractLanguage = false } = {}) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (!item) return null;
      if (typeof item === 'string') {
        const coverageType = trimString(item);
        if (!coverageType) return null;
        return {
          coverageType,
          scenario: preferDirectContractLanguage ? '条款页未完整识别到触发情形' : '需以正式条款核对',
          payout: preferDirectContractLanguage ? '条款页未完整识别到给付金额' : '需以正式条款核对',
          note: preferDirectContractLanguage ? '当前只识别到责任名称，需继续补充对应条款页。' : '当前只有责任名称，具体责任需以正式条款核对。',
        };
      }
      if (typeof item !== 'object') return null;
      const coverageType = trimString(item.coverageType || item.title || item.name || item.label || item.heading);
      const detail = trimString(item.detail || item.desc || item.description || item.text || item.content);
      const scenario = trimString(item.scenario || extractDetailPart(detail, '保障情形'));
      const payout = trimString(item.payout || item.amount || item.limit || extractDetailPart(detail, '赔付金额'));
      const note = normalizeCoverageNoteText(trimString(item.note || item.explanation || extractDetailPart(detail, '说明')), {
        scenario,
        payout,
      });
      const extras = normalizedCoverageRowExtras(item);
      if (!coverageType && !detail) return null;
      return {
        coverageType: coverageType || '责任项',
        scenario: scenario || (preferDirectContractLanguage ? '条款页未完整识别到触发情形' : '需以正式条款核对'),
        payout: payout || (preferDirectContractLanguage ? '条款页未完整识别到给付金额' : '需以正式条款核对'),
        note:
          note ||
          detail ||
          (preferDirectContractLanguage ? '基于已上传条款页OCR整理，缺失字段已按未完整识别处理。' : '需以正式条款核对。'),
        ...extras,
      };
    })
    .filter(Boolean);
}

function isProductMechanismCoverageRow(row) {
  const coverageType = trimString(row?.coverageType);
  if (!coverageType) return false;
  if (ACTUAL_COVERAGE_TYPE_PATTERN.test(coverageType)) return false;
  const combined = [row?.coverageType, row?.scenario, row?.payout, row?.note].map(trimString).filter(Boolean).join(' ');
  return PRODUCT_MECHANISM_TYPE_PATTERN.test(combined);
}

function formatProductMechanismNote(row) {
  const coverageType = trimString(row?.coverageType);
  const detail = [row?.scenario, row?.payout, row?.note]
    .map(trimString)
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index)
    .join('；');
  return detail ? `${coverageType}：${detail}` : coverageType;
}

function splitCoverageRowsAndMechanismNotes(rows = []) {
  const coverageTable = [];
  const mechanismNotes = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (isProductMechanismCoverageRow(row)) {
      const note = formatProductMechanismNote(row);
      if (note) mechanismNotes.push(note);
    } else {
      coverageTable.push(row);
    }
  }
  return { coverageTable, mechanismNotes };
}

function isGenericCoverageText(value) {
  return GENERIC_COVERAGE_PATTERN.test(trimString(value));
}

function shouldRunDetailOcrFollowup(analysisInput) {
  return analysisInput?.evidenceMode === 'detail_ocr' && Boolean(trimString(analysisInput?.ocrText));
}

function buildCoverageRefinementMessages({ policy, analysisInput, analysis }) {
  const rows = Array.isArray(analysis?.coverageTable) ? analysis.coverageTable : [];
  return [
    {
      role: 'system',
      content:
        '你是保险条款责任提炼助手。你只能基于用户提供的条款页/OCR文本，对已有责任表进行二次细化。不要重写产品概览，不要输出注意事项，只输出 JSON。JSON 只能包含 coverageTable 一个字段。coverageTable 只能写发生保险事故、达到领取条件或满足合同约定触发条件后的保险金/给付/赔付/报销责任，每行必须包含 coverageType、scenario、payout、note，并尽量补充指标拆解字段：liability、triggerCondition、formulaText、basis、value、unit、cashflowTreatment、calculationReason、requiredInputs、sourceExcerpt。所有保险责任都可以拆成指标候选，但字段名必须统一；依赖现金价值表、领取计划表、伤残比例表、实际医疗费用、实际住院天数或人工判断的责任，也要写出公式口径和 requiredInputs，并写 calculationEligible=false 与 calculationReason。sourceExcerpt 必须摘录能支持该责任和公式的原文短句，不得编造。分红、红利领取方式、现金价值、减保、保单贷款、自动垫交等产品利益机制不要作为 coverageTable 独立行；若有效保额递增或给付比例属于某条保险责任的计算公式，则写进该责任的 payout 和 formulaText。若 OCR 中能明确识别责任触发情形、给付规则、给付比例、满期返还条件、赔付倍数，就直接写明，不要再用“需以正式条款核对”兜底。note 必须用面向客户的解释性中文，不要只写“合同终止”“责任终止”“合同中止”这种术语标签，必须把它解释成这对客户意味着什么。只有在 OCR 文本确实没有给出该责任的关键内容时，才保留核对提醒。',
    },
    {
      role: 'user',
      content: `请基于以下条款页 OCR，对已有责任表做二次细化，只改写那些仍然过于保守或泛化的责任项。\n\n基础保单信息：\n保险公司：${policy.company || '未识别'}\n保险产品：${policy.name || '未识别'}\n投保时间：${policy.date || '未识别'}\n缴费期间：${policy.paymentPeriod || '未识别'}\n保障期间：${policy.coveragePeriod || '未识别'}\n\n当前责任表：\n${JSON.stringify(rows, null, 2)}\n\n详情页/条款页OCR：\n${analysisInput.ocrText}\n\n请输出更具体的 coverageTable。若某一责任在 OCR 中没有足够证据，再保留核对提醒。`,
    },
  ];
}

function mergeRefinedCoverageRows(baseRows = [], refinedRows = []) {
  if (!Array.isArray(baseRows) || !baseRows.length) return Array.isArray(refinedRows) ? refinedRows : [];
  const refinedMap = new Map(
    (Array.isArray(refinedRows) ? refinedRows : [])
      .filter((row) => trimString(row?.coverageType))
      .map((row) => [trimString(row.coverageType), row]),
  );
  return baseRows.map((row) => {
    const key = trimString(row?.coverageType);
    const refined = refinedMap.get(key);
    if (!refined) return row;
    const scenario = !isGenericCoverageText(refined.scenario) ? trimString(refined.scenario) : trimString(row.scenario);
    const payout = !isGenericCoverageText(refined.payout) ? trimString(refined.payout) : trimString(row.payout);
    const note = !isGenericCoverageText(refined.note) ? trimString(refined.note) : trimString(row.note);
    return {
      coverageType: key || trimString(refined.coverageType) || trimString(row.coverageType),
      scenario: scenario || trimString(row.scenario),
      payout: payout || trimString(row.payout),
      note: note || trimString(row.note),
      ...normalizedCoverageRowExtras(refined),
    };
  });
}

function normalizeAnalysis(payload, model, options = {}) {
  const sensitiveTerms = Array.isArray(options?.sensitiveTerms) ? options.sensitiveTerms : [];
  const { coverageTable } = splitCoverageRowsAndMechanismNotes(
    normalizeCoverageTable(
      payload?.coverageTable || payload?.mainCoverageBreakdown || payload?.primaryCoverageBreakdown || payload?.mainCoverage,
      options,
    ),
  );
  const normalizedPayload = {
    report: '',
    coverageTable,
    notes: [],
  };
  const parsed = analysisResponseSchema.parse(normalizedPayload);
  return {
    report: '',
    productOverview: '',
    coreFeature: '',
    coverageTable: parsed.coverageTable.slice(0, 12).map((row) => sanitizeModelCoverageRow(row, sensitiveTerms)),
    notes: [],
    purchaseAdvice: '',
    disclaimer: '',
    model: trimString(model) || DEFAULT_DEEPSEEK_MODEL,
    generatedAt: isoNow(),
    cached: false,
  };
}

function resolveGeneratedAt(value) {
  const text = trimString(value);
  if (!text) return isoNow();
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? isoNow() : parsed.toISOString();
}

export function sanitizeStoredPolicyAnalysis(analysis) {
  if (!analysis || typeof analysis !== 'object') return null;
  try {
    const sensitiveTerms = buildSensitiveTerms({
      policy: analysis?.structuredPolicy || analysis?.policy || analysis,
      ocrText: analysis?.ocrText,
    });
    const normalized = normalizeAnalysis(analysis, trimString(analysis.model) || DEFAULT_DEEPSEEK_MODEL, {
      sensitiveTerms,
    });
    return {
      ...normalized,
      generatedAt: resolveGeneratedAt(analysis.generatedAt),
      cached: false,
    };
  } catch {
    return null;
  }
}

function buildModelChain(config) {
  const seen = new Set();
  return [config.model, config.fallbackModel].filter((model) => {
    const value = trimString(model);
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function buildAnalysisInput({ policy, ocrText = '' }) {
  const sensitiveTerms = buildSensitiveTerms({ policy, ocrText });
  const ocrConflictSummary = summarizeOcrConflict(policy, ocrText);
  const effectiveOcrText = ocrConflictSummary ? '' : ocrText;
  const normalizedOcrText = normalizeLlmOcrPromptText(effectiveOcrText, sensitiveTerms);
  return {
    company: policy.company,
    name: policy.name,
    date: policy.date,
    amount: policy.amount,
    firstPremium: policy.firstPremium,
    participantSummary: policy.participantSummary,
    applicantRelation: policy.applicantRelation,
    insuredRelation: policy.insuredRelation,
    paymentPeriod: policy.paymentPeriod,
    coveragePeriod: policy.coveragePeriod,
    ocrText: normalizedOcrText,
    ocrConflictSummary,
    sensitiveTerms,
    evidenceMode: hasDetailedOcrEvidence(normalizedOcrText) ? 'detail_ocr' : 'basic',
    detailLevel: hasExtendedPolicyContext(policy, effectiveOcrText) ? 'full' : 'basic',
  };
}

function buildSearchPhrase(parts = []) {
  return parts.map((part) => trimString(part)).filter(Boolean).join(' ');
}

function domainMatches(hostname = '', domain = '') {
  const normalizedHost = trimString(hostname).toLowerCase();
  const normalizedDomain = trimString(domain).toLowerCase();
  if (!normalizedHost || !normalizedDomain) return false;
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function resolveUrlHostname(url = '') {
  try {
    return new URL(trimString(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeOfficialDomain(value = '') {
  const raw = trimString(value)
    .replace(/^官方域名(?:为|是)?/u, '')
    .replace(/^域名(?:为|是)?/u, '')
    .trim();
  if (!raw) return '';
  try {
    return new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    const match = raw.match(/(?:[a-z0-9-]+\.)+[a-z]{2,}/iu);
    return match ? match[0].toLowerCase().replace(/^www\./u, '') : '';
  }
}

function normalizeOfficialDomains(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(normalizeOfficialDomain).filter(Boolean)));
}

function resolveInsurerOfficialProfile(policy = {}, officialDomainProfiles = getDefaultOfficialDomainProfiles()) {
  const target = `${trimString(policy.company)} ${trimString(policy.name)}`;
  if (!target.trim()) return null;
  return (
    (officialDomainProfiles || []).find((profile) => (profile.aliases || []).some((alias) => target.includes(alias))) || null
  );
}

export function isPolicyOfficialSourceUrl(url = '', policy = {}, officialDomainProfiles = getDefaultOfficialDomainProfiles(), extraOfficialDomains = []) {
  const profile = resolveInsurerOfficialProfile(policy, officialDomainProfiles);
  const hostname = resolveUrlHostname(url);
  const profileDomains = normalizeOfficialDomains([...(profile?.officialDomains || []), ...(profile?.siteDomains || [])]);
  if (profileDomains.length) {
    return profileDomains.some((domain) => domainMatches(hostname, domain));
  }
  const extraDomains = normalizeOfficialDomains(extraOfficialDomains);
  return extraDomains.some((domain) => domainMatches(hostname, domain));
}

function isInsurerOfficialUrl(url = '', policy = {}, extraOfficialDomains = [], officialDomainProfiles = getDefaultOfficialDomainProfiles()) {
  return isPolicyOfficialSourceUrl(url, policy, officialDomainProfiles, extraOfficialDomains);
}

function isPublicAuthorityOrJudicialUrl(url = '') {
  const hostname = resolveUrlHostname(url);
  return PUBLIC_AUTHORITY_OR_JUDICIAL_DOMAINS.some((domain) => domainMatches(hostname, domain));
}

function buildSearchCompanyAliases(policy = {}, officialDomainProfiles = getDefaultOfficialDomainProfiles()) {
  const normalized = trimString(policy.company);
  const aliases = [normalized];
  const profile = resolveInsurerOfficialProfile(policy, officialDomainProfiles);
  if (profile) {
    aliases.push(...profile.companyAliases);
  }
  return Array.from(new Set(aliases.filter(Boolean)));
}

function buildSearchQueries(policy = {}, officialDomainProfiles = getDefaultOfficialDomainProfiles()) {
  const companyAliases = buildSearchCompanyAliases(policy, officialDomainProfiles);
  const primaryCompany = companyAliases[0] || '';
  const productName = trimString(policy.name);
  const productType = trimString(policy.type);
  const queries = [];
  const profile = resolveInsurerOfficialProfile(policy, officialDomainProfiles);
  if (profile) {
    for (const domain of profile.siteDomains) {
      queries.push(
        buildSearchPhrase([`site:${domain}`, productName, '保险条款', '保险责任']),
        buildSearchPhrase([`site:${domain}`, productName, '产品说明书', '保险责任']),
        buildSearchPhrase([`site:${domain}`, productName, '责任免除', '给付规则']),
      );
    }
  } else if (isNewChinaLifePolicy(policy)) {
    queries.push(
      buildSearchPhrase(['site:newchinalife.com', productName, '保险条款', '保险责任']),
      buildSearchPhrase(['site:static-cdn.newchinalife.com', productName, '保险条款', '产品说明书']),
    );
  } else if (isChinaLifePolicy(policy)) {
    queries.push(
      buildSearchPhrase(['site:e-chinalife.com', productName, '保险条款', '保险责任']),
      buildSearchPhrase(['site:e-chinalife.com', productName, '保险责任', '产品介绍']),
    );
  }
  for (const domain of PUBLIC_AUTHORITY_SEARCH_DOMAINS) {
    queries.push(
      buildSearchPhrase([`site:${domain}`, primaryCompany, productName, '保险责任']),
      buildSearchPhrase([`site:${domain}`, primaryCompany, productName, '保险合同']),
    );
  }
  queries.push(
    buildSearchPhrase([primaryCompany, productName, '保险责任', '产品介绍']),
    buildSearchPhrase([primaryCompany, productName, '保险条款', '保险责任']),
    buildSearchPhrase([primaryCompany, productName, '产品说明书', '保险责任']),
    buildSearchPhrase([primaryCompany, productName, productType, '条款', '现金价值表']),
    buildSearchPhrase([primaryCompany, productName, '责任免除', '给付规则']),
    buildSearchPhrase([primaryCompany, productName, '投保年龄', '交费方式', '保险期间']),
  );
  for (const alias of companyAliases.slice(1)) {
    queries.push(buildSearchPhrase([alias, productName, '产品说明书', '保险责任']));
    queries.push(buildSearchPhrase([alias, productName, '保险条款', '保险责任']));
  }
  return Array.from(new Set(queries.filter(Boolean)));
}

function buildSearchQuery(policy = {}, officialDomainProfiles = getDefaultOfficialDomainProfiles()) {
  return buildSearchQueries(policy, officialDomainProfiles)[0] || '';
}

function isNewChinaLifePolicy(policy = {}) {
  return /新华/u.test(trimString(policy.company)) || /新华/u.test(trimString(policy.name));
}

function isChinaLifePolicy(policy = {}) {
  return /中国人寿|国寿/u.test(trimString(policy.company)) || /中国人寿|国寿/u.test(trimString(policy.name));
}

function resolveAbsoluteUrl(href = '', baseUrl = 'https://www.newchinalife.com') {
  const decoded = decodeHtmlEntities(href);
  if (!decoded) return '';
  try {
    return new URL(decoded, baseUrl).toString();
  } catch {
    return '';
  }
}

function extractHtmlRows(html = '') {
  return Array.from(String(html || '').matchAll(/<tr\b[\s\S]*?<\/tr>/giu)).map((match) => match[0]);
}

function extractHtmlLinks(html = '') {
  return Array.from(String(html || '').matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu))
    .map((match) => ({
      href: decodeHtmlEntities(match[1]),
      label: stripHtml(match[2]),
    }))
    .filter((link) => link.href && link.label);
}

function extractNewChinaProductTitle(rowHtml = '', policy = {}) {
  const productName = normalizeComparableFact(policy.name);
  const cells = Array.from(String(rowHtml || '').matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu))
    .map((match) => stripHtml(match[1]))
    .filter(Boolean);
  const matchedCell = cells.find((cell) => {
    const normalized = normalizeComparableFact(cell);
    return productName && normalized.includes(productName);
  });
  return matchedCell || trimString(policy.name);
}

function isNewChinaProductRow(rowHtml = '', policy = {}) {
  const productName = normalizeComparableFact(policy.name);
  if (!productName) return false;
  const rowText = normalizeComparableFact(stripHtml(rowHtml));
  return rowText.includes(productName);
}

function buildNewChinaDisclosureResult({ productTitle, materialLabel, url }) {
  const label = trimString(materialLabel);
  const title = trimString(productTitle);
  return {
    title: trimString(`${title}${label && !title.includes(label) ? label : ''}`) || label || url,
    url,
    snippet: `新华保险官网产品基本信息披露材料：${label || '披露材料'}`,
  };
}

function extractNewChinaPdfLinksFromMaterialPage({ html = '', policy = {}, materialLabel = '' } = {}) {
  const productName = normalizeComparableFact(policy.name);
  return extractHtmlLinks(html)
    .map((link) => ({
      ...link,
      url: resolveAbsoluteUrl(link.href, 'https://www.newchinalife.com'),
    }))
    .filter((link) => /static-cdn\.newchinalife\.com\/ncl\/pdf\/.+\.pdf(?:$|[?#])/iu.test(link.url))
    .filter((link) => {
      const labelText = normalizeComparableFact(link.label);
      return !productName || labelText.includes(productName);
    })
    .map((link) =>
      buildNewChinaDisclosureResult({
        productTitle: link.label || trimString(policy.name),
        materialLabel,
        url: link.url,
      }),
    );
}

async function fetchNewChinaDisclosureResultsFromUrl({ disclosureUrl: disclosureUrlValue, policy, fetchImpl, signal, seenUrls } = {}) {
  if (!isNewChinaLifePolicy(policy)) return [];
  const productName = trimString(policy.name);
  if (!productName) return [];
  const disclosureUrl = new URL(disclosureUrlValue);
  disclosureUrl.searchParams.set('productName', productName);
  try {
    const response = await fetchImpl(disclosureUrl, {
      method: 'GET',
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!response.ok) return [];
    const html = await response.text();
    const productRows = extractHtmlRows(html).filter((row) => isNewChinaProductRow(row, policy));
    const results = [];
    for (const row of productRows) {
      const productTitle = extractNewChinaProductTitle(row, policy);
      const materialLinks = extractHtmlLinks(row).filter((link) => /条款|产品说明|费率表|现金价值表/u.test(link.label));
      for (const link of materialLinks) {
        const url = resolveAbsoluteUrl(link.href, disclosureUrl);
        if (!url) continue;
        if (/static-cdn\.newchinalife\.com\/ncl\/pdf\/.+\.pdf(?:$|[?#])/iu.test(url)) {
          if (!seenUrls.has(url)) {
            seenUrls.add(url);
            results.push(buildNewChinaDisclosureResult({ productTitle, materialLabel: link.label, url }));
          }
          continue;
        }
        if (!/newchinalife\.com\/node\/(?:670|2430)/iu.test(url)) continue;
        try {
          const materialResponse = await fetchImpl(url, {
            method: 'GET',
            signal,
            headers: {
              'User-Agent': 'Mozilla/5.0',
              Accept: 'text/html,application/xhtml+xml',
            },
          });
          if (!materialResponse.ok) continue;
          const materialResults = extractNewChinaPdfLinksFromMaterialPage({
            html: await materialResponse.text(),
            policy,
            materialLabel: link.label,
          });
          for (const result of materialResults) {
            if (seenUrls.has(result.url)) continue;
            seenUrls.add(result.url);
            results.push(result);
          }
        } catch {
          // Continue with other official material links.
        }
      }
    }
    return results;
  } catch {
    return [];
  }
}

async function fetchNewChinaDisclosureResults({ policy, fetchImpl, signal } = {}) {
  if (!isNewChinaLifePolicy(policy)) return [];
  const results = [];
  const seenUrls = new Set();
  for (const disclosureUrl of NEW_CHINA_PRODUCT_DISCLOSURE_URLS) {
    const pageResults = await fetchNewChinaDisclosureResultsFromUrl({
      disclosureUrl,
      policy,
      fetchImpl,
      signal,
      seenUrls,
    });
    results.push(...pageResults);
    if (hasEnoughOfficialPolicyDocuments(results, policy)) break;
  }
  return results;
}

function parse360SearchResults(html, { policy = {}, maxResults = DEFAULT_POLICY_ANALYSIS_SMART_SEARCH_MAX_RESULTS } = {}) {
  const matches = Array.from(
    String(html || '').matchAll(
      /<li class="res-list"[\s\S]*?<a\s+[^>]*data-mdurl="([^"]+)"[\s\S]*?>([\s\S]*?)<\/a>[\s\S]*?<p class="res-desc">([\s\S]*?)<\/p>/gu,
    ),
  );
  const productName = normalizeComparableFact(policy.name);
  const results = [];
  for (const match of matches) {
    const url = trimString(match[1]);
    const title = stripHtml(match[2]);
    const snippet = stripHtml(match[3]);
    if (!url || !title || !snippet) continue;
    const relevanceText = normalizeComparableFact(`${title} ${snippet}`);
    if (productName && !relevanceText.includes(productName)) continue;
    results.push({ title, url, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

function normalizeDuckDuckGoHref(href = '') {
  const raw = decodeHtmlEntities(trimString(href));
  if (!raw) return '';
  const absolute = raw.startsWith('//') ? `https:${raw}` : raw;
  try {
    const url = new URL(absolute);
    const redirected = trimString(url.searchParams.get('uddg'));
    if (/duckduckgo\.com$/u.test(url.hostname) && redirected) return redirected;
    return url.toString();
  } catch {
    return absolute;
  }
}

function parseDuckDuckGoSearchResults(html, { policy = {}, maxResults = DEFAULT_POLICY_ANALYSIS_SMART_SEARCH_MAX_RESULTS } = {}) {
  const blocks = Array.from(String(html || '').matchAll(/<div class="result[\s\S]*?(?=<div class="result|<\/body>|$)/gu)).map(
    (match) => match[0],
  );
  const productName = normalizeComparableFact(policy.name);
  const results = [];
  for (const block of blocks) {
    const linkMatch = block.match(/<a\s+[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/u);
    if (!linkMatch) continue;
    const url = normalizeDuckDuckGoHref(linkMatch[1]);
    const title = stripHtml(linkMatch[2]);
    const snippetMatch = block.match(/<a\s+[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/u);
    const snippet = stripHtml(snippetMatch?.[1] || title);
    if (!url || !title) continue;
    const relevanceText = normalizeComparableFact(`${title} ${snippet} ${url}`);
    if (productName && !relevanceText.includes(productName)) continue;
    results.push({ title, url, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

function parseBaiduSearchResults(html, { policy = {}, maxResults = DEFAULT_POLICY_ANALYSIS_SMART_SEARCH_MAX_RESULTS } = {}) {
  const blocks = Array.from(String(html || '').matchAll(/<div[^>]+(?:result|c-container)[^>]*>[\s\S]*?(?=<div[^>]+(?:result|c-container)|<\/body>|$)/giu)).map(
    (match) => match[0],
  );
  const productName = normalizeComparableFact(policy.name);
  const results = [];
  for (const block of blocks) {
    const linkMatch = block.match(/<h3[^>]*>[\s\S]*?<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/iu)
      || block.match(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/iu);
    if (!linkMatch) continue;
    const url = decodeHtmlEntities(linkMatch[1]);
    const title = stripHtml(linkMatch[2]);
    const snippetMatch = block.match(/<(?:div|span)[^>]+class="[^"]*(?:c-abstract|content-right|result-desc)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/iu);
    const snippet = stripHtml(snippetMatch?.[1] || title);
    if (!url || !title || !/^https?:\/\//iu.test(url)) continue;
    const relevanceText = normalizeComparableFact(`${title} ${snippet} ${url}`);
    if (productName && !relevanceText.includes(productName)) continue;
    results.push({ title, url, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

async function fetchSearchResultsForQuery({ query, policy, fetchImpl, signal, maxResults }) {
  const engines = [
    {
      url: new URL('https://www.so.com/s'),
      parse: parse360SearchResults,
    },
    {
      url: new URL('https://duckduckgo.com/html/'),
      parse: parseDuckDuckGoSearchResults,
    },
    {
      url: new URL('https://www.baidu.com/s'),
      parse: parseBaiduSearchResults,
    },
  ];
  const results = [];
  for (const engine of engines) {
    try {
      engine.url.searchParams.set('q', query);
      if (/baidu\.com$/u.test(engine.url.hostname)) engine.url.searchParams.set('wd', query);
      const response = await fetchImpl(engine.url, {
        method: 'GET',
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      if (!response.ok) continue;
      results.push(
        ...engine.parse(await response.text(), {
          policy,
          maxResults,
        }),
      );
    } catch {
      continue;
    }
  }
  return results;
}

function scoreSearchResult(result = {}, policy = {}, extraOfficialDomains = [], officialDomainProfiles = getDefaultOfficialDomainProfiles()) {
  const url = trimString(result.url).toLowerCase();
  const title = trimString(result.title);
  let score = 0;
  if (isInsurerOfficialUrl(url, policy, extraOfficialDomains, officialDomainProfiles)) score += 120;
  if (isPublicAuthorityOrJudicialUrl(url)) score += 70;
  if (/\.pdf(?:$|[?#])/u.test(url)) score += 25;
  if (/产品说明书/u.test(title)) score += 40;
  if (/保险条款|利益条款/u.test(title)) score += 35;
  if (/现金价值表/u.test(title)) score += 10;
  if (/沃保|万一|搜狐|网易|新浪/u.test(title)) score -= 20;
  return score;
}

function hasEnoughOfficialPolicyDocuments(results = [], policy = {}) {
  if (!isNewChinaLifePolicy(policy)) return false;
  const officialPdfResults = Array.from(results).filter((result) => {
    const url = trimString(result?.url).toLowerCase();
    return /static-cdn\.newchinalife\.com/u.test(url) && /\.pdf(?:$|[?#])/u.test(url);
  });
  const text = officialPdfResults.map((result) => `${trimString(result.title)} ${trimString(result.url)}`).join('\n');
  return officialPdfResults.length >= 2 && /产品说明|产品说明书/u.test(text) && /利益条款|保险条款|条款/u.test(text);
}

function hasInsurerOfficialEvidence(results = [], policy = {}, extraOfficialDomains = [], officialDomainProfiles = getDefaultOfficialDomainProfiles()) {
  return Array.from(results).some((result) => isInsurerOfficialUrl(result?.url, policy, extraOfficialDomains, officialDomainProfiles));
}

function formatSearchEvidenceLabel(result = {}, { policy = {}, hasOfficialEvidence = false, extraOfficialDomains = [], officialDomainProfiles = getDefaultOfficialDomainProfiles() } = {}) {
  if (isInsurerOfficialUrl(result?.url, policy, extraOfficialDomains, officialDomainProfiles)) return '保险公司官方资料';
  if (!hasOfficialEvidence) {
    if (isPublicAuthorityOrJudicialUrl(result?.url)) {
      return '监管或司法辅助资料（未匹配到保险公司官方条款或说明书，需以正式合同为准）';
    }
    return '非官方辅助资料（未匹配到保险公司官方条款或说明书，需以正式合同为准）';
  }
  if (isPublicAuthorityOrJudicialUrl(result?.url)) return '监管或司法辅助资料';
  return '辅助资料';
}

function formatSearchEvidenceLevel(result = {}, { policy = {}, hasOfficialEvidence = false, extraOfficialDomains = [], officialDomainProfiles = getDefaultOfficialDomainProfiles() } = {}) {
  if (isInsurerOfficialUrl(result?.url, policy, extraOfficialDomains, officialDomainProfiles)) return 'insurer_official';
  if (isPublicAuthorityOrJudicialUrl(result?.url)) return 'public_authority';
  return hasOfficialEvidence ? 'auxiliary' : 'non_official_auxiliary';
}

function resolveSearchSourceType(result = {}) {
  const url = trimString(result?.url).toLowerCase();
  if (/\.pdf(?:$|[?#])/u.test(url)) return 'pdf';
  return 'html';
}

function formatSearchSources(results = [], { policy = {}, extraOfficialDomains = [], officialDomainProfiles = getDefaultOfficialDomainProfiles() } = {}) {
  if (!Array.isArray(results) || !results.length) return [];
  const hasOfficialEvidence = hasInsurerOfficialEvidence(results, policy, extraOfficialDomains, officialDomainProfiles);
  return results
    .map((result) => {
      const url = trimString(result?.url);
      if (!url) return null;
      const evidenceLabel = formatSearchEvidenceLabel(result, { policy, hasOfficialEvidence, extraOfficialDomains, officialDomainProfiles });
      const evidenceLevel = formatSearchEvidenceLevel(result, { policy, hasOfficialEvidence, extraOfficialDomains, officialDomainProfiles });
      return {
        title: trimString(result?.title) || url,
        url,
        snippet: trimString(result?.snippet),
        evidenceLabel,
        evidenceLevel,
        official: evidenceLevel === 'insurer_official',
        sourceType: resolveSearchSourceType(result),
      };
    })
    .filter(Boolean);
}

function formatSearchContext(results = [], { policy = {}, extraOfficialDomains = [], officialDomainProfiles = getDefaultOfficialDomainProfiles() } = {}) {
  if (!Array.isArray(results) || !results.length) return '';
  const hasOfficialEvidence = hasInsurerOfficialEvidence(results, policy, extraOfficialDomains, officialDomainProfiles);
  return results
    .map((result, index) => {
      const evidenceLabel = formatSearchEvidenceLabel(result, { policy, hasOfficialEvidence, extraOfficialDomains, officialDomainProfiles });
      return [
        `【资料${index + 1}】${result.title}`,
        `证据等级：${evidenceLabel}`,
        `摘要：${result.snippet}`,
        result.pageText ? `正文：${result.pageText}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

function extractRelevantText(text = '', policy = {}) {
  const normalizedText = trimString(text);
  if (!normalizedText) return '';
  if (!text) return '';
  const productName = trimString(policy.name);
  const keywords = [
    '保险责任',
    '身故',
    '全残',
    '给付',
    '现金价值',
    '红利',
    '责任免除',
    '投保年龄',
    '保险期间',
    '保险责任',
    '基本责任',
    '可选责任',
    '生存保险金',
    '养老年金',
    '满期生存保险金',
    '身故保险金',
    '成长教育金',
    '成家立业金',
    '个人养老金',
    '交费',
    '缴费',
    '等待期',
    '给付系数',
    '有效保险金额',
    '基本保险金额',
    '减保',
    '保单贷款',
    '公共交通',
    '交通工具',
    '1.75%',
    '1.5倍',
  ];
  const sentences = normalizedText
    .split(/[。！？!?；;\n\r]+/u)
    .map((item) => trimString(item))
    .filter((item) => item.length >= 8 && item.length <= 360);
  const relevant = [];
  for (const sentence of sentences) {
    const hasProduct = productName && sentence.includes(productName);
    const hasKeyword = keywords.some((keyword) => sentence.includes(keyword));
    if (!hasProduct && !hasKeyword) continue;
    if (!relevant.includes(sentence)) relevant.push(sentence);
    if (relevant.join('。').length >= MAX_SEARCH_PAGE_TEXT_CHARS) break;
  }
  const fallbackStart = productName ? normalizedText.indexOf(productName) : -1;
  if (fallbackStart >= 0) {
    const nearby = normalizedText.slice(Math.max(0, fallbackStart - 240), fallbackStart + MAX_SEARCH_PAGE_TEXT_CHARS);
    if (!relevant.length) return nearby;
    const combined = `${nearby}。${relevant.join('。')}`;
    return Array.from(new Set(combined.split(/[。！？!?；;\n\r]+/u).map((item) => trimString(item)).filter(Boolean)))
      .join('。')
      .slice(0, MAX_SEARCH_PAGE_TEXT_CHARS);
  }
  return relevant.join('。').slice(0, MAX_SEARCH_PAGE_TEXT_CHARS);
}

function extractRelevantPageText(html = '', policy = {}) {
  return extractRelevantText(stripHtml(html), policy);
}

function decodePdfHexText(value = '') {
  const normalized = String(value || '').replace(/\s+/gu, '');
  if (!normalized) return '';
  const bytes = Buffer.from(normalized, 'hex');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let output = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      output += String.fromCharCode(bytes.readUInt16BE(index));
    }
    return output;
  }
  return bytes.toString('utf8');
}

function decodePdfLiteralText(value = '') {
  return String(value || '').replace(/\\([nrtbf()\\])/gu, (_match, token) => {
    const replacements = {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      '(': '(',
      ')': ')',
      '\\': '\\',
    };
    return replacements[token] || token;
  });
}

function extractPdfActualText(buffer) {
  const raw = Buffer.from(buffer || []).toString('latin1');
  if (!raw) return '';
  const values = [];
  const pattern = /\/ActualText\s*(?:\((.*?)\)|<([0-9A-Fa-f\s]+)>)/gsu;
  for (const match of raw.matchAll(pattern)) {
    const decoded = match[1] !== undefined ? decodePdfLiteralText(match[1]) : decodePdfHexText(match[2]);
    const text = trimString(decoded);
    if (text) values.push(text);
  }
  return values.join('');
}

async function extractPdfTextWithPython(buffer) {
  const raw = Buffer.from(buffer || []);
  if (!raw.length) return '';
  return new Promise((resolve) => {
    const child = spawn(
      'python3',
      [
        '-c',
        [
          'import base64, io, sys',
          'try:',
          '    from pypdf import PdfReader',
          '    data = base64.b64decode(sys.stdin.read())',
          '    reader = PdfReader(io.BytesIO(data))',
          "    print('\\n'.join((page.extract_text() or '') for page in reader.pages))",
          'except Exception:',
          '    sys.exit(0)',
        ].join('\n'),
      ],
      {
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    );
    let output = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      resolve('');
    }, 8000);
    child.stdout.on('data', (chunk) => {
      output += String(chunk || '');
      if (output.length > 20_000) {
        child.kill('SIGTERM');
      }
    });
    child.on('close', () => {
      clearTimeout(timeout);
      resolve(trimString(output));
    });
    child.on('error', () => {
      clearTimeout(timeout);
      resolve('');
    });
    child.stdin.end(raw.toString('base64'));
  });
}

async function extractRelevantPdfText(buffer, policy = {}) {
  const actualText = extractPdfActualText(buffer);
  const rawText = actualText || (await extractPdfTextWithPython(buffer));
  return extractRelevantText(rawText, policy);
}

async function enrichSearchResultsWithPageText({ results = [], policy, fetchImpl, signal, maxResults = DEFAULT_POLICY_ANALYSIS_SMART_SEARCH_MAX_RESULTS } = {}) {
  const enriched = [];
  for (const result of results) {
    if (enriched.length >= maxResults) break;
    let pageText = '';
    try {
      const url = new URL(result.url);
      const isFetchablePage = !/\.(doc|docx|xls|xlsx|ppt|pptx)(?:$|[?#])/iu.test(url.pathname);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && isFetchablePage) {
        const response = await fetchImpl(url, {
          method: 'GET',
          signal,
          headers: {
            'User-Agent': 'Mozilla/5.0',
            Accept: 'text/html,application/xhtml+xml',
          },
        });
        const contentType = String(response.headers?.get?.('content-type') || '');
        const isPdf = /application\/pdf/iu.test(contentType) || /\.pdf(?:$|[?#])/iu.test(url.pathname);
        const contentLength = Number(response.headers?.get?.('content-length') || 0);
        if (response.ok && isPdf && (!contentLength || contentLength <= MAX_SEARCH_PDF_BYTES)) {
          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.length <= MAX_SEARCH_PDF_BYTES) {
            pageText = await extractRelevantPdfText(buffer, policy);
          }
        } else if (response.ok && !/(application\/msword|officedocument)/iu.test(contentType)) {
          pageText = extractRelevantPageText(await response.text(), policy);
        }
      }
    } catch {
      pageText = '';
    }
    enriched.push({
      ...result,
      pageText,
    });
  }
  return enriched;
}

function hasOfficialSearchSource(sources = []) {
  return (Array.isArray(sources) ? sources : []).some(
    (source) => Boolean(source?.official) || trimString(source?.evidenceLevel) === 'insurer_official',
  );
}

function hasExternalReviewSource(sources = []) {
  return (Array.isArray(sources) ? sources : []).some((source) => {
    const level = trimString(source?.evidenceLevel);
    const kind = trimString(source?.sourceKind);
    return level === 'external_legacy_reference' || kind === 'legacy_external_reference' || kind === 'open_web_reference';
  });
}

function normalizePolicyAnalysisSkillKeys(skills = []) {
  return Array.from(
    new Set(
      (Array.isArray(skills) ? skills : [])
        .map(trimString)
        .filter((skill) => POLICY_ANALYSIS_SKILL_KEYS.includes(skill)),
    ),
  );
}

function inferPolicyAnalysisDocumentType(analysisInput = {}) {
  const ocrText = trimString(analysisInput.ocrText);
  if (/现金价值|退保金|保单年度|现金价值表/u.test(ocrText)) return 'cash_value_or_benefit_page';
  if (/保险责任|基本责任|可选责任|责任免除|保险金|给付|赔付|报销|豁免/u.test(ocrText)) return 'responsibility_page';
  if (/投保人|被保险人|保险期间|缴费期间|交费期间|基本保险金额|首期保险费/u.test(ocrText)) return 'policy_basic_page';
  return 'unknown';
}

function buildLocalPolicyAnalysisSkillPlan({ analysisInput = {}, searchArtifacts = {}, hasOfficialSource = false, hasExternalSource = false } = {}) {
  const ocrText = trimString(analysisInput.ocrText);
  const documentType = inferPolicyAnalysisDocumentType(analysisInput);
  const skills = ['responsibility_extraction', 'indicator_quantification'];
  if (hasOfficialSource) skills.push('official_rag_grounding');
  if (hasExternalSource && !hasOfficialSource) skills.push('external_reference_review');
  if (ocrText && (analysisInput.evidenceMode === 'detail_ocr' || documentType !== 'unknown' || !hasOfficialSource)) {
    skills.push('uploaded_ocr_fallback');
  }
  if (/年金|生存金|满期|祝寿金|养老金|领取|教育金|成家立业金/u.test(ocrText)) {
    skills.push('benefit_schedule');
  }
  if (/现金价值|保单贷款|减保|自动垫交|减额交清/u.test(ocrText)) {
    skills.push('cash_value_reference');
  }
  const sourceCount = Array.isArray(searchArtifacts?.sources) ? searchArtifacts.sources.length : 0;
  return {
    documentType,
    skills: normalizePolicyAnalysisSkillKeys(skills),
    promptDirectives: [],
    reason: hasOfficialSource
      ? '已命中官方资料，结合上传OCR核对责任'
      : ocrText
        ? '基于上传OCR兜底解析保险责任'
        : sourceCount
          ? '基于检索资料解析保险责任'
          : '基于已知保单字段解析保险责任',
    selectedBy: 'local_fallback',
  };
}

function normalizePromptDirectives(value = []) {
  const items = Array.isArray(value) ? value : [value];
  return Array.from(
    new Set(
      items
        .map((item) => trimString(item))
        .filter(Boolean)
        .filter((item) => !/忽略|ignore|system|developer|markdown|改成|不要输出JSON|不要输出 json/iu.test(item))
        .map((item) => item.slice(0, 140)),
    ),
  ).slice(0, 5);
}

function normalizePolicyAnalysisSkillPlanPayload(payload = {}, fallback = {}) {
  const skills = normalizePolicyAnalysisSkillKeys(payload?.skills);
  if (!skills.length) return fallback;
  return {
    documentType: trimString(payload?.documentType) || fallback.documentType || 'unknown',
    skills,
    promptDirectives: normalizePromptDirectives(payload?.promptDirectives || payload?.directives || payload?.nextPromptDirectives),
    reason: trimString(payload?.reason).slice(0, 120) || fallback.reason || '',
    selectedBy: 'deepseek',
  };
}

function policyAnalysisSkillRouterMessages({ policy = {}, analysisInput = {}, searchArtifacts = {}, localPlan = {} } = {}) {
  const skillList = POLICY_ANALYSIS_SKILL_KEYS
    .map((key) => `- ${key}: ${POLICY_ANALYSIS_SKILLS[key].label}；${POLICY_ANALYSIS_SKILLS[key].routerDescription}`)
    .join('\n');
  const sourceSummary = (Array.isArray(searchArtifacts?.sources) ? searchArtifacts.sources : [])
    .slice(0, 5)
    .map((source, index) => {
      const evidence = trimString(source?.evidenceLabel || source?.evidenceLevel);
      return `资料${index + 1}: ${trimString(source?.title || source?.url)}${evidence ? `；${evidence}` : ''}`;
    })
    .join('\n');
  return [
    {
      role: 'system',
      content: [
        '你是 policy_analysis_skill_router，只为下一次保单责任解析选择 skills 和 prompt 指令。',
        '必须只返回 JSON，不要解释，不要输出 Markdown。',
        '可选 skills：',
        skillList,
        '',
        '选择原则：',
        '- 上传OCR含保险责任、保险金、给付、赔付、豁免、领取条件时，必须包含 responsibility_extraction、indicator_quantification、uploaded_ocr_fallback。',
        '- 命中保险公司官方资料或本地官方知识库时，包含 official_rag_grounding。',
        '- 只有非官方外部资料时，包含 external_reference_review。',
        '- OCR含年金、生存金、满期、养老金、祝寿金、领取计划时，包含 benefit_schedule。',
        '- OCR含现金价值、减保、保单贷款时，包含 cash_value_reference，但现金价值不得单独变成保险责任。',
        '- promptDirectives 只写给下一次责任解析模型的重点，不得改变 JSON 输出格式。',
        '',
        'JSON 格式：{"documentType":"responsibility_page|policy_basic_page|cash_value_or_benefit_page|unknown","skills":["skill_key"],"promptDirectives":["不超过5条"],"reason":"不超过40字"}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `保险公司：${policy.company || '未识别'}`,
        `产品名称：${policy.name || '未识别'}`,
        `本地初判文档类型：${localPlan.documentType || 'unknown'}`,
        `OCR证据模式：${analysisInput.evidenceMode || 'basic'}`,
        `OCR片段：${trimString(analysisInput.ocrText).slice(0, 1200) || '无'}`,
        `RAG资料：${sourceSummary || '无'}`,
      ].join('\n'),
    },
  ];
}

async function selectPolicyAnalysisSkillPlan({ config, model, policy, analysisInput, searchArtifacts, fetchImpl }) {
  const hasOfficialSource = hasOfficialSearchSource(searchArtifacts?.sources);
  const hasExternalSource = hasExternalReviewSource(searchArtifacts?.sources);
  const fallback = buildLocalPolicyAnalysisSkillPlan({
    analysisInput,
    searchArtifacts,
    hasOfficialSource,
    hasExternalSource,
  });
  try {
    const payload = await requestPolicyAnalysis({
      config,
      model,
      fetchImpl,
      messages: policyAnalysisSkillRouterMessages({
        policy,
        analysisInput,
        searchArtifacts,
        localPlan: fallback,
      }),
      options: {
        maxTokens: DEFAULT_SKILL_ROUTER_MAX_TOKENS,
        temperature: 0.05,
      },
    });
    const content = trimString(payload?.choices?.[0]?.message?.content);
    return normalizePolicyAnalysisSkillPlanPayload(extractJson(content), fallback);
  } catch (error) {
    return {
      ...fallback,
      routerError: trimString(error?.code || error?.message).slice(0, 120),
    };
  }
}

function buildPolicyAnalysisSkillInstructionBlock(skillPlan = {}) {
  const skills = normalizePolicyAnalysisSkillKeys(skillPlan.skills);
  if (!skills.length) return '';
  const skillRules = skills
    .map((key) => `- ${key}（${POLICY_ANALYSIS_SKILLS[key].label}）：${POLICY_ANALYSIS_SKILLS[key].promptRule}`)
    .join('\n');
  const directives = normalizePromptDirectives(skillPlan.promptDirectives);
  return [
    '本次解析技能计划（内部执行，不要在输出中提到 skills、router 或 prompt）：',
    `文档类型：${trimString(skillPlan.documentType) || 'unknown'}`,
    `选择来源：${trimString(skillPlan.selectedBy) || 'local_fallback'}`,
    trimString(skillPlan.reason) ? `选择原因：${trimString(skillPlan.reason)}` : '',
    '启用 skills：',
    skillRules,
    directives.length ? 'Router 生成的下一步解析重点（不得改变输出 JSON 格式）：' : '',
    directives.length ? directives.map((item) => `- ${item}`).join('\n') : '',
  ].filter(Boolean).join('\n');
}

function normalizeDiscoveredSourcePayload(payload = {}) {
  const sourceRows = Array.isArray(payload?.sources) ? payload.sources : [];
  const officialDomains = normalizeOfficialDomains(payload?.companyOfficialDomainHints || payload?.officialDomains || []);
  const domains = normalizeOfficialDomains(officialDomains);
  const results = sourceRows
    .map((source) => ({
      title: trimString(source?.title) || trimString(source?.url),
      url: trimString(source?.url),
      snippet: trimString(source?.snippet),
    }))
    .filter((source) => source.url && domains.some((domain) => domainMatches(resolveUrlHostname(source.url), domain)));
  return {
    officialDomains: domains,
    results,
  };
}

function buildOfficialSourceDiscoveryMessages(policy = {}) {
  return [
    {
      role: 'system',
      content:
        '你只查找保险公司官方资料链接，不做保险责任分析。只输出 JSON，不要输出 markdown。JSON 字段只能包含 companyOfficialDomainHints 和 sources。companyOfficialDomainHints 是该保险公司的官方域名数组；sources 是官方产品条款、产品说明书、保险责任页或 PDF 链接数组，每项包含 title、url、snippet。不要返回第三方平台、新闻、百科、论坛、代理人文章、聚合站。',
    },
    {
      role: 'user',
      content: `只查找保险公司官方资料：保险公司=${policy.company || '未识别'}；产品名称=${policy.name || '未识别'}。找不到官方资料时返回 {"companyOfficialDomainHints":[],"sources":[]}。`,
    },
  ];
}

async function discoverOfficialSourceResults({ config, policy, fetchImpl }) {
  try {
    const payload = await requestPolicyAnalysis({
      config,
      model: config.model,
      fetchImpl,
      messages: buildOfficialSourceDiscoveryMessages(policy),
      options: { maxTokens: DEFAULT_DISCOVERY_MAX_TOKENS },
    });
    const content = trimString(payload?.choices?.[0]?.message?.content);
    return normalizeDiscoveredSourcePayload(extractJson(content));
  } catch {
    return { officialDomains: [], results: [] };
  }
}

function uniqueResultsByUrl(results = []) {
  const seen = new Set();
  const unique = [];
  for (const result of results) {
    const url = trimString(result?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push(result);
  }
  return unique;
}

async function fetchPolicySearchArtifacts({ config, policy, fetchImpl, officialDomainProfiles = getDefaultOfficialDomainProfiles() }) {
  if (!config.smartSearchEnabled) return { context: '', sources: [] };
  if (!trimString(policy?.company) || !trimString(policy?.name)) return { context: '', sources: [] };
  const queries = buildSearchQueries(policy, officialDomainProfiles);
  if (!queries.length) return { context: '', sources: [] };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.smartSearchTimeoutMs);
  try {
    const resultsByUrl = new Map();
    const officialResults = await fetchNewChinaDisclosureResults({
      policy,
      fetchImpl,
      signal: controller.signal,
    });
    for (const result of officialResults) {
      if (!resultsByUrl.has(result.url)) {
        resultsByUrl.set(result.url, result);
      }
    }
    const candidateLimit = Math.max(config.smartSearchMaxResults * 3, config.smartSearchMaxResults);
    for (const query of queries) {
      if (hasEnoughOfficialPolicyDocuments(resultsByUrl.values(), policy)) break;
      if (resultsByUrl.size >= candidateLimit) break;
      const results = await fetchSearchResultsForQuery({
        query,
        policy,
        fetchImpl,
        signal: controller.signal,
        maxResults: candidateLimit,
      });
      for (const result of results) {
        if (!resultsByUrl.has(result.url)) {
          resultsByUrl.set(result.url, result);
        }
        if (resultsByUrl.size >= candidateLimit) break;
      }
      if (hasEnoughOfficialPolicyDocuments(resultsByUrl.values(), policy)) break;
    }
    let officialDomains = [];
    let sortedResults = Array.from(resultsByUrl.values())
      .sort((left, right) => scoreSearchResult(right, policy, [], officialDomainProfiles) - scoreSearchResult(left, policy, [], officialDomainProfiles))
      .slice(0, config.smartSearchMaxResults);
    let enriched = await enrichSearchResultsWithPageText({
      results: sortedResults,
      policy,
      fetchImpl,
      signal: controller.signal,
      maxResults: config.smartSearchMaxResults,
    });
    let sources = formatSearchSources(enriched, { policy, extraOfficialDomains: officialDomains, officialDomainProfiles });
    if (!hasOfficialSearchSource(sources)) {
      const discovered = await discoverOfficialSourceResults({ config, policy, fetchImpl });
      officialDomains = discovered.officialDomains;
      const discoveredEnriched = await enrichSearchResultsWithPageText({
        results: discovered.results,
        policy,
        fetchImpl,
        signal: controller.signal,
        maxResults: config.smartSearchMaxResults,
      });
      enriched = uniqueResultsByUrl([...enriched, ...discoveredEnriched])
        .sort((left, right) => scoreSearchResult(right, policy, officialDomains, officialDomainProfiles) - scoreSearchResult(left, policy, officialDomains, officialDomainProfiles))
        .slice(0, config.smartSearchMaxResults);
      sources = formatSearchSources(enriched, { policy, extraOfficialDomains: officialDomains, officialDomainProfiles });
    }
    return {
      context: formatSearchContext(enriched, { policy, extraOfficialDomains: officialDomains, officialDomainProfiles }),
      sources,
    };
  } catch {
    return { context: '', sources: [] };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchPolicySearchContext({ config, policy, fetchImpl, officialDomainProfiles }) {
  return (await fetchPolicySearchArtifacts({ config, policy, fetchImpl, officialDomainProfiles })).context;
}

function buildMessages({ policy, analysisInput, externalReviewMode = false, skillPlan = null }) {
  const contextLines = [];
  if (analysisInput.searchContext) {
    contextLines.push(`产品资料（后端搜索获得）：\n${analysisInput.searchContext}`);
  }
  if (analysisInput.ocrText) {
    contextLines.push(`保单详情OCR（客户上传识别）：\n${analysisInput.ocrText}`);
  }
  const contextBlock = contextLines.length
    ? `\n\n内部上下文只用于核对保险责任。上下文来源已明确区分为“产品资料（后端搜索获得）”和“保单详情OCR（客户上传识别）”：产品资料用于核对公开保险责任和条款口径，OCR用于核对这张客户保单的关系信息、保费、保额、缴费期和保险期间等个单信息；客户姓名、身份证号、手机号等敏感信息不得出现在上下文或输出中。\n\n${contextLines.join('\n\n')}`
    : '';
  const skillBlock = buildPolicyAnalysisSkillInstructionBlock(skillPlan);
  const messages = [
    {
      role: 'system',
      content: `你是保险责任提炼助手。你只能输出保险责任。

输出要求：
1. 最终只输出保险责任，不要输出保单概览、注意事项、免责声明、产品利益说明、资料来源说明，也不要提到“联网”“搜索”“网页”“检索”“资料摘要”“内部上下文”“外部资料”等来源字样。
2. 优先输出严格 JSON，不要包裹 markdown 代码块。JSON 字段只包含：coverageTable。coverageTable 是对象数组，不要输出 report、notes、summary、overview、disclaimer 等其他字段。
3. coverageTable 是保险责任表，只能写保险公司在“发生保险事故、达到领取条件或满足合同约定触发条件”后承担的给付/赔付/报销责任。每一条保险责任都要单独写入 coverageTable 的一行；分阶段给付、额外给付、不同领取条件也要拆成独立行，不要把多项责任合并成一行。每行必须包含 coverageType、scenario、payout、note，并尽量补充指标拆解字段 liability、triggerCondition、formulaText、basis、value、unit、cashflowTreatment、calculationReason、requiredInputs、sourceExcerpt。
4. 指标拆解规则：liability 写具体责任名称；triggerCondition 写触发条件；formulaText 写可执行的给付公式或条款口径；basis 写计算基准，例如基本保险金额、已交保险费、现金价值、账户价值、实际医疗费用、领取计划/比例表、伤残等级比例表；value 和 unit 只在条款明确百分比、倍数或固定金额时填写；cashflowTreatment 只能取 scheduled_cashflow、claim_contingent、waiver_only、not_cashflow；sourceExcerpt 必须摘录支持该责任和公式的原文短句，不得编造。
5. 计算字段统一规则：所有可拆解责任都可以作为指标候选。能直接用保单基础字段计算的，formulaText/basis/value/unit 要写完整；暂时需要额外输入的，也要写完整公式口径，并用 requiredInputs 写需要的输入字段，例如 cashValue、accountValue、policyScheduleTable、policyYearOrAge、disabilityGrade、actualMedicalExpense、deductible、reimbursementRate、thirdPartyPaid、liabilityLimit、actualDays、dailyAmount、dayLimit。凡是需要额外输入才能算出具体金额的责任，标记 calculationEligible=false，并在 calculationReason 写明缺哪些输入。
6. 分红、红利领取方式、现金价值、减保、保单贷款、自动垫交、转换年金等属于产品利益机制或保全权益，不要作为 coverageTable 的独立行；若有效保额递增、现金价值或给付比例属于某条保险责任的计算公式，则只写进该责任的 payout 和 formulaText。
7. 上下文没有明确证据的内容不要编造；不要输出“本产品未明确提及某某责任”来凑内容。若产品资料和 OCR 不一致，保险责任以正式条款口径为主，个单金额、保费、期间以 OCR 或结构化保单字段为主。
${externalReviewMode ? '8. 当前只有非官方公开资料线索，必须更保守：只提炼资料中明确出现的保险责任；不要推断金额、比例、等待期、领取年龄；note 字段必须写“非官方资料待保险公司确认”。' : ''}

${skillBlock ? `${skillBlock}\n` : ''}
${contextBlock}`,
    },
  ];
  messages.push({
    role: 'user',
    content: `${policy.company || '未识别'}公司的保险产品：${policy.name || '未识别'}。请只输出保险责任 coverageTable，不要输出其他内容。`,
  });
  return messages;
}

async function requestPolicyAnalysis({ config, model, messages, fetchImpl, options = {} }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const url = new URL('/chat/completions', config.baseUrl);
    const body = {
      model,
      max_tokens: options.maxTokens ?? DEFAULT_ANALYSIS_MAX_TOKENS,
      messages,
    };
    if (isDeepSeekV4Model(model)) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = DEFAULT_DEEPSEEK_REASONING_EFFORT;
    }
    if (!usesDeepSeekThinkingMode(model)) {
      body.temperature = options.temperature ?? 0.15;
    }
    const response = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const bodyText = trimString(await response.text());
      const error = new Error(`POLICY_ANALYSIS_UPSTREAM_${response.status}:${bodyText || 'upstream_error'}`);
      error.code = 'POLICY_ANALYSIS_UPSTREAM_FAILED';
      throw error;
    }

    return response.json();
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw withCode(new Error('POLICY_ANALYSIS_TIMEOUT'), 'POLICY_ANALYSIS_TIMEOUT');
    }
    if (error?.code) throw error;
    throw withCode(error instanceof Error ? error : new Error('POLICY_ANALYSIS_FAILED'), 'POLICY_ANALYSIS_FAILED');
  } finally {
    clearTimeout(timeoutId);
  }
}

async function refineCoverageTableWithDetailOcr({ config, model, policy, analysisInput, analysis, fetchImpl }) {
  const payload = await requestPolicyAnalysis({
    config,
    model,
    fetchImpl,
    messages: buildCoverageRefinementMessages({ policy, analysisInput, analysis }),
    options: {
      temperature: 0.05,
      maxTokens: 2200,
    },
  });
  const refinementRawText = trimString(payload?.choices?.[0]?.message?.content);
  const parsed = extractJson(refinementRawText);
  const normalizedRows = normalizeCoverageTable(parsed?.coverageTable, {
    preferDirectContractLanguage: true,
  });
  const mergedRows = normalizedRows.length ? mergeRefinedCoverageRows(analysis.coverageTable, normalizedRows) : analysis.coverageTable;
  const hasSpecificUpgrade = mergedRows.some((row, index) => {
    const prev = analysis.coverageTable[index];
    return trimString(row?.coverageType) === trimString(prev?.coverageType)
      && (
        trimString(row?.scenario) !== trimString(prev?.scenario)
        || trimString(row?.payout) !== trimString(prev?.payout)
        || trimString(row?.note) !== trimString(prev?.note)
      );
  });
  return {
    analysis: {
      ...analysis,
      coverageTable: hasSpecificUpgrade ? mergedRows : analysis.coverageTable,
      disclaimer: trimString(parsed?.disclaimer) || analysis.disclaimer,
      cached: false,
    },
    model: trimString(payload?.model || model) || trimString(model),
    rawText: refinementRawText,
    upgraded: hasSpecificUpgrade,
  };
}

function parseLimitAmountFromPayout(payout, policy = {}) {
  const text = trimString(payout);
  if (!text) return 0;
  const wanMatch = text.match(/(\d+(?:\.\d+)?)\s*万/);
  if (wanMatch) return Math.round(Number(wanMatch[1]) * 10000);
  const yuanMatch = text.match(/(\d+(?:\.\d+)?)\s*元/);
  if (yuanMatch) return Math.round(Number(yuanMatch[1]));
  const baseAmount = Number(toNumberString(policy.amount));
  const multiMatch = text.match(/基本保额(?:的)?\s*(\d+(?:\.\d+)?)\s*倍/);
  if (multiMatch && Number.isFinite(baseAmount) && baseAmount > 0) {
    return Math.round(baseAmount * Number(multiMatch[1]));
  }
  if (/返还.*保费/.test(text)) {
    const premium = Number(toNumberString(policy.firstPremium || policy.annualPremium));
    if (Number.isFinite(premium) && premium > 0) return premium;
  }
  return 0;
}

export function mapAnalysisToPolicyResponsibilities(analysis, policy = {}) {
  const rows = Array.isArray(analysis?.coverageTable) ? analysis.coverageTable : [];
  return rows
    .map((item) => {
      const name = trimString(item?.coverageType);
      if (!name) return null;
      const scenario = trimString(item?.scenario);
      const note = trimString(item?.note);
      return {
        name,
        desc: [scenario, note].filter(Boolean).join('；'),
        limit: parseLimitAmountFromPayout(item?.payout, policy),
      };
    })
    .filter(Boolean);
}

function withCode(error, code) {
  error.code = code;
  return error;
}

export async function analyzeInsurancePolicyResponsibilities({
  policy,
  ocrText = '',
  fetchImpl = fetch,
  officialDomainProfiles: customOfficialDomainProfiles = [],
  knowledgeRecords = [],
  allowExternalReferences = false,
}) {
  const normalizedPolicy = normalizePolicyForPrompt(policy);
  const externalPolicy = stripSensitivePolicyForLlm(normalizedPolicy);
  const config = getConfig();
  if (!config.apiKey) {
    throw withCode(new Error('POLICY_ANALYSIS_PROVIDER_NOT_READY'), 'POLICY_ANALYSIS_PROVIDER_NOT_READY');
  }

  const analysisInput = buildAnalysisInput({
    policy: normalizedPolicy,
    ocrText,
  });
  const officialDomainProfiles = mergeOfficialDomainProfiles(customOfficialDomainProfiles);
  const searchQuery = buildSearchQuery(externalPolicy, officialDomainProfiles);
  const modelChain = buildModelChain(config);
  const knowledgeArtifacts = buildKnowledgeSearchArtifacts({
    policy: externalPolicy,
    records: knowledgeRecords,
    officialDomainProfiles,
    maxResults: config.smartSearchMaxResults,
    includeExternalReferences: allowExternalReferences,
  });
  const searchArtifacts = hasOfficialSearchSource(knowledgeArtifacts.sources) || (allowExternalReferences && hasExternalReviewSource(knowledgeArtifacts.sources))
    ? knowledgeArtifacts
    : await fetchPolicySearchArtifacts({
        config,
        policy: externalPolicy,
        fetchImpl,
        officialDomainProfiles,
      });
  const hasOfficialSource = hasOfficialSearchSource(searchArtifacts.sources);
  const hasExternalSource = allowExternalReferences && hasExternalReviewSource(searchArtifacts.sources);
  const localSkillPlan = buildLocalPolicyAnalysisSkillPlan({
    analysisInput,
    searchArtifacts,
    hasOfficialSource,
    hasExternalSource,
  });
  const canUseUploadedOcrFallback = localSkillPlan.skills.includes('uploaded_ocr_fallback');
  if (config.smartSearchEnabled && searchQuery && !hasOfficialSource && !hasExternalSource && !canUseUploadedOcrFallback) {
    throw withCode(
      new Error('POLICY_ANALYSIS_OFFICIAL_SOURCE_NOT_FOUND'),
      'POLICY_ANALYSIS_OFFICIAL_SOURCE_NOT_FOUND',
    );
  }
  const enrichedAnalysisInput = {
    ...analysisInput,
    searchContext: searchArtifacts.context,
  };

  let lastError = null;
  for (const model of modelChain) {
    try {
      const skillPlan = await selectPolicyAnalysisSkillPlan({
        config,
        model,
        policy: externalPolicy,
        analysisInput: enrichedAnalysisInput,
        searchArtifacts,
        fetchImpl,
      });
      const payload = await requestPolicyAnalysis({
        config,
        model,
        fetchImpl,
        messages: buildMessages({
          policy: externalPolicy,
          analysisInput: enrichedAnalysisInput,
          externalReviewMode: hasExternalSource && !hasOfficialSource,
          skillPlan,
        }),
      });
      const content = trimString(payload?.choices?.[0]?.message?.content);
      let parsedPayload = null;
      try {
        parsedPayload = extractJson(content);
      } catch {
        parsedPayload = { report: content };
      }
      let normalized = normalizeAnalysis(parsedPayload, String(payload?.model || model), {
        preferDirectContractLanguage: analysisInput.evidenceMode === 'detail_ocr',
        sensitiveTerms: analysisInput.sensitiveTerms,
      });
      const modelOutput = {
        model: trimString(payload?.model || model) || trimString(model),
        rawText: redactSensitiveAnalysisText(content, analysisInput.sensitiveTerms),
        refinementModel: '',
        refinementRawText: '',
        skillPlan,
      };
      const result = {
        analysis: normalized,
        modelOutput,
        sources: searchArtifacts.sources,
      };
      return buildAnalysisResult(result);
    } catch (error) {
      if (error?.code) {
        lastError = error;
      } else {
        lastError = withCode(error instanceof Error ? error : new Error('POLICY_ANALYSIS_FAILED'), 'POLICY_ANALYSIS_FAILED');
      }
      if (model === modelChain[modelChain.length - 1]) {
        throw lastError;
      }
    }
  }

  throw lastError || withCode(new Error('POLICY_ANALYSIS_FAILED'), 'POLICY_ANALYSIS_FAILED');
}

export function sanitizePolicyAnalysisOcrTextForLlm(ocrText = '') {
  return normalizeLlmOcrPromptText(ocrText);
}
