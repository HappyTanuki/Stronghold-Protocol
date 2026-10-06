import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const scriptPath = path.resolve(import.meta.dirname, '../scripts/stage-latest-assets.mjs');
const packageRoot = process.env.KR_PACKAGE_ROOT;
assert.ok(packageRoot, 'KR_PACKAGE_ROOT must point at the verified KR board package');
const { KR_REPLACE_GROUPS, mergeLocalAssetsManifest, assetRecordToRelativePath, verifyKrPackage, copyTreeOrdinary,
  buildVoiceAvailability, resolveVoiceCue } = await import(pathToFileURL(scriptPath).href);

const scratch = process.env.TMPDIR || tmpdir();

test('merged manifest replaces only the eight KR groups and preserves unrelated groups', () => {
  const overlapping = ['map/autochess', 'map/fx', 'mesh/map_autochess_bkg'];
  const unrelated = Array.from({ length: 13 }, (_, i) => `legacy/group-${i}`);
  const currentGroups = Object.fromEntries([
    ...overlapping.map((group) => [group, { stale: { path: `/assets/local/${group}/stale.bin`, kind: 'Binary' } }]),
    ...unrelated.map((group) => [group, { kept: { path: `/assets/local/${group}/kept.bin`, kind: 'Binary' } }]),
  ]);
  const koreanGroups = Object.fromEntries(KR_REPLACE_GROUPS.map((group) => [group, {
    fresh: { path: `/assets/local/${group}/fresh.png`, kind: 'Texture2D' },
  }]));
  const current = { version: 1, source: 'local-client', count: 16, groups: currentGroups };
  const korean = { version: 1, source: 'local-client', locale: 'ko-KR', count: 8, groups: koreanGroups };

  const merged = mergeLocalAssetsManifest(current, korean);

  assert.equal(Object.keys(merged.groups).length, 21);
  assert.equal(merged.count, 21);
  for (const group of unrelated) assert.deepEqual(merged.groups[group], current.groups[group]);
  for (const group of KR_REPLACE_GROUPS) {
    assert.deepEqual(merged.groups[group], korean.groups[group]);
    assert.ok(!Object.hasOwn(merged.groups[group], 'stale'));
  }
  assert.equal(merged.source, 'local-client');
  assert.equal(Object.hasOwn(merged, 'locale'), false, 'mixed manifest must not claim a global locale');
});

test('KR manifest records must resolve canonically inside their declared group', () => {
  assert.equal(
    assetRecordToRelativePath({ path: '/assets/local/map/water/waves.png' }, 'map/water'),
    'local/map/water/waves.png',
  );
  assert.throws(() => assetRecordToRelativePath({ path: '/assets/local/map/water/../../outside.png' }, 'map/water'), /unsafe|canonical|group/i);
  assert.throws(() => assetRecordToRelativePath({ path: '/assets/local/map/common/wind.png' }, 'map/water'), /group/i);
  assert.throws(() => assetRecordToRelativePath({ path: '/assets/local/map/water/%2e%2e/outside.png' }, 'map/water'), /unsafe|canonical|group/i);
});

test('the real KR package has 62 files whose bytes match its provenance hashes', async () => {
  const verified = await verifyKrPackage(packageRoot);
  assert.equal(verified.manifest.count, 62);
  assert.equal(verified.groups.length, 8);
  assert.equal(verified.records.length, 62);
  assert.equal(verified.manifest.locale, 'ko-KR');
  assert.equal(verified.manifestSha256, '6ebcb9f30c8ffc7670fe7dc2f65faebae0a7c14b63242130b3cc68c6c913f52e');
  assert.equal(verified.hashesChecked, 62);
});

test('candidate copy is byte-identical but does not share source inodes', async (t) => {
  const base = await mkdtemp(path.join(scratch, 'stage-latest-assets-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  const destination = path.join(base, 'candidate');
  await mkdir(path.join(source, 'local/map/common'), { recursive: true });
  await writeFile(path.join(source, 'local/map/common/wind.bin'), Buffer.from('original shared bytes'));

  await copyTreeOrdinary(source, destination);

  const from = await stat(path.join(source, 'local/map/common/wind.bin'));
  const to = await stat(path.join(destination, 'local/map/common/wind.bin'));
  assert.deepEqual(await readFile(path.join(destination, 'local/map/common/wind.bin')), Buffer.from('original shared bytes'));
  assert.ok(from.dev !== to.dev || from.ino !== to.ino, 'candidate must not hardlink to the protected source');
});

test('voice availability is explicit per line and Korean falls back only to Japanese', () => {
  const manifest = { audio: { voice: {
    char_001_alpha: {
      place: [
        '/assets/audio/voice/cn/char_001_alpha/cn_001.mp3',
        '/assets/audio/voice/cn/char_001_alpha/cn_002.mp3',
      ],
      skill1: '/assets/audio/voice/cn/char_001_alpha/cn_003.mp3',
    },
  } } };
  const records = {
    ja: {
      'audio/voice/jp/char_001_alpha/cn_001.mp3': { status: 'ok', sha256: 'ja-1', bytes: 10 },
      'audio/voice/jp/char_001_alpha/cn_002.mp3': { status: 'ok', sha256: 'ja-2', bytes: 11 },
      'audio/voice/jp/char_001_alpha/cn_003.mp3': { status: 'miss' },
    },
    kr: {
      'audio/voice/kr/char_001_alpha/cn_001.mp3': { status: 'ok', sha256: 'kr-1', bytes: 12 },
      'audio/voice/kr/char_001_alpha/cn_002.mp3': { status: 'miss' },
      'audio/voice/kr/char_001_alpha/cn_003.mp3': { status: 'miss' },
    },
  };

  const availability = buildVoiceAvailability(manifest, records);
  const first = availability.characters.char_001_alpha.place[0];
  const second = availability.characters.char_001_alpha.place[1];
  const missing = availability.characters.char_001_alpha.skill1[0];

  assert.equal(first.ja.available, true);
  assert.equal(first.kr.available, true);
  assert.equal(second.kr.available, false);
  assert.equal(resolveVoiceCue(availability, 'kr', 'char_001_alpha', 'place', 0).language, 'kr');
  assert.equal(resolveVoiceCue(availability, 'kr', 'char_001_alpha', 'place', 1).language, 'ja');
  assert.equal(resolveVoiceCue(availability, 'ja', 'char_001_alpha', 'place', 0).language, 'ja');
  assert.equal(resolveVoiceCue(availability, 'kr', 'char_001_alpha', 'skill1', 0), null);
  assert.equal(resolveVoiceCue(availability, 'ja', 'char_001_alpha', 'skill1', 0), null);
  assert.equal(missing.ja.available, false);
  assert.equal(missing.kr.available, false);
  assert.ok(!JSON.stringify(availability).includes('/voice/cn/'), 'CN must not be a resolver candidate');
});
