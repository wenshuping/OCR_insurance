import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const sourcePath = new URL('../src/features/family-report/FamilySalesReviewMarkdown.tsx', import.meta.url);

async function importMarkdownModule() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const renderStart = source.indexOf('\nfunction renderInlineMarkdown');
  assert.notEqual(renderStart, -1, 'markdown renderer should keep parser before JSX helpers');
  const parserSource = source.slice(0, renderStart);
  const compiled = ts.transpileModule(parserSource, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const tempPath = path.join(os.tmpdir(), `family-sales-review-markdown-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(tempPath, compiled);
  try {
    return await import(tempPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

test('family sales review markdown parser preserves report structure and inline markdown', async () => {
  const { parseFamilySalesReviewMarkdown } = await importMarkdownModule();

  const blocks = parseFamilySalesReviewMarkdown([
    '## 一、销售结论摘要',
    '**优先级最高**：先核实 `duplicatePolicyHints`。',
    '',
    '- `evidenceWarnings` 需要改写',
    '- 暂无',
    '',
    '| 方案 | 下一步 |',
    '| --- | --- |',
    '| **顶梁柱收入保护** | 核实 `plans` |',
  ].join('\n'));

  assert.deepEqual(blocks, [
    { type: 'heading', level: 2, text: '一、销售结论摘要' },
    { type: 'paragraph', text: '**优先级最高**：先核实 重复保单提示。' },
    { type: 'list', ordered: false, items: ['条款证据冲突 需要改写'] },
    {
      type: 'table',
      headers: ['方案', '下一步'],
      rows: [['**顶梁柱收入保护**', '核实 险种明细']],
    },
  ]);
});
