# Hidden Korean display audit and live patch

## Verified outcome

- Both live targets received 297 exact display entries and 2 dynamic patterns; no existing live entries were revised.
- Tested the actual deployed translator and actual `richTextPlain` -> native `title` composition in headless Chrome, using each deployment's own snapshot.
- New-target unpatched control: 285 choice records, 114 titles retained CJK. Patched old and new snapshots: 285 choice records each, zero residual CJK in their titles, zero exact-entry DOM/title failures.
- The earlier raw `name + desc` probe had 275 failing records. This is a synthetic comparison, not the actual rendered failure count.
- Nine unique visible-data strings had existing translations under whitespace-bearing keys unreachable after runtime trimming. Added trimmed aliases preserving source data and existing terminology/markup.
- Broader data scan covered 5,432 unique CJK-containing strings. Internal specification/formula/assumption prose was classified separately and was not modified.
- Static inspection covered JS literals/templates plus static HTML text and attributes. `中文` is intentionally retained as the Chinese-language self-name. This is not proof that every possible user/state-generated message is translated.
- Browser checks included late title updates, text nodes, input/code preservation, and unknown-string passthrough. These fixtures are not an authenticated full-match playthrough.

## Live safety and durability

- Targets: stronghold-ko-next-a0a5419 (3002), stronghold-ko-game-763e224 (3004).
- Only ui.json, patterns.json and the revalidated dictionary cache-tag module changed.
- Both dictionary-cache revisions: 0b7964b24b05bf89. Tag module uses Cache-Control: no-cache.
- Served versioned JSON and module bytes matched staged bytes. Container IDs, start times and restart counts remained unchanged; health was OK.
- 177 protected source/data files per target were byte-for-byte unchanged, including server/shared/data and all public JS except the explicitly permitted cache-tag module.
- Remote build overlay dictionaries were also merged/read back. Local canonical overlay merged with one version-specific exception: existing empty `覆盖` remains because the candidate's surrounding Korean import-warning fragments already express overwrite; the live version lacked that sentence arrangement.
- Images were not rebuilt. Live patch backups and readback evidence are identified in hidden-ko-live-verification.json.
- Existing clients must refresh voluntarily to load the new dictionary revision; no reload was forced.

## Artifacts

- hidden-ko-authored.json: directly authored new Korean wording.
- hidden-ko-complete-delta.json: live delta, including reused existing translations for composite aliases.
- hidden-ko-provenance.json: alias provenance.
- hidden-ko-browser-{new,old}-verified.json: browser results.
- ../tests/hidden-ko-browser.cjs: reusable fixture. Requires Playwright and installed Chrome; arguments are snapshot root, delta JSON, and `patched` or `original`.

Example: `node overlay/tests/hidden-ko-browser.cjs SNAPSHOT_ROOT overlay/translations/hidden-ko-complete-delta.json patched`.
