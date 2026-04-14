import { defineConfig } from "vite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Vite build config for the StablePiggy Napoleon Game Assistant Foundry module.
 *
 * Build output goes to `../dist/scripts/main.js` (a top-level dist/ at the repo
 * root with a `scripts/` subdirectory) so that the Foundry `module.json`
 * manifest can reference it as `dist/scripts/main.js` from the repo root.
 *
 * Library mode: Foundry loads this as an ESM module via the `esmodules` field
 * in `module.json`, not as a standalone web app. Vite's library mode produces
 * a single ESM bundle without the typical app shell.
 *
 * Externals: Foundry's runtime globals (`Hooks`, `game`, `CONFIG`, `Dialog`,
 * etc.) are resolved at runtime by Foundry's own loader and live on the
 * browser's global scope. The bundle references them as bare identifiers and
 * Vite/Rollup leaves them as-is (no externalization needed because they were
 * never imports in the first place).
 *
 * The `@stablepiggy-napoleon/protocol` workspace is resolved via npm
 * workspace symlinking: `npm install` at the repo root creates a symlink at
 * `node_modules/@stablepiggy-napoleon/protocol` pointing at `../protocol/`,
 * and Vite follows the symlink + the package.json `exports` map.
 */

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "main.ts"),
      formats: ["es"],
      fileName: () => "main.js",
    },
    outDir: resolve(__dirname, "../dist/scripts"),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
});
