// Tunables for the image-history compaction in the proxy.
//
// Resolution order matches the DeepSeek key: a one-off process environment
// variable wins, then the durable value in ~/.codex/dscodex/config.json, then
// the built-in default.
//
// The stored file exists because an environment variable on its own is not
// reachable here: the router is started by the Windows Task Scheduler through a
// wscript shim, so a variable typed into a shell never reaches it, and the
// supervisor that owns the router outlives a router-only hot reload. The config
// file is re-read by the router process itself, which `restart-dscodex.ps1`
// replaces — so the setting lands without touching the scheduler.

import { readRouterConfig } from "./keys.mjs";
import {
  DEFAULT_IMAGE_MAX_SIDE,
  DEFAULT_KEEP_RECENT_IMAGES,
  DEFAULT_WEBP_EFFORT,
  DEFAULT_WEBP_QUALITY,
} from "./image-compaction.mjs";
import { join } from "node:path";

// The defaults live with the code that uses them, but this module is where the
// effective values are resolved, so it re-exports them for callers and tests.
export {
  DEFAULT_IMAGE_MAX_SIDE,
  DEFAULT_KEEP_RECENT_IMAGES,
  DEFAULT_WEBP_EFFORT,
  DEFAULT_WEBP_QUALITY,
} from "./image-compaction.mjs";

// DeepSeek's gateway rejects bodies at ~47 MB (measured 2026-10-01: 46 MB is
// served, 47 MB answers 413). 44 MB leaves headroom under that ceiling.
export const DEFAULT_UPSTREAM_BYTE_BUDGET = 44 * 1024 * 1024;

export const MAX_UPSTREAM_FIELD = "max_upstream_bytes";
export const KEEP_RECENT_FIELD = "keep_recent_images";
export const IMAGE_MAX_SIDE_FIELD = "image_max_side";
export const WEBP_QUALITY_FIELD = "webp_quality";
export const WEBP_ENCODER_DIR_FIELD = "webp_encoder_dir";

// Convention, not configuration: an encoder dropped here is picked up with no
// settings to edit. It sits in the user's DSCodex state directory, so the
// checkout still ships nothing but `ws`.
export const DEFAULT_ENCODER_DIRNAME = "encoders";

function integerFrom(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function tuned({ env, envName, config, field, fallback, min, max }) {
  const fromEnv = integerFrom(env?.[envName]);
  if (fromEnv !== null) return clamp(fromEnv, min, max);
  const stored = integerFrom(config?.[field]);
  if (stored !== null) return clamp(stored, min, max);
  return fallback;
}

function clamp(value, min, max) {
  if (min !== undefined && value < min) return min;
  if (max !== undefined && value > max) return max;
  return value;
}

function stringFrom(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Not a limit, but resolved the same way so the banner can report every knob
// from one place. Points at a Node package directory holding the encoder.
function stringTuned({ env, envName, config, field, fallback = "" }) {
  return stringFrom(env?.[envName]) ?? stringFrom(config?.[field]) ?? fallback;
}

// A byte budget of `0` is the documented off switch: no budget is applied, so
// an oversized body is forwarded as-is and fails with the gateway's own 413
// instead of losing older images. Anything below 1 KB would only ever fire on
// requests that cannot succeed, so it is clamped up to 1 KB.
export function compactionTunables(paths, env = process.env) {
  const config = paths?.keyFile ? readRouterConfig(paths.keyFile) : {};
  const budget = tuned({
    env, envName: "DSCODEX_MAX_UPSTREAM_BYTES", config, field: MAX_UPSTREAM_FIELD,
    fallback: DEFAULT_UPSTREAM_BYTE_BUDGET,
  });
  const keepRecent = tuned({
    env, envName: "DSCODEX_KEEP_RECENT_IMAGES", config, field: KEEP_RECENT_FIELD,
    fallback: DEFAULT_KEEP_RECENT_IMAGES, min: 1,
  });
  const maxSide = tuned({
    env, envName: "DSCODEX_IMAGE_MAX_SIDE", config, field: IMAGE_MAX_SIDE_FIELD,
    fallback: DEFAULT_IMAGE_MAX_SIDE, min: 64,
  });
  const quality = tuned({
    env, envName: "DSCODEX_WEBP_QUALITY", config, field: WEBP_QUALITY_FIELD,
    fallback: DEFAULT_WEBP_QUALITY, min: 1, max: 100,
  });
  return {
    maxUpstreamBytes: budget === 0 ? Number.POSITIVE_INFINITY : Math.max(1024, budget),
    keepRecentImages: keepRecent,
    imageMaxSide: maxSide,
    webpQuality: quality,
    webpEffort: DEFAULT_WEBP_EFFORT,
    webpEncoderDir: stringTuned({
      env, envName: "DSCODEX_WEBP_ENCODER_DIR", config, field: WEBP_ENCODER_DIR_FIELD,
    }) || (paths?.stateDir ? join(paths.stateDir, DEFAULT_ENCODER_DIRNAME) : ""),
  };
}

// Where the effective budget came from, for the startup banner. A value the
// operator cannot see is a value they cannot correct.
export function compactionBudgetSource(paths, env = process.env) {
  if (integerFrom(env?.DSCODEX_MAX_UPSTREAM_BYTES) !== null) return "env";
  const config = paths?.keyFile ? readRouterConfig(paths.keyFile) : {};
  if (integerFrom(config?.[MAX_UPSTREAM_FIELD]) !== null) return `config.json:${MAX_UPSTREAM_FIELD}`;
  return "default";
}
