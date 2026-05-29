// scripts/fix-cashflow-indicators.mjs
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const DB_PATH = args[0] || process.env.DB_PATH || path.join(projectRoot, '.runtime/policy-ocr.sqlite');
const DRY_RUN = process.argv.includes('--dry-run');

function fixChangxingDiseaseDeath(db) {
  const old = db.prepare(
    `SELECT id FROM insurance_indicator_records
     WHERE product_name LIKE '%畅行万里智赢版%'
       AND liability LIKE '%疾病%'
       AND coverage_type = '人寿保障'
       AND json_extract(payload, '$.basis') = '基本保额'`
  ).all();
  if (!old.length) { console.log('[skip] 畅行万里疾病身故已修复'); return 0; }

  const sourceId = old[0].id;
  const now = new Date().toISOString();

  if (!DRY_RUN) {
    const del = db.prepare(`DELETE FROM insurance_indicator_records WHERE id = ?`);
    old.forEach((r) => del.run(r.id));

    const insert = db.prepare(
      `INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const productName = '新华人寿保险股份有限公司畅行万里智赢版两全保险';
    const company = '新华保险';

    const rows = [
      { liability: '疾病身故/全残(41岁前)', value: 1.6, formulaText: '实际交纳保险费 × 1.6', condition: '41岁前' },
      { liability: '疾病身故/全残(41-61岁)', value: 1.4, formulaText: '实际交纳保险费 × 1.4', condition: '41-61岁' },
      { liability: '疾病身故/全残(61岁后)', value: 1.2, formulaText: '实际交纳保险费 × 1.2', condition: '61岁后' },
    ];

    rows.forEach((r, i) => {
      const id = `fix-changxing-disease-${i + 1}`;
      const payload = JSON.stringify({
        id, company, productName, coverageType: '人寿保障', liability: r.liability,
        value: r.value, valueText: String(r.value), unit: '倍', basis: '已交保费',
        formulaText: r.formulaText, condition: r.condition, sourceRecordId: sourceId, updatedAt: now,
      });
      insert.run(id, company, productName, '人寿保障', r.liability, payload);
    });
  }
  console.log(`[fix] 畅行万里疾病身故: 删除 ${old.length} 条, 插入 3 条`);
  return old.length;
}

function fixChangxingAccidentScenarios(db) {
  const old = db.prepare(
    `SELECT id FROM insurance_indicator_records
     WHERE product_name LIKE '%畅行万里智赢版%'
       AND coverage_type = '意外保障'
       AND liability LIKE '%特定意外%'`
  ).all();
  if (!old.length) { console.log('[skip] 畅行万里意外场景已拆分'); return 0; }

  const sourceId = old[0].id;
  const now = new Date().toISOString();

  if (!DRY_RUN) {
    const del = db.prepare(`DELETE FROM insurance_indicator_records WHERE id = ?`);
    old.forEach((r) => del.run(r.id));

    const insert = db.prepare(
      `INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const productName = '新华人寿保险股份有限公司畅行万里智赢版两全保险';
    const company = '新华保险';

    const scenarios = [
      { liability: '一般意外身故/全残', value: 10 },
      { liability: '步行/骑行交通意外', value: 15 },
      { liability: '驾乘意外', value: 20 },
      { liability: '高空坠物/抛物意外', value: 20 },
      { liability: '客运轮船/汽车意外', value: 30 },
      { liability: '电梯意外', value: 30 },
      { liability: '公共场所特定事故', value: 40 },
      { liability: '重大自然灾害', value: 40 },
      { liability: '客运列车/航空意外', value: 60 },
    ];

    scenarios.forEach((s, i) => {
      const id = `fix-changxing-accident-${i + 1}`;
      const payload = JSON.stringify({
        id, company, productName, coverageType: '意外保障', liability: s.liability,
        value: s.value, valueText: String(s.value), unit: '倍', basis: '基本保额',
        formulaText: `基本保额 × ${s.value}`, condition: '', sourceRecordId: sourceId, updatedAt: now,
      });
      insert.run(id, company, productName, '意外保障', s.liability, payload);
    });
  }
  console.log(`[fix] 畅行万里意外场景: 删除 ${old.length} 条, 插入 9 条`);
  return old.length;
}

function fixAnxinNursing(db) {
  const old = db.prepare(
    `SELECT id FROM insurance_indicator_records
     WHERE product_name LIKE '%安鑫优选%'
       AND (liability LIKE '%疾病身故%' OR liability LIKE '%护理%')
       AND json_extract(payload, '$.basis') = '基本保额'`
  ).all();
  if (!old.length) { console.log('[skip] 安鑫护理已拆分'); return 0; }

  const sourceId = old[0].id;
  const now = new Date().toISOString();

  if (!DRY_RUN) {
    const del = db.prepare(`DELETE FROM insurance_indicator_records WHERE id = ?`);
    old.forEach((r) => del.run(r.id));

    const insert = db.prepare(
      `INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const productName = '安鑫优选终身护理保险';
    const companyRow = db.prepare(
      `SELECT company FROM insurance_indicator_records WHERE product_name LIKE '%安鑫优选%' LIMIT 1`
    ).get();
    const company = companyRow?.company || '新华保险';

    const rows = [
      { liability: '护理金(18岁前)', value: null, unit: '公式',
        formulaText: '实际交纳保险费，现金价值不展示', condition: '18岁前' },
      { liability: '护理金(18-61岁)', value: 1.6, unit: '倍',
        formulaText: '实际交纳保险费 × 160%，现金价值不展示', condition: '18-61岁' },
      { liability: '护理金(61岁后)', value: 1.2, unit: '倍',
        formulaText: 'max(实际交纳保险费 × 120%, 基本保额)，现金价值不展示', condition: '61岁后' },
    ];

    rows.forEach((r, i) => {
      const id = `fix-anxin-nursing-${i + 1}`;
      const payload = JSON.stringify({
        id, company, productName, coverageType: '疾病保障', liability: r.liability,
        value: r.value, valueText: r.value != null ? String(r.value) : '', unit: r.unit,
        basis: '已交保费', formulaText: r.formulaText, condition: r.condition,
        sourceRecordId: sourceId, updatedAt: now,
      });
      insert.run(id, company, productName, '疾病保障', r.liability, payload);
    });
  }
  console.log(`[fix] 安鑫护理: 删除 ${old.length} 条, 插入 3 条`);
  return old.length;
}

console.log(`[info] DB: ${DB_PATH}, DRY_RUN: ${DRY_RUN}`);
const db = new DatabaseSync(DB_PATH);
const total = fixChangxingDiseaseDeath(db) + fixChangxingAccidentScenarios(db) + fixAnxinNursing(db);
db.close();
console.log(`[done] 共修复 ${total} 条旧记录`);
