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

test('agent skill router requires useful follow-up advice before optional information requests', () => {
  const prompt = selectAgentSkillPrompt({
    scene: 'family_sales_chat',
    question: '这个客户怎么继续跟进？',
  });

  assert.equal(prompt.intent, 'sales_script');
  const rules = prompt.systemRules.join('\n');
  assert.match(rules, /信息不完整.*至少一个可执行的跟进方法或话术/u);
  assert.match(rules, /不得把补充信息作为开始分析的前置条件/u);
  assert.match(rules, /低成本短事实可以合并/u);
  assert.match(rules, /隐私程度高的问题一次只问一项/u);
  assert.match(rules, /先给出下一步动作/u);
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
