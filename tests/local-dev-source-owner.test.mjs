import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertDevSourceOwner, readDevSourceOwner } from '../scripts/local-dev-source-owner.mjs';

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-local-source-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, 'runtime');
  const sourceA = path.join(root, 'source-a');
  const sourceB = path.join(root, 'source-b');
  fs.mkdirSync(sourceA);
  fs.mkdirSync(sourceB);
  return { runtimeDir, sourceA, sourceB };
}

test('first development start binds the runtime to its canonical source tree', (t) => {
  const { runtimeDir, sourceA } = createFixture(t);

  const owner = assertDevSourceOwner({ runtimeDir, projectRoot: sourceA, claimIfMissing: true });

  assert.equal(owner, fs.realpathSync(sourceA));
  assert.equal(readDevSourceOwner(runtimeDir), fs.realpathSync(sourceA));
});

test('a different source tree cannot start or stop the bound development runtime', (t) => {
  const { runtimeDir, sourceA, sourceB } = createFixture(t);
  assertDevSourceOwner({ runtimeDir, projectRoot: sourceA, claimIfMissing: true });

  assert.throws(
    () => assertDevSourceOwner({ runtimeDir, projectRoot: sourceB, claimIfMissing: true }),
    (error) => error?.code === 'LOCAL_DEV_SOURCE_MISMATCH' && error.message.includes(fs.realpathSync(sourceA)),
  );
  assert.throws(
    () => assertDevSourceOwner({ runtimeDir, projectRoot: sourceB }),
    (error) => error?.code === 'LOCAL_DEV_SOURCE_MISMATCH',
  );
});

test('legacy unbound runtime can still be stopped', (t) => {
  const { runtimeDir, sourceA } = createFixture(t);
  assert.equal(assertDevSourceOwner({ runtimeDir, projectRoot: sourceA }), '');
  assert.equal(readDevSourceOwner(runtimeDir), '');
});
