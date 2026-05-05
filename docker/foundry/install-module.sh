#!/bin/bash
# install-module.sh — napoleon-foundry image entrypoint wrapper.
#
# Runs at container start as the `node` user (per the Dockerfile's USER
# directive). Copies the StablePiggy Napoleon module bytes from the
# image's staging dir (/opt/napoleon-module/) into the Foundry data
# volume (/data/Data/modules/stablepiggy-napoleon-game-assistant/) when
# the version differs, then `exec`s felddy's PID-1 entrypoint so signal
# handling stays correct.
#
# See FOUNDRY-HARNESS-V2 spec §6.3 in the DevVault MCP repo for the
# full design rationale (why a wrapper, why exec, why a version marker
# instead of cp -rn).
#
# Behavior on each container start:
#
#   - On first start (data volume has no module dir): full install.
#   - On subsequent starts with the SAME image (IMAGE_VERSION matches):
#     skip with a log line — module bytes already match.
#   - On bundle.update with a NEW image (IMAGE_VERSION differs from the
#     marker in the data volume): atomic stage-then-rename re-install.
#     This is the path that lets bundle.update actually deliver new
#     module bytes, since the data volume persists across container
#     destroys.
#
# Atomicity: the new module is staged at <DEST_DIR>.installing, then
# rename'd into place after the old <DEST_DIR> is removed. If the
# container is killed mid-copy, the stage dir gets rm -rf'd on next
# start; <DEST_DIR> still has the prior version.

set -euo pipefail

MODULE_ID="stablepiggy-napoleon-game-assistant"
SRC_DIR="/opt/napoleon-module"
DEST_DIR="/data/Data/modules/${MODULE_ID}"
IMAGE_VERSION_FILE="${SRC_DIR}/IMAGE_VERSION"
DEPLOYED_VERSION_FILE="${DEST_DIR}/IMAGE_VERSION"

# Read image-baked version (always exists in the image — the Dockerfile
# RUN step writes it from the MODULE_VERSION build arg).
IMAGE_VERSION="$(cat "${IMAGE_VERSION_FILE}")"

# Read deployed version. Missing on first run; missing if the data volume
# was wiped or the file was hand-deleted; set normally on subsequent runs.
DEPLOYED_VERSION=""
if [ -f "${DEPLOYED_VERSION_FILE}" ]; then
  DEPLOYED_VERSION="$(cat "${DEPLOYED_VERSION_FILE}")"
fi

if [ "${IMAGE_VERSION}" != "${DEPLOYED_VERSION}" ]; then
  # First install OR version mismatch (image was rebuilt + bundle.update
  # ran). Replace the module dir atomically.
  #
  # /data/Data/modules may not exist on a brand-new world directory —
  # mkdir -p covers both cases (already exists OR doesn't yet).
  mkdir -p "$(dirname "${DEST_DIR}")"

  # Stage to a sibling dir, then atomic rename. The "-rT" approach
  # (treat target as not-a-directory) is more concise but less portable;
  # explicit stage + rename is clearer and works across coreutils versions.
  STAGE_DIR="${DEST_DIR}.installing"
  rm -rf "${STAGE_DIR}"
  cp -r "${SRC_DIR}" "${STAGE_DIR}"
  rm -rf "${DEST_DIR}"
  mv "${STAGE_DIR}" "${DEST_DIR}"

  echo "[napoleon-foundry] installed module ${MODULE_ID} version ${IMAGE_VERSION}"
else
  echo "[napoleon-foundry] module ${MODULE_ID} version ${IMAGE_VERSION} already installed"
fi

# Chain to felddy's entrypoint as PID 1. `exec` replaces our shell
# process so felddy's signal traps work correctly (SIGTERM/EXIT
# forwarding to the launcher child process). The "$@" forwards the
# CMD args (Foundry launcher path + flags) verbatim — Foundry's
# v13 default is "resources/app/main.mjs --port=30000 --headless
# --noupdate --dataPath=/data".
#
# **Defensive fallback** (added 2026-05-05). The Dockerfile re-declares
# felddy's CMD explicitly so callers that don't override Cmd at runtime
# get the expected args — but if a future caller ever passes
# cmd: [] (empty array) at docker.run time, "$@" expands to nothing
# here and felddy's /home/node/entrypoint.sh crashes on `set -u`
# referencing an unbound `$1` (line 21). Belt-and-suspenders: detect
# the empty case and pass felddy's args explicitly. The values match
# felddy/foundryvtt:13's CMD verbatim AND the Dockerfile's CMD line —
# all three sources have the same args so a future Foundry version
# bump only needs the Dockerfile change.
if [ "$#" -eq 0 ]; then
  exec /home/node/entrypoint.sh \
    resources/app/main.mjs \
    --port=30000 \
    --headless \
    --noupdate \
    --dataPath=/data
fi
exec /home/node/entrypoint.sh "$@"
