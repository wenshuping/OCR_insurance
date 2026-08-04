#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectSkillManifest, parseWorktreeList } from './integration-harness-audit.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024 * 4,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr?.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout || '';
}

function parseArgs(argv) {
  const options = { projectRoot: DEFAULT_PROJECT_ROOT, configPath: 'docs/integration-harness.json', outputPath: '', sourceManifestPath: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-root') options.projectRoot = path.resolve(argv[++index] || options.projectRoot);
    else if (arg.startsWith('--project-root=')) options.projectRoot = path.resolve(arg.slice('--project-root='.length));
    else if (arg === '--config') options.configPath = argv[++index] || options.configPath;
    else if (arg.startsWith('--config=')) options.configPath = arg.slice('--config='.length);
    else if (arg === '--output') options.outputPath = argv[++index] || options.outputPath;
    else if (arg.startsWith('--output=')) options.outputPath = arg.slice('--output='.length);
    else if (arg === '--source-manifest') options.sourceManifestPath = argv[++index] || options.sourceManifestPath;
    else if (arg.startsWith('--source-manifest=')) options.sourceManifestPath = arg.slice('--source-manifest='.length);
  }
  return options;
}

function buildManifest(options) {
  const root = path.resolve(options.projectRoot);
  const configPath = path.isAbsolute(options.configPath) ? options.configPath : path.join(root, options.configPath);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const canonicalRoot = path.resolve(root, config.canonicalWorktree);
  const worktrees = parseWorktreeList(runGit(['worktree', 'list', '--porcelain'], root));
  const entry = worktrees.find((item) => path.resolve(item.path) === canonicalRoot);
  if (!entry) throw new Error(`canonical integration worktree is not registered: ${canonicalRoot}`);
  if (entry.branch !== config.canonicalBranch) throw new Error(`canonical worktree is on the wrong branch: ${entry.branch || '(detached)'}`);
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all'], canonicalRoot).trim();
  if (status) throw new Error(`canonical worktree is not clean:\n${status.split(/\r?\n/).slice(0, 80).join('\n')}`);

  const skills = collectSkillManifest({ canonicalRoot, config });
  if (!skills.ok) throw new Error(`required Skills are missing or empty:\n${skills.missing.join('\n')}`);

  const manifest = {
    format: 'ocr-insurance-batch-manifest/v1',
    createdAt: new Date().toISOString(),
    canonicalWorktree: canonicalRoot,
    canonicalBranch: config.canonicalBranch,
    codeCommit: entry.head,
    skillManifestSha256: skills.manifestSha256,
    skills: skills.skills,
  };
  if (options.sourceManifestPath) {
    const sourcePath = path.resolve(options.sourceManifestPath);
    manifest.sourceManifestPath = sourcePath;
    manifest.sourceManifestSha256 = sha256File(sourcePath);
  }
  return manifest;
}

const options = parseArgs(process.argv.slice(2));
if (!options.outputPath) {
  console.error('usage: node scripts/create-integration-manifest.mjs --output <path> [--source-manifest <path>]');
  process.exit(2);
}

const outputPath = path.resolve(options.outputPath);
if (fs.existsSync(outputPath)) {
  console.error(`refusing to overwrite existing manifest: ${outputPath}`);
  process.exit(2);
}

try {
  const manifest = buildManifest(options);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, manifestPath: outputPath, codeCommit: manifest.codeCommit, skillManifestSha256: manifest.skillManifestSha256 }));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
