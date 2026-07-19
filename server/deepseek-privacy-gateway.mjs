function text(value) {
  return String(value ?? '');
}

function escapeRegExp(value) {
  return text(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function unique(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => text(value).trim()).filter(Boolean))];
}

function retainedRegion(address = '') {
  const value = text(address).trim();
  const match = value.match(/^(.{2,32}?(?:区|县|旗))(?:[^区县旗].*)$/u);
  return match?.[1] ? `${match[1]}[详细地址已脱敏]` : '[详细地址已脱敏]';
}

function replaceKnownValues(value, values, replacement) {
  return unique(values)
    .sort((left, right) => right.length - left.length)
    .reduce((result, item) => result.replace(new RegExp(escapeRegExp(item), 'gu'), replacement), value);
}

export function redactDeepSeekDirectIdentifiers(value = '', options = {}) {
  let result = text(value);
  result = replaceKnownValues(result, options.names, '[客户姓名已脱敏]');
  for (const address of unique(options.addresses).sort((left, right) => right.length - left.length)) {
    result = result.replace(new RegExp(escapeRegExp(address), 'gu'), retainedRegion(address));
  }
  result = result
    .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d(?:[-\s]?\d){8}(?!\d)/gu, '[手机号已脱敏]')
    .replace(/(?<!\d)\d{3,4}[-\s]\d{7,8}(?!\d)/gu, '[固定电话已脱敏]')
    .replace(/(?<!\d)\d{17}[0-9Xx](?!\d)/gu, '[身份证号已脱敏]')
    .replace(/(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/gu, '[银行卡号已脱敏]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[邮箱已脱敏]')
    .replace(/((?:保单号|合同号|保险合同号)\s*[：:]?\s*)[A-Z0-9_-]{6,40}/giu, '$1[已脱敏]')
    .replace(/((?:微信号|微信|WeChat)\s*[：:]\s*)[A-Z][-_A-Z0-9]{5,19}/giu, '$1[已脱敏]')
    .replace(/((?:家庭地址|居住地址|联系地址|住址|地址)\s*[：:]?\s*)([^\n，,。；;]{3,100})/gu, (_match, label, address) => `${label}${retainedRegion(address)}`);
  return result;
}

export function sanitizeDeepSeekMessages(messages = [], options = {}) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    ...message,
    content: typeof message?.content === 'string'
      ? redactDeepSeekDirectIdentifiers(message.content, options)
      : message?.content,
  }));
}

export function sanitizeDeepSeekRequestBody(body = {}, options = {}) {
  return {
    ...body,
    messages: sanitizeDeepSeekMessages(body?.messages, options),
  };
}
