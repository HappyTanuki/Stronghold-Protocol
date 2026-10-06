import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const overlayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = path.resolve(process.env.OVERLAY_APP_ROOT || path.join(overlayRoot, '../work/latest-9f93096/overlay-app'));
const moduleUrl = (relative) => pathToFileURL(path.join(appRoot, relative)).href;

const { DEFAULT_SETTINGS, sanitizeSettings } = await import(moduleUrl('public/js/ui/gameLogic.js'));
const { AudioManager, VoiceGate } = await import(moduleUrl('public/js/audio.js'));
const { createDataStore } = await import(moduleUrl('public/js/data.js'));

function cue({ kr = false, ja = false } = {}) {
  return {
    index: 0,
    cue: 'cn_001.mp3',
    kr: { available: kr, assetPath: 'audio/voice/kr/char_test/cn_001.mp3', url: '/assets/audio/voice/kr/char_test/cn_001.mp3', language: 'kr' },
    ja: { available: ja, assetPath: 'audio/voice/jp/char_test/cn_001.mp3', url: '/assets/audio/voice/jp/char_test/cn_001.mp3', language: 'ja' },
  };
}

function availability(value) {
  return { schemaVersion: 1, characters: { char_test: { start: [value] } } };
}

function rig(voiceAvailability, cnUrl = '/assets/audio/voice/cn/char_test/cn_001.mp3') {
  const requested = [];
  const manager = new AudioManager({
    getManifest: () => ({ audio: { voice: { char_test: { start: cnUrl } } } }),
    getVoiceAvailability: () => voiceAvailability,
    random: () => 0,
  });
  manager.ctx = {};
  manager.voiceGain = {};
  manager._playVoice = (url) => requested.push(url);
  manager.voiceGate = new VoiceGate({ gapMs: 0 });
  return { manager, requested };
}

test('voice language is sanitized and defaults to Korean without changing existing volume settings', () => {
  assert.equal(DEFAULT_SETTINGS.voiceLanguage, 'ko');
  assert.equal(sanitizeSettings(null).voiceLanguage, 'ko');
  assert.equal(sanitizeSettings({ voiceLanguage: 'ja', voice: 0.35 }).voiceLanguage, 'ja');
  assert.equal(sanitizeSettings({ voiceLanguage: 'cn', voice: 0.35 }).voiceLanguage, 'ko');
  assert.equal(sanitizeSettings({ voiceLanguage: 'ja', voice: 0.35 }).voice, 0.35);
});

test('settingsStore persists the voice language without changing the display-language preference', async () => {
  const previousStorage = globalThis.localStorage;
  const values = new Map([['sp.pref.lang', 'ko']]);
  globalThis.localStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  try {
    const first = await import(`${moduleUrl('public/js/ui/settings.js')}?voice-persist-write`);
    const before = first.settingsStore.get();
    first.updateSettings({ voiceLanguage: 'ja' });
    const saved = JSON.parse(values.get('sp.pref.settings'));
    assert.equal(saved.voiceLanguage, 'ja');
    assert.equal(saved.voice, before.voice, 'the existing voice volume remains unchanged');
    assert.equal(values.get('sp.pref.lang'), 'ko', 'voice language is independent from UI language');

    const reloaded = await import(`${moduleUrl('public/js/ui/settings.js')}?voice-persist-reload`);
    assert.equal(reloaded.settingsStore.get().voiceLanguage, 'ja');
    assert.equal(reloaded.settingsStore.get().voice, before.voice);
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('data store loads the staged voice availability document from its production endpoint', async () => {
  const requested = [];
  const fixture = { schemaVersion: 1, characters: {} };
  const store = createDataStore({ fetch: async (url) => {
    requested.push(url);
    return { ok: true, json: async () => fixture };
  } });
  assert.deepEqual(await store.load('voiceAvailability'), fixture);
  assert.deepEqual(requested, ['/data/voice-availability.json']);
});

test('Korean voice uses the Korean cue, then the same Japanese cue, and otherwise stays silent', () => {
  const korean = rig(availability(cue({ kr: true, ja: true })));
  assert.equal(korean.manager.setVoiceLanguage?.('ko'), true);
  assert.equal(korean.manager.voice('char_test', 'start'), true);
  assert.deepEqual(korean.requested, ['/assets/audio/voice/kr/char_test/cn_001.mp3']);

  const fallback = rig(availability(cue({ ja: true })));
  fallback.manager.setVoiceLanguage?.('ko');
  assert.equal(fallback.manager.voice('char_test', 'start'), true);
  assert.deepEqual(fallback.requested, ['/assets/audio/voice/jp/char_test/cn_001.mp3']);

  const missing = rig(availability(cue()));
  missing.manager.setVoiceLanguage?.('ko');
  assert.equal(missing.manager.voice('char_test', 'start'), false);
  assert.deepEqual(missing.requested, [], 'neither localized payload means silence, not the CN manifest URL');
});

test('Japanese voice selection is Japanese-only even when a Korean cue exists', () => {
  const selected = rig(availability(cue({ kr: true, ja: true })));
  assert.equal(selected.manager.setVoiceLanguage?.('ja'), true);
  assert.equal(selected.manager.voice('char_test', 'start'), true);
  assert.deepEqual(selected.requested, ['/assets/audio/voice/jp/char_test/cn_001.mp3']);

  const missing = rig(availability(cue({ kr: true })));
  missing.manager.setVoiceLanguage?.('ja');
  assert.equal(missing.manager.voice('char_test', 'start'), false);
  assert.deepEqual(missing.requested, [], 'Japanese mode never falls back to Korean or the upstream CN URL');
});
