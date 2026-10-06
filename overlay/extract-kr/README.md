# Stronghold Korean extraction adapter

This host-side adapter builds **new, isolated packages from the installed Korean Arknights client only**. It uses the pinned Stronghold upstream exporter and crop tables as guarded helpers; it does not fork/copy `extract.py` or `aklz4.py`, call upstream `main()`, download assets, merge an old manifest, modify the upstream checkout, or deploy a package.

## Frozen CLI

Run from any working directory with the existing pinned Python environment:

```sh
PY='C:/Users/rlaal/source/repos/Stronghold-local-assets-repair/.venv/Scripts/python.exe'
UP='C:/Users/rlaal/source/repos/stronghold-latest-deploy/upstream'
KR='I:/YostarGames/Arknights_KR'
AD='C:/Users/rlaal/source/repos/stronghold-latest-deploy/overlay/extract-kr'

"$PY" -B "$AD/extract_kr.py" inspect --upstream "$UP" --install "$KR" --all-jobs
"$PY" -B "$AD/extract_kr.py" extract --upstream "$UP" --install "$KR" --only mesh/s_wind_device --out-root 'D:/Hermes/cache/scratch/stronghold-kr-wind-r1'
"$PY" -B "$AD/extract_kr.py" extract --upstream "$UP" --install "$KR" --only mesh/s_common_box_01 --out-root 'D:/Hermes/cache/scratch/stronghold-kr-crate-r1'
"$PY" -B "$AD/extract_kr.py" extract --upstream "$UP" --install "$KR" --only emoticon/basic_2 --out-root 'D:/Hermes/cache/scratch/stronghold-kr-sprite-r1'
"$PY" -B "$AD/extract_kr.py" extract --upstream "$UP" --install "$KR" --profile board --out-root 'D:/Hermes/cache/scratch/stronghold-kr-board-r1'
"$PY" -B "$AD/extract_kr.py" validate --upstream "$UP" --out-root 'D:/Hermes/cache/scratch/stronghold-kr-board-r1'
node "$AD/crop_kr.mjs" --upstream "$UP" --package-root 'D:/Hermes/cache/scratch/stronghold-kr-board-r1' --check
```

`--out-root` must be a **previously absent absolute directory**, with an existing parent. Extraction stages beside it, validates everything, then atomically renames the complete package. Existing output paths, path traversal, symlink/reparse paths, outputs inside the game/upstream trees, unsupported client/catalog snapshots, and upstream preimage drift are refused. `inspect` and `validate` are read-only. No command has an overwrite, force, CN fallback, network, or deployment mode.

`--only` is repeatable and selects output-group prefixes using the upstream `select_jobs` semantics. An unknown prefix, missing catalog content, stale H content, or zero-export selected bundle is a hard failure; old groups are never carried forward. `--profile board` is the first supported complete package and cannot be combined with `--only`. Exit **2** means usage, source identity/version, unsupported source, or requested-content refusal; exit **1** means decode/export/package validation failure.

## Supported board package

The board profile requires all of these upstream groups:

- `map/autochess`
- `mesh/map_autochess_bkg`
- `mesh/s_background_common`
- `mesh/s_common_box_01`
- `mesh/s_wind_device`
- `map/fx`
- `map/common`
- `map/water`

It resolves the real KR catalog's active H entries first. A B bundle is accepted only when its B catalog identity and bytes match the active H record exactly (`hash`, `md5`, and `abSize`). A cataloged `[[kr]]/` override wins and never falls back if absent or invalid. H downloads must also match `persistent_res_list.json`. Catalog/file MD5 and `abSize` are checked before staging and source/catalog hashes are checked again before promotion. Brackets in bundle names are literal.

The adapter records every primary and staged shader dependency, including the chosen root, exact source-relative name, catalog records (`hash`, `md5`, `abSize`, `totalSize`, `pid`/`cid` when present), byte size and SHA-256. It records client/catlog identities, Unity bundle metadata, object path IDs as decimal strings, texture formats/dimensions, decoder/dependency versions, output file hashes, and decoded PNG pixel hashes. Private installation paths are confined to `provenance.json`; the browser manifest contains only package-relative asset URLs.

### Manifest schema (consumer version 1)

`data/local-assets.json` preserves the existing consumer fields and entry style:

```json
{
  "version": 1,
  "source": "local-client",
  "locale": "ko-KR",
  "sourceSnapshot": "<H versionId>/<manifestVersion>",
  "count": 123,
  "groups": {
    "mesh/s_common_box_01": {
      "pCube2": {
        "path": "/assets/local/mesh/s_common_box_01/pCube2.obj",
        "kind": "Mesh",
        "verts": 25,
        "faces": 30
      }
    }
  }
}
```

The numbers above illustrate the shape; actual count and groups come from the exported package. `count` is recomputed from all completed group entries. The board profile explicitly registers `map/autochess/tiles` as `kind: "Derived"` at `/assets/local/map/autochess/tiles.json`; the file sits next to the D atlas because the renderer fetches it there. Tiles URLs are fixed to `/assets/local/map/autochess/...`, never computed relative to `upstream/public`.

### Provenance and validation schemas

The private `provenance.json` has `schemaVersion: 1` and the following required top-level fields:

- `adapter`, `adapterVersion`, `profile`
- `requestedGroups`, `producedGroups`, `missingGroups`
- `sourceIdentity`: `installRoot`, `identity`, `catalogHashes`, `catalogPaths`, and B/H roots
- `upstream`: pinned `head` and `files` SHA-256 map
- `dependencyVersions`
- `sourceFiles[]`: each record has `role`, `logicalPath`, `relativePath`, `sourceRoot`, `absolutePath`, `catalogRecord`, `sourceCatalogRecord`, `baseCatalogRecord`, `persistentRecord`, `size`, `sha256`, `md5`
- `jobs[]`: selected primary bundle/group, source identity, export paths, Unity header/block metadata, object `pathId` strings/names/output mapping, object type counts, texture formats and CAB index
- `transformRecipes`, `outputFiles`, `manifestSha256`, `warnings`, `knownLimitations`

`outputFiles` maps package-relative paths such as `public/assets/local/map/autochess/TX_autochessi_D.png` to `{size, sha256, pixelSha256, width, height}` for PNGs (other files omit pixel fields). `validation.json` has `schemaVersion: 1`, `status: "valid"`, `profile`, `manifestCount`, `groups`, `assetFileCount`, source snapshot ID, and the board/tiles validation summaries. `validate` independently re-resolves provenance sources, re-hashes the live KR inputs and package outputs, checks manifest referential integrity, and for board packages re-validates the **saved** tiles file without writing.

The committed contract is `contract.json`. It pins the upstream HEAD and consumed source-byte hashes, the supported KR client/catalog snapshot, board consumer key maps from guarded `load.js`, 36 board UV surface names from guarded `atlas.js`, and real source/output pixel/geometry fixtures. Tests should read these literal values; do not derive or update expected hashes from adapter output.

## Normal-map correction

For this verified KR profile, `TX_autochessi_N` is TextureFormat 12 (DXT5), has constant R=255 and encodes X/Y as A/G. The adapter preserves its original RGBA PNG and uses the guarded upstream Z lookup after reordering A/G to X/Y. It emits `TX_autochessi_N_rgb.png` with `derive: "normal_dxt5nm_ag"`; the unsupported upstream BC5/RG-on-DXT5 result (flat Z=128) is not used. The recipe is bound to the observed format, dimensions, and constant-red profile; unknown packings fail closed. The existing gloss-to-roughness helper is retained and fixture checked. No global green flip, texture rotation, or second mesh-space transform is applied.

## Known coverage limits

- The three fool-day emote groups are absent from this KR catalog and therefore fail if requested.
- `spine/token_10039_ulpia_block` is present but exports zero requested `Texture2D`/`TextAsset` objects; selecting it fails instead of producing an empty success group.
- Enemy Spine IDs `enemy_1305_mhslim` and `enemy_1305_mhslim_2` are explicitly unverified and unsupported in adapter v1; `inspect` reports that no accepted targeted scan/export was performed.
- `map/autochesssand` and other non-board groups may be individually requested if their real catalog content is present, but their complete runtime behavior is not covered by the board profile.
- Passing structural/pixel validations does not claim visual parity or runtime/browser playtesting. A human semantic/contact-sheet review remains distinct from hashes, dimensions, and statistical crop checks.
- `contract.json` pins one observed game/catalog snapshot and upstream preimage. Updates must be revalidated before changing those pins.

The installed game is read-only input. Package outputs are staging artifacts for a separate, explicitly authorized integration/deployment decision.
