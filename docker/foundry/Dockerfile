# napoleon-foundry — felddy/foundryvtt:13 with the StablePiggy Napoleon module
# baked in at /opt/napoleon-module/. install-module.sh copies the staged bytes
# into the data volume on container start before exec'ing felddy's PID-1
# entrypoint.
#
# See FOUNDRY-HARNESS-V2 spec §6 (in the DevVault MCP repo) for the full
# design rationale: image-bake replaces the legacy Barn-symlink delivery,
# IMAGE_VERSION marker drives data-volume updates on bundle.update, the
# wrapper script chains into felddy's entrypoint to preserve PID-1 signal
# handling.
#
# Build via the .github/workflows/release-image.yml workflow on tag push,
# or locally with docker build (--build-arg MODULE_VERSION=vX.Y.Z required
# so the IMAGE_VERSION file ends up correct).

FROM felddy/foundryvtt:13

# felddy's image runs as USER node by default; switch to root to install
# the wrapper script, then restore.
USER root

# Bake module bytes into a stable in-image staging directory. install-
# module.sh copies these into /data/Data/modules/<id>/ at container start.
# The directory layout under /opt/napoleon-module mirrors what Foundry
# expects to find at /data/Data/modules/stablepiggy-napoleon-game-assistant
# so the wrapper can do a single cp -r without rewriting paths.
COPY --chown=node:node module.json    /opt/napoleon-module/module.json
COPY --chown=node:node dist/scripts/  /opt/napoleon-module/dist/scripts/
COPY --chown=node:node styles/        /opt/napoleon-module/styles/
COPY --chown=node:node languages/     /opt/napoleon-module/languages/

# IMAGE_VERSION marker — install-module.sh compares this against the
# data-volume copy's marker to decide whether to re-install. The CI
# workflow passes the git tag in via --build-arg MODULE_VERSION; local
# builds default to "dev" so a hand-built image is distinguishable.
ARG MODULE_VERSION=dev
RUN echo "${MODULE_VERSION}" > /opt/napoleon-module/IMAGE_VERSION \
 && chown node:node /opt/napoleon-module/IMAGE_VERSION

# Wrapper script — chmod +x as root before USER node since /usr/local/bin
# isn't writable by node.
COPY docker/foundry/install-module.sh /usr/local/bin/install-module.sh
RUN chmod +x /usr/local/bin/install-module.sh

# Restore felddy's runtime user. felddy's entrypoint expects to run as
# uid 1000 (the `node` user); the cp + chmod above were the only steps
# that needed root.
USER node

# Wrap felddy's entrypoint with our module-install pre-step. The wrapper
# `exec`s felddy's /home/node/entrypoint.sh at the end so PID 1 stays
# the felddy script (it traps SIGTERM/EXIT and forwards signals to the
# launcher child process — replacing PID 1 would break graceful shutdown).
ENTRYPOINT ["/usr/local/bin/install-module.sh"]

# Re-declare felddy's CMD explicitly. **Load-bearing.** Docker's
# documented behavior: setting ENTRYPOINT in a derived Dockerfile
# RESETS the inherited CMD to []. Without this line, callers that
# don't override Cmd at runtime (which is exactly what
# `bundles/provision.ts::provisionContainer` does — no Cmd field on
# the createContainer call) would see Docker exec install-module.sh
# with empty "$@", and felddy's /home/node/entrypoint.sh hits
# `set -u` on an unbound `$1` and crashes on line 21. Reproduced on
# 2026-05-05 during V2 verification: bundle.create rolled back with
# "Container is not running" while the container had been
# crash-restart-looping with this exact error.
#
# The values match felddy/foundryvtt:13's own CMD verbatim so the
# wrapper's `exec /home/node/entrypoint.sh "$@"` chains felddy with
# its expected args. install-module.sh ALSO carries a defensive
# fallback for the same args in case a future caller ever passes
# cmd: [] explicitly — belt-and-suspenders.
CMD ["resources/app/main.mjs", "--port=30000", "--headless", "--noupdate", "--dataPath=/data"]
