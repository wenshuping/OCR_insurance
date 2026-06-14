import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  auditDurableDataPersistence,
  auditExecutionPoints,
  auditFeatureTestGate,
  auditHighRiskScriptDefaults,
  auditOptionalResponsibilityDatabase,
  auditRouteSqlPersistence,
  auditSensitivePathChanges,
  parseGitStatus,
  patternMatches,
} from '../scripts/harness-audit.mjs';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'policy-ocr-harness-audit-'));
}

async function writeFile(root, filePath, content = '') {
  const absolutePath = path.join(root, filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, 'utf8');
}

async function makeHarnessRoot({ checkInvokesAudit = true } = {}) {
  const root = await makeTempDir();
  await writeFile(root, 'package.json', JSON.stringify({
    scripts: {
      check: 'node --check server/*.mjs',
      typecheck: 'tsc --noEmit',
      test: 'node --test ./tests/*.test.mjs',
      build: 'vite build',
    },
  }));
  await writeFile(root, 'scripts/check.sh', checkInvokesAudit
    ? '#!/bin/sh\nnode scripts/harness-audit.mjs\nnpm run check\n'
    : '#!/bin/sh\nnpm run check\n');
  await writeFile(root, 'scripts/test.sh', '#!/bin/sh\nnpm test\n');
  await writeFile(root, 'scripts/dev.sh', '#!/bin/sh\nnpm run local:dev\n');
  await writeFile(root, 'scripts/harness-audit.mjs', '');
  await writeFile(root, 'docs/harness-test-map.json', '[]\n');
  await writeFile(root, 'tests/policy-ocr-mapping.test.mjs', '');
  await writeFile(root, 'tests/policy-optional-responsibility.test.mjs', '');
  await writeFile(root, 'tests/optional-responsibility-governance.test.mjs', '');
  await writeFile(root, 'tests/customer-policy-form.test.mjs', '');
  await writeFile(root, 'tests/policy-ocr-flow.test.mjs', '');
  return root;
}

test('parseGitStatus normalizes changed and renamed paths', () => {
  const entries = parseGitStatus(' M scripts/check.sh\nR  old name.mjs -> scripts/harness-audit.mjs\n?? docs/harness-test-map.json\n');
  assert.deepEqual(entries.map((entry) => entry.path), [
    'scripts/check.sh',
    'scripts/harness-audit.mjs',
    'docs/harness-test-map.json',
  ]);
});

test('sensitive path audit fails production paths and allows development runtime paths', () => {
  const report = auditSensitivePathChanges([
    { path: '.env.local' },
    { path: '.runtime/policy-ocr.sqlite' },
    { path: '.runtime/local/policy-ocr.sqlite' },
    { path: '.runtime/tmp/upload.bin' },
  ]);
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].detail, /\.env\.local/);
  assert.match(report.failed[0].detail, /\.runtime\/policy-ocr\.sqlite/);
  assert.doesNotMatch(report.failed[0].detail, /\.runtime\/local\/policy-ocr\.sqlite/);
});

test('execution point audit fails when check.sh does not invoke harness audit', async () => {
  const root = await makeHarnessRoot({ checkInvokesAudit: false });
  const report = auditExecutionPoints({ projectRoot: root });
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].message, /scripts\/check\.sh/);
});

test('pattern matching supports recursive glob patterns', () => {
  assert.equal(patternMatches('ocr-service/**', 'ocr-service/scripts/parser.mjs'), true);
  assert.equal(patternMatches('src/features/*/index.ts', 'src/features/cashflow/index.ts'), true);
  assert.equal(patternMatches('src/features/*/index.ts', 'src/features/cashflow/pages/index.ts'), false);
});

test('feature test gate maps changed files, de-duplicates commands, and fails unmapped code', () => {
  const commands = [];
  const testMap = [
    {
      name: 'optional-responsibility',
      patterns: ['server/optional-responsibility-governance.mjs', 'tests/policy-optional-responsibility.test.mjs'],
      commands: [
        'node --test tests/policy-optional-responsibility.test.mjs',
        'node --test tests/policy-optional-responsibility.test.mjs',
      ],
    },
  ];

  const mapped = auditFeatureTestGate({
    changedFiles: ['server/optional-responsibility-governance.mjs', 'tests/policy-optional-responsibility.test.mjs'],
    testMap,
    executeCommand(command) {
      commands.push(command);
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(mapped.failed.length, 0);
  assert.deepEqual(commands, ['node --test tests/policy-optional-responsibility.test.mjs']);

  const unmapped = auditFeatureTestGate({
    changedFiles: ['server/unmapped-domain.mjs', 'docs/readme.md'],
    testMap,
    runCommands: false,
  });
  assert.equal(unmapped.failed.length, 1);
  assert.match(unmapped.failed[0].detail, /server\/unmapped-domain\.mjs/);
  assert.equal(unmapped.skipped.some((item) => item.message.includes('docs-only change')), true);
});

test('durable data audit fails crawler scripts without SQLite persistence', async () => {
  const root = await makeTempDir();
  await writeFile(root, 'scripts/crawl-demo-knowledge.mjs', `
import fs from 'node:fs';

const statePath = '.runtime/state.json';
const records = [{ company: '示例保险', productName: '示例产品' }];
fs.writeFileSync(statePath, JSON.stringify({ knowledgeRecords: records }));
console.log(JSON.stringify({ ok: true, records }));
`);

  const report = auditDurableDataPersistence({
    projectRoot: root,
    changedFiles: ['scripts/crawl-demo-knowledge.mjs'],
  });
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].detail, /no SQLite write evidence/);
  assert.match(report.failed[0].detail, /temporary JSON\/CSV\/NDJSON\/state files/);
});

test('durable data audit passes crawler scripts with SQLite persistence evidence', async () => {
  const root = await makeTempDir();
  await writeFile(root, 'scripts/crawl-demo-knowledge.mjs', `
import { createKnowledgeStateStore } from './runtime-knowledge-state.mjs';
import { upsertKnowledgeRecords } from '../server/policy-knowledge.service.mjs';

const knowledgeStore = await createKnowledgeStateStore();
try {
  const state = knowledgeStore.loadState();
  const saved = upsertKnowledgeRecords(state, [{ company: '示例保险', productName: '示例产品' }]);
  knowledgeStore.saveState(state);
  console.log(JSON.stringify({ ok: true, savedRecordCount: saved.length, dbPath: knowledgeStore.dbPath }));
} finally {
  knowledgeStore.close();
}
`);

  const report = auditDurableDataPersistence({
    projectRoot: root,
    changedFiles: ['scripts/crawl-demo-knowledge.mjs'],
  });
  assert.equal(report.failed.length, 0);
  assert.equal(report.passed.length, 1);
});

test('route SQL persistence audit fails new full-state persist calls', async () => {
  const root = await makeTempDir();
  await writeFile(root, 'server/routes/policies.routes.mjs', `
export function createPolicyRoutes({ state, persist }) {
  return async function handler(policy) {
    state.policies.push(policy);
    await persist(state);
  };
}
`);
  const report = auditRouteSqlPersistence({
    projectRoot: root,
    changedEntries: [{ path: 'server/routes/policies.routes.mjs', status: ' M' }],
  });
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].detail, /server\/routes\/policies\.routes\.mjs:\d+/);
  assert.match(report.failed[0].detail, /await persist\(state\)/);
});

test('route SQL persistence audit fails granular persister fallback paths', async () => {
  const root = await makeTempDir();
  await writeFile(root, 'server/routes/policies.routes.mjs', `
export function createPolicyRoutes({ state, persist, persistPendingScan }) {
  return async function handler(guestId) {
    if (persistPendingScan) {
      await persistPendingScan({ guestId });
    } else {
      await persist(state);
    }
  };
}
`);
  const report = auditRouteSqlPersistence({
    projectRoot: root,
    changedEntries: [{ path: 'server/routes/policies.routes.mjs', status: ' M' }],
  });
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].detail, /await persist\(state\)/);
});

test('route SQL persistence audit allows granular persister calls', async () => {
  const root = await makeTempDir();
  await writeFile(root, 'server/routes/policies.routes.mjs', `
export function createPolicyRoutes({ persistPendingScan }) {
  return async function handler(guestId) {
    await persistPendingScan({ guestId });
  };
}
`);
  const report = auditRouteSqlPersistence({
    projectRoot: root,
    changedEntries: [{ path: 'server/routes/policies.routes.mjs', status: ' M' }],
  });
  assert.equal(report.failed.length, 0);
  assert.equal(report.passed.length, 1);
});

test('route SQL persistence audit scans untracked route modules', async () => {
  const root = await makeTempDir();
  await writeFile(root, 'server/routes/new-user.routes.mjs', `
export function createNewUserRoutes({ state, persist }) {
  return async function handler() {
    await persist(state);
  };
}
`);
  const report = auditRouteSqlPersistence({
    projectRoot: root,
    changedEntries: [{ path: 'server/routes/new-user.routes.mjs', status: '??' }],
  });
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].detail, /new-user\.routes\.mjs/);
});

test('optional responsibility DB audit skips a missing development DB', async () => {
  const root = await makeTempDir();
  const report = auditOptionalResponsibilityDatabase({ dbPath: path.join(root, 'missing.sqlite') });
  assert.equal(report.failed.length, 0);
  assert.equal(report.skipped.length, 1);
  assert.match(report.skipped[0].message, /not found/);
});

test('optional responsibility DB audit finds duplicate rows, blank excerpts, clause names, and broken links', async () => {
  const root = await makeTempDir();
  const dbPath = path.join(root, 'policy-ocr.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE optional_responsibility_records (
      id TEXT PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      liability TEXT,
      payload TEXT
    );
    CREATE TABLE insurance_indicator_records (
      id TEXT PRIMARY KEY,
      payload TEXT
    );
  `);
  const insertOptional = db.prepare(`
    INSERT INTO optional_responsibility_records (id, company, product_name, liability, payload)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertOptional.run('opt_1', '新华保险', '多倍保障重大疾病保险（智享版）', '可选责任一', JSON.stringify({ sourceExcerpt: '官方条款' }));
  insertOptional.run('opt_2', '新华保险', '多倍保障重大疾病保险（智享版）', '可选责任一', JSON.stringify({ sourceExcerpt: '重复条款' }));
  insertOptional.run('opt_3', '新华保险', '确定，在本合同', '可选责任二', JSON.stringify({ sourceExcerpt: '' }));
  db.prepare('INSERT INTO insurance_indicator_records (id, payload) VALUES (?, ?)').run(
    'ind_1',
    JSON.stringify({ optionalResponsibilityId: 'missing_opt' }),
  );
  db.close();

  const report = auditOptionalResponsibilityDatabase({ dbPath });
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].detail, /duplicate optional responsibility/);
  assert.match(report.failed[0].detail, /blank optional responsibility sourceExcerpt/);
  assert.match(report.failed[0].detail, /clause fragment product name/);
  assert.match(report.failed[0].detail, /broken optional responsibility link/);
});

test('high-risk script default audit warns about production SQLite defaults', async () => {
  const root = await makeTempDir();
  await writeFile(root, 'scripts/repair.mjs', "const dbPath = path.join(runtimeDir, 'policy-ocr.sqlite');\n");
  const report = auditHighRiskScriptDefaults({ projectRoot: root });
  assert.equal(report.failed.length, 0);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0].detail, /scripts\/repair\.mjs/);
});
