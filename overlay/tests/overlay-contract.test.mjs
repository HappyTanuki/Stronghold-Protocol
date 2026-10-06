import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const overlay = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = process.env.ARTIFACTS || path.join(overlay, 'artifacts');
const root = process.env.OVERLAY_APP_ROOT || '/app';
const sourceInventory = JSON.parse(fs.readFileSync(path.join(artifacts, 'upstream-inventory.json'), 'utf8'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('display overlay preserves upstream gameplay and Chinese data sources', () => {
  for (const [relative, expected] of Object.entries(sourceInventory.files)) {
    if (!/^(data|server|shared)\//.test(relative) || ['data/local-assets.json', 'data/voice-availability.json'].includes(relative)) continue;
    assert.equal(sha(path.join(root, relative)), expected, `upstream-owned file changed: ${relative}`);
  }
});

test('localization integration coexists with upstream loadout and build guard', () => {
  const main = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
  const lobby = fs.readFileSync(path.join(root, 'public/js/screens/lobby.js'), 'utf8');
  const rich = fs.readFileSync(path.join(root, 'public/js/ui/richText.js'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'public/js/ui/settings.js'), 'utf8');
  const audio = fs.readFileSync(path.join(root, 'public/js/audio.js'), 'utf8');
  const gameLogic = fs.readFileSync(path.join(root, 'public/js/ui/gameLogic.js'), 'utf8');
  const data = fs.readFileSync(path.join(root, 'public/js/data.js'), 'utf8');
  assert.match(main, /buildGuard/);
  assert.match(main, /i18n\/i18n/);
  assert.match(lobby, /<\$\{LangButton/);
  assert.match(lobby, /LoadoutButton/);
  assert.match(lobby, /spectate/);
  assert.match(rich, /tr\(String\(src\)\)/);
  assert.match(settings, /setLang/);
  assert.match(settings, /voiceLanguage/);
  assert.match(audio, /resolveVoiceCue/);
  const voiceResolver = audio.match(/export function resolveVoiceCue\(availability, selectedLanguage, charId, slot, lineIndex = 0\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(voiceResolver, 'voice selection must use the staged availability resolver');
  assert.match(voiceResolver, /if \(selectedLanguage === 'ja'\) return japanese\(\);/);
  assert.match(voiceResolver, /return candidate\('kr', 'kr'\) \|\| japanese\(\);/);
  assert.doesNotMatch(voiceResolver, /manifest|audio\.voice/, 'resolver must not fall back to upstream manifest voice URLs');
  assert.match(gameLogic, /voiceLanguage: 'ko'/);
  assert.match(data, /voiceAvailability: 'voice-availability\.json'/);
});

test('all five Korean dictionaries and licensed regular/bold Nanum fonts are shipped', () => {
  for (const file of ['data', 'manual', 'official', 'patterns', 'ui']) {
    assert.ok(fs.existsSync(path.join(root, `public/i18n/ko/${file}.json`)), `missing ${file}.json`);
  }
  for (const file of ['NanumGothic-Regular.ttf', 'NanumGothic-Bold.ttf', 'OFL.txt', 'PROVENANCE.txt']) {
    assert.ok(fs.existsSync(path.join(root, 'public/fonts/nanum-gothic', file)), `missing ${file}`);
  }
  const compatibilityStylesheet = fs.readFileSync(path.join(root, 'public/fonts/fonts.css'), 'utf8');
  assert.match(compatibilityStylesheet, /upstream Bender\/Novecento asset bundle is not shipped/);
  assert.match(compatibilityStylesheet, /Keep the upstream CSS fallback stacks unchanged/);
  assert.doesNotMatch(compatibilityStylesheet, /@font-face/i, 'compatibility stylesheet must not redeclare font faces');
  const koreanFontCss = fs.readFileSync(path.join(root, 'public/i18n/ko/ko.css'), 'utf8');
  assert.match(koreanFontCss, /@font-face[^\n]*Nanum Gothic[^\n]*NanumGothic-Regular\.ttf/);
  assert.match(koreanFontCss, /@font-face[^\n]*Nanum Gothic[^\n]*NanumGothic-Bold\.ttf/);
  assert.ok(fs.existsSync(path.join(root, 'data/local-assets.json')), 'missing durable local-assets manifest');
  const voiceAvailability = JSON.parse(fs.readFileSync(path.join(root, 'data/voice-availability.json'), 'utf8'));
  assert.equal(voiceAvailability.schemaVersion, 1);
  assert.equal(voiceAvailability.policy.krFallback, 'ja');
  assert.equal(voiceAvailability.policy.jaFallback, null);
  assert.equal(voiceAvailability.policy.cnFallback, false);
});
