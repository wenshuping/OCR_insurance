import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/methods/legacy-indicator-safe-reuse-v7-clone-and-medical-table';
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const readJsonl = (file) => fs.readFileSync(path.join(root, file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

test('v7 clone gate is exact and real SSD remains unchanged', () => {
  const summary = readJson('summary.json');
  assert.equal(summary.clone.clonePass, 10);
  assert.equal(summary.clone.materializerBlocked, 0);
  assert.equal(summary.clone.validationFailure, 0);
  assert.equal(summary.clone.officialResponsibilities, 40);
  assert.equal(summary.clone.importReadyResponsibilities, 40);
  assert.equal(summary.clone.importReadyIndicators, 40);
  assert.equal(summary.clone.after.quickCheck, 'ok');
  assert.equal(summary.clone.after.foreignKeyCheckCount, 0);
  assert.equal(summary.realSsd.unchangedSha, true);
  assert.equal(summary.realSsd.unchangedSize, true);
  assert.equal(summary.realSsd.writes, 0);
  assert.equal(summary.legacyPollutionLeakage, 0);
  assert.equal(summary.versionOverwrite, 0);
  assert.equal(summary.responsibilityOmissions, 0);
  assert.equal(readJsonl('import-ready.jsonl').length, 10);
});

test('formula, operands, branches and parent/branch fields survive three-layer readback', () => {
  const annual = readJson('products/02/readback.json');
  assert.equal(annual.ok, true);
  const annualIndicator = annual.indicators.find((item) => item.normalizedFormula?.includes('min('));
  assert.ok(annualIndicator);
  assert.ok(annualIndicator.operands.length >= 2);
  assert.ok(annualIndicator.branches.length >= 1);

  const accident = readJson('products/09/readback.json');
  assert.equal(accident.ok, true);
  assert.equal(accident.orphanIndicatorIds ?? accident.orphanNestedIds?.length ?? 0, 0);
  for (const indicator of accident.indicators) {
    assert.ok(indicator.evidenceSegments?.length);
    assert.ok(indicator.provenance);
  }
});

test('medical table evidence proves merged deductible and both reimbursement rows', () => {
  const evidence = readJson('medical-table/table-evidence.json');
  assert.equal(evidence.page, 13);
  assert.equal(evidence.sharedAnnualDeductible.value, '1 万元');
  assert.deepEqual(evidence.sharedAnnualDeductible.appliesTo, ['一般医疗保险金', '恶性肿瘤医疗保险金']);
  assert.equal(evidence.generalRate.socialOrPublicMedicalReimbursement, '100%');
  assert.equal(evidence.generalRate.noSocialOrPublicMedicalReimbursement, '60%');
  assert.equal(evidence.malignantRate.sharedFromRow, '一般医疗保险金');
  assert.equal(readJson('medical-table/source-url-readback.json').ok, true);
  assert.equal(readJson('medical-table/canonicalizer.json').ok, true);
  assert.equal(readJson('medical-table/validator.json').ok, true);
  assert.equal(readJson('medical-table/clone-terminal.json').terminal, 'clone_pass');
});
