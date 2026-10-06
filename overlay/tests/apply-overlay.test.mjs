import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

const overlay = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = process.env.UPSTREAM || path.resolve(overlay, '..', 'upstream');
const scratch = 'D:/Hermes/cache/scratch';
const tempBase = process.env.OVERLAY_TEST_TMPDIR || (process.platform === 'win32' && fs.existsSync(scratch) ? scratch : (process.env.TMPDIR || os.tmpdir()));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(tempBase, 'stronghold-overlay-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'upstream');
  fs.cpSync(upstream, root, { recursive: true, filter: source => !source.split(path.sep).includes('.git') });
  const ov = path.join(dir, 'overlay');
  fs.cpSync(overlay, ov, { recursive: true });
  const artifacts = path.join(dir, 'artifacts');
  fs.cpSync(path.join(overlay, 'artifacts'), artifacts, { recursive: true });
  return { dir, root, ov, artifacts };
}

function apply(f) {
  return cp.spawnSync(process.execPath, [path.join(f.ov, 'scripts/apply-overlay.mjs'), f.root, f.ov, f.artifacts], { encoding: 'utf8' });
}

test('pinned latest tree applies with the explicit artifacts directory', t => {
  const f = fixture(t);
  const result = apply(f);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('rejects an artifact inventory whose revision differs from the overlay pin', t => {
  const f = fixture(t);
  const inventoryPath = path.join(f.artifacts, 'upstream-inventory.json');
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  inventory.revision = 'not-the-pinned-revision';
  fs.writeFileSync(inventoryPath, JSON.stringify(inventory));
  const result = apply(f);
  assert.notEqual(result.status, 0, `accepted mismatched revision\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /revision|pin|upstream/i);
});
