import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAgentSkillPromptFromSelection,
  selectAgentSkillPrompt,
} from '../server/agent-skill-router.service.mjs';

test('agent skill router supports product comparison and replacement cautions', () => {
  const prompt = selectAgentSkillPrompt({
    scene: 'family_sales_chat',
    question: '客户原来有一份重疾险，和这个新产品哪个好，要不要替换旧保单？',
  });

  assert.equal(prompt.intent, 'product_comparison');
  assert.deepEqual(prompt.skills.map((skill) => skill.key), [
    'product_comparison',
    'policy_evidence',
    'sales_script',
    'followup_materials',
  ]);
  assert.match(prompt.systemRules.join('\n'), /退保损失/);
  assert.match(prompt.systemRules.join('\n'), /等待期重启/);
  assert.match(prompt.systemRules.join('\n'), /不得凭记忆编造产品责任/);
});

test('agent skill prompt keeps router-selected product comparison rules', () => {
  const prompt = buildAgentSkillPromptFromSelection({
    scene: 'family_sales_chat',
    selection: {
      intent: 'product_comparison',
      skills: ['product_comparison', 'policy_evidence', 'sales_script'],
      reason: '产品对比',
    },
  });

  assert.equal(prompt.selectedBy, 'deepseek');
  assert.equal(prompt.intent, 'product_comparison');
  assert.match(prompt.promptHint, /智能 skill router 选择/);
  assert.match(prompt.promptHint, /产品比对与替换评估/);
  assert.match(prompt.systemRules.join('\n'), /同类型产品/);
  assert.match(prompt.systemRules.join('\n'), /官网证据/);
  assert.match(prompt.systemRules.join('\n'), /顾问话术/);
});

test('agent skill router treats model output as a validated selection, never a tool grant', () => {
  const prompt = buildAgentSkillPromptFromSelection({
    scene: 'family_sales_chat',
    selection: {
      intent: 'product_comparison',
      skills: ['product_comparison', 'terminal', '__proto__'],
      tools: ['terminal', 'search_policy_evidence'],
      permissions: ['*'],
      tool: 'ask_insurance_expert',
      reason: '产品对比',
    },
  });

  assert.deepEqual(prompt.skills.map(({ key }) => key), ['product_comparison']);
  assert.equal(prompt.intent, 'product_comparison');
  assert.equal('tools' in prompt, false);
  assert.equal('tool' in prompt, false);
  assert.equal('permissions' in prompt, false);
  assert.doesNotMatch(JSON.stringify(prompt), /terminal|search_policy_evidence|ask_insurance_expert/);

  const inherited = Object.create({
    intent: 'product_comparison',
    skills: ['product_comparison'],
    tools: ['terminal'],
  });
  const inheritedPrompt = buildAgentSkillPromptFromSelection({ selection: inherited });
  assert.equal(inheritedPrompt.intent, 'sales_script');
  assert.deepEqual(inheritedPrompt.skills.map(({ key }) => key), ['sales_script']);
});
