import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PIPELINE_SCRIPT = path.join(
  PROJECT_ROOT,
  '.agents/skills/ocr-insurance-product-responsibility-pipeline/scripts/batch_deepseek_backfill.py',
);

function text(value) {
  return String(value || '').trim();
}

function productKey(company, productName) {
  return `company_product:${text(company)}:${text(productName)}`;
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    productKey: text(row.product_key),
    company: text(row.company),
    productName: text(row.product_name),
    status: text(row.status),
    attempts: Number(row.attempts || 0),
    lastError: text(row.last_error),
    artifactPath: text(row.artifact_path),
    claimToken: text(row.claim_token),
    leaseUntil: text(row.lease_until),
    payload: JSON.parse(row.payload || '{}'),
  };
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_responsibility_pipeline_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_key TEXT NOT NULL UNIQUE,
      company TEXT NOT NULL,
      product_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'published', 'manual_review', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      artifact_path TEXT NOT NULL DEFAULT '',
      claim_token TEXT NOT NULL DEFAULT '',
      lease_until TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_product_responsibility_pipeline_jobs_status
      ON product_responsibility_pipeline_jobs(status, updated_at, id);
  `);
}

function resolvePython() {
  const configured = text(process.env.OCR_RESPONSIBILITY_PIPELINE_PYTHON);
  if (configured) return configured;
  return path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

export function createProductResponsibilityPipelineRunner({ db, dbPath, runtimeDir, commandRunner = runCommand } = {}) {
  if (!db || !text(dbPath)) throw new TypeError('Product responsibility pipeline runner requires db and dbPath');
  const root = runtimeDir || path.join(PROJECT_ROOT, '.runtime/product-responsibility-pipeline');
  return async function runProductResponsibilityPipeline(job) {
    const jobDir = path.join(root, `job-${job.id}-attempt-${job.attempts}`);
    const outputDir = path.join(jobDir, 'output');
    const manifestPath = path.join(jobDir, 'manifest.json');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify([job.payload], null, 2));
    const completed = await commandRunner(resolvePython(), [
      PIPELINE_SCRIPT,
      '--db-path', path.resolve(dbPath),
      '--output-dir', outputDir,
      '--env-file', path.join(PROJECT_ROOT, '.env.local'),
      '--manifest', manifestPath,
      '--limit', '1',
      '--workers', '1',
      '--repair-rounds', '3',
    ], { cwd: PROJECT_ROOT, env: process.env });
    if (completed.exitCode !== 0) {
      throw new Error(text(completed.stderr || completed.stdout || `pipeline exited ${completed.exitCode}`));
    }
    const sourceUrl = text(job.payload?.sourceUrl);
    const artifact = sourceUrl
      ? db.prepare(`
          SELECT payload FROM product_responsibility_artifacts
          WHERE source_url = ? AND json_extract(payload, '$.audit.status') = 'approved'
          ORDER BY published_at DESC LIMIT 1
        `).get(sourceUrl)
      : db.prepare(`
          SELECT payload FROM product_responsibility_artifacts
          WHERE product_name = ? AND json_extract(payload, '$.audit.status') = 'approved'
          ORDER BY published_at DESC LIMIT 1
        `).get(job.productName);
    if (artifact) {
      const payload = JSON.parse(artifact.payload || '{}');
      return { status: 'published', artifactPath: text(payload?.publication?.artifactPath) };
    }
    const manualPath = path.join(outputDir, 'manual-review.jsonl');
    let manualError = '';
    try {
      manualError = (await fs.readFile(manualPath, 'utf8')).trim();
    } catch {
      manualError = '';
    }
    return {
      status: 'manual_review',
      lastError: manualError.slice(0, 2_000) || '流水线完成，但未发布 approved artifact',
    };
  };
}

export function createProductResponsibilityPipelineQueue({
  db,
  runJob,
  afterPublished,
  now = () => new Date().toISOString(),
  workerId = crypto.randomUUID(),
  leaseMs = 30 * 60_000,
  intervalMs = 10_000,
  onError = (error) => console.error('[product-responsibility-pipeline] worker failed', error?.message || error),
} = {}) {
  if (!db) throw new TypeError('Product responsibility pipeline queue requires db');
  ensureSchema(db);
  let timer = null;
  let draining = null;

  function getByProductKey(key) {
    return rowToJob(db.prepare(
      'SELECT * FROM product_responsibility_pipeline_jobs WHERE product_key = ?',
    ).get(key));
  }

  async function enqueue(input = {}) {
    const company = text(input.company);
    const productName = text(input.productName);
    const key = productKey(company, productName);
    const timestamp = now();
    const payload = JSON.stringify({
      company,
      productName,
      sourceUrl: text(input.sourceUrl),
      officialDomain: text(input.officialDomain),
      existingResponsibilityHint: text(input.existingResponsibilityHint).slice(0, 12_000),
    });
    db.prepare(`
      INSERT INTO product_responsibility_pipeline_jobs
        (product_key, company, product_name, status, attempts, payload, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)
      ON CONFLICT(product_key) DO UPDATE SET
        payload = excluded.payload,
        updated_at = CASE
          WHEN product_responsibility_pipeline_jobs.status = 'failed' THEN excluded.updated_at
          ELSE product_responsibility_pipeline_jobs.updated_at
        END,
        status = CASE
          WHEN product_responsibility_pipeline_jobs.status = 'failed'
            AND product_responsibility_pipeline_jobs.attempts < 3 THEN 'queued'
          ELSE product_responsibility_pipeline_jobs.status
        END,
        last_error = CASE
          WHEN product_responsibility_pipeline_jobs.status = 'failed'
            AND product_responsibility_pipeline_jobs.attempts < 3 THEN ''
          ELSE product_responsibility_pipeline_jobs.last_error
        END
    `).run(key, company, productName, payload, timestamp, timestamp);
    const job = getByProductKey(key);
    if (job?.status === 'queued') void drain().catch(onError);
    return job;
  }

  function claimNext() {
    const timestamp = now();
    const leaseUntil = new Date(Date.parse(timestamp) + leaseMs).toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare(`
        SELECT id FROM product_responsibility_pipeline_jobs
        WHERE status = 'queued' OR (status = 'processing' AND lease_until <= ?)
        ORDER BY updated_at, id LIMIT 1
      `).get(timestamp);
      if (!row) {
        db.exec('COMMIT');
        return null;
      }
      const claimToken = `${workerId}:${row.id}:${timestamp}`;
      const updated = db.prepare(`
        UPDATE product_responsibility_pipeline_jobs
        SET status = 'processing', attempts = attempts + 1, claim_token = ?, lease_until = ?, updated_at = ?
        WHERE id = ? AND (status = 'queued' OR (status = 'processing' AND lease_until <= ?))
      `).run(claimToken, leaseUntil, timestamp, row.id, timestamp);
      const claimed = updated.changes === 1
        ? db.prepare('SELECT * FROM product_responsibility_pipeline_jobs WHERE id = ?').get(row.id)
        : null;
      db.exec('COMMIT');
      return rowToJob(claimed);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function complete(job, result) {
    const status = result?.status === 'published' ? 'published' : 'manual_review';
    const timestamp = now();
    db.prepare(`
      UPDATE product_responsibility_pipeline_jobs
      SET status = ?, last_error = ?, artifact_path = ?, claim_token = '', lease_until = '',
          updated_at = ?, completed_at = ?
      WHERE id = ? AND status = 'processing' AND claim_token = ?
    `).run(status, text(result?.lastError).slice(0, 2_000), text(result?.artifactPath), timestamp, timestamp, job.id, job.claimToken);
  }

  function fail(job, error) {
    const timestamp = now();
    db.prepare(`
      UPDATE product_responsibility_pipeline_jobs
      SET status = 'failed', last_error = ?, claim_token = '', lease_until = '', updated_at = ?
      WHERE id = ? AND status = 'processing' AND claim_token = ?
    `).run(text(error?.message || error).slice(0, 2_000), timestamp, job.id, job.claimToken);
  }

  async function drainOnce() {
    if (typeof runJob !== 'function') return { processed: 0, reason: 'runner_not_configured' };
    const job = claimNext();
    if (!job) return { processed: 0 };
    try {
      const result = await runJob(job);
      if (result?.status === 'published' && typeof afterPublished === 'function') {
        await afterPublished(job, result);
      }
      complete(job, result);
    } catch (error) {
      fail(job, error);
    }
    return { processed: 1 };
  }

  function drain() {
    if (draining) return draining;
    draining = (async () => {
      let processed = 0;
      while (true) {
        const result = await drainOnce();
        if (!result.processed) return { processed };
        processed += result.processed;
      }
    })().finally(() => { draining = null; });
    return draining;
  }

  function start() {
    if (timer) return;
    void drain().catch(onError);
    timer = setInterval(() => { void drain().catch(onError); }, Math.max(1_000, intervalMs));
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { enqueue, getByProductKey, drain, start, stop };
}
