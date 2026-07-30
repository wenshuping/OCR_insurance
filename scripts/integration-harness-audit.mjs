#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_CONFIG_PATH = 'docs/integration-harness.json';

function makeReport() {
  return { passed: [], failed: [], warnings: [], skipped: [] };
}

function add(report, bucket, check, message, detail = '') {
  report[bucket].push({ check, message, detail });
}

function summarizeStatus(output = '') {
  const lines = String(output).split(/\r?\n/).filter(Boolean);
  const visible = lines.slice(0, 80);
  if (lines.length > visible.length) visible.push(`... ${lines.length - visible.length} more changed paths`);
  return visible.join('\n');
}

export function uncommittedStatusLines(output = '', allowedPrefixes = []) {
  const prefixes = allowedPrefixes.map((prefix) => String(prefix).replace(/^\/+|\/+$/gu, '')).filter(Boolean);
  return String(output).split(/\r?\n/).filter(Boolean).filter((line) => {
    const pathText = line.slice(3).trim().replace(/^"|"$/gu, '');
    return !prefixes.some((prefix) => pathText === prefix || pathText.startsWith(`${prefix}/`));
  });
}

function normalizePath(value = '') {
  return path.resolve(String(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function runGit(args, cwd, timeout = 10000) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 1024 * 1024 * 4,
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error?.message || result.stderr?.trim() || `git ${args.join(' ')} failed`,
    };
  }
  return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '', error: '' };
}

export function parseWorktreeList(output = '') {
  const entries = [];
  let current = null;
  const flush = () => {
    if (current?.path) entries.push(current);
    current = null;
  };

  for (const line of String(output).split(/\r?\n/)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const separator = line.indexOf(' ');
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1);
    if (key === 'worktree') {
      flush();
      current = { path: value };
    } else if (current && key === 'HEAD') {
      current.head = value;
    } else if (current && key === 'branch') {
      current.branch = value.replace(/^refs\/heads\//u, '');
    } else if (current && key === 'detached') {
      current.branch = '';
    }
  }
  flush();
  return entries;
}

export function collectSkillManifest({ canonicalRoot, config }) {
  const skillRoot = config.skillRoot || '.agents/skills';
  const requiredSkills = Array.isArray(config.requiredSkills) ? [...config.requiredSkills].sort() : [];
  const skills = [];
  const missing = [];

  for (const name of requiredSkills) {
    const relativePath = path.join(skillRoot, name, 'SKILL.md');
    const absolutePath = path.join(canonicalRoot, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      missing.push(relativePath);
      continue;
    }
    const bytes = fs.readFileSync(absolutePath);
    if (!bytes.length) {
      missing.push(`${relativePath} (empty)`);
      continue;
    }
    skills.push({ name, path: relativePath.replaceAll(path.sep, '/'), sha256: sha256(bytes) });
  }

  const payload = { format: 'ocr-insurance-skill-manifest/v1', skills };
  return {
    ok: missing.length === 0,
    missing,
    skills,
    manifest: payload,
    manifestSha256: sha256(JSON.stringify(stableValue(payload))),
  };
}

function readConfig(projectRoot, configPath) {
  const absolutePath = path.isAbsolute(configPath) ? configPath : path.join(projectRoot, configPath);
  if (!fs.existsSync(absolutePath)) throw new Error(`integration config is missing: ${absolutePath}`);
  const config = readJson(absolutePath);
  if (config.format !== 'ocr-insurance-integration-config/v1') {
    throw new Error(`unsupported integration config format: ${config.format || '(missing)'}`);
  }
  return { config, absolutePath };
}

function validateBatchManifest({ manifestPath, projectRoot, canonicalRoot, canonicalBranch, canonicalHead, skillSnapshot }) {
  const report = makeReport();
  if (!manifestPath) {
    add(report, 'skipped', 'batch-manifest', 'no batch manifest supplied');
    return report;
  }

  const absolutePath = path.isAbsolute(manifestPath) ? manifestPath : path.join(projectRoot, manifestPath);
  if (!fs.existsSync(absolutePath)) {
    add(report, 'failed', 'batch-manifest', 'batch manifest is missing', absolutePath);
    return report;
  }

  let manifest;
  try {
    manifest = readJson(absolutePath);
  } catch (error) {
    add(report, 'failed', 'batch-manifest', 'batch manifest is not valid JSON', error.message);
    return report;
  }

  const failures = [];
  if (manifest.format !== 'ocr-insurance-batch-manifest/v1') failures.push('format must be ocr-insurance-batch-manifest/v1');
  if (manifest.canonicalWorktree && normalizePath(manifest.canonicalWorktree) !== normalizePath(canonicalRoot)) {
    failures.push(`canonicalWorktree mismatch: ${manifest.canonicalWorktree}`);
  }
  if (manifest.canonicalBranch !== canonicalBranch) failures.push(`canonicalBranch mismatch: ${manifest.canonicalBranch || '(missing)'}`);
  if (manifest.codeCommit !== canonicalHead) failures.push(`codeCommit mismatch: ${manifest.codeCommit || '(missing)'} != ${canonicalHead}`);
  if (manifest.skillManifestSha256 !== skillSnapshot.manifestSha256) {
    failures.push(`skillManifestSha256 mismatch: ${manifest.skillManifestSha256 || '(missing)'} != ${skillSnapshot.manifestSha256}`);
  }

  const listedSkills = JSON.stringify(stableValue(manifest.skills || []));
  const actualSkills = JSON.stringify(stableValue(skillSnapshot.skills));
  if (listedSkills !== actualSkills) failures.push('manifest skills do not match the canonical Skill files');

  if (manifest.sourceManifestPath || manifest.sourceManifestSha256) {
    if (!manifest.sourceManifestPath || !manifest.sourceManifestSha256) {
      failures.push('sourceManifestPath and sourceManifestSha256 must be supplied together');
    } else {
      const sourcePath = path.isAbsolute(manifest.sourceManifestPath)
        ? manifest.sourceManifestPath
        : path.resolve(path.dirname(absolutePath), manifest.sourceManifestPath);
      if (!fs.existsSync(sourcePath)) {
        failures.push(`source manifest is missing: ${sourcePath}`);
      } else if (sha256File(sourcePath) !== manifest.sourceManifestSha256) {
        failures.push('sourceManifestSha256 does not match the source manifest');
      }
    }
  }

  if (failures.length) {
    add(report, 'failed', 'batch-manifest', 'batch manifest is not bound to the current canonical code and Skills', failures.join('\n'));
  } else {
    add(report, 'passed', 'batch-manifest', 'batch manifest is bound to the current canonical code and Skills');
  }
  return report;
}

export function auditIntegrationConsistency({
  projectRoot = DEFAULT_PROJECT_ROOT,
  configPath = DEFAULT_CONFIG_PATH,
  manifestPath = '',
  requireManifest = false,
  gitRunner = runGit,
} = {}) {
  const report = makeReport();
  const root = normalizePath(projectRoot);
  let loaded;
  try {
    loaded = readConfig(root, configPath);
  } catch (error) {
    add(report, 'failed', 'integration-config', error.message);
    return report;
  }
  const { config } = loaded;
  const canonicalRoot = normalizePath(path.resolve(root, config.canonicalWorktree));

  const topLevel = gitRunner(['rev-parse', '--show-toplevel'], root);
  if (!topLevel.ok) {
    add(report, 'failed', 'worktree-layout', 'project root is not a readable Git worktree', topLevel.error);
    return report;
  }
  if (normalizePath(topLevel.stdout.trim()) !== root) {
    add(report, 'failed', 'worktree-layout', 'project root does not match Git top-level', topLevel.stdout.trim());
  }

  const worktrees = gitRunner(['worktree', 'list', '--porcelain'], root);
  if (!worktrees.ok) {
    add(report, 'failed', 'worktree-layout', 'Git worktree list could not be read', worktrees.error);
    return report;
  }
  const canonicalEntry = parseWorktreeList(worktrees.stdout)
    .find((entry) => normalizePath(entry.path) === canonicalRoot);
  if (!canonicalEntry) {
    add(report, 'failed', 'worktree-layout', 'canonical integration worktree is not registered', canonicalRoot);
    return report;
  }
  if (canonicalEntry.branch !== config.canonicalBranch) {
    add(report, 'failed', 'worktree-layout', 'canonical worktree is on the wrong branch', `${canonicalEntry.branch || '(detached)'} != ${config.canonicalBranch}`);
  }
  if (root !== canonicalRoot) {
    add(report, 'failed', 'worktree-layout', 'batch/integration commands must run from the canonical worktree', `${root} != ${canonicalRoot}`);
  } else {
    add(report, 'passed', 'worktree-layout', 'command is running from the canonical integration worktree');
  }

  const canonicalStatus = gitRunner(['status', '--porcelain=v1', '--untracked-files=all'], canonicalRoot);
  if (!canonicalStatus.ok) {
    add(report, 'failed', 'canonical-cleanliness', 'canonical worktree status could not be read', canonicalStatus.error);
  } else {
    const dirtyLines = uncommittedStatusLines(canonicalStatus.stdout, config.allowedUncommittedPrefixes || []);
    if (dirtyLines.length) {
      add(report, 'failed', 'canonical-cleanliness', 'canonical worktree has uncommitted or untracked code files', summarizeStatus(dirtyLines.join('\n')));
    } else if (canonicalStatus.stdout.trim()) {
      add(report, 'passed', 'canonical-cleanliness', 'canonical worktree has only protected generated artifacts', summarizeStatus(canonicalStatus.stdout));
    } else {
      add(report, 'passed', 'canonical-cleanliness', 'canonical worktree is clean');
    }
  }

  const canonicalHead = canonicalEntry.head || '';
  if (!canonicalHead) add(report, 'failed', 'canonical-commit', 'canonical worktree has no HEAD commit');
  else add(report, 'passed', 'canonical-commit', 'canonical worktree commit was resolved', canonicalHead);

  const skillSnapshot = collectSkillManifest({ canonicalRoot, config });
  if (!skillSnapshot.ok) {
    add(report, 'failed', 'skill-manifest', 'required Skills are missing or empty in the canonical worktree', skillSnapshot.missing.join('\n'));
  } else {
    add(report, 'passed', 'skill-manifest', 'required Skills are present and hashed', `sha256:${skillSnapshot.manifestSha256}`);
  }

  if (requireManifest && !manifestPath) {
    add(report, 'failed', 'batch-manifest', 'batch manifest is required for integration/batch execution');
  } else {
    const manifestReport = validateBatchManifest({
      manifestPath,
      projectRoot: root,
      canonicalRoot,
      canonicalBranch: config.canonicalBranch,
      canonicalHead,
      skillSnapshot,
    });
    for (const bucket of ['passed', 'failed', 'warnings', 'skipped']) report[bucket].push(...manifestReport[bucket]);
  }
  return report;
}

function parseArgs(argv) {
  const options = { projectRoot: DEFAULT_PROJECT_ROOT, configPath: DEFAULT_CONFIG_PATH, manifestPath: '', requireManifest: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--require-manifest') options.requireManifest = true;
    else if (arg === '--project-root') options.projectRoot = path.resolve(argv[++index] || options.projectRoot);
    else if (arg.startsWith('--project-root=')) options.projectRoot = path.resolve(arg.slice('--project-root='.length));
    else if (arg === '--config') options.configPath = argv[++index] || options.configPath;
    else if (arg.startsWith('--config=')) options.configPath = arg.slice('--config='.length);
    else if (arg === '--manifest') options.manifestPath = argv[++index] || options.manifestPath;
    else if (arg.startsWith('--manifest=')) options.manifestPath = arg.slice('--manifest='.length);
  }
  return options;
}

function printReport(report) {
  for (const bucket of ['passed', 'failed', 'warnings', 'skipped']) {
    console.log(`${bucket}: ${report[bucket].length}`);
    for (const item of report[bucket]) {
      console.log(`- [${item.check}] ${item.message}`);
      if (item.detail) for (const line of item.detail.split('\n')) console.log(`  ${line}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));
  const report = auditIntegrationConsistency(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  process.exit(report.failed.length ? 1 : 0);
}
