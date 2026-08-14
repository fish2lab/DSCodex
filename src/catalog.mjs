import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { DEEPSEEK_MODELS } from "./constants.mjs";

const HIGH = {
  effort: "high",
  description: "DeepSeek thinking mode",
};
const MAX = {
  effort: "max",
  description: "Maximum DeepSeek thinking depth",
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Codex version bumps can turn previously optional catalog fields into
// required ones faster than the app rewrites models_cache.json, and a single
// unparseable entry breaks the whole model_catalog_json (app-server fails to
// start). Backfill known-required fields on native entries with safe
// defaults; the DeepSeek entry sets its own values explicitly.
const NATIVE_ENTRY_DEFAULTS = {
  prefer_websockets: false,
  supports_reasoning_summaries: false,
};

// These fields are required by the current Codex model-catalog parser. Keep
// this deliberately narrower than the full catalog shape: native entries may
// gain optional fields independently, while doctor only needs to know that the
// merged catalog is parseable and still contains both DSCodex models.
const REQUIRED_ENTRY_FIELD_TYPES = Object.freeze({
  slug: "string",
  base_instructions: "string",
  prefer_websockets: "boolean",
  supports_reasoning_summaries: "boolean",
});

function backfillNativeEntry(model) {
  const entry = clone(model);
  for (const [key, value] of Object.entries(NATIVE_ENTRY_DEFAULTS)) {
    if (entry[key] === undefined) entry[key] = value;
  }
  // Codex CLI 0.146+ requires this legacy top-level field even though current
  // desktop caches carry the same instructions only in model_messages.
  if (typeof entry.base_instructions !== "string") {
    entry.base_instructions = typeof entry.model_messages?.instructions_template === "string"
      ? entry.model_messages.instructions_template
      : "";
  }
  return entry;
}

function replaceIdentity(value, productName) {
  if (typeof value !== "string") return value;
  return value
    .replaceAll("You are Codex, an agent based on GPT-5.", `You are Codex, powered by ${productName}.`)
    .replaceAll("You are Codex, based on GPT-5.", `You are Codex, powered by ${productName}.`);
}

export function buildDeepSeekCatalogEntry(template, model = DEEPSEEK_MODELS[0]) {
  const entry = backfillNativeEntry(template);
  entry.slug = model.pickerSlug;
  entry.display_name = model.displayName;
  entry.description = `${model.productName} via the native Responses API.`;
  entry.default_reasoning_level = "max";
  entry.supported_reasoning_levels = [HIGH, MAX];
  entry.priority = 0;
  entry.visibility = "list";
  entry.supported_in_api = true;
  entry.prefer_websockets = false;
  entry.support_verbosity = true;
  entry.default_verbosity = "low";
  entry.apply_patch_tool_type = "freeform";
  entry.web_search_tool_type = "text";
  // Declaring the image modality opens the desktop view_image gate; the router
  // rewrites those images into GPT-generated descriptions before DeepSeek sees them.
  entry.input_modalities = ["text", "image"];
  entry.supports_image_detail_original = false;
  // DeepSeek's Responses API rejects a turn that replays more than one tool call
  // ("The reasoning_text in the thinking mode must be passed back to the API."),
  // which wedges every later request in the session. Never ask for parallel calls.
  entry.supports_parallel_tool_calls = false;
  entry.supports_search_tool = true;
  entry.tool_mode = null;
  entry.multi_agent_version = "v2";
  entry.use_responses_lite = false;
  entry.include_skills_usage_instructions = false;
  entry.context_window = 1_048_576;
  entry.max_context_window = 1_048_576;
  entry.effective_context_window_percent = 95;
  entry.auto_compact_token_limit = null;
  entry.default_reasoning_summary = "none";
  entry.supports_reasoning_summaries = false;
  entry.minimal_client_version = "0.144.0";
  entry.availability_nux = null;
  entry.upgrade = null;
  entry.experimental_supported_tools = [];
  entry.base_instructions = replaceIdentity(entry.base_instructions, model.productName);
  if (entry.model_messages?.instructions_template) {
    entry.model_messages.instructions_template = replaceIdentity(
      entry.model_messages.instructions_template,
      model.productName,
    );
  }

  delete entry.additional_speed_tiers;
  delete entry.service_tiers;
  delete entry.default_service_tier;
  return entry;
}

export function buildCatalog(cache) {
  if (!Array.isArray(cache?.models) || cache.models.length === 0) {
    throw new Error("Codex models_cache.json has no model templates; open Codex once, then retry");
  }
  const deepSeekSlugs = new Set(DEEPSEEK_MODELS.map((model) => model.pickerSlug));
  const nativeModels = cache.models.filter((model) => !deepSeekSlugs.has(model?.slug));
  const template = nativeModels.find((model) => model?.slug === "gpt-5.6-sol") ?? nativeModels[0];
  return {
    models: [
      ...DEEPSEEK_MODELS.map((model) => buildDeepSeekCatalogEntry(template, model)),
      ...nativeModels.map(backfillNativeEntry),
    ],
  };
}

export function isCatalogReady(catalog) {
  if (!Array.isArray(catalog?.models) || catalog.models.length === 0) return false;

  const slugs = new Set();
  for (const model of catalog.models) {
    if (!model || typeof model !== "object" || Array.isArray(model)) return false;
    if (Object.entries(REQUIRED_ENTRY_FIELD_TYPES).some(([field, type]) => (
      typeof model[field] !== type
    ))) return false;
    if (model.slug.trim().length === 0 || slugs.has(model.slug)) return false;
    slugs.add(model.slug);
  }

  return DEEPSEEK_MODELS.every((model) => slugs.has(model.pickerSlug));
}

export function writeCatalog({ catalogPath, catalog }) {
  const temporary = `${catalogPath}.dscodex-tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, catalogPath);
  return catalog;
}

export function syncCatalog({ cachePath, catalogPath }) {
  const cache = JSON.parse(readFileSync(cachePath, "utf8"));
  return writeCatalog({ catalogPath, catalog: buildCatalog(cache) });
}
