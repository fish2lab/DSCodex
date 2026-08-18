import { homedir } from "node:os";
import { join } from "node:path";

export const VERSION = "1.1.0";
export const DEFAULT_PORT = 10110;
export const HOST = "127.0.0.1";
export const DEEPSEEK_MODELS = Object.freeze([
  Object.freeze({
    pickerSlug: "deepseek/deepseek-v4-flash",
    wireModel: "deepseek-v4-flash",
    displayName: "🐳 V4 Flash",
    productName: "DeepSeek V4 Flash",
  }),
  Object.freeze({
    pickerSlug: "deepseek/deepseek-v4-pro",
    wireModel: "deepseek-v4-pro",
    displayName: "🐳 V4 Pro",
    productName: "DeepSeek V4 Pro",
  }),
]);
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const OPENAI_REALTIME_BASE_URL = "https://api.openai.com/v1";
export const MANAGED_MARKER = "# DSCodex managed; remove with `dscodex uninstall`";

export function deepSeekModelFor(model) {
  return DEEPSEEK_MODELS.find((candidate) => (
    model === candidate.pickerSlug || model === candidate.wireModel
  )) ?? null;
}

export function resolveCodexHome(env = process.env) {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

// Windows cannot spawn .cmd/.bat directly (CreateProcess needs an .exe), so those
// launchers must go through the command interpreter. POSIX scripts need no shell.
export function needsShellSpawn(executablePath, platform = process.platform) {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(executablePath);
}

export function pathsFor(codexHome) {
  return {
    config: join(codexHome, "config.toml"),
    cache: join(codexHome, "models_cache.json"),
    catalog: join(codexHome, "dscodex-models.json"),
    backup: join(codexHome, "config.toml.pre-dscodex.bak"),
    stateDir: join(codexHome, "dscodex"),
    keyFile: join(codexHome, "dscodex", "config.json"),
    selectionState: join(codexHome, "dscodex", "model-selections.json"),
    bridgeShim: join(codexHome, "dscodex", "codex-cli-bridge.sh"),
    pid: join(codexHome, "dscodex", "server.pid"),
    log: join(codexHome, "dscodex", "server.log"),
  };
}
