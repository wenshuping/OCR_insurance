const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const ALLOWED_DOWNLOAD_HOST_SUFFIXES = [
  '.dingtalk.com',
  '.alicdn.com',
  '.aliyuncs.com',
  '.alibabausercontent.com',
];

function mediaError(code, status = 502) {
  return Object.assign(new Error(code), { code, status });
}

function attachmentDescriptor(message) {
  const content = message?.content && typeof message.content === 'object' ? message.content : {};
  const downloadCode = String(content.downloadCode || content.pictureDownloadCode || '').trim();
  if (!downloadCode) throw mediaError('DINGTALK_ATTACHMENT_CODE_REQUIRED', 400);
  const name = message?.msgtype === 'picture' ? 'dingtalk-policy.jpg' : 'dingtalk-policy-file';
  return { downloadCode, name };
}

function trustedDownloadUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw mediaError('DINGTALK_DOWNLOAD_URL_INVALID'); }
  if (url.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))) {
    throw mediaError('DINGTALK_DOWNLOAD_URL_FORBIDDEN');
  }
  return url;
}

async function boundedBytes(response, maxBytes) {
  if (!response.ok) throw mediaError('DINGTALK_ATTACHMENT_DOWNLOAD_FAILED');
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw mediaError('DOCUMENT_SIZE_EXCEEDED', 413);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw mediaError('DOCUMENT_SIZE_EXCEEDED', 413);
  return bytes;
}

export function createDingtalkMediaDownloader({ client, fetchImpl = fetch, apiBaseUrl = 'https://api.dingtalk.com', maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!client || typeof client.getAccessToken !== 'function') throw mediaError('DINGTALK_MEDIA_CLIENT_REQUIRED', 503);
  return async function downloadAttachment(message) {
    const { downloadCode, name } = attachmentDescriptor(message);
    const accessToken = String(await client.getAccessToken() || '').trim();
    if (!accessToken) throw mediaError('DINGTALK_ACCESS_TOKEN_FAILED');
    const metadataResponse = await fetchImpl(`${apiBaseUrl.replace(/\/$/, '')}/v1.0/robot/messageFiles/download`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken,
      },
      body: JSON.stringify({ downloadCode, robotCode: String(message?.robotCode || '').trim() }),
    });
    if (!metadataResponse.ok) throw mediaError('DINGTALK_ATTACHMENT_METADATA_FAILED');
    const metadata = await metadataResponse.json().catch(() => null);
    const downloadUrl = trustedDownloadUrl(metadata?.downloadUrl);
    const fileResponse = await fetchImpl(downloadUrl, { redirect: 'error' });
    const bytes = await boundedBytes(fileResponse, maxBytes);
    const mediaType = String(fileResponse.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    return {
      uploadItem: `data:${mediaType || 'application/octet-stream'};base64,${bytes.toString('base64')}`,
      name,
      mediaType,
    };
  };
}
