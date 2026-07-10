import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  MAX_PRODUCT_DOCUMENT_BYTES,
  normalizeProductDocumentUpload,
} from '../server/product-document-upload.service.mjs';

function uploadInput(fileName, text = 'insurance product material', mediaType = '') {
  return {
    fileName,
    mediaType,
    dataBase64: Buffer.from(text).toString('base64'),
  };
}

test('normalizeProductDocumentUpload decodes bytes and creates a stable hash', () => {
  const input = uploadInput(
    '产品培训.pptx',
    'test deck',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  );
  const result = normalizeProductDocumentUpload(input);

  assert.equal(result.fileName, '产品培训.pptx');
  assert.equal(result.extension, 'pptx');
  assert.equal(result.mediaType, input.mediaType);
  assert.equal(result.bytes.toString('utf8'), 'test deck');
  assert.equal(result.byteSize, Buffer.byteLength('test deck'));
  assert.equal(
    result.contentHash,
    crypto.createHash('sha256').update('test deck').digest('hex'),
  );
});

test('normalizeProductDocumentUpload accepts supported insurance material formats', () => {
  const extensions = [
    'pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'md', 'jpg', 'jpeg', 'png',
  ];

  for (const extension of extensions) {
    const result = normalizeProductDocumentUpload(uploadInput(`material.${extension}`));
    assert.equal(result.extension, extension);
    assert.ok(result.mediaType);
  }
});

test('normalizeProductDocumentUpload strips path fragments from browser file names', () => {
  const result = normalizeProductDocumentUpload(uploadInput('C:\\fakepath\\产品条款.PDF'));
  assert.equal(result.fileName, '产品条款.PDF');
  assert.equal(result.extension, 'pdf');
});

test('normalizeProductDocumentUpload rejects malformed or empty base64', () => {
  assert.throws(
    () => normalizeProductDocumentUpload({ fileName: '产品.txt', dataBase64: '%%%' }),
    (error) => error?.code === 'PRODUCT_DOCUMENT_INVALID_BASE64' && error?.status === 400,
  );
  assert.throws(
    () => normalizeProductDocumentUpload({ fileName: '产品.txt', dataBase64: '' }),
    (error) => error?.code === 'PRODUCT_DOCUMENT_EMPTY' && error?.status === 400,
  );
  assert.throws(
    () => normalizeProductDocumentUpload({
      fileName: '产品.txt',
      dataBase64: 'data:text/plain;base64,dGVzdA==',
    }),
    (error) => error?.code === 'PRODUCT_DOCUMENT_INVALID_BASE64',
  );
});

test('normalizeProductDocumentUpload rejects unsupported extensions', () => {
  assert.throws(
    () => normalizeProductDocumentUpload(uploadInput('malware.exe')),
    (error) => error?.code === 'PRODUCT_DOCUMENT_UNSUPPORTED_TYPE' && error?.status === 400,
  );
});

test('normalizeProductDocumentUpload rejects files larger than the product limit', () => {
  const bytes = Buffer.alloc(MAX_PRODUCT_DOCUMENT_BYTES + 1, 1);
  assert.throws(
    () => normalizeProductDocumentUpload({
      fileName: 'too-large.pdf',
      dataBase64: bytes.toString('base64'),
    }),
    (error) => error?.code === 'PRODUCT_DOCUMENT_TOO_LARGE' && error?.status === 413,
  );
});
