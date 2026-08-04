import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_CODE_BINDINGS = [
  'scripts/import-execution-guard.mjs',
  'scripts/responsibility-strict-alignment.mjs',
  'scripts/audit-responsibility-card-indicator-alignment.mjs',
];

function realpathOrResolve(value) {
  const absolute = path.resolve(String(value || ''));
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  return absolute;
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function gitValue(repoRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function gateError(code, message, details = []) {
  const error = new Error([message, ...details].filter(Boolean).join('\n'));
  error.code = code;
  return error;
}

export function collectImportExecution({
  repoRoot,
  scriptPath,
  dbPath,
  artifacts = [],
  sampleLimit = 10,
  write = false,
  isolatedClone = false,
  gatePath = '',
  cwd = process.cwd(),
} = {}) {
  const resolvedRepoRoot = realpathOrResolve(repoRoot);
  const resolvedScriptPath = realpathOrResolve(scriptPath);
  const resolvedDbPath = realpathOrResolve(dbPath);
  const resolvedArtifacts = artifacts.map((artifact) => realpathOrResolve(artifact));
  const boundFiles = [...new Set([
    resolvedScriptPath,
    ...REQUIRED_CODE_BINDINGS.map((relativePath) => realpathOrResolve(path.join(resolvedRepoRoot, relativePath))),
  ])].sort().map((filePath) => ({
    realpath: filePath,
    sha256: fs.existsSync(filePath) ? sha256File(filePath) : '',
  }));
  return {
    schema: 'legacy-import-execution/v1',
    cwd: realpathOrResolve(cwd),
    scriptRealpath: resolvedScriptPath,
    dbRealpath: resolvedDbPath,
    codeTree: {
      repoRoot: resolvedRepoRoot,
      gitCommit: gitValue(resolvedRepoRoot, ['rev-parse', 'HEAD']),
      scriptSha256: fs.existsSync(resolvedScriptPath) ? sha256File(resolvedScriptPath) : '',
      boundFiles,
      statusPorcelain: gitValue(resolvedRepoRoot, ['status', '--porcelain', '--untracked-files=all']),
    },
    parameters: {
      artifacts: resolvedArtifacts,
      sampleLimit: Number(sampleLimit) || 10,
      write: Boolean(write),
      isolatedClone: Boolean(isolatedClone),
    },
    gatePath: gatePath ? realpathOrResolve(gatePath) : '',
  };
}

export function createImportExecutionGate({
  execution,
  scope = 'isolated_clone',
  status = 'PASS',
} = {}) {
  if (!execution || execution.schema !== 'legacy-import-execution/v1') {
    throw gateError('IMPORT_EXECUTION_CONTEXT_MISSING', '缺少固定代码树执行上下文。');
  }
  return {
    schema: 'legacy-import-execution-gate/v1',
    status,
    scope,
    createdAt: new Date().toISOString(),
    cwd: execution.cwd,
    scriptRealpath: execution.scriptRealpath,
    dbRealpath: execution.dbRealpath,
    codeTree: execution.codeTree,
    parameters: execution.parameters,
  };
}

export function assertImportExecutionGate({ gatePath, execution } = {}) {
  if (!gatePath) {
    throw gateError(
      'IMPORT_EXECUTION_GATE_REQUIRED',
      '写入前必须提供固定代码树执行门禁。',
      ['参数: --execution-gate=/absolute/path/to/execution-gate.json'],
    );
  }
  let gate;
  try {
    gate = JSON.parse(fs.readFileSync(gatePath, 'utf8'));
  } catch (error) {
    throw gateError('IMPORT_EXECUTION_GATE_INVALID', '无法读取执行门禁收据。', [String(error.message || error)]);
  }
  if (gate?.schema !== 'legacy-import-execution-gate/v1' || gate.status !== 'PASS') {
    throw gateError('IMPORT_EXECUTION_GATE_NOT_PASS', '执行门禁不是 PASS。');
  }
  const checks = [
    ['cwd', gate.cwd, execution.cwd],
    ['scriptRealpath', gate.scriptRealpath, execution.scriptRealpath],
    ['dbRealpath', gate.dbRealpath, execution.dbRealpath],
    ['codeTree.repoRoot', gate.codeTree?.repoRoot, execution.codeTree.repoRoot],
    ['codeTree.gitCommit', gate.codeTree?.gitCommit, execution.codeTree.gitCommit],
    ['codeTree.scriptSha256', gate.codeTree?.scriptSha256, execution.codeTree.scriptSha256],
  ];
  for (const [field, actual, expected] of checks) {
    if (String(actual || '') !== String(expected || '')) {
      throw gateError(
        'IMPORT_EXECUTION_GATE_CODE_MISMATCH',
        `执行门禁与当前代码/目标不一致: ${field}`,
        [`门禁: ${actual || '(empty)'}`, `当前: ${expected || '(empty)'}`],
      );
    }
  }
  if (JSON.stringify(gate.parameters || {}) !== JSON.stringify(execution.parameters || {})) {
    throw gateError('IMPORT_EXECUTION_GATE_PARAMETERS_MISMATCH', '执行门禁参数与当前导入参数不一致。');
  }
  if (JSON.stringify(gate.codeTree?.boundFiles || []) !== JSON.stringify(execution.codeTree.boundFiles || [])) {
    throw gateError('IMPORT_EXECUTION_GATE_BINDING_MISMATCH', '执行门禁绑定脚本的 realpath 或 SHA 不一致。');
  }
  return gate;
}
