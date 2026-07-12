import fs from 'node:fs/promises';
import path from 'node:path';

const ENV_ALLOW_KEYS = new Set([
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'DEEPSEEK_FALLBACK_MODEL',
  'DEEPSEEK_TIMEOUT_MS',
  'DEEPSEEK_FAMILY_REVIEW_MODEL',
  'DEEPSEEK_FAMILY_REVIEW_TIMEOUT_MS',
  'DEEPSEEK_FAMILY_REVIEW_MAX_TOKENS',
]);

async function loadEnvFile(envPath, { override = false, allowKeys = null } = {}) {
  let raw = '';
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    if (allowKeys && !allowKeys.has(key)) continue;
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
}

export async function loadRuntimeEnv(projectRoot) {
  await loadEnvFile(path.join(projectRoot, '.env'));
  await loadEnvFile(path.join(projectRoot, '.env.local'), { override: true, allowKeys: ENV_ALLOW_KEYS });
}

export function resolveOwnerFields(family = {}, normalizeGuestId) {
  const ownerUserId = Number(family.ownerUserId || 0) || null;
  return {
    userId: ownerUserId,
    guestId: ownerUserId ? '' : normalizeGuestId(family.ownerGuestId),
  };
}

export function createFamilySalesReviewRecord({ state, family, owner, review, allocateId }) {
  const now = new Date().toISOString();
  const ownerUserId = Number(owner.userId || 0) || null;
  return {
    id: allocateId(state),
    familyId: Number(family.id),
    ownerUserId,
    ownerGuestId: ownerUserId ? '' : String(owner.guestId || ''),
    status: 'active',
    content: review.content,
    model: review.model,
    generatedAt: review.generatedAt || now,
    createdAt: now,
    updatedAt: now,
    inputSummary: {
      ...(review.inputSummary || {}),
      familyId: Number(family.id),
    },
  };
}

export function shouldSkipFamilySalesReviewInput(input = {}) {
  return !input.members?.length && !input.policies?.length;
}
