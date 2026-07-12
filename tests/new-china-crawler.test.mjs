import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');
const crawlerPath = path.join(projectRoot, 'server', 'scrapling-policy-crawler.py');
const pythonPath = process.env.SCRAPLING_PYTHON_BIN || '/Users/wenshuping/Documents/Scrapling/.venv/bin/python';

test('New China crawler falls back to local Vision OCR for scanned official PDFs', (t) => {
  if (!fs.existsSync(pythonPath)) {
    t.skip(`Scrapling Python not found: ${pythonPath}`);
    return;
  }

  const script = String.raw`
import importlib.util
import json

PRODUCT = "新华人寿保险股份有限公司健乐增额终身重大疾病保险（分红型）"
PDF_URL = "https://static-cdn.newchinalife.com/ncl/pdf/20240423/29e90f47-6d61-445a-a48f-1e0441821df3.pdf"

spec = importlib.util.spec_from_file_location("scrapling_policy_crawler", ${JSON.stringify(crawlerPath)})
crawler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crawler)

def fake_fetch_html(url):
    if "node/670" in url:
        return 200, f'<html><body><a href="{PDF_URL}">{PRODUCT}</a></body></html>'
    return 200, f'''
      <table>
        <tr>
          <td>1</td>
          <td>{PRODUCT}</td>
          <td>重疾险</td>
          <td>停售</td>
          <td><a href="/node/670?riskCode=00701000&status=2&productName=test">产品说明书</a></td>
        </tr>
      </table>
    '''

def fake_fetch_bytes(url):
    return 200, b"%PDF-1.6 scanned fixture"

def fake_text_extract(data):
    return {"pages": 9, "text": ""}

def fake_vision_extract(data, max_pages=0):
    return {
        "pages": 9,
        "text": (
            "健乐增额终身重大疾病保险（分红型）条款\n"
            "第二条 保险责任\n"
            "在本合同有效期内，本公司承担下列保险责任：\n"
            "一、被保险人于合同生效一年内因疾病导致身故或身体全残，本公司按本合同初始基本保险金额的10%给付身故或全残保险金，并无息返还所交保险费，本合同终止。\n"
            "被保险人因意外伤害或者合同生效一年后因疾病导致身故或身体全残，本公司按有效保险金额给付身故或全残保险金，本合同终止。\n"
            "二、被保险人于合同生效一年后初次患本合同所指的重大疾病，本公司按有效保险金额给付重大疾病保险金，本合同终止。\n"
            "第四条 保单红利\n"
        ),
    }

crawler.fetch_html = fake_fetch_html
crawler.fetch_bytes = fake_fetch_bytes
crawler.extract_pdf_text_with_system_python = fake_text_extract
crawler.extract_pdf_text_with_local_vision = fake_vision_extract

records = crawler.crawl_new_china("新华保险", PRODUCT)
print(json.dumps(records, ensure_ascii=False))
`;

  const result = spawnSync(pythonPath, ['-c', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const records = JSON.parse(result.stdout);
  assert.equal(records.length, 1);
  assert.equal(records[0].productName, '新华人寿保险股份有限公司健乐增额终身重大疾病保险（分红型）');
  assert.equal(records[0].url, 'https://static-cdn.newchinalife.com/ncl/pdf/20240423/29e90f47-6d61-445a-a48f-1e0441821df3.pdf');
  assert.equal(records[0].extractionMethod, 'macos_vision');
  assert.match(records[0].pageText, /重大疾病保险金/);
});
