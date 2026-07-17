import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  HERMES_DOMAIN_TOOL_DEFINITIONS,
  createHermesDomainMcpServer,
  executeHermesDomainTool,
  validateHermesDomainToolInput,
} from '../server/hermes-domain-mcp-server.mjs';

test('MCP bridge registers exactly the two public domain tools and no resources or prompts', async () => {
  const server = createHermesDomainMcpServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      'ask_insurance_expert',
      'ask_sales_champion',
    ]);
    assert.deepEqual(HERMES_DOMAIN_TOOL_DEFINITIONS.map((tool) => tool.name).sort(), listed.tools.map((tool) => tool.name).sort());
    await assert.rejects(client.listResources(), /Method not found/u);
    await assert.rejects(client.listPrompts(), /Method not found/u);
  } finally {
    await client.close();
  }
});

test('tool validation permits only explicit operations, natural names, and opaque context refs', () => {
  assert.deepEqual(validateHermesDomainToolInput('ask_insurance_expert', {
    question: '康健无忧主要保什么？',
    operation: 'product_knowledge',
    names: ['康健无忧两全保险', '新华保险'],
    contextRefs: ['ctx_family_alpha'],
    queryAspects: ['product_advantages'],
  }), {
    question: '康健无忧主要保什么？',
    operation: 'product_knowledge',
    names: ['康健无忧两全保险', '新华保险'],
    contextRefs: ['ctx_family_alpha'],
    queryAspects: ['product_advantages'],
  });
  assert.deepEqual(validateHermesDomainToolInput('ask_sales_champion', {
    question: '下一步怎么沟通？', operation: 'sales_coaching',
    productMentions: ['新华保险的康健华尊'], officialFactNeeds: ['renewal'],
  }), {
    question: '下一步怎么沟通？', operation: 'sales_coaching',
    productMentions: ['新华保险的康健华尊'], officialFactNeeds: ['renewal'],
  });

  for (const forbiddenKey of ['internalUserId', 'userId', 'familyId', 'policyId', 'permissions']) {
    assert.throws(() => validateHermesDomainToolInput('ask_insurance_expert', {
      question: '查询', operation: 'coverage_report', [forbiddenKey]: 7,
    }), (error) => error.code === 'OCR_AGENT_TOOL_INPUT_INVALID');
  }
  assert.throws(() => validateHermesDomainToolInput('ask_insurance_expert', {
    question: '查询', operation: 'sales_report',
  }), (error) => error.code === 'OCR_AGENT_TOOL_INPUT_INVALID');
  assert.throws(() => validateHermesDomainToolInput('ask_sales_champion', {
    question: '查询', operation: 'coverage_report',
  }), (error) => error.code === 'OCR_AGENT_TOOL_INPUT_INVALID');
  assert.throws(() => validateHermesDomainToolInput('ask_sales_champion', {
    question: '查询', operation: 'sales_report', contextRefs: ['9'],
  }), (error) => error.code === 'OCR_AGENT_TOOL_INPUT_INVALID');
  assert.throws(() => validateHermesDomainToolInput('ask_insurance_expert', {
    question: '查询', operation: 'product_knowledge', queryAspects: ['unknown'],
  }), (error) => error.code === 'OCR_AGENT_TOOL_INPUT_INVALID');
  assert.throws(() => validateHermesDomainToolInput('ask_insurance_expert', {
    question: '查询', operation: 'product_knowledge', productMentions: ['康健华尊'],
  }), (error) => error.code === 'OCR_AGENT_TOOL_INPUT_INVALID');
});

test('gateway execution sends the capability only as authorization and returns JSON', async () => {
  const calls = [];
  const result = await executeHermesDomainTool('ask_sales_champion', {
    question: '生成销售建议', operation: 'sales_report', contextRefs: ['ctx_family_alpha'],
  }, {
    env: {
      OCR_AGENT_TOOL_GATEWAY_URL: 'http://127.0.0.1:4207/internal/agent-tools',
      OCR_AGENT_TOOL_CAPABILITY: 'secret-capability',
    },
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return { ok: true, async json() { return { answer: '建议先补充资料' }; } };
    },
  });
  assert.deepEqual(result, { answer: '建议先补充资料' });
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret-capability');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    tool: 'ask_sales_champion',
    input: {
      question: '生成销售建议', operation: 'sales_report', contextRefs: ['ctx_family_alpha'],
    },
  });
  assert.doesNotMatch(calls[0].options.body, /secret-capability/u);
});

test('gateway timeout and failures use stable errors without leaking capability or response bodies', async () => {
  const env = {
    OCR_AGENT_TOOL_GATEWAY_URL: 'https://gateway.test/internal/agent-tools',
    OCR_AGENT_TOOL_CAPABILITY: 'never-leak-this-token',
  };
  await assert.rejects(executeHermesDomainTool('ask_insurance_expert', {
    question: '查询责任', operation: 'coverage_report',
  }, {
    env,
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error(`aborted never-leak-this-token`)));
    }),
  }), (error) => error.code === 'OCR_AGENT_TOOL_GATEWAY_TIMEOUT'
    && !error.message.includes('never-leak-this-token'));

  await assert.rejects(executeHermesDomainTool('ask_insurance_expert', {
    question: '查询责任', operation: 'coverage_report',
  }, {
    env,
    async fetchImpl() {
      return { ok: false, status: 403, async json() { return { detail: 'token never-leak-this-token' }; } };
    },
  }), (error) => error.code === 'OCR_AGENT_TOOL_GATEWAY_FAILED'
    && !error.message.includes('never-leak-this-token'));
});
