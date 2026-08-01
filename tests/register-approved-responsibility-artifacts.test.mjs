import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { registerApprovedResponsibilityArtifacts } from '../scripts/register-approved-responsibility-artifacts.mjs';

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approved-artifact-register-'));
  try { return run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function setupDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE product_responsibility_artifacts (
      id TEXT PRIMARY KEY, company TEXT NOT NULL, product_name TEXT NOT NULL,
      source_digest TEXT NOT NULL, source_url TEXT, published_at TEXT NOT NULL,
      publisher_version TEXT NOT NULL, payload TEXT NOT NULL
    );
  `);
  db.close();
}

function artifact() {
  return {
    company: '示例人寿保险有限公司',
    productName: '示例终身寿险',
    productIdentity: { sourceDigest: `sha256:${'a'.repeat(64)}`, sourceUrl: 'https://example.com/policy.pdf' },
    responsibilities: [{ liability: '身故保险金' }],
  };
}

test('dry-run does not write and write is idempotent', () => {
  withTempDir((dir) => {
    const dbPath = path.join(dir, 'db.sqlite');
    const artifactPath = path.join(dir, 'artifact.json');
    fs.writeFileSync(artifactPath, JSON.stringify(artifact()));
    setupDb(dbPath);

    const dryRun = registerApprovedResponsibilityArtifacts({ artifacts: [artifactPath], dbPath });
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.dryRun, true);

    const first = registerApprovedResponsibilityArtifacts({ artifacts: [artifactPath], dbPath, write: true });
    const second = registerApprovedResponsibilityArtifacts({ artifacts: [artifactPath], dbPath, write: true });
    assert.equal(first.inserted.length, 1);
    assert.equal(second.inserted.length, 0);
    assert.equal(second.skipped.length, 1);
  });
});

test('rejects a conflicting existing digest', () => {
  withTempDir((dir) => {
    const dbPath = path.join(dir, 'db.sqlite');
    const artifactPath = path.join(dir, 'artifact.json');
    fs.writeFileSync(artifactPath, JSON.stringify(artifact()));
    setupDb(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare(`INSERT INTO product_responsibility_artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('other-id', '其他公司', '其他产品', `sha256:${'a'.repeat(64)}`, 'https://other.example/policy.pdf', 'now', 'test', '{}');
    db.close();
    const result = registerApprovedResponsibilityArtifacts({ artifacts: [artifactPath], dbPath, write: true });
    assert.equal(result.ok, false);
    assert.equal(result.conflicts.length, 1);
  });
});
