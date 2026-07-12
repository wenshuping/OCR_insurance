import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { indicatorCalculationPayloadFields, normalizeIndicatorCalculation } from '../src/indicator-calculation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(projectRoot, '.runtime', 'local', 'policy-ocr.sqlite');
const VERSION = '2026-06-21-indicator-computability';

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parsePayload(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function bump(map, key, amount = 1) {
  const normalized = String(key || 'unknown').trim() || 'unknown';
  map.set(normalized, (map.get(normalized) || 0) + amount);
}

function sortedObject(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')));
}

function samplePush(samples, key, item, sampleLimit) {
  if (!samples.has(key)) samples.set(key, []);
  const bucket = samples.get(key);
  if (bucket.length < sampleLimit) bucket.push(item);
}

function changedPayload(payload, fields) {
  return Object.entries(fields).some(([key, value]) => payload[key] !== value);
}

function indicatorForCalculationAudit(indicator = {}) {
  const {
    basisKey,
    calculationKey,
    calculationEligible,
    calculationReason,
    calculationMetadataVersion,
    ...rest
  } = indicator;
  return rest;
}

export function auditIndicatorComputability({
  dbPath = DEFAULT_DB_PATH,
  writeCalculationKeys = false,
  sampleLimit = 5,
  coverageType = '',
} = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare(`
      SELECT id, company, product_name, coverage_type, liability, payload
        FROM insurance_indicator_records
       WHERE (? = '' OR coverage_type = ?)
       ORDER BY coverage_type, product_name, liability, id
    `).all(coverageType, coverageType);

    const byCoverageType = new Map();
    const byBasisKey = new Map();
    const byCalculationKey = new Map();
    const byIssue = new Map();
    const samples = new Map();
    const updates = [];
    let computable = 0;
    let notComputable = 0;
    let emptyFormula = 0;
    let alreadyStructured = 0;

    for (const row of rows) {
      const payload = parsePayload(row.payload);
      const indicator = {
        ...payload,
        id: payload.id || row.id,
        company: payload.company || row.company,
        productName: payload.productName || row.product_name,
        coverageType: payload.coverageType || row.coverage_type,
        liability: payload.liability || row.liability,
      };
      const auditIndicator = indicatorForCalculationAudit(indicator);
      const meta = normalizeIndicatorCalculation(auditIndicator);
      const fields = {
        ...indicatorCalculationPayloadFields(auditIndicator),
        calculationMetadataVersion: VERSION,
      };
      const effectiveCoverageType = indicator.coverageType || row.coverage_type || 'unknown';
      const issue = meta.calculationEligible ? 'computable' : meta.calculationKey || 'unknown';

      bump(byCoverageType, effectiveCoverageType);
      bump(byBasisKey, meta.basisKey);
      bump(byCalculationKey, meta.calculationKey);
      bump(byIssue, issue);
      if (meta.calculationEligible) computable += 1;
      else notComputable += 1;
      if (!String(indicator.formulaText || '').trim()) emptyFormula += 1;
      if (payload.basisKey || payload.calculationKey) alreadyStructured += 1;

      if (issue !== 'computable') {
        samplePush(samples, issue, {
          id: row.id,
          productName: row.product_name,
          coverageType: row.coverage_type,
          liability: row.liability,
          basis: indicator.basis || '',
          formulaText: indicator.formulaText || '',
          calculationReason: meta.calculationReason,
        }, sampleLimit);
      }

      if (changedPayload(payload, fields)) {
        updates.push({
          id: row.id,
          payload: {
            ...payload,
            ...fields,
          },
        });
      }
    }

    if (writeCalculationKeys && updates.length) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      const update = db.prepare('UPDATE insurance_indicator_records SET payload = ? WHERE id = ?');
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of updates) update.run(JSON.stringify(row.payload), row.id);
        db.prepare(`
          INSERT INTO app_meta (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run('insurance_indicator_calculation_metadata_updated_at', new Date().toISOString());
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }

    return {
      dbPath,
      dryRun: !writeCalculationKeys,
      coverageType: coverageType || 'all',
      total: rows.length,
      computable,
      notComputable,
      emptyFormula,
      alreadyStructured,
      rowsNeedingMetadataUpdate: updates.length,
      metadataUpdates: writeCalculationKeys ? updates.length : 0,
      byCoverageType: sortedObject(byCoverageType),
      byBasisKey: sortedObject(byBasisKey),
      byCalculationKey: sortedObject(byCalculationKey),
      byIssue: sortedObject(byIssue),
      samples: Object.fromEntries(samples.entries()),
    };
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = auditIndicatorComputability({
    dbPath: path.resolve(readArg('db-path', DEFAULT_DB_PATH)),
    writeCalculationKeys: hasFlag('write-calculation-keys'),
    sampleLimit: Number(readArg('sample-limit', 5)) || 5,
    coverageType: readArg('coverage-type', ''),
  });
  console.log(JSON.stringify(result, null, 2));
}
