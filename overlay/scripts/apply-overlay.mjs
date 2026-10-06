import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';

const root = path.resolve(process.argv[2] || '/app');
const overlay = path.resolve(process.argv[3] || '/overlay');
const artifacts = path.resolve(process.argv[4] || process.env.OVERLAY_ARTIFACTS || path.join(overlay, 'artifacts'));
const lock = JSON.parse(fs.readFileSync(path.join(overlay, 'overlay.lock.json'), 'utf8'));
const inventoryFile = path.join(artifacts, 'upstream-inventory.json');
const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const expectedModified = [
  'public/js/audio.js',
  'public/js/data.js',
  'public/js/main.js',
  'public/js/screens/lobby.js',
  'public/js/ui/richText.js',
  'public/js/ui/settings.js',
  'public/js/ui/gameLogic.js',
];
const allowedAddedRoots = ['public/i18n/ko/', 'public/js/i18n/', 'public/fonts/nanum-gothic/'];
const allowedAddedFiles = new Set(['public/fonts/fonts.css']);

function confined(base, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error(`invalid relative path: ${relative}`);
  const absolute = path.resolve(base, relative);
  if (!absolute.startsWith(`${base}${path.sep}`)) throw new Error(`path escapes root: ${relative}`);
  return absolute;
}

function listFiles(base, relative = '') {
  const found = [];
  for (const entry of fs.readdirSync(path.join(base, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...listFiles(base, child));
    else if (entry.isFile() || entry.isSymbolicLink()) found.push(child);
    else throw new Error(`unsupported upstream filesystem entry: ${child}`);
  }
  return found;
}

if (sha(inventoryFile) !== lock.upstreamInventory) throw new Error('upstream inventory SHA mismatch');
if (inventory.revision !== lock.upstream) {
  throw new Error(`upstream revision mismatch: lock=${lock.upstream} inventory=${inventory.revision}`);
}
if (!inventory.files || Object.keys(inventory.files).length === 0) throw new Error('upstream inventory is empty');
if (!Array.isArray(lock.allowedModified)
  || JSON.stringify([...lock.allowedModified].sort()) !== JSON.stringify([...expectedModified].sort())) {
  throw new Error('display-only modified-file allowlist mismatch');
}
if (!Array.isArray(lock.added) || new Set(lock.added).size !== lock.added.length
  || lock.added.some(file => !allowedAddedRoots.some(prefix => file.startsWith(prefix)) && !allowedAddedFiles.has(file))) {
  throw new Error('overlay added-file list is invalid or outside approved display-only roots');
}

const expectedPaths = Object.keys(inventory.files).sort();
const actualPaths = listFiles(root).sort();
const missingPaths = expectedPaths.filter(file => !actualPaths.includes(file));
const unexpectedPaths = actualPaths.filter(file => !Object.hasOwn(inventory.files, file));
if (missingPaths.length || unexpectedPaths.length) {
  throw new Error(`upstream inventory path mismatch: missing=${missingPaths.slice(0, 5).join(',')} unexpected=${unexpectedPaths.slice(0, 5).join(',')}`);
}
for (const [relative, expected] of Object.entries(inventory.files)) {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error(`invalid upstream SHA-256: ${relative}`);
  const file = confined(root, relative);
  if (!fs.existsSync(file) || sha(file) !== expected) throw new Error(`upstream source mismatch: ${relative}`);
}

const patch = path.join(overlay, 'patches', 'ko-ui.patch');
const patchText = fs.readFileSync(patch, 'utf8');
const patchTargets = [...patchText.matchAll(/^diff --git a\/([^\s]+) b\/[^\s]+$/gm)].map(match => match[1]);
if (patchTargets.length !== expectedModified.length || new Set(patchTargets).size !== expectedModified.length
  || expectedModified.some(file => !patchTargets.includes(file))) {
  throw new Error(`patch targets do not match the display-only allowlist: ${patchTargets.join(', ')}`);
}
cp.execFileSync('git', ['-C', root, 'apply', '--check', patch]);
cp.execFileSync('git', ['-C', root, 'apply', patch]);

for (const relative of lock.added) {
  const destination = confined(root, relative);
  const source = confined(path.join(overlay, 'files'), relative);
  if (fs.existsSync(destination)) throw new Error(`collision: ${relative}`);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`missing overlay file: ${relative}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

const has = (relative, text) => fs.readFileSync(confined(root, relative), 'utf8').includes(text);
if (!has('public/js/main.js', "import './i18n/i18n.js';")
  || !has('public/js/screens/lobby.js', '<${LangButton')
  || !has('public/js/ui/richText.js', "import { tr } from '../i18n/i18n.js';")
  || !has('public/js/ui/settings.js', 'setLang')
  || !has('public/js/ui/settings.js', 'voiceLanguage')
  || !has('public/js/audio.js', 'resolveVoiceCue')
  || !has('public/js/data.js', "voiceAvailability: 'voice-availability.json'")) {
  throw new Error('overlay display-integration contract missing');
}

const manifest = path.join(artifacts, 'local-assets.json');
if (sha(manifest) !== lock.assetManifest) throw new Error('asset manifest SHA mismatch');
const manifestTarget = confined(root, 'data/local-assets.json');
if (fs.existsSync(manifestTarget)) throw new Error('upstream already contains data/local-assets.json; refusing overwrite');
fs.copyFileSync(manifest, manifestTarget);
const voiceAvailabilityArtifact = path.join(artifacts, 'voice-availability.json');
if (!fs.existsSync(voiceAvailabilityArtifact)) throw new Error('staged data/voice-availability.json is required');
const voiceAvailability = JSON.parse(fs.readFileSync(voiceAvailabilityArtifact, 'utf8'));
if (voiceAvailability.schemaVersion !== 1 || !voiceAvailability.characters
  || typeof voiceAvailability.characters !== 'object' || !Object.keys(voiceAvailability.characters).length
  || voiceAvailability.policy?.jaFallback !== null || voiceAvailability.policy?.krFallback !== 'ja'
  || voiceAvailability.policy?.cnFallback !== false
  || JSON.stringify([...(voiceAvailability.policy?.selectedLanguages || [])].sort()) !== JSON.stringify(['ja', 'kr'])) {
  throw new Error('staged voice availability schema or KR/JA-only policy is invalid');
}
const voiceAvailabilityTarget = confined(root, 'data/voice-availability.json');
if (fs.existsSync(voiceAvailabilityTarget)) throw new Error('upstream already contains data/voice-availability.json; refusing overwrite');
fs.copyFileSync(voiceAvailabilityArtifact, voiceAvailabilityTarget);
console.log(JSON.stringify({
  upstream: inventory.revision,
  files: expectedPaths.length,
  patch: sha(patch),
  manifest: sha(manifestTarget),
  voiceAvailability: sha(voiceAvailabilityArtifact),
}));
