#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ADAPTER_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(fs.readFileSync(path.join(ADAPTER_DIR, 'contract.json'), 'utf8'));
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
  const key = arg.slice(2);
  if (key === 'check') { options.check = true; continue; }
  if (!['upstream', 'package-root'].includes(key)) throw new Error(`unknown option: ${arg}`);
  if (options[key]) throw new Error(`duplicate option: ${arg}`);
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`missing value for ${arg}`);
  options[key] = args[++i];
}
if (!options.upstream || !options['package-root']) {
  throw new Error('usage: node crop_kr.mjs --upstream <upstream> --package-root <package> [--check]');
}

const RAW_UPSTREAM = options.upstream;
const RAW_PACKAGE = options['package-root'];
let UPSTREAM;
let PACKAGE;
const within = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function assertNoReparse(target) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`reparse/symlink path component refused: ${current}`);
  }
}
function verifyUpstream() {
  if (!fs.statSync(UPSTREAM).isDirectory()) throw new Error(`upstream directory not found: ${UPSTREAM}`);
  const git = spawnSync('git', ['--no-optional-locks', '-C', UPSTREAM, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (git.status !== 0) throw new Error(`cannot read upstream HEAD: ${(git.stderr || '').trim()}`);
  const head = git.stdout.trim();
  if (head !== CONTRACT.upstream.head) throw new Error(`unsupported upstream HEAD ${head}; expected ${CONTRACT.upstream.head}`);
  for (const [relative, expected] of Object.entries(CONTRACT.upstream.files)) {
    const file = path.join(UPSTREAM, ...relative.split('/'));
    if (digest(file) !== expected) throw new Error(`upstream source drift: ${relative}`);
  }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function verifyCropData(crop, atlas, images) {
  const problems = [];
  for (const [key, source] of Object.entries(crop.SOURCES)) {
    const decoded = images[key];
    if (!decoded || decoded.w !== source.w || decoded.h !== source.h) problems.push(`bad source dimensions: ${key}`);
  }
  for (const [name, layers] of Object.entries(crop.MATERIALS)) {
    for (const layer of layers) {
      if (layer.proc) continue;
      const source = crop.SOURCES[layer.src];
      const img = images[layer.src];
      if (!source || !img) { problems.push(`${name}: missing source ${layer.src}`); continue; }
      const [x, y, w, h] = layer.rect;
      if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w <= 8 || h <= 8 || x + w > source.w || y + h > source.h) {
        problems.push(`${name}: invalid ${layer.src} rectangle ${JSON.stringify(layer.rect)}`);
        continue;
      }
      const stats = crop.rectStats(img, layer.rect);
      const decal = layer !== layers[0] || layer.scale != null;
      if ((!decal && stats.opaque < 0.9) || (decal && stats.opaque < 0.05) || stats.std < 2) {
        problems.push(`${name}: empty/flat crop ${layer.src} ${JSON.stringify(layer.rect)}`);
      }
    }
  }
  for (const [name, surface] of Object.entries(atlas.SURFACES)) {
    const source = crop.SOURCES[surface.src];
    const img = images[surface.src];
    const [x, y, w, h] = surface.rect;
    if (!source || !img || ![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w <= 8 || h <= 8 || x + w > source.w || y + h > source.h) {
      problems.push(`board3d ${name}: invalid ${surface.src} rectangle ${JSON.stringify(surface.rect)}`);
      continue;
    }
    const stats = crop.rectStats(img, surface.rect);
    if ((surface.src === 'D' && stats.opaque < 0.9) || (surface.src === 'common' && stats.opaque < 0.05) || stats.std < 2) {
      problems.push(`board3d ${name}: empty/flat crop ${surface.src} ${JSON.stringify(surface.rect)}`);
    }
  }
  if (problems.length) throw new Error(`crop table validation failed:\n  ${problems.join('\n  ')}`);
}
function expectedTiles(crop, atlas, images) {
  const source = {};
  for (const [key, item] of Object.entries(crop.SOURCES)) {
    const img = images[key];
    source[key] = { path: `/assets/local/map/autochess/${item.file}`, w: img.w, h: img.h };
  }
  const board3d = Object.fromEntries(Object.entries(atlas.SURFACES).map(([key, value]) => [key, {
    ...clone(value), rect: [...value.rect],
  }]));
  return {
    version: 2,
    generatedBy: 'overlay/extract-kr/crop_kr.mjs',
    cell: 256,
    source,
    materials: clone(crop.MATERIALS),
    backdrop: clone(crop.BACKDROP),
    board3d,
  };
}
function validateSavedTiles(file, expected, crop, atlas) {
  if (!fs.existsSync(file)) throw new Error(`missing generated crop table: ${file}`);
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`invalid tiles.json: ${error.message}`); }
  if (JSON.stringify(saved) !== JSON.stringify(expected)) throw new Error('saved tiles.json differs from the guarded source tables');
  for (const [key, source] of Object.entries(crop.SOURCES)) {
    const rec = saved.source?.[key];
    if (!rec || rec.path !== `/assets/local/map/autochess/${source.file}` || rec.w !== source.w || rec.h !== source.h) {
      throw new Error(`tiles.json source mapping invalid for ${key}`);
    }
  }
  const surfaceNames = Object.keys(atlas.SURFACES).sort();
  if (JSON.stringify(Object.keys(saved.board3d || {}).sort()) !== JSON.stringify(surfaceNames)) throw new Error('tiles.json board3d key set mismatch');
  for (const [name, layers] of Object.entries(saved.materials || {})) {
    if (!Array.isArray(layers) || !layers.length) throw new Error(`tiles.json material missing layers: ${name}`);
    for (const layer of layers) {
      if (layer.proc) continue;
      if (!saved.source[layer.src] || !Array.isArray(layer.rect) || layer.rect.length !== 4) throw new Error(`tiles.json invalid layer: ${name}`);
    }
  }
  return saved;
}

async function main() {
  assertNoReparse(RAW_UPSTREAM);
  assertNoReparse(RAW_PACKAGE);
  UPSTREAM = path.resolve(RAW_UPSTREAM);
  PACKAGE = path.resolve(RAW_PACKAGE);
  verifyUpstream();
  if (!fs.statSync(PACKAGE).isDirectory()) throw new Error(`package root is not a directory: ${PACKAGE}`);
  if (within(PACKAGE, UPSTREAM)) throw new Error('package root inside upstream worktree is refused');
  const cropUrl = pathToFileURL(path.join(UPSTREAM, 'tools/crop-board-atlas.mjs')).href;
  const atlasUrl = pathToFileURL(path.join(UPSTREAM, 'public/js/render/board3d/atlas.js')).href;
  const [crop, atlas] = await Promise.all([import(cropUrl), import(atlasUrl)]);
  const dir = path.join(PACKAGE, 'public', 'assets', 'local', 'map', 'autochess');
  if (!fs.statSync(dir).isDirectory()) throw new Error(`missing board texture directory: ${dir}`);
  const images = {};
  for (const [key, item] of Object.entries(crop.SOURCES)) {
    const file = path.join(dir, item.file);
    if (!fs.existsSync(file)) throw new Error(`missing source image ${item.file}`);
    images[key] = crop.decodePng(fs.readFileSync(file));
    if (images[key].w !== item.w || images[key].h !== item.h) throw new Error(`${item.file}: ${images[key].w}x${images[key].h}, expected ${item.w}x${item.h}`);
  }
  verifyCropData(crop, atlas, images);
  const expected = expectedTiles(crop, atlas, images);
  const tilesFile = path.join(dir, 'tiles.json');
  if (!options.check) fs.writeFileSync(tilesFile, `${JSON.stringify(expected, null, 1)}\n`, { flag: 'wx' });
  const saved = validateSavedTiles(tilesFile, expected, crop, atlas);
  console.log(JSON.stringify({ status: 'valid', mode: options.check ? 'check' : 'generated', tiles: 'public/assets/local/map/autochess/tiles.json', materialCount: Object.keys(saved.materials).length, board3dSurfaceCount: Object.keys(saved.board3d).length, source: saved.source }));
}

main().catch((error) => {
  console.error(`[crop_kr] ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
