import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createInsuranceExpertSkillRegistry,
  formatSkillRegistryForPrompt,
  loadLocalInsuranceExpertSkills,
} from '../server/insurance-expert-skill-registry.service.mjs';

test('local insurance skills are loaded with their safety boundaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insurance-skills-'));
  const skillDir = path.join(root, 'insurance');
  fs.mkdirSync(skillDir);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
    '---',
    'name: insurance',
    'description: Local-first insurance record organizer for tracking policies, renewals, claims logs, and related insurance records. NEVER provides insurance advice.',
    '---',
    '# Insurance',
    '- All insurance records stored locally only under memory/insurance/',
    '- NEVER provide insurance advice',
    '- NEVER recommend specific coverage amounts',
  ].join('\n'));

  const skills = loadLocalInsuranceExpertSkills({ skillRoot: root });

  assert.equal(skills.length, 1);
  assert.equal(skills[0].key, 'insurance');
  assert.equal(skills[0].source, 'local_skill');
  assert.match(skills[0].path, /insurance\/SKILL\.md$/u);
  assert.deepEqual(skills[0].safetyBoundaries, [
    'Local-first insurance record organizer for tracking policies, renewals, claims logs, and related insurance records. NEVER provides insurance advice.',
    'All insurance records stored locally only under memory/insurance/',
    'NEVER provide insurance advice',
    'NEVER recommend specific coverage amounts',
  ]);
});

test('insurance expert skill registry selects local record skills only when relevant', () => {
  const registry = createInsuranceExpertSkillRegistry({
    localSkills: [{
      key: 'insurance',
      label: 'insurance',
      description: 'Local-first insurance record organizer for tracking policies, renewals and claims logs. NEVER provides insurance advice.',
      source: 'local_skill',
      safetyBoundaries: ['NEVER provides insurance advice.'],
    }],
  });

  const recordSkills = registry.skillsForIntent('insurance_product_knowledge', {
    question: '帮我记录这张保单，后面提醒续期',
  }).map((item) => item.key);
  const responsibilitySkills = registry.skillsForIntent('insurance_product_knowledge', {
    question: '寰宇尊悦保险责任',
  }).map((item) => item.key);

  assert.ok(recordSkills.includes('insurance'));
  assert.equal(responsibilitySkills.includes('insurance'), false);
  assert.ok(responsibilitySkills.includes('responsibility_detail'));
});

test('insurance expert skill registry falls back to generic QA for common product questions', () => {
  const registry = createInsuranceExpertSkillRegistry({ localSkills: [] });

  const skills = registry.skillsForIntent('insurance_product_knowledge', {
    question: '这个产品适合什么人群',
    resolvedProduct: { company: '新华保险', officialName: '医药安欣（易核版）医疗保险' },
  }).map((item) => item.key);

  assert.deepEqual(skills, [
    'insurance_expert_qa',
    'official_terms_retrieval',
    'approved_material_retrieval',
    'evidence_validation',
  ]);
});

test('skill registry prompt includes callable keys and local safety boundaries', () => {
  const registry = createInsuranceExpertSkillRegistry({
    localSkills: [{
      key: 'insurance',
      label: 'insurance',
      description: 'Local-first insurance record organizer.',
      source: 'local_skill',
      safetyBoundaries: ['NEVER provides insurance advice.'],
    }],
  });

  const prompt = formatSkillRegistryForPrompt(registry.skillsForIntent('insurance_product_knowledge', {
    question: '记录保单续期',
  }));

  assert.match(prompt, /insurance｜本地保单记录管理/u);
  assert.match(prompt, /NEVER provides insurance advice/u);
  assert.doesNotMatch(prompt, /responsibility_detail｜C端保险责任助理/u);
});
