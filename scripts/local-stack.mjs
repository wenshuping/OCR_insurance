import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const cloudflaredConfig = path.join(process.env.HOME || '', '.cloudflared/config.yml');
const command = process.argv[2] || 'start';
const parsedCommand = parseCommand(command);
const profileConfigs = createProfileConfigs();

function parseCommand(rawCommand) {
  const raw = String(rawCommand || 'start').trim();
  if (raw === 'status-all') return { action: 'status-all', profile: 'all' };
  if (raw.endsWith('-local')) return { action: raw.slice(0, -'-local'.length), profile: 'dev' };
  if (raw.endsWith('-dev')) return { action: raw.slice(0, -'-dev'.length), profile: 'dev' };
  if (raw.endsWith('-prod')) return { action: raw.slice(0, -'-prod'.length), profile: 'prod' };
  if (['start', 'stop', 'status'].includes(raw)) return { action: raw, profile: 'prod' };
  return { action: raw, profile: 'prod' };
}

function createProfileConfigs() {
  const prodRuntimeDir = path.join(projectRoot, '.runtime');
  const devRuntimeDir = path.join(prodRuntimeDir, 'local');
  const prodDbPath = path.join(prodRuntimeDir, 'policy-ocr.sqlite');
  const prodRuntimeEnv = readRuntimeEnvConfig(prodRuntimeDir);
  const devRuntimeEnv = readRuntimeEnvConfig(devRuntimeDir);
  return {
    prod: createProfileConfig({
      name: 'prod',
      label: '生产',
      runtimeDir: prodRuntimeDir,
      webPort: 3013,
      apiPort: 4206,
      ocrPort: 4105,
      webHost: '0.0.0.0',
      apiHost: '0.0.0.0',
      ocrHost: '127.0.0.1',
      nodeEnv: 'production',
      publicTunnel: true,
      extraEnv: prodRuntimeEnv,
    }),
    dev: createProfileConfig({
      name: 'dev',
      label: '开发',
      runtimeDir: devRuntimeDir,
      webPort: 3014,
      apiPort: 4207,
      ocrPort: 4109,
      webHost: '127.0.0.1',
      apiHost: '127.0.0.1',
      ocrHost: '127.0.0.1',
      nodeEnv: 'development',
      publicTunnel: false,
      extraEnv: {
        POLICY_OCR_SKIP_PROJECT_DOTENV_LOCAL: 'true',
        POLICY_OCR_APP_DB_PATH: path.join(devRuntimeDir, 'policy-ocr.sqlite'),
        POLICY_OCR_SYNC_SOURCE_DB_PATH: prodDbPath,
        POLICY_ADMIN_PASSWORD: 'admin123456',
        SMS_MODE: 'mock',
        SMS_MOCK_CODE: '123456',
        ...devRuntimeEnv,
      },
    }),
  };
}

function readRuntimeEnvConfig(runtimeDir) {
  const configPath = path.join(runtimeDir, 'policy-ocr-env.json');
  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
  const allowedKeys = new Set([
    'POLICY_OCR_PROVIDER',
    'POLICY_OCR_POSTPROCESSOR',
    'POLICY_OCR_OLLAMA_BASE_URL',
    'POLICY_OCR_OLLAMA_MODEL',
    'POLICY_OCR_OLLAMA_VISION_MODEL',
    'POLICY_OCR_OLLAMA_TIMEOUT_MS',
    'POLICY_OCR_OLLAMA_VISION_TIMEOUT_MS',
    'POLICY_OCR_OLLAMA_VISION_NUM_CTX',
    'POLICY_OCR_OLLAMA_VISION_NUM_PREDICT',
    'POLICY_OCR_OLLAMA_VISION_COMPLEX_PASSES',
    'POLICY_OCR_OLLAMA_VISION_MAX_IMAGE_DIMENSION',
    'POLICY_OCR_OLLAMA_VISION_JPEG_QUALITY',
    'POLICY_OCR_REMOTE_VISION_BASE_URL',
    'POLICY_OCR_REMOTE_VISION_MODEL',
    'POLICY_OCR_REMOTE_VISION_TIMEOUT_MS',
    'POLICY_OCR_REMOTE_VISION_MAX_IMAGE_DIMENSION',
    'POLICY_OCR_REMOTE_VISION_JPEG_QUALITY',
    'POLICY_OCR_REMOTE_VISION_MAX_TOKENS',
    'POLICY_OCR_HUAWEI_PROJECT_ID',
    'POLICY_OCR_HUAWEI_X_AUTH_TOKEN',
    'POLICY_OCR_HUAWEI_AUTH_TOKEN',
    'POLICY_OCR_HUAWEI_AK',
    'POLICY_OCR_HUAWEI_SK',
    'CLOUD_SDK_AK',
    'CLOUD_SDK_SK',
    'POLICY_OCR_HUAWEI_ENDPOINT',
    'POLICY_OCR_HUAWEI_REGION',
    'POLICY_OCR_HUAWEI_ENTERPRISE_PROJECT_ID',
    'POLICY_OCR_HUAWEI_TIMEOUT_MS',
    'POLICY_OCR_FALLBACK_PADDLE',
    'POLICY_OCR_PADDLE_PYTHON',
  ]);
  const env = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (!allowedKeys.has(key)) continue;
    const normalized = String(value || '').trim();
    if (normalized) env[key] = normalized;
  }
  return env;
}

function createProfileConfig({
  name,
  label,
  runtimeDir,
  webPort,
  apiPort,
  ocrPort,
  webHost,
  apiHost,
  ocrHost,
  nodeEnv,
  publicTunnel,
  extraEnv = {},
}) {
  return {
    name,
    label,
    runtimeDir,
    pidDir: path.join(runtimeDir, 'pids'),
    logDir: path.join(runtimeDir, 'logs'),
    webPort,
    apiPort,
    ocrPort,
    webHost,
    apiHost,
    ocrHost,
    publicTunnel,
    env: {
      NODE_ENV: nodeEnv,
      POLICY_OCR_PROFILE: name,
      POLICY_OCR_WEB_PORT: String(webPort),
      POLICY_OCR_WEB_HOST: webHost,
      POLICY_OCR_APP_API_PORT: String(apiPort),
      POLICY_OCR_APP_HOST: apiHost,
      POLICY_OCR_APP_STATE_PATH: path.join(runtimeDir, 'state.json'),
      POLICY_OCR_APP_DB_PATH: path.join(runtimeDir, 'policy-ocr.sqlite'),
      POLICY_OCR_SERVICE_URL: `http://127.0.0.1:${ocrPort}`,
      OCR_SERVICE_HOST: ocrHost,
      OCR_SERVICE_PORT: String(ocrPort),
      POLICY_OCR_CONFIG_PATH: path.join(runtimeDir, 'policy-ocr-config.json'),
      POLICY_OCR_PROVIDER: 'remote_gpu_vision',
      ...extraEnv,
    },
  };
}

function createServices(profile) {
  return [
    {
      name: 'caffeinate',
      label: '防睡眠',
      command: '/usr/bin/caffeinate',
      args: ['-dimsu'],
      optional: true,
    },
    {
      name: 'ocr',
      label: 'OCR 服务',
      command: process.execPath,
      args: ['ocr-service/index.mjs'],
      port: profile.ocrPort,
      healthUrl: `http://127.0.0.1:${profile.ocrPort}/internal/ocr-service/health`,
    },
    {
      name: 'api',
      label: 'API 服务',
      command: process.execPath,
      args: ['server/index.mjs'],
      port: profile.apiPort,
      healthUrl: `http://127.0.0.1:${profile.apiPort}/api/health`,
    },
    {
      name: 'web',
      label: '前端页面',
      command: process.execPath,
      args: [
        path.join(projectRoot, 'node_modules/vite/bin/vite.js'),
        'preview',
        '--port',
        String(profile.webPort),
        '--host',
        profile.webHost,
      ],
      port: profile.webPort,
      healthUrl: `http://127.0.0.1:${profile.webPort}/`,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'cloudflared',
      label: '公网 Tunnel',
      command: findCloudflared(),
      args: ['tunnel', '--config', cloudflaredConfig, 'run'],
      optional: true,
      skip: !profile.publicTunnel || !fs.existsSync(cloudflaredConfig),
    },
  ];
}

function findCloudflared() {
  for (const candidate of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'cloudflared';
}

function ensureDirs(profile) {
  fs.mkdirSync(profile.pidDir, { recursive: true });
  fs.mkdirSync(profile.logDir, { recursive: true });
}

function pidPath(profile, name) {
  return path.join(profile.pidDir, `${name}.pid`);
}

function logPath(profile, name) {
  return path.join(profile.logDir, `${name}.log`);
}

function readPid(profile, name) {
  try {
    const pid = Number(fs.readFileSync(pidPath(profile, name), 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function isPidRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removePid(profile, name) {
  fs.rmSync(pidPath(profile, name), { force: true });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port, timeout: 500 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await wait(700);
  }
  throw new Error(`${url} 未就绪：${lastError || 'timeout'}`);
}

function serviceEnv(profile, service = {}) {
  return {
    ...process.env,
    ...profile.env,
    ...(service.env || {}),
  };
}

function runBuild(profile) {
  console.log(`[local:${profile.name}] 构建前端 dist`);
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...serviceEnv(profile),
      NODE_ENV: 'production',
    },
  });
  if (result.status !== 0) {
    throw new Error('前端构建失败，已停止启动');
  }
}

async function startService(profile, service) {
  if (service.skip) {
    console.log(`[local:${profile.name}] 跳过 ${service.label}：缺少配置`);
    return;
  }

  const existingPid = readPid(profile, service.name);
  if (isPidRunning(existingPid)) {
    console.log(`[local:${profile.name}] ${service.label} 已运行 pid=${existingPid}`);
    return;
  }
  removePid(profile, service.name);

  if (service.port && (await isPortOpen(service.port))) {
    console.log(`[local:${profile.name}] ${service.label} 端口 ${service.port} 已被占用，保留现有进程`);
    return;
  }

  const logFile = fs.openSync(logPath(profile, service.name), 'a');
  const child = spawn(service.command, service.args, {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', logFile, logFile],
    env: serviceEnv(profile, service),
  });

  child.once('error', (error) => {
    if (service.optional) {
      console.log(`[local:${profile.name}] ${service.label} 未启动：${error.message}`);
      return;
    }
    throw error;
  });

  child.unref();
  fs.writeFileSync(pidPath(profile, service.name), `${child.pid}\n`);
  console.log(`[local:${profile.name}] 已启动 ${service.label} pid=${child.pid} log=${path.relative(projectRoot, logPath(profile, service.name))}`);

  if (service.healthUrl) {
    await waitForHttp(service.healthUrl);
    console.log(`[local:${profile.name}] ${service.label} 健康检查通过`);
  }
}

async function start(profile) {
  ensureDirs(profile);
  runBuild(profile);
  for (const service of createServices(profile)) {
    await startService(profile, service);
  }
  console.log('');
  console.log(`${profile.label}地址: http://localhost:${profile.webPort}/`);
  console.log(`${profile.label}后台: http://localhost:${profile.webPort}/admin`);
  console.log(`${profile.label}数据: ${path.relative(projectRoot, profile.runtimeDir)}`);
  if (profile.publicTunnel) {
    console.log('公网域名: https://poptonic.cn/');
  }
  console.log(profile.name === 'prod' ? '查看状态: npm run local:prod:status' : '查看状态: npm run local:dev:status');
  console.log(profile.name === 'prod' ? '停止服务: npm run local:prod:stop' : '停止服务: npm run local:dev:stop');
}

async function stop(profile) {
  ensureDirs(profile);
  for (const service of [...createServices(profile)].reverse()) {
    const pid = readPid(profile, service.name);
    if (!pid) {
      console.log(`[local:${profile.name}] ${service.label} 没有 pid 文件`);
      continue;
    }
    if (!isPidRunning(pid)) {
      console.log(`[local:${profile.name}] ${service.label} 已停止 pid=${pid}`);
      removePid(profile, service.name);
      continue;
    }
    process.kill(pid, 'SIGTERM');
    await wait(1000);
    if (isPidRunning(pid)) {
      process.kill(pid, 'SIGKILL');
    }
    removePid(profile, service.name);
    console.log(`[local:${profile.name}] 已停止 ${service.label} pid=${pid}`);
  }
}

async function status(profile) {
  ensureDirs(profile);
  console.log(`[local:${profile.name}] ${profile.label}环境`);
  for (const service of createServices(profile)) {
    const pid = readPid(profile, service.name);
    const running = isPidRunning(pid);
    const portOpen = service.port ? await isPortOpen(service.port) : false;
    const externalHealthy = !running && service.healthUrl && portOpen ? await waitForHttp(service.healthUrl, 2000).catch(() => false) : false;
    const state = running ? `running pid=${pid}` : externalHealthy ? 'running external' : 'stopped';
    console.log(`${service.label}: ${state}${service.port ? ` port=${service.port} ${portOpen ? 'open' : 'closed'}` : ''}`);
  }
}

async function main() {
  if (parsedCommand.action === 'status-all') {
    await status(profileConfigs.prod);
    console.log('');
    await status(profileConfigs.dev);
    return;
  }

  const profile = profileConfigs[parsedCommand.profile];
  if (!profile) throw new Error(`未知环境：${parsedCommand.profile}`);
  if (parsedCommand.action === 'start') return start(profile);
  if (parsedCommand.action === 'stop') return stop(profile);
  if (parsedCommand.action === 'status') return status(profile);
  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  console.error(`[local] ${error?.message || error}`);
  process.exit(1);
});
