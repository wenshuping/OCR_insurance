import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { redactDeepSeekDirectIdentifiers } from './deepseek-privacy-gateway.mjs';
import { normalizeAgentContextFactBlock } from './agent-context-fact-block.service.mjs';

const DEFAULT_MAX_TURNS = 4;
const DEFAULT_DECISION_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_GRACE_MS = 10_000;
const TOOLSET = 'ocr-insurance-domain';

function clientError(code) {
  return Object.assign(new Error(code), { code });
}

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

function normalizeMaxTurns(value) {
  const turns = Number(value ?? DEFAULT_MAX_TURNS);
  if (!Number.isInteger(turns) || turns < 2 || turns > 6) {
    throw new TypeError('Hermes agent maxTurns must be an integer between 2 and 6');
  }
  return turns;
}

function normalizeGatewayUrl(value) {
  const normalized = boundedText(value, 2_048);
  if (!normalized) throw clientError('HERMES_AGENT_LOOP_UNAVAILABLE');
  try {
    const url = new URL(normalized);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid');
    return url.toString();
  } catch {
    throw clientError('HERMES_AGENT_LOOP_UNAVAILABLE');
  }
}

function invoke(execFile, command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || '');
        const code = error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
          ? 'HERMES_ABORTED'
          : /Session not found:/u.test(detail)
          ? 'HERMES_SESSION_NOT_FOUND'
          : error?.code === 'ENOENT' ? 'HERMES_CLI_UNAVAILABLE'
            : error?.killed || ['SIGTERM', 'SIGKILL'].includes(error?.signal)
              ? 'HERMES_TIMEOUT' : 'HERMES_PROVIDER_FAILED';
        reject(Object.assign(clientError(code), { cause: error }));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function promptFor({ question, safeRecentContext }) {
  const history = (Array.isArray(safeRecentContext?.history) ? safeRecentContext.history : [])
    .slice(-6)
    .flatMap((item) => {
      const role = ['user', 'assistant'].includes(item?.role) ? item.role : '';
      const content = boundedText(redactDeepSeekDirectIdentifiers(item?.content), 1_000);
      return role && content ? [{ role, content }] : [];
    });
  const activeProductName = boundedText(redactDeepSeekDirectIdentifiers(
    safeRecentContext?.activeEntities?.product?.officialName,
  ), 200);
  const previousProductName = boundedText(redactDeepSeekDirectIdentifiers(
    safeRecentContext?.activeEntities?.previousProduct?.officialName,
  ), 200);
  const activeEntities = {
    ...(activeProductName ? { product: { officialName: activeProductName } } : {}),
    ...(previousProductName ? { previousProduct: { officialName: previousProductName } } : {}),
  };
  const factBlock = safeRecentContext?.factBlock
    ? normalizeAgentContextFactBlock(safeRecentContext.factBlock)
    : null;
  return [
    '你是 OCR Insurance 的受控对话 Agent。请理解当前问题和最近对话，自主完成本轮回答。',
    '你只有两个保险业务工具：ask_insurance_expert 和 ask_sales_champion。不得假设存在其他业务工具。',
    '涉及保险产品、责任、条款、保单、保障、家庭保险数据或销售建议等事实时，必须调用合适的领域工具；不得凭模型记忆臆造。',
    ...(factBlock ? [`VERIFIED_FACT_BLOCK=${JSON.stringify(factBlock)}`] : []),
    '先结合当前问题、最近对话和 ACTIVE_ENTITIES 消解省略的主语与指代，再决定任务和工具参数；ACTIVE_ENTITIES 是当前会话已核验且仍有效的实体。',
    '用户延续上一任务且省略实体时，应补用对应的 ACTIVE_ENTITIES；任务需要多个实体时，只补齐缺失角色，不得覆盖用户本轮明确提供的实体。',
    'ACTIVE_ENTITIES 只能补齐本轮省略的实体；只要用户本轮出现新的产品名称、简称、俗称或其他产品线索，就必须优先按该新线索调用工具，不得把它覆盖到本轮新出现的产品线索。',
    'ACTIVE_ENTITIES.previousProduct 表示上一轮确认过的产品，只是可供语义理解的历史事实。你应根据用户本轮原话自行判断它是主语、比较对象还是与本轮无关；不得默认把它当作当前产品。',
    '用户提供的产品简称、俗称、残缺名称、疑似错别字或仅一段产品线索，也属于已提供产品实体；必须将该线索原样放入 names 调用 ask_insurance_expert，由工具检索正式产品和候选项，不得先要求用户补充正式名称。用户只发送这一段产品线索时，也视为产品查询。',
    '如果完成任务所需的实体没有可用上下文、存在多个可能解释或无法确定指代，直接提出一个具体澄清问题，不得猜测。',
    '调用产品知识时，names 只填写彼此独立的保险产品名称；同一产品下的计划、版本、档位或可选责任不是多款产品，names 应只填写一次共同的产品名称，并在 question 中保留要比较的计划或版本。',
    '调用产品知识时必须原样保留用户的问题；明确时可填写 queryAspects 作为语义提示，不确定时省略，由保险专家依据原问题判断。不得把优势问题改写成责任问题。',
    '领域工具返回的事实、证据、限制、权限结果和澄清要求是权威结果，不得篡改或补写不存在的结论。',
    '同一轮中，相同工具和相同参数成功或失败后均不得重复调用；已有成功结果时应直接据此完成回复。',
    '信息不足时应向用户提出具体澄清问题；普通寒暄可以直接自然回答。',
    '完成必要工具调用后直接输出给用户的最终回复，不要输出意图分类 JSON、工具调用说明或隐藏推理。',
    `ACTIVE_ENTITIES=${JSON.stringify(activeEntities)}`,
    `SAFE_RECENT_CONTEXT=${JSON.stringify(history)}`,
    `USER_QUESTION=${JSON.stringify(redactDeepSeekDirectIdentifiers(question))}`,
  ].join('\n');
}

function lastSessionId(stderr) {
  const matches = [...String(stderr || '').matchAll(/(?:^|\n)session_id:\s*([^\s]+)/gu)];
  return boundedText(matches.at(-1)?.[1], 200);
}

function finalReplyFromStdout(stdout) {
  const withoutAnsi = String(stdout || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
  return boundedText(withoutAnsi.split(/\r?\n/u)
    .filter((line) => !/tirith security scanner enabled but not available/iu.test(line))
    .join('\n'), 20_000);
}

export function createHermesAgentLoopClient({
  env = process.env,
  execFile = nodeExecFile,
  command = defaultCommand(env),
  hermesHome = env?.HERMES_HOME,
  toolset = env?.HERMES_AGENT_LOOP_TOOLSET || TOOLSET,
  maxTurns = DEFAULT_MAX_TURNS,
  timeoutMs = Number(env?.HERMES_AGENT_LOOP_TIMEOUT_MS) || DEFAULT_DECISION_TIMEOUT_MS,
  startupGraceMs = Number(env?.HERMES_AGENT_LOOP_STARTUP_GRACE_MS) || DEFAULT_STARTUP_GRACE_MS,
  failureThreshold = 5,
  circuitResetMs = 30_000,
  now = Date.now,
} = {}) {
  const dedicatedHome = boundedText(hermesHome, 1_000);
  if (!dedicatedHome || !path.isAbsolute(dedicatedHome)) {
    throw clientError('HERMES_AGENT_LOOP_UNAVAILABLE');
  }
  const configuredMaxTurns = normalizeMaxTurns(maxTurns);
  const configuredToolset = boundedText(toolset, 100);
  if (!configuredToolset) throw clientError('HERMES_AGENT_LOOP_UNAVAILABLE');
  const configuredTimeoutMs = Math.min(
    120_000,
    Math.max(1_000, Number(timeoutMs) || DEFAULT_DECISION_TIMEOUT_MS),
  );
  const configuredStartupGraceMs = Math.min(
    20_000,
    Math.max(0, Number(startupGraceMs) || 0),
  );
  const processTimeoutMs = configuredTimeoutMs + configuredStartupGraceMs;
  let consecutiveFailures = 0;
  let circuitOpenedAt = null;
  let halfOpenProbeRunning = false;

  async function runTurn({
    sessionId = '', question, capability, gatewayUrl, safeRecentContext = {}, signal,
  } = {}) {
    const normalizedQuestion = boundedText(question, 1_000);
    if (!normalizedQuestion) throw new TypeError('Hermes agent question is required');
    const normalizedSessionId = sessionId ? boundedText(sessionId, 200) : '';
    if (sessionId && !normalizedSessionId) throw new TypeError('Hermes agent session id is invalid');
    const normalizedCapability = boundedText(capability, 4_096);
    if (!normalizedCapability) throw clientError('HERMES_AGENT_LOOP_UNAVAILABLE');
    const normalizedGatewayUrl = normalizeGatewayUrl(gatewayUrl);
    const openedForMs = circuitOpenedAt === null ? 0 : Number(now()) - circuitOpenedAt;
    if (circuitOpenedAt !== null && openedForMs < circuitResetMs) {
      throw clientError('HERMES_CIRCUIT_OPEN');
    }
    if (circuitOpenedAt !== null && halfOpenProbeRunning) {
      throw clientError('HERMES_CIRCUIT_OPEN');
    }
    if (circuitOpenedAt !== null) halfOpenProbeRunning = true;
    const args = [
      'chat', '-q', promptFor({ question: normalizedQuestion, safeRecentContext }),
      '-Q', '--source', 'tool', '--max-turns', String(configuredMaxTurns),
      '--ignore-rules', '-t', configuredToolset,
      ...(normalizedSessionId ? ['--resume', normalizedSessionId] : []),
    ];
    try {
      const result = await invoke(execFile, command, args, {
        timeout: processTimeoutMs,
        maxBuffer: 256 * 1_024,
        windowsHide: true,
        ...(signal ? { signal } : {}),
        env: {
          ...env,
          HERMES_HOME: dedicatedHome,
          OCR_AGENT_TOOL_CAPABILITY: normalizedCapability,
          OCR_AGENT_TOOL_GATEWAY_URL: normalizedGatewayUrl,
        },
      });
      const finalReply = finalReplyFromStdout(result.stdout);
      const returnedSessionId = lastSessionId(result.stderr);
      if (!finalReply || !returnedSessionId) throw clientError('HERMES_RESPONSE_INVALID');
      consecutiveFailures = 0;
      circuitOpenedAt = null;
      return { sessionId: returnedSessionId, finalReply };
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= Math.max(1, Number(failureThreshold) || 5)) {
        circuitOpenedAt = Number(now());
      }
      throw error;
    } finally {
      halfOpenProbeRunning = false;
    }
  }

  return Object.freeze({ runTurn });
}
