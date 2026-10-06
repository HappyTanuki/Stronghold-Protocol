# Stronghold 0.1.4 Korean display + JA/KR voice overlay

Pinned source: upstream `9f93096efaf4d1e671c76b8ca3efc4692b02d15b` (v0.1.4). Translation donor: `7fef692dd1836e10a2ea60c7538e623ca7a0ad18`. The donor is used only for the checked-in display dictionaries, fonts, and minimal version-checked UI patch; no donor source tree is built or copied wholesale.

## Upload-ready context

The release context is a deterministic tarball containing four independent BuildKit inputs: `default-context/`, `upstream-context/`, `overlay-context/`, and `artifacts-context/`. It includes the 601-file pinned upstream Git archive and hash inventory, the Korean overlay, licensed Nanum Gothic fonts, and the matching local-assets manifest. It does **not** contain extracted game-resource payload files.

After extracting the tarball, run this command on the intended Docker host:

```sh
docker buildx build --progress=plain \
  --file default-context/Dockerfile.build \
  --build-context upstream=./upstream-context \
  --build-context overlay=./overlay-context \
  --build-context artifacts=./artifacts-context \
  --tag stronghold-ko:9f93096-ko-overlay-v2-voice-ja-kr \
  --load ./default-context
```

The final image stage depends on the mandatory pinned-source, upstream regression, overlay contract, negative-gate, and real-browser checks. This command builds an image only; it does not replace or stop a running container.

## Separate runtime assets

`data/local-assets.json` and the staged `data/voice-availability.json` are baked into the image so both indexes survive container recreation. The merged game-resource tree (including localized voice payloads) remains external and must be mounted read-only at `/app/public/assets`; this package contains no resource payload. Nanum Gothic Regular/Bold and the Korean dictionaries are bundled in the image. Voice language is independently persisted in `sp.pref.settings.voiceLanguage`: Korean cues fall back to the same Japanese cue, Japanese selection is Japanese-only, and neither path falls back to upstream CN voice URLs.

