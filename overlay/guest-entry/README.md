# Stronghold-only username allowlist entry

This is an explicitly approved low-trust game gate, **not identity authentication**. Anyone who knows an allowed username can enter. The gate grants no Authentik, administrator, portal, or other-game session.

- Active human usernames were snapshotted from Authentik at activation (five entries). Anonymous/service accounts and inactive accounts are excluded. Passwords and password hashes are not copied.
- Exact username matching; no registration. Newly created Authentik accounts are not automatically admitted. Updating the private allowlist requires a reviewed export and gate restart; existing Authentik accounts and policies are unchanged.
- HTTPS-only HttpOnly host-scoped signed cookie, 12-hour lifetime, CSRF/Origin checks, bounded input and per-IP login limits.
- Nginx authorizes only Stronghold page/resource/WebSocket routes through this service. Other routes keep the existing portal authorization.
- Docker service `stronghold-entry`, loopback `127.0.0.1:3011`, restart `unless-stopped`, read-only root, dropped capabilities, no-new-privileges. No game restart was needed.

## Operations

Runtime project: `/home/happytanuki/Docker/stronghold-entry`.
The private `config/users.json` and `config/signing-key` are deliberately excluded from Git. Bootstrap is fail-closed if either already exists. The Dockerfile uses the installed `game-portal:0.1.1` image as its Node runtime, not an external image dependency.

Run `node --test server.test.mjs` for isolated tests. `probe.py` validates the staged gate; `verify-public.py` exercises real HTTPS form submission, unknown-name denial, image bytes, and other-game isolation without printing cookies. These operational probes read one allowlisted username server-side; they never retrieve a password.

`activate.py` backs up both affected Nginx files and rolls back on syntax/reload failure. It is a one-time guarded activation, not an idempotent arbitrary configuration replacement. Rollback: restore the two files from the private `nginx-before-*` backup, run `nginx -t`, then gracefully reload Nginx. Keep Authentik running for unrelated services.

## Verified live

Existing username accepted; unknown username rejected; unauthenticated game request redirects to `/stronghold-entry`. The resulting cookie loads the game, PNG image (2,057,900 bytes), fonts and voice metadata. That same cookie does not authorize SummerGrowth or the portal `/api/me` endpoint. Existing match/socket remained running after reload. PNG transfer measured about 30ms from the server through its public hostname; this is not a measurement of the user's browser/network.

Authelia was not installed or activated: the agreed username-only gate does not need an identity provider. Authentik remains intact for other services.
