import crypto from 'node:crypto';
import fs from 'node:fs';

function trim(value) {
  return String(value || '').trim();
}

function readSecret(env, valueKey, pathKey) {
  const direct = trim(env[valueKey]);
  if (direct) return direct.replace(/\\n/g, '\n');
  const filePath = trim(env[pathKey]);
  return filePath ? fs.readFileSync(filePath, 'utf8') : '';
}

export function resolveWechatPayConfig(env = process.env) {
  const mode = trim(env.WECHAT_PAY_MODE) || 'mock';
  const nodeEnv = trim(env.NODE_ENV);
  const allowMockInProduction = trim(env.WECHAT_PAY_ALLOW_MOCK_IN_PRODUCTION).toLowerCase() === 'true';
  const config = {
    mode,
    nodeEnv,
    allowMockInProduction,
    appId: trim(env.WECHAT_H5_APP_ID || env.WECHAT_APP_ID),
    mchId: trim(env.WECHAT_PAY_MCH_ID),
    apiV3Key: trim(env.WECHAT_PAY_API_V3_KEY),
    serialNo: trim(env.WECHAT_PAY_SERIAL_NO),
    privateKey: readSecret(env, 'WECHAT_PAY_PRIVATE_KEY', 'WECHAT_PAY_PRIVATE_KEY_PATH'),
    platformPublicKey: readSecret(env, 'WECHAT_PAY_PLATFORM_PUBLIC_KEY', 'WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH'),
    platformPublicKeyId: trim(env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID),
    notifyUrl: trim(env.WECHAT_PAY_NOTIFY_URL),
  };
  config.ready = mode === 'mock'
    ? nodeEnv !== 'production' || allowMockInProduction
    : Boolean(
    config.appId &&
    config.mchId &&
    config.apiV3Key &&
    config.serialNo &&
    config.privateKey &&
    config.platformPublicKey &&
    config.platformPublicKeyId &&
    config.notifyUrl
  );
  return config;
}

export function signWechatPayMessage(message, privateKey) {
  return crypto.createSign('RSA-SHA256').update(message).sign(privateKey, 'base64');
}

export function verifyWechatPaySignature({ timestamp, nonce, body, signature, publicKey, maxAgeSeconds = 0, nowMs = Date.now() }) {
  try {
    if (maxAgeSeconds) {
      const timestampSeconds = Number(timestamp);
      if (!Number.isFinite(timestampSeconds)) return false;
      const ageSeconds = Math.abs(Math.floor(Number(nowMs) / 1000) - timestampSeconds);
      if (ageSeconds > Number(maxAgeSeconds)) return false;
    }
    return crypto.createVerify('RSA-SHA256')
      .update(`${timestamp}\n${nonce}\n${body}\n`)
      .verify(publicKey, signature, 'base64');
  } catch {
    return false;
  }
}

export function decryptWechatPayResource({ apiV3Key, nonce, associatedData, ciphertext }) {
  const encrypted = Buffer.from(ciphertext, 'base64');
  const authTag = encrypted.subarray(encrypted.length - 16);
  const data = encrypted.subarray(0, encrypted.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce));
  decipher.setAuthTag(authTag);
  if (associatedData) decipher.setAAD(Buffer.from(associatedData));
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

export function buildJsapiPayParams({
  appId,
  prepayId,
  privateKey,
  nonceStr = crypto.randomBytes(16).toString('hex'),
  timeStamp = String(Math.floor(Date.now() / 1000)),
}) {
  const packageValue = `prepay_id=${prepayId}`;
  const message = `${appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`;
  return {
    appId,
    timeStamp,
    nonceStr,
    package: packageValue,
    signType: 'RSA',
    paySign: signWechatPayMessage(message, privateKey),
  };
}

export async function createWechatPayJsapiPrepay({ config, order, openid, fetchImpl = fetch }) {
  if (!config.ready || config.mode !== 'live') {
    const error = new Error('WECHAT_PAY_NOT_CONFIGURED');
    error.code = 'WECHAT_PAY_NOT_CONFIGURED';
    error.status = 503;
    throw error;
  }
  const body = JSON.stringify({
    appid: config.appId,
    mchid: config.mchId,
    description: 'OCR Insurance 年费会员',
    out_trade_no: order.outTradeNo,
    time_expire: order.expiresAt,
    notify_url: config.notifyUrl,
    amount: { total: order.amountCents, currency: order.currency },
    payer: { openid },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const urlPath = '/v3/pay/transactions/jsapi';
  const signature = signWechatPayMessage(`POST\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`, config.privateKey);
  const response = await fetchImpl(`https://api.mch.weixin.qq.com${urlPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${config.serialNo}",signature="${signature}"`,
    },
    body,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.prepay_id) {
    const error = new Error(payload?.message || 'WECHAT_PAY_PREPAY_FAILED');
    error.code = payload?.code || 'WECHAT_PAY_PREPAY_FAILED';
    error.status = 502;
    throw error;
  }
  return {
    prepayId: payload.prepay_id,
    payParams: buildJsapiPayParams({ appId: config.appId, prepayId: payload.prepay_id, privateKey: config.privateKey }),
  };
}

export function createMockJsapiPayParams(order) {
  return {
    appId: 'mock-wechat-appid',
    timeStamp: String(Math.floor(Date.now() / 1000)),
    nonceStr: `mock_${order.id}`,
    package: `prepay_id=mock_${order.outTradeNo}`,
    signType: 'RSA',
    paySign: `mock_sign_${order.id}`,
  };
}
