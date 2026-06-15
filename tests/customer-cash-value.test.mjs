import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

async function loadCustomerCashValueModule() {
  const source = fs.readFileSync(new URL('../src/shared/customer-cash-value.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const encoded = Buffer.from(output, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

test('appendCashValueRowsSequentially shifts a supplemental scan after the current last year', async () => {
  const { appendCashValueRowsSequentially } = await loadCustomerCashValueModule();
  const rows = appendCashValueRowsSequentially(
    [
      { policyYear: 19, age: 48, cashValue: 12760, source: 'ocr' },
      { policyYear: 20, age: 49, cashValue: 13329, source: 'ocr' },
    ],
    [
      { policyYear: 1, age: 30, cashValue: 13921 },
      { policyYear: 2, age: 31, cashValue: 14542 },
    ],
    'ocr',
  );

  assert.deepEqual(rows.map((row) => [row.policyYear, row.age, row.cashValue]), [
    [19, 48, 12760],
    [20, 49, 13329],
    [21, 50, 13921],
    [22, 51, 14542],
  ]);
});

test('appendCashValueRowsSequentially preserves already numbered remaining years', async () => {
  const { appendCashValueRowsSequentially } = await loadCustomerCashValueModule();
  const rows = appendCashValueRowsSequentially(
    [
      { policyYear: 1, age: null, cashValue: 1000, source: 'ocr' },
      { policyYear: 2, age: null, cashValue: 2000, source: 'ocr' },
    ],
    [
      { policyYear: 2, age: null, cashValue: 2000 },
      { policyYear: 3, age: null, cashValue: 3000 },
      { policyYear: 4, age: null, cashValue: 4000 },
    ],
    'ocr',
  );

  assert.deepEqual(rows.map((row) => [row.policyYear, row.cashValue]), [
    [1, 1000],
    [2, 2000],
    [3, 3000],
    [4, 4000],
  ]);
});
