/**
 * Viewport snapshot capture for Phase B.3.
 *
 * When the GM submits a `/napoleon` query, we optionally attach a JPEG
 * of the current canvas viewport so vision-capable LLMs can reason about
 * scene state (token positions, terrain, placement contexts).
 *
 * Captures `canvas.stage` at the current pan/zoom — "what the GM is
 * looking at" — NOT the full scene. If the GM has panned to a corner,
 * the LLM sees a corner. The tool description on the backend side
 * reflects this so LLMs don't misinterpret the framing.
 *
 * Gating is server-side: the module sends optimistically when a scene
 * is active; the backend discards silently when the active model's
 * `modelFlags.supportsImageInput=false`. A future commit may add a
 * module-side hint cached from the previous response to avoid the
 * upload cost on non-vision models, but that requires new protocol
 * plumbing and isn't in Phase B.3's scope.
 *
 * PIXI API: Foundry v13 uses PIXI 8. `renderer.extract.base64(target, format, quality)`
 * is an async call returning a data URL. `canvas.stage` is the root of
 * the scene render graph (tokens, tiles, walls, lights); the UI chrome
 * is separate DOM and never appears in the extract.
 *
 * Downscale guardrail: if the source viewport exceeds 2048px on the
 * long edge, we scale down BEFORE encoding. Keeps upload size bounded
 * (~300 KB JPEG typical) and prevents the relay WebSocket from hitting
 * frame-size limits on huge custom maps.
 */

import type { ClientQuerySnapshot } from "@stablepiggy-napoleon/protocol";
import { debug, warn } from "./log.js";

// ── Foundry globals ────────────────────────────────────────────────────
// Typed against v13.351. See docs/foundry-conventions.md §2.

interface PixiRendererExtract {
  base64(
    target: unknown,
    format?: string,
    quality?: number
  ): Promise<string>;
}

interface PixiRenderer {
  readonly extract: PixiRendererExtract;
}

interface PixiApplication {
  readonly renderer: PixiRenderer;
  readonly stage: unknown;
}

interface FoundryScene {
  readonly id: string;
  readonly name: string;
  readonly grid: { readonly size: number };
  readonly dimensions?: { readonly width: number; readonly height: number };
}

declare const canvas: {
  readonly app: PixiApplication | null;
  readonly stage: unknown;
  readonly scene: FoundryScene | null;
  readonly screenDimensions?: readonly [number, number];
};

// ── Config ─────────────────────────────────────────────────────────────

/** Max dimension on either edge before we downscale. ~300 KB JPEG typical at this size. */
const MAX_DIM = 2048;

/** Default JPEG quality. 0.85 gives a good size/fidelity tradeoff. */
const DEFAULT_QUALITY = 0.85;

// ── Capture ────────────────────────────────────────────────────────────

/**
 * Capture the GM's current viewport as a JPEG data URL.
 * Returns `null` when no scene is active, PIXI isn't available, or the
 * extract fails — capture is best-effort and never blocks the query.
 */
export async function captureViewportSnapshot(): Promise<ClientQuerySnapshot | null> {
  const scene = canvas.scene;
  if (!scene) {
    debug("snapshot: no active scene — skipping capture");
    return null;
  }

  const app = canvas.app;
  if (!app || !app.renderer || typeof app.renderer.extract?.base64 !== "function") {
    warn("snapshot: canvas.app.renderer.extract.base64 unavailable — skipping capture");
    return null;
  }

  const target = canvas.stage ?? app.stage;
  if (!target) {
    warn("snapshot: canvas.stage unavailable — skipping capture");
    return null;
  }

  try {
    const started = Date.now();
    let dataUrl = await app.renderer.extract.base64(target, "image/jpeg", DEFAULT_QUALITY);

    // Resolve the source dimensions — prefer screenDimensions (viewport),
    // fall back to scene.dimensions (full scene), final fallback 0/0 so
    // the downscale check can short-circuit safely.
    const [viewW, viewH] = canvas.screenDimensions ?? [0, 0];
    let width = viewW || scene.dimensions?.width || 0;
    let height = viewH || scene.dimensions?.height || 0;

    // Downscale if either dim exceeds MAX_DIM.
    if (width > MAX_DIM || height > MAX_DIM) {
      const downscaled = await downscaleDataUrl(dataUrl, MAX_DIM, DEFAULT_QUALITY);
      if (downscaled) {
        dataUrl = downscaled.dataUrl;
        width = downscaled.width;
        height = downscaled.height;
      }
      // If downscale fails, send original and let the backend's 4096px
      // clamp reject if it's truly too large.
    }

    const durationMs = Date.now() - started;
    const approxBytes = Math.floor((dataUrl.length * 3) / 4); // base64 → bytes estimate
    debug(`snapshot: captured scene="${scene.name}" ${width}x${height} (~${approxBytes}B, ${durationMs}ms)`);

    return {
      dataUrl,
      width: width || MAX_DIM,
      height: height || MAX_DIM,
      gridSize: scene.grid.size,
      sceneId: scene.id,
      sceneName: scene.name,
    };
  } catch (err) {
    warn(`snapshot: extract.base64 failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Downscale helper ───────────────────────────────────────────────────
//
// Re-encodes a data URL through an HTMLImageElement + OffscreenCanvas so
// we get a size-capped JPEG. Returns null on any failure — callers fall
// back to the original URL and let the backend's clamp reject if needed.

async function downscaleDataUrl(
  dataUrl: string,
  maxDim: number,
  quality: number
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    const img = await loadImage(dataUrl);
    const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);

    const canvasEl = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : (() => {
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          return c;
        })();
    const ctx = (canvasEl as unknown as { getContext(t: string): CanvasRenderingContext2D | null }).getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);

    const out = canvasEl instanceof OffscreenCanvas
      ? await (canvasEl as OffscreenCanvas).convertToBlob({ type: "image/jpeg", quality })
      : await new Promise<Blob | null>((resolve) => {
          (canvasEl as HTMLCanvasElement).toBlob(resolve, "image/jpeg", quality);
        });

    if (!out) return null;
    const reader = new FileReader();
    const dataUrlOut: string = await new Promise((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(out);
    });
    return { dataUrl: dataUrlOut, width: w, height: h };
  } catch (err) {
    warn(`snapshot: downscale failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}
