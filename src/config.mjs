import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, win32 } from "node:path";
import { HOST, MANAGED_MARKER } from "./constants.mjs";
import { buildCatalog, writeCatalog } from "./catalog.mjs";
import {
  createRouterToken,
  ensureRouterToken,
  readRouterConfig,
  readRouterToken,
} from "./keys.mjs";

// model_catalog_json is only recognized so older installs can be migrated off
// it: a static catalog is read once at startup and freezes the GPT list.
const ROOT_KEYS = new Set(["openai_base_url", "model_catalog_json"]);
const CATALOG_FILE = "dscodex-models.json";
const DESKTOP_KEY = "enabled-reasoning-efforts";
const REASONING_EFFORTS = '["low", "medium", "high", "xhigh", "max", "ultra"]';

function keyOf(line) {
  return /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1] ?? null;
}

function firstTableIndex(lines) {
  const index = lines.findIndex((line) => /^\s*\[/.test(line));
  return index === -1 ? lines.length : index;
}

function quoteToml(value) {
  return JSON.stringify(value);
}

function validRouterToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function authenticatedPidState(state) {
  return Number.isInteger(state?.pid) && state.pid >= 1
    && Number.isInteger(state.port) && state.port >= 1 && state.port <= 65535
    && validRouterToken(state.routerToken)
    && validRouterToken(state.shutdownToken)
    && typeof state.instanceId === "string"
    && new RegExp(`^${state.pid}-\\d+-[0-9a-f]{16}$`).test(state.instanceId);
}

function processAppearsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function assertNoActiveLegacyRouter(paths) {
  if (!existsSync(paths.pid)) return;
  let state;
  try {
    state = JSON.parse(readFileSync(paths.pid, "utf8"));
  } catch {
    throw new Error(
      `Invalid DSCodex pid state at ${paths.pid}; verify no router is running and remove the file before installing`,
    );
  }
  if (authenticatedPidState(state)) return;
  if (!Number.isInteger(state?.pid) || state.pid < 1
    || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535) {
    throw new Error(
      `Untrusted DSCodex pid state at ${paths.pid}; verify no router is running and remove the file before installing`,
    );
  }
  if (!processAppearsAlive(state.pid)) return;
  throw new Error(
    `A router from an older or untrusted DSCodex state is still running `
      + `(PID ${state.pid}, port ${state.port}); stop it with the previous DSCodex version before installing`,
  );
}

function routerBaseUrl({ port, routerToken }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  if (!validRouterToken(routerToken)) throw new Error("DSCodex install requires a router token");
  return `http://${HOST}:${port}/${routerToken}/v1`;
}

function managedRootLines(options) {
  return [
    MANAGED_MARKER,
    `openai_base_url = ${quoteToml(routerBaseUrl(options))}`,
  ];
}

function assignedString(line) {
  const equals = line.indexOf("=");
  if (equals === -1) return "";
  try {
    const value = JSON.parse(line.slice(equals + 1).trim());
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function hasManagedRootBlock(content) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  return lines.some((line, index) => line.trim() === MANAGED_MARKER && ROOT_KEYS.has(keyOf(lines[index + 1] ?? "")));
}

function ownedRouterToken(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    const match = /^\/([A-Za-z0-9_-]{43})\/v1\/?$/.exec(parsed.pathname);
    if (parsed.protocol !== "http:" || parsed.hostname !== HOST
      || parsed.username || parsed.password || parsed.search || parsed.hash || !match) return "";
    return match[1];
  } catch {
    return "";
  }
}

// Codex rewrites config.toml and may drop the marker comment, so DSCodex also
// recognizes its root lines by value: a tokenized loopback base URL and the
// generated catalog file are never user-authored.
function ownedRootLine(line) {
  const key = keyOf(line);
  const value = assignedString(line);
  if (key === "openai_base_url") return Boolean(ownedRouterToken(value));
  if (key === "model_catalog_json") return basename(value) === CATALOG_FILE || win32.basename(value) === CATALOG_FILE;
  return false;
}

export function readManagedRouterToken(content) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const rootEnd = firstTableIndex(lines);
  for (let index = 0; index < rootEnd; index += 1) {
    if (keyOf(lines[index]) !== "openai_base_url") continue;
    const token = ownedRouterToken(assignedString(lines[index]));
    if (token) return token;
  }
  return "";
}

function stripOwnedLines(content, { desktop }) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const rootEnd = firstTableIndex(lines);
  const kept = [];
  let firstOwnedRoot = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === MANAGED_MARKER && (desktop || index < rootEnd)) {
      if (index < rootEnd) firstOwnedRoot ??= kept.length;
      let next = index + 1;
      while (next < lines.length) {
        const key = keyOf(lines[next]);
        if (!ROOT_KEYS.has(key) && key !== DESKTOP_KEY) break;
        next += 1;
      }
      index = next - 1;
      continue;
    }
    if (index < rootEnd && ownedRootLine(lines[index])) {
      firstOwnedRoot ??= kept.length;
      continue;
    }
    kept.push(lines[index]);
  }
  return { kept, firstOwnedRoot };
}

function collapseBlankRuns(lines) {
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

// Rewrite in place so a config that already matches is left byte-for-byte alone.
function rewriteManagedRouterConfig(content, options) {
  const { kept, firstOwnedRoot } = stripOwnedLines(content, { desktop: false });
  kept.splice(firstOwnedRoot ?? firstTableIndex(kept), 0, ...managedRootLines(options));
  return collapseBlankRuns(kept);
}

export function managedRouterConfigMatches(content, options) {
  const normalized = content.replaceAll("\r\n", "\n");
  if (!readManagedRouterToken(normalized)) return false;
  return rewriteManagedRouterConfig(normalized, options) === normalized;
}

export function stripManagedConfig(content) {
  return collapseBlankRuns(stripOwnedLines(content, { desktop: true }).kept);
}

function assertNoRootConflict(content) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const rootEnd = firstTableIndex(lines);
  for (let index = 0; index < rootEnd; index += 1) {
    const key = keyOf(lines[index]);
    if (ROOT_KEYS.has(key)) {
      throw new Error(`Refusing to replace user-owned root key: ${key}`);
    }
  }
}

function injectRoot(content, { port, routerToken }) {
  const lines = content.split("\n");
  const insertAt = firstTableIndex(lines);
  lines.splice(insertAt, 0, ...managedRootLines({ port, routerToken }));
  return lines.join("\n");
}

function injectDesktopReasoning(content) {
  const lines = content.split("\n");
  const desktopStart = lines.findIndex((line) => /^\s*\[desktop\]\s*$/.test(line));
  if (desktopStart === -1) {
    const suffix = content.endsWith("\n") ? "" : "\n";
    return `${content}${suffix}\n[desktop]\n${MANAGED_MARKER}\n${DESKTOP_KEY} = ${REASONING_EFFORTS}\n`;
  }
  let desktopEnd = lines.findIndex((line, index) => index > desktopStart && /^\s*\[/.test(line));
  if (desktopEnd === -1) desktopEnd = lines.length;
  for (let index = desktopStart + 1; index < desktopEnd; index += 1) {
    if (keyOf(lines[index]) !== DESKTOP_KEY) continue;
    if (/\bmax\b/.test(lines[index])) return content;
    throw new Error(`Existing [desktop].${DESKTOP_KEY} does not expose max; update it manually`);
  }
  let insertAt = desktopEnd;
  while (insertAt > desktopStart + 1 && lines[insertAt - 1].trim() === "") insertAt -= 1;
  lines.splice(insertAt, 0, MANAGED_MARKER, `${DESKTOP_KEY} = ${REASONING_EFFORTS}`);
  return lines.join("\n");
}

export function buildInstalledConfig(content, options) {
  const clean = stripManagedConfig(content);
  assertNoRootConflict(clean);
  return injectDesktopReasoning(injectRoot(clean, options));
}

const MCP_ENV_TABLE = /^\s*\[mcp_servers\.[^\]]+\.env\]\s*$/;
const BRIDGE_ENV_KEY = "CODEX_CLI_PATH";

// The Codex app snapshots CODEX_CLI_PATH into [mcp_servers.*.env] while the
// bridge is active, persisting the hijack past `launchctl unsetenv`. Remove
// only DSCodex-owned values (the shim or the wrapper); never a user override.
export function stripBridgeCliPath(content, ownedValues) {
  const owned = new Set(ownedValues.filter(Boolean));
  if (!owned.size) return content;
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  let inMcpEnv = false;
  const kept = [];
  for (const line of lines) {
    if (/^\s*\[/.test(line)) inMcpEnv = MCP_ENV_TABLE.test(line);
    if (inMcpEnv && keyOf(line) === BRIDGE_ENV_KEY && owned.has(assignedString(line))) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function stripBridgeCliPathFromConfig({ paths, ownedValues }) {
  if (!existsSync(paths.config)) return false;
  const original = readFileSync(paths.config, "utf8");
  const repaired = stripBridgeCliPath(original, ownedValues);
  if (repaired === original) return false;
  atomicWrite(paths.config, repaired.endsWith("\n") ? repaired : `${repaired}\n`);
  return true;
}

function atomicWrite(path, content, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.dscodex-tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode });
  renameSync(temporary, path);
}

export function ensureManagedRouterBinding({ paths, port }) {
  // Guard every runtime entry point (start/serve/autostart) before it can
  // publish an authenticated URL while a pre-authentication router still owns
  // the port and legacy pid state. `install` performs the same guard separately.
  assertNoActiveLegacyRouter(paths);
  const original = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "";
  if (!hasManagedRootBlock(original) && !readManagedRouterToken(original)) {
    throw new Error("DSCodex managed router config is missing; run `node src/cli.mjs install`");
  }
  const routerToken = ensureRouterToken(paths.keyFile, readManagedRouterToken(original));
  const options = { port, catalogPath: paths.catalog, routerToken };
  const updated = !managedRouterConfigMatches(original, options);
  if (updated) {
    const configured = rewriteManagedRouterConfig(original, options);
    atomicWrite(paths.config, configured.endsWith("\n") ? configured : `${configured}\n`);
  }
  return { routerToken, updated };
}

export function install({ paths, port }) {
  // A pre-authentication router cannot understand the new tokenized URL, and
  // its legacy pid file cannot support authenticated shutdown. Refuse the
  // upgrade before changing config or generated state; never signal that PID.
  assertNoActiveLegacyRouter(paths);
  mkdirSync(dirname(paths.config), { recursive: true });
  const original = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "";
  // Validate every input before publishing any generated file. In particular,
  // a corrupt state file must not leave config.toml pointing at an unpersisted token.
  readRouterConfig(paths.keyFile, { strict: true });
  const candidateToken = readRouterToken(paths.keyFile)
    || readManagedRouterToken(original)
    || createRouterToken();
  let configured = buildInstalledConfig(original, {
    port,
    catalogPath: paths.catalog,
    routerToken: candidateToken,
  });
  const cache = JSON.parse(readFileSync(paths.cache, "utf8"));
  const catalog = buildCatalog(cache);
  if (!existsSync(paths.backup) && existsSync(paths.config)) {
    copyFileSync(paths.config, paths.backup);
  }

  // Persist the credential used by the loopback router before exposing it in
  // config.toml. A later failure can leave an unused token, never a broken URL.
  const routerToken = ensureRouterToken(paths.keyFile, candidateToken);
  if (routerToken !== candidateToken) {
    configured = buildInstalledConfig(original, { port, catalogPath: paths.catalog, routerToken });
  }
  writeCatalog({ catalogPath: paths.catalog, catalog });
  atomicWrite(paths.config, configured.endsWith("\n") ? configured : `${configured}\n`);
  return { catalog, configPath: paths.config, catalogPath: paths.catalog, routerToken };
}

export function uninstall({ paths }) {
  if (existsSync(paths.config)) {
    const current = readFileSync(paths.config, "utf8");
    const stripped = stripManagedConfig(current);
    atomicWrite(paths.config, stripped.endsWith("\n") ? stripped : `${stripped}\n`);
  }
  if (existsSync(paths.catalog)) unlinkSync(paths.catalog);
  if (existsSync(paths.keyFile)) unlinkSync(paths.keyFile);
  if (existsSync(paths.selectionState)) unlinkSync(paths.selectionState);
  if (existsSync(paths.bridgeShim)) unlinkSync(paths.bridgeShim);
}
