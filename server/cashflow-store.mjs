/**
 * Cashflow store — DB operations for the `policy_cashflows` table.
 *
 * Provides a thin wrapper around `node:sqlite` (DatabaseSync) for storing
 * pre-computed cashflow entries keyed by policy_id + year.
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
