import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const VERSION = '2026-05-31-remaining-optional-responsibility-quantification';
const DB_PATHS = [
  path.join(runtimeDir, 'policy-ocr.sqlite'),
  path.join(runtimeDir, 'local', 'policy-ocr.sqlite'),
];

const GREATLIFE_TERMS_URLS = {
  opt_acecfad51e6616ef:
    'https://www.greatlife.cn/userfiles/files/%E9%95%BF%E5%9F%8E%E6%98%93%E7%94%9F%E5%AE%88%E6%8A%A4%E4%BC%98%E9%80%89%E7%89%88%E9%87%8D%E5%A4%A7%E7%96%BE%E7%97%85%E4%BF%9D%E9%99%A9%EF%BC%88%E4%BA%92%E8%81%94%E7%BD%91%EF%BC%89%E6%9D%A1%E6%AC%BE.pdf',
  opt_a785bd265819dd1f:
    'https://www.greatlife.cn/userfiles/files/%E9%95%BF%E5%9F%8E%E6%98%93%E7%94%9F%E5%AE%88%E6%8A%A4%E7%BB%88%E8%BA%AB%E7%89%88%E9%87%8D%E5%A4%A7%E7%96%BE%E7%97%85%E4%BF%9D%E9%99%A9%EF%BC%88%E4%BA%92%E8%81%94%E7%BD%91%EF%BC%89%E6%9D%A1%E6%AC%BE.pdf',
};

const SOURCE_TEXT_FILES = new Map([
  ['83', '.runtime/tmp/pending-official/direct/83.txt'],
  ['1311', '.runtime/tmp/pending-official/direct/1311.txt'],
  ['4871', '.runtime/tmp/remaining-official/taikang-city-base/terms.txt'],
  ['4879', '.runtime/tmp/remaining-official/taikang-city-c/terms.txt'],
  ['4881', '.runtime/tmp/remaining-official/taikang-city-internet/terms.txt'],
  ['4893', '.runtime/tmp/taikang-city-b/terms.txt'],
  ['25766', '.runtime/tmp/remaining-official/zhonghua-travel-accident/terms.txt'],
  ['25769', '.runtime/tmp/remaining-official/zhonghua-travel-medical/terms.txt'],
  ['26991', '.runtime/tmp/remaining-official/nongyin-overseas/terms-20090828.txt'],
  [
    '1883',
    '.runtime/tmp/pending-official/remaining/chinalife-D.txt',
  ],
  [
    '1885',
    '.runtime/tmp/pending-official/remaining/chinalife-A.txt',
  ],
  ['6285', '.runtime/tmp/pending-official/remaining/6285.txt'],
  ['16683', '.runtime/tmp/pending-official/direct/16683.txt'],
  ['24368', '.runtime/tmp/pending-official/greatlife/ysyouxuan_terms.txt'],
  ['24934', '.runtime/tmp/pending-official/greatlife/yszhongshen_terms.txt'],
  [
    '25927',
    '.runtime/tmp/pending-official/remaining/zhonghua-fu/20240117_中华福（经典版）终身重大疾病保险（B款）_470/02-中华福（经典版）终身重大疾病保险（B款）条款.txt',
  ],
]);

const SOURCE_RECORD_OVERRIDES_BY_OPTIONAL_ID = new Map([
  ['opt_2e3c5a80f226c4d1', '4871'],
  ['opt_6ba9ba99c82a98b1', '4879'],
  ['opt_55744b450a15ca64', '4881'],
  ['opt_ded82eef8c2ad677', '4893'],
]);

const TERMS_SOURCE_OVERRIDES_BY_RECORD_ID = new Map([
  [
    '4871',
    {
      sourceUrl:
        'https://www.taikanglife.com/uploader/pubProductFile/2026/01/04/24f8152b-f7cd-4cc3-908a-7794222926e3.pdf',
      sourceTitle: '泰康城市定制型医保补充团体医疗保险产品条款',
    },
  ],
  [
    '4879',
    {
      sourceUrl:
        'https://www.taikanglife.com/uploader/pubProductFile/2026/01/04/60aac074-cf2e-4428-95be-3506a2c79016.pdf',
      sourceTitle: '泰康城市定制医保补充C款团体医疗保险产品条款',
    },
  ],
  [
    '4881',
    {
      sourceUrl:
        'https://www.taikanglife.com/uploader/pubProductFile/2026/01/04/29b36248-2558-476b-9167-ed86cd529ecc.pdf',
      sourceTitle: '泰康城市定制型医保补充团体医疗保险（互联网）产品条款',
    },
  ],
  [
    '4893',
    {
      sourceUrl:
        'https://www.taikanglife.com/uploader/pubProductFile/2026/01/04/96d13f05-0af3-4412-b84d-6b9b5ac20268.pdf',
      sourceTitle: '泰康城市定制医保补充B款团体医疗保险产品条款',
    },
  ],
]);

function trim(value) {
  return String(value ?? '').trim();
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parsePayload(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeOneLine(value) {
  return trim(value)
    .normalize('NFKC')
    .replace(/\r/gu, '\n')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s+/gu, ' ');
}

function sha1(value, length = 18) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, length);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function backupSqlite(dbPath) {
  if (!(await exists(dbPath))) return [];
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  await fs.mkdir(backupDir, { recursive: true });
  const label = dbPath.includes(`${path.sep}local${path.sep}`) ? 'local-policy-ocr' : 'policy-ocr';
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const backupBase = path.join(
    backupDir,
    `${label}-before-remaining-optional-quantification-${stamp}.sqlite`,
  );
  const copied = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${dbPath}${suffix}`;
    if (!(await exists(source))) continue;
    const target = `${backupBase}${suffix}`;
    await fs.copyFile(source, target);
    copied.push(target);
  }
  return copied;
}

function excerptAround(text = '', marker = '', length = 900) {
  const source = normalizeOneLine(text);
  const index = marker instanceof RegExp ? source.search(marker) : source.indexOf(marker);
  if (index < 0) return source.slice(0, length);
  return source.slice(Math.max(0, index - 120), index + length).trim();
}

async function loadOfficialText(sourceRecordId) {
  const relativePath = SOURCE_TEXT_FILES.get(String(sourceRecordId));
  if (!relativePath) return '';
  const filePath = path.join(projectRoot, relativePath);
  if (!(await exists(filePath))) return '';
  return fs.readFile(filePath, 'utf8');
}

function sourceInfo(row, overrides = {}) {
  const payload = row.payload || {};
  return {
    sourceRecordId: trim(overrides.sourceRecordId ?? payload.sourceRecordId),
    sourceUrl: trim(overrides.sourceUrl ?? payload.sourceUrl),
    sourceTitle: trim(overrides.sourceTitle ?? payload.sourceTitle ?? row.productName),
  };
}

function valueText(value, explicit = '') {
  if (explicit) return explicit;
  if (value === undefined || value === null) return '';
  return String(value);
}

function indicatorId(row, liability, condition = '', formulaText = '') {
  return `ind_rem_opt_${sha1([VERSION, row.id, row.company, row.productName, liability, condition, formulaText].join('\u001f'))}`;
}

function buildIndicator(row, definition, now, sourceOverrides = {}) {
  const info = sourceInfo(row, sourceOverrides);
  const liability = trim(definition.liability);
  const condition = trim(definition.condition);
  const formulaText = trim(definition.formulaText);
  const value = definition.value ?? null;
  const payload = {
    id: indicatorId(row, liability, condition, formulaText),
    version: VERSION,
    company: row.company,
    productName: row.productName,
    coverageType: trim(definition.coverageType || '保险责任'),
    liability,
    value,
    valueText: valueText(value, definition.valueText),
    unit: trim(definition.unit),
    basis: trim(definition.basis),
    formulaText,
    condition,
    extractionMethod: 'remaining_optional_responsibility_manual_official_evidence',
    responsibilityScope: 'optional',
    optionalResponsibilityId: row.id,
    quantificationStatus: 'quantified',
    sourceRecordId: info.sourceRecordId,
    sourceUrl: info.sourceUrl,
    sourceTitle: info.sourceTitle,
    sourceExcerpt: trim(definition.sourceExcerpt || row.payload?.sourceExcerpt).slice(0, 900),
    sourceEvidenceLevel: 'official_terms',
    governanceReasons: ['quantify_remaining_optional_responsibility'],
    updatedAt: now,
  };
  return {
    id: payload.id,
    company: row.company,
    productName: row.productName,
    coverageType: payload.coverageType,
    liability,
    payload,
  };
}

function plusDefinitions(excerpt) {
  return [
    {
      coverageType: '医疗保障',
      liability: '普通门急诊医疗保险金年累计给付次数限制',
      value: 45,
      unit: '次/年',
      basis: '普通门急诊医疗保险金',
      formulaText: '一般门急诊医疗费、中医及其他特殊疗法门急诊医疗费、精神疾病门急诊医疗费年累计给付次数以45次为限',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '门急诊特定费用给付比例',
      value: 90,
      unit: '%',
      basis: '门急诊特定治疗费、药品费、材料费、检查化验费',
      formulaText: '门急诊特定治疗费、特定药品费、特定材料费、特定检查化验费 × 90%',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '一般门急诊其他费用给付比例',
      value: 90,
      unit: '%',
      basis: '医生费、治疗费、药品费、材料费、检查化验费等',
      condition: '门诊共付医疗机构第1-10次',
      formulaText: '门诊共付医疗机构第1-10次一般门急诊其他费用 × 90%',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '一般门急诊其他费用给付比例',
      value: 80,
      unit: '%',
      basis: '医生费、治疗费、药品费、材料费、检查化验费等',
      condition: '门诊共付医疗机构第11-20次',
      formulaText: '门诊共付医疗机构第11-20次一般门急诊其他费用 × 80%',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '一般门急诊其他费用给付比例',
      value: 50,
      unit: '%',
      basis: '医生费、治疗费、药品费、材料费、检查化验费等',
      condition: '门诊共付医疗机构第21次及以上',
      formulaText: '门诊共付医疗机构第21次及以上一般门急诊其他费用 × 50%',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '一般门急诊其他费用给付比例',
      value: 100,
      unit: '%',
      basis: '医生费、治疗费、药品费、材料费、检查化验费等',
      condition: '非门诊共付医疗机构',
      formulaText: '非门诊共付医疗机构一般门急诊其他费用 × 100%',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '耐用医疗器械购买或者租赁费年限额',
      value: 200000,
      unit: '元/年',
      basis: '耐用医疗器械购买或者租赁费',
      formulaText: '耐用医疗器械购买或者租赁费年限额20万元',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '中医及其他特殊疗法门急诊医疗费年限额',
      value: 20000,
      unit: '元/年',
      basis: '中医及其他特殊疗法门急诊医疗费',
      formulaText: '中医及其他特殊疗法门急诊医疗费年限额2万元',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '中医及其他特殊疗法门急诊医疗费次限额',
      value: 2000,
      unit: '元/次',
      basis: '中医及其他特殊疗法门急诊医疗费',
      formulaText: '中医及其他特殊疗法门急诊医疗费次限额2000元',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '精神疾病门急诊医疗费年限额',
      value: 20000,
      unit: '元/年',
      basis: '精神疾病门急诊医疗费',
      formulaText: '精神疾病门急诊医疗费年限额2万元',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '线上药品费年限额',
      value: 2000,
      unit: '元/年',
      basis: '线上药品费',
      formulaText: '线上药品费年限额2000元',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '线上药品费给付比例',
      value: 100,
      unit: '%',
      basis: '线上药品费',
      formulaText: '线上药品费 × 100%',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '预防性检查及疫苗接种费年限额',
      value: 500,
      unit: '元/年',
      basis: '预防性检查及疫苗接种费',
      formulaText: '预防性检查及疫苗接种费年限额500元',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '保险区域外紧急医疗保险金年限额',
      value: 1000000,
      unit: '元/年',
      basis: '保险区域外紧急医疗保险金',
      condition: '30日内',
      formulaText: '保险区域外紧急医疗保险金30日内年限额100万元',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '保险区域外紧急医疗保险金给付比例',
      value: 100,
      unit: '%',
      basis: '保险区域外紧急医疗保险金',
      condition: '30日内',
      formulaText: '保险区域外紧急医疗保险金 × 100%',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '齿科医疗保险金共用年限额',
      value: 10000,
      unit: '元/年',
      basis: '预防齿科医疗费、全科齿科医疗费',
      formulaText: '预防齿科医疗费、全科齿科医疗费共用年限额1万元',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '齿科医疗保险金给付比例',
      value: 100,
      unit: '%',
      basis: '齿科医疗保险金',
      condition: '齿科优选网络',
      formulaText: '齿科优选网络齿科医疗费 × 100%',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '齿科医疗保险金给付比例',
      value: 80,
      unit: '%',
      basis: '齿科医疗保险金',
      condition: '非齿科优选网络',
      formulaText: '非齿科优选网络齿科医疗费 × 80%',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '疫苗保险金可选年限额',
      unit: '选项',
      basis: '疫苗保险金年限额',
      valueText: '3000元/5000元',
      formulaText: '疫苗保险金可选年限额3000元或者5000元',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '疫苗保险金给付比例',
      value: 100,
      unit: '%',
      basis: '疫苗保险金',
      formulaText: '疫苗保险金 × 100%',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '体检保险金可选年限额',
      unit: '选项',
      basis: '体检保险金年限额',
      valueText: '1000元/5000元/10000元',
      formulaText: '体检保险金可选年限额1000元、5000元或者1万元',
      sourceExcerpt: excerpt,
    },
    {
      coverageType: '医疗保障',
      liability: '体检保险金给付比例',
      value: 100,
      unit: '%',
      basis: '体检保险金',
      formulaText: '体检保险金 × 100%',
      sourceExcerpt: excerpt,
    },
  ];
}

function taikangCityMedicalDefinitions(text, sourceRecordId) {
  const section = excerptAround(text, '2.4.2 可选责任', 3800);
  const outpatientExcerpt = excerptAround(text, '医保内一般门', 1300);
  const drugExcerpt = excerptAround(text, '特定药品费用保险金', 1300);
  const internetExcerpt = excerptAround(text, '互联网门诊医疗费用保险金', 1400);
  const nursingExcerpt = excerptAround(text, '住院护理津贴保险金', 1200);
  const protonExcerpt = excerptAround(text, '质子重离子医疗保险金', 1300);
  const urgentDrugExcerpt = excerptAround(text, '临床急需进口特定药品费用保险金', 1300);
  const cancerAllowanceExcerpt = excerptAround(text, '“恶性肿瘤—重度”津贴保险金', 1100);
  const projectAllowanceExcerpt = excerptAround(text, '特定项目津贴保险金', 1100);
  const totalCapExcerpt = excerptAround(text, '累计给付的各项保险金之和', 900);
  return {
    sourceExcerpt: section,
    sourceRecordId,
    ...TERMS_SOURCE_OVERRIDES_BY_RECORD_ID.get(String(sourceRecordId)),
    definitions: [
      {
        coverageType: '医疗保障',
        liability: '医保内一般门（急）诊医疗保险金计算公式',
        unit: '公式',
        basis: '合理医保内一般门（急）诊医疗费用、其他途径补偿金额、免赔额、给付比例',
        condition: '等待期后在指定医疗机构接受一般门（急）诊治疗',
        formulaText: '医保内一般门（急）诊医疗保险金 = (合理医保内一般门（急）诊医疗费用 - 其他途径已获补偿金额 - 约定免赔额) × 约定给付比例',
        sourceExcerpt: outpatientExcerpt,
      },
      {
        coverageType: '医疗保障',
        liability: '医保内一般门（急）诊医疗保险金累计给付限额',
        unit: '公式',
        basis: '医保内一般门（急）诊医疗保险金基本保险金额',
        formulaText: '累计给付的医保内一般门（急）诊医疗保险金以该项基本保险金额为限',
        sourceExcerpt: outpatientExcerpt,
      },
      {
        coverageType: '医疗保障',
        liability: '特定药品费用保险金计算公式',
        unit: '公式',
        basis: '合理特定药品费用、其他途径补偿金额、免赔额、给付比例',
        condition: '经指定医疗机构诊断必须使用合同约定特定药品名单内药品',
        formulaText: '特定药品费用保险金 = (合理特定药品费用 - 其他途径已获补偿金额 - 约定免赔额) × 约定给付比例',
        sourceExcerpt: drugExcerpt,
      },
      {
        coverageType: '医疗保障',
        liability: '特定药品费用保险金累计给付限额',
        unit: '公式',
        basis: '特定药品费用保险金基本保险金额',
        formulaText: '累计给付的特定药品费用保险金以该项基本保险金额为限',
        sourceExcerpt: drugExcerpt,
      },
      {
        coverageType: '医疗保障',
        liability: '互联网门诊医疗费用保险金计算公式',
        unit: '公式',
        basis: '合理互联网门诊医疗费用、其他途径补偿金额、免赔额、给付比例、单次限额、赔付次数',
        condition: '等待期后罹患合同约定疾病，并在合同约定互联网医院购买合同约定药品',
        formulaText: '互联网门诊医疗费用保险金 = (合理互联网门诊医疗费用 - 其他途径已获补偿金额 - 约定免赔额) × 约定给付比例，并受约定单次限额及赔付次数限制',
        sourceExcerpt: internetExcerpt,
      },
      {
        coverageType: '医疗保障',
        liability: '互联网门诊医疗费用保险金累计给付限额',
        unit: '公式',
        basis: '互联网门诊医疗费用保险金基本保险金额',
        formulaText: '累计给付的互联网门诊医疗费用保险金以该项基本保险金额为限',
        sourceExcerpt: internetExcerpt,
      },
      {
        coverageType: '医疗保障',
        liability: '住院护理津贴保险金计算公式',
        unit: '公式',
        basis: '免赔天数、住院日额、每次实际住院天数、赔付次数',
        condition: '等待期后在指定医疗机构住院接受合同约定治疗，并向约定护理机构申请术后护理服务',
        formulaText: '住院护理津贴保险金按约定免赔天数、住院日额、每次实际住院天数及赔付次数给付',
        sourceExcerpt: nursingExcerpt,
      },
      {
        coverageType: '医疗保障',
        liability: '住院护理津贴保险金累计给付限额',
        unit: '公式',
        basis: '住院护理津贴保险金基本保险金额',
        formulaText: '累计给付的住院护理津贴保险金以该项基本保险金额为限',
        sourceExcerpt: nursingExcerpt,
      },
      {
        coverageType: '医疗保障',
        liability: '质子重离子医疗保险金计算公式',
        unit: '公式',
        basis: '合理质子重离子医疗费用、其他途径补偿金额、免赔额、给付比例',
        condition: '等待期后初次确诊恶性肿瘤，并在约定质子重离子医院接受质子重离子放射治疗',
        formulaText: '质子重离子医疗保险金 = (合理质子重离子医疗费用 - 其他途径已获补偿金额 - 约定免赔额) × 约定给付比例',
        sourceExcerpt: protonExcerpt,
      },
      {
        coverageType: '医疗保障',
        liability: '质子重离子医疗保险金累计给付限额',
        unit: '公式',
        basis: '质子重离子医疗保险金基本保险金额',
        formulaText: '累计给付的质子重离子医疗保险金以该项基本保险金额为限',
        sourceExcerpt: protonExcerpt,
      },
      {
        coverageType: '医疗保障',
        liability: '临床急需进口特定药品费用保险金计算公式',
        unit: '公式',
        basis: '合理临床急需进口特定药品费用、其他途径补偿金额、免赔额、给付比例',
        condition: '等待期后初次确诊疾病，并在约定医院按特定药品使用申请购买约定临床急需进口特定药品',
        formulaText: '临床急需进口特定药品费用保险金 = (合理临床急需进口特定药品费用 - 其他途径已获补偿金额 - 约定免赔额) × 约定给付比例',
        sourceExcerpt: urgentDrugExcerpt,
      },
      {
        coverageType: '医疗保障',
        liability: '临床急需进口特定药品费用保险金累计给付限额',
        unit: '公式',
        basis: '临床急需进口特定药品费用保险金基本保险金额',
        formulaText: '累计给付的临床急需进口特定药品费用保险金以该项基本保险金额为限',
        sourceExcerpt: urgentDrugExcerpt,
      },
      {
        coverageType: '疾病津贴',
        liability: '“恶性肿瘤—重度”津贴保险金给付比例',
        value: 100,
        unit: '%',
        basis: '“恶性肿瘤—重度”津贴保险金基本保险金额',
        condition: '等待期后初次确诊恶性肿瘤——重度',
        formulaText: '“恶性肿瘤—重度”津贴保险金 = 该项基本保险金额 × 100%',
        sourceExcerpt: cancerAllowanceExcerpt,
      },
      {
        coverageType: '疾病津贴',
        liability: '“恶性肿瘤—重度”津贴保险金给付次数上限',
        value: 1,
        unit: '次',
        basis: '“恶性肿瘤—重度”津贴保险金',
        condition: '给付后该项保险责任终止',
        formulaText: '“恶性肿瘤—重度”津贴保险金给付后该项保险责任终止',
        sourceExcerpt: cancerAllowanceExcerpt,
      },
      {
        coverageType: '疾病津贴',
        liability: '特定项目津贴保险金给付比例',
        value: 100,
        unit: '%',
        basis: '特定项目津贴保险金基本保险金额',
        condition: '等待期后确诊必须接受合同约定特定项目范围内治疗',
        formulaText: '特定项目津贴保险金 = 该项基本保险金额 × 100%',
        sourceExcerpt: projectAllowanceExcerpt,
      },
      {
        coverageType: '疾病津贴',
        liability: '特定项目津贴保险金给付次数上限',
        value: 1,
        unit: '次',
        basis: '特定项目津贴保险金',
        condition: '给付后该项保险责任终止',
        formulaText: '特定项目津贴保险金给付后该项保险责任终止',
        sourceExcerpt: projectAllowanceExcerpt,
      },
      {
        coverageType: '医疗保障',
        liability: '各项保险金累计给付总限额',
        unit: '公式',
        basis: '被保险人名下基本保险金额',
        formulaText: '同一被保险人在保险期间内累计给付的各项保险金之和以该被保险人名下的基本保险金额为限',
        sourceExcerpt: totalCapExcerpt,
      },
    ],
  };
}

function zhonghuaTravelAccidentDefinitions(text) {
  const section = excerptAround(text, '2.4.5 特殊旅游项目', 2100);
  const disabilityExcerpt = excerptAround(text, '2.4.1 意外伤残保险金', 1800);
  const deathExcerpt = excerptAround(text, '2.4.2 意外身故保险金', 1200);
  const trafficExcerpt = excerptAround(text, '交通工具给付系数表', 1500);
  const optionalExcerpt = excerptAround(text, '特殊旅游项目意外伤害保险金', 1300);
  return {
    sourceExcerpt: section,
    definitions: [
      {
        coverageType: '意外保障',
        liability: '特殊旅游项目意外伤害保险金适用规则',
        unit: '公式',
        basis: '本合同约定各项保险金',
        condition: '境内旅行期间在国家旅游管理部门许可的旅游景点从事高风险运动遭受意外伤害',
        formulaText: '特殊旅游项目意外伤害保险金按本合同约定给付各项保险金',
        sourceExcerpt: optionalExcerpt,
      },
      {
        coverageType: '意外保障',
        liability: '特殊旅游项目意外伤残保险金计算公式',
        unit: '公式',
        basis: '意外伤害基本保险金额、伤残等级给付比例',
        condition: '特殊旅游项目责任范围内，意外伤害发生之日起180日内造成伤残',
        valueText: '伤残程度第1级100%，第2级90%，每级递减10%，第10级10%',
        formulaText: '意外伤残保险金 = 意外伤害基本保险金额 × 伤残等级给付比例',
        sourceExcerpt: disabilityExcerpt,
      },
      {
        coverageType: '意外保障',
        liability: '特殊旅游项目意外伤残保险金累计给付限额',
        unit: '公式',
        basis: '意外伤害基本保险金额',
        formulaText: '累计给付的意外伤残保险金以意外伤害基本保险金额为限，达到限额时本项保险责任终止',
        sourceExcerpt: disabilityExcerpt,
      },
      {
        coverageType: '身故保障',
        liability: '特殊旅游项目意外身故保险金给付比例',
        value: 100,
        unit: '%',
        basis: '意外伤害基本保险金额',
        condition: '特殊旅游项目责任范围内，意外伤害发生之日起180日内身故',
        formulaText: '意外身故保险金 = 意外伤害基本保险金额 × 100%，给付时扣除已给付的意外伤残保险金',
        sourceExcerpt: deathExcerpt,
      },
      {
        coverageType: '意外保障',
        liability: '交通工具意外伤害给付系数',
        unit: '选项',
        basis: '交通工具给付系数表',
        valueText: '民航班机10倍；轨道交通工具5倍；客运轮船3倍；营运汽车、私家车2倍',
        condition: '同时符合交通工具意外伤害责任',
        formulaText: '交通工具意外伤残/身故保险金按对应交通工具给付系数 × 意外伤害基本保险金额（伤残另乘伤残等级给付比例）给付',
        sourceExcerpt: trafficExcerpt,
      },
    ],
  };
}

function zhonghuaTravelMedicalDefinitions(text) {
  const section = excerptAround(text, '2.3.4 特殊旅游项目', 2300);
  const emergencyExcerpt = excerptAround(text, '2.3.1 紧急医疗保险金', 1900);
  const inpatientExcerpt = excerptAround(text, '2.3.2 紧急住院津贴保险金', 1200);
  const fractureExcerpt = excerptAround(text, '2.3.3 意外伤害骨折', 1600);
  const optionalExcerpt = excerptAround(text, '特殊旅游项目紧急医疗保险金', 1300);
  return {
    sourceExcerpt: section,
    definitions: [
      {
        coverageType: '医疗保障',
        liability: '特殊旅游项目紧急医疗保险金适用规则',
        unit: '公式',
        basis: '本附加合同约定各项保险金',
        condition: '境内旅行期间在国家旅游管理部门许可的旅游景点从事高风险运动遭受意外伤害或患突发性疾病',
        formulaText: '特殊旅游项目紧急医疗保险金按本附加合同约定给付各项保险金',
        sourceExcerpt: optionalExcerpt,
      },
      {
        coverageType: '医疗保障',
        liability: '紧急医疗保险金给付比例',
        value: 100,
        unit: '%',
        basis: '该次治疗的医疗费用、公费医疗或基本医疗保险已报销费用、其他途径补偿',
        condition: '已获得公费医疗或基本医疗保险报销医疗费用',
        formulaText: '紧急医疗保险金 = (该次治疗的医疗费用 - 公费医疗或基本医疗保险已报销费用 - 其他途径获得的补偿、赔偿或者给付的费用) × 100%',
        sourceExcerpt: emergencyExcerpt,
      },
      {
        coverageType: '医疗保障',
        liability: '紧急医疗保险金给付比例',
        value: 95,
        unit: '%',
        basis: '该次治疗的医疗费用、其他途径补偿',
        condition: '未获得公费医疗或基本医疗保险报销医疗费用',
        formulaText: '紧急医疗保险金 = (该次治疗的医疗费用 - 其他途径获得的补偿、赔偿或者给付的费用) × 95%',
        sourceExcerpt: emergencyExcerpt,
      },
      {
        coverageType: '医疗保障',
        liability: '紧急医疗保险金累计给付限额',
        unit: '公式',
        basis: '紧急医疗基本保险金额',
        formulaText: '单次或累计给付的紧急医疗保险金总额以紧急医疗基本保险金额为限',
        sourceExcerpt: emergencyExcerpt,
      },
      {
        coverageType: '津贴保障',
        liability: '紧急住院津贴保险金计算公式',
        unit: '公式',
        basis: '住院日额、实际住院天数',
        condition: '因意外伤害或突发性疾病经医院诊断必须住院治疗',
        formulaText: '每次紧急住院日额保险金给付天数 = 实际住院天数 - 2日，自每次住院第3日起每日按住院日额给付',
        sourceExcerpt: inpatientExcerpt,
      },
      {
        coverageType: '津贴保障',
        liability: '紧急住院津贴保险金给付天数上限',
        value: 30,
        unit: '天/次',
        basis: '同一次住院',
        condition: '同一次住院',
        formulaText: '同一次住院的紧急住院津贴保险金累计给付天数以30日为限',
        sourceExcerpt: inpatientExcerpt,
      },
      {
        coverageType: '津贴保障',
        liability: '紧急住院津贴保险金年度给付天数上限',
        value: 180,
        unit: '天/保险期间',
        basis: '每一保险期间',
        formulaText: '每一保险期间内紧急住院津贴保险金累计给付天数以180日为限',
        sourceExcerpt: inpatientExcerpt,
      },
      {
        coverageType: '津贴保障',
        liability: '意外伤害骨折及关节替换津贴保险金计算公式',
        unit: '公式',
        basis: '骨折及关节替换津贴、骨折部位给付比例、系数',
        condition: '因意外伤害导致骨折或在医院进行关节替换',
        formulaText: '意外伤害骨折及关节替换津贴保险金 = 骨折及关节替换津贴 × 骨折部位给付比例 × 系数；关节替换按关节替换项目表给付',
        sourceExcerpt: fractureExcerpt,
      },
      {
        coverageType: '津贴保障',
        liability: '意外伤害骨折及关节替换津贴保险金累计给付限额',
        unit: '公式',
        basis: '骨折及关节替换津贴',
        formulaText: '单次或累计给付的意外伤害骨折及关节替换津贴保险金总额以骨折及关节替换津贴为限',
        sourceExcerpt: fractureExcerpt,
      },
    ],
  };
}

function nongyinOverseasRescueDefinitions(text) {
  const section = excerptAround(text, /可选保险责任/u, 2600);
  return {
    sourceExcerpt: section,
    definitions: [
      {
        coverageType: '医疗保障',
        liability: '紧急门诊费用每次事故累计限额',
        value: 8000,
        unit: '元/次事故',
        basis: '紧急门诊费用',
        condition: '紧急门诊责任',
        formulaText: '紧急门诊费用每一保险事故不超过8000元',
        sourceExcerpt: excerptAround(text, /紧\s*急\s*门\s*诊/u, 1400),
      },
      {
        coverageType: '医疗保障',
        liability: '紧急门诊首次费用自付额',
        value: 800,
        unit: '元',
        basis: '每一保险事故之紧急门诊费用',
        condition: '每一保险事故紧急门诊费用低于或等于800元部分',
        formulaText: '每一保险事故之紧急门诊费用低于800元（含800元）的部分由被保险人自行承担',
        sourceExcerpt: excerptAround(text, /紧\s*急\s*门\s*诊/u, 1400),
      },
      {
        coverageType: '医疗保障',
        liability: '紧急牙科门诊费用每次事故累计限额',
        value: 4000,
        unit: '元/次事故',
        basis: '牙科急诊费用',
        condition: '紧急牙科门诊责任',
        formulaText: '牙科急诊费用每一保险事故不超过4000元',
        sourceExcerpt: excerptAround(text, /紧\s*急\s*牙\s*科/u, 1200),
      },
      {
        coverageType: '医疗保障',
        liability: '紧急牙科门诊首次费用自付额',
        value: 800,
        unit: '元',
        basis: '每一保险事故之牙科急诊费用',
        condition: '每一保险事故牙科急诊费用低于或等于800元部分',
        formulaText: '每一保险事故之牙科急诊费用低于800元（含800元）的部分由被保险人自行承担',
        sourceExcerpt: excerptAround(text, /紧\s*急\s*牙\s*科/u, 1200),
      },
    ],
  };
}

function definitionsFor(row, officialText = '') {
  const text = normalizeOneLine(officialText || row.fullText || row.payload?.sourceExcerpt || '');
  switch (row.id) {
    case 'opt_a6d1b0358d3539e2': {
      const sourceExcerpt = excerptAround(text, '意外伤害身故保险金');
      return {
        sourceExcerpt,
        definitions: [
          {
            coverageType: '身故保障',
            liability: '意外伤害身故保险金',
            value: 100,
            unit: '%',
            basis: '基本保险金额',
            condition: '18周岁保单周年日（含）之后、80周岁保单周年日（不含）之前，意外伤害发生之日起180日内身故',
            formulaText: '意外伤害身故保险金 = 基本保险金额 × 100%',
            sourceExcerpt,
          },
        ],
      };
    }
    case 'opt_5e5bfd2703a3b333': {
      const sourceExcerpt = excerptAround(text, '祝寿');
      return {
        sourceExcerpt,
        definitions: [
          {
            coverageType: '现金流',
            liability: '祝寿金',
            value: 100,
            unit: '%',
            basis: '可选责任保险金额',
            condition: '第一被保险人年满60周岁保单生效对应日生存',
            formulaText: '祝寿金 = 可选责任保险金额 × 100%',
            sourceExcerpt,
          },
          {
            coverageType: '身故保障',
            liability: '身故或身体全残保险金',
            unit: '公式',
            basis: '可选责任保险费、可选责任基本保险金额现金价值、可选责任累积红利现金价值',
            condition: '第一被保险人在祝寿金约定领取日之前身故或身体全残',
            formulaText: '身故或身体全残保险金 = max(实际交纳的可选责任保险费, 可选责任基本保险金额对应现金价值) × 1.05 + 可选责任累积红利保险金额对应现金价值',
            sourceExcerpt,
          },
        ],
      };
    }
    case 'opt_04556ece65e73c43': {
      const sourceExcerpt = excerptAround(text, '猝死保险责任');
      return {
        sourceExcerpt,
        definitions: [
          {
            coverageType: '身故保障',
            liability: '猝死保险金',
            value: 100,
            unit: '%',
            basis: '猝死保险金额',
            condition: '被保险人猝死',
            formulaText: '猝死保险金 = 猝死保险金额 × 100%',
            sourceExcerpt,
          },
        ],
      };
    }
    case 'opt_9d9225ae24ebeb7c': {
      const sourceExcerpt = excerptAround(text, '二、可选保险责任');
      return {
        sourceExcerpt,
        definitions: [
          {
            coverageType: '身故保障',
            liability: '意外身故保险金',
            value: 100,
            unit: '%',
            basis: '意外身故保险金额',
            condition: '意外伤害发生之日起180日内导致身故',
            formulaText: '意外身故保险金 = 意外身故保险金额 × 100%',
            sourceExcerpt,
          },
          {
            coverageType: '身故保障',
            liability: '猝死保险金',
            value: 100,
            unit: '%',
            basis: '猝死保险金额',
            condition: '被保险人猝死',
            formulaText: '猝死保险金 = 猝死保险金额 × 100%',
            sourceExcerpt,
          },
        ],
      };
    }
    case 'opt_48b64fea778e6631': {
      const sourceExcerpt = excerptAround(text, '可选保险责任一');
      return {
        sourceExcerpt,
        definitions: [
          {
            coverageType: '疾病保障',
            liability: '恶性肿瘤-重度关爱保险金',
            value: 25,
            unit: '%',
            basis: '基本保险金额',
            condition: '年满80周岁的首个保单周年日之前，初次患恶性肿瘤-重度',
            formulaText: '恶性肿瘤-重度关爱保险金 = 基本保险金额 × 25%',
            sourceExcerpt,
          },
          {
            coverageType: '疾病保障',
            liability: '恶性肿瘤-重度关爱保险金给付次数上限',
            value: 1,
            unit: '次',
            basis: '恶性肿瘤-重度关爱保险金',
            condition: '可选保险责任一',
            formulaText: '恶性肿瘤-重度关爱保险金的给付次数以一次为限',
            sourceExcerpt,
          },
        ],
      };
    }
    case 'opt_f6e859d447abb6f5': {
      const sourceExcerpt = excerptAround(text, '2.1 保险金额');
      return {
        sourceExcerpt,
        definitions: [
          {
            coverageType: '医疗保障',
            liability: '紧急门诊责任累计给付限额',
            unit: '公式',
            basis: '保险单载明的该项责任保险金额',
            condition: '境外旅行遭受意外伤害或突发急性病需紧急门诊救助',
            formulaText: '紧急救援及相关医疗服务的各项累计费用以保险单载明的该项责任保险金额为限',
            sourceExcerpt,
          },
        ],
      };
    }
    case 'opt_aa821d1ae5d9dd9d': {
      const sourceExcerpt = excerptAround(text, '一次就诊医疗保险金');
      return {
        sourceExcerpt,
        definitions: [
          {
            coverageType: '医疗保障',
            liability: '普通门急诊医疗保险金计算公式',
            unit: '公式',
            basis: '医疗费用有效金额、免赔额、保障计划给付比例、社保报销状态调节因子',
            condition: '可选责任普通门急诊医疗保险金',
            formulaText: '一次就诊医疗保险金 = (医疗费用有效金额 - 免赔额) × 保障计划给付比例 × 社保报销状态调节因子',
            sourceExcerpt,
          },
          {
            coverageType: '医疗保障',
            liability: '社保未使用调节因子',
            value: 60,
            unit: '%',
            basis: '社保报销状态调节因子',
            condition: '投保时有社保或公费医疗，但本次就诊未使用',
            formulaText: '社保报销状态调节因子 = 60%',
            sourceExcerpt,
          },
        ],
      };
    }
    case 'opt_82eb7bdbdd1aa10b': {
      const sourceExcerpt = excerptAround(text, '2.3.2 可选责任');
      return {
        sourceExcerpt,
        definitions: [
          {
            coverageType: '医疗保障',
            liability: '恶性肿瘤医疗保险金计算公式',
            unit: '公式',
            basis: '恶性肿瘤医疗费用有效金额、保障计划给付比例、社保报销状态调节因子',
            condition: '可选责任恶性肿瘤医疗保险金',
            formulaText: '保险金 = 恶性肿瘤医疗费用有效金额 × 保障计划给付比例 × 社保报销状态调节因子',
            sourceExcerpt,
          },
          {
            coverageType: '医疗保障',
            liability: '保障计划给付比例可选档位',
            unit: '选项',
            basis: '保障计划给付比例',
            valueText: '85%/100%',
            condition: '可选责任给付比例同基本责任保持一致',
            formulaText: '保障计划给付比例提供85%、100%两档',
            sourceExcerpt,
          },
          {
            coverageType: '医疗保障',
            liability: '社保未使用调节因子',
            value: 60,
            unit: '%',
            basis: '社保报销状态调节因子',
            condition: '投保时有社保或公费医疗，但本次就诊未使用',
            formulaText: '社保报销状态调节因子 = 60%',
            sourceExcerpt,
          },
          {
            coverageType: '医疗保障',
            liability: '恶性肿瘤住院最高给付天数',
            value: 180,
            unit: '天/年',
            basis: '恶性肿瘤住院医疗费用',
            condition: '每一个保单年度内',
            formulaText: '因恶性肿瘤住院的最高给付天数为180天',
            sourceExcerpt,
          },
        ],
      };
    }
    case 'opt_b3ff4babd88c9dd9':
    case 'opt_e34e47e3d62b4ce7': {
      const sourceExcerpt = excerptAround(text || row.payload?.sourceExcerpt, '保险金年累计给付次数限制', 1400);
      return {
        sourceExcerpt,
        definitions: plusDefinitions(sourceExcerpt),
      };
    }
    case 'opt_cb0400a7b6297620': {
      const sourceExcerpt = excerptAround(text, '紧急门诊和牙');
      return {
        sourceExcerpt,
        definitions: [
          {
            coverageType: '医疗保障',
            liability: '紧急门诊费用每次事故累计限额',
            value: 8000,
            unit: '元/次事故',
            basis: '紧急门诊费用',
            condition: '紧急门诊责任',
            formulaText: '紧急门诊费用每一次保险事故累计不超过8000元',
            sourceExcerpt,
          },
          {
            coverageType: '医疗保障',
            liability: '紧急门诊首次费用自付额',
            value: 800,
            unit: '元',
            basis: '每一事件之首次紧急门诊费用',
            condition: '首次紧急门诊费用低于或等于800元部分',
            formulaText: '每一事件之首次紧急门诊费用低于800元（含800元）的部分由被保险人自行承担',
            sourceExcerpt,
          },
          {
            coverageType: '医疗保障',
            liability: '紧急牙科门诊费用每次事故累计限额',
            value: 4000,
            unit: '元/次事故',
            basis: '牙科门诊费用',
            condition: '紧急牙科门诊责任',
            formulaText: '牙科门诊费用每一次保险事故累计不超过4000元',
            sourceExcerpt,
          },
          {
            coverageType: '医疗保障',
            liability: '紧急牙科门诊首次费用自付额',
            value: 800,
            unit: '元',
            basis: '每一事件之首次牙科门诊费用',
            condition: '首次牙科门诊费用低于或等于800元部分',
            formulaText: '每一事件之首次牙科门诊费用低于800元（含800元）的部分由被保险人自行承担',
            sourceExcerpt,
          },
        ],
      };
    }
    case 'opt_acecfad51e6616ef':
    case 'opt_a785bd265819dd1f': {
      const sourceExcerpt = excerptAround(text, '可选责任 身故或全残保险金');
      return {
        sourceExcerpt,
        sourceUrl: GREATLIFE_TERMS_URLS[row.id],
        sourceTitle: `${row.productName}条款`,
        definitions: [
          {
            coverageType: '身故保障',
            liability: '身故或全残保险金',
            unit: '公式',
            basis: '基本保险金额、现金价值、累计已交纳保险费（无息）',
            condition: '被保险人身故或全残',
            formulaText: '身故或全残保险金 = max(基本保险金额, 现金价值, 累计已交纳保险费（无息）)',
            sourceExcerpt,
          },
        ],
      };
    }
    case 'opt_f0ace8c44690e765':
      return zhonghuaTravelAccidentDefinitions(text);
    case 'opt_7be115a7b0c95636':
      return zhonghuaTravelMedicalDefinitions(text);
    case 'opt_e9c9bae3aaea0bf5':
      return nongyinOverseasRescueDefinitions(text);
    case 'opt_2e3c5a80f226c4d1':
    case 'opt_6ba9ba99c82a98b1':
    case 'opt_55744b450a15ca64':
    case 'opt_ded82eef8c2ad677':
      return taikangCityMedicalDefinitions(
        text,
        SOURCE_RECORD_OVERRIDES_BY_OPTIONAL_ID.get(row.id) || row.payload?.sourceRecordId,
      );
    default:
      return { sourceExcerpt: '', definitions: [] };
  }
}

function loadPendingRows(db) {
  return db.prepare(`
    SELECT id, company, product_name, liability, payload
      FROM optional_responsibility_records
     WHERE json_extract(payload, '$.quantificationStatus') = 'pending_review'
  `).all().map((row) => ({
    id: trim(row.id),
    company: trim(row.company),
    productName: trim(row.product_name),
    liability: trim(row.liability),
    payload: parsePayload(row.payload),
  }));
}

function countPending(db) {
  return db.prepare(`
    SELECT COUNT(*) AS count
      FROM optional_responsibility_records
     WHERE json_extract(payload, '$.quantificationStatus') = 'pending_review'
  `).get().count;
}

function updateKnowledgePayload(db, sourceRecordId, officialText, now) {
  if (!officialText) return false;
  const row = db.prepare('SELECT id, company, product_name, url, payload FROM knowledge_records WHERE id = ?').get(sourceRecordId);
  if (!row) return false;
  const payload = {
    ...parsePayload(row.payload),
    pageText: officialText,
    parser: 'remaining_optional_responsibility_quantification',
    repairedAt: now,
  };
  db.prepare('UPDATE knowledge_records SET payload = ? WHERE id = ?').run(JSON.stringify(payload), sourceRecordId);
  return true;
}

function upsertIndicators(db, indicators) {
  const statement = db.prepare(`
    INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company = excluded.company,
      product_name = excluded.product_name,
      coverage_type = excluded.coverage_type,
      liability = excluded.liability,
      payload = excluded.payload
  `);
  for (const indicator of indicators) {
    statement.run(
      indicator.id,
      indicator.company,
      indicator.productName,
      indicator.coverageType,
      indicator.liability,
      JSON.stringify(indicator.payload),
    );
  }
}

function updateOptionalRecord(db, row, indicators, section, sourceOverrides, now) {
  const source = sourceInfo(row, sourceOverrides);
  const indicatorIds = [
    ...new Set([
      ...(Array.isArray(row.payload?.indicatorIds) ? row.payload.indicatorIds.map(trim).filter(Boolean) : []),
      ...indicators.map((indicator) => indicator.id),
    ]),
  ];
  const payload = {
    ...row.payload,
    indicatorIds,
    quantificationStatus: 'quantified',
    quantificationReason: '',
    sourceExcerpt: trim(section || row.payload?.sourceExcerpt).slice(0, 4000),
    sourceRecordId: source.sourceRecordId,
    sourceUrl: source.sourceUrl,
    sourceTitle: source.sourceTitle,
    sourceEvidenceLevel: 'official_terms',
    governanceReasons: [
      ...new Set([
        ...(Array.isArray(row.payload?.governanceReasons) ? row.payload.governanceReasons : []),
        'quantify_remaining_optional_responsibility',
      ]),
    ],
    updatedAt: now,
  };
  db.prepare(`
    UPDATE optional_responsibility_records
       SET company = ?, product_name = ?, liability = ?, payload = ?
     WHERE id = ?
  `).run(row.company, row.productName, row.liability, JSON.stringify(payload), row.id);
}

async function buildPlan(db) {
  const rows = loadPendingRows(db);
  const plans = [];
  for (const row of rows) {
    const sourceRecordId = SOURCE_RECORD_OVERRIDES_BY_OPTIONAL_ID.get(row.id) || row.payload?.sourceRecordId;
    const officialText = await loadOfficialText(sourceRecordId);
    const definitions = definitionsFor(row, officialText);
    if (!definitions.definitions.length) continue;
    const resolvedSourceRecordId = definitions.sourceRecordId || sourceRecordId;
    const sourceOverrides = {
      sourceRecordId: resolvedSourceRecordId,
      sourceUrl: definitions.sourceUrl || row.payload?.sourceUrl,
      sourceTitle: definitions.sourceTitle || row.payload?.sourceTitle || row.productName,
    };
    const indicators = definitions.definitions.map((definition) =>
      buildIndicator(row, definition, new Date().toISOString(), sourceOverrides),
    );
    plans.push({
      row,
      officialText,
      sourceRecordId: resolvedSourceRecordId,
      sourceOverrides,
      section: definitions.sourceExcerpt,
      indicators,
    });
  }
  return plans;
}

async function runForDb(dbPath, dryRun, now) {
  const db = new DatabaseSync(dbPath);
  try {
    const beforePending = countPending(db);
    const plan = await buildPlan(db);
    const result = {
      dbPath,
      beforePending,
      optionalRecordUpdates: plan.length,
      indicatorUpserts: plan.reduce((sum, item) => sum + item.indicators.length, 0),
      products: plan.map((item) => ({
        id: item.row.id,
        company: item.row.company,
        productName: item.row.productName,
        indicatorCount: item.indicators.length,
      })),
      dryRun,
      afterPending: dryRun ? beforePending - plan.length : null,
    };
    if (dryRun) return result;

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of plan) {
        updateKnowledgePayload(db, item.sourceRecordId, item.officialText, now);
        upsertIndicators(db, item.indicators.map((indicator) => ({
          ...indicator,
          payload: { ...indicator.payload, updatedAt: now },
        })));
        updateOptionalRecord(db, item.row, item.indicators, item.section, item.sourceOverrides, now);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    result.afterPending = countPending(db);
    return result;
  } finally {
    db.close();
  }
}

async function main() {
  const dryRun = hasFlag('dry-run');
  const requestedDbPath = readArg('db-path');
  const dbPaths = requestedDbPath ? [path.resolve(requestedDbPath)] : DB_PATHS;
  const now = new Date().toISOString();
  const backups = {};
  if (!dryRun) {
    for (const dbPath of dbPaths) backups[dbPath] = await backupSqlite(dbPath);
  }
  const results = [];
  for (const dbPath of dbPaths) {
    results.push(await runForDb(dbPath, dryRun, now));
  }
  console.log(JSON.stringify({
    ok: true,
    dryRun,
    generatedAt: now,
    backups,
    results,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
