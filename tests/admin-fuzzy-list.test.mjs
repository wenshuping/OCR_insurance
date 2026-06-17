import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as ts from 'typescript';

async function loadFuzzyListModule() {
  const source = fs.readFileSync(new URL('../src/features/admin-shared/fuzzyList.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

test('admin fuzzy list matching ranks continuous and abbreviated Chinese matches', async () => {
  const { filterAdminList, scoreAdminFuzzyMatch } = await loadFuzzyListModule();
  const rows = [
    { name: '北京人寿京安泰综合意外伤害保险', company: '北京人寿', liability: '可选责任三' },
    { name: '国联人寿福气年年年金保险', company: '国联人寿', liability: '年金领取' },
    { name: '百年好合两全保险(分红型)', company: '新华保险', liability: '责任的基本保险金' },
  ];

  const abbreviatedMatches = filterAdminList(rows, '国联年金', (row) => [row.name, row.company, row.liability]);
  assert.equal(abbreviatedMatches[0].name, '国联人寿福气年年年金保险');
  assert.equal(scoreAdminFuzzyMatch('新华 基本保险金', ['百年好合两全保险(分红型)', '新华保险', '责任的基本保险金']) > 0, true);
  assert.equal(filterAdminList(rows, '完全不存在', (row) => [row.name, row.company, row.liability]).length, 0);
});

test('admin fuzzy list can search insurer names and aliases only', async () => {
  const { filterAdminList } = await loadFuzzyListModule();
  const profiles = [
    { company: '平安人寿', aliases: ['平安保险'], companyAliases: ['中国平安'] },
    { company: '北京人寿', aliases: ['京人寿'], companyAliases: [] },
    { company: '国联人寿', aliases: ['国联保险'], companyAliases: ['国联寿险'] },
  ];

  const aliasMatches = filterAdminList(profiles, '中国平安', (profile) => [
    profile.company,
    profile.aliases.join(' '),
    profile.companyAliases.join(' '),
  ]);
  assert.equal(aliasMatches[0].company, '平安人寿');

  const abbreviatedMatches = filterAdminList(profiles, '国联寿', (profile) => [
    profile.company,
    profile.aliases.join(' '),
    profile.companyAliases.join(' '),
  ]);
  assert.equal(abbreviatedMatches[0].company, '国联人寿');
});

test('admin page window clamps pagination for filtered lists', async () => {
  const { getAdminPageWindow } = await loadFuzzyListModule();

  assert.deepEqual(getAdminPageWindow(37, 1, 10), {
    page: 1,
    pageCount: 4,
    startIndex: 0,
    endIndex: 10,
  });
  assert.deepEqual(getAdminPageWindow(37, 9, 10), {
    page: 4,
    pageCount: 4,
    startIndex: 30,
    endIndex: 37,
  });
  assert.deepEqual(getAdminPageWindow(0, 3, 10), {
    page: 1,
    pageCount: 1,
    startIndex: 0,
    endIndex: 0,
  });
});
