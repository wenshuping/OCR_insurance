import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createKnowledgeStateStore } from './runtime-knowledge-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');

export function trim(value) {
  return String(value || '').trim();
}

export function normalizeProductName(value = '') {
  return trim(value)
    .replace(/[（]/gu, '(')
    .replace(/[）]/gu, ')')
    .replace(/[，]/gu, ',')
    .replace(/[：]/gu, ':')
    .replace(/\s+/gu, '')
    .replace(/,+/gu, ',');
}

export function isPingAnIssuer(value = '') {
  const normalized = trim(value).replace(/\s+/gu, '');
  if (!normalized) return false;
  if (normalized === '中国平安') return true;
  if (normalized.includes('中国平安人寿')) return true;
  if (normalized.includes('平安人寿')) return true;
  if (normalized.includes('平安健康保险')) return true;
  return false;
}

export function planCodeFromUrl(url = '') {
  try {
    return trim(new URL(url).searchParams.get('planCode'));
  } catch {
    return '';
  }
}
