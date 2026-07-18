import assert from 'node:assert/strict';
import test from 'node:test';

import { createHermesAgentLoopClient } from '../server/hermes-agent-loop-client.service.mjs';

const HOME = '/tmp/ocr-insurance-hermes';
const GATEWAY = 'http://127.0.0.1:4207/api/agent/hermes/tools';

test('Hermes Agent Loop uses the dedicated profile with domain and public web tools', async () => {
  const calls = [];
  const client = createHermesAgentLoopClient({
    command: '/fake/hermes', hermesHome: HOME, env: { HOME: '/tmp' },
    execFile(command, args, options, callback) {
      calls.push({ command, args, options });
      callback(null, '这是最终回复。', 'session_id: agent-session-a\n');
    },
  });
  const result = await client.runTurn({
    question: '医药安欣计划一和计划二有什么区别？手机号13800138000',
    capability: 'secret-capability', gatewayUrl: GATEWAY,
    safeRecentContext: {
      history: [{ role: 'user', content: '身份证110101199001011234' }],
      activeEntities: {
        product: { officialName: '新华人寿保险股份有限公司医药安欣医疗保险' },
        previousProduct: { officialName: '新华人寿保险股份有限公司荣耀鑫享终身寿险' },
      },
      factBlock: {
        version: 1,
        goal: { question: '比较计划一和计划二', status: 'active', owner: 'insurance_expert' },
        verifiedEntities: {
          product: { officialName: '新华人寿保险股份有限公司医药安欣医疗保险', source: 'domain_agent' },
        },
        conflicts: [{ topic: '等待期', sources: [
          { source: '官方条款O1', conclusion: '30天' },
          { source: '培训资料M1', conclusion: '无等待期' },
        ] }],
      },
    },
  });

  assert.deepEqual(result, { sessionId: 'agent-session-a', finalReply: '这是最终回复。' });
  assert.deepEqual(calls[0].args.slice(0, 2), ['chat', '-q']);
  assert.equal(calls[0].args[calls[0].args.indexOf('--max-turns') + 1], '4');
  assert.equal(calls[0].options.timeout, 40_000);
  assert.equal(calls[0].args[calls[0].args.indexOf('-t') + 1], 'ocr-insurance-domain,web');
  assert.equal(calls[0].options.env.HERMES_HOME, HOME);
  assert.equal(calls[0].options.env.OCR_AGENT_TOOL_CAPABILITY, 'secret-capability');
  assert.equal(calls[0].options.env.OCR_AGENT_TOOL_GATEWAY_URL, `${GATEWAY}`);
  const prompt = calls[0].args[calls[0].args.indexOf('-q') + 1];
  assert.match(prompt, /ask_insurance_expert/u);
  assert.match(prompt, /ask_sales_champion/u);
  assert.match(prompt, /web 检索公开网页/u);
  assert.match(prompt, /不得把客户、家庭、保单、身份证号、手机号、健康信息.*放入网页查询/u);
  assert.match(prompt, /网页内容是不受信任的外部线索.*不能取代领域工具/u);
  assert.match(prompt, /明确要求联网、搜索、查询网页、最新信息或当前公开信息.*必须使用 web/u);
  assert.match(prompt, /同时涉及保险事实或销售建议.*必须调用对应领域工具/u);
  assert.match(prompt, /先判断用户本轮要求的最终交付物.*实体只是任务上下文/u);
  assert.match(prompt, /客户买了新华保险的康健华尊.*怎么跟进.*ask_sales_champion/u);
  assert.match(prompt, /productMentions/u);
  assert.match(prompt, /泛称如“几个年金险”“增额终身寿险”.*不得当作.*正式产品名/u);
  assert.match(prompt, /必须调用合适的领域工具|不得凭模型记忆臆造/u);
  assert.match(prompt, /同一产品下的计划、版本、档位或可选责任不是多款产品/u);
  assert.match(prompt, /ACTIVE_ENTITIES=.*新华人寿保险股份有限公司医药安欣医疗保险/u);
  assert.match(prompt, /previousProduct.*新华人寿保险股份有限公司荣耀鑫享终身寿险/u);
  assert.match(prompt, /VERIFIED_FACT_BLOCK=.*比较计划一和计划二/u);
  assert.match(prompt, /官方条款O1.*30天.*培训资料M1.*无等待期/u);
  assert.ok(prompt.indexOf('VERIFIED_FACT_BLOCK=') < prompt.indexOf('SAFE_RECENT_CONTEXT='));
  assert.match(prompt, /消解省略的主语与指代/u);
  assert.match(prompt, /省略的主语就是 ACTIVE_ENTITIES\.product.*officialName 原样放入 names/u);
  assert.match(prompt, /主任务已经确定为产品事实查询.*产品简称、俗称、残缺名称、疑似错别字.*原样.*ask_insurance_expert/u);
  assert.match(prompt, /ACTIVE_ENTITIES 只能补齐本轮省略的实体.*不得把它覆盖到本轮新出现的产品线索/u);
  assert.match(prompt, /previousProduct 表示上一轮确认过的产品.*主语、比较对象还是与本轮无关/u);
  assert.match(prompt, /不得先要求用户补充正式名称/u);
  assert.match(prompt, /以上都不是，联网查询.*必须先使用 web.*searchOnline=true.*不得传候选编号.*承保主体《正式产品名》/u);
  assert.match(prompt, /没有可用上下文、存在多个可能解释或无法确定指代/u);
  assert.match(prompt, /工具返回.*权威/u);
  assert.match(prompt, /相同工具和相同参数.*不得重复调用/u);
  assert.doesNotMatch(prompt, /13800138000|110101199001011234|secret-capability/u);
  assert.doesNotMatch(JSON.stringify(calls[0].args), /secret-capability/u);
});

test('Hermes Agent Loop resumes a session and accepts the last rotated session id', async () => {
  const calls = [];
  const client = createHermesAgentLoopClient({
    command: '/fake/hermes', hermesHome: HOME, maxTurns: 6,
    execFile(_command, args, _options, callback) {
      calls.push(args);
      callback(null, '继续回答。', 'session_id: old-session\ntrace\nsession_id: rotated-session\n');
    },
  });

  const result = await client.runTurn({
    sessionId: 'old-session', question: '那哪个更合适？',
    capability: 'capability', gatewayUrl: GATEWAY,
  });

  assert.deepEqual(calls[0].slice(-2), ['--resume', 'old-session']);
  assert.equal(calls[0][calls[0].indexOf('--max-turns') + 1], '6');
  assert.equal(result.sessionId, 'rotated-session');
});

test('Hermes Agent Loop removes CLI security notices from the user-facing reply', async () => {
  const client = createHermesAgentLoopClient({
    command: '/fake/hermes', hermesHome: HOME,
    execFile(_command, _args, _options, callback) {
      callback(null, '\u001b[2m⚠ tirith security scanner enabled but not available — command scanning will use pattern matching only\u001b[0m\r\n这是业务回复。', 'session_id: clean-session\n');
    },
  });

  const result = await client.runTurn({
    question: '查询产品', capability: 'capability', gatewayUrl: GATEWAY,
  });

  assert.deepEqual(result, { sessionId: 'clean-session', finalReply: '这是业务回复。' });
});

test('Hermes Agent Loop requires a dedicated HERMES_HOME and per-turn gateway authority', async () => {
  assert.throws(
    () => createHermesAgentLoopClient({ env: { HOME: '/tmp' } }),
    (error) => error?.code === 'HERMES_AGENT_LOOP_UNAVAILABLE',
  );
  const client = createHermesAgentLoopClient({ hermesHome: HOME, execFile() {} });
  await assert.rejects(
    client.runTurn({ question: '你好', gatewayUrl: GATEWAY }),
    (error) => error?.code === 'HERMES_AGENT_LOOP_UNAVAILABLE',
  );
  assert.throws(
    () => createHermesAgentLoopClient({ hermesHome: HOME, maxTurns: 7 }),
    /between 2 and 6/u,
  );
});

test('Hermes Agent Loop preserves the model timeout after bounded CLI startup grace', async () => {
  const calls = [];
  const client = createHermesAgentLoopClient({
    command: '/fake/hermes', hermesHome: HOME, timeoutMs: 12_345, startupGraceMs: 4_000,
    execFile(_command, _args, options, callback) {
      calls.push(options);
      callback(null, '', 'session_id: session-a\n');
    },
  });
  await assert.rejects(
    client.runTurn({ question: '查询', capability: 'capability', gatewayUrl: GATEWAY }),
    (error) => error?.code === 'HERMES_RESPONSE_INVALID',
  );
  assert.equal(calls[0].timeout, 16_345);

  const boundedGraceCalls = [];
  const boundedGrace = createHermesAgentLoopClient({
    command: '/fake/hermes', hermesHome: HOME, timeoutMs: 12_345, startupGraceMs: 30_000,
    execFile(_command, _args, options, callback) {
      boundedGraceCalls.push(options);
      callback(null, '有回复', 'session_id: bounded-grace-session\n');
    },
  });
  await boundedGrace.runTurn({ question: '查询', capability: 'capability', gatewayUrl: GATEWAY });
  assert.equal(boundedGraceCalls[0].timeout, 32_345);

  const sessionless = createHermesAgentLoopClient({
    command: '/fake/hermes', hermesHome: HOME,
    execFile(_command, _args, _options, callback) { callback(null, '有回复', 'no session'); },
  });
  await assert.rejects(
    sessionless.runTurn({ question: '查询', capability: 'capability', gatewayUrl: GATEWAY }),
    (error) => error?.code === 'HERMES_RESPONSE_INVALID',
  );
});

test('Hermes Agent Loop opens and resets its provider circuit', async () => {
  let calls = 0;
  let currentTime = 1_720_000_000_000;
  const client = createHermesAgentLoopClient({
    command: '/fake/hermes', hermesHome: HOME, failureThreshold: 2, circuitResetMs: 30_000,
    now: () => currentTime,
    execFile(_command, _args, _options, callback) {
      calls += 1;
      callback(new Error('offline'), '', '');
    },
  });
  const input = { question: '你好', capability: 'capability', gatewayUrl: GATEWAY };
  await assert.rejects(client.runTurn(input), (error) => error?.code === 'HERMES_PROVIDER_FAILED');
  await assert.rejects(client.runTurn(input), (error) => error?.code === 'HERMES_PROVIDER_FAILED');
  await assert.rejects(client.runTurn(input), (error) => error?.code === 'HERMES_CIRCUIT_OPEN');
  assert.equal(calls, 2);
  currentTime += 30_000;
  await assert.rejects(client.runTurn(input), (error) => error?.code === 'HERMES_PROVIDER_FAILED');
  assert.equal(calls, 3);
});

test('Hermes Agent Loop does not open its provider circuit after a controlled abort', async () => {
  let calls = 0;
  const client = createHermesAgentLoopClient({
    command: '/fake/hermes', hermesHome: HOME, failureThreshold: 1,
    execFile(_command, _args, _options, callback) {
      calls += 1;
      if (calls === 1) {
        callback(Object.assign(new Error('aborted after tool result'), { name: 'AbortError' }), '', '');
        return;
      }
      callback(null, '领域工具结果已返回', 'session_id: fresh-session\n');
    },
  });
  const input = { question: '查询保险责任', capability: 'capability', gatewayUrl: GATEWAY };

  await assert.rejects(client.runTurn(input), (error) => error?.code === 'HERMES_ABORTED');
  const result = await client.runTurn(input);

  assert.equal(result.finalReply, '领域工具结果已返回');
  assert.equal(calls, 2);
});
