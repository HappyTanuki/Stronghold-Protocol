#!/usr/bin/env node
// Build a private, versioned resource tree for upstream 9f93096.
// Read-only checks are the default; --stage is the only path that writes.

import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const KR_REPLACE_GROUPS = Object.freeze([
  'map/autochess',
  'map/common',
  'map/fx',
  'map/water',
  'mesh/map_autochess_bkg',
  'mesh/s_background_common',
  'mesh/s_common_box_01',
  'mesh/s_wind_device',
]);

export const REQUIRED_AUDIO = Object.freeze([
  { rel: 'audio/bgm/m_bat_corrosion_intro.mp3', source: 'music/act13d5d0/m_bat_corrosion_intro.mp3', reusable: true },
  { rel: 'audio/bgm/m_bat_corrosion_loop.mp3', source: 'music/act13d5d0/m_bat_corrosion_loop.mp3', reusable: true },
  { rel: 'audio/bgm/m_bat_kazimierz2_1_intro.mp3', source: 'music/act13side/m_bat_kazimierz2_1_intro.mp3' },
  { rel: 'audio/bgm/m_bat_kazimierz2_1_loop.mp3', source: 'music/act13side/m_bat_kazimierz2_1_loop.mp3' },
  { rel: 'audio/bgm/m_bat_kazimierz2_2_loop.mp3', source: 'music/act13side/m_bat_kazimierz2_2_loop.mp3' },
  { rel: 'audio/sfx/battle/b_ui/b_ui_alarmenter.mp3', source: 'battle/b_ui/b_ui_alarmenter.mp3' },
]);

const VOICE_SOURCE_ROOT = 'https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/voice/assets/dyn/audio/sound_beta_2/';
const UPSTREAM_REVISION = '9f93096efaf4d1e671c76b8ca3efc4692b02d15b';
const VOICE_ASSET_RE = /^\/assets\/audio\/voice\/cn\/([^/]+)\/(cn_\d+\.mp3)$/i;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function manifestEntryCount(manifest) {
  if (!manifest || typeof manifest.groups !== 'object' || !manifest.groups) throw new Error('local-assets manifest has no groups object');
  return Object.values(manifest.groups).reduce((sum, group) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new Error('local-assets group must be an object');
    return sum + Object.keys(group).length;
  }, 0);
}

function sortedKeys(value) { return Object.keys(value || {}).sort((a, b) => a.localeCompare(b, 'en')); }

export function mergeLocalAssetsManifest(current, korean) {
  if (!current || typeof current !== 'object' || !current.groups || !korean || typeof korean !== 'object' || !korean.groups) {
    throw new Error('both local-assets manifests must contain groups');
  }
  const krGroups = sortedKeys(korean.groups);
  if (krGroups.length !== KR_REPLACE_GROUPS.length || KR_REPLACE_GROUPS.some((group) => !Object.hasOwn(korean.groups, group))) {
    throw new Error('KR manifest must contain exactly the eight approved replacement groups');
  }
  const mergedGroups = { ...current.groups };
  for (const group of KR_REPLACE_GROUPS) mergedGroups[group] = korean.groups[group];
  const merged = { ...current, groups: mergedGroups };
  delete merged.locale; // this tree is mixed-source, not globally Korean
  merged.count = manifestEntryCount(merged);
  return merged;
}

/** Convert a canonical /assets/local/<group>/... manifest URL to a safe relative file path. */
export function assetRecordToRelativePath(record, group) {
  const urlPath = record?.path;
  if (typeof urlPath !== 'string' || !urlPath.startsWith('/assets/local/') || /[?#]/.test(urlPath)) {
    throw new Error('asset path is not a canonical /assets/local URL');
  }
  const rawSegments = urlPath.slice('/assets/local/'.length).split('/');
  let segments;
  try { segments = rawSegments.map((part) => decodeURIComponent(part)); }
  catch { throw new Error('asset path has invalid percent encoding'); }
  if (segments.length < 2 || segments.some((part) => !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\') || part.includes('\0'))) {
    throw new Error('unsafe or non-canonical asset path');
  }
  const groupParts = String(group).split('/');
  if (segments.slice(0, groupParts.length).join('/') !== group || segments.length <= groupParts.length) {
    throw new Error(`asset path does not belong to group ${group}`);
  }
  return `local/${segments.join('/')}`;
}

async function readJson(filePath) { return JSON.parse(await readFile(filePath, 'utf8')); }

async function listFiles(root) {
  const files = [];
  async function visit(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink is not allowed in asset trees: ${abs}`);
      if (entry.isDirectory()) await visit(abs, rel);
      else if (entry.isFile()) files.push({ rel, abs });
      else throw new Error(`unsupported filesystem entry in asset tree: ${abs}`);
    }
  }
  await visit(root);
  files.sort((a, b) => a.rel.localeCompare(b.rel, 'en'));
  return files;
}

async function treeInventory(root, includeIdentity = false) {
  const files = await listFiles(root);
  const entries = [];
  for (const file of files) {
    const st = await stat(file.abs);
    const item = { path: file.rel, size: st.size, sha256: await sha256File(file.abs) };
    if (includeIdentity) { item.dev = String(st.dev); item.ino = String(st.ino); }
    entries.push(item);
  }
  return entries;
}

function inventoryDigest(entries) {
  const hash = createHash('sha256');
  for (const item of [...entries].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
    hash.update(`${item.path}\0${item.size}\0${item.sha256}\n`);
  }
  return hash.digest('hex');
}

/** Copy regular files only. This is deliberately copyFile-based, never a hardlink operation. */
export async function copyTreeOrdinary(source, destination) {
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error(`source tree must be a real directory: ${source}`);
  await mkdir(destination, { recursive: true });
  async function copyDir(src, dst) {
    for (const entry of await readdir(src, { withFileTypes: true })) {
      const from = path.join(src, entry.name);
      const to = path.join(dst, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink is not allowed in asset trees: ${from}`);
      if (entry.isDirectory()) {
        await mkdir(to, { recursive: true });
        await copyDir(from, to);
      } else if (entry.isFile()) {
        await mkdir(path.dirname(to), { recursive: true });
        await copyFile(from, to);
      } else throw new Error(`unsupported filesystem entry in asset tree: ${from}`);
    }
  }
  await copyDir(source, destination);
}

function sameSet(left, right) {
  return left.length === right.length && [...left].sort().every((value, i) => value === [...right].sort()[i]);
}

export async function verifyKrPackage(packageRoot) {
  const manifestPath = path.join(packageRoot, 'data', 'local-assets.json');
  const provenancePath = path.join(packageRoot, 'provenance.json');
  const validationPath = path.join(packageRoot, 'validation.json');
  const [manifestBytes, manifest, provenance, validation] = await Promise.all([
    readFile(manifestPath), readJson(manifestPath), readJson(provenancePath), readJson(validationPath),
  ]);
  const manifestSha256 = sha256(manifestBytes);
  const groups = sortedKeys(manifest.groups);
  if (manifest.locale !== 'ko-KR') throw new Error('KR package locale must be ko-KR');
  if (!sameSet(groups, KR_REPLACE_GROUPS)) throw new Error('KR package does not contain exactly the approved eight groups');
  const records = [];
  for (const group of groups) {
    for (const [name, record] of Object.entries(manifest.groups[group])) {
      records.push({ group, name, record, relativePath: assetRecordToRelativePath(record, group) });
    }
  }
  if (manifest.count !== records.length || provenance.manifestSha256 !== manifestSha256) {
    throw new Error('KR package manifest count or provenance manifest digest mismatch');
  }
  if (validation.status !== 'valid' || validation.manifestCount !== records.length || validation.assetFileCount !== records.length ||
      !sameSet(validation.groups || [], KR_REPLACE_GROUPS)) {
    throw new Error('KR package validation report is not valid for the packaged manifest');
  }
  const outputFiles = provenance.outputFiles;
  if (!outputFiles || typeof outputFiles !== 'object' || Object.keys(outputFiles).length !== records.length) {
    throw new Error('KR package provenance output file inventory does not match manifest');
  }
  const expectedOutputKeys = new Set();
  for (const entry of records) {
    const outputKey = `public/assets/${entry.relativePath}`;
    expectedOutputKeys.add(outputKey);
    const expected = outputFiles[outputKey];
    if (!expected || typeof expected.sha256 !== 'string') throw new Error(`KR package is missing provenance hash for ${outputKey}`);
    const filePath = path.join(packageRoot, 'public', 'assets', ...entry.relativePath.split('/'));
    const st = await stat(filePath);
    if (!st.isFile() || st.size !== expected.size || await sha256File(filePath) !== expected.sha256) {
      throw new Error(`KR package output hash/size mismatch: ${outputKey}`);
    }
  }
  const actualFiles = await listFiles(path.join(packageRoot, 'public', 'assets', 'local'));
  if (actualFiles.length !== records.length || actualFiles.some((f) => !expectedOutputKeys.has(`public/assets/local/${f.rel}`))) {
    throw new Error('KR package local asset tree has missing or unmanifested files');
  }
  return { manifest, provenance, validation, groups, records, manifestSha256, hashesChecked: records.length };
}

function toVoiceRelative(assetUrl, language) {
  const match = VOICE_ASSET_RE.exec(String(assetUrl));
  if (!match) throw new Error(`unexpected upstream voice cue URL: ${assetUrl}`);
  const [, charId, fileName] = match;
  const folder = language === 'ja' ? 'jp' : language;
  return `audio/voice/${folder}/${charId}/${fileName.toLowerCase()}`;
}

function voiceSourceUrl(relativePath, rawRoot = VOICE_SOURCE_ROOT) {
  const prefix = relativePath.startsWith('audio/voice/jp/') ? 'voice/' : 'voice_kr/';
  const suffix = relativePath.slice(relativePath.indexOf('/', 'audio/voice/'.length) + 1);
  return rawRoot + prefix + suffix.split('/').map(encodeURIComponent).join('/');
}

function manifestVoiceLines(manifest) {
  const voice = manifest?.audio?.voice;
  if (!voice || typeof voice !== 'object' || Array.isArray(voice)) throw new Error('upstream asset manifest has no audio.voice map');
  const lines = [];
  for (const charId of sortedKeys(voice)) {
    const slots = voice[charId];
    if (!slots || typeof slots !== 'object' || Array.isArray(slots)) throw new Error(`invalid voice slots for ${charId}`);
    for (const slot of sortedKeys(slots)) {
      const urls = Array.isArray(slots[slot]) ? slots[slot] : [slots[slot]];
      urls.forEach((url, index) => {
        const relJa = toVoiceRelative(url, 'ja');
        const relKr = toVoiceRelative(url, 'kr');
        lines.push({ charId, slot, index, upstreamUrl: url, ja: { rel: relJa }, kr: { rel: relKr } });
      });
    }
  }
  return lines;
}

function downloaderRecord(records, language, relativePath) {
  const languageRecords = records?.[language];
  if (languageRecords instanceof Map) return languageRecords.get(relativePath);
  return languageRecords?.[relativePath];
}

function materializedAsset(line, language, records, rawRoot) {
  const rel = line[language].rel;
  const result = downloaderRecord(records, language, rel);
  const status = result?.status || (result?.available === true ? 'ok' : 'missing-record');
  const available = result?.available === true || status === 'ok' || status === 'skip';
  return {
    available,
    status: available ? (status === 'skip' ? 'verified-existing' : 'staged') : (status === 'miss' ? 'source-404' : status),
    assetPath: rel,
    url: `/assets/${rel}`,
    sourceUrl: voiceSourceUrl(rel, rawRoot),
    ...(result?.sha256 ? { sha256: result.sha256 } : {}),
    ...(Number.isFinite(result?.bytes) ? { bytes: result.bytes } : {}),
    ...(!available && result?.error ? { reason: result.error } : {}),
    language,
  };
}

export function buildVoiceAvailability(assetsManifest, records = {}, rawRoot = VOICE_SOURCE_ROOT) {
  const lines = manifestVoiceLines(assetsManifest);
  const characters = {};
  for (const line of lines) {
    const byChar = characters[line.charId] || (characters[line.charId] = {});
    const bySlot = byChar[line.slot] || (byChar[line.slot] = []);
    bySlot[line.index] = {
      index: line.index,
      cue: path.posix.basename(line.upstreamUrl),
      ja: materializedAsset(line, 'ja', records, rawRoot),
      kr: materializedAsset(line, 'kr', records, rawRoot),
    };
  }
  let jaAvailable = 0, krAvailable = 0, krFallbackToJa = 0, unresolved = 0;
  for (const char of Object.values(characters)) {
    for (const cues of Object.values(char)) {
      for (const cue of cues) {
        if (cue.ja.available) jaAvailable++;
        if (cue.kr.available) krAvailable++;
        else if (cue.ja.available) krFallbackToJa++;
        else unresolved++;
      }
    }
  }
  const characterIds = sortedKeys(characters);
  return {
    schemaVersion: 1,
    source: { manifest: 'upstream data/assets.json#audio.voice', upstreamRevision: UPSTREAM_REVISION,
      voiceDump: 'ArknightsAssets2/voice/assets/dyn/audio/sound_beta_2' },
    policy: { selectedLanguages: ['ja', 'kr'], jaFallback: null, krFallback: 'ja', cnFallback: false },
    characters,
    summary: {
      characters: characterIds.length,
      cueOccurrences: lines.length,
      jaAvailable,
      krAvailable,
      krFallbackToJa,
      unresolvedForKr: unresolved,
      unresolvedForJa: lines.filter((line) => !characters[line.charId][line.slot][line.index].ja.available).length,
    },
  };
}

export function resolveVoiceCue(availability, selectedLanguage, charId, slot, lineIndex = 0) {
  if (selectedLanguage !== 'ja' && selectedLanguage !== 'kr') throw new Error(`unsupported voice language: ${selectedLanguage}`);
  const cue = availability?.characters?.[charId]?.[slot]?.[lineIndex];
  if (!cue) return null;
  if (selectedLanguage === 'ja') return cue.ja?.available ? cue.ja : null;
  if (cue.kr?.available) return cue.kr;
  return cue.ja?.available ? cue.ja : null;
}

function requiredAudioPathsReferenced(manifest) {
  const found = new Set();
  const audio = manifest?.audio || {};
  for (const part of [audio.bgm?.unite, ...(Array.isArray(audio.bgm?.combatAlts) ? audio.bgm.combatAlts : [])]) {
    for (const value of Object.values(part || {})) if (typeof value === 'string') found.add(value);
  }
  const leak = audio.sfx?.battle?.leak;
  if (typeof leak === 'string') found.add(leak);
  return found;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.part-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, filePath);
}

async function verifyManifestTree(manifest, assetsRoot) {
  for (const group of sortedKeys(manifest.groups)) {
    for (const record of Object.values(manifest.groups[group])) {
      const rel = assetRecordToRelativePath(record, group);
      const st = await stat(path.join(assetsRoot, ...rel.split('/')));
      if (!st.isFile()) throw new Error(`manifest file is not a regular file: ${rel}`);
    }
  }
}

function isKrGroupFile(rel) {
  return KR_REPLACE_GROUPS.some((group) => rel.startsWith(`local/${group}/`));
}

function compareEntries(a, b) {
  return a.length === b.length && a.every((x, i) => x.path === b[i].path && x.size === b[i].size && x.sha256 === b[i].sha256);
}

function assertCandidatePreservesSource(sourceEntries, candidateEntries, expectedKrFiles, stagedNewFiles) {
  const sourceMap = new Map(sourceEntries.map((item) => [item.path, item]));
  const candidateMap = new Map(candidateEntries.map((item) => [item.path, item]));
  const expectedGroupSet = new Set(expectedKrFiles);
  const stagedSet = new Set(stagedNewFiles);
  for (const item of sourceEntries) {
    if (isKrGroupFile(item.path)) continue;
    const copied = candidateMap.get(item.path);
    if (!copied || copied.size !== item.size || copied.sha256 !== item.sha256) {
      throw new Error(`non-KR shared asset changed or missing in candidate: ${item.path}`);
    }
    if (copied.dev === item.dev && copied.ino === item.ino) throw new Error(`candidate hardlinks to shared source: ${item.path}`);
  }
  for (const item of candidateEntries) {
    if (isKrGroupFile(item.path)) {
      if (!expectedGroupSet.has(item.path)) throw new Error(`unexpected asset in a replaced KR group: ${item.path}`);
      continue;
    }
    if (!sourceMap.has(item.path) && !stagedSet.has(item.path)) throw new Error(`unexpected new candidate asset: ${item.path}`);
  }
  for (const expected of expectedGroupSet) {
    if (!candidateMap.has(expected)) throw new Error(`KR package asset missing in candidate: ${expected}`);
  }
  for (const rel of stagedSet) {
    if (!candidateMap.has(rel)) throw new Error(`staged required asset missing from candidate: ${rel}`);
  }
}

async function makeRecordMap(jobs, results, assetsRoot) {
  const records = {};
  for (const job of jobs) {
    const result = results.get(job.rel) || { status: 'error', error: 'downloader returned no result' };
    let record = { status: result.status, ...(result.error ? { error: result.error } : {}) };
    if (result.status === 'ok' || result.status === 'skip') {
      const filePath = path.join(assetsRoot, ...job.rel.split('/'));
      const st = await stat(filePath);
      record = { ...record, bytes: st.size, sha256: await sha256File(filePath) };
    }
    records[job.rel] = record;
  }
  return records;
}

async function prepareOutputRoot(outputRoot, cleanupInputDir) {
  try {
    const entries = await readdir(outputRoot);
    const allowed = cleanupInputDir ? path.basename(cleanupInputDir) : null;
    if (entries.some((entry) => entry !== allowed)) throw new Error(`release output already contains files: ${outputRoot}`);
    if (allowed && !entries.includes(allowed)) throw new Error(`expected stage input directory is absent: ${cleanupInputDir}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (cleanupInputDir) throw new Error('cleanup input directory requires an existing release output root');
    await mkdir(outputRoot, { recursive: true });
  }
}

function assertCleanupInput(outputRoot, cleanupInputDir) {
  if (!cleanupInputDir) return;
  const resolvedRoot = path.resolve(outputRoot);
  const resolvedInput = path.resolve(cleanupInputDir);
  if (path.dirname(resolvedInput) !== resolvedRoot || path.basename(resolvedInput) !== '.stage-input') {
    throw new Error('cleanup input must be the exact .stage-input child of the release output');
  }
}

function parseCli(argv) {
  const out = { mode: 'check', concurrency: 12 };
  for (const arg of argv) {
    if (arg === '--stage') { out.mode = 'stage'; continue; }
    if (arg === '--check') { out.mode = 'check'; continue; }
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (!arg.startsWith('--') || !arg.includes('=')) throw new Error(`unknown argument: ${arg}`);
    const separator = arg.indexOf('=');
    const key = arg.slice(2, separator), value = arg.slice(separator + 1);
    if (!value) throw new Error(`empty value for --${key}`);
    if (key === 'concurrency') out.concurrency = Math.max(1, Math.min(32, Number(value) || 12));
    else if (['kr-package', 'source-assets', 'source-manifest', 'upstream-assets', 'upstream-root', 'output', 'reuse-live-audio-dir', 'cleanup-input'].includes(key)) out[key] = value;
    else throw new Error(`unknown option: --${key}`);
  }
  return out;
}

function helpText() {
  return [
    'Usage:',
    '  node stage-latest-assets.mjs --check --kr-package=<verified-package> --upstream-assets=<data/assets.json>',
    '  node stage-latest-assets.mjs --stage --source-assets=<shared/public/assets> --source-manifest=<shared/data/local-assets.json>',
    '    --kr-package=<verified-package> --upstream-assets=<data/assets.json> --upstream-root=<checkout> --output=<new-release>',
    '    [--reuse-live-audio-dir=<read-only copies of live corrosion BGM>] [--cleanup-input=<release/.stage-input>]',
    'Default mode is read-only --check. Staging requires the explicit --stage flag and an empty new release directory.',
  ].join('\n');
}

async function loadUpstreamHelpers(upstreamRoot) {
  if (!upstreamRoot) throw new Error('--upstream-root is required for staging');
  const base = path.resolve(upstreamRoot, 'tools', 'assets');
  const [downloader, sources, formats] = await Promise.all([
    import(pathToFileURL(path.join(base, 'downloader.mjs')).href),
    import(pathToFileURL(path.join(base, 'sources.mjs')).href),
    import(pathToFileURL(path.join(base, 'formats.mjs')).href),
  ]);
  return { Downloader: downloader.Downloader, RAW: sources.RAW, joinUrl: sources.joinUrl, kindOf: formats.kindOf, validate: formats.validate };
}

async function stageLatestAssets(options) {
  const required = ['source-assets', 'source-manifest', 'kr-package', 'upstream-assets', 'upstream-root', 'output'];
  for (const key of required) if (!options[key]) throw new Error(`--${key} is required with --stage`);
  assertCleanupInput(options.output, options['cleanup-input']);
  const { Downloader, RAW, joinUrl, kindOf, validate } = await loadUpstreamHelpers(options['upstream-root']);
  const packageInfo = await verifyKrPackage(options['kr-package']);
  const currentBytes = await readFile(options['source-manifest']);
  const currentManifest = JSON.parse(currentBytes.toString('utf8'));
  if (currentManifest.count !== manifestEntryCount(currentManifest)) throw new Error('current shared local-assets count is inconsistent');
  const upstreamBytes = await readFile(options['upstream-assets']);
  const upstreamManifest = JSON.parse(upstreamBytes.toString('utf8'));
  const voiceLines = manifestVoiceLines(upstreamManifest);
  const referencedAudio = requiredAudioPathsReferenced(upstreamManifest);
  for (const item of REQUIRED_AUDIO) {
    const canonical = `/assets/${item.rel}`;
    if (!referencedAudio.has(canonical)) throw new Error(`upstream data/assets.json does not reference required payload ${canonical}`);
  }
  if (REQUIRED_AUDIO.some((item) => referencedAudio.has(`/assets/audio/voice/cn/${item.rel}`))) {
    throw new Error('nonvoice payload list unexpectedly collides with CN voice URLs');
  }
  if (voiceLines.some((line) => !line.upstreamUrl.includes('/audio/voice/cn/'))) throw new Error('voice source manifest is not the expected CN-indexed upstream shape');

  const outputRoot = path.resolve(options.output);
  await prepareOutputRoot(outputRoot, options['cleanup-input']);
  const sourceAssetsRoot = path.resolve(options['source-assets']);
  if (outputRoot === sourceAssetsRoot || outputRoot.startsWith(`${sourceAssetsRoot}${path.sep}`) || sourceAssetsRoot.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error('release output and protected shared asset source must be disjoint trees');
  }
  const sourceManifestDigest = sha256(currentBytes);
  const upstreamManifestDigest = sha256(upstreamBytes);
  const sourceInventoryBefore = await treeInventory(sourceAssetsRoot);
  const sourceDigestBefore = inventoryDigest(sourceInventoryBefore);

  const assetsRoot = path.join(outputRoot, 'public', 'assets');
  await copyTreeOrdinary(sourceAssetsRoot, assetsRoot);
  const sourceIdentity = await treeInventory(sourceAssetsRoot, true);
  const copiedIdentity = await treeInventory(assetsRoot, true);
  if (sourceIdentity.length !== copiedIdentity.length || !compareEntries(sourceIdentity, copiedIdentity)) {
    throw new Error('private tree copy is not byte-identical to the live shared asset source');
  }
  for (let i = 0; i < sourceIdentity.length; i++) {
    if (sourceIdentity[i].dev === copiedIdentity[i].dev && sourceIdentity[i].ino === copiedIdentity[i].ino) {
      throw new Error(`private candidate hardlinks to protected shared tree: ${sourceIdentity[i].path}`);
    }
  }

  const packageFiles = [];
  for (const group of KR_REPLACE_GROUPS) {
    const groupRoot = path.join(assetsRoot, 'local', ...group.split('/'));
    await rm(groupRoot, { recursive: true, force: true });
    const sourceGroup = path.join(options['kr-package'], 'public', 'assets', 'local', ...group.split('/'));
    await copyTreeOrdinary(sourceGroup, groupRoot);
  }
  for (const entry of packageInfo.records) packageFiles.push(`local/${entry.relativePath.slice('local/'.length)}`);

  const mergedManifest = mergeLocalAssetsManifest(currentManifest, packageInfo.manifest);
  if (mergedManifest.count !== 1470 || Object.keys(mergedManifest.groups).length !== 21) {
    // This is an inventory-drift guard, not a substitute for the dynamic per-entry checks below.
    throw new Error(`merged local-assets inventory drifted unexpectedly: ${mergedManifest.count} assets / ${Object.keys(mergedManifest.groups).length} groups`);
  }
  await verifyManifestTree(mergedManifest, assetsRoot);
  await mkdir(path.join(outputRoot, 'data'), { recursive: true });
  await writeJson(path.join(outputRoot, 'data', 'local-assets.json'), mergedManifest);

  const downloader = new Downloader({
    root: assetsRoot,
    ledgerPath: path.join(outputRoot, 'reports', 'upstream-download-ledger.json'),
    concurrency: options.concurrency,
    retries: 3,
    timeoutMs: 90000,
    source: 'direct',
    log: (message) => console.log(message),
  });
  await downloader.loadLedger();
  const audioJobs = REQUIRED_AUDIO.map((item) => ({ rel: item.rel, urls: [joinUrl(RAW.aa2voice, item.source)], kind: kindOf(item.rel) }));
  const audioRecords = {};
  const reuseDir = options['reuse-live-audio-dir'];
  for (const item of REQUIRED_AUDIO.filter((entry) => entry.reusable && reuseDir)) {
    const cachedPath = path.join(reuseDir, path.posix.basename(item.rel));
    const cachedBytes = await readFile(cachedPath);
    if (!validate('mp3', cachedBytes)) throw new Error(`live cached BGM is not valid MP3: ${cachedPath}`);
    const relPath = path.join(assetsRoot, ...item.rel.split('/'));
    await mkdir(path.dirname(relPath), { recursive: true });
    try {
      const current = await readFile(relPath);
      if (sha256(current) !== sha256(cachedBytes)) throw new Error(`candidate already contains conflicting required BGM: ${item.rel}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await copyFile(cachedPath, relPath);
    }
    const staged = await readFile(relPath);
    audioRecords[item.rel] = {
      status: 'copied-live-unite-cache', bytes: staged.length, sha256: sha256(staged),
      sourceFile: `read-only copy from running upstream container audio-patches/${path.posix.basename(item.rel)}`,
      upstreamSourceUrl: joinUrl(RAW.aa2voice, item.source),
    };
  }
  const audioDownloadJobs = audioJobs.filter((job) => !Object.hasOwn(audioRecords, job.rel));
  const audioResults = audioDownloadJobs.length ? await downloader.run(audioDownloadJobs, 'required nonvoice audio') : new Map();
  const downloadedAudio = await makeRecordMap(audioDownloadJobs, audioResults, assetsRoot);
  for (const job of audioDownloadJobs) {
    const record = downloadedAudio[job.rel];
    const result = audioResults.get(job.rel);
    if (!['ok', 'skip'].includes(result?.status)) throw new Error(`required nonvoice audio failed: ${job.rel} (${result?.error || result?.status || 'no result'})`);
    audioRecords[job.rel] = {
      status: result.status === 'skip' ? 'preexisting-valid-candidate-copy' : 'downloaded',
      bytes: record.bytes, sha256: record.sha256,
      sourceUrl: result.url || audioJobs.find((item) => item.rel === job.rel)?.urls[0],
      upstreamSourceUrl: audioJobs.find((item) => item.rel === job.rel)?.urls[0],
    };
  }

  const voiceJobs = [];
  for (const line of voiceLines) {
    for (const language of ['ja', 'kr']) {
      const rel = line[language].rel;
      voiceJobs.push({ rel, urls: [joinUrl(RAW.aa2voice, `${language === 'ja' ? 'voice' : 'voice_kr'}/${rel.split('/').slice(3).join('/')}`)], kind: kindOf(rel) });
    }
  }
  const voiceResults = await downloader.run(voiceJobs, 'JA/KR operator voice cues');
  const voiceRecordFlat = await makeRecordMap(voiceJobs, voiceResults, assetsRoot);
  const voiceRecords = { ja: {}, kr: {} };
  for (const job of voiceJobs) {
    const lang = job.rel.startsWith('audio/voice/jp/') ? 'ja' : 'kr';
    const result = voiceResults.get(job.rel);
    if (result?.status === 'error') throw new Error(`${lang.toUpperCase()} voice availability is unverified for ${job.rel}: ${result.error}`);
    voiceRecords[lang][job.rel] = voiceRecordFlat[job.rel];
  }
  const voiceAvailability = buildVoiceAvailability(upstreamManifest, voiceRecords, RAW.aa2voice);
  await writeJson(path.join(outputRoot, 'data', 'voice-availability.json'), voiceAvailability);

  const stagedNewFiles = new Set([...REQUIRED_AUDIO.map((item) => item.rel)]);
  for (const language of ['ja', 'kr']) {
    for (const record of Object.values(voiceRecords[language])) {
      if (record.status === 'ok' || record.status === 'skip') stagedNewFiles.add(Object.keys(voiceRecords[language]).find((rel) => voiceRecords[language][rel] === record));
    }
  }
  const candidateInventoryIdentity = await treeInventory(assetsRoot, true);
  const candidateInventory = candidateInventoryIdentity.map(({ path: rel, size, sha256: digest }) => ({ path: rel, size, sha256: digest }));
  const expectedKrFiles = packageInfo.records.map((entry) => entry.relativePath);
  assertCandidatePreservesSource(sourceIdentity, candidateInventoryIdentity, expectedKrFiles, stagedNewFiles);

  const sourceInventoryAfter = await treeInventory(sourceAssetsRoot);
  if (!compareEntries(sourceInventoryBefore, sourceInventoryAfter) || sourceManifestDigest !== sha256(await readFile(options['source-manifest']))) {
    throw new Error('protected shared asset tree or its manifest changed during staging');
  }
  const finalManifestBytes = await readFile(path.join(outputRoot, 'data', 'local-assets.json'));
  const finalManifest = JSON.parse(finalManifestBytes.toString('utf8'));
  if (finalManifest.count !== manifestEntryCount(finalManifest)) throw new Error('staged merged local-assets count failed readback');
  for (const group of sortedKeys(currentManifest.groups)) {
    if (!KR_REPLACE_GROUPS.includes(group) && JSON.stringify(finalManifest.groups[group]) !== JSON.stringify(currentManifest.groups[group])) {
      throw new Error(`unrelated local-assets group changed: ${group}`);
    }
  }
  for (const group of KR_REPLACE_GROUPS) {
    if (JSON.stringify(finalManifest.groups[group]) !== JSON.stringify(packageInfo.manifest.groups[group])) throw new Error(`KR group mismatch on readback: ${group}`);
  }
  if (Object.hasOwn(finalManifest, 'locale')) throw new Error('mixed local-assets manifest must not advertise a global locale');
  if (stagedNewFiles.size !== REQUIRED_AUDIO.length + [...voiceJobs].filter((job) => {
    const result = voiceResults.get(job.rel);
    return result?.status === 'ok' || result?.status === 'skip';
  }).length) throw new Error('staged asset path inventory contains duplicate voice records');

  const audioInventory = [];
  for (const item of REQUIRED_AUDIO) {
    const result = audioRecords[item.rel];
    const filePath = path.join(assetsRoot, ...item.rel.split('/'));
    const bytes = await readFile(filePath);
    if (!validate('mp3', bytes) || sha256(bytes) !== result.sha256) throw new Error(`required nonvoice audio failed final verification: ${item.rel}`);
    audioInventory.push({ assetPath: item.rel, url: `/assets/${item.rel}`, ...result });
  }
  for (const cue of voiceLines) {
    for (const language of ['ja', 'kr']) {
      const record = voiceRecords[language][cue[language].rel];
      if (!record || record.status === 'miss') continue;
      const filePath = path.join(assetsRoot, ...cue[language].rel.split('/'));
      if (!record.sha256 || await sha256File(filePath) !== record.sha256) throw new Error(`voice cue hash failed final readback: ${cue[language].rel}`);
    }
  }

  const jaVoiceFiles = Object.values(voiceRecords.ja).filter((record) => record.status === 'ok' || record.status === 'skip').length;
  const krVoiceFiles = Object.values(voiceRecords.kr).filter((record) => record.status === 'ok' || record.status === 'skip').length;
  const krMissing = Object.values(voiceRecords.kr).filter((record) => record.status === 'miss').length;
  const jaMissing = Object.values(voiceRecords.ja).filter((record) => record.status === 'miss').length;
  const missingBoth = [];
  for (const line of voiceLines) {
    if (voiceRecords.kr[line.kr.rel]?.status === 'miss' && voiceRecords.ja[line.ja.rel]?.status === 'miss') {
      missingBoth.push({ charId: line.charId, slot: line.slot, cue: path.posix.basename(line.upstreamUrl), kr: 'missing', ja: 'missing' });
    }
  }
  const rootDigest = inventoryDigest(candidateInventory);
  const report = {
    schemaVersion: 1,
    upstreamRevision: UPSTREAM_REVISION,
    stagedAt: new Date().toISOString(),
    releaseRoot: outputRoot,
    source: {
      assetsPath: sourceAssetsRoot,
      localAssetsManifestPath: path.resolve(options['source-manifest']),
      sourceAssetCount: sourceInventoryBefore.length,
      sourceAssetTreeSha256: sourceDigestBefore,
      sourceLocalAssetsManifestSha256: sourceManifestDigest,
      sourceUnchangedAfterStage: true,
      copyMode: 'ordinary byte copy (copyFile; not hardlinks)',
    },
    krPackage: {
      source: path.resolve(options['kr-package']),
      locale: 'ko-KR',
      groups: packageInfo.groups,
      assets: packageInfo.records.length,
      manifestSha256: packageInfo.manifestSha256,
      hashesChecked: packageInfo.hashesChecked,
    },
    mergedLocalAssets: {
      path: 'data/local-assets.json',
      count: finalManifest.count,
      groups: Object.keys(finalManifest.groups).length,
      krReplacedGroups: KR_REPLACE_GROUPS,
      unrelatedGroupsPreserved: Object.keys(currentManifest.groups).filter((group) => !KR_REPLACE_GROUPS.includes(group)).length,
      globalLocaleLabel: null,
    },
    requiredNonvoiceAudio: audioInventory,
    voice: {
      indexSchema: 'upstream data/assets.json#audio.voice (CN-indexed cue names; CN audio is not staged or offered)',
      voiceSourceRoot: RAW.aa2voice,
      sourceMapping: { ja: 'voice/<charId>/<cn_NNN>.mp3', kr: 'voice_kr/<charId>/<cn_NNN>.mp3' },
      policy: { ja: 'Japanese only; missing cue is omitted', kr: 'Korean cue if staged; otherwise Japanese same character/slot/cue; if both missing omit', cnFallback: false },
      characterCount: voiceAvailability.summary.characters,
      cueOccurrences: voiceAvailability.summary.cueOccurrences,
      jaAvailableFiles: jaVoiceFiles,
      jaMissingFiles: jaMissing,
      krAvailableFiles: krVoiceFiles,
      krMissingFiles: krMissing,
      krFallbackToJaCueOccurrences: voiceAvailability.summary.krFallbackToJa,
      unresolvedForKrCueOccurrences: voiceAvailability.summary.unresolvedForKr,
      unresolvedForJaCueOccurrences: voiceAvailability.summary.unresolvedForJa,
      missingBoth,
      manifestPath: 'data/voice-availability.json',
      resolverIntegrationRequired: true,
    },
    candidateAssetTreeSha256: rootDigest,
    candidateAssetFileCount: candidateInventory.length,
  };
  await writeJson(path.join(outputRoot, 'reports', 'provenance.json'), report);
  await writeJson(path.join(outputRoot, 'reports', 'asset-inventory.json'), candidateInventory);
  await writeJson(path.join(outputRoot, 'reports', 'voice-download-status.json'), voiceRecords);
  await writeJson(path.join(outputRoot, 'reports', 'required-audio-status.json'), audioInventory);

  if (options['cleanup-input']) await rm(path.resolve(options['cleanup-input']), { recursive: true, force: false });
  console.log(JSON.stringify({
    status: 'staged-and-verified', releaseRoot: outputRoot,
    privateAssetTree: path.join(outputRoot, 'public', 'assets'),
    mergedLocalManifest: path.join(outputRoot, 'data', 'local-assets.json'),
    voiceAvailability: path.join(outputRoot, 'data', 'voice-availability.json'),
    mergedLocalAssets: report.mergedLocalAssets,
    requiredAudio: audioInventory.length,
    voice: report.voice,
    candidateAssetFileCount: candidateInventory.length,
    candidateAssetTreeSha256: rootDigest,
  }, null, 2));
  return report;
}

async function checkOnly(options) {
  if (!options['kr-package'] || !options['upstream-assets']) throw new Error('--kr-package and --upstream-assets are required in --check mode');
  const packageInfo = await verifyKrPackage(options['kr-package']);
  const manifest = await readJson(options['upstream-assets']);
  const voiceLines = manifestVoiceLines(manifest);
  const requiredAudio = requiredAudioPathsReferenced(manifest);
  const missingAudio = REQUIRED_AUDIO.map((item) => `/assets/${item.rel}`).filter((url) => !requiredAudio.has(url));
  console.log(JSON.stringify({
    status: missingAudio.length ? 'check-failed' : 'check-ok',
    krPackage: { assets: packageInfo.records.length, groups: packageInfo.groups.length, manifestSha256: packageInfo.manifestSha256 },
    upstreamVoiceIndex: { characters: sortedKeys(manifest.audio.voice).length, cueOccurrences: voiceLines.length, languages: ['ja', 'kr'], cnFallback: false },
    requiredNonvoiceAudio: REQUIRED_AUDIO.length,
    missingRequiredAudioReferences: missingAudio,
    sourceMapping: { ja: 'voice/<charId>/<cn_NNN>.mp3', kr: 'voice_kr/<charId>/<cn_NNN>.mp3' },
    policy: { ja: 'JA only', kr: 'KR then same-cue JA', neither: 'omit', cnFallback: false },
  }, null, 2));
  if (missingAudio.length) throw new Error('upstream manifest is missing required nonvoice audio references');
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) { console.log(helpText()); return; }
  if (options.mode === 'stage') await stageLatestAssets(options);
  else await checkOnly(options);
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  main().catch((error) => { console.error(`[stage-latest-assets] ${error?.stack || error}`); process.exitCode = 1; });
}
