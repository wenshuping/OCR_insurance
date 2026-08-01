import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { importReviewedResponsibilityArtifacts } from '../scripts/import-reviewed-responsibility-artifacts.mjs';

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewed-artifact-import-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function unifiedResponsibility(overrides = {}) {
  return {
    responsibilityId: 'death-benefit',
    liability: '身故保险金',
    triggerCondition: '被保险人身故',
    insurerObligation: '按基本保险金额给付身故保险金',
    sourceExcerpt: '被保险人身故，本公司按基本保险金额给付身故保险金。',
    card: {
      title: '身故保险金',
      customerSummary: '被保险人身故后，保险公司按约定给付。',
    },
    indicators: [{
      basisKey: 'basic_amount',
      calculationKey: 'basic_amount',
      calculationEligible: true,
      calculationStatus: 'calculable',
      calculationReason: '按基本保险金额给付。',
    }],
    ...overrides,
  };
}

function writeJsonl(filePath, records) {
  fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

test('imports unified pipeline responsibilities from an approval index in dry-run', () => {
  withTempDir((dir) => {
    const artifactPath = path.join(dir, 'artifact.json');
    const indexPath = path.join(dir, 'approved.jsonl');
    fs.writeFileSync(artifactPath, JSON.stringify({
      company: '示例人寿',
      productName: '示例终身寿险',
      productIdentity: { sourceUrl: 'https://example.com/policy.pdf' },
      responsibilities: [
        unifiedResponsibility(),
        unifiedResponsibility({
          responsibilityId: 'maturity-benefit',
          liability: '满期保险金',
          card: { title: '满期保险金', customerSummary: '满期生存时按约定给付。' },
        }),
      ],
    }));
    writeJsonl(indexPath, [{ artifactPath, responsibilityCount: 2 }]);

    const result = importReviewedResponsibilityArtifacts({
      artifacts: [indexPath],
      dbPath: path.join(dir, 'must-not-be-created.sqlite'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.productsReviewed, 1);
    assert.equal(result.acceptedResponsibilities, 2);
    assert.equal(result.validationIssueCount, 0);
  });
});

test('uses approval index identity for a nested artifact', () => {
  withTempDir((dir) => {
    const artifactPath = path.join(dir, 'artifact.json');
    const indexPath = path.join(dir, 'approved.jsonl');
    fs.writeFileSync(artifactPath, JSON.stringify({
      company: '产品简称',
      productName: '条款简称',
      productIdentity: { sourceUrl: 'https://example.com/identity.pdf' },
      responsibilities: [unifiedResponsibility()],
    }));
    writeJsonl(indexPath, [{
      company: '示例人寿保险股份有限公司',
      productName: '示例人寿条款全称',
      artifactPath,
      responsibilityCount: 1,
    }]);

    const result = importReviewedResponsibilityArtifacts({ artifacts: [indexPath] });

    assert.equal(result.ok, true);
    assert.equal(result.samples[0].company, '示例人寿保险股份有限公司');
    assert.equal(result.samples[0].productName, '示例人寿条款全称');
  });
});

test('rejects same product name with different source digests as a version conflict', () => {
  withTempDir((dir) => {
    const firstPath = path.join(dir, 'first.json');
    const secondPath = path.join(dir, 'second.json');
    for (const [filePath, digest] of [[firstPath, 'sha256:first'], [secondPath, 'sha256:second']]) {
      fs.writeFileSync(filePath, JSON.stringify({
        company: '示例人寿',
        productName: '同名不同版本产品',
        productIdentity: { sourceUrl: `https://example.com/${digest}.pdf`, sourceDigest: digest },
        responsibilities: [unifiedResponsibility()],
      }));
    }

    const result = importReviewedResponsibilityArtifacts({ artifacts: [firstPath, secondPath] });

    assert.equal(result.ok, false);
    assert.deepEqual(result.versionConflicts, [{
      productKey: '示例人寿\u001f同名不同版本产品',
      sourceDigests: ['sha256:first', 'sha256:second'],
    }]);
    assert.equal(result.validationFailures.length, 2);
    assert.ok(result.validationFailures.every((failure) => failure.issues[0].startsWith('version_conflict:')));
    assert.equal(result.acceptedResponsibilities, 0);
  });
});

test('rejects source-pinned responsibility title mismatch before materialization', () => {
  withTempDir((dir) => {
    const artifactPath = path.join(dir, 'mismatched-title.json');
    fs.writeFileSync(artifactPath, JSON.stringify({
      company: '示例人寿',
      productName: '来源锁定产品',
      productIdentity: { sourceUrl: 'https://example.com/pinned.pdf', sourceDigest: 'sha256:pinned' },
      responsibilities: [unifiedResponsibility({
        liability: '整段责任描述',
        card: { title: '身故保险金', customerSummary: '被保险人身故后按约定给付。' },
      })],
    }));

    const result = importReviewedResponsibilityArtifacts({ artifacts: [artifactPath] });

    assert.equal(result.ok, false);
    assert.ok(result.validationFailures[0].issues.includes('artifact_card_title_mismatch:0:整段责任描述->身故保险金'));
    assert.equal(result.acceptedResponsibilities, 0);
  });
});

test('fills missing calculation metadata in older unified artifacts', () => {
  withTempDir((dir) => {
    const artifactPath = path.join(dir, 'older-unified.json');
    fs.writeFileSync(artifactPath, JSON.stringify({
      company: '示例人寿',
      productName: '旧版统一产物',
      productIdentity: { sourceUrl: 'https://example.com/older.pdf' },
      responsibilities: [unifiedResponsibility({
        indicators: [{
          formulaText: '基本保险金额 × 100%',
          calculationStatus: 'needs_claim_facts',
          calculationReason: '需要基本保险金额。',
        }],
      })],
    }));

    const result = importReviewedResponsibilityArtifacts({ artifacts: [artifactPath] });

    assert.equal(result.ok, true);
    assert.equal(result.acceptedResponsibilities, 1);
    assert.equal(result.validationIssueCount, 0);
  });
});

test('preserves responsibility repair provenance on imported indicators', () => {
  withTempDir((dir) => {
    const artifactPath = path.join(dir, 'repaired-unified.json');
    const dbPath = path.join(dir, 'write.sqlite');
    fs.writeFileSync(artifactPath, JSON.stringify({
      artifactId: 'responsibility_repair_artifact_example',
      company: '示例人寿',
      productName: '修复版统一产物',
      productIdentity: {
        sourceUrl: 'https://example.com/repaired.pdf',
        sourceDigest: 'sha256:repaired-source',
      },
      repairAudit: { version: '2026-07-26-deepseek-repair-v2' },
      responsibilities: [unifiedResponsibility()],
    }));

    const result = importReviewedResponsibilityArtifacts({
      artifacts: [artifactPath],
      dbPath,
      write: true,
    });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare(`
        SELECT payload
          FROM insurance_indicator_records
         WHERE company = ? AND product_name = ?
      `).get('示例人寿', '修复版统一产物');
      const payload = JSON.parse(row.payload);
      assert.equal(result.ok, true);
      assert.equal(payload.responsibilityArtifactId, 'responsibility_repair_artifact_example');
      assert.equal(payload.responsibilityRepairVersion, '2026-07-26-deepseek-repair-v2');
      assert.equal(payload.responsibilitySourceDigest, 'sha256:repaired-source');
    } finally {
      db.close();
    }
  });
});

test('maps unified included status to a visible responsibility card', () => {
  withTempDir((dir) => {
    const artifactPath = path.join(dir, 'included-unified.json');
    const dbPath = path.join(dir, 'write.sqlite');
    fs.writeFileSync(artifactPath, JSON.stringify({
      company: '示例人寿',
      productName: '旧状态产品',
      productIdentity: { sourceUrl: 'https://example.com/included.pdf' },
      responsibilities: [unifiedResponsibility({
        liability: '被保险人接受治疗，本公司按约定给付医疗保险金。',
        card: {
          title: '医疗保险金',
          customerSummary: '接受符合约定的治疗后给付医疗保险金。',
        },
        selectionStatus: 'included',
      })],
    }));

    const result = importReviewedResponsibilityArtifacts({
      artifacts: [artifactPath],
      dbPath,
      write: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.materializedProducts, 1);
    assert.equal(result.materializedCards, 1);

    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`
        UPDATE product_responsibility_cards
           SET id = 'legacy-card-id', product_key = 'legacy-product-key'
      `).run();
    } finally {
      db.close();
    }

    importReviewedResponsibilityArtifacts({
      artifacts: [artifactPath],
      dbPath,
      write: true,
    });
    const readDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const count = readDb.prepare(`
        SELECT COUNT(*) AS count
          FROM product_responsibility_cards
         WHERE company = ? AND product_name = ?
      `).get('示例人寿', '旧状态产品').count;
      assert.equal(count, 1);
    } finally {
      readDb.close();
    }
  });
});

test('keeps same-title unified responsibility branches as distinct indicators', () => {
  withTempDir((dir) => {
    const artifactPath = path.join(dir, 'same-title-branches.json');
    const dbPath = path.join(dir, 'write.sqlite');
    fs.writeFileSync(artifactPath, JSON.stringify({
      company: '示例人寿',
      productName: '同名分支产品',
      productIdentity: { sourceUrl: 'https://example.com/branches.pdf' },
      responsibilities: [
        unifiedResponsibility({ responsibilityId: 'medical-plan-a' }),
        unifiedResponsibility({ responsibilityId: 'medical-plan-b' }),
      ],
    }));

    const result = importReviewedResponsibilityArtifacts({
      artifacts: [artifactPath],
      dbPath,
      write: true,
    });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const count = db.prepare(`
        SELECT COUNT(*) AS count
          FROM insurance_indicator_records
         WHERE company = ? AND product_name = ?
      `).get('示例人寿', '同名分支产品').count;
      assert.equal(count, 2);
      assert.equal(result.acceptedResponsibilities, 2);
    } finally {
      db.close();
    }
  });
});

test('keeps the legacy acceptedResponsibilities JSONL format compatible', () => {
  withTempDir((dir) => {
    const artifactPath = path.join(dir, 'legacy.jsonl');
    writeJsonl(artifactPath, [{
      company: '示例人寿',
      productName: '旧版格式产品',
      acceptedResponsibilities: [{
        liability: '身故保险金',
        customerSummary: '被保险人身故后按约定给付。',
        triggerCondition: '被保险人身故',
        insurerObligation: '给付身故保险金',
        sourceUrl: 'https://example.com/legacy.pdf',
        sourceExcerpt: '被保险人身故，本公司给付身故保险金。',
      }],
      internalIndicatorChecks: [{
        liability: '身故保险金',
        basisKey: 'basic_amount',
        calculationKey: 'basic_amount',
        calculationEligible: true,
        calculationStatus: 'calculable',
        calculationReason: '按基本保险金额给付。',
        indicatorCheckStatus: 'accepted_manual_review',
      }],
    }]);

    const result = importReviewedResponsibilityArtifacts({ artifacts: [artifactPath] });

    assert.equal(result.ok, true);
    assert.equal(result.acceptedResponsibilities, 1);
  });
});

test('rejects empty responsibilities instead of returning a zero-count success', () => {
  withTempDir((dir) => {
    const artifactPath = path.join(dir, 'empty.jsonl');
    writeJsonl(artifactPath, [{
      company: '示例人寿',
      productName: '空责任产品',
      responsibilities: [],
      productIdentity: { sourceUrl: 'https://example.com/empty.pdf' },
    }]);

    const result = importReviewedResponsibilityArtifacts({ artifacts: [artifactPath] });

    assert.equal(result.ok, false);
    assert.equal(result.acceptedResponsibilities, 0);
    assert.deepEqual(result.validationFailures[0].issues, ['empty_responsibilities']);
  });
});

test('rejects duplicate IDs, missing title/source, and responsibility count mismatch', () => {
  withTempDir((dir) => {
    const artifactPath = path.join(dir, 'invalid-artifact.json');
    const indexPath = path.join(dir, 'invalid-index.jsonl');
    fs.writeFileSync(artifactPath, JSON.stringify({
      company: '示例人寿',
      productName: '问题产品',
      responsibilities: [
        unifiedResponsibility({ responsibilityId: 'duplicate' }),
        unifiedResponsibility({
          responsibilityId: 'duplicate',
          liability: '',
          sourceExcerpt: '',
          card: { title: '', customerSummary: '摘要' },
          evidenceSegments: [],
        }),
      ],
    }));
    writeJsonl(indexPath, [{ artifactPath, responsibilityCount: 3 }]);

    const result = importReviewedResponsibilityArtifacts({ artifacts: [indexPath] });
    const issues = result.validationFailures[0].issues;

    assert.equal(result.ok, false);
    assert.equal(result.acceptedResponsibilities, 0);
    assert.ok(issues.includes('duplicate_responsibility_id:duplicate'));
    assert.ok(issues.includes('responsibility_count_mismatch:expected=3:actual=2'));
    assert.ok(issues.includes('accepted_missing_title'));
    assert.ok(issues.includes('accepted_missing_sourceUrl:'));
    assert.ok(issues.includes('accepted_missing_sourceExcerpt:'));
  });
});

test('dry-run never creates or changes the configured SQLite file', () => {
  withTempDir((dir) => {
    const artifactPath = path.join(dir, 'artifact.jsonl');
    const dbPath = path.join(dir, 'sentinel.sqlite');
    const sentinel = Buffer.from('not-a-database-and-must-not-change');
    fs.writeFileSync(dbPath, sentinel);
    writeJsonl(artifactPath, [{
      company: '示例人寿',
      productName: '只读验证产品',
      productIdentity: { sourceUrl: 'https://example.com/policy.pdf' },
      responsibilities: [unifiedResponsibility()],
    }]);

    const result = importReviewedResponsibilityArtifacts({
      artifacts: [artifactPath],
      dbPath,
      write: false,
    });

    assert.equal(result.dryRun, true);
    assert.deepEqual(fs.readFileSync(dbPath), sentinel);
  });
});
