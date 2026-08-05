import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const targetModuleUrl = new URL('../server/policy-ocr-database-target.mjs', import.meta.url);

async function loadResolver() {
  const targetModule = await import(targetModuleUrl).catch(() => ({}));
  assert.equal(
    typeof targetModule.resolvePolicyOcrWriteDatabasePath,
    'function',
    'database target resolver must exist',
  );
  return targetModule.resolvePolicyOcrWriteDatabasePath;
}

function createDatabaseLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-ocr-db-target-'));
  const projectRoot = path.join(root, 'project');
  const legacyRuntimeDir = path.join(root, 'legacy-runtime');
  const ssdDbPath = path.join(root, 'ssd', 'policy-ocr.sqlite');
  const productionDbPath = path.join(projectRoot, '.runtime', 'policy-ocr.sqlite');

  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(legacyRuntimeDir, { recursive: true });
  fs.mkdirSync(path.dirname(ssdDbPath), { recursive: true });
  fs.mkdirSync(path.dirname(productionDbPath), { recursive: true });
  fs.writeFileSync(path.join(legacyRuntimeDir, 'policy-ocr.sqlite'), '');
  fs.writeFileSync(ssdDbPath, '');
  fs.writeFileSync(productionDbPath, '');
  fs.writeFileSync(path.join(legacyRuntimeDir, 'policy-ocr-env.json'), JSON.stringify({
    POLICY_OCR_APP_DB_PATH: ssdDbPath,
  }));
  fs.symlinkSync(legacyRuntimeDir, path.join(projectRoot, '.runtime', 'local'));

  return {
    root,
    projectRoot,
    legacyDbPath: path.join(projectRoot, '.runtime', 'local', 'policy-ocr.sqlite'),
    productionDbPath,
    ssdDbPath,
  };
}

test('development writes resolve to the configured SSD database', async (t) => {
  const layout = createDatabaseLayout();
  t.after(() => fs.rmSync(layout.root, { recursive: true, force: true }));
  const resolveDatabasePath = await loadResolver();

  assert.equal(
    resolveDatabasePath({ projectRoot: layout.projectRoot, profile: 'dev', env: {} }),
    fs.realpathSync(layout.ssdDbPath),
  );
});

test('development writes reject the legacy local database even through a symlink', async (t) => {
  const layout = createDatabaseLayout();
  t.after(() => fs.rmSync(layout.root, { recursive: true, force: true }));
  const resolveDatabasePath = await loadResolver();

  assert.throws(
    () => resolveDatabasePath({
      projectRoot: layout.projectRoot,
      profile: 'dev',
      requestedPath: layout.legacyDbPath,
      env: {},
    }),
    (error) => error?.code === 'POLICY_OCR_LEGACY_DATABASE_TARGET',
  );
});

test('development writes reject a database different from the configured SSD target', async (t) => {
  const layout = createDatabaseLayout();
  t.after(() => fs.rmSync(layout.root, { recursive: true, force: true }));
  const otherDbPath = path.join(layout.root, 'other', 'policy-ocr.sqlite');
  fs.mkdirSync(path.dirname(otherDbPath), { recursive: true });
  fs.writeFileSync(otherDbPath, '');
  const resolveDatabasePath = await loadResolver();

  assert.throws(
    () => resolveDatabasePath({
      projectRoot: layout.projectRoot,
      profile: 'dev',
      requestedPath: otherDbPath,
      env: {},
    }),
    (error) => error?.code === 'POLICY_OCR_DEVELOPMENT_DATABASE_MISMATCH',
  );
});

test('shared SQLite state store refuses the checkout legacy database path', async () => {
  const projectRoot = path.resolve(path.dirname(new URL('../package.json', import.meta.url).pathname));
  const legacyDbPath = path.join(projectRoot, '.runtime', 'local', 'policy-ocr.sqlite');
  const { createSqliteStateStore } = await import('../server/sqlite-state-store.mjs');

  await assert.rejects(
    createSqliteStateStore({ dbPath: legacyDbPath }),
    (error) => error?.code === 'POLICY_OCR_LEGACY_DATABASE_TARGET',
  );
});

test('shared SQLite state store keeps explicit in-memory databases isolated', async () => {
  const { createSqliteStateStore } = await import('../server/sqlite-state-store.mjs');
  const first = await createSqliteStateStore({ dbPath: ':memory:' });
  const second = await createSqliteStateStore({ dbPath: ':memory:' });
  try {
    await first.appendAgentUnknownQuestion({ userId: 1, messageRef: 'first', question: 'first', actor: 'test' });
    assert.equal((await first.listAgentUnknownQuestions()).total, 1);
    assert.equal((await second.listAgentUnknownQuestions()).total, 0);
  } finally {
    first.close();
    second.close();
  }
});

test('production writes resolve to the production database', async (t) => {
  const layout = createDatabaseLayout();
  t.after(() => fs.rmSync(layout.root, { recursive: true, force: true }));
  const resolveDatabasePath = await loadResolver();

  assert.equal(
    resolveDatabasePath({ projectRoot: layout.projectRoot, profile: 'prod', env: {} }),
    fs.realpathSync(layout.productionDbPath),
  );
});

test('production env database path is not mistaken for the development SSD target', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-ocr-prod-db-target-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  const productionDbPath = path.join(root, 'data', 'policy-ocr.sqlite');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(path.dirname(productionDbPath), { recursive: true });
  fs.writeFileSync(productionDbPath, '');
  const resolveDatabasePath = await loadResolver();

  assert.equal(
    resolveDatabasePath({
      projectRoot,
      profile: 'prod',
      env: { POLICY_OCR_APP_DB_PATH: productionDbPath },
    }),
    fs.realpathSync(productionDbPath),
  );
});

test('production writes reject the configured development SSD database', async (t) => {
  const layout = createDatabaseLayout();
  t.after(() => fs.rmSync(layout.root, { recursive: true, force: true }));
  const resolveDatabasePath = await loadResolver();

  assert.throws(
    () => resolveDatabasePath({
      projectRoot: layout.projectRoot,
      profile: 'prod',
      requestedPath: layout.ssdDbPath,
      env: {},
    }),
    (error) => error?.code === 'POLICY_OCR_PRODUCTION_DATABASE_MISMATCH',
  );
});

test('direct development API command does not hard-code the legacy local database', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(packageJson.scripts['dev:api'], /POLICY_OCR_APP_DB_PATH=\.runtime\/local\/policy-ocr\.sqlite/u);
});

test('artifact publication entry points use the shared database target resolver', () => {
  const sources = [
    '../server/index.mjs',
    '../scripts/import-reviewed-responsibility-artifacts.mjs',
    '../scripts/reconcile-approved-responsibility-products.mjs',
    '../scripts/backfill-cashflow.mjs',
    '../scripts/backfill-basic-indicators-from-responsibility-cards.mjs',
    '../scripts/backfill-policy-derived-results.mjs',
    '../scripts/backfill-policy-summary-from-responsibility-cards.mjs',
    '../scripts/backfill-knowledge-responsibility-indicators.mjs',
    '../scripts/backfill-optional-responsibility-governance.mjs',
    '../scripts/backfill-payout-method-indicators.mjs',
    '../scripts/backfill-product-customer-responsibility-summaries.mjs',
    '../scripts/audit-indicator-computability.mjs',
    '../scripts/fix-cashflow-indicators.mjs',
    '../scripts/insurance-indicator-quality-governance.mjs',
    '../scripts/materialize-product-responsibility-cards.mjs',
    '../scripts/migrate-old-runtime-extra-products-to-dev.mjs',
    '../scripts/quantify-new-optional-responsibility-indicators.mjs',
    '../scripts/quantify-remaining-optional-responsibility-indicators.mjs',
    '../scripts/refill-no-indicator-official-pdf-text.mjs',
    '../scripts/refill-pending-optional-responsibility-sources.mjs',
    '../scripts/regenerate-family-sales-reviews.mjs',
    '../scripts/repair-indicator-remaining-governance.mjs',
    '../scripts/repair-indicator-source-governance.mjs',
    '../scripts/repair-pending-optional-responsibility-indicators.mjs',
    '../scripts/repair-zhonghua-jianle-zhenbei-2025.mjs',
    '../scripts/runtime-knowledge-state.mjs',
    '../scripts/sync-dev-db-from-prod.mjs',
    '../scripts/sync-insurance-indicators.mjs',
    '../scripts/sync-state-knowledge-indicators-to-sqlite.mjs',
    '../.agents/skills/ocr-insurance-product-responsibility-pipeline/scripts/publish_development_artifact.mjs',
  ].map((relativePath) => fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
  for (const source of sources) {
    assert.match(source, /resolvePolicyOcrWriteDatabasePath/u);
  }

  const batchSource = fs.readFileSync(
    new URL('../.agents/skills/ocr-insurance-product-responsibility-pipeline/scripts/batch_deepseek_backfill.py', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(batchSource, /default=Path\("\.runtime\/local\/policy-ocr\.sqlite"\)/u);
});
