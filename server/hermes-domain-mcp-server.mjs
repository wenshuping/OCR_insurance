import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { SEMANTIC_QUERY_ASPECTS } from './agent-semantic-contract.mjs';

const TOOL_OPERATIONS = Object.freeze({
  ask_insurance_expert: Object.freeze(['product_knowledge', 'family_summary', 'coverage_report']),
  ask_sales_champion: Object.freeze(['sales_report', 'sales_coaching']),
});
const TOOL_NAMES = Object.freeze(Object.keys(TOOL_OPERATIONS));
const OPAQUE_REF = /^[A-Za-z][A-Za-z0-9_-]{7,199}$/u;
const DEFAULT_TOOL_GATEWAY_TIMEOUT_MS = 100_000;

function inputSchemaFor(name, operations) {
  return z.object({
    question: z.string().trim().min(1).max(1_000),
    operation: z.enum(operations),
    names: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
    contextRefs: z.array(z.string().regex(OPAQUE_REF)).max(10).optional(),
    ...(name === 'ask_insurance_expert'
      ? {
        queryAspects: z.array(z.enum(SEMANTIC_QUERY_ASPECTS)).max(8).optional(),
        searchOnline: z.boolean().optional(),
      }
      : {}),
    ...(name === 'ask_sales_champion'
      ? {
        productMentions: z.array(z.string().trim().min(1).max(200)).max(5).optional(),
        officialFactNeeds: z.array(z.enum(SEMANTIC_QUERY_ASPECTS)).max(8).optional(),
      }
      : {}),
  }).strict();
}

export const HERMES_DOMAIN_TOOL_DEFINITIONS = Object.freeze(TOOL_NAMES.map((name) => Object.freeze({
  name,
  description: name === 'ask_insurance_expert'
    ? '查询经过授权和证据校验的保险事实。operation 选择 product_knowledge、family_summary 或 coverage_report；question 必须保留用户的自然语言原意。queryAspects 可在明确时补充，例如保险责任用 main_responsibilities、产品优势用 product_advantages、产品对比用 comparison，但不确定时可以省略，由保险专家依据原问题判断。names 按问题顺序填写彼此独立的产品名或家庭名，不得填写内部 ID。同一产品下的计划、版本、档位或可选责任不是多款产品，产品名只填一次，具体计划保留在 question。用户明确拒绝上一轮全部产品候选时，保留原产品线索并设置 searchOnline=true。'
    : '查询当前账号有权访问的销售建议。operation 选择 sales_report 或 sales_coaching；names 只填写家庭名称，不得填写产品名或内部 ID。开放式客户跟进、需求分析、异议处理和沟通话术使用 sales_coaching，即使问题中出现保险公司或产品名称也不改变销售主任务；把明确出现的产品名称放入 productMentions。只有销售回答确实依赖责任、续保、等待期等官方产品事实时，才用 officialFactNeeds 声明需要保险专家核验的维度。',
  operations: TOOL_OPERATIONS[name],
  inputSchema: inputSchemaFor(name, TOOL_OPERATIONS[name]),
})));

function stableError(code) {
  return Object.assign(new Error(code), { code });
}

export function validateHermesDomainToolInput(toolName, value) {
  const definition = HERMES_DOMAIN_TOOL_DEFINITIONS.find((item) => item.name === toolName);
  if (!definition) throw stableError('OCR_AGENT_TOOL_NOT_ALLOWED');
  const parsed = definition.inputSchema.safeParse(value);
  if (!parsed.success) throw stableError('OCR_AGENT_TOOL_INPUT_INVALID');
  return parsed.data;
}

function gatewayConfig(env) {
  const rawUrl = String(env?.OCR_AGENT_TOOL_GATEWAY_URL || '').trim();
  const capability = String(env?.OCR_AGENT_TOOL_CAPABILITY || '').trim();
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw stableError('OCR_AGENT_TOOL_GATEWAY_NOT_CONFIGURED');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !capability) {
    throw stableError('OCR_AGENT_TOOL_GATEWAY_NOT_CONFIGURED');
  }
  return { url: url.href, capability };
}

export async function executeHermesDomainTool(toolName, value, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs,
} = {}) {
  const input = validateHermesDomainToolInput(toolName, value);
  const { url, capability } = gatewayConfig(env);
  if (typeof fetchImpl !== 'function') throw stableError('OCR_AGENT_TOOL_GATEWAY_FAILED');
  const configuredTimeoutMs = Math.max(
    1_000,
    Math.min(120_000, Number(timeoutMs ?? env?.OCR_AGENT_TOOL_TIMEOUT_MS) || DEFAULT_TOOL_GATEWAY_TIMEOUT_MS),
  );
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), configuredTimeoutMs);
  timeoutId.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${capability}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tool: toolName, input }),
      signal: controller.signal,
    });
    if (!response?.ok) throw stableError('OCR_AGENT_TOOL_GATEWAY_FAILED');
    let result;
    try {
      result = await response.json();
    } catch {
      throw stableError('OCR_AGENT_TOOL_GATEWAY_FAILED');
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw stableError('OCR_AGENT_TOOL_GATEWAY_FAILED');
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw stableError('OCR_AGENT_TOOL_GATEWAY_TIMEOUT');
    if (error?.code === 'OCR_AGENT_TOOL_GATEWAY_FAILED') throw error;
    throw stableError('OCR_AGENT_TOOL_GATEWAY_FAILED');
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createHermesDomainMcpServer(options = {}) {
  const server = new McpServer({ name: 'ocr-insurance-domain', version: '1.0.0' });
  for (const definition of HERMES_DOMAIN_TOOL_DEFINITIONS) {
    server.registerTool(definition.name, {
      description: definition.description,
      inputSchema: definition.inputSchema,
    }, async (input) => {
      try {
        const result = await executeHermesDomainTool(definition.name, input, options);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: String(error?.code || 'OCR_AGENT_TOOL_GATEWAY_FAILED') }],
          isError: true,
        };
      }
    });
  }
  return server;
}

export async function startHermesDomainMcpServer(options = {}) {
  const server = createHermesDomainMcpServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startHermesDomainMcpServer();
}
