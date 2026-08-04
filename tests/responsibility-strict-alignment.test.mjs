import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  evaluateResponsibilityStrictAlignment,
} from '../scripts/responsibility-strict-alignment.mjs';
import {
  assertImportExecutionGate,
  collectImportExecution,
  createImportExecutionGate,
} from '../scripts/import-execution-guard.mjs';

const repoRoot = '/Volumes/OCR_ARCHIVE/OCR_insurance/.worktrees/dev-agent-semantic-integration';

function approvedArtifact({ responsibilities }) {
  return {
    company: '严格对齐测试保险公司',
    productName: '严格对齐测试产品',
    sourceDigest: 'sha256:strict-source',
    sourceUrl: 'https://official.example.test/strict.pdf',
    audit: { status: 'approved' },
    responsibilities,
  };
}

function responsibility({
  id = 'R1',
  title = '身故或全残保险金',
  indicators = [],
  parentResponsibilityId = null,
} = {}) {
  return {
    responsibilityId: id,
    liability: title,
    card: { title },
    sourceUrl: 'https://official.example.test/strict.pdf',
    sourceDigest: 'sha256:strict-source',
    responsibilitySourceDigest: 'sha256:strict-source',
    parentResponsibilityId,
    indicators,
  };
}

function indicator({
  name = '给付金额',
  responsibilityId = 'R1',
  parentResponsibilityId = null,
  branchId = null,
  formulaText = 'max(基本保险金额, 已交保险费)',
  normalizedFormula = 'max(basic_amount, paid_premium)',
  requiredInputs = ['basic_amount', 'paid_premium'],
  operands = [{ operandId: 'basic', basisKey: 'basic_amount' }, { operandId: 'premium', basisKey: 'paid_premium' }],
  branches = [],
} = {}) {
  return {
    indicatorName: name,
    responsibilityId,
    parentResponsibilityId,
    branchId,
    sourceUrl: 'https://official.example.test/strict.pdf',
    sourceDigest: 'sha256:strict-source',
    responsibilitySourceDigest: 'sha256:strict-source',
    formulaText,
    normalizedFormula,
    requiredInputs,
    operands,
    branches,
    evidenceSegments: [{ sourcePage: '3', exactText: `${name}官方证据` }],
    provenance: { source: 'approved_artifact', locator: `page:3#${responsibilityId}` },
  };
}

function persistedRows(artifact) {
  let serial = 0;
  const cards = artifact.responsibilities.map((item) => {
    const nested = item.indicators.map((source) => {
      const id = `indicator-${serial += 1}`;
      return {
        id,
        liability: item.card.title,
        ...source,
        sourceExcerpt: source.evidenceSegments.map((segment) => segment.exactText).join('\n'),
      };
    });
    return {
      id: `card-${item.responsibilityId}`,
      company: artifact.company,
      productName: artifact.productName,
      title: item.card.title,
      payload: {
        title: item.card.title,
        sourceDigest: artifact.sourceDigest,
        sourceUrl: artifact.sourceUrl,
        indicators: nested,
      },
    };
  });
  const indicators = cards.flatMap((card) => card.payload.indicators.map((item) => ({
    id: item.id,
    company: artifact.company,
    productName: artifact.productName,
    liability: card.title,
    payload: { ...item },
  })));
  return { cards, indicators };
}

function evaluate(artifact, persisted = persistedRows(artifact)) {
  return evaluateResponsibilityStrictAlignment({
    artifact,
    cards: persisted.cards,
    indicators: persisted.indicators,
    company: artifact.company,
    productName: artifact.productName,
  });
}

test('strict alignment accepts legal multi-indicator max/min responsibilities', () => {
  const artifact = approvedArtifact({
    responsibilities: [responsibility({
      indicators: [
        indicator({ name: '较大者给付', normalizedFormula: 'max(basic_amount, paid_premium)' }),
        indicator({
          name: '较小者限额',
          formulaText: 'min(基本保险金额, 限额)',
          normalizedFormula: 'min(basic_amount, limit)',
          requiredInputs: ['basic_amount', 'limit'],
          operands: [{ operandId: 'basic', basisKey: 'basic_amount' }, { operandId: 'limit', basisKey: 'limit' }],
        }),
      ],
    })],
  });
  assert.equal(evaluate(artifact).strictAligned, true);
});

test('strict alignment preserves one death/full-disability indicator with condition branches', () => {
  const branches = [
    { branchId: 'death', condition: '被保险人身故', result: 'max(basic_amount, paid_premium)' },
    { branchId: 'disability', condition: '被保险人全残', result: 'max(basic_amount, paid_premium)' },
  ];
  const artifact = approvedArtifact({
    responsibilities: [responsibility({ indicators: [indicator({ branches })] })],
  });
  const result = evaluate(artifact);
  assert.equal(result.strictAligned, true);
  assert.equal(result.counts.expectedIndicators, 1);
});

test('strict alignment rejects source digest, evidence, and formula projection loss', () => {
  const artifact = approvedArtifact({
    responsibilities: [responsibility({ indicators: [indicator()] })],
  });
  const persisted = persistedRows(artifact);
  persisted.cards[0].payload.indicators[0].sourceDigest = 'sha256:wrong';
  persisted.cards[0].payload.indicators[0].evidenceSegments = [];
  persisted.indicators[0].payload.normalizedFormula = null;
  const result = evaluate(artifact, persisted);
  assert.equal(result.strictAligned, false);
  assert.ok(result.reasonCodes.includes('ARTIFACT_TO_NESTED_FIELD_MISMATCH'));
  assert.ok(result.reasonCodes.includes('NESTED_TO_RECORD_FIELD_MISMATCH'));
  assert.ok(result.reasonCodes.includes('SOURCE_DIGEST_CONFLICT'));
});

test('strict alignment accepts optional parent/branch linkage only when both layers preserve it', () => {
  const artifact = approvedArtifact({
    responsibilities: [responsibility({
      id: 'R-optional',
      title: '可选责任保险金',
      parentResponsibilityId: 'R-parent',
      indicators: [indicator({
        responsibilityId: 'R-optional',
        parentResponsibilityId: 'R-parent',
        branchId: 'optional-a',
      })],
    })],
  });
  assert.equal(evaluate(artifact).strictAligned, true);
  const persisted = persistedRows(artifact);
  persisted.indicators[0].payload.branchId = 'optional-b';
  assert.ok(evaluate(artifact, persisted).reasonCodes.includes('NESTED_TO_RECORD_FIELD_MISMATCH'));
});

test('strict alignment rejects duplicate nested ids and orphan indicator records', () => {
  const artifact = approvedArtifact({
    responsibilities: [responsibility({ indicators: [indicator(), indicator({ name: '第二指标' })] })],
  });
  const persisted = persistedRows(artifact);
  persisted.cards[0].payload.indicators[1].id = persisted.cards[0].payload.indicators[0].id;
  const result = evaluate(artifact, persisted);
  assert.equal(result.strictAligned, false);
  assert.ok(result.reasonCodes.includes('DUPLICATE_NESTED_INDICATOR_ID'));
  assert.ok(result.reasonCodes.includes('ORPHAN_INDICATOR_RECORD'));
});

test('execution gate rejects a changed strict-alignment binding SHA', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-alignment-gate-'));
  const gatePath = path.join(dir, 'gate.json');
  try {
    const execution = collectImportExecution({
      repoRoot,
      scriptPath: path.join(repoRoot, 'scripts/import-reviewed-responsibility-artifacts.mjs'),
      dbPath: path.join(dir, 'clone.sqlite'),
      artifacts: [],
      write: true,
      isolatedClone: true,
      gatePath,
      cwd: repoRoot,
    });
    const gate = JSON.parse(JSON.stringify(createImportExecutionGate({ execution })));
    gate.codeTree.boundFiles[0].sha256 = 'tampered';
    fs.writeFileSync(gatePath, JSON.stringify(gate));
    assert.throws(
      () => assertImportExecutionGate({ gatePath, execution }),
      (error) => error.code === 'IMPORT_EXECUTION_GATE_BINDING_MISMATCH',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
