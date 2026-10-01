// Outbound image compaction: keep every picture, make the old ones small.
//
// Codex resends the whole transcript on every turn, and images travel inside it
// as base64 that never shrinks, so a picture-heavy session eventually passes the
// gateway's request-size ceiling and stops being sendable at all. The first
// answer is to make old pictures smaller rather than delete them: on a real
// 44-image session, lossy WebP at long side 1024 took the image payload from
// 47.92 MB to 1.18 MB, and the model still read the dice faces and their
// numbers. Deleting is kept only as the last resort, and a deleted picture
// always leaves a record naming its position, media type, and size.
//
// Two properties make this affordable:
//   * the newest `keepRecent` images are never touched, so the turn being
//     answered keeps its pictures at full fidelity;
//   * transcodes are cached by content hash, because the same picture is
//     re-sent every turn and WebP encoding is far too slow to repeat.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export const DEFAULT_KEEP_RECENT_IMAGES = 4;
export const DEFAULT_IMAGE_MAX_SIDE = 1024;
export const DEFAULT_WEBP_QUALITY = 75;
export const DEFAULT_WEBP_EFFORT = 4;
export const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;

const IMAGE_PART_KEYS = ["content", "output"];

// Re-serializing the whole body on every step is O(n^2) over a body that can be
// tens of megabytes, so the running byte size is maintained by measuring only
// the block being swapped.
function sizeTracker(body) {
  let bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  return {
    get: () => bytes,
    replace(blocks, slot, block) {
      bytes += Buffer.byteLength(JSON.stringify(block), "utf8")
        - Buffer.byteLength(JSON.stringify(blocks[slot]), "utf8");
      blocks[slot] = block;
    },
  };
}

function imageUrlOf(part) {
  const value = part?.image_url;
  if (typeof value === "string") return value;
  const nested = value?.url ?? value?.image_url;
  return typeof nested === "string" ? nested : "";
}

// Returns each `input_image` block with the exact array slot it lives in, oldest
// first, so a caller can replace the block in place and keep the surrounding
// item (a `function_call_output` pair, a message) structurally untouched.
export function collectImageParts(input) {
  const parts = [];
  if (!Array.isArray(input)) return parts;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    for (const key of IMAGE_PART_KEYS) {
      const blocks = item[key];
      if (!Array.isArray(blocks)) continue;
      blocks.forEach((block, slot) => {
        if (block?.type !== "input_image") return;
        const url = imageUrlOf(block);
        if (url.length > 512) parts.push({ blocks, slot, url });
      });
    }
  }
  return parts;
}

// The record keeps the picture's provenance, so a later turn can tell what was
// lost and ask for a re-render instead of finding an anonymous hole. Replacing
// the whole block is what keeps the marker free of the image-only fields
// (`detail`, `image_url`) that DeepSeek's closed content enum does not expect on
// an `input_text`.
export function imageRecordFor(url, ordinal, total) {
  const match = /^data:([^;,]+)(?:;base64)?,/.exec(url);
  const mime = match ? match[1] : "image";
  const size = (Buffer.byteLength(url, "utf8") / 1048576).toFixed(2);
  return `[image omitted by DSCodex: transcript image ${ordinal} of ${total} (${mime}, ${size} MB as base64)`
    + " was replaced by this record because the request body passed the API size limit. The picture is no"
    + " longer available here; re-render or re-attach it, or start a new chat, if it matters again.]";
}

// Last resort: trade the oldest pictures for text records until the body fits.
// Oldest first, so what survives is closest to the turn being answered.
export function compactImagesToBudget(body, maxBytes, { keepRecent = DEFAULT_KEEP_RECENT_IMAGES } = {}) {
  const size = sizeTracker(body);
  const before = size.get();
  if (before <= maxBytes) return { before, after: before, dropped: 0, images: 0 };
  const parts = collectImageParts(body.input);
  const droppable = parts.slice(0, Math.max(0, parts.length - keepRecent));
  let dropped = 0;
  // `droppable` is a prefix of `parts`, so the loop counter is also the image's
  // ordinal in the transcript.
  for (let ordinal = 0; ordinal < droppable.length; ordinal += 1) {
    if (size.get() <= maxBytes) break;
    const { blocks, slot, url } = droppable[ordinal];
    size.replace(blocks, slot, { type: "input_text", text: imageRecordFor(url, ordinal + 1, parts.length) });
    dropped += 1;
  }
  return { before, after: size.get(), dropped, images: parts.length };
}

// --- WebP encoder (found, never required) ------------------------------------
//
// DSCodex advertises exactly one runtime dependency, `ws`, and that stays true:
// the encoder is an accelerator that the environment may provide, not something
// the package installs. The router therefore *looks for* an encoder the way it
// already looks for `ws` — createRequire, lazily, and degrade clearly when it is
// missing — in this order:
//
//   1. `webp_encoder_dir` / DSCODEX_WEBP_ENCODER_DIR: a Node package directory,
//      so the encoder can live in the user's DSCodex state directory and never
//      appear in this checkout at all;
//   2. this checkout's own node_modules, for anyone who installed one by hand.
//
// Without either, oversized bodies fall back to the record path, which is the
// pre-encoder behaviour and remains correct.

const encoderCache = new Map();

function wrap(sharp) {
  return typeof sharp === "function"
    ? (dataUrl, options) => encodeWithSharp(sharp, dataUrl, options)
    : null;
}

async function resolveEncoder(directory) {
  if (directory) {
    try {
      const require = createRequire(join(directory, "dscodex-encoder.cjs"));
      const encode = wrap(require("sharp"));
      return encode
        ? { encode, source: `sharp from ${directory}` }
        : { encode: null, source: `unavailable (${directory} does not export an encoder)` };
    } catch {
      return { encode: null, source: `unavailable (nothing resolvable from ${directory})` };
    }
  }
  try {
    const module = await import("sharp");
    const encode = wrap(module.default);
    return encode
      ? { encode, source: "sharp from the checkout" }
      : { encode: null, source: "unavailable" };
  } catch {
    return { encode: null, source: "unavailable" };
  }
}

/**
 * @returns {Promise<{encode: Function|null, source: string}>} `encode` is null
 *   when the environment provides no encoder, which is a normal outcome.
 */
export function loadWebpEncoder({ directory = "" } = {}) {
  const key = directory || "\u0000checkout";
  if (!encoderCache.has(key)) encoderCache.set(key, resolveEncoder(directory));
  return encoderCache.get(key);
}

export async function encodeWithSharp(sharp, dataUrl, {
  maxSide = DEFAULT_IMAGE_MAX_SIDE,
  quality = DEFAULT_WEBP_QUALITY,
  effort = DEFAULT_WEBP_EFFORT,
} = {}) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  let source;
  try {
    source = Buffer.from(match[2], "base64");
  } catch {
    return null;
  }
  try {
    const image = sharp(source, { animated: false, autoOrient: false });
    const meta = await image.metadata();
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
    const pipeline = longest > maxSide
      ? image.resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
      : image;
    const encoded = await pipeline.webp({ quality, effort }).toBuffer();
    // Never make a picture bigger than it already was; some small images and
    // already-WebP ones lose nothing by being left alone.
    return encoded.length < source.length ? encoded : null;
  } catch {
    // A corrupt or unsupported picture must not take the whole request down.
    return null;
  }
}

// --- transcode cache ---------------------------------------------------------

export class ImageTranscodeCache {
  constructor(directory, { maxBytes = DEFAULT_CACHE_BYTES, pruneEvery = 100 } = {}) {
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.pruneEvery = pruneEvery;
    this.writes = 0;
    this.hits = 0;
    this.misses = 0;
  }

  // The policy string is part of the key, so changing quality or size produces
  // new entries and the old ones simply age out: no migration needed.
  static keyFor(source, policy) {
    return createHash("sha256").update(policy).update("\u0000").update(source).digest("hex");
  }

  pathFor(key) {
    return join(this.directory, `${key}.webp`);
  }

  get(key) {
    try {
      const data = readFileSync(this.pathFor(key));
      this.hits += 1;
      return data;
    } catch {
      this.misses += 1;
      return null;
    }
  }

  set(key, buffer) {
    if (!this.directory) return;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeFileSync(this.pathFor(key), buffer, { mode: 0o600 });
      this.writes += 1;
      if (this.writes % this.pruneEvery === 0) this.prune();
    } catch {
      // A cache that cannot be written is a slow router, never a broken one.
    }
  }

  prune() {
    try {
      const entries = readdirSync(this.directory)
        .filter((name) => name.endsWith(".webp"))
        .map((name) => {
          const path = join(this.directory, name);
          const info = statSync(path);
          return { path, size: info.size, atime: info.mtimeMs };
        })
        .sort((a, b) => a.atime - b.atime);
      let total = entries.reduce((sum, entry) => sum + entry.size, 0);
      for (const entry of entries) {
        if (total <= this.maxBytes) break;
        unlinkSync(entry.path);
        total -= entry.size;
      }
    } catch {
      // Pruning is housekeeping; failing it changes nothing for this request.
    }
  }
}

// --- the ladder --------------------------------------------------------------

async function transcode(part, { policy, maxSide, quality, effort, cache, encode }) {
  const key = cache ? ImageTranscodeCache.keyFor(part.url, policy) : "";
  if (key) {
    const cached = cache.get(key);
    if (cached) {
      return { url: `data:image/webp;base64,${cached.toString("base64")}`, cached: true };
    }
  }
  const encoded = await encode(part.url, { maxSide, quality, effort });
  if (!encoded) return null;
  if (key) cache.set(key, encoded);
  return { url: `data:image/webp;base64,${encoded.toString("base64")}`, cached: false };
}

/**
 * Bring `body` under `maxBytes` by shrinking pictures, and only then by trading
 * the oldest ones for text records.
 *
 * @returns {{before:number, after:number, images:number, transcoded:number,
 *            fromCache:number, dropped:number, encoder:string}}
 */
export async function shrinkImagesToBudget(body, maxBytes, {
  keepRecent = DEFAULT_KEEP_RECENT_IMAGES,
  maxSide = DEFAULT_IMAGE_MAX_SIDE,
  quality = DEFAULT_WEBP_QUALITY,
  effort = DEFAULT_WEBP_EFFORT,
  cache = null,
  encode = null,
} = {}) {
  const size = sizeTracker(body);
  const before = size.get();
  const parts = collectImageParts(body.input);
  const stats = {
    before,
    after: before,
    images: parts.length,
    transcoded: 0,
    fromCache: 0,
    dropped: 0,
    encoder: encode ? "webp" : "unavailable",
  };
  if (before <= maxBytes || !encode) {
    if (!encode && before > maxBytes) {
      // The record pass does its own accounting; this tracker is now stale.
      const records = compactImagesToBudget(body, maxBytes, { keepRecent });
      stats.dropped = records.dropped;
      stats.after = records.after;
    }
    return stats;
  }

  const policy = `webp|q${quality}|s${maxSide}|e${effort}`;
  const shrinkable = parts.slice(0, Math.max(0, parts.length - Math.max(0, keepRecent)));
  // Every picture older than the protected window is shrunk, not just enough of
  // them to scrape under the limit. Stopping at the limit would leave the
  // session pressed against the ceiling, where the next screenshot trips the
  // compaction again; shrinking all of them buys real headroom and then stops
  // firing at all. Oldest first, so the untouched pictures are the newest.
  for (const part of shrinkable) {
    const smaller = await transcode(part, { policy, maxSide, quality, effort, cache, encode });
    if (!smaller) continue;
    size.replace(part.blocks, part.slot, { type: "input_image", image_url: smaller.url, detail: "high" });
    stats.transcoded += 1;
    if (smaller.cached) stats.fromCache += 1;
  }
  stats.after = size.get();
  if (stats.after > maxBytes) {
    const records = compactImagesToBudget(body, maxBytes, { keepRecent });
    stats.dropped = records.dropped;
    stats.after = records.after;
  }
  return stats;
}
