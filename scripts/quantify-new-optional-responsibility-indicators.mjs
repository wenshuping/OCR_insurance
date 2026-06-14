import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(projectRoot, '.runtime', 'local', 'policy-ocr.sqlite');
const VERSION = '2026-06-14-new-optional-responsibility-quantification';

function trim(value) {
  return String(value ?? '').trim();
}

function normalizeSpaces(value) {
  return trim(value)
    .normalize('NFKC')
    .replace(/\r/gu, '\n')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s+/gu, ' ');
}

function parsePayload(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sha1(value, length = 18) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, length);
}

function normalizeLookupText(value) {
  return normalizeSpaces(value).replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
}

function limitText(value, max = 1200) {
  const text = normalizeSpaces(value);
  return text.length > max ? `${text.slice(0, max - 12)}...已截断` : text;
}

function extractFirst(text, patterns = []) {
  for (const pattern of patterns) {
    const match = normalizeSpaces(text).match(pattern);
    if (match?.[1]) return trim(match[1]);
  }
  return '';
}

function stripBadLiabilityPrefix(value) {
  return trim(value)
    .replace(/^可选(?:保险)?责任[：:\s]*/u, '')
    .replace(/^[（(]?[一二三四五六七八九十\d]+[）)、.．\s]*/u, '')
    .replace(/^(本合同的可选(?:保险)?责任为|本合同可选(?:保险)?责任为|可选(?:保险)?责任为)/u, '')
    .replace(/^(部分包括|包括|为|中的|的)+/u, '')
    .replace(/[，。；：:].*$/u, '')
    .replace(/^["“”']+|["“”']+$/gu, '')
    .trim();
}

function liabilityLooksClean(value) {
  const text = trim(value);
  if (text.length < 4 || text.length > 40) return false;
  if (!/保险金|津贴|补贴/u.test(text)) return false;
  if (/^(保险金|基本保险金|责任的基本保险金|该项责任的基本保险金|津贴保险金|补贴保险金|医疗保险金)$/u.test(text)) return false;
  if (/^(付|病身故)/u.test(text)) return false;
  if (/本合同|可选责任|保险责任|给付保险金|申请保险金|收到保险金|被保险人|投保人|我们|本公司|您选择|若您|如果您|该项责任|累积红利|累计红利/u.test(text)) return false;
  return true;
}

function deriveLiability(row, text) {
  const normalized = normalizeSpaces(text);
  const fromText = extractFirst(normalized, [
    /[“"]([^”"]{2,32}?保险金)[”"]/u,
    /[“"]([^”"]{2,32}?津贴)[”"]/u,
    /(急性病身故保险金)/u,
    /可选(?:保险)?责任[：:\s]*[（(]?[一二三四五六七八九十\d]*[）)、.．\s]*([\u4e00-\u9fa5A-Za-z0-9“”\-—（）()]+?保险金)/u,
    /可选(?:保险)?责任[：:\s]*([\u4e00-\u9fa5A-Za-z0-9“”\-—（）()]+?津贴)/u,
    /可选(?:保险)?责任[：:\s]*([\u4e00-\u9fa5A-Za-z0-9“”\-—（）()]+?补贴)/u,
    /([\u4e00-\u9fa5A-Za-z0-9“”\-—（）()]{2,32}?保险金)\s*(?:若|被保险人|=|＝)/u,
    /([\u4e00-\u9fa5A-Za-z0-9“”\-—（）()]{2,32}?津贴保险金)\s*(?:若|被保险人|=|＝)/u,
  ]);
  const cleaned = stripBadLiabilityPrefix(fromText);
  if (liabilityLooksClean(cleaned)) return cleaned.replace(/\s+/gu, '');

  const existing = stripBadLiabilityPrefix(row.liability || row.payload?.liability || row.payload?.title);
  if (liabilityLooksClean(existing)) return existing.replace(/\s+/gu, '');
  return '';
}

function deriveCoverageType(liability, text) {
  const direct = normalizeSpaces(liability);
  const haystack = normalizeSpaces(`${liability} ${text}`);
  if (/豁免/u.test(direct)) return '保费豁免';
  if (/门诊|住院|医疗|药品|药械|费用|报销|补偿|质子重离子/u.test(direct)) return '医疗保障';
  if (/津贴|日额|每日|住院天数|护理天数|补贴/u.test(direct)) return '津贴保障';
  if (/伤残|残疾|骨折|烧伤/u.test(direct)) return '意外伤残保障';
  if (/猝死/u.test(direct)) return '意外身故保障';
  if (/意外/u.test(direct) && /身故|全残/u.test(direct)) return '意外身故保障';
  if (/身故|全残/u.test(direct)) return '身故保障';
  if (/恶性肿瘤|癌|重大疾病|重疾|中症|轻症|中度疾病|轻度疾病|特定疾病|疾病/u.test(direct)) return '重大疾病保障';
  if (/年金|养老金|祝寿|生存金|养老保险金|教育金/u.test(direct)) return '现金流';
  if (/豁免/u.test(haystack)) return '保费豁免';
  if (/恶性肿瘤|癌|重大疾病|重疾|中症|轻症|中度疾病|轻度疾病|特定疾病|疾病/u.test(haystack)) return '重大疾病保障';
  if (/门诊|住院|医疗|药品|药械|费用|报销|补偿|质子重离子/u.test(haystack)) return '医疗保障';
  if (/津贴|日额|每日|住院天数|护理天数|补贴/u.test(haystack)) return '津贴保障';
  if (/伤残|残疾/u.test(haystack)) return '意外伤残保障';
  if (/意外/u.test(haystack) && /身故|全残/u.test(haystack)) return '意外身故保障';
  if (/身故|全残/u.test(haystack)) return '身故保障';
  if (/年金|养老金|祝寿|生存金|养老保险金|教育金/u.test(haystack)) return '现金流';
  return '可选责任';
}

function maxFormulaDefinition(liability, text) {
  if (!/最大者|较大者|三者中/u.test(text)) return null;
  const hasAmount = /基本保险金额|基本保额/u.test(text);
  const hasCashValue = /现金价值/u.test(text);
  const hasPremium = /已交|已交纳|累计已交|实际交纳|保险费/u.test(text);
  if (!hasAmount || !hasCashValue || !hasPremium) return null;
  return {
    value: null,
    valueText: '',
    unit: '公式',
    basis: '基本保险金额、现金价值、已交保险费',
    formulaText: `${liability} = max(基本保险金额, 现金价值, 已交保险费)`,
  };
}

function percentDefinition(liability, text) {
  const normalized = normalizeSpaces(text);
  if (/最大者|较大者|三者中/u.test(normalized)) return null;
  if (/医疗|门诊|住院|药品|药械|费用|报销|补偿|质子重离子|津贴|补贴/u.test(liability)) return null;
  const match = normalized.match(/(?:按|给付|另行给付)?[^。；，,]{0,24}?(?:基本保险金额|基本保额|保险金额)[^。；，,]{0,16}?(\d+(?:\.\d+)?)\s*[％%]/u)
    || normalized.match(/(\d+(?:\.\d+)?)\s*[％%][^。；，,]{0,20}?(?:基本保险金额|基本保额|保险金额)/u);
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) {
      return {
        value,
        valueText: String(value),
        unit: '%',
        basis: '基本保险金额',
        formulaText: `${liability} = 基本保险金额 × ${value}%`,
      };
    }
  }
  if (/按[^。；]{0,20}(?:本(?:主险|附加)?合同的)?基本保险金额给付/u.test(normalized)
    || /(?:本(?:主险|附加)?合同的)?基本保险金额给付/u.test(normalized)) {
    return {
      value: 100,
      valueText: '100',
      unit: '%',
      basis: '基本保险金额',
      formulaText: `${liability} = 基本保险金额 × 100%`,
    };
  }
  return null;
}

function equalExtraDefinition(liability, text) {
  if (!/另行等额给付|额外给付等额|同等金额/u.test(text)) return null;
  return {
    value: 100,
    valueText: '100',
    unit: '%',
    basis: '已确定的保险金',
    formulaText: `${liability} = 已确定的保险金 × 100%`,
  };
}

function medicalFormulaDefinition(liability, text) {
  const normalized = normalizeSpaces(text);
  if (!/医疗|门诊|药品|药械|费用|报销|补偿|质子重离子/u.test(liability)) return null;
  if (!/给付比例|赔付比例|报销比例|补偿原则|免赔额|实际发生|合理且必要|医疗费用/u.test(normalized)) return null;
  const ratio = normalized.match(/(?:给付比例|赔付比例|报销比例)[①②]?(?:为|：|:)?\s*(\d+(?:\.\d+)?)\s*[％%]/u)
    || normalized.match(/×\s*(\d+(?:\.\d+)?)\s*[％%]/u);
  const deductible = normalized.match(/(?:免赔额|免赔额余额|起付金额)[^。；，,]{0,20}?(\d+(?:,\d{3})*(?:\.\d+)?)\s*元/u);
  const conditionParts = [];
  if (deductible?.[1]) conditionParts.push(`免赔额/起付金额 ${deductible[1].replace(/,/gu, '')} 元`);
  if (ratio?.[1]) conditionParts.push(`给付比例 ${ratio[1]}%`);
  return {
    value: ratio?.[1] ? Number(ratio[1]) : null,
    valueText: ratio?.[1] || '',
    unit: ratio?.[1] ? '%' : '公式',
    basis: '实际合理医疗费用',
    formulaText: `${liability} = (实际合理医疗费用 - 已获补偿 - 免赔额/起付金额) × 给付比例`,
    condition: conditionParts.join('；'),
  };
}

function dailyAllowanceDefinition(liability, text) {
  if (!/津贴|补贴|日额/u.test(liability)) return null;
  const normalized = normalizeSpaces(text);
  const match = normalized.match(/(?:每日津贴金额|日津贴额|每日给付金额|住院日额)[^。；，,]{0,12}?(\d+(?:\.\d+)?)\s*元/u)
    || normalized.match(/(\d+(?:\.\d+)?)\s*元\s*\/\s*日/u);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return {
    value,
    valueText: String(value),
    unit: '元/日',
    basis: '实际住院天数',
    formulaText: `${liability} = 实际住院天数 × 每日津贴金额 ${value} 元`,
  };
}

function fixedNamedAmountDefinition(liability, text) {
  const normalized = normalizeSpaces(text);
  if (/最大者|较大者|三者中/u.test(normalized)) return null;
  if (/医疗|门诊|住院|药品|药械|费用|报销|补偿|质子重离子|津贴|补贴/u.test(liability)) return null;
  if (!/基本保险金额/u.test(normalized) || !/给付/u.test(normalized)) return null;
  if (/医疗费用|实际发生|给付比例|赔付比例|免赔额/u.test(normalized)) return null;
  return {
    value: 100,
    valueText: '100',
    unit: '%',
    basis: '基本保险金额',
    formulaText: `${liability} = 基本保险金额 × 100%`,
  };
}

function inferFormula(liability, text) {
  return maxFormulaDefinition(liability, text)
    || percentDefinition(liability, text)
    || equalExtraDefinition(liability, text)
    || medicalFormulaDefinition(liability, text)
    || dailyAllowanceDefinition(liability, text)
    || fixedNamedAmountDefinition(liability, text);
}

function conditionFromText(text, fallback = '') {
  const normalized = normalizeSpaces(text);
  const match = normalized.match(/(?:若|如果)([^。；]{6,120}?)(?:，|,|我们|本公司)/u);
  if (match?.[1]) return trim(match[1]);
  return trim(fallback);
}

function buildIndicator(row, now) {
  const text = normalizeSpaces([
    row.payload?.sourceExcerpt,
    row.payload?.responsibility,
    row.payload?.analysis?.report,
  ].filter(Boolean).join('\n'));
  if (!text || !/(可选|保险责任|保险金|医疗费用|津贴)/u.test(text)) return null;
  const liability = deriveLiability(row, text);
  if (!liability) return null;
  const formula = inferFormula(liability, text);
  if (!formula?.formulaText) return null;
  const company = trim(row.company || row.payload?.company);
  const productName = trim(row.productName || row.payload?.productName);
  if (!company || !productName) return null;
  const coverageType = deriveCoverageType(liability, text);
  const condition = trim(formula.condition || conditionFromText(text, row.payload?.condition));
  const sourceExcerpt = limitText(text, 1200);
  const id = `ind_optional_auto_${sha1([
    company,
    productName,
    row.payload?.canonicalProductId,
    coverageType,
    liability,
    formula.formulaText,
  ].join('\u001f'))}`;
  return {
    id,
    payload: {
      id,
      version: VERSION,
      rowNumber: 0,
      company,
      productName,
      canonicalProductId: trim(row.payload?.canonicalProductId),
      productType: trim(row.payload?.productType),
      salesStatus: trim(row.payload?.salesStatus),
      coverageType,
      liability,
      value: formula.value,
      valueText: formula.valueText,
      unit: formula.unit,
      basis: formula.basis,
      formulaText: formula.formulaText,
      condition,
      responsibilityScope: 'optional',
      quantificationStatus: 'quantified',
      quantificationReason: '',
      extractionMethod: '规则抽取',
      sourceRecordId: trim(row.payload?.sourceRecordId),
      sourceUrl: trim(row.payload?.sourceUrl),
      sourceTitle: trim(row.payload?.sourceTitle),
      sourceExcerpt,
      sourceEvidenceLevel: row.payload?.sourceUrl ? 'official_excerpt' : 'local_excerpt',
      optionalResponsibilityIds: [row.id],
      updatedAt: now,
    },
  };
}

function loadPendingRows(db) {
  return db.prepare(`
    SELECT id, company, product_name, liability, payload
      FROM optional_responsibility_records
     WHERE json_extract(payload, '$.quantificationStatus') = 'pending_review'
     ORDER BY company, product_name, liability, id
  `).all().map((row) => ({
    id: trim(row.id),
    company: trim(row.company),
    productName: trim(row.product_name),
    liability: trim(row.liability),
    payload: parsePayload(row.payload),
  }));
}

function mergeIndicator(existing, next) {
  if (!existing) return next;
  const ids = new Set([
    ...(Array.isArray(existing.payload.optionalResponsibilityIds) ? existing.payload.optionalResponsibilityIds : []),
    ...(Array.isArray(next.payload.optionalResponsibilityIds) ? next.payload.optionalResponsibilityIds : []),
  ].map(trim).filter(Boolean));
  return {
    ...existing,
    payload: {
      ...existing.payload,
      optionalResponsibilityIds: [...ids],
      updatedAt: next.payload.updatedAt,
    },
  };
}

function buildPlan(db) {
  const now = new Date().toISOString();
  const pendingRows = loadPendingRows(db);
  const indicatorsById = new Map();
  const updates = [];
  const skipped = [];
  for (const row of pendingRows) {
    const indicator = buildIndicator(row, now);
    if (!indicator) {
      skipped.push(row);
      continue;
    }
    indicatorsById.set(indicator.id, mergeIndicator(indicatorsById.get(indicator.id), indicator));
    const indicatorIds = [
      ...new Set([
        ...(Array.isArray(row.payload?.indicatorIds) ? row.payload.indicatorIds.map(trim).filter(Boolean) : []),
        indicator.id,
      ]),
    ];
    updates.push({
      row,
      payload: {
        ...row.payload,
        liability: indicator.payload.liability,
        title: indicator.payload.liability,
        coverageType: indicator.payload.coverageType,
        indicatorIds,
        quantificationStatus: 'quantified',
        quantificationReason: '',
        sourceExcerpt: indicator.payload.sourceExcerpt,
        sourceEvidenceLevel: indicator.payload.sourceEvidenceLevel,
        governanceReasons: [
          ...new Set([
            ...(Array.isArray(row.payload?.governanceReasons) ? row.payload.governanceReasons : []),
            'quantify_new_optional_responsibility',
          ]),
        ],
        updatedAt: now,
      },
    });
  }
  return {
    pendingRows,
    indicators: [...indicatorsById.values()],
    updates,
    skipped,
  };
}

function writePlan(db, plan) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS insurance_indicator_records (
      id TEXT PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      coverage_type TEXT,
      liability TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_insurance_indicator_records_company ON insurance_indicator_records(company);
    CREATE INDEX IF NOT EXISTS idx_insurance_indicator_records_product_name ON insurance_indicator_records(product_name);
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const upsertIndicator = db.prepare(`
    INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company = excluded.company,
      product_name = excluded.product_name,
      coverage_type = excluded.coverage_type,
      liability = excluded.liability,
      payload = excluded.payload
  `);
  const updateOptional = db.prepare(`
    UPDATE optional_responsibility_records
       SET company = ?, product_name = ?, liability = ?, payload = ?
     WHERE id = ?
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const indicator of plan.indicators) {
      upsertIndicator.run(
        indicator.payload.id,
        indicator.payload.company,
        indicator.payload.productName,
        indicator.payload.coverageType,
        indicator.payload.liability,
        JSON.stringify(indicator.payload),
      );
    }
    for (const update of plan.updates) {
      updateOptional.run(
        update.row.company,
        update.row.productName,
        update.payload.liability,
        JSON.stringify(update.payload),
        update.row.id,
      );
    }
    consolidateUpdatedOptionalRecords(db);
    db.prepare(`
      INSERT INTO app_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('new_optional_responsibility_indicators_updated_at', new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function payloadHasGovernanceReason(payload, reason) {
  return Array.isArray(payload?.governanceReasons) && payload.governanceReasons.includes(reason);
}

function uniqueStrings(values = []) {
  return [...new Set(values.map(trim).filter(Boolean))];
}

function mergeOptionalPayloads(rows) {
  const [primary, ...duplicates] = rows;
  const primaryPayload = parsePayload(primary.payload);
  const duplicatePayloads = duplicates.map((row) => parsePayload(row.payload));
  return {
    ...primaryPayload,
    indicatorIds: uniqueStrings([
      ...(Array.isArray(primaryPayload.indicatorIds) ? primaryPayload.indicatorIds : []),
      ...duplicatePayloads.flatMap((payload) => (Array.isArray(payload.indicatorIds) ? payload.indicatorIds : [])),
    ]),
    mergedOptionalResponsibilityIds: uniqueStrings([
      ...(Array.isArray(primaryPayload.mergedOptionalResponsibilityIds) ? primaryPayload.mergedOptionalResponsibilityIds : []),
      primary.id,
      ...duplicates.map((row) => row.id),
      ...duplicatePayloads.flatMap((payload) =>
        Array.isArray(payload.mergedOptionalResponsibilityIds) ? payload.mergedOptionalResponsibilityIds : [],
      ),
    ]),
    governanceReasons: uniqueStrings([
      ...(Array.isArray(primaryPayload.governanceReasons) ? primaryPayload.governanceReasons : []),
      ...duplicatePayloads.flatMap((payload) => (Array.isArray(payload.governanceReasons) ? payload.governanceReasons : [])),
      'merge_duplicate_new_optional_responsibility',
    ]),
    updatedAt: new Date().toISOString(),
  };
}

function consolidateUpdatedOptionalRecords(db) {
  const rows = db.prepare(`
    SELECT id, company, product_name, liability, payload
      FROM optional_responsibility_records
     ORDER BY company, product_name, liability, id
  `).all();
  const groups = new Map();
  for (const row of rows) {
    const key = [
      normalizeLookupText(row.company),
      normalizeLookupText(row.product_name),
      normalizeLookupText(row.liability),
    ].join('\u001f');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const updatePrimary = db.prepare('UPDATE optional_responsibility_records SET payload = ? WHERE id = ?');
  const deleteDuplicate = db.prepare('DELETE FROM optional_responsibility_records WHERE id = ?');
  for (const groupRows of groups.values()) {
    if (groupRows.length <= 1) continue;
    if (!groupRows.some((row) => payloadHasGovernanceReason(parsePayload(row.payload), 'quantify_new_optional_responsibility'))) continue;
    const [primary, ...duplicates] = groupRows;
    updatePrimary.run(JSON.stringify(mergeOptionalPayloads(groupRows)), primary.id);
    for (const duplicate of duplicates) {
      deleteDuplicate.run(duplicate.id);
    }
  }
}

export function quantifyNewOptionalResponsibilityIndicators({ dbPath = DEFAULT_DB_PATH, write = false, sampleLimit = 10 } = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    const beforePending = db.prepare(`
      SELECT COUNT(*) AS count
        FROM optional_responsibility_records
       WHERE json_extract(payload, '$.quantificationStatus') = 'pending_review'
    `).get().count;
    const plan = buildPlan(db);
    if (write) writePlan(db, plan);
    const afterPending = write
      ? db.prepare(`
          SELECT COUNT(*) AS count
            FROM optional_responsibility_records
           WHERE json_extract(payload, '$.quantificationStatus') = 'pending_review'
        `).get().count
      : beforePending - plan.updates.length;
    const byCoverageType = {};
    for (const indicator of plan.indicators) {
      byCoverageType[indicator.payload.coverageType] = (byCoverageType[indicator.payload.coverageType] || 0) + 1;
    }
    return {
      dbPath,
      dryRun: !write,
      beforePending,
      optionalRecordUpdates: plan.updates.length,
      indicatorUpserts: plan.indicators.length,
      skipped: plan.skipped.length,
      afterPending,
      byCoverageType,
      samples: plan.indicators.slice(0, sampleLimit).map((indicator) => ({
        id: indicator.payload.id,
        company: indicator.payload.company,
        productName: indicator.payload.productName,
        coverageType: indicator.payload.coverageType,
        liability: indicator.payload.liability,
        formulaText: indicator.payload.formulaText,
        linkedOptionalCount: indicator.payload.optionalResponsibilityIds.length,
      })),
    };
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = quantifyNewOptionalResponsibilityIndicators({
    dbPath: path.resolve(readArg('db-path', DEFAULT_DB_PATH)),
    write: hasFlag('write'),
    sampleLimit: Number(readArg('sample-limit', 10)) || 10,
  });
  console.log(JSON.stringify(result, null, 2));
}
