/**
 * Vision LLM client — OpenAI-compatible API for cash value table extraction.
 *
 * Falls back gracefully when env vars are not configured.
 */

const CASH_VALUE_PROMPT = `请识别这张图片中的现金价值表格。
返回 JSON 数组，每项包含:
- policyYear: 保单年度(整数)
- age: 被保险年龄(整数，如无此列则为 null)
- cashValue: 现金价值金额(数字)
只返回 JSON 数组，不要其他内容。`;

export function isVisionLlmConfigured(env = process.env) {
  return Boolean(
    (env.VISION_LLM_API_KEY || '').trim() &&
    (env.VISION_LLM_ENDPOINT || '').trim()
  );
}

function resolveConfig(env = process.env) {
  const apiKey = (env.VISION_LLM_API_KEY || '').trim();
  const endpoint = (env.VISION_LLM_ENDPOINT || '').trim().replace(/\/+$/, '');
  const model = (env.VISION_LLM_MODEL || 'gpt-4o').trim();
  if (!apiKey || !endpoint) return null;
  return { apiKey, endpoint, model };
}

/**
 * Extract cash value table from an image using a vision LLM.
 *
 * @param {string} imageDataUrl - Base64 data URL of the image
 * @returns {Promise<{ok: boolean, rows?: Array, error?: string}>}
 */
export async function extractCashValueWithVisionLlm(imageDataUrl, env = process.env) {
  const config = resolveConfig(env);
  if (!config) {
    return { ok: false, error: 'VISION_LLM_NOT_CONFIGURED', message: '视觉大模型未配置' };
  }

  try {
    const response = await fetch(`${config.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: CASH_VALUE_PROMPT },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
        max_tokens: 4096,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return { ok: false, error: 'VISION_LLM_FAILED', message: `HTTP ${response.status}: ${errorText.slice(0, 200)}` };
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';

    // Extract JSON array from response (handle markdown code blocks)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return { ok: false, error: 'VISION_LLM_FAILED', message: '返回内容中未找到 JSON 数组' };
    }

    const rows = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: false, error: 'VISION_LLM_FAILED', message: '解析结果为空' };
    }

    // Validate and normalize
    const normalized = [];
    for (const row of rows) {
      const policyYear = Number(row.policyYear);
      const cashValue = Number(row.cashValue);
      if (!Number.isFinite(policyYear) || !Number.isFinite(cashValue)) continue;
      normalized.push({
        policyYear,
        age: row.age != null ? Number(row.age) : null,
        cashValue,
      });
    }

    if (normalized.length < 3) {
      return { ok: false, error: 'VISION_LLM_FAILED', message: `有效行数不足: ${normalized.length}` };
    }

    return { ok: true, source: 'vision_llm', rows: normalized, rowCount: normalized.length };
  } catch (error) {
    return { ok: false, error: 'VISION_LLM_FAILED', message: error instanceof Error ? error.message : '视觉大模型调用失败' };
  }
}
