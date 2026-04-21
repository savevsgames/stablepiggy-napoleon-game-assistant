/**
 * World-files — FilePicker wrappers for Phase B.4 data persistence.
 *
 * Single module-side write path for Barn → Foundry Data copies. Mirrors
 * the backend's `src/captures.ts` single-write-path convention — all
 * uploads of Barn-sourced content land here. Do NOT call FilePicker.upload
 * directly from other files for this purpose.
 *
 * Flow:
 *   1. `listWorldFiles(worldId)` — recursive FilePicker.browse under
 *      `worlds/<world>/napoleon/`, flattened to ClientWorldFile[] for
 *      sending with each `/napoleon` query. Napoleon reuses existing
 *      assets before regenerating.
 *   2. `uploadToWorld(signedUrl, targetPath)` — fetch the signed Barn
 *      URL, upload bytes to Foundry Data via FilePicker.upload with
 *      replace-existing collision handling. Used by the
 *      `backend.data.upload` handler in relay-client.ts.
 *
 * Error posture: fail loud per RFC Q4. On any failure, throw with a
 * short human-readable message. Callers surface it via
 * `ui.notifications.error` and emit `client.data_upload_ack` with
 * `ok: false`. No automatic retry — GM decides.
 */

import type {
  ClientWorldFile,
  WorldFileCategory,
} from "@stablepiggy-napoleon/protocol";
import { WORLD_FILE_CATEGORIES } from "@stablepiggy-napoleon/protocol";
import { debug, warn } from "./log.js";

// ── Foundry globals (typed against v13.351) ────────────────────────────

interface FilePickerBrowseResult {
  readonly target: string;
  readonly dirs: readonly string[];
  readonly files: readonly string[];
}

interface FilePickerStatic {
  browse(
    source: string,
    target: string,
    options?: Record<string, unknown>
  ): Promise<FilePickerBrowseResult>;
  upload(
    source: string,
    target: string,
    file: File,
    body?: Record<string, unknown>,
    options?: { notify?: boolean }
  ): Promise<unknown>;
  createDirectory?(
    source: string,
    target: string,
    options?: Record<string, unknown>
  ): Promise<void>;
}

declare const FilePicker: FilePickerStatic;

declare const ui: {
  notifications: {
    info(message: string, options?: Record<string, unknown>): void;
    warn(message: string, options?: Record<string, unknown>): void;
    error(message: string, options?: Record<string, unknown>): void;
  };
};

// ── Config ─────────────────────────────────────────────────────────────

/** Hard cap on worldFiles per query — matches the protocol validator. */
const MAX_WORLD_FILES = 1000;

/** Base path for Napoleon's per-world asset tree. */
function napoleonRoot(worldId: string): string {
  return `worlds/${worldId}/napoleon`;
}

// ── listWorldFiles ─────────────────────────────────────────────────────

/**
 * List every file under `worlds/<world>/napoleon/<category>/*.<ext>`
 * flattened to a ClientWorldFile[]. Returns an empty array if the
 * napoleon/ tree doesn't exist yet (first query in a fresh world).
 *
 * Not recursive past one level — the path convention is exactly
 * `worlds/<world>/napoleon/<category>/<file>`, no deeper nesting.
 */
export async function listWorldFiles(worldId: string): Promise<ClientWorldFile[]> {
  const root = napoleonRoot(worldId);
  const collected: ClientWorldFile[] = [];

  // Probe the root. If it doesn't exist, FilePicker.browse throws — treat
  // that as "empty world" and return [].
  let rootResult: FilePickerBrowseResult;
  try {
    rootResult = await FilePicker.browse("data", root);
  } catch (err) {
    debug(`listWorldFiles: no napoleon/ tree yet for world "${worldId}" (${err instanceof Error ? err.message : err})`);
    return [];
  }

  // Each top-level dir under napoleon/ should map to a WorldFileCategory.
  // Unknown dirs (GM-created vanity folders) are skipped — they're not
  // part of the contract and Napoleon shouldn't reason about them.
  const knownCategories = new Set<string>(WORLD_FILE_CATEGORIES);

  for (const dirPath of rootResult.dirs) {
    // FilePicker.browse returns dir paths like "worlds/<w>/napoleon/npcs"
    // — take the last segment as the category.
    const category = dirPath.split("/").pop() ?? "";
    if (!knownCategories.has(category)) {
      debug(`listWorldFiles: skipping unknown category dir "${dirPath}"`);
      continue;
    }

    let dirResult: FilePickerBrowseResult;
    try {
      dirResult = await FilePicker.browse("data", dirPath);
    } catch (err) {
      warn(`listWorldFiles: FilePicker.browse failed on ${dirPath}: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    for (const filePath of dirResult.files) {
      if (collected.length >= MAX_WORLD_FILES) {
        warn(`listWorldFiles: hit ${MAX_WORLD_FILES}-file cap, truncating`);
        return collected;
      }
      const slug = slugFromPath(filePath);
      if (!slug) continue;
      collected.push({
        path: filePath,
        category: category as WorldFileCategory,
        slug,
        // FilePicker doesn't expose sizeBytes — report 0; sorting/dedup
        // logic on the backend doesn't depend on it.
        sizeBytes: 0,
      });
    }
  }

  debug(`listWorldFiles: ${collected.length} file(s) under ${root}`);
  return collected;
}

/** Extract slug (filename without extension) from a path. Returns empty on failure. */
function slugFromPath(path: string): string {
  const basename = path.split("/").pop() ?? "";
  const dotIdx = basename.lastIndexOf(".");
  if (dotIdx <= 0) return basename;
  return basename.slice(0, dotIdx);
}

// ── uploadToWorld ──────────────────────────────────────────────────────

/**
 * Fetch a signed Barn URL and upload the bytes to Foundry Data at
 * `targetPath`. Replace-existing collision: if a file already occupies
 * the target path, we show a brief `ui.notifications.info` informing the
 * GM of the replace and proceed.
 *
 * Throws on any failure (fetch failure, FilePicker.upload throw, etc.)
 * with a short human message. Caller catches and surfaces via ack +
 * notifications.
 */
export async function uploadToWorld(signedUrl: string, targetPath: string): Promise<void> {
  const dir = dirname(targetPath);
  const filename = basename(targetPath);

  if (!filename || !dir) {
    throw new Error(`invalid targetPath "${targetPath}"`);
  }

  // Ensure parent dirs exist. FilePicker.createDirectory is idempotent
  // in Foundry v13 — returns an error on "already exists" which we swallow.
  await ensureDir(dir);

  // Check for existing file at target — brief notice if replacing.
  let replacing = false;
  try {
    const existing = await FilePicker.browse("data", dir);
    if (existing.files.includes(targetPath)) {
      replacing = true;
    }
  } catch {
    // Directory might have been created but is empty — fine, no replace.
  }
  if (replacing) {
    ui.notifications.info(`Replacing existing ${filename}`, { permanent: false });
  }

  // Fetch the signed URL body. The backend serves Barn files over HTTPS
  // with wildcard CORS on /barn/serve, so this is a straight cross-origin
  // GET + blob extraction.
  let blob: Blob;
  try {
    const response = await fetch(signedUrl);
    if (!response.ok) {
      const status = response.status;
      if (status === 403) {
        throw new Error(`signed URL expired or invalid (HTTP 403)`);
      }
      throw new Error(`fetch failed with HTTP ${status}`);
    }
    blob = await response.blob();
  } catch (err) {
    throw new Error(
      err instanceof Error && err.message.startsWith("signed URL")
        ? err.message
        : `fetch from Barn failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Construct a File from the blob. FilePicker.upload expects a File
  // (has .name) rather than a raw Blob.
  const file = new File([blob], filename, { type: blob.type || "image/png" });

  try {
    // notify: false — we already emitted our own info notification above
    // for the replace case; Foundry's default upload toast is redundant.
    await FilePicker.upload("data", dir, file, {}, { notify: false });
  } catch (err) {
    throw new Error(
      `FilePicker.upload failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  debug(`uploadToWorld: uploaded ${filename} to ${dir} (${blob.size} bytes)${replacing ? " [replaced]" : ""}`);
}

/**
 * Create every directory in the path that doesn't already exist. Foundry's
 * createDirectory errors on "already exists" — we swallow those.
 */
async function ensureDir(dirPath: string): Promise<void> {
  if (!FilePicker.createDirectory) {
    debug(`ensureDir: FilePicker.createDirectory unavailable, skipping`);
    return;
  }

  // Walk the path creating each segment. This is N FilePicker calls per
  // new directory (typical: 3 — `worlds/<w>/napoleon/<cat>`). Cheap.
  const segments = dirPath.split("/");
  for (let i = 1; i <= segments.length; i++) {
    const step = segments.slice(0, i).join("/");
    if (!step) continue;
    try {
      await FilePicker.createDirectory("data", step);
    } catch (err) {
      // Foundry throws on "already exists" — that's expected at every
      // level except the last (and sometimes the last too). Log at debug
      // only so we don't spam.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/exists/i.test(msg)) {
        // A real error (permission denied, quota, etc.) — bubble it.
        throw new Error(`createDirectory failed at "${step}": ${msg}`);
      }
    }
  }
}

// ── Path helpers (cross-platform, no Node path module in module env) ───

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return "";
  return path.slice(0, idx);
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return path;
  return path.slice(idx + 1);
}
