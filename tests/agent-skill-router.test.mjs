import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAgentSkillPromptFromSelection,
  selectAgentSkillPrompt,
} from '../server/agent-skill-router.service.mjs';

test('local skill fallback never classifies raw sales text by keywords', () => {
  const prompt = selectAgentSkillPrompt({
    scene: 'family_sales_chat',
    question: '客户原来有一份重疾险，和这个新产品哪个好，要不要替换旧保单？',
  });

  assert.equal(prompt.intent, 'sales_script');
  assert.deepEqual(prompt.skills.map((skill) => skill.key), ['sales_script']);
  assert.match(prompt.promptHint, /不得按原始问题关键词推断/u);
  assert.doesNotMatch(prompt.promptHint, /产品比对与替换评估/u);
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
