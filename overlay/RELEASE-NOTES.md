# Korean overlay release — upstream 0.1.4

Base: `9f93096efaf4d1e671c76b8ca3efc4692b02d15b`.

## Included
- External, guarded Korean display overlay; upstream gameplay source remains unchanged in this checkout. Apply the overlay during the image build.
- Korean dictionaries including composite hover-tooltip translations.
- Korean-client extraction adapter, independently pinned to its supported extractor revision; eight verified board groups, 62 outputs.
- Separate persistent Korean/Japanese voice preference. Missing Korean cues fall back to the same Japanese cue; neither available means silence. No Chinese voice fallback.
- Hangul-only Nanum Gothic faces. Latin, digits, symbols, punctuation and other scripts retain the exact upstream family stacks.
- Private resource staging, deployment launcher and focused tests.

## Resources
Game image/model/audio payloads are intentionally excluded. Manifests describe an external read-only resource tree. Board resources were extracted from the Korean client; JA/KR audio was sourced from ArknightsAssets2, not claimed as local extraction. The combined manifest has 1,470 entries in 21 groups and is not wholly Korean-source.

## Verification and limitations
Recorded checks: extractor Python 26 and Node 6; voice settings 5; overlay contract 3; overlay apply 2; compatibility 1; selected upstream tests 60 passed, one skipped. Voice requests and missing-cue fallback were exercised in Chrome. The full browser smoke did not complete; final 2D/3D visual parity is not claimed.

The 0.1.4 release was routed to the new game service; the previous service was retained for rollback. The font change is a separate static update and must also be preserved by future builds. Do not interpret historical partial browser reports as a complete acceptance pass.
