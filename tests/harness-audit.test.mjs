import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  auditDurableDataPersistence,
  auditDevelopmentDatabaseBinding,
  auditDevelopmentProcessOwnership,
  auditDevelopmentSourceOwnership,
  auditExecutionPoints,
  auditFeatureTestGate,
  auditAgentSkillOrchestrationHarness,
  auditHighRiskScriptDefaults,
  auditOptionalResponsibilityDatabase,
  auditProductIdentityMatchGate,
  auditRouteSqlPersistence,
  auditSemanticAgentFlowHarness,
  auditSensitivePathChanges,
  parseGitStatus,
  patternMatches,
} from '../scripts/harness-audit.mjs';
import { auditProductIdentityMatching, matchProductIdentity } from '../scripts/product-identity-harness.mjs';

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
  await writeFile(root, 'scripts/integration-harness-audit.mjs', '');
  await writeFile(root, 'scripts/create-integration-manifest.mjs', '');
  await writeFile(root, 'docs/harness-test-map.json', '[]\n');
  await writeFile(root, 'docs/integration-harness.json', '{}\n');
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

test('product identity matching is key-first and does not fall back across keys', () => {
  assert.equal(matchProductIdentity(
    { canonicalProductId: 'product-a', company: '甲', productName: '同名产品', sourceDigest: 'digest-a' },
    { canonicalProductId: 'product-a', company: '甲', productName: '不同名称', sourceDigest: 'digest-b' },
  ), true);
  assert.equal(matchProductIdentity(
    { canonicalProductId: 'product-a', company: '甲', productName: '同名产品', sourceDigest: 'digest-a' },
    { canonicalProductId: 'product-b', company: '甲', productName: '同名产品', sourceDigest: 'digest-a' },
  ), false);
});

test('legacy identity fallback requires exact official source or version and product name', () => {
  const base = { company: '甲', productName: '同名产品' };
  assert.equal(matchProductIdentity({ ...base, sourceDigest: 'digest-a' }, { ...base, sourceDigest: 'digest-a' }), true);
  assert.equal(matchProductIdentity({ ...base, sourceUrl: 'https://official.test/a.pdf' }, { ...base, sourceUrl: 'https://official.test/a.pdf' }), true);
  assert.equal(matchProductIdentity({ ...base, publisherVersion: '2025-01' }, { ...base, publisherVersion: '2025-01' }), true);
  assert.equal(matchProductIdentity(base, { ...base, sourceDigest: 'digest-a' }), false);
  assert.equal(matchProductIdentity({ ...base, sourceDigest: 'digest-a' }, { ...base, sourceDigest: 'digest-b' }), false);
});

test('product identity harness rejects name-only matching and accepts guarded legacy matching', () => {
  const bad = auditProductIdentityMatching({
    projectRoot: '/repo',
    changedFiles: ['server/example-product-matcher.mjs'],
    readFile: () => 'SELECT * FROM product_responsibility_cards WHERE company = ? AND product_name = ?',
  });
  assert.equal(bad.ok, false);

  const good = auditProductIdentityMatching({
    projectRoot: '/repo',
    changedFiles: ['scripts/legacy-product-matcher.mjs'],
    readFile: () => 'legacy missing key: productKey canonicalProductId sourceDigest sourceUrl publisherVersion; WHERE company = ? AND product_name = ?',
  });
  assert.equal(good.ok, true);
});

test('harness report exposes the product identity match gate', () => {
  const report = auditProductIdentityMatchGate({
    projectRoot: '/repo',
    changedFiles: [],
  });
  assert.equal(report.failed.length, 0);
  assert.equal(report.passed.length, 1);
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

test('development source ownership audit fails from a non-owning worktree', () => {
  const report = auditDevelopmentSourceOwnership({
    projectRoot: '/repo/non-owner',
    runtimeDir: '/runtime/local',
    realpath: (value) => value,
    readSourceOwner: () => '/repo/dev-owner',
  });
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].detail, /current worktree: \/repo\/non-owner/u);
  assert.match(report.failed[0].detail, /development source owner: \/repo\/dev-owner/u);
});

test('development source ownership audit passes for the owning worktree and skips before first start', () => {
  const passed = auditDevelopmentSourceOwnership({
    projectRoot: '/repo/dev-owner',
    runtimeDir: '/runtime/local',
    realpath: (value) => value,
    readSourceOwner: () => '/repo/dev-owner',
  });
  assert.equal(passed.failed.length, 0);
  assert.equal(passed.passed.length, 1);

  const skipped = auditDevelopmentSourceOwnership({
    projectRoot: '/repo/new',
    runtimeDir: '/runtime/local',
    realpath: (value) => value,
    readSourceOwner: () => '',
  });
  assert.equal(skipped.failed.length, 0);
  assert.equal(skipped.skipped.length, 1);
});

test('development process ownership audit accepts listeners managed by the bound worktree', () => {
  const report = auditDevelopmentProcessOwnership({
    runtimeDir: '/runtime/local',
    readSourceOwner: () => '/repo/dev-owner',
    realpath: (value) => value,
    servicePorts: [{ name: 'api', label: 'API 服务', port: 4207 }],
    readManagedPid: () => 101,
    findListeners: () => [101],
    readCwd: () => '/repo/dev-owner',
  });
  assert.equal(report.failed.length, 0);
  assert.equal(report.passed.length, 1);
});

test('development process ownership audit rejects unmanaged listeners and listeners from another worktree', () => {
  const unmanaged = auditDevelopmentProcessOwnership({
    runtimeDir: '/runtime/local',
    readSourceOwner: () => '/repo/dev-owner',
    realpath: (value) => value,
    servicePorts: [{ name: 'web', label: '前端页面', port: 3014 }],
    readManagedPid: () => 0,
    findListeners: () => [202],
    readCwd: () => '/repo/dev-owner',
  });
  assert.equal(unmanaged.failed.length, 1);
  assert.match(unmanaged.failed[0].message, /not managed/u);

  const wrongWorktree = auditDevelopmentProcessOwnership({
    runtimeDir: '/runtime/local',
    readSourceOwner: () => '/repo/dev-owner',
    realpath: (value) => value,
    servicePorts: [{ name: 'api', label: 'API 服务', port: 4207 }],
    readManagedPid: () => 101,
    findListeners: () => [101],
    readCwd: () => '/repo/other-worktree',
  });
  assert.equal(wrongWorktree.failed.length, 1);
  assert.match(wrongWorktree.failed[0].message, /different worktree/u);
});

test('development database binding audit requires the configured database and matches the API process', () => {
  const matching = auditDevelopmentDatabaseBinding({
    runtimeDir: '/runtime/local',
    realpath: (value) => value,
    readConfiguredPath: () => '/ssd/policy-ocr.sqlite',
    pathExists: () => true,
    readManagedPid: () => 101,
    readProcessEnv: () => '/ssd/policy-ocr.sqlite',
  });
  assert.equal(matching.failed.length, 0);
  assert.equal(matching.passed.length, 1);

  const mismatch = auditDevelopmentDatabaseBinding({
    runtimeDir: '/runtime/local',
    realpath: (value) => value,
    readConfiguredPath: () => '/ssd/policy-ocr.sqlite',
    pathExists: () => true,
    readManagedPid: () => 101,
    readProcessEnv: () => '/repo/.runtime/local/policy-ocr.sqlite',
  });
  assert.equal(mismatch.failed.length, 1);
  assert.match(mismatch.failed[0].message, /different database/u);
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

test('feature test gate maps Skill files instead of treating them as generated output', () => {
  const mapped = auditFeatureTestGate({
    changedFiles: ['.agents/skills/ocr-insurance-universal-account-responsibility/SKILL.md'],
    testMap: [{
      name: 'skill-integrity',
      patterns: ['.agents/skills/**'],
      commands: ['node --test tests/integration-harness-audit.test.mjs'],
    }],
    runCommands: false,
  });
  assert.equal(mapped.failed.length, 0);
  assert.deepEqual(mapped.skipped.map((item) => item.message), [
    'focused test execution skipped',
  ]);
});

test('semantic Agent flow harness fails when the DingTalk conversation path is not fully mapped', () => {
  const report = auditSemanticAgentFlowHarness({
    testMap: [{
      name: 'hermes-question-routing',
      patterns: ['server/agent-question-router.service.mjs'],
      commands: ['node --test tests/agent-question-router.test.mjs'],
    }],
  });
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].detail, /server\/agent-conversation-runtime\.service\.mjs/);
  assert.match(report.failed[0].detail, /tests\/dingtalk-agent-gateway\.test\.mjs/);
});

test('semantic Agent flow harness passes when the current DingTalk conversation path is mapped', () => {
  const report = auditSemanticAgentFlowHarness({
    testMap: [{
      name: 'hermes-question-routing',
      patterns: [
        'server/hermes-conversation-client.service.mjs',
        'server/agent-question-interpreter.service.mjs',
        'server/agent-conversation-runtime.service.mjs',
        'server/agent-conversation-context.service.mjs',
        'server/dingtalk-agent-gateway.mjs',
        'server/dingtalk-agent-gateway.service.mjs',
        'server/agent-question-router.service.mjs',
        'server/agent-question-handlers.service.mjs',
        'server/agent-product-knowledge.service.mjs',
        'server/routes/agent.routes.mjs',
        'tests/agent-question-interpreter.test.mjs',
        'tests/agent-conversation-runtime.test.mjs',
        'tests/agent-conversation-context.test.mjs',
        'tests/dingtalk-agent-gateway.test.mjs',
        'tests/agent-question-router.test.mjs',
        'tests/agent-question-handlers.test.mjs',
        'tests/agent-product-knowledge.test.mjs',
        'tests/agent-question-routes.test.mjs',
      ],
      commands: [
        'node --test tests/agent-question-interpreter.test.mjs',
        'node --test tests/agent-conversation-runtime.test.mjs',
        'node --test tests/agent-conversation-context.test.mjs',
        'node --test tests/dingtalk-agent-gateway.test.mjs',
        'node --test tests/agent-question-router.test.mjs',
        'node --test tests/agent-question-handlers.test.mjs',
        'node --test tests/agent-product-knowledge.test.mjs',
        'node --test tests/agent-question-routes.test.mjs',
      ],
    }],
  });
  assert.equal(report.failed.length, 0);
  assert.equal(report.passed.length, 1);
});

test('Agent skill orchestration harness fails unless insurance expert and sales champion mappings are complete', () => {
  const report = auditAgentSkillOrchestrationHarness({
    testMap: [{
      name: 'insurance-expert-skill-orchestration',
      patterns: ['server/agent-product-knowledge.service.mjs'],
      commands: ['node --test tests/agent-product-knowledge.test.mjs'],
    }],
  });
  assert.equal(report.failed.length, 2);
  assert.match(report.failed[0].detail, /server\/responsibility-planner\.service\.mjs/);
  assert.match(report.failed[1].message, /sales-champion-skill-orchestration/);
});

test('Agent skill orchestration harness passes when both skill-based agent paths are mapped', () => {
  const report = auditAgentSkillOrchestrationHarness({
    testMap: [
      {
        name: 'insurance-expert-skill-orchestration',
        patterns: [
          'server/insurance-expert-skill-registry.service.mjs',
          'server/insurance-expert-skill-router.service.mjs',
          'server/agent-product-knowledge.service.mjs',
          'server/product-customer-responsibility-summary.service.mjs',
          'server/responsibility-planner.service.mjs',
          'server/responsibility-summary-templates.mjs',
          'server/responsibility-source-resolver.mjs',
          'server/responsibility-summary-quality-gate.mjs',
          'server/responsibility-card-standardizer.mjs',
          'tests/insurance-expert-skill-router.test.mjs',
          'tests/agent-product-knowledge.test.mjs',
          'tests/product-customer-responsibility-summary.test.mjs',
          'tests/responsibility-planner-service.test.mjs',
          'tests/responsibility-summary-templates.test.mjs',
          'tests/responsibility-source-resolver.test.mjs',
          'tests/responsibility-summary-quality-gate.test.mjs',
          'tests/responsibility-card-standardizer.test.mjs',
        ],
        commands: [
          'node --test tests/insurance-expert-skill-router.test.mjs',
          'node --test tests/agent-product-knowledge.test.mjs',
          'node --test tests/product-customer-responsibility-summary.test.mjs',
          'node --test tests/responsibility-planner-service.test.mjs',
          'node --test tests/responsibility-summary-templates.test.mjs',
          'node --test tests/responsibility-source-resolver.test.mjs',
          'node --test tests/responsibility-summary-quality-gate.test.mjs',
          'node --test tests/responsibility-card-standardizer.test.mjs',
        ],
      },
      {
        name: 'sales-champion-skill-orchestration',
        patterns: [
          'server/agent-skill-router.service.mjs',
          'server/family-sales-chat.service.mjs',
          'server/family-sales-review.service.mjs',
          'server/family-sales-memory.service.mjs',
          'server/sales-champion-turn.contract.mjs',
          'server/sales-champion-readiness.service.mjs',
          'server/sales-champion-skill-registry.mjs',
          'server/sales-champion-training-catalog.mjs',
          'server/sales-champion-router.service.mjs',
          'server/sales-champion-turn-interpreter.service.mjs',
          'tests/agent-skill-router.test.mjs',
          'tests/family-sales-review.test.mjs',
          'tests/family-sales-review-markdown.test.mjs',
          'tests/sales-champion-atomic-orchestration.test.mjs',
          'tests/sales-champion-turn-interpreter.test.mjs',
        ],
        commands: [
          'node --test tests/agent-skill-router.test.mjs',
          'node --test tests/family-sales-review.test.mjs',
          'node --test tests/family-sales-review-markdown.test.mjs',
          'node --test tests/sales-champion-atomic-orchestration.test.mjs',
          'node --test tests/sales-champion-turn-interpreter.test.mjs',
        ],
      },
    ],
  });
  assert.equal(report.failed.length, 0);
  assert.equal(report.passed.length, 2);
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
