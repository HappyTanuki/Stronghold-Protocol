# Retained extraction and access tooling

The legacy Korean display overlay and Nanum Gothic layer were retired when moving to upstream 0.2.1's native Korean language pack and typography.

- `extract-kr/`: Korean-client extraction adapter. Its extractor pin remains independent of the application revision; see its README and validation contract.
- `guest-entry/`: Stronghold-only username-allowlist entry gate, independent of game localization. Preserve the existing live v2/3012 service and proxy authorization.
- `../extras/`: current guarded resource-manifest, JA/KR voice selection/fallback and profession-glyph integration, with Docker build and tests.

Previous translation code, dictionaries and fonts remain recoverable from Git history. Do not reinstall them into the native-language-pack application.
