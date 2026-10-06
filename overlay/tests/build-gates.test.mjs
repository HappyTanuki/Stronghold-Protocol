import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

const overlay = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = process.env.UPSTREAM || path.resolve(overlay, '..', 'upstream');
const artifacts = process.env.ARTIFACTS || path.join(overlay, 'artifacts');
const validator = path.join(overlay, 'scripts/apply-overlay.mjs');
const scratch = 'D:/Hermes/cache/scratch';
const tempBase = process.env.OVERLAY_TEST_TMPDIR || (process.platform === 'win32' && fs.existsSync(scratch) ? scratch : (process.env.TMPDIR || os.tmpdir()));
const run = (root, overlayPath = overlay, artifactPath = artifacts) => cp.spawnSync(process.execPath, [validator, root, overlayPath, artifactPath], { encoding: 'utf8' });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(tempBase, 'overlay-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'upstream');
  fs.cpSync(upstream, root, { recursive: true, filter: source => !source.split(path.sep).includes('.git') });
  const ov = path.join(dir, 'overlay');
  fs.cpSync(overlay, ov, { recursive: true });
  const art = path.join(dir, 'artifacts');
  fs.cpSync(artifacts, art, { recursive: true });
  return { dir, root, ov, art };
}
test('pristine upstream plus overlay passes the real apply validator', t => {
  const f = fixture(t); const r = run(f.root, f.ov, f.art);
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
const cases = [
  ['modified upstream server source', f => fs.appendFileSync(path.join(f.root, 'server/index.js'), '\n// unexpected change\n')],
  ['modified upstream client preimage', f => fs.appendFileSync(path.join(f.root, 'public/js/main.js'), '\n// unexpected change\n')],
  ['unlisted upstream file', f => fs.writeFileSync(path.join(f.root, 'unexpected-source.txt'), 'not in the pinned tree')],
  ['missing upstream file', f => fs.rmSync(path.join(f.root, 'server/index.js'))],
  ['missing dictionary', f => fs.rmSync(path.join(f.ov, 'files/public/i18n/ko/ui.json'))],
  ['missing bold Nanum font', f => fs.rmSync(path.join(f.ov, 'files/public/fonts/nanum-gothic/NanumGothic-Bold.ttf'))],
  ['missing referenced font stylesheet', f => fs.rmSync(path.join(f.ov, 'files/public/fonts/fonts.css'))],
  ['duplicate overlay target', f => fs.writeFileSync(path.join(f.root, 'public/i18n/ko/ui.json'), '{}')],
  ['missing main boot hook', f => fs.writeFileSync(path.join(f.ov, 'patches/ko-ui.patch'), fs.readFileSync(path.join(f.ov, 'patches/ko-ui.patch'), 'utf8').replace("+import './i18n/i18n.js';", '+// removed integration hook'))],
  ['missing lobby language control', f => fs.writeFileSync(path.join(f.ov, 'patches/ko-ui.patch'), fs.readFileSync(path.join(f.ov, 'patches/ko-ui.patch'), 'utf8').replace('+        <${LangButton} class="lobby-lang" variant="secondary" />', '+        <!-- removed control -->'))],
  ['unauthorized source patch target', f => fs.appendFileSync(path.join(f.ov, 'patches/ko-ui.patch'), '\ndiff --git a/server/index.js b/server/index.js\n')],
  ['changed local asset manifest', f => fs.appendFileSync(path.join(f.art, 'local-assets.json'), '\n')],
];
for (const [name, corrupt] of cases) test(`${name} is rejected`, t => {
  const f = fixture(t);
  corrupt(f);
  const result = run(f.root, f.ov, f.art);
  assert.notEqual(result.status, 0, `validator accepted ${name}\n${result.stdout}\n${result.stderr}`);
});
