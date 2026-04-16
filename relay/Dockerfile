# ── Build stage ────────────────────────────────────────────────────────
# Compiles protocol + relay TypeScript and produces a single esbuild
# bundle. We deliberately install the full workspace deps here (including
# tsc and esbuild) because the runtime image below only needs ws + pino.
FROM node:22-alpine AS build
WORKDIR /src

# Copy the workspace root's manifests and the two workspaces we care
# about. Skipping the module/scripts workspace keeps the build lean —
# we never need it in the relay image.
COPY package.json package-lock.json tsconfig.base.json ./
COPY protocol ./protocol
COPY relay ./relay

# Install all workspaces at once so the symlink from
# relay/node_modules/@stablepiggy-napoleon/protocol lands correctly.
# npm workspaces + --workspaces=false is a no-op we don't want.
RUN npm install --no-audit --no-fund

# Protocol must build first — its dist/index.d.ts is what the relay's
# tsc step imports, and the dist/index.js is what esbuild inlines.
RUN npm run build --workspace=@stablepiggy-napoleon/protocol

# build:bundle runs tsc AND esbuild. Output is relay/dist/bundle.js
# with the protocol workspace inlined. ws, pino, and pino-pretty are
# left as externals so the runtime image can install them from npm.
RUN npm run build:bundle --workspace=@stablepiggy-napoleon/relay

# ── Runtime stage ──────────────────────────────────────────────────────
# Minimal image with just what the bundle needs at runtime. No tsc, no
# esbuild, no protocol or relay source files — only the bundle + its
# two npm runtime deps.
FROM node:22-alpine

WORKDIR /app

# Write a tiny package.json that declares only the runtime deps. Using
# a heredoc here rather than COPY avoids pulling the workspace manifest
# with its workspaces field (which would try to resolve symlinks the
# runtime image doesn't have) and its devDependencies (which we don't
# need). `"type": "module"` is required because the bundle is ESM.
RUN cat > package.json <<'PKG'
{
  "name": "stablepiggy-napoleon-relay",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "dependencies": {
    "ws": "^8.18.0",
    "pino": "^9.5.0"
  }
}
PKG
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock

# The bundle itself.
COPY --from=build /src/relay/dist/bundle.js ./bundle.js

# Production defaults. NODE_ENV=production is what log.ts checks to
# skip pino-pretty (which we don't install here). Other env vars —
# RELAY_SHARED_SECRET, RELAY_BACKEND_URL, RELAY_BACKEND_TOKEN,
# RELAY_REQUIRE_API_KEY — are provided at docker run time.
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "bundle.js"]
