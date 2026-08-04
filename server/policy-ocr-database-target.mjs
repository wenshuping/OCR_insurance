import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function canonicalPath(value) {
  const absolutePath = path.resolve(String(value || '').trim());
  let existingPath = absolutePath;
  const missingSegments = [];
  while (!fs.existsSync(existingPath)) {
    const parentPath = path.dirname(existingPath);
    if (parentPath === existingPath) return absolutePath;
    missingSegments.unshift(path.basename(existingPath));
    existingPath = parentPath;
  }
  return path.join(fs.realpathSync(existingPath), ...missingSegments);
}

function readConfiguredDevelopmentDatabasePath(projectRoot) {
  try {
    const configPath = path.join(projectRoot, '.runtime', 'local', 'policy-ocr-env.json');
    const payload = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return String(payload?.POLICY_OCR_APP_DB_PATH || '').trim();
  } catch {
    return '';
  }
}

function databaseTargetError(code, message, details = []) {
  const error = new Error([message, ...details].filter(Boolean).join('\n'));
  error.code = code;
  return error;
}

function normalizedProfile(profile, env) {
  const value = String(profile || env.POLICY_OCR_PROFILE || '').trim().toLowerCase();
  if (value === 'prod' || value === 'production' || (!value && env.NODE_ENV === 'production')) return 'prod';
  return 'dev';
}

export function assertNotLegacyPolicyOcrDatabasePath({ projectRoot, dbPath }) {
  if (String(dbPath || '').trim() === ':memory:') return ':memory:';
  const resolvedPath = canonicalPath(dbPath);
  const legacyPath = canonicalPath(path.join(projectRoot, '.runtime', 'local', 'policy-ocr.sqlite'));
  if (resolvedPath === legacyPath) {
    throw databaseTargetError(
      'POLICY_OCR_LEGACY_DATABASE_TARGET',
      '已拒绝写入旧开发数据库。',
      [`旧库: ${resolvedPath}`],
    );
  }
  return resolvedPath;
}

export function resolvePolicyOcrWriteDatabasePath({
  projectRoot,
  profile = '',
  requestedPath = '',
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const root = path.resolve(String(projectRoot || '').trim());
  const targetProfile = normalizedProfile(profile, env);
  const configuredDevelopmentPath = readConfiguredDevelopmentDatabasePath(root);
  const defaultDevelopmentPath = path.join(homeDir, 'OCR_insurance_ssd', '.runtime', 'local', 'policy-ocr.sqlite');
  const expectedDevelopmentPath = configuredDevelopmentPath
    || String(env.POLICY_OCR_APP_DB_PATH || '').trim()
    || defaultDevelopmentPath;

  if (targetProfile === 'prod') {
    const expectedProductionPath = String(requestedPath || env.POLICY_OCR_APP_DB_PATH || '').trim()
      || path.join(root, '.runtime', 'policy-ocr.sqlite');
    const resolvedProductionPath = assertNotLegacyPolicyOcrDatabasePath({
      projectRoot: root,
      dbPath: expectedProductionPath,
    });
    if (resolvedProductionPath === canonicalPath(expectedDevelopmentPath)) {
      throw databaseTargetError(
        'POLICY_OCR_PRODUCTION_DATABASE_MISMATCH',
        '生产发布不得写入开发 SSD 数据库。',
        [`生产目标: ${resolvedProductionPath}`],
      );
    }
    return resolvedProductionPath;
  }

  const resolvedDevelopmentPath = assertNotLegacyPolicyOcrDatabasePath({
    projectRoot: root,
    dbPath: requestedPath || expectedDevelopmentPath,
  });
  const configuredTarget = assertNotLegacyPolicyOcrDatabasePath({
    projectRoot: root,
    dbPath: expectedDevelopmentPath,
  });
  if (resolvedDevelopmentPath !== configuredTarget) {
    throw databaseTargetError(
      'POLICY_OCR_DEVELOPMENT_DATABASE_MISMATCH',
      '开发写入目标与配置的 SSD 数据库不一致。',
      [
        `配置目标: ${configuredTarget}`,
        `请求目标: ${resolvedDevelopmentPath}`,
      ],
    );
  }
  return resolvedDevelopmentPath;
}
