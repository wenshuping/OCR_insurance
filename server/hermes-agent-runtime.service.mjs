import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MAX_ANSWER_CHARS = 20_000;

function runtimeError(code, status = 502) {
  return Object.assign(new Error(code), { code, status });
}

function sessionName(dingUserId) {
  return `dingtalk-insurance-${createHash('sha256').update(String(dingUserId)).digest('hex').slice(0, 24)}`;
}

function agentPrompt(text) {
  return [
    '你是 OCR Insurance 的钉钉保险顾问 Agent。',
    '理解用户自然语言后，自主选择 OCR Insurance MCP 工具；涉及家庭时先列出可访问家庭，再按名称、编号或上下文选择，绝不猜测业务数据。',
    '查询数量、保单或家庭事实必须调用工具。保险结论必须调用保险专家或销冠工具。回答简洁、自然，不要提 MCP、工具调用或内部实现。',
    `用户消息：${String(text || '').slice(0, 4_000)}`,
  ].join('\n');
}

export function createHermesTextAgent({ command = 'insuranceagent', execFileImpl = execFile, timeoutMs = 120_000 } = {}) {
  return async function answerText({ dingUserId, text }) {
    const principal = String(dingUserId || '').trim();
    if (!principal) throw runtimeError('HERMES_PRINCIPAL_REQUIRED', 400);
    try {
      const result = await execFileImpl(command, [
        '--oneshot', agentPrompt(text),
        '--continue', sessionName(principal),
        '--ignore-rules',
      ], {
        env: { ...process.env, OCR_INSURANCE_DING_USER_ID: principal },
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
      });
      const answer = String(result?.stdout || '').trim();
      if (!answer) throw runtimeError('HERMES_EMPTY_RESPONSE');
      return answer.slice(0, MAX_ANSWER_CHARS);
    } catch (error) {
      if (error?.code === 'HERMES_EMPTY_RESPONSE') throw error;
      throw runtimeError(error?.killed ? 'HERMES_TIMEOUT' : 'HERMES_AGENT_FAILED', error?.killed ? 504 : 502);
    }
  };
}
