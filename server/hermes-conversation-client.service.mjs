import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { redactDeepSeekDirectIdentifiers } from './deepseek-privacy-gateway.mjs';
import { normalizeAgentContextFactBlock } from './agent-context-fact-block.service.mjs';
import {
  normalizeSemanticProposal,
  SEMANTIC_INTENTS,
  SEMANTIC_QUERY_ASPECTS,
  SEMANTIC_REFERENCE_TYPES,
} from './agent-semantic-contract.mjs';

const ALLOWED_INTENTS = new Set([
  'chat', 'family_list', 'family_summary', 'coverage_report', 'sales_report',
  'sales_coaching', 'upload_link', 'insurance_product_knowledge',
]);
const ALLOWED_ENTITY_KEYS = new Set([
  'familyName', 'productName', 'productBText', 'policyHint', 'sourceFamilyName', 'targetFamilyName',
]);

function boundedText(value, maxLength) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && normalized.length <= maxLength ? normalized : '';
}

function defaultCommand(env) {
  const configured = boundedText(env?.HERMES_CLI_PATH, 1_000);
  if (configured) return configured;
  const local = path.join(String(env?.HOME || ''), '.local', 'bin', 'hermes');
  return existsSync(local) ? local : 'hermes';
}

function invoke(execFile, command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || '');
        const code = /Session not found:/u.test(detail)
          ? 'HERMES_SESSION_NOT_FOUND'
          : error?.code === 'ENOENT'
            ? 'HERMES_CLI_UNAVAILABLE'
            : error?.killed || ['SIGTERM', 'SIGKILL'].includes(error?.signal)
              ? 'HERMES_TIMEOUT'
              : /(?:429|rate.?limit|too many requests)/iu.test(detail)
                ? 'HERMES_RATE_LIMITED'
                : /(?:401|403|unauthorized|invalid[^\n]{0,30}(?:api|token|key))/iu.test(detail)
                  ? 'HERMES_AUTH_FAILED'
                  : 'HERMES_PROVIDER_FAILED';
        reject(Object.assign(new Error(code), { code, cause: error }));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function parseJsonOutput(value) {
  const raw = String(value || '').split(/\r?\n/u)
    .filter((line) => line.trim() !== 'Warning: Unknown toolsets: none')
    .join('\n').trim();
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)?.[1] || raw;
  let parsed;
  try { parsed = JSON.parse(fenced); } catch {
    throw Object.assign(new Error('HERMES_RESPONSE_INVALID'), { code: 'HERMES_RESPONSE_INVALID' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('HERMES_RESPONSE_INVALID'), { code: 'HERMES_RESPONSE_INVALID' });
  }
  return parsed;
}

function normalizeCandidate(value, originalQuestion) {
  const allowedRoot = new Set(['intent', 'question', 'confidence', 'requestedOperation', 'entities', 'contextRefs']);
  if (Object.keys(value).some((key) => !allowedRoot.has(key))) {
    throw Object.assign(new Error('HERMES_RESPONSE_INVALID'), { code: 'HERMES_RESPONSE_INVALID' });
  }
  let intent = boundedText(value.intent, 80);
  const confidence = Number(value.confidence);
  if (!ALLOWED_INTENTS.has(intent) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw Object.assign(new Error('HERMES_RESPONSE_INVALID'), { code: 'HERMES_RESPONSE_INVALID' });
  }
  const requestedOperation = value.requestedOperation == null ? 'read' : boundedText(value.requestedOperation, 20);
  if (requestedOperation !== 'read') {
    throw Object.assign(new Error('HERMES_RESPONSE_INVALID'), { code: 'HERMES_RESPONSE_INVALID' });
  }
  const entities = {};
  if (value.entities !== undefined) {
    if (!value.entities || typeof value.entities !== 'object' || Array.isArray(value.entities)) {
      throw Object.assign(new Error('HERMES_RESPONSE_INVALID'), { code: 'HERMES_RESPONSE_INVALID' });
    }
    for (const [key, item] of Object.entries(value.entities)) {
      const normalized = boundedText(item, 200);
      if (!ALLOWED_ENTITY_KEYS.has(key) || !normalized) {
        throw Object.assign(new Error('HERMES_RESPONSE_INVALID'), { code: 'HERMES_RESPONSE_INVALID' });
      }
      entities[key] = normalized;
    }
  }
  const contextRefs = value.contextRefs === undefined ? [] : value.contextRefs;
  if (!Array.isArray(contextRefs) || contextRefs.length > 4
    || contextRefs.some((item) => item !== 'previous_product')) {
    throw Object.assign(new Error('HERMES_RESPONSE_INVALID'), { code: 'HERMES_RESPONSE_INVALID' });
  }
  if (contextRefs.includes('previous_product') && entities.productBText) {
    intent = 'insurance_product_knowledge';
  }
  return {
    intent,
    question: originalQuestion,
    confidence,
    requestedOperation,
    ...(Object.keys(entities).length ? { entities } : {}),
    ...(contextRefs.length ? { contextRefs: [...new Set(contextRefs)] } : {}),
  };
}

function promptFor({ question, safeRecentContext }) {
  const history = (Array.isArray(safeRecentContext?.history) ? safeRecentContext.history : [])
    .slice(-6)
    .flatMap((item) => {
      const role = ['user', 'assistant'].includes(item?.role) ? item.role : '';
      const content = boundedText(redactDeepSeekDirectIdentifiers(item?.content), 1_000);
      return role && content ? [{ role, content }] : [];
    });
  const factBlock = safeRecentContext?.factBlock
    ? normalizeAgentContextFactBlock(safeRecentContext.factBlock)
    : null;
  return [
    '你是 OCR Insurance 的 Hermes 语义解析器，只做意图、原文实体提及和上下文引用解析，不回答保险事实，不调用任何工具。',
    ...(factBlock ? [`VERIFIED_FACT_BLOCK=${JSON.stringify(factBlock)}`] : []),
    '只输出一个 JSON 对象，不要 Markdown、解释或额外字段。',
    '固定输出字段：semanticContractVersion, intent, operation, queryAspects, mentions, references, requestedSteps, confidence。',
    'semanticContractVersion 固定为 JSON 数字 1（不要输出字符串 "1"）；operation 只能是 read 或 write。',
    `intent 只能是：${SEMANTIC_INTENTS.join(', ')}。`,
    `queryAspects 只能从以下值选择：${SEMANTIC_QUERY_ASPECTS.join(', ')}。`,
    'mentions 是原文中明确出现的实体数组，每项只能含 type 和 rawText；type 只能是 insurer, product, family，rawText 必须逐字来自 USER_QUESTION。',
    '同一保险产品内部的“计划一、计划二、计划三、方案A”等保障计划或方案编号不是独立保险产品，不得作为 product mention；只提取它们所属的产品名称。',
    'comparison 只表示两个或以上不同保险产品之间的比较；比较同一产品内部的计划、方案或档位时，不得输出 comparison。',
    `references 每项只能含 type 和 rawText；type 只能是：${SEMANTIC_REFERENCE_TYPES.join(', ')}；rawText 必须逐字来自 USER_QUESTION。`,
    'requestedSteps 只能从 lookup, compare, generate, upload, continue 中选择。',
    'confidence 必须恰好包含 intent, mentions, references 三个 0 到 1 的数字。',
    '“他、它、这个产品、上述产品”等指代只放入 references，不得猜测或编造规范产品名、公司名、家庭名。',
    '凡是保险产品、条款、责任、理赔、核保、保单、保障分析或产品比较等专业问题，必须归入最匹配的保险专业意图；产品类或无法再细分的保险专业问题使用 insurance_product_knowledge，不得归入 chat。',
    '凡是客户需求分析、产品推荐、销售方案、沟通话术、异议处理或成交辅导等销售专业问题，使用 sales_coaching，不得归入 chat。',
    'chat 只用于不需要保险知识或销售判断的普通寒暄和一般交流。',
    '保险结论将由受控保险专家工具核验，你不得凭记忆补充责任、金额、销售状态或来源。',
    `SAFE_RECENT_CONTEXT=${JSON.stringify(history)}`,
    `USER_QUESTION=${JSON.stringify(redactDeepSeekDirectIdentifiers(question))}`,
  ].join('\n');
}

function normalizeProviderOutput(value, originalQuestion) {
  const semanticContractVersion = value?.semanticContractVersion;
  if (semanticContractVersion === 1 || semanticContractVersion === '1') {
    try {
      return {
        proposal: normalizeSemanticProposal({ ...value, semanticContractVersion: 1 }, originalQuestion),
      };
    } catch {
      throw Object.assign(new Error('HERMES_RESPONSE_INVALID'), { code: 'HERMES_RESPONSE_INVALID' });
    }
  }
  return { candidate: normalizeCandidate(value, originalQuestion) };
}

export function createHermesConversationClient({
  env = process.env,
  execFile = nodeExecFile,
  command = defaultCommand(env),
  timeoutMs = Number(env?.HERMES_TIMEOUT_MS) || 30_000,
  failureThreshold = 5,
  circuitResetMs = 30_000,
  now = Date.now,
} = {}) {
  let consecutiveFailures = 0;
  let circuitOpenedAt = null;
  let halfOpenProbeRunning = false;

  async function runTurn({ sessionId = '', question, safeRecentContext = {} } = {}) {
    const normalizedQuestion = boundedText(question, 1_000);
    if (!normalizedQuestion) throw new TypeError('Hermes question is required');
    const normalizedSessionId = sessionId ? boundedText(sessionId, 200) : '';
    if (sessionId && !normalizedSessionId) throw new TypeError('Hermes session id is invalid');
    const openedForMs = circuitOpenedAt === null ? 0 : Number(now()) - circuitOpenedAt;
    if (circuitOpenedAt !== null && openedForMs < circuitResetMs) {
      throw Object.assign(new Error('HERMES_CIRCUIT_OPEN'), { code: 'HERMES_CIRCUIT_OPEN' });
    }
    if (circuitOpenedAt !== null && halfOpenProbeRunning) {
      throw Object.assign(new Error('HERMES_CIRCUIT_OPEN'), { code: 'HERMES_CIRCUIT_OPEN' });
    }
    if (circuitOpenedAt !== null) halfOpenProbeRunning = true;
    const args = [
      'chat', '-q', promptFor({ question: normalizedQuestion, safeRecentContext }),
      '-Q', '--source', 'tool', '--max-turns', '1', '--ignore-rules', '-t', 'none',
      ...(normalizedSessionId ? ['--resume', normalizedSessionId] : []),
    ];
    try {
      const result = await invoke(execFile, command, args, {
        timeout: Math.min(30_000, Math.max(1_000, Number(timeoutMs) || 20_000)),
        maxBuffer: 128 * 1_024,
        windowsHide: true,
        env,
      });
      const returnedSessionId = boundedText(result.stderr.match(/(?:^|\n)session_id:\s*([^\s]+)/u)?.[1], 200);
      if (!returnedSessionId || (normalizedSessionId && returnedSessionId !== normalizedSessionId)) {
        throw Object.assign(new Error('HERMES_SESSION_MISMATCH'), { code: 'HERMES_SESSION_MISMATCH' });
      }
      const response = {
        sessionId: returnedSessionId,
        ...normalizeProviderOutput(parseJsonOutput(result.stdout), normalizedQuestion),
      };
      consecutiveFailures = 0;
      circuitOpenedAt = null;
      return response;
    } catch (error) {
      if (error?.code !== 'HERMES_SESSION_NOT_FOUND') {
        consecutiveFailures += 1;
        if (consecutiveFailures >= Math.max(1, Number(failureThreshold) || 5)) {
          circuitOpenedAt = Number(now());
        }
      }
      throw error;
    } finally {
      halfOpenProbeRunning = false;
    }
  }

  return { runTurn };
}
