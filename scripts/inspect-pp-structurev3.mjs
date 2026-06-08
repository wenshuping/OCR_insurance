#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  buildStructureV3InspectionReport,
  normalizeStructureV3Inspection,
} from '../ocr-service/policy-structurev3-normalizer.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const PYTHON_SCRIPT = path.join(PROJECT_ROOT, 'ocr-service', 'scripts', 'policy_ocr_structurev3.py');
const OUTPUT_ROOT = path.join(PROJECT_ROOT, '.structurev3-inspect');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff']);
const USAGE = 'Usage: npm run ocr:structurev3:inspect -- <image-or-directory>';

function text(value) {
  return String(value ?? '').trim();
}

function parseArgs(args) {
  const parsed = {
    input: '',
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
  const extension = path.extname(relative);
  const withoutExtension = extension ? relative.slice(0, -extension.length) : relative;
  return withoutExtension
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
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
  const python = configuredPython(parsedArgs);
  const relativeInput = path.relative(PROJECT_ROOT, inputFile);
  const outputDir = path.join(OUTPUT_ROOT, `${timestampForPath()}-${slugForFile(inputFile)}`);
  await fs.mkdir(outputDir, { recursive: true });

  const meta = {
    input: relativeInput,
    inputPath: inputFile,
    ranAt: new Date().toISOString(),
    python,
    device: structureDevice(),
    useFormulaRecognition: envFlag('POLICY_OCR_STRUCTUREV3_USE_FORMULA_RECOGNITION', false),
    useChartRecognition: envFlag('POLICY_OCR_STRUCTUREV3_USE_CHART_RECOGNITION', false),
  };
  await writeJson(path.join(outputDir, 'input.meta.json'), meta);

  const pythonStatus = await runPython({ python, inputFile, outputDir, meta });
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
