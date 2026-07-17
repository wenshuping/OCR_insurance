import fs from 'node:fs';
import path from 'node:path';

export const DEV_SOURCE_OWNER_FILE = 'source-root';

function canonicalPath(value) {
  const absolutePath = path.resolve(String(value || '').trim());
  try {
    return fs.realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

export function readDevSourceOwner(runtimeDir) {
  const ownerPath = path.join(runtimeDir, DEV_SOURCE_OWNER_FILE);
  try {
    const sourceRoot = fs.readFileSync(ownerPath, 'utf8').trim();
    return sourceRoot ? canonicalPath(sourceRoot) : '';
  } catch {
    return '';
  }
}

export function assertDevSourceOwner({ runtimeDir, projectRoot, claimIfMissing = false }) {
  const currentSourceRoot = canonicalPath(projectRoot);
  const existingSourceRoot = readDevSourceOwner(runtimeDir);

  if (!existingSourceRoot && claimIfMissing) {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, DEV_SOURCE_OWNER_FILE), `${currentSourceRoot}\n`);
    return currentSourceRoot;
  }

  if (existingSourceRoot && existingSourceRoot !== currentSourceRoot) {
    const error = new Error([
      '开发环境源码目录不匹配，已拒绝操作。',
      `当前绑定：${existingSourceRoot}`,
      `本次目录：${currentSourceRoot}`,
      '请到“当前绑定”目录执行开发环境命令。',
    ].join('\n'));
    error.code = 'LOCAL_DEV_SOURCE_MISMATCH';
    throw error;
  }

  return existingSourceRoot;
}
