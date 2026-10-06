import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const PACKAGE_ROOT = process.env.KR_PACKAGE_ROOT;
const UPSTREAM = process.env.STRONGHOLD_UPSTREAM;
assert.ok(PACKAGE_ROOT, 'KR_PACKAGE_ROOT must point at the real board CLI output; this test never skips missing art');
assert.ok(UPSTREAM, 'STRONGHOLD_UPSTREAM must point at the pinned upstream checkout');
const pkg = path.resolve(PACKAGE_ROOT);
const upstream = path.resolve(UPSTREAM);
assert.ok(existsSync(pkg) && statSync(pkg).isDirectory(), `board package is missing: ${pkg}`);

const importUpstream = (rel) => import(pathToFileURL(path.join(upstream, rel)).href);
const [{ PACK_IMAGES, PACK_MESHES, GATE_NODES }, { SURFACES, resolveUvTable, surfaceUV }, { parseObj }, layout, crop, fixture] = await Promise.all([
  importUpstream('public/js/render/board3d/load.js'),
  importUpstream('public/js/render/board3d/atlas.js'),
  importUpstream('public/js/render/board3d/obj.js'),
  importUpstream('public/js/render/board3d/layout.js'),
  importUpstream('tools/crop-board-atlas.mjs'),
  Promise.resolve(JSON.parse(readFileSync(new URL('./fixtures/kr-41.0.1-71ac81.json', import.meta.url), 'utf8'))),
]);

const manifestPath = path.join(pkg, 'data/local-assets.json');
assert.ok(existsSync(manifestPath), `real board manifest is missing: ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert.ok(manifest.groups && typeof manifest.groups === 'object', 'manifest has no groups map');
const allGroupEntries = Object.values(manifest.groups).flatMap((group) => Object.keys(group));
assert.equal(manifest.count, allGroupEntries.length, 'manifest count must equal the completed group-entry count');

function entry(group, name) {
  const value = manifest.groups[group]?.[name];
  assert.ok(value && typeof value === 'object', `manifest is missing ${group}/${name}`);
  return value;
}

function localFile(group, name) {
  const value = entry(group, name);
  const prefix = '/assets/local/';
  assert.ok(typeof value.path === 'string' && value.path.startsWith(prefix), `${group}/${name} has noncanonical URL ${value.path}`);
  const decoded = decodeURIComponent(value.path);
  const relative = decoded.slice(1);
  assert.ok(!relative.split('/').includes('..'), `${group}/${name} URL traverses outside the local assets root`);
  const file = path.join(pkg, 'public', relative);
  assert.ok(existsSync(file) && statSync(file).isFile(), `${group}/${name} file missing at ${file}`);
  return { record: value, file };
}

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function pngPixels(file) {
  return crop.decodePng(readFileSync(file));
}

function cropRgba(image, [x, y, w, h]) {
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    const start = ((y + row) * image.w + x) * 4;
    image.rgba.copy(out, row * w * 4, start, start + w * 4);
  }
  return out;
}

function verticallyFlip(image) {
  const rowBytes = image.w * 4;
  const out = Buffer.alloc(image.rgba.length);
  for (let y = 0; y < image.h; y++) {
    image.rgba.copy(out, (image.h - 1 - y) * rowBytes, y * rowBytes, (y + 1) * rowBytes);
  }
  return out;
}

function finiteGeometry(mesh, label) {
  assert.ok(mesh, `${label}: OBJ did not parse into geometry`);
  assert.ok(mesh.position.length > 0 && mesh.index.length > 0, `${label}: empty geometry`);
  for (const value of mesh.position) assert.ok(Number.isFinite(value), `${label}: non-finite vertex`);
  for (const value of mesh.index) assert.ok(Number.isInteger(value) && value >= 0 && value < mesh.position.length / 3, `${label}: invalid OBJ index ${value}`);
  if (mesh.normal) for (const value of mesh.normal) assert.ok(Number.isFinite(value), `${label}: non-finite normal`);
  return mesh;
}

const requiredGroups = fixture.freeze.board_required_groups;
const tilesPath = path.join(pkg, 'public/assets/local/map/autochess/tiles.json');
assert.ok(existsSync(tilesPath), 'board package did not save tiles.json beside the D atlas');
const tiles = JSON.parse(readFileSync(tilesPath, 'utf8'));
const uvTable = resolveUvTable(tiles);


test('board profile contains every renderer pack image and mesh as a readable package artifact', () => {
  for (const group of requiredGroups) assert.ok(manifest.groups[group], `board profile omitted required group ${group}`);
  for (const [slot, [group, name]] of Object.entries(PACK_IMAGES)) {
    const { record, file } = localFile(group, name);
    assert.ok(record.kind === 'Texture2D' || record.kind === 'Derived', `${slot} has unexpected kind ${record.kind}`);
    const image = pngPixels(file);
    assert.deepEqual([image.w, image.h], [record.w, record.h], `${slot}: manifest dimensions disagree with saved PNG`);
    assert.ok(image.w > 1 && image.h > 1, `${slot}: empty PNG`);
  }
  for (const [slot, [group, name]] of Object.entries(PACK_MESHES)) {
    const { record, file } = localFile(group, name);
    assert.equal(record.kind, 'Mesh', `${slot} is not a mesh manifest entry`);
    finiteGeometry(parseObj(readFileSync(file, 'utf8')), slot);
  }
  const bkgMeshes = Object.values(manifest.groups['mesh/map_autochess_bkg']).filter((value) => value.kind === 'Mesh');
  assert.ok(bkgMeshes.length > 0, 'the fourth required board mesh job exported no mesh');
  for (const record of bkgMeshes) {
    const file = path.join(pkg, 'public', decodeURIComponent(record.path).slice(1));
    assert.ok(existsSync(file), `map_autochess_bkg mesh is missing: ${file}`);
    finiteGeometry(parseObj(readFileSync(file, 'utf8')), 'map_autochess_bkg');
  }
});


test('saved tiles.json has canonical runtime URLs and preserves the source crop contract', () => {
  assert.equal(tiles.version, 2);
  for (const [key, name, w, h] of [
    ['D', 'TX_autochessi_D.png', 2048, 2048],
    ['common', 'TX_autochessi_common_D.png', 1024, 1024],
    ['BG', 'TX_autochessi_BG.png', 1024, 1024],
  ]) {
    assert.deepEqual(tiles.source[key], { path: `/assets/local/map/autochess/${name}`, w, h }, `${key} saved source entry`);
  }
  for (const name of ['crateSide', 'crateTop']) {
    assert.deepEqual(tiles.board3d[name].rect, fixture.board_goldens.crate_crops[name].rect);
    assert.deepEqual(uvTable[name].rect, tiles.board3d[name].rect, `${name}: saved table was not applied to renderer UV table`);
    const [x, y, w, h] = uvTable[name].rect;
    const uv = surfaceUV(uvTable[name], null, 0);
    if (name === 'crateSide') {
      assert.deepEqual(uv, [x / 2048, 1 - (y + h) / 2048, (x + w) / 2048, 1 - (y + h) / 2048, (x + w) / 2048, 1 - y / 2048, x / 2048, 1 - y / 2048]);
    }
  }
  assert.ok(Object.keys(tiles.materials || {}).length > 0, 'tiles.json has no material crop table');
  assert.ok(tiles.backdrop && tiles.backdrop.src === 'BG', 'tiles.json omitted the board backdrop mapping');
});


test('real board pixels, orientation, and crate crops match the installed KR source snapshot', () => {
  for (const [name, golden] of Object.entries(fixture.board_goldens.textures)) {
    const { file } = localFile('map/autochess', name);
    const image = pngPixels(file);
    assert.deepEqual([image.w, image.h], golden.size, name);
    assert.equal(digest(image.rgba), golden.rgba_sha256, `${name} decoded pixel hash`);
  }
  const { file: dFile } = localFile('map/autochess', 'TX_autochessi_D');
  const atlas = pngPixels(dFile);
  assert.equal(digest(atlas.rgba), fixture.board_goldens.atlas_orientation.top_down_rgba_sha256);
  assert.equal(digest(verticallyFlip(atlas)), fixture.board_goldens.atlas_orientation.vertical_flip_rgba_sha256);
  assert.notEqual(digest(atlas.rgba), digest(verticallyFlip(atlas)), 'atlas orientation must not be silently flipped');
  for (const [name, golden] of Object.entries(fixture.board_goldens.crate_crops)) {
    assert.equal(digest(cropRgba(atlas, golden.rect)), golden.rgba_sha256, `${name} crop pixels`);
  }
});


test('theme and effect material tables resolve required shader and texture relationships', () => {
  for (const group of ['map/autochess', 'map/fx']) {
    const { file } = localFile(group, 'materials');
    const materials = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(Object.keys(materials).length > 0, `${group} material table is empty`);
    for (const [materialName, material] of Object.entries(materials)) {
      for (const binding of Object.values(material.textures || {})) {
        const textureName = binding.texture;
        assert.ok(textureName, `${group}/${materialName} has an unnamed texture pointer`);
        assert.ok(allGroupEntries.includes(textureName), `${group}/${materialName} texture ${textureName} is not exported in this package`);
      }
    }
  }
  const { file: fxMaterialsFile } = localFile('map/fx', 'materials');
  const fxMaterials = JSON.parse(readFileSync(fxMaterialsFile, 'utf8'));
  assert.equal(fxMaterials['[opt]start_end_add']?.shader, 'Torappu/Particles/Additive');
  assert.equal(fxMaterials['[opt]start_end_ab']?.shader, 'Torappu/Particles/AlphaBlend');
  assert.equal(fxMaterials['[opt]start_end_add']?.textures?._MainTex?.texture, '[opt]merged_textures');
  const { file: themeFile } = localFile('map/autochess', 'materials');
  const theme = JSON.parse(readFileSync(themeFile, 'utf8'));
  assert.ok(Object.values(theme).some((material) => typeof material.shader === 'string' && material.shader.includes('StandardDirectional')),
    'resolved autochess theme materials must include the standard directional shader');
});


test('prefab gate references resolve to saved OBJ files, including the unscaled duplicate Start_back mesh', () => {
  const { file: prefabFile } = localFile('map/fx', 'prefab');
  const prefab = JSON.parse(readFileSync(prefabFile, 'utf8'));
  assert.ok(Array.isArray(prefab) && prefab.length > 0, 'map/fx prefab hierarchy is missing');
  for (const [slot, nodeName] of Object.entries(GATE_NODES)) {
    const node = prefab.find((item) => item && item.name === nodeName && (nodeName !== 'Start_back' || item.parent === '[opt]start_box'));
    assert.ok(node, `${slot}: expected prefab node ${nodeName}`);
    assert.ok(typeof node.mesh === 'string', `${slot}: prefab node has no mesh key`);
    const { file } = localFile('map/fx', node.mesh);
    finiteGeometry(parseObj(readFileSync(file, 'utf8')), `${slot}/${node.mesh}`);
  }
  const expected = fixture.inputs.map_fx.start_back;
  const standard = prefab.filter((item) => item && item.name === 'Start_back' && item.parent === expected.parent);
  assert.equal(standard.length, 1, 'standard start-box node must be unambiguous despite duplicate mesh names');
  assert.equal(standard[0].mesh, expected.mesh_name, 'standard start box selected the wrong duplicate mesh path ID');
  const standardEntry = localFile('map/fx', expected.mesh_name);
  const standardBytes = readFileSync(standardEntry.file).toString('utf8').replace(/\r\n/g, '\n');
  assert.equal(digest(Buffer.from(standardBytes, 'utf8')), expected.mesh_sha256);
  const alternateEntry = localFile('map/fx', 'Start_back');
  const alternateBytes = readFileSync(alternateEntry.file).toString('utf8').replace(/\r\n/g, '\n');
  assert.equal(digest(Buffer.from(alternateBytes, 'utf8')), expected.scaled_alternative_sha256);
  assert.notEqual(standard[0].mesh, 'Start_back', 'standard start gate must not use the scaled duplicate');
});


test('saved crate OBJ passes renderer parser and board-space projection with saved UVs', () => {
  const { file } = localFile('mesh/s_common_box_01', 'pCube2');
  const parsed = finiteGeometry(parseObj(readFileSync(file, 'utf8')), 'crate');
  const boardSpace = layout.objToBoard(parsed);
  const projected = layout.boxProjectUV(boardSpace, uvTable.crateTop, uvTable.crateSide);
  assert.ok(projected.uv && projected.uv.length === projected.position.length / 3 * 2);
  for (const coord of projected.uv) assert.ok(Number.isFinite(coord) && coord >= 0 && coord <= 1, `invalid projected crate UV ${coord}`);
  assert.ok(projected.bounds.x1 > projected.bounds.x0 && projected.bounds.y1 > projected.bounds.y0 && projected.bounds.z1 > projected.bounds.z0,
    'crate projection has degenerate real bounds');
});
