import crypto from 'node:crypto';

export const MAX_PRODUCT_DOCUMENT_BYTES = 16 * 1024 * 1024;

export const SUPPORTED_PRODUCT_DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'ppt',
  'pptx',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'txt',
  'md',
  'jpg',
  'jpeg',
  'png',
  'mp3',
  'm4a',
  'wav',
  'aac',
  'flac',
]);

const DEFAULT_MEDIA_TYPES = {
  pdf: 'application/pdf',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  md: 'text/markdown',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

function uploadError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeFileName(value) {
  const submitted = String(value || '').trim();
  if (!submitted || submitted.includes('\0')) {
    throw uploadError('PRODUCT_DOCUMENT_FILE_NAME_REQUIRED', '缺少有效的产品资料文件名');
  }
  const fileName = submitted.split(/[\\/]/u).at(-1)?.trim() || '';
  if (!fileName) {
    throw uploadError('PRODUCT_DOCUMENT_FILE_NAME_REQUIRED', '缺少有效的产品资料文件名');
  }
  return fileName;
}

function extensionFromFileName(fileName) {
  const match = String(fileName || '').match(/\.([^.]+)$/u);
  const extension = String(match?.[1] || '').trim().toLowerCase();
  if (!SUPPORTED_PRODUCT_DOCUMENT_EXTENSIONS.has(extension)) {
    throw uploadError('PRODUCT_DOCUMENT_UNSUPPORTED_TYPE', '暂不支持该产品资料格式');
  }
  return extension;
}

function decodeBase64(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    throw uploadError('PRODUCT_DOCUMENT_EMPTY', '产品资料文件不能为空');
  }
  const normalized = raw.replace(/\s+/gu, '');
  const paddingLength = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  const encodedContent = paddingLength ? normalized.slice(0, -paddingLength) : normalized;
  const expectedRemainder = paddingLength === 2 ? 2 : paddingLength === 1 ? 3 : 0;
  const validSyntax = normalized.length % 4 === 0
    && encodedContent.length % 4 === expectedRemainder
    && !/[^A-Za-z0-9+/]/u.test(encodedContent);
  if (!validSyntax) {
    throw uploadError('PRODUCT_DOCUMENT_INVALID_BASE64', '产品资料文件内容不是有效的Base64');
  }
  const decodedByteSize = (normalized.length / 4) * 3 - paddingLength;
  if (decodedByteSize > MAX_PRODUCT_DOCUMENT_BYTES) {
    throw uploadError(
      'PRODUCT_DOCUMENT_TOO_LARGE',
      '产品资料文件过大，请压缩到16MB以内后重新上传',
      413,
    );
  }
  const bytes = Buffer.from(normalized, 'base64');
  if (!bytes.length) {
    throw uploadError('PRODUCT_DOCUMENT_EMPTY', '产品资料文件不能为空');
  }
  if (bytes.toString('base64') !== normalized) {
    throw uploadError('PRODUCT_DOCUMENT_INVALID_BASE64', '产品资料文件内容不是有效的Base64');
  }
  return bytes;
}

export function normalizeProductDocumentUpload(input = {}) {
  const fileName = normalizeFileName(input.fileName);
  const extension = extensionFromFileName(fileName);
  const bytes = decodeBase64(input.dataBase64);
  if (bytes.length > MAX_PRODUCT_DOCUMENT_BYTES) {
    throw uploadError(
      'PRODUCT_DOCUMENT_TOO_LARGE',
      '产品资料文件过大，请压缩到16MB以内后重新上传',
      413,
    );
  }
  return {
    fileName,
    extension,
    mediaType: String(input.mediaType || '').trim() || DEFAULT_MEDIA_TYPES[extension],
    bytes,
    byteSize: bytes.length,
    contentHash: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}
