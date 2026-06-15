import type { CashValueRow } from '../api/contracts/cashflow';

export function summarizeCashValues(cashValues?: CashValueRow[]) {
  const rows = Array.isArray(cashValues)
    ? [...cashValues].filter((row) => Number.isFinite(Number(row.policyYear)) && Number.isFinite(Number(row.cashValue)))
    : [];
  if (!rows.length) return null;
  rows.sort((left, right) => Number(left.policyYear) - Number(right.policyYear));
  return {
    count: rows.length,
    first: rows[0],
    last: rows[rows.length - 1],
  };
}

export function parseNumericInput(value: string | number | null | undefined) {
  const normalized = String(value ?? '').replace(/[,，\s元¥￥]/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

export function makeManualCashValueRow(policyYear = 1, age: number | null = null): CashValueRow {
  return { policyYear, age, cashValue: 0, source: 'manual' };
}

export function normalizeCashValueRowsForEditing(cashValues?: CashValueRow[]) {
  const rows: CashValueRow[] = [];
  if (Array.isArray(cashValues)) {
    for (const row of cashValues) {
      const policyYear = parseNumericInput(row.policyYear);
      const age = row.age === null || row.age === undefined ? null : parseNumericInput(row.age);
      const cashValue = parseNumericInput(row.cashValue);
      if (policyYear === null || cashValue === null) continue;
      rows.push({
        policyYear,
        age,
        cashValue,
        source: row.source || 'manual',
      });
    }
    rows.sort((left, right) => left.policyYear - right.policyYear);
  }
  return rows.length ? rows : [makeManualCashValueRow()];
}

export function nextManualCashValueRow(rows: CashValueRow[]) {
  const sortedRows = [...rows]
    .filter((row) => Number.isFinite(Number(row.policyYear)))
    .sort((left, right) => Number(left.policyYear) - Number(right.policyYear));
  const last = sortedRows[sortedRows.length - 1];
  const nextPolicyYear = Number(last?.policyYear || 0) + 1 || 1;
  const nextAge = last?.age === null || last?.age === undefined ? null : Number(last.age) + 1;
  return makeManualCashValueRow(nextPolicyYear, Number.isFinite(Number(nextAge)) ? nextAge : null);
}

export function appendCashValueRowsSequentially(
  existingRows: CashValueRow[],
  supplementalRows: CashValueRow[],
  source = 'ocr',
) {
  const existing = normalizeCashValueRowsForSaving(existingRows, source);
  const incoming = normalizeCashValueRowsForSaving(supplementalRows, source);
  if (!existing.length) return incoming;
  if (!incoming.length) return existing;

  const lastExisting = existing[existing.length - 1];
  const maxPolicyYear = Number(lastExisting.policyYear);
  const maxAge = lastExisting.age === null || lastExisting.age === undefined ? null : Number(lastExisting.age);
  const alreadyNumberedRows = incoming.filter((row) => Number(row.policyYear) > maxPolicyYear);
  const rowsToAppend = alreadyNumberedRows.length
    ? alreadyNumberedRows
    : incoming.map((row, index) => ({
      ...row,
      policyYear: maxPolicyYear + index + 1,
      age: Number.isFinite(maxAge) ? Number(maxAge) + index + 1 : row.age,
    }));

  return normalizeCashValueRowsForSaving([...existing, ...rowsToAppend], source);
}

export function normalizeCashValueRowsForSaving(rows: CashValueRow[], source = 'manual') {
  const normalized: CashValueRow[] = [];
  for (const row of rows) {
    const policyYear = parseNumericInput(row.policyYear);
    const age = row.age === null || row.age === undefined ? null : parseNumericInput(row.age);
    const cashValue = parseNumericInput(row.cashValue);
    if (policyYear === null || policyYear <= 0 || cashValue === null || cashValue < 0) continue;
    normalized.push({
      policyYear,
      age,
      cashValue,
      source: row.source || source,
    });
  }
  normalized.sort((left, right) => left.policyYear - right.policyYear);
  const byPolicyYear = new Map<number, CashValueRow>();
  for (const row of normalized) byPolicyYear.set(row.policyYear, row);
  return [...byPolicyYear.values()];
}
