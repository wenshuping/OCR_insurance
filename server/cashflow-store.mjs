/**
 * Cashflow & cash-value stores — DB operations for policy financial data.
 *
 * • createCashflowStore:   pre-computed cashflow entries (policy_cashflows)
 * • createCashValueStore:  OCR-extracted cash value data (policy_cash_values)
 */

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS policy_cashflows (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    policy_id   INTEGER NOT NULL REFERENCES policies(id),
    year        INTEGER NOT NULL,
    age         INTEGER NOT NULL,
    amount      REAL    NOT NULL,
    cumulative  REAL    NOT NULL,
    liability   TEXT    NOT NULL,
    calc_text   TEXT,
    created_at  TEXT    DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cashflows_policy ON policy_cashflows(policy_id);
`;

export function ensureCashflowTable(db) {
  db.exec(CREATE_TABLE_SQL);
}

export function createCashflowStore(db) {
  ensureCashflowTable(db);

  const selectEntries = db.prepare(`
    SELECT year, age, amount, cumulative, liability, calc_text
      FROM policy_cashflows
     WHERE policy_id = ?
     ORDER BY year ASC
  `);

  const deleteByPolicyId = db.prepare(`
    DELETE FROM policy_cashflows WHERE policy_id = ?
  `);

  const insertEntry = db.prepare(`
    INSERT INTO policy_cashflows (policy_id, year, age, amount, cumulative, liability, calc_text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const selectDistinctPolicyIds = db.prepare(`
    SELECT DISTINCT policy_id FROM policy_cashflows ORDER BY policy_id ASC
  `);

  const selectStatus = db.prepare(`
    SELECT
      COUNT(*)           AS totalEntries,
      COUNT(DISTINCT policy_id) AS totalPolicies
    FROM policy_cashflows
  `);

  function getEntries(policyId) {
    return selectEntries.all(policyId).map((row) => ({
      year: row.year,
      age: row.age,
      amount: row.amount,
      cumulative: row.cumulative,
      liability: row.liability,
      calcText: row.calc_text,
    }));
  }

  function replaceEntries(policyId, entries) {
    if (!Array.isArray(entries)) {
      throw new TypeError('replaceEntries: entries must be an array');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      deleteByPolicyId.run(policyId);
      for (const entry of entries) {
        insertEntry.run(
          policyId,
          entry.year,
          entry.age,
          entry.amount,
          entry.cumulative,
          entry.liability,
          entry.calcText ?? null,
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function getAllPolicyIds() {
    return selectDistinctPolicyIds.all().map((row) => row.policy_id);
  }

  function getStatus() {
    const row = selectStatus.get();
    return {
      totalEntries: row.totalEntries,
      totalPolicies: row.totalPolicies,
    };
  }

  return { getEntries, replaceEntries, getAllPolicyIds, getStatus };
}

// ---------------------------------------------------------------------------
// Cash-value store — DB operations for the `policy_cash_values` table.
//
// Stores OCR-extracted cash value data keyed by policy_id + policy_year.
// ---------------------------------------------------------------------------

const CREATE_CASH_VALUES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS policy_cash_values (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    policy_id   INTEGER NOT NULL REFERENCES policies(id),
    policy_year INTEGER NOT NULL,
    age         INTEGER,
    cash_value  REAL    NOT NULL,
    source      TEXT    DEFAULT 'ocr',
    created_at  TEXT    DEFAULT (datetime('now')),
    UNIQUE(policy_id, policy_year)
  );
  CREATE INDEX IF NOT EXISTS idx_cash_values_policy
    ON policy_cash_values(policy_id);
`;

export function ensureCashValueTable(db) {
  db.exec(CREATE_CASH_VALUES_TABLE_SQL);
}

export function createCashValueStore(db) {
  ensureCashValueTable(db);

  const selectValues = db.prepare(`
    SELECT policy_year, age, cash_value, source
      FROM policy_cash_values
     WHERE policy_id = ?
     ORDER BY policy_year ASC
  `);

  const deleteByPolicyId = db.prepare(`
    DELETE FROM policy_cash_values WHERE policy_id = ?
  `);

  const insertValue = db.prepare(`
    INSERT INTO policy_cash_values (policy_id, policy_year, age, cash_value, source)
    VALUES (?, ?, ?, ?, ?)
  `);

  function getValues(policyId) {
    return selectValues.all(policyId).map((row) => ({
      policyYear: row.policy_year,
      age: row.age,
      cashValue: row.cash_value,
      source: row.source,
    }));
  }

  function replaceValues(policyId, rows) {
    if (!Array.isArray(rows)) {
      throw new TypeError('replaceValues: rows must be an array');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      deleteByPolicyId.run(policyId);
      for (const row of rows) {
        insertValue.run(
          policyId,
          row.policyYear,
          row.age ?? null,
          row.cashValue,
          row.source ?? 'ocr',
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return { getValues, replaceValues };
}
