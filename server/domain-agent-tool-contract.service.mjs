import { redactDeepSeekDirectIdentifiers } from './deepseek-privacy-gateway.mjs';

const AGENTS = new Set(['insurance_expert', 'sales_champion']);
const MAX_LIST_ITEMS = 20;

function text(value, limit = 4_000) {
  return typeof value === 'string'
    ? redactDeepSeekDirectIdentifiers(value).trim().slice(0, limit)
    : '';
}

function safeReference(value) {
  const normalized = text(value, 1_000);
  if (!normalized
    || /^data:/iu.test(normalized)
    || /(?:^|[/\\])(?:Users|home|var|tmp|private|runtime)(?:[/\\]|$)/u.test(normalized)) return '';
  return normalized;
}

function stringList(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => text(item, 1_000))
    .filter(Boolean))].slice(0, MAX_LIST_ITEMS);
}

function evidenceList(value) {
  return (Array.isArray(value) ? value : []).slice(0, MAX_LIST_ITEMS).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const label = text(item.label || item.title, 500);
    const ref = safeReference(item.ref || item.sourceRef || item.versionRef);
    const url = safeReference(item.url);
    const version = text(item.version, 200);
    const provenance = text(item.provenance, 200);
    if (!label || (!ref && !url && !version)) return [];
    return [{
      label,
      ...(ref ? { ref } : {}),
      ...(url ? { url } : {}),
      ...(version ? { version } : {}),
      ...(provenance ? { provenance } : {}),
    }];
  });
}

export function buildDomainAgentEnvelope(value = {}) {
  const agent = text(value.agent, 40);
  if (!AGENTS.has(agent)) throw new TypeError('domain agent is invalid');
  const answer = text(value.answer, 48_000);
  if (!answer) throw new TypeError('domain agent answer is required');
  const requestId = text(value.requestId, 200);
  const taskId = text(value.taskId, 200);
  return {
    agent,
    answer,
    evidence: evidenceList(value.evidence),
    limitations: stringList(value.limitations),
    missingInformation: stringList(value.missingInformation),
    ...(requestId ? { requestId } : {}),
    ...(taskId ? { taskId } : {}),
  };
}

export function attachDomainAgentProvenance(result, agent) {
  if (!AGENTS.has(agent)) throw new TypeError('domain agent is invalid');
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !result.interaction || typeof result.interaction !== 'object') {
    throw new TypeError('domain agent result is invalid');
  }
  return {
    ...result,
    provenance: {
      ...(result.provenance && typeof result.provenance === 'object' && !Array.isArray(result.provenance)
        ? result.provenance : {}),
      domainAgent: agent,
      agentAsTool: true,
    },
  };
}
