import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const overlay = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.resolve(overlay, '..');
const upstream = process.env.UPSTREAM || path.join(project, 'work', 'latest-9f93096', 'upstream');
const artifacts = path.join(overlay, 'artifacts');
const revision = '9f93096efaf4d1e671c76b8ca3efc4692b02d15b';
const scratch = 'D:/Hermes/cache/scratch';
const tempBase = process.env.OVERLAY_TEST_TMPDIR || (process.platform === 'win32' && fs.existsSync(scratch) ? scratch : (process.env.TMPDIR || os.tmpdir()));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));

function run(command, args, cwd, env = process.env) {
  return cp.spawnSync(command, args, { cwd, encoding: 'utf8', env });
}

function listFiles(base, relative = '') {
  const found = [];
  for (const entry of fs.readdirSync(path.join(base, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...listFiles(base, child));
    else if (entry.isFile() || entry.isSymbolicLink()) found.push(child);
  }
  return found;
}

test('frozen 0.1.4 source accepts the Korean patch without losing upstream fixes', t => {
  const lock = JSON.parse(fs.readFileSync(path.join(overlay, 'overlay.lock.json'), 'utf8'));
  const inventoryPath = path.join(artifacts, 'upstream-inventory.json');
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  const compatibility = JSON.parse(fs.readFileSync(path.join(overlay, 'compatibility.json'), 'utf8'));
  const dockerfile = fs.readFileSync(path.join(overlay, 'Dockerfile.deploy'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(upstream, 'package.json'), 'utf8'));
  const constants = fs.readFileSync(path.join(upstream, 'shared/constants.js'), 'utf8');

  assert.equal(lock.upstream, revision);
  assert.equal(inventory.revision, revision);
  assert.equal(shaFile(inventoryPath), lock.upstreamInventory);
  assert.equal(pkg.version, '0.1.4');
  assert.match(constants, /APP_VERSION = '0\.1\.4'/);
  assert.equal(compatibility.matrix[0].upstream, revision);
  assert.equal(compatibility.matrix[0].appVersion, '0.1.4');
  if (lock.assetManifest == null) {
    assert.equal(compatibility.release.ready, false);
    assert.match(dockerfile, /final local-assets manifest SHA is pending/);
  } else {
    assert.match(lock.assetManifest, /^[a-f0-9]{64}$/);
  }
  assert.match(dockerfile, new RegExp(revision));
  assert.match(dockerfile, /require\('\.\/package\.json'\)\.version !== '0\.1\.4'/);
  assert.match(dockerfile, /org\.opencontainers\.image\.version="0\.1\.4-ko-overlay-v2-voice-ja-kr"/);
  assert.doesNotMatch(dockerfile, /0\.1\.3|763e224b8d72c2362e70a8f1283a74e644195712/);

  const dir = fs.mkdtempSync(path.join(tempBase, 'stronghold-latest-overlay-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = path.join(dir, 'app');
  fs.cpSync(upstream, app, { recursive: true });
  const testOverlay = path.join(dir, 'overlay');
  fs.mkdirSync(testOverlay, { recursive: true });
  for (const name of ['overlay.lock.json', 'patches', 'files', 'scripts']) {
    fs.cpSync(path.join(overlay, name), path.join(testOverlay, name), { recursive: true });
  }
  const testArtifacts = path.join(dir, 'artifacts');
  fs.mkdirSync(testArtifacts);
  for (const name of ['upstream-revision', 'upstream-inventory.json']) {
    fs.copyFileSync(path.join(artifacts, name), path.join(testArtifacts, name));
  }
  const voiceAvailability = path.join(project, 'work', 'latest-9f93096', 'verified-artifacts', 'voice-availability.json');
  assert.ok(fs.existsSync(voiceAvailability), 'real staged voice-availability fixture is required');
  fs.copyFileSync(voiceAvailability, path.join(testArtifacts, 'voice-availability.json'));
  // Isolated, empty test-only manifest: this exercises overlay application, not release assets.
  const testManifest = Buffer.from('{"version":1,"source":"test-only","count":0,"groups":{}}\n');
  fs.writeFileSync(path.join(testArtifacts, 'local-assets.json'), testManifest);
  const testLockPath = path.join(testOverlay, 'overlay.lock.json');
  const testLock = JSON.parse(fs.readFileSync(testLockPath, 'utf8'));
  testLock.assetManifest = sha(testManifest);
  fs.writeFileSync(testLockPath, JSON.stringify(testLock));

  const apply = run(process.execPath, [path.join(testOverlay, 'scripts/apply-overlay.mjs'), app, testOverlay, testArtifacts]);
  assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
  const version = run(process.execPath, [path.join(testOverlay, 'scripts/overlay-version.mjs'), app, testOverlay, testArtifacts]);
  assert.equal(version.status, 0, `${version.stdout}\n${version.stderr}`);
  const buildTag = JSON.parse(version.stdout).tag;
  const contract = run(process.execPath, ['--test', path.join(overlay, 'tests/overlay-contract.test.mjs')], undefined, {
    ...process.env,
    OVERLAY_APP_ROOT: app,
    ARTIFACTS: testArtifacts,
  });
  assert.equal(contract.status, 0, `${contract.stdout}\n${contract.stderr}`);

  const lobby = fs.readFileSync(path.join(app, 'public/js/screens/lobby.js'), 'utf8');
  const settings = fs.readFileSync(path.join(app, 'public/js/ui/settings.js'), 'utf8');
  const title = fs.readFileSync(path.join(app, 'public/js/screens/title.js'), 'utf8');
  const richText = fs.readFileSync(path.join(app, 'public/js/ui/richText.js'), 'utf8');
  const audio = fs.readFileSync(path.join(app, 'public/js/audio.js'), 'utf8');
  const main = fs.readFileSync(path.join(app, 'public/js/main.js'), 'utf8');
  assert.match(main, /import '\.\/i18n\/i18n\.js'/);
  assert.match(lobby, /\bERR\s*\}/);
  assert.match(lobby, /<\$\{LangButton/);
  assert.match(lobby, /LoadoutButton/);
  assert.match(settings, /label="干员语音"[\s\S]*?value=\$\{s\.voice\}/);
  assert.match(settings, /setLang/);
  assert.match(title, /import \{ SettingsModal \} from '\.\.\/ui\/settings\.js'/);
  assert.match(title, /<\$\{SettingsModal} open=\$\{settingsOpen\}/);
  assert.match(richText, /Math\.max\(0, Math\.min\(1, base \+ per \* L\)\)/);
  assert.match(richText, /import \{ tr \} from '\.\.\/i18n\/i18n\.js'/);
  assert.match(audio, /case PHASE\.UNITE:[\s\S]*?return 'unite'/);
  assert.match(audio, /a\.bgm\?\.unite \|\| a\.bgm\?\.combat/);

  const beforePaths = new Set(Object.keys(inventory.files));
  const afterPaths = new Set(listFiles(app));
  const allowedAdded = new Set([...lock.added, 'data/local-assets.json', 'data/voice-availability.json', `public/js/i18n/build-tag-${buildTag}.js`]);
  const actualAdded = [...afterPaths].filter(name => !beforePaths.has(name));
  assert.deepEqual(actualAdded.sort(), [...allowedAdded].sort());
  for (const [relative, expected] of Object.entries(inventory.files)) {
    if (lock.allowedModified.includes(relative)) continue;
    assert.equal(shaFile(path.join(app, relative)), expected, `unexpected upstream mutation: ${relative}`);
  }
});
