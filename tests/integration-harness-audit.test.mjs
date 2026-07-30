import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { auditIntegrationConsistency, collectSkillManifest, parseWorktreeList } from '../scripts/integration-harness-audit.mjs';

test('parseWorktreeList extracts branch and detached worktrees', () => {
  const entries = parseWorktreeList([
    'worktree /repo/main',
    'HEAD abc123',
    'branch refs/heads/master',
    '',
    'worktree /repo/.worktrees/integration',
    'HEAD def456',
    'branch refs/heads/codex/dev-agent-semantic-integration',
    '',
    'worktree /repo/detached',
    'HEAD 789000',
    'detached',
    '',
  ].join('\n'));
  assert.deepEqual(entries, [
    { path: '/repo/main', head: 'abc123', branch: 'master' },
    { path: '/repo/.worktrees/integration', head: 'def456', branch: 'codex/dev-agent-semantic-integration' },
    { path: '/repo/detached', head: '789000', branch: '' },
  ]);
});

test('collectSkillManifest hashes required Skill entrypoints and reports missing Skills', async () => {
  const root = `/tmp/integration-harness-skill-test-${process.pid}`;
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(`${root}/.agents/skills/one`, { recursive: true });
  await fs.writeFile(`${root}/.agents/skills/one/SKILL.md`, '# one\n');
  const snapshot = collectSkillManifest({
    canonicalRoot: root,
    config: { skillRoot: '.agents/skills', requiredSkills: ['one', 'missing'] },
  });
  assert.equal(snapshot.ok, false);
  assert.deepEqual(snapshot.missing, ['.agents/skills/missing/SKILL.md']);
  assert.equal(snapshot.skills[0].name, 'one');
  await fs.rm(root, { recursive: true, force: true });
});

test('integration audit blocks a non-canonical worktree and does not require a batch manifest for layout-only checks', async () => {
  const root = await fs.mkdtemp('/tmp/integration-harness-layout-test-');
  await fs.mkdir(`${root}/docs`, { recursive: true });
  await fs.writeFile(`${root}/docs/integration-harness.json`, JSON.stringify({
    format: 'ocr-insurance-integration-config/v1',
    canonicalWorktree: '.worktrees/dev-agent-semantic-integration',
    canonicalBranch: 'codex/dev-agent-semantic-integration',
    skillRoot: '.agents/skills',
    requiredSkills: [],
  }));
  const calls = [];
  const gitRunner = (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === 'rev-parse') return { ok: true, stdout: `${root}\n`, stderr: '', error: '' };
    if (args[0] === 'worktree') return {
      ok: true,
      stdout: [
        `worktree ${root}`,
        'HEAD abc123',
        'branch refs/heads/codex/mobile-date-input',
        '',
        `worktree ${root}/.worktrees/dev-agent-semantic-integration`,
        'HEAD def456',
        'branch refs/heads/codex/dev-agent-semantic-integration',
        '',
      ].join('\n'),
      stderr: '',
      error: '',
    };
    return { ok: true, stdout: '', stderr: '', error: '' };
  };
  const report = auditIntegrationConsistency({
    projectRoot: root,
    gitRunner,
  });
  assert.equal(report.failed.some((item) => item.message.includes('must run from the canonical worktree')), true);
  assert.equal(report.skipped.some((item) => item.message === 'no batch manifest supplied'), true);
  assert.equal(calls.length > 0, true);
  await fs.rm(root, { recursive: true, force: true });
});
