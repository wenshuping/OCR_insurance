import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { candidateFromText, createDingtalkAgentGateway, createSignedAgentRequest } from '../server/dingtalk-agent-gateway.service.mjs';
import * as dingtalkRuntime from '../server/dingtalk-agent-gateway.mjs';

test('natural DingTalk questions route to distinct safe intents', () => {
  assert.deepEqual(candidateFromText('余贵祥家庭有几个保单'), {
    intent: 'family_summary', question: '余贵祥家庭有几个保单', confidence: 1, requestedOperation: 'read',
    entities: { familyName: '余贵祥家庭' },
  });
  assert.deepEqual(candidateFromText('现在有几个家庭'), {
    intent: 'family_list', question: '现在有几个家庭', confidence: 1, requestedOperation: 'read',
  });
  assert.equal(candidateFromText('查看余贵祥家庭保障报告').intent, 'coverage_report');
  assert.equal(candidateFromText('余贵祥家庭下一步怎么聊').intent, 'sales_coaching');
  assert.equal(candidateFromText('新华的荣耀鑫享保险责任').entities.productName, '新华的荣耀鑫享');
  assert.equal(
    candidateFromText('国寿如E康悦百万医疗保险（A款） 对比 新华保险的康健长佑').intent,
    'insurance_product_knowledge',
  );
  assert.deepEqual(candidateFromText('国寿有哪些在售的百万医疗'), {
    intent: 'insurance_product_knowledge', question: '国寿有哪些在售的百万医疗', confidence: 1, requestedOperation: 'read',
    entities: { productName: '国寿百万医疗' },
  });
});

test('signed agent request signs the exact serialized body', () => {
  const body = { channel: 'dingtalk', channelMobile: '13800138000' };
  const request = createSignedAgentRequest({ secret: 'test-secret', timestamp: 1_720_000_000_000, body });
  assert.equal(request.headers['x-agent-timestamp'], '1720000000000');
  assert.equal(request.headers['x-agent-signature'], createHmac('sha256', 'test-secret')
    .update(`1720000000000.${request.rawBody}`).digest('hex'));
});

test('DingTalk mobile resolver reuses a recent verified profile lookup', async () => {
  let now = 1_720_000_000_000;
  let profileLookups = 0;
  const resolver = dingtalkRuntime.createDingtalkMobileResolver({
    client: { async getAccessToken() { return 'token'; } },
    now: () => now,
    cacheTtlMs: 300_000,
    fetchImpl: async () => {
      profileLookups += 1;
      return { ok: true, json: async () => ({ errcode: 0, result: { mobile: '13800138000' } }) };
    },
  });
  assert.equal(await resolver('ding-7'), '13800138000');
  assert.equal(await resolver('ding-7'), '13800138000');
  assert.equal(profileLookups, 1);
  now += 300_000;
  assert.equal(await resolver('ding-7'), '13800138000');
  assert.equal(profileLookups, 2);
});

test('DingTalk runtime wires process termination to gateway shutdown', async () => {
  assert.equal(typeof dingtalkRuntime.installDingtalkShutdownHandlers, 'function');
  const handlers = {};
  const events = [];
  const stop = dingtalkRuntime.installDingtalkShutdownHandlers({
    processLike: { once(signal, handler) { handlers[signal] = handler; } },
    client: { disconnect() { events.push('disconnect'); } },
    gateway: { async shutdown() { events.push('shutdown'); } },
  });

  assert.equal(typeof handlers.SIGTERM, 'function');
  assert.equal(typeof handlers.SIGINT, 'function');
  await stop();
  assert.deepEqual(events, ['disconnect', 'shutdown']);
});

test('production DingTalk gateway sends only signed raw text to the messages API', async () => {
  const requests = [];
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', useMessagesApi: true,
    now: () => 1_720_000_000_000,
    getDingtalkMobile: async () => '13800138000',
    interpretQuestion: async () => { throw new Error('gateway must not interpret'); },
    conversationContext: {
      async loadContext() { throw new Error('gateway must not load context'); },
      async commitContext() { throw new Error('gateway must not commit context'); },
    },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return String(url).includes('/api/agent/messages')
        ? { ok: true, json: async () => ({ decision: 'execute', interaction: { type: 'answer', text: '已处理' } }) }
        : { ok: true, json: async () => ({}) };
    },
  });
  await gateway.handle({
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7', conversationId: 'conv-7',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text', msgId: 'raw-7',
    text: { content: '他和医药安欣对比呢' },
  });
  assert.match(requests[0].url, /\/api\/agent\/messages$/u);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    protocolVersion: '1', channel: 'dingtalk', channelUserId: 'ding-7', channelMobile: '13800138000',
    messageRef: 'raw-7', conversationId: 'conv-7', message: { type: 'text', text: '他和医药安欣对比呢' },
  });
  assert.equal(JSON.parse(requests[0].options.body).candidate, undefined);
  assert.equal(JSON.parse(requests[0].options.body).history, undefined);
});

test('production DingTalk gateway acknowledges a slow Agent request before the final reply', async () => {
  const replies = [];
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', useMessagesApi: true,
    progressDelayMs: 5,
    getDingtalkMobile: async () => '13800138000',
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/agent/messages')) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true, json: async () => ({ decision: 'execute', interaction: { type: 'answer', text: '最终答复' } }) };
      }
      replies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({}) };
    },
  });

  await gateway.handle({
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7', conversationId: 'conv-7',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text', msgId: 'slow-7',
    text: { content: '康健无忧两全保险主要保什么' },
  });

  assert.equal(replies.length, 2);
  assert.match(replies[0].text.content, /正在理解并查询/u);
  assert.equal(replies[1].text.content, '最终答复');
});

test('production DingTalk gateway notifies an active customer when shutdown interrupts the request', async () => {
  const replies = [];
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', useMessagesApi: true,
    progressDelayMs: 60_000, agentRequestTimeoutMs: 20,
    getDingtalkMobile: async () => '13800138000',
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/agent/messages')) {
        requestStarted();
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      replies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({}) };
    },
  });
  const handling = gateway.handle({
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7', conversationId: 'conv-7',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text', msgId: 'shutdown-7',
    text: { content: '医药安欣保险责任' },
  });

  await started;
  await gateway.shutdown();
  await handling;

  assert.equal(replies.length, 1);
  assert.match(replies[0].text.content, /服务正在更新/u);
  assert.match(replies[0].text.content, /重新发送/u);
});

test('production DingTalk gateway retries a timed out session webhook reply', async () => {
  let replyAttempts = 0;
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', useMessagesApi: true, replyTimeoutMs: 5,
    getDingtalkMobile: async () => '13800138000',
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/agent/messages')) {
        return { ok: true, json: async () => ({ decision: 'execute', interaction: { type: 'answer', text: 'Hermes 已处理' } }) };
      }
      replyAttempts += 1;
      if (replyAttempts === 1) {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return { ok: true, json: async () => ({}) };
    },
  });

  await gateway.handle({
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7', conversationId: 'conv-7',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text', msgId: 'timeout-7',
    text: { content: '康健长佑保险责任' },
  });

  assert.equal(replyAttempts, 2);
});

test('production DingTalk gateway retries a rejected session webhook reply', async () => {
  let replyAttempts = 0;
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', useMessagesApi: true,
    getDingtalkMobile: async () => '13800138000',
    fetchImpl: async (url) => {
      if (String(url).includes('/api/agent/messages')) {
        return { ok: true, json: async () => ({ decision: 'execute', interaction: { type: 'answer', text: 'Hermes 已处理' } }) };
      }
      replyAttempts += 1;
      return replyAttempts === 1
        ? { ok: true, json: async () => ({ errcode: 310000, errmsg: 'send failed' }) }
        : { ok: true, json: async () => ({ errcode: 0, errmsg: 'ok' }) };
    },
  });

  await gateway.handle({
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7', conversationId: 'conv-7',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text', msgId: 'rejected-7',
    text: { content: '康健长佑保险责任' },
  });

  assert.equal(replyAttempts, 2);
});

test('DingTalk gateway sends a signed request with verified mobile and replies safely', async () => {
  const requests = [];
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1',
    hmacSecret: 'test-secret',
    now: () => 1_720_000_000_000,
    getDingtalkMobile: async () => '+86 138-0013-8000',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).includes('/api/agent/questions/route')) {
        return { ok: true, json: async () => ({ interaction: { type: 'answer', text: '已查询' } }) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  await gateway.handle({
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7',
    sessionWebhook: 'https://api.dingtalk.com/robot/sendBySession', msgtype: 'text',
    text: { content: ' 查家庭保单 ' }, msgId: 'msg-7', conversationId: 'conv-7',
  });
  const request = requests[0];
  const body = JSON.parse(request.options.body);
  assert.equal(body.channelMobile, '13800138000');
  assert.equal(body.channelUserId, 'ding-7');
  assert.equal(body.messageRef, 'msg-7');
  assert.equal(body.candidate.question, '查家庭保单');
  assert.equal(body.candidate.intent, 'family_summary');
  assert.equal(request.options.headers['x-agent-signature'], createHmac('sha256', 'test-secret')
    .update(`1720000000000.${request.options.body}`).digest('hex'));
  assert.deepEqual(JSON.parse(requests[1].options.body), { msgtype: 'text', text: { content: '已查询' } });
});

test('DingTalk gateway uses the model interpreter with recent conversation history', async () => {
  const interpreted = [];
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', getDingtalkMobile: async () => '13800138000',
    interpretQuestion: async (input) => {
      interpreted.push(input);
      return {
        intent: 'family_summary', question: input.question, confidence: 0.99, requestedOperation: 'read',
        entities: { familyName: '余贵祥家庭' },
      };
    },
    fetchImpl: async (url, options) => String(url).includes('/api/agent/questions/route')
      ? { ok: true, json: async () => ({ interaction: { type: 'answer', text: '已根据状态解释。' } }) }
      : { ok: true, json: async () => ({}) },
  });
  const base = {
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7', conversationId: 'conv-7',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text',
  };
  await gateway.handle({ ...base, msgId: 'msg-1', text: { content: '余贵祥家庭有几个保单' } });
  await gateway.handle({ ...base, msgId: 'msg-2', text: { content: '为啥0份有效' } });
  assert.equal(interpreted[0].history.length, 0);
  assert.match(JSON.stringify(interpreted[1].history), /余贵祥家庭有几个保单/u);
  assert.match(JSON.stringify(interpreted[1].history), /已根据状态解释/u);
});

test('DingTalk gateway honors the published fallback history message limit', async () => {
  const interpreted = [];
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', getDingtalkMobile: async () => '13800138000',
    getRuntimeSettings: async () => ({ fallbackHistoryMessageLimit: 2, productContextTtlMinutes: 30 }),
    interpretQuestion: async (input) => {
      interpreted.push(input);
      return { intent: 'chat', question: input.question, confidence: 1, requestedOperation: 'read' };
    },
    fetchImpl: async (url) => String(url).includes('/api/agent/questions/route')
      ? { ok: true, json: async () => ({ interaction: { type: 'answer', text: '收到。' } }) }
      : { ok: true, json: async () => ({}) },
  });
  const base = {
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7', conversationId: 'limited-history',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text',
  };
  await gateway.handle({ ...base, msgId: 'history-1', text: { content: '第一问' } });
  await gateway.handle({ ...base, msgId: 'history-2', text: { content: '第二问' } });
  await gateway.handle({ ...base, msgId: 'history-3', text: { content: '第三问' } });
  assert.equal(interpreted[2].recentMessageLimit, 2);
  assert.deepEqual(interpreted[2].history, [
    { role: 'user', content: '第二问' },
    { role: 'assistant', content: '收到。' },
  ]);
});

test('DingTalk gateway never shares fallback history between users with the same conversation id', async () => {
  const interpreted = [];
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', getDingtalkMobile: async () => '13800138000',
    interpretQuestion: async (input) => {
      interpreted.push(input);
      return { intent: 'chat', question: input.question, confidence: 1, requestedOperation: 'read' };
    },
    fetchImpl: async (url) => String(url).includes('/api/agent/questions/route')
      ? { ok: true, json: async () => ({ interaction: { type: 'answer', text: '收到。' } }) }
      : { ok: true, json: async () => ({}) },
  });
  const base = {
    senderCorpId: 'corp-1', conversationType: '1', conversationId: 'same-conversation',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text',
  };
  await gateway.handle({ ...base, senderStaffId: 'ding-a', msgId: 'isolation-1', text: { content: '用户甲的问题' } });
  await gateway.handle({ ...base, senderStaffId: 'ding-b', msgId: 'isolation-2', text: { content: '用户乙的问题' } });
  await gateway.handle({ ...base, senderStaffId: 'ding-a', msgId: 'isolation-3', text: { content: '用户甲追问' } });
  assert.deepEqual(interpreted[1].history, []);
  assert.match(JSON.stringify(interpreted[2].history), /用户甲的问题/u);
  assert.doesNotMatch(JSON.stringify(interpreted[2].history), /用户乙/u);
});

test('DingTalk gateway expires product pronouns using the published OCR context TTL', async () => {
  const routedCandidates = [];
  let currentTime = 1_720_000_000_000;
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', getDingtalkMobile: async () => '13800138000', now: () => currentTime,
    getRuntimeSettings: async () => ({ fallbackHistoryMessageLimit: 6, productContextTtlMinutes: 1 }),
    interpretQuestion: async ({ question }) => ({
      intent: 'insurance_product_knowledge', question, confidence: 1, requestedOperation: 'read',
      ...(question === '第一问' ? { entities: { productName: '测试医疗保险' } } : {}),
    }),
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/agent/questions/route')) {
        routedCandidates.push(JSON.parse(options.body).candidate);
        return { ok: true, json: async () => ({ interaction: { type: 'answer', text: routedCandidates.length === 1 ? '保险公司《测试医疗保险》：已查询。' : '请补充产品名称。' } }) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  const base = {
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7', conversationId: 'ttl-context',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text',
  };
  await gateway.handle({ ...base, msgId: 'ttl-1', text: { content: '第一问' } });
  currentTime += 61_000;
  await gateway.handle({ ...base, msgId: 'ttl-2', text: { content: '这个产品有啥优势' } });
  assert.equal(routedCandidates[1].entities?.productName, undefined);
});

test('DingTalk gateway routes an explicit product comparison to the insurance expert even when the model says chat', async () => {
  let routedCandidate;
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', getDingtalkMobile: async () => '13800138000',
    interpretQuestion: async ({ question }) => ({
      intent: 'chat', question, confidence: 0.99, requestedOperation: 'read',
    }),
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/agent/questions/route')) {
        routedCandidate = JSON.parse(options.body).candidate;
        return { ok: true, json: async () => ({ interaction: { type: 'answer', text: '已对比' } }) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });

  await gateway.handle({
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text',
    text: { content: '国寿如E康悦百万医疗保险（A款） 对比 新华保险的康健长佑' },
  });

  assert.equal(routedCandidate.intent, 'insurance_product_knowledge');
});

test('DingTalk gateway renders product comparison markdown as a mobile-friendly markdown message', async () => {
  const replies = [];
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', getDingtalkMobile: async () => '13800138000',
    interpretQuestion: async ({ question }) => ({
      intent: 'insurance_product_knowledge', question, confidence: 1, requestedOperation: 'read',
    }),
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/agent/questions/route')) {
        return { ok: true, json: async () => ({ interaction: {
          type: 'answer',
          text: '# 两款医疗险对比\n\n| 维度 | 如E康悦A款 | 康健长佑 |\n| --- | --- | --- |\n| 保障期限 | 1年 | 长期 |\n| 费率 | 固定一年 | 可调 |\n\n**结论**：按保障期限和费率机制选择。\n[官方资料](https://official.test/terms.pdf) [危险链接](http://unsafe.test)',
        } }) };
      }
      replies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({}) };
    },
  });

  await gateway.handle({
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text',
    text: { content: '国寿如E康悦百万医疗保险（A款） 对比 新华保险的康健长佑' },
  });

  assert.equal(replies[0].msgtype, 'markdown');
  assert.equal(replies[0].markdown.title, '保险产品对比');
  assert.match(replies[0].markdown.text, /#### 保障期限/u);
  assert.match(replies[0].markdown.text, /- \*\*如E康悦A款\*\*：1年/u);
  assert.match(replies[0].markdown.text, /\[官方资料\]\(https:\/\/official\.test\/terms\.pdf\)/u);
  assert.doesNotMatch(replies[0].markdown.text, /http:\/\/unsafe\.test/u);
  assert.doesNotMatch(replies[0].markdown.text, /\| --- \|/u);
});

test('DingTalk gateway renders a responsibility answer with the responsibility assistant card hierarchy', async () => {
  const replies = [];
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', getDingtalkMobile: async () => '13800138000',
    interpretQuestion: async ({ question }) => ({
      intent: 'insurance_product_knowledge', question, confidence: 1, requestedOperation: 'read',
    }),
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/agent/questions/route')) {
        return { ok: true, json: async () => ({ interaction: {
          type: 'answer',
          text: [
            '新华保险《康健无忧两全保险》：',
            '### 产品主要做什么',
            '提供满期生存和身故保障。',
            '### 健康管理服务',
            '上传资料补充了健康咨询服务。',
            '来源：M1',
            '### 责任明细（4项）',
            '1. **满期生存保险金**',
            '被保险人生存至保险期间届满时按约定给付。',
            '触发条件：被保险人生存至保险期间届满',
            '给付金额 = 主险保费 + 附加险保费',
            'calculationStatus: scheduled_cashflow',
            '来源：src_2',
            '计算所需保单信息：已交保险费、保险期间',
            '2. **身故保险金（180日内因疾病）**',
            '按合同约定给付。',
          ].join('\n'),
        } }) };
      }
      replies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({}) };
    },
  });

  await gateway.handle({
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text',
    text: { content: '康健无忧两全保险的保险责任' },
  });

  assert.equal(replies[0].msgtype, 'markdown');
  assert.equal(replies[0].markdown.title, '保险责任助手');
  assert.match(replies[0].markdown.text, /### 🛡️ 保险责任助手/u);
  assert.match(replies[0].markdown.text, /> 已生成 \*\*4 项责任摘要\*\*/u);
  assert.match(replies[0].markdown.text, /### 责任明细　4 项/u);
  assert.match(replies[0].markdown.text, /#### 健康管理服务/u);
  assert.match(replies[0].markdown.text, /上传资料补充了健康咨询服务/u);
  assert.match(replies[0].markdown.text, /来源：M1/u);
  assert.match(replies[0].markdown.text, /> \*\*①　满期生存保险金\*\*/u);
  assert.match(replies[0].markdown.text, /> \*\*触发条件：\*\*/u);
  assert.match(replies[0].markdown.text, /> \*\*给付金额 = 主险保费 \+ 附加险保费\*\*/u);
  assert.match(replies[0].markdown.text, /> `calculationStatus: scheduled_cashflow`/u);
  assert.match(replies[0].markdown.text, /> \*\*来源：\*\* `src_2`/u);
  assert.match(replies[0].markdown.text, /> \*\*所需保单信息：\*\* `已交保险费` `保险期间`/u);
  assert.match(replies[0].markdown.text, /---/u);
});

test('DingTalk gateway splits long responsibility cards without losing the answer tail', async () => {
  const replies = [];
  const longAnswer = [
    '新华保险《长文本测试保险》：',
    '### 产品主要做什么',
    ...Array.from({ length: 24 }, (_, index) => `第${index + 1}段产品说明：${'保障内容完整呈现。'.repeat(32)}`),
    '### 责任明细（1项）',
    '1. **身故保险金**',
    '被保险人身故时按合同约定给付。',
    '触发条件：被保险人身故',
    '给付金额 = 基本保险金额',
    'calculationStatus: claim_contingent',
    '来源：src_1#保险责任',
    '计算所需保单信息：基本保险金额、出险日期',
    '### 注意事项',
    '尾部完整标记：本段必须发送，不得截断。',
  ].join('\n');
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', getDingtalkMobile: async () => '13800138000',
    interpretQuestion: async ({ question }) => ({
      intent: 'insurance_product_knowledge', question, confidence: 1, requestedOperation: 'read',
    }),
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/agent/questions/route')) {
        return { ok: true, json: async () => ({ interaction: { type: 'answer', text: longAnswer } }) };
      }
      replies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({}) };
    },
  });

  await gateway.handle({
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text',
    text: { content: '长文本测试保险的保险责任' },
  });

  assert.ok(replies.length > 1);
  assert.ok(replies.every((reply) => reply.msgtype === 'markdown'));
  assert.ok(replies.every((reply) => reply.markdown.text.length <= 6_000));
  assert.match(replies.at(-1).markdown.text, /尾部完整标记：本段必须发送，不得截断。/u);
  assert.match(replies[1].markdown.title, /续 2\//u);
});

test('DingTalk gateway preserves verified product source links in the markdown reply', async () => {
  const replies = [];
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', getDingtalkMobile: async () => '13800138000',
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/agent/questions/route')) {
        return { ok: true, json: async () => ({
          interaction: { type: 'answer', text: '已核验 1 款候选产品：官网确认在售 1 款。\n\n#### 核验来源\n\n1. [中国人寿官方产品页](https://official.test/product)' },
        }) };
      }
      replies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({}) };
    },
  });

  await gateway.handle({
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text',
    text: { content: '国寿有哪些在售的百万医疗' },
  });

  assert.equal(replies[0].msgtype, 'markdown');
  assert.match(replies[0].markdown.text, /#### 核验来源/u);
  assert.match(replies[0].markdown.text, /\[中国人寿官方产品页\]\(https:\/\/official\.test\/product\)/u);
});

test('DingTalk gateway retries the last understood question when the user challenges comprehension', async () => {
  const routedCandidates = [];
  let interpretationCount = 0;
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', getDingtalkMobile: async () => '13800138000',
    now: () => 1_720_000_000_000 + routedCandidates.length,
    interpretQuestion: async ({ question }) => {
      interpretationCount += 1;
      return {
        intent: 'insurance_product_knowledge', question, confidence: 1, requestedOperation: 'read',
        entities: { productName: '康健长佑长期医疗保险' },
      };
    },
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/agent/questions/route')) {
        routedCandidates.push(JSON.parse(options.body).candidate);
        return { ok: true, json: async () => ({ interaction: { type: 'answer', text: '已回答。' } }) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  const base = {
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7', conversationId: 'understanding',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text',
  };

  await gateway.handle({ ...base, msgId: 'understanding-1', text: { content: '什么人适合 康健长佑长期医疗保险' } });
  await gateway.handle({ ...base, msgId: 'understanding-2', text: { content: '你听懂我说的吗' } });

  assert.equal(interpretationCount, 1);
  assert.deepEqual(routedCandidates[1], routedCandidates[0]);
});

test('DingTalk gateway keeps the previous product scope for an on-sale follow-up', async () => {
  const routedCandidates = [];
  let interpretationCount = 0;
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', getDingtalkMobile: async () => '13800138000',
    interpretQuestion: async ({ question }) => {
      interpretationCount += 1;
      return interpretationCount === 1
        ? { intent: 'insurance_product_knowledge', question, confidence: 1, requestedOperation: 'read', entities: { productName: '中国人寿的百万医疗' } }
        : { intent: 'insurance_product_knowledge', question, confidence: 0.9, requestedOperation: 'read' };
    },
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/agent/questions/route')) {
        routedCandidates.push(JSON.parse(options.body).candidate);
        return { ok: true, json: async () => ({ interaction: { type: 'answer', text: '已回答。' } }) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  const base = {
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7', conversationId: 'sales-status',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text',
  };

  await gateway.handle({ ...base, msgId: 'sales-status-1', text: { content: '中国人寿的百万医疗' } });
  await gateway.handle({ ...base, msgId: 'sales-status-2', text: { content: '在售的有哪些' } });

  assert.equal(routedCandidates[1].question, '在售的有哪些');
  assert.equal(routedCandidates[1].entities.productName, '中国人寿的百万医疗');
});

test('DingTalk gateway reuses the last canonical product when the model misses a product pronoun', async () => {
  const routedCandidates = [];
  let interpretationCount = 0;
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', getDingtalkMobile: async () => '13800138000',
    now: () => 1_720_000_000_000 + interpretationCount,
    interpretQuestion: async ({ question }) => {
      interpretationCount += 1;
      return interpretationCount === 1
        ? {
          intent: 'insurance_product_knowledge', question, confidence: 1, requestedOperation: 'read',
          entities: { productName: '新华保险尊享人生年金保险（分红型）' },
        }
        : { intent: 'insurance_product_knowledge', question, confidence: 0.1, requestedOperation: 'read' };
    },
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/agent/questions/route')) {
        routedCandidates.push(JSON.parse(options.body).candidate);
        return {
          ok: true,
          json: async () => ({ interaction: { type: 'answer', text: routedCandidates.length === 1
            ? '新华保险《尊享人生年金保险（分红型）》：提供年金保障。'
            : '主要优势是长期现金流。' } }),
        };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  const base = {
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7', conversationId: 'conv-product',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text',
  };

  await gateway.handle({ ...base, msgId: 'product-1', text: { content: '新华保险尊享人生年金保险保什么' } });
  await gateway.handle({ ...base, msgId: 'product-2', text: { content: '这个产品有啥优势呀' } });

  assert.equal(routedCandidates[1].entities.productName, '尊享人生年金保险（分红型）');
  assert.equal('familyName' in routedCandidates[1].entities, false);
});

test('DingTalk gateway expands a comparison pronoun to the last canonical product', async () => {
  const routedCandidates = [];
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', getDingtalkMobile: async () => '13800138000',
    interpretQuestion: async ({ question }) => ({
      intent: 'insurance_product_knowledge', question, confidence: 1, requestedOperation: 'read',
      entities: { productName: question.includes('康健长佑') ? '康健长佑' : '国寿如E康悦百万医疗保险（A款）' },
    }),
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/agent/questions/route')) {
        routedCandidates.push(JSON.parse(options.body).candidate);
        return { ok: true, json: async () => ({ interaction: { type: 'answer', text: routedCandidates.length === 1
          ? '已找到这款产品的医疗保障资料。'
          : '已完成两款产品对比。' } }) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  const base = {
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7', conversationId: 'conv-comparison-pronoun',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text',
  };

  await gateway.handle({ ...base, msgId: 'comparison-product-1', text: { content: '国寿如E康悦百万医疗保险（A款）保险责任' } });
  await gateway.handle({ ...base, msgId: 'comparison-product-2', text: { content: '他 和 康健长佑对比呢' } });

  assert.equal(
    routedCandidates[1].question,
    '国寿如E康悦百万医疗保险（A款） 和 康健长佑对比呢',
  );
});

test('DingTalk gateway falls back locally when the model interpreter fails', async () => {
  let routedCandidate;
  const errors = [];
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', getDingtalkMobile: async () => '13800138000',
    interpretQuestion: async () => { throw new Error('model timeout'); },
    reportError: (code) => errors.push(code),
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/agent/questions/route')) {
        routedCandidate = JSON.parse(options.body).candidate;
        return { ok: true, json: async () => ({ interaction: { type: 'answer', text: '已查询。' } }) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  await gateway.handle({
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7', conversationId: 'fallback',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text', text: { content: '新华的荣耀鑫享保险责任' },
  });

  assert.equal(routedCandidate.intent, 'insurance_product_knowledge');
  assert.equal(routedCandidate.entities.productName, '新华的荣耀鑫享');
  assert.deepEqual(errors, ['DINGTALK_INTERPRETER_FALLBACK']);
});

test('DingTalk gateway routes a numbered product choice to the selected exact product', async () => {
  const routedCandidates = [];
  let interpreted = 0;
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', getDingtalkMobile: async () => '13800138000',
    interpretQuestion: async ({ question }) => {
      interpreted += 1;
      return { intent: 'insurance_product_knowledge', question, confidence: 1, requestedOperation: 'read', entities: { productName: '荣耀鑫享' } };
    },
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/agent/questions/route')) {
        routedCandidates.push(JSON.parse(options.body).candidate);
        return routedCandidates.length === 1
          ? { ok: true, json: async () => ({ interaction: { type: 'clarification', text: '请选择：', candidates: [
            { ref: 'product_1', label: '新华保险《荣耀鑫享赢家版终身寿险》' },
            { ref: 'product_2', label: '新华保险《荣耀鑫享智赢版终身寿险》' },
          ] } }) }
          : { ok: true, json: async () => ({ interaction: { type: 'answer', text: '新华保险《荣耀鑫享智赢版终身寿险》：已查询。' } }) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  const base = {
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7', conversationId: 'choice',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text',
  };
  await gateway.handle({ ...base, msgId: 'choice-1', text: { content: '荣耀鑫享保险责任' } });
  await gateway.handle({ ...base, msgId: 'choice-2', text: { content: '2' } });

  assert.equal(interpreted, 1);
  assert.equal(routedCandidates[1].question, '荣耀鑫享智赢版终身寿险保险责任');
  assert.equal(routedCandidates[1].entities.productName, '荣耀鑫享智赢版终身寿险');
});

test('unregistered mobile receives only the safe registration link', async () => {
  const replies = [];
  const gateway = createDingtalkAgentGateway({
    corpId: 'corp-1', hmacSecret: 'test-secret', getDingtalkMobile: async () => '13800138000',
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/agent/questions/route')) {
        return { ok: false, json: async () => ({ code: 'AGENT_REGISTRATION_REQUIRED', action: { url: 'https://ocr.example/agent/register' } }) };
      }
      replies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({}) };
    },
  });
  await gateway.handle({
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text', text: { content: '你好' },
  });
  assert.match(replies[0].text.content, /https:\/\/ocr\.example\/agent\/register/u);
  assert.doesNotMatch(replies[0].text.content, /13800138000/u);
});
