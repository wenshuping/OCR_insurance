import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const statePath = path.resolve(process.env.POLICY_OCR_APP_STATE_PATH || path.join(runtimeDir, 'state.json'));

const CATEGORIES = ['重疾险', '医疗险', '意外险', '定期寿险', '护理险', '年金险', '两全保险', '增额终身寿险', '万能账户', '投连险', '其他'];
const CATEGORY_ORDER = new Map(CATEGORIES.map((category, index) => [category, index]));

function trim(value) {
  return String(value || '').trim();
}

function normalize(value) {
  return trim(value)
    .replace(/[（）]/gu, (ch) => (ch === '（' ? '(' : ')'))
    .replace(/\s+/gu, '');
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseCliJson(stdout) {
  const text = String(stdout || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`lark-cli did not return JSON: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start, end + 1));
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRetryableLarkError(text) {
  return /800004135|limited|rate.?limit|too many|too frequent|频率|限流|timeout|timed out|i\/o timeout|EOF|ECONNRESET|ETIMEDOUT|429|502|503|504/iu.test(
    text,
  );
}

function runLark(args, { retries = 8, maxBuffer = 40 * 1024 * 1024 } = {}) {
  let lastError = '';
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const result = spawnSync('lark-cli', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer,
      timeout: 90_000,
    });
    if (result.status === 0) return parseCliJson(result.stdout);
    lastError = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (attempt < retries && isRetryableLarkError(lastError)) {
      sleepMs(Math.min(60_000, attempt * 8_000));
      continue;
    }
    break;
  }
  throw new Error(lastError.slice(0, 2000) || `lark-cli ${args.join(' ')} failed`);
}

function hasAnnuityNameSignal(name) {
  return /年金|养老保险|商业养老|退休金|养老金|补充养老|教育金/u.test(name);
}

function hasStructuredAnnuityResponsibility(text) {
  if (/转化为.{0,20}年金|选择权.{0,80}年金|受益人申领.{0,120}年金/u.test(text)) return false;

  const hasSurvivalBenefit = /生存保险金|生存金|生存给付|生存现金|年金|养老金|教育金|婚嫁金|祝寿金/u.test(text) && /生存/u.test(text);
  const hasStartTime =
    /年满[一二三四五六七八九十百\d]+(?:周岁|岁)|[男女][一二三四五六七八九十百\d]+(?:周岁|岁)|第[一二三四五六七八九十百\d]+个?(?:保单)?周年|(?:首个)?年生效对应日|每满?[一二三四五六七八九十百\d]+个?(?:保单)?年度|每[一二三四五六七八九十百\d]*周年|每届满[一二三四五六七八九十百\d]*周年|合同生效后(?:的)?第?[一二三四五六七八九十百\d]+(?:个)?周年|领取期|养老金领取年龄/u.test(
      text,
    );
  const hasAmountFormula =
    /(?:按|等值于|保证给付)[^，。；;]{0,50}(?:保险金额|基本保险金额|所交保险费|已交保险费|保险费|保费)[^，。；;]{0,30}(?:[一二三四五六七八九十百\d]+(?:\.\d+)?%|给付)|每(?:年|月|期)每份[一二三四五六七八九十百\d]+元|每份[^，。；;]{0,20}(?:月)?领取标准详见|给付金额详见|领取金额|月领取标准/u.test(
      text,
    );
  const hasRepeatedPayment =
    /分别|每(?:年|月|期|届满|满?[一二三四五六七八九十百\d]+个?(?:保单)?年度|[一二三四五六七八九十百\d]*周年)|年生效对应日|逐月|逐年|分[一二三四五六七八九十百\d]+年|直至|领取期|[一二三四五六七八九十百\d]+、[一二三四五六七八九十百\d]+/u.test(
      text,
    );

  return hasSurvivalBenefit && hasStartTime && hasAmountFormula && hasRepeatedPayment;
}

function hasInvestmentLinkedSignal(name, title, allText) {
  if (/投资连结|投连/u.test(`${name} ${title}`)) return true;
  return (
    /投资账户|投资单位|单位价格|买入价|卖出价|账户转换|资产管理费/u.test(allText) &&
    /投资风险.{0,20}投保人承担|不(?:保证|承诺).{0,20}最低.{0,10}(?:收益|回报)|无.{0,10}最低.{0,10}(?:收益|回报)/u.test(allText)
  );
}

function hasUniversalSignal(name, title, allText) {
  if (/万能型|万能险|万能账户/u.test(`${name} ${title}`)) return true;
  if (/万能账户/u.test(allText)) return true;
  return /(?:账户价值|个人账户价值)/u.test(allText) && /结算利率|最低保证利率|保底利率|追加保险费|初始费用|保单管理费|风险保险费|部分领取手续费/u.test(allText);
}

function hasMedicalWideSignal(name) {
  return /医疗|住院医疗|住院费用|门急诊|门诊|费用补偿|费用报销|报销|医保|药品|药械|质子重离子|特药|特定药|院外药|护理服务费用|健康保险|住院.*收入保障|重病监护|重症监护|ICU|住院津贴|住院补贴|住院日额|每日住院|住院给付|住院医护补贴|住院现金补偿/u.test(
    name,
  );
}

function hasCriticalIllnessNameSignal(name) {
  return /重大疾病|重大疾病保险|重疾|疾病保险|特定疾病|恶性肿瘤|癌症|防癌|轻症|中症|豁免保费.*疾病|豁免保险费.*疾病/u.test(
    name,
  );
}

function hasAccidentNameSignal(name) {
  return /意外|交通工具|交通意外|驾乘|旅行|航空|乘客|出行|建筑工程人员/u.test(name);
}

function hasPureAccidentProductNameSignal(name) {
  return /意外伤害.{0,16}保险|意外保险|综合意外|交通意外|驾乘意外|旅行意外|学生平安|学平险|借贷安心/u.test(name) && !/两全|生死两全|重大疾病|重疾|年金|终身寿险|终身寿/u.test(name);
}

function analyzeAccidentSubtype({ name, title, body, allText }) {
  const nameText = `${name} ${title}`;
  const hasNameAccidentMedical = /意外.{0,16}(医疗|费用补偿|住院|门急诊)|医疗.{0,16}意外|突发急性病/u.test(nameText);
  const hasOnlyName = body.length < 20;
  const hasNonAccidentProductName = /两全|生死两全|重大疾病|重疾|年金|终身寿险|终身寿/u.test(nameText);
  const nameHasAccident = hasAccidentNameSignal(nameText);
  const hasPureAccidentProductName = hasPureAccidentProductNameSignal(nameText);
  const hasAccidentContext = hasAccidentNameSignal(nameText) || /意外伤害|交通事故|驾乘|航空|客运|电梯|高空坠物|高空抛物|重大自然灾害|突发急性病/u.test(allText);
  const hasAllCauseOrDiseaseDeath =
    /无论何种原因[^。；;]{0,50}(?:身故|全残|身体全残)|所有原因[^。；;]{0,50}(?:身故|全残|身体全残)|(?:疾病|自然死亡)[^。；;]{0,50}(?:身故|全残|身体全残)|被保险人(?:身故|全残|身体全残)[^。；;]{0,80}(?:给付|身故保险金|全残保险金)/u.test(
      allText,
    ) && !hasPureAccidentProductName;
  const specificBenefits = allText.match(
    /(?:一般|交通|驾乘|航空|客运|自驾|公共场所|重大自然灾害|电梯|高空坠物|高空抛物|步行及骑行|轮船|汽车|列车|民航|水陆公共交通|私家车|公务用车|商务用车|租赁车)[^。；;]{0,60}意外伤害?[^。；;]{0,40}(?:身故|伤残|残疾|全残|身体全残)[^。；;]{0,20}保险金/gu,
  );
  const specificBenefitLabels = new Set(
    (specificBenefits || []).map((benefit) => {
      const label = benefit.match(
        /一般|步行及骑行|驾乘|高空坠物|高空抛物|客运轮船|客运汽车|电梯|公共场所|重大自然灾害|客运列车|航空|民航|水陆公共交通|私家车|公务用车|商务用车|租赁车|交通|自驾|客运|轮船|汽车|列车/u,
      );
      return label?.[0] || benefit.slice(0, 24);
    }),
  );
  const hasSpecificDeathDisability = specificBenefitLabels.size >= 2;
  const hasHighMultipleAccidentBenefit =
    /意外伤害[^。；;]{0,160}按基本保险金额的(?:[1-9]\d|[二三四五六七八九十百])[^。；;]{0,8}倍给付/u.test(allText);
  const hasNamedAccidentDeathDisabilityBenefit =
    /(?:一般|交通|驾乘|航空|客运|自驾|公共场所|重大自然灾害|电梯|高空坠物|高空抛物|步行及骑行|轮船|汽车|列车|民航|水陆公共交通|私家车|公务用车|商务用车|租赁车)?意外(?:伤害)?(?:身故|伤残|残疾|全残|身体全残|骨折)保险金|意外(?:身故|伤残|残疾|全残|骨折)保险金/u.test(
      allText,
    );
  const hasGenericDeathDisability = /身故保险金|伤残保险金|残疾保险金|骨折保险金/u.test(allText);
  const hasMaterialDeathDisability = hasSpecificDeathDisability || hasHighMultipleAccidentBenefit || (nameHasAccident && hasNamedAccidentDeathDisabilityBenefit);
  const hasDeathDisability =
    hasMaterialDeathDisability || ((hasPureAccidentProductName || nameHasAccident) && hasGenericDeathDisability);
  const hasExplicitAccidentMedical = /意外伤害医疗|意外医疗|突发急性病医疗|意外[^。；;]{0,40}(?:医疗费用|住院医疗|门急诊医疗|住院津贴)/u.test(allText);
  const hasGenericMedicalReimbursement = /医疗费用保险金|医疗费用给付|住院医疗费用|门急诊医疗费用|费用补偿|费用报销|扣除免赔额|免赔额|实际发生并支付|合理且必要|剩余部分/u.test(allText);
  const hasMedicalReimbursement = hasExplicitAccidentMedical || hasNameAccidentMedical || ((hasPureAccidentProductName || nameHasAccident) && hasGenericMedicalReimbursement);

  let category = '非意外险';
  if (hasDeathDisability && hasMedicalReimbursement) category = '组合型';
  else if (hasDeathDisability) category = '大意外';
  else if (hasMedicalReimbursement) category = '小意外';
  else if (hasPureAccidentProductName) category = hasNameAccidentMedical ? '小意外' : '大意外';

  let confidence = '低';
  if (category !== '非意外险' && hasNameAccidentMedical) confidence = '高';
  else if (category !== '非意外险' && !hasOnlyName && (hasMaterialDeathDisability || hasMedicalReimbursement)) confidence = '高';
  else if (category !== '非意外险' && hasPureAccidentProductName) confidence = hasOnlyName ? '中' : '中';
  else if (category !== '非意外险' && hasOnlyName) confidence = '中';

  let note = '';
  if (hasAllCauseOrDiseaseDeath && !hasPureAccidentProductName && !hasMaterialDeathDisability && !hasExplicitAccidentMedical && !hasNameAccidentMedical) {
    category = '非意外险';
    confidence = '高';
    note = '身故责任覆盖疾病/所有原因，意外责任不是纯意外险主体';
  } else if (hasNonAccidentProductName && !hasMaterialDeathDisability && !hasExplicitAccidentMedical && !hasNameAccidentMedical) {
    category = '非意外险';
    confidence = '低';
    note = '名称含两全/重疾/年金/终身寿等非意外主险字样，未命中物质性意外责任';
  } else if (!hasAccidentContext) {
    category = '非意外险';
    confidence = '低';
    note = '未命中意外责任或意外医疗责任';
  } else if (hasNonAccidentProductName && category === '非意外险') {
    note = '名称含两全/重疾/年金等非意外主险字样，且未命中明确意外责任';
  } else if (category === '非意外险') {
    note = '有意外相关语境，但未命中身故/伤残或医疗费用责任';
  } else if (hasPureAccidentProductName && !hasDeathDisability && !hasMedicalReimbursement) {
    note = '产品名称明确为意外伤害保险，条款责任未完整命中给付模式，按名称保留意外险并需复核';
  } else if (hasOnlyName) {
    note = '仅名称命中，缺少条款细节';
  }

  return {
    category,
    confidence,
    hasDeathDisability,
    hasMedicalReimbursement,
    isPureAccidentInsurance: hasPureAccidentProductName && !hasAllCauseOrDiseaseDeath,
    isAccidentTriggered: category !== '非意外险' || hasAccidentContext,
    note,
  };
}

function hasBodyAnnuityExclusionNameSignal(name) {
  return /重大疾病|重大疾病保险|重疾|疾病保险|特定疾病|恶性肿瘤|癌症|防癌|轻症|中症|医疗|意外|护理|失能|定期寿险|定期寿|终身寿险|终身寿|万能型|万能险|投资连结|投连/u.test(
    name,
  );
}

function hasEndowmentSignal(name, allText, { hasStructuredAnnuity = false } = {}) {
  if (/两全|生死两全/u.test(name)) return true;
  if (hasStructuredAnnuity) return false;

  const hasDeathBenefit = /身故保险金|身故[^。；;]{0,80}给付/u.test(allText);
  const hasMaturitySurvivalBenefit =
    /满期(?:生存)?保险金|满期金|生存至保险期间届满|保险期间届满[^。；;]{0,40}生存/u.test(allText);
  const hasOneTimeMaturity = /满期(?:生存)?保险金[^。；;]{0,80}(?:本合同终止|合同终止)|一次性[^。；;]{0,40}满期/u.test(allText);

  return hasDeathBenefit && hasMaturitySurvivalBenefit && hasOneTimeMaturity;
}

function hasTermLifeNameSignal(name) {
  return /定期寿险|定期寿|一年期寿险|团体定期寿险|定期团体寿险/u.test(name);
}

function uniqueCategories(categories) {
  const unique = [...new Set(categories.filter(Boolean))];
  return unique.sort((left, right) => (CATEGORY_ORDER.get(left) ?? 999) - (CATEGORY_ORDER.get(right) ?? 999));
}

function formatCategories(categories) {
  const unique = uniqueCategories(categories);
  return unique.length ? unique.join('、') : '其他';
}

function parseCategories(value) {
  const parts = trim(value)
    .split(/[、,，;；/]+/u)
    .map((part) => trim(part))
    .filter(Boolean);
  return uniqueCategories(parts.length ? parts : ['其他']);
}

function isValidProductType(value) {
  return parseCategories(value).every((category) => CATEGORIES.includes(category));
}

function classifyProductCategories(record) {
  const name = normalize(record.productName || record.title);
  const title = normalize(record.title);
  const body = normalize([record.snippet, record.pageText, record.responsibilityText].filter(Boolean).join(' '));
  const allText = `${name} ${title} ${body}`;
  const categories = [];

  if (!name) return ['其他'];

  const hasInvestmentLinked = hasInvestmentLinkedSignal(name, title, allText);
  const hasUniversal = hasUniversalSignal(name, title, allText);
  const accidentSubtype = analyzeAccidentSubtype({ name, title, body, allText });

  if (hasInvestmentLinked) categories.push('投连险');
  if (!hasInvestmentLinked && hasUniversal) categories.push('万能账户');

  if (/护理|失能/u.test(name)) categories.push('护理险');

  const hasStructuredAnnuity =
    hasAnnuityNameSignal(name) || (!hasBodyAnnuityExclusionNameSignal(name) && hasStructuredAnnuityResponsibility(allText));

  if (hasStructuredAnnuity) categories.push('年金险');

  if (hasEndowmentSignal(name, allText, { hasStructuredAnnuity })) categories.push('两全保险');

  if (
    !hasInvestmentLinked &&
    !hasUniversal &&
    /(增额|递增).{0,12}终身寿|终身寿.{0,12}(增额|递增)|终身寿险|终身寿/u.test(name) &&
    /增额|递增|有效保险金额|现金价值|减保|部分领取|保单贷款|分红型|终身寿/u.test(allText)
  ) {
    categories.push('增额终身寿险');
  }

  if (accidentSubtype.category !== '非意外险') categories.push('意外险');

  if (hasMedicalWideSignal(name) || accidentSubtype.hasMedicalReimbursement) {
    categories.push('医疗险');
  }

  if (hasCriticalIllnessNameSignal(name)) {
    categories.push('重疾险');
  }

  if (hasTermLifeNameSignal(name) && !/两全|生死两全/u.test(name)) categories.push('定期寿险');

  return uniqueCategories(categories.length ? categories : ['其他']);
}

function classifyProduct(record) {
  return formatCategories(classifyProductCategories(record));
}

function analyzeRecordAccidentSubtype(record) {
  const name = normalize(record.productName || record.title);
  const title = normalize(record.title);
  const body = normalize([record.snippet, record.pageText, record.responsibilityText].filter(Boolean).join(' '));
  const allText = `${name} ${title} ${body}`;
  return analyzeAccidentSubtype({ name, title, body, allText });
}

function loadState() {
  const state = readJson(statePath, {});
  if (!Array.isArray(state.knowledgeRecords)) {
    throw new Error(`state file has no knowledgeRecords: ${statePath}`);
  }
  return state;
}

function loadConfigs() {
  return fs
    .readdirSync(runtimeDir)
    .filter((name) => /^feishu-knowledge.*\.json$/u.test(name))
    .sort()
    .map((fileName) => {
      const saved = readJson(path.join(runtimeDir, fileName), {});
      return {
        fileName,
        identity: trim(saved.identity || process.env.FEISHU_KNOWLEDGE_AS) || 'user',
        baseToken: trim(saved.baseToken || process.env.FEISHU_KNOWLEDGE_BASE_TOKEN),
        tableId: trim(saved.tableId),
        tableName: trim(saved.tableName),
      };
    })
    .filter((config) => config.baseToken && config.tableId);
}

function countBy(records, keyFn) {
  const counts = new Map();
  for (const record of records) {
    const key = keyFn(record) || '其他';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts]
    .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0]), 'zh-CN'))
    .map(([key, count]) => ({ key, count }));
}

function buildLocalPlan(state) {
  const changes = [];
  const rows = state.knowledgeRecords;
  for (const record of rows) {
    const oldType = trim(record.productType);
    const newType = classifyProduct(record);
    if (!isValidProductType(newType)) throw new Error(`invalid category: ${newType}`);
    if (oldType !== newType) {
      const accidentSubtype = analyzeRecordAccidentSubtype(record);
      changes.push({
        id: String(record.id),
        company: trim(record.company),
        productName: trim(record.productName),
        materialType: trim(record.materialType || record.sourceType),
        oldType,
        newType,
        accidentSubtype: accidentSubtype.category,
        accidentConfidence: accidentSubtype.confidence,
        accidentIsPure: accidentSubtype.isPureAccidentInsurance,
        accidentTriggered: accidentSubtype.isAccidentTriggered,
        accidentHasDeathDisability: accidentSubtype.hasDeathDisability,
        accidentHasMedicalReimbursement: accidentSubtype.hasMedicalReimbursement,
        accidentNote: accidentSubtype.note,
      });
    }
  }
  return {
    total: rows.length,
    changes,
    finalDistribution: countBy(rows.map((record) => ({ ...record, productType: classifyProduct(record) })), (record) => record.productType),
    changeDistribution: countBy(changes, (change) => change.newType),
    changedOldTypes: countBy(changes, (change) => change.oldType || '(empty)'),
  };
}

function applyLocalPlan(state, plan) {
  const categoryById = new Map(plan.changes.map((change) => [String(change.id), change.newType]));
  for (const record of state.knowledgeRecords) {
    const next = categoryById.get(String(record.id));
    if (next) record.productType = next;
  }
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const backupPath = path.join(runtimeDir, 'backups', `state-before-product-type-classification-${stamp}.json`);
  writeJson(backupPath, readJson(statePath, {}));
  state.lastProductTypeClassification = {
    classifiedAt: new Date().toISOString(),
    taxonomy: CATEGORIES,
    changed: plan.changes.length,
    backupPath,
  };
  writeJson(statePath, state);
  return backupPath;
}

function readRemoteTable(config) {
  let offset = 0;
  const rows = [];
  while (true) {
    const payload = runLark([
      'base',
      '+record-list',
      '--as',
      config.identity,
      '--base-token',
      config.baseToken,
      '--table-id',
      config.tableId,
      '--field-id',
      '本地ID',
      '--field-id',
      '产品分类',
      '--limit',
      '200',
      '--offset',
      String(offset),
      '--format',
      'json',
    ]);
    const data = payload?.data || {};
    const records = data.data || [];
    const recordIds = data.record_id_list || [];
    for (let index = 0; index < records.length; index += 1) {
      const row = Array.isArray(records[index]) ? records[index] : [];
      rows.push({
        localId: trim(row[0]),
        productType: trim(row[1]),
        recordId: recordIds[index] || '',
        configFileName: config.fileName,
        tableName: config.tableName,
      });
    }
    if (!data.has_more || records.length === 0) break;
    offset += records.length;
    sleepMs(250);
  }
  return rows;
}

function readAllRemote(configs) {
  const rows = [];
  const errors = [];
  for (const config of configs) {
    try {
      const tableRows = readRemoteTable(config);
      rows.push(...tableRows);
      console.error(`[classify] read ${config.fileName} rows=${tableRows.length}`);
      sleepMs(600);
    } catch (error) {
      const message = String(error?.message || error).slice(0, 1000);
      errors.push({ configFileName: config.fileName, tableName: config.tableName, message });
      console.error(`[classify] read failed ${config.fileName}: ${message.slice(0, 180)}`);
    }
  }
  return { rows, errors };
}

function buildFeishuPlan(state, remoteRows) {
  const localTypeById = new Map(
    state.knowledgeRecords.map((record) => [String(record.id), trim(record.productType) || classifyProduct(record)]),
  );
  const duplicateRemoteIds = new Set();
  const seenRemoteIds = new Set();
  const missingLocalIds = [];
  const updates = [];
  for (const row of remoteRows) {
    if (!row.localId) continue;
    if (seenRemoteIds.has(row.localId)) duplicateRemoteIds.add(row.localId);
    seenRemoteIds.add(row.localId);
    const target = localTypeById.get(row.localId);
    if (!target) {
      missingLocalIds.push(row);
      continue;
    }
    if (row.productType !== target) {
      updates.push({
        localId: row.localId,
        recordId: row.recordId,
        configFileName: row.configFileName,
        tableName: row.tableName,
        oldType: row.productType,
        newType: target,
      });
    }
  }
  const missingRemoteIds = [];
  for (const id of localTypeById.keys()) {
    if (!seenRemoteIds.has(id)) missingRemoteIds.push(id);
  }
  return {
    remoteRows: remoteRows.length,
    updates,
    missingRemoteIds,
    missingLocalIds,
    duplicateRemoteIds: [...duplicateRemoteIds],
    updateDistribution: countBy(updates, (update) => update.newType),
  };
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function applyFeishuPlan(plan, configs) {
  const configByName = new Map(configs.map((config) => [config.fileName, config]));
  const byTableAndCategory = new Map();
  for (const update of plan.updates) {
    const key = `${update.configFileName}\u0001${update.newType}`;
    if (!byTableAndCategory.has(key)) byTableAndCategory.set(key, { configFileName: update.configFileName, category: update.newType, recordIds: [] });
    byTableAndCategory.get(key).recordIds.push(update.recordId);
  }

  let updated = 0;
  for (const group of byTableAndCategory.values()) {
    const config = configByName.get(group.configFileName);
    if (!config) throw new Error(`missing config: ${group.configFileName}`);
    for (const ids of chunk(group.recordIds.filter(Boolean), 100)) {
      runLark([
        'base',
        '+record-batch-update',
        '--as',
        config.identity,
        '--base-token',
        config.baseToken,
        '--table-id',
        config.tableId,
        '--json',
        JSON.stringify({
          record_id_list: ids,
          patch: {
            产品分类: group.category,
          },
        }),
      ]);
      updated += ids.length;
      console.error(`[classify] feishu updated ${updated}/${plan.updates.length}`);
      sleepMs(500);
    }
  }
  return { updated };
}

function main() {
  const applyLocal = hasFlag('apply-local');
  const syncFeishu = hasFlag('sync-feishu');
  const verifyOnly = hasFlag('verify-only');
  const includeChanges = hasFlag('include-changes');
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const state = loadState();
  const localPlan = buildLocalPlan(state);
  const summary = {
    createdAt: new Date().toISOString(),
    taxonomy: CATEGORIES,
    statePath,
    applyLocal,
    syncFeishu,
    verifyOnly,
    includeChanges,
    local: {
      total: localPlan.total,
      changes: localPlan.changes.length,
      finalDistribution: localPlan.finalDistribution,
      changeDistribution: localPlan.changeDistribution,
      changedOldTypes: localPlan.changedOldTypes.slice(0, 50),
      samples: localPlan.changes.slice(0, 30),
      allChanges: includeChanges ? localPlan.changes : undefined,
    },
  };

  if (applyLocal && !verifyOnly) {
    summary.local.backupPath = applyLocalPlan(state, localPlan);
  }

  if (syncFeishu || verifyOnly) {
    const configs = loadConfigs();
    const { rows: remoteRows, errors } = readAllRemote(configs);
    const feishuPlan = buildFeishuPlan(state, remoteRows);
    summary.feishu = {
      configs: configs.length,
      remoteRows: feishuPlan.remoteRows,
      updates: feishuPlan.updates.length,
      missingRemoteIds: feishuPlan.missingRemoteIds.length,
      missingLocalIds: feishuPlan.missingLocalIds.length,
      duplicateRemoteIds: feishuPlan.duplicateRemoteIds.length,
      updateDistribution: feishuPlan.updateDistribution,
      errors,
      samples: feishuPlan.updates.slice(0, 30),
    };
    if (syncFeishu && !verifyOnly) {
      if (errors.length || feishuPlan.missingRemoteIds.length || feishuPlan.missingLocalIds.length || feishuPlan.duplicateRemoteIds.length) {
        summary.blocked = true;
        summary.blockReason = 'remote/local ids are not aligned';
      } else {
        summary.feishu.result = applyFeishuPlan(feishuPlan, configs);
      }
    }
  }

  const summaryPath = path.join(runtimeDir, `knowledge-product-type-classification-${stamp}.json`);
  writeJson(summaryPath, summary);
  console.log(JSON.stringify({ summaryPath, ...summary }, null, 2));
}

main();
