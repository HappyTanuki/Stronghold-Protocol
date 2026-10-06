# Profession small-icon correction

The original `prof.icon` payloads were horizontal nameplates with Chinese labels, but `ui/assetUrls.js` expects small white glyphs. Resizing whole nameplates into 18–24px squares made them unreadable.

`derive-profession-glyphs.py` derives the existing right-hand white symbol into a transparent 64×64 PNG. It does not redraw the symbols or modify the original nameplates. Inputs are validated by size and glyph location; output/source hashes and crop coordinates are recorded in the generated provenance.json.

Prepare external resources with Pillow:

```sh
python overlay/scripts/derive-profession-glyphs.py --source /path/to/original/assets/prof --output /path/to/new/assets/prof/glyph-v1
```

Preserve that directory in private release asset trees. Game PNG payloads remain outside Git. `apply-overlay.mjs` applies `scripts/prof-icon-paths.json` during the build, changing only eight `prof.icon` URLs in data/assets.json. Large, battlecard, subprofession, and all other mappings remain unchanged. New filenames avoid stale nameplate caches.

Verification: all eight outputs decoded as 64×64 transparent white glyphs; contact-sheet inspection showed no names or black nameplates. Clean overlay application succeeded and every other manifest field was compared unchanged. All eight served production PNG hashes matched the generated provenance. The live update changed the manifest and added files without restarting the game or touching the protected old server.
