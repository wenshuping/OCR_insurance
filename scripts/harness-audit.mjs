#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_TEST_MAP_PATH = 'docs/harness-test-map.json';
const DEFAULT_DEV_DB_PATH = '.runtime/local/policy-ocr.sqlite';

const REQUIRED_FILES = [
  'scripts/check.sh',
  'scripts/test.sh',
  'scripts/dev.sh',
  'scripts/harness-audit.mjs',
  DEFAULT_TEST_MAP_PATH,
  'tests/policy-ocr-mapping.test.mjs',
  'tests/policy-optional-responsibility.test.mjs',
  'tests/optional-responsibility-governance.test.mjs',
  'tests/customer-policy-form.test.mjs',
  'tests/policy-ocr-flow.test.mjs',
];

const REQUIRED_NPM_SCRIPTS = ['check', 'typecheck', 'test', 'build'];

const FEATURE_PATH_PREFIXES = ['server/', 'ocr-service/', 'src/', 'scripts/', 'tests/'];
const DOCUMENTATION_PREFIXES = ['docs/'];
const GENERATED_PREFIXES = ['node_modules/', 'dist/', 'build/', 'coverage/', 'graphify-out/', '.agents/'];
const GENERATED_EXACT_PATHS = new Set(['package-lock.json', 'skills-lock.json']);

function makeReport() {
  return {
    passed: [],
    failed: [],
    warnings: [],
    skipped: [],
  };
}

function add(report, bucket, check, message, detail = '') {
  report[bucket].push({ check, message, detail });
}

function mergeReport(target, source) {
  for (const bucket of ['passed', 'failed', 'warnings', 'skipped']) {
    target[bucket].push(...source[bucket]);
  }
  return target;
}

function normalizeProjectPath(filePath = '') {
  return String(filePath)
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function unquoteGitPath(filePath) {
  const trimmed = String(filePath || '').trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function parseGitStatus(output = '') {
  return String(output)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3);
      const renamedPath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath;
      return {
        status,
        path: normalizeProjectPath(unquoteGitPath(renamedPath)),
      };
    })
    .filter((entry) => entry.path);
}

function gitStatus(projectRoot) {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    return {
      entries: [],
      skipped: true,
      reason: result.error?.message || result.stderr?.trim() || 'git status failed',
    };
  }
  return {
    entries: parseGitStatus(result.stdout),
    skipped: false,
    reason: '',
  };
}

function isAllowedRuntimePath(filePath) {
  if (!filePath.startsWith('.runtime/')) return false;
  if (
    filePath.startsWith('.runtime/local/')
    || filePath.startsWith('.runtime/logs/')
    || filePath.startsWith('.runtime/pids/')
    || filePath.startsWith('.runtime/tmp/')
    || filePath.startsWith('.runtime/backups/')
  ) {
    return true;
  }
  return path.posix.basename(filePath).startsWith('test-');
}

function sensitiveReason(filePath) {
  if (filePath === '.env.local') return 'production/local-secret env file changed';
  if (filePath === '.runtime/policy-ocr.sqlite') return 'production SQLite database changed';
  if (filePath === '.runtime/policy-ocr-config.json') return 'production OCR config changed';
  if (filePath === '.runtime/sms-delivery-config.json') return 'production SMS config changed';
  if (!filePath.startsWith('.runtime/')) return '';
  if (isAllowedRuntimePath(filePath)) return '';

  const lower = filePath.toLowerCase();
  const basename = path.posix.basename(filePath);
  if (/^feishu-.*\.json$/.test(basename)) return 'production Feishu runtime file changed';
  if (lower.includes('secret')) return 'runtime secret file changed';
  if (lower.includes('credential')) return 'runtime credential file changed';
  if (lower.includes('token')) return 'runtime token file changed';
  return 'runtime path requires explicit review';
}

export function auditSensitivePathChanges(entries = []) {
  const report = makeReport();
  const failures = [];
  for (const entry of entries) {
    const filePath = normalizeProjectPath(entry.path);
    const reason = sensitiveReason(filePath);
    if (reason) failures.push(`${filePath}: ${reason}`);
  }

  if (failures.length) {
    add(report, 'failed', 'sensitive-paths', 'production-sensitive changes detected', failures.join('\n'));
  } else {
    add(report, 'passed', 'sensitive-paths', 'no production-sensitive file changes detected');
  }
  return report;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function auditExecutionPoints({ projectRoot = DEFAULT_PROJECT_ROOT } = {}) {
  const report = makeReport();
  const missingFiles = REQUIRED_FILES.filter((filePath) => !fs.existsSync(path.join(projectRoot, filePath)));
  if (missingFiles.length) {
    add(report, 'failed', 'execution-points', 'required harness files are missing', missingFiles.join('\n'));
  } else {
    add(report, 'passed', 'execution-points', 'required harness files exist');
  }

  const packagePath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(packagePath)) {
    add(report, 'failed', 'execution-points', 'package.json is missing');
  } else {
    const packageJson = readJsonFile(packagePath);
    const missingScripts = REQUIRED_NPM_SCRIPTS.filter((script) => !packageJson.scripts?.[script]);
    if (missingScripts.length) {
      add(report, 'failed', 'execution-points', 'required npm scripts are missing', missingScripts.join('\n'));
    } else {
      add(report, 'passed', 'execution-points', 'required npm scripts exist');
    }
  }

  const checkPath = path.join(projectRoot, 'scripts/check.sh');
  if (fs.existsSync(checkPath)) {
    const checkScript = fs.readFileSync(checkPath, 'utf8');
    if (checkScript.includes('scripts/harness-audit.mjs')) {
      add(report, 'passed', 'execution-points', 'scripts/check.sh invokes harness audit');
    } else {
      add(report, 'failed', 'execution-points', 'scripts/check.sh must invoke scripts/harness-audit.mjs');
    }
  }
  return report;
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

export function patternMatches(pattern, filePath) {
  const normalizedPattern = normalizeProjectPath(pattern);
  const normalizedPath = normalizeProjectPath(filePath);
  if (normalizedPattern === normalizedPath) return true;
  if (!normalizedPattern.includes('*')) return false;

  const token = '__DOUBLE_STAR__';
  const escaped = escapeRegExp(normalizedPattern.replaceAll('**', token)).replaceAll('*', '[^/]*');
  const regex = `^${escaped.replaceAll(token, '.*')}$`;
  return new RegExp(regex).test(normalizedPath);
}

function isDocumentationPath(filePath) {
  return DOCUMENTATION_PREFIXES.some((prefix) => filePath.startsWith(prefix)) && filePath !== DEFAULT_TEST_MAP_PATH;
}

function isGeneratedOrMetadataPath(filePath) {
  return GENERATED_EXACT_PATHS.has(filePath)
    || GENERATED_PREFIXES.some((prefix) => filePath.startsWith(prefix))
    || filePath.startsWith('.tmp-')
    || filePath.endsWith('.log');
}

function requiresFeatureMap(filePath) {
  if (isDocumentationPath(filePath) || isGeneratedOrMetadataPath(filePath)) return false;
  return FEATURE_PATH_PREFIXES.some((prefix) => filePath.startsWith(prefix))
    || filePath === DEFAULT_TEST_MAP_PATH
    || filePath === 'package.json';
}

function defaultExecuteCommand(command, projectRoot) {
  const result = spawnSync(command, {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 1024 * 1024 * 8,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function summarizeCommandOutput(stdout = '', stderr = '') {
  const output = `${stdout}\n${stderr}`.trim();
  if (!output) return '';
  const lines = output.split(/\r?\n/);
  return lines.slice(-30).join('\n');
}

export function auditFeatureTestGate({
  changedFiles = [],
  testMap = [],
  projectRoot = DEFAULT_PROJECT_ROOT,
  runCommands = true,
  executeCommand = defaultExecuteCommand,
} = {}) {
  const report = makeReport();
  const commands = new Set();
  const unmapped = [];
  const mappedFiles = [];

  for (const changedFile of changedFiles.map(normalizeProjectPath)) {
    if (!requiresFeatureMap(changedFile)) {
      if (isDocumentationPath(changedFile)) {
        add(report, 'skipped', 'feature-test-gate', `docs-only change does not need focused tests: ${changedFile}`);
      }
      continue;
    }

    const matchingEntries = testMap.filter((entry) => (
      Array.isArray(entry.patterns) && entry.patterns.some((pattern) => patternMatches(pattern, changedFile))
    ));
    if (!matchingEntries.length) {
      unmapped.push(changedFile);
      continue;
    }
    mappedFiles.push(changedFile);
    for (const entry of matchingEntries) {
      for (const command of entry.commands || []) commands.add(command);
    }
  }

  if (unmapped.length) {
    add(
      report,
      'failed',
      'feature-test-gate',
      'changed code files have no focused test mapping',
      unmapped.join('\n'),
    );
  }

  if (!mappedFiles.length && !unmapped.length) {
    add(report, 'skipped', 'feature-test-gate', 'no changed code files require focused tests');
  } else if (mappedFiles.length) {
    add(report, 'passed', 'feature-test-gate', 'changed code files mapped to focused tests', mappedFiles.join('\n'));
  }

  if (!commands.size) return report;
  if (!runCommands) {
    add(report, 'skipped', 'feature-test-gate', 'focused test execution skipped', [...commands].join('\n'));
    return report;
  }

  for (const command of commands) {
    const result = executeCommand(command, projectRoot);
    if (result.status === 0) {
      add(report, 'passed', 'feature-test-gate', `focused test passed: ${command}`);
    } else {
      add(
        report,
        'failed',
        'feature-test-gate',
        `focused test failed: ${command}`,
        summarizeCommandOutput(result.stdout, result.stderr),
      );
    }
  }
  return report;
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function text(value) {
  return String(value || '').trim();
}

function looksLikeClauseFragment(productName) {
  return productName.includes('确定，在本合同')
    || productName.includes('在本合同保险期间内不得变更')
    || productName === '确定，在本合同';
}

export function auditOptionalResponsibilityDatabase({
  dbPath = path.join(DEFAULT_PROJECT_ROOT, DEFAULT_DEV_DB_PATH),
  DatabaseClass = DatabaseSync,
} = {}) {
  const report = makeReport();
  if (!fs.existsSync(dbPath)) {
    add(report, 'skipped', 'optional-responsibility-db', `development database not found: ${dbPath}`);
    return report;
  }

  const db = new DatabaseClass(dbPath, { readOnly: true });
  try {
    if (!tableExists(db, 'optional_responsibility_records')) {
      add(report, 'skipped', 'optional-responsibility-db', 'optional_responsibility_records table is missing');
      return report;
    }

    const failures = [];
    const duplicateRows = db.prepare(`
      SELECT company, product_name, liability, COUNT(*) AS count, group_concat(id, ' | ') AS ids
      FROM optional_responsibility_records
      GROUP BY company, product_name, liability
      HAVING COUNT(*) > 1
      LIMIT 20
    `).all();
    for (const row of duplicateRows) {
      failures.push(`duplicate optional responsibility: ${row.company} / ${row.product_name} / ${row.liability} (${row.count}) ${row.ids}`);
    }

    const optionalRows = db.prepare('SELECT id, company, product_name, liability, payload FROM optional_responsibility_records').all();
    const optionalIds = new Set(optionalRows.map((row) => row.id));
    for (const row of optionalRows) {
      const payload = parseJsonObject(row.payload);
      const productName = text(row.product_name || payload.productName);
      if (looksLikeClauseFragment(productName)) {
        failures.push(`clause fragment product name: ${row.id} ${productName}`);
      }

      const sourceExcerpt = text(payload.sourceExcerpt || payload.source_excerpt);
      const quantificationStatus = text(payload.quantificationStatus || payload.quantification_status);
      if (!sourceExcerpt && quantificationStatus !== 'not_quantifiable') {
        failures.push(`blank optional responsibility sourceExcerpt: ${row.id} ${row.company} / ${row.product_name} / ${row.liability}`);
      }
      if (failures.length >= 40) break;
    }

    if (tableExists(db, 'insurance_indicator_records')) {
      const indicatorRows = db.prepare('SELECT id, payload FROM insurance_indicator_records').all();
      for (const row of indicatorRows) {
        const payload = parseJsonObject(row.payload);
        const optionalResponsibilityId = text(payload.optionalResponsibilityId);
        if (optionalResponsibilityId && !optionalIds.has(optionalResponsibilityId)) {
          failures.push(`broken optional responsibility link: ${row.id} -> ${optionalResponsibilityId}`);
        }
        if (failures.length >= 60) break;
      }
    } else {
      add(report, 'skipped', 'optional-responsibility-db', 'insurance_indicator_records table is missing');
    }

    if (failures.length) {
      add(report, 'failed', 'optional-responsibility-db', 'optional responsibility data issues detected', failures.join('\n'));
    } else {
      add(report, 'passed', 'optional-responsibility-db', 'optional responsibility development data passed read-only audit');
    }
  } finally {
    db.close();
  }
  return report;
}

function scriptLooksProductionDbDefault(content) {
  return content.includes("'.runtime/policy-ocr.sqlite'")
    || content.includes('".runtime/policy-ocr.sqlite"')
    || content.includes("'.runtime', 'policy-ocr.sqlite'")
    || content.includes('".runtime", "policy-ocr.sqlite"')
    || content.includes("runtimeDir, 'policy-ocr.sqlite'")
    || content.includes('runtimeDir, "policy-ocr.sqlite"')
    || content.includes("defaultRuntimeDir, 'policy-ocr.sqlite'")
    || content.includes('defaultRuntimeDir, "policy-ocr.sqlite"')
    || content.includes("prodRuntimeDir, 'policy-ocr.sqlite'")
    || content.includes('prodRuntimeDir, "policy-ocr.sqlite"');
}

export function auditHighRiskScriptDefaults({ projectRoot = DEFAULT_PROJECT_ROOT } = {}) {
  const report = makeReport();
  const scriptsDir = path.join(projectRoot, 'scripts');
  if (!fs.existsSync(scriptsDir)) {
    add(report, 'skipped', 'high-risk-script-defaults', 'scripts directory is missing');
    return report;
  }

  const riskyScripts = fs.readdirSync(scriptsDir)
    .filter((fileName) => fileName.endsWith('.mjs') && fileName !== 'harness-audit.mjs')
    .filter((fileName) => {
      const content = fs.readFileSync(path.join(scriptsDir, fileName), 'utf8');
      return scriptLooksProductionDbDefault(content);
    })
    .map((fileName) => `scripts/${fileName}`)
    .sort();

  if (riskyScripts.length) {
    add(
      report,
      'warnings',
      'high-risk-script-defaults',
      `${riskyScripts.length} scripts reference the production SQLite path by default; review before write operations`,
      riskyScripts.slice(0, 30).join('\n'),
    );
  } else {
    add(report, 'passed', 'high-risk-script-defaults', 'no script production DB defaults detected');
  }
  return report;
}

function loadTestMap(projectRoot) {
  const mapPath = path.join(projectRoot, DEFAULT_TEST_MAP_PATH);
  if (!fs.existsSync(mapPath)) return { ok: false, testMap: [], error: `${DEFAULT_TEST_MAP_PATH} is missing` };
  try {
    const testMap = readJsonFile(mapPath);
    if (!Array.isArray(testMap)) return { ok: false, testMap: [], error: `${DEFAULT_TEST_MAP_PATH} must contain an array` };
    return { ok: true, testMap, error: '' };
  } catch (error) {
    return { ok: false, testMap: [], error: error.message };
  }
}

function parseArgs(argv) {
  const options = {
    projectRoot: DEFAULT_PROJECT_ROOT,
    dbPath: path.join(DEFAULT_PROJECT_ROOT, DEFAULT_DEV_DB_PATH),
    runFeatureTests: true,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--skip-feature-tests') {
      options.runFeatureTests = false;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--project-root') {
      options.projectRoot = path.resolve(argv[index + 1] || options.projectRoot);
      index += 1;
    } else if (arg.startsWith('--project-root=')) {
      options.projectRoot = path.resolve(arg.slice('--project-root='.length));
    } else if (arg === '--db') {
      options.dbPath = path.resolve(argv[index + 1] || options.dbPath);
      index += 1;
    } else if (arg.startsWith('--db=')) {
      options.dbPath = path.resolve(arg.slice('--db='.length));
    }
  }
  if (options.projectRoot !== DEFAULT_PROJECT_ROOT && options.dbPath === path.join(DEFAULT_PROJECT_ROOT, DEFAULT_DEV_DB_PATH)) {
    options.dbPath = path.join(options.projectRoot, DEFAULT_DEV_DB_PATH);
  }
  return options;
}

export function runHarnessAudit({
  projectRoot = DEFAULT_PROJECT_ROOT,
  dbPath = path.join(projectRoot, DEFAULT_DEV_DB_PATH),
  runFeatureTests = true,
} = {}) {
  const report = makeReport();
  const status = gitStatus(projectRoot);
  if (status.skipped) {
    add(report, 'skipped', 'git-status', status.reason);
  } else {
    mergeReport(report, auditSensitivePathChanges(status.entries));
  }

  mergeReport(report, auditExecutionPoints({ projectRoot }));

  const loadedMap = loadTestMap(projectRoot);
  if (!loadedMap.ok) {
    add(report, 'failed', 'feature-test-gate', loadedMap.error);
  } else if (status.skipped) {
    add(report, 'skipped', 'feature-test-gate', 'git status unavailable');
  } else {
    mergeReport(report, auditFeatureTestGate({
      changedFiles: status.entries.map((entry) => entry.path),
      testMap: loadedMap.testMap,
      projectRoot,
      runCommands: runFeatureTests,
    }));
  }

  mergeReport(report, auditOptionalResponsibilityDatabase({ dbPath }));
  mergeReport(report, auditHighRiskScriptDefaults({ projectRoot }));
  return report;
}

function printBucket(title, items) {
  console.log(`${title}: ${items.length}`);
  for (const item of items) {
    console.log(`- [${item.check}] ${item.message}`);
    if (item.detail) {
      for (const line of item.detail.split('\n')) console.log(`  ${line}`);
    }
  }
}

export function printReport(report) {
  printBucket('passed', report.passed);
  printBucket('failed', report.failed);
  printBucket('warnings', report.warnings);
  printBucket('skipped', report.skipped);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));
  const report = runHarnessAudit(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
  process.exit(report.failed.length ? 1 : 0);
}
