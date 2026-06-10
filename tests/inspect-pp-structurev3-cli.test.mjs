import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TEST_DIR, '..');
const INSPECT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'inspect-pp-structurev3.mjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf-8'));
}

test('inspect CLI uses remote PP-StructureV3 endpoint when configured', async (t) => {
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/structurev3') {
      response.writeHead(404).end();
      return;
    }

    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requestCount += 1;
      assert.equal(Buffer.concat(chunks).toString('utf-8'), 'fake-image');
      const body = JSON.stringify({
        ok: true,
        pipeline: 'pp_structurev3',
        device: 'gpu',
        rawJson: {
          ok: true,
          pipeline: 'pp_structurev3',
          device: 'gpu',
          blocks: [
            { type: 'text', text: '新华保险 投保人 张三 被保险人 李四 受益人 法定' },
          ],
          tables: [
            {
              source: 'raw-table',
              headers: ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费'],
              rows: [
                ['金瑞人生', '100000元', '终身', '20年交', '4334元'],
                ['首期保险费合计', '', '', '', '4334元'],
              ],
            },
          ],
        },
        markdown: '| 险种名称 | 基本保险金额 |\n| --- | --- |\n| 金瑞人生 | 100000元 |',
      });
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
    });
  });

  await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'structurev3-cli-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const imagePath = path.join(tempDir, 'policy.jpg');
  await fs.writeFile(imagePath, 'fake-image', 'utf-8');

  const endpoint = `http://127.0.0.1:${server.address().port}/structurev3`;
  const { stdout } = await execFileAsync(process.execPath, [
    INSPECT_SCRIPT,
    imagePath,
    '--endpoint',
    endpoint,
  ], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      POLICY_OCR_STRUCTUREV3_PYTHON: path.join(tempDir, 'missing-python'),
    },
    timeout: 30000,
  });

  assert.equal(requestCount, 1);
  assert.match(stdout, /^OK /u);
  const outputRel = stdout.trim().match(/ -> (.+)$/u)?.[1];
  assert.ok(outputRel);
  const outputDir = path.join(PROJECT_ROOT, outputRel);
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));

  const meta = await readJson(path.join(outputDir, 'input.meta.json'));
  const normalized = await readJson(path.join(outputDir, 'normalized.json'));
  const candidates = await readJson(path.join(outputDir, 'candidates.json'));

  assert.equal(meta.mode, 'remote');
  assert.equal(meta.endpoint, endpoint);
  assert.equal(normalized.tables[0].source, 'raw-table');
  assert.equal(candidates.policyFields.company.value, '新华保险');
  assert.equal(candidates.plans[0].name, '金瑞人生');
  assert.equal(candidates.plans[0].role, 'main');
});
