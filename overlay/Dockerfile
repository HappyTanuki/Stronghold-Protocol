FROM node:22-bookworm-slim AS verify
WORKDIR /app
COPY --from=upstream . .
COPY --from=overlay / /overlay/
COPY --from=artifacts / /artifacts/
RUN node /overlay/scripts/apply-overlay.mjs /app /overlay
RUN npm ci && npm run vendor
RUN node --test test/build.test.js test/version.test.js test/data.test.js test/assets.test.js test/static-local-art.test.js test/ui/buildGuard.test.js test/ui/loadout.test.js test/ui/loadout-stats.test.js test/ui/gameLogic.test.js test/ui/localArt.test.js test/ui/emotes.test.js test/ui/richText.test.js
RUN node --test test/match/board.test.js test/match/feedback1-placement.test.js test/render/issue25-downback.test.js test/render/feedback2-doll.test.js test/sim/feedback2-doll.test.js test/sim/feedback2-forced-exit-down.test.js
RUN node --test /overlay/tests/overlay-contract.test.mjs
RUN mkdir -p /verify && sha256sum data/local-assets.json public/fonts/nanum-gothic/*.ttf > /verify/artifact-hashes.txt
FROM verify AS runtime
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
EXPOSE 3000
CMD ["node","server/index.js"]
