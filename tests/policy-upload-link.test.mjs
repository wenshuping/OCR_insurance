import assert from 'node:assert/strict';
import test from 'node:test';
import { createPolicyUploadLinkService } from '../server/policy-upload-link.service.mjs';

test('policy upload links bind family task owner and expiry with tamper protection', () => {
  const service = createPolicyUploadLinkService({ key: 'test-policy-upload-link-key-32-bytes', publicBaseUrl: 'https://app.example.test', now: () => 1_000, ttlMs: 60_000 });
  const issued = service.issue({ familyId: 6, taskId: 10, userId: 7 });
  assert.match(issued.url, /^https:\/\/app\.example\.test\/#\/policy-upload\//);
  assert.deepEqual(service.verify(issued.token), { familyId: 6, taskId: 10, userId: 7, expiresAt: '1970-01-01T00:01:01.000Z' });
  assert.throws(() => service.verify(`${issued.token}x`), { code: 'UPLOAD_LINK_INVALID' });
});
