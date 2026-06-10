#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  buildStructureV3InspectionReport,
  normalizeStructureV3Inspection,
} from '../ocr-service/policy-structurev3-normalizer.mjs';
import {
  buildStructureV3LlmReport,
  extractStructureV3WithLocalModel,
} from '../ocr-service/policy-structurev3-llm-extractor.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const PYTHON_SCRIPT = path.join(PROJECT_ROOT, 'ocr-service', 'scripts', 'policy_ocr_structurev3.py');
const OUTPUT_ROOT = path.join(PROJECT_ROOT, '.structurev3-inspect');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff']);
const USAGE = 'Usage: npm run ocr:structurev3:inspect -- <image-or-directory> [--llm]';

function text(value) {
  return String(value ?? '').trim();
}

function parseArgs(args) {
  const parsed = {
    endpoint: '',
    input: '',
    llm: false,
    llmBaseUrl: '',
    llmModel: '',
    python: '',
    positionals: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--input') {
      parsed.input = text(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--input=')) {
      parsed.input = text(arg.slice('--input='.length));
      continue;
    }
    if (arg === '--endpoint') {
      parsed.endpoint = text(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--endpoint=')) {
      parsed.endpoint = text(arg.slice('--endpoint='.length));
      continue;
    }
    if (arg === '--llm') {
      parsed.llm = true;
      continue;
    }
    if (arg === '--llm-base-url') {
      parsed.llmBaseUrl = text(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--llm-base-url=')) {
      parsed.llmBaseUrl = text(arg.slice('--llm-base-url='.length));
      continue;
    }
    if (arg === '--llm-model') {
      parsed.llmModel = text(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--llm-model=')) {
      parsed.llmModel = text(arg.slice('--llm-model='.length));
      continue;
    }
    if (arg === '--python') {
      parsed.python = text(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--python=')) {
      parsed.python = text(arg.slice('--python='.length));
      continue;
    }
    if (!arg.startsWith('--')) parsed.positionals.push(arg);
  }

  return parsed;
}

function shouldRunLlm(parsedArgs) {
  return Boolean(parsedArgs.llm || envFlag('POLICY_OCR_STRUCTUREV3_LLM', false));
}

function configuredEndpoint(parsedArgs) {
  return text(parsedArgs.endpoint) || text(process.env.POLICY_OCR_STRUCTUREV3_ENDPOINT);
}

function configuredPython(parsedArgs) {
  return text(parsedArgs.python)
    || text(process.env.POLICY_OCR_STRUCTUREV3_PYTHON)
    || text(process.env.POLICY_OCR_PADDLE_PYTHON)
    || 'python3';
}

function envValue(name, fallback = '') {
  return text(process.env[name]) || fallback;
}

function structureDevice() {
  return envValue(
    'POLICY_OCR_STRUCTUREV3_DEVICE',
    envValue('POLICY_OCR_PADDLE_DEVICE', 'gpu'),
  );
}

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !['', '0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

function buildPythonEnv() {
  return {
    ...process.env,
    POLICY_OCR_STRUCTUREV3_DEVICE: structureDevice(),
    POLICY_OCR_STRUCTUREV3_USE_FORMULA_RECOGNITION: envValue(
      'POLICY_OCR_STRUCTUREV3_USE_FORMULA_RECOGNITION',
      'false',
    ),
    POLICY_OCR_STRUCTUREV3_USE_CHART_RECOGNITION: envValue(
      'POLICY_OCR_STRUCTUREV3_USE_CHART_RECOGNITION',
      'false',
    ),
  };
}

function isPathCommand(command) {
  return command.includes('/') || (path.sep !== '/' && command.includes(path.sep));
}

function isExecutable(filePath) {
  try {
    fsSync.accessSync(filePath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandExists(command) {
  if (!command) return false;
  if (isPathCommand(command)) {
    const resolved = path.isAbsolute(command) ? command : path.resolve(PROJECT_ROOT, command);
    return isExecutable(resolved);
  }

  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return pathEntries.some((entry) => isExecutable(path.join(entry, command)));
}

function timestampForPath(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`,
  ].join('-');
}

function slugForFile(filePath) {
  const relative = path.relative(PROJECT_ROOT, filePath) || path.basename(filePath);
  const safeSource = relative.startsWith('..') || path.isAbsolute(relative)
    ? path.basename(filePath)
    : relative;
  const extension = path.extname(safeSource);
  const withoutExtension = extension ? safeSource.slice(0, -extension.length) : safeSource;
  return withoutExtension
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^\.+$/u, '')
    .replace(/^-+|-+$/gu, '')
    || 'policy';
}

async function collectInputFiles(inputPath) {
  const resolved = path.resolve(inputPath);
  const stat = await fs.stat(resolved);
  if (stat.isFile()) {
    return IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase()) ? [resolved] : [];
  }
  if (!stat.isDirectory()) return [];

  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(resolved, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectInputFiles(child));
      continue;
    }
    if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(child);
    }
  }
  return files.sort();
}

async function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function parsePythonStatus(stdout) {
  const raw = text(stdout);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const line = raw.split(/\r?\n/u).map(text).filter(Boolean).reverse()
      .find((item) => item.startsWith('{') && item.endsWith('}'));
    return line ? JSON.parse(line) : {};
  }
}

function pythonErrorText(error) {
  return [
    text(error?.stderr),
    text(error?.stdout),
    text(error?.message || error),
  ].filter(Boolean).join('\n').trim();
}

function remoteTimeoutMs() {
  const raw = Number.parseInt(envValue('POLICY_OCR_STRUCTUREV3_REMOTE_TIMEOUT_MS', '600000'), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 600000;
}

function remoteErrorText(error) {
  return [
    text(error?.responseText),
    text(error?.message || error),
  ].filter(Boolean).join('\n').trim();
}

function parseRemoteJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return { rawText: value };
  }
}

function remoteRawJson(payload) {
  const raw = payload?.rawJson ?? payload?.raw ?? payload?.rawPayload;
  const parsed = parseRemoteJson(raw);
  if (parsed && typeof parsed === 'object') return parsed;
  return {
    ok: payload?.ok === true,
    pipeline: payload?.pipeline || 'pp_structurev3',
    device: payload?.device || '',
    results: [],
  };
}

function remoteMarkdown(payload) {
  return text(payload?.markdown ?? payload?.rawMarkdown ?? payload?.rawMarkdownText);
}

async function postRemoteStructureV3(endpoint, inputFile) {
  const target = new URL(endpoint);
  const client = target.protocol === 'https:' ? https : http;
  const body = await fs.readFile(inputFile);
  const headers = {
    'content-type': 'application/octet-stream',
    'content-length': body.length,
    'x-filename': encodeURIComponent(path.basename(inputFile)),
  };

  return new Promise((resolve, reject) => {
    const request = client.request(target, {
      method: 'POST',
      headers,
      timeout: remoteTimeoutMs(),
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const responseText = Buffer.concat(chunks).toString('utf-8');
        let payload = {};
        try {
          payload = responseText ? JSON.parse(responseText) : {};
        } catch (error) {
          reject(Object.assign(error, { responseText }));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(Object.assign(new Error(payload.error || `HTTP ${response.statusCode}`), {
            responseText,
          }));
          return;
        }
        resolve(payload);
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error(`Remote PP-StructureV3 timed out after ${remoteTimeoutMs()}ms`));
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function runRemote({ endpoint, inputFile, outputDir, meta }) {
  try {
    const payload = await postRemoteStructureV3(endpoint, inputFile);
    await writeJson(path.join(outputDir, 'raw.structurev3.json'), remoteRawJson(payload));
    await fs.writeFile(path.join(outputDir, 'raw.structurev3.md'), remoteMarkdown(payload), 'utf-8');

    if (payload.ok === true) {
      return {
        ok: true,
        pipeline: payload.pipeline || 'pp_structurev3',
        device: payload.device || meta.device,
        mode: 'remote',
        endpoint,
      };
    }
    return {
      ok: false,
      error: payload.error || 'Remote PP-StructureV3 did not return ok:true',
      device: payload.device || meta.device,
      mode: 'remote',
      endpoint,
      ...payload,
    };
  } catch (error) {
    return {
      ok: false,
      error: remoteErrorText(error) || 'Remote PP-StructureV3 failed',
      device: meta.device,
      mode: 'remote',
      endpoint,
    };
  }
}

async function runPython({ python, inputFile, outputDir, meta }) {
  try {
    const { stdout } = await execFileAsync(
      python,
      [PYTHON_SCRIPT, '--input', inputFile, '--output-dir', outputDir],
      {
        cwd: PROJECT_ROOT,
        env: buildPythonEnv(),
        timeout: 600000,
        maxBuffer: 50 * 1024 * 1024,
      },
    );
    const status = parsePythonStatus(stdout);
    if (status.ok === true) return status;
    return {
      ok: false,
      error: status.error || 'Python runner did not return ok:true',
      device: status.device || meta.device,
      ...status,
    };
  } catch (error) {
    return {
      ok: false,
      error: pythonErrorText(error) || 'Python runner failed',
      device: meta.device,
    };
  }
}

async function inspectOne(inputFile, parsedArgs) {
  const endpoint = configuredEndpoint(parsedArgs);
  const python = endpoint ? '' : configuredPython(parsedArgs);
  const relativeInput = path.relative(PROJECT_ROOT, inputFile);
  const outputDir = path.join(OUTPUT_ROOT, `${timestampForPath()}-${slugForFile(inputFile)}`);
  await fs.mkdir(outputDir, { recursive: true });

  const meta = {
    mode: endpoint ? 'remote' : 'local-python',
    input: relativeInput,
    inputPath: inputFile,
    ranAt: new Date().toISOString(),
    ...(endpoint ? { endpoint } : { python }),
    device: structureDevice(),
    useFormulaRecognition: envFlag('POLICY_OCR_STRUCTUREV3_USE_FORMULA_RECOGNITION', false),
    useChartRecognition: envFlag('POLICY_OCR_STRUCTUREV3_USE_CHART_RECOGNITION', false),
    useLlm: shouldRunLlm(parsedArgs),
  };
  await writeJson(path.join(outputDir, 'input.meta.json'), meta);

  const pythonStatus = endpoint
    ? await runRemote({ endpoint, inputFile, outputDir, meta })
    : await runPython({ python, inputFile, outputDir, meta });
  if (pythonStatus.ok !== true) {
    await writeJson(path.join(outputDir, 'error.json'), pythonStatus);
  }

  const rawJsonPath = path.join(outputDir, 'raw.structurev3.json');
  const rawMarkdownPath = path.join(outputDir, 'raw.structurev3.md');
  const raw = fsSync.existsSync(rawJsonPath) ? await readJson(rawJsonPath, {}) : {};
  const markdown = fsSync.existsSync(rawMarkdownPath)
    ? await fs.readFile(rawMarkdownPath, 'utf-8')
    : '';
  const result = normalizeStructureV3Inspection({ raw, markdown });

  await writeJson(path.join(outputDir, 'normalized.json'), result.normalized);
  await writeJson(path.join(outputDir, 'candidates.json'), result.candidates);

  if (shouldRunLlm(parsedArgs) && pythonStatus.ok === true) {
    const llmResult = await extractStructureV3WithLocalModel({
      normalized: result.normalized,
      candidates: result.candidates,
      markdown,
      baseUrl: parsedArgs.llmBaseUrl,
      model: parsedArgs.llmModel,
    });
    await writeJson(path.join(outputDir, 'llm.candidates.json'), llmResult);
    if (llmResult.rawContent) {
      await fs.writeFile(path.join(outputDir, 'llm.raw-response.txt'), llmResult.rawContent, 'utf-8');
    }
    await fs.writeFile(path.join(outputDir, 'llm.report.md'), buildStructureV3LlmReport(llmResult), 'utf-8');
  }

  await fs.writeFile(
    path.join(outputDir, 'report.md'),
    buildStructureV3InspectionReport({
      input: relativeInput,
      result,
      pythonStatus,
    }),
    'utf-8',
  );

  return {
    ok: pythonStatus.ok === true,
    input: relativeInput,
    output: path.relative(PROJECT_ROOT, outputDir),
  };
}

async function main(args = process.argv.slice(2)) {
  const parsedArgs = parseArgs(args);
  const input = text(parsedArgs.input) || text(parsedArgs.positionals[0]);
  if (!input) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const endpoint = configuredEndpoint(parsedArgs);
  if (!endpoint) {
    if (!fsSync.existsSync(PYTHON_SCRIPT)) {
      console.error(`Missing Python runner: ${PYTHON_SCRIPT}`);
      process.exitCode = 1;
      return;
    }

    const python = configuredPython(parsedArgs);
    if (!commandExists(python)) {
      console.error(`Missing Python runner: ${python}`);
      process.exitCode = 1;
      return;
    }
  }

  let files = [];
  try {
    files = await collectInputFiles(input);
  } catch (error) {
    console.error(`No supported image files found: ${input}`);
    process.exitCode = 1;
    return;
  }

  if (!files.length) {
    console.error(`No supported image files found: ${input}`);
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(OUTPUT_ROOT, { recursive: true });

  let allOk = true;
  for (const file of files) {
    const result = await inspectOne(file, parsedArgs);
    if (!result.ok) allOk = false;
    console.log(`${result.ok ? 'OK' : 'FAIL'} ${result.input} -> ${result.output}`);
  }

  process.exitCode = allOk ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
