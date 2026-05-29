import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createOcrServiceApp } from './app.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const INITIAL_ENV_KEYS = new Set(Object.keys(process.env));
const SKIP_PROJECT_DOTENV_LOCAL = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.POLICY_OCR_SKIP_PROJECT_DOTENV_LOCAL || '').trim().toLowerCase(),
);

const ENV_FILES = [
  path.join(PROJECT_ROOT, '.env'),
  SKIP_PROJECT_DOTENV_LOCAL ? '' : path.join(PROJECT_ROOT, '.env.local'),
  path.join(__dirname, '.env'),
  path.join(__dirname, '.env.local'),
];

function loadEnvFile(envFile, { override = false } = {}) {
  if (!envFile) {
    return;
  }
  if (!fs.existsSync(envFile)) {
    return;
  }

  const parsed = dotenv.parse(fs.readFileSync(envFile));
  for (const [key, value] of Object.entries(parsed)) {
    if (INITIAL_ENV_KEYS.has(key)) {
      continue;
    }
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(ENV_FILES[0]);
loadEnvFile(ENV_FILES[1], { override: true });
loadEnvFile(ENV_FILES[2], { override: true });
loadEnvFile(ENV_FILES[3], { override: true });

const PORT = Number(process.env.OCR_SERVICE_PORT || process.env.PORT || 4105);
const HOST = process.env.OCR_SERVICE_HOST || process.env.API_HOST || '127.0.0.1';

async function main() {
  const app = createOcrServiceApp();
  const server = app.listen(PORT, HOST, () => {
    const provider = String(process.env.POLICY_OCR_PROVIDER || 'local');
    console.log(`ocr-service listening on http://${HOST}:${PORT} (provider=${provider})`);
  });

  const shutdown = async () => {
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[ocr-service] bootstrap failed:', err?.message || err);
  process.exit(1);
});
