const FACT_TOKEN_PATTERN = /\d+(?:\.\d+)?(?:%|万|元|年|月|天|日|岁|倍)/gu;

function text(value, limit = 48_000) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function safeToolTexts(toolResults) {
  return [...new Set((Array.isArray(toolResults) ? toolResults : [])
    .map((item) => text(item?.result?.interaction?.text))
    .filter(Boolean))];
}

function safeVerbatimToolTexts(toolResults) {
  return [...new Set((Array.isArray(toolResults) ? toolResults : [])
    .filter((item) => item?.result?.interaction?.delivery === 'verbatim')
    .map((item) => text(item?.result?.interaction?.text))
    .filter(Boolean))];
}

export function guardAgentFinalReply({ finalReply, toolResults } = {}) {
  const reply = text(finalReply);
  if (!reply) throw new TypeError('Agent final reply is required');
  const verbatimTexts = safeVerbatimToolTexts(toolResults);
  if (verbatimTexts.length) {
    return { reply: verbatimTexts.join('\n\n'), fallbackUsed: true, reason: 'authoritative_tool_output' };
  }
  const safeTexts = safeToolTexts(toolResults);
  if (!safeTexts.length) return { reply, fallbackUsed: false };
  const supportedText = safeTexts.join('\n');
  const unsupportedToken = [...reply.matchAll(FACT_TOKEN_PATTERN)]
    .map((match) => match[0])
    .find((token) => !supportedText.includes(token));
  return unsupportedToken
    ? { reply: safeTexts.join('\n\n'), fallbackUsed: true, reason: 'unsupported_numeric_fact' }
    : { reply, fallbackUsed: false };
}
