import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { HOST, MANAGED_MARKER } from "./constants.mjs";
import { buildCatalog, writeCatalog } from "./catalog.mjs";
import {
  createRouterToken,
  ensureRouterToken,
  readRouterConfig,
  readRouterToken,
} from "./keys.mjs";

const MANAGED_ROOT_KEY_ORDER = [
  "openai_base_url",
  "experimental_realtime_ws_base_url",
  "model_provider",
  "model_catalog_json",
];
const REALTIME_LEGACY_MANAGED_ROOT_KEY_ORDER = [
  "openai_base_url",
  "experimental_realtime_ws_base_url",
  "model_catalog_json",
];
const LEGACY_MANAGED_ROOT_KEY_ORDER = [
  "openai_base_url",
  "model_catalog_json",
];
const ROOT_KEYS = new Set(MANAGED_ROOT_KEY_ORDER);
const MANAGED_PROVIDER_HEADER = "[model_providers.dscodex]";
const MANAGED_PROVIDER_KEY_ORDER = [
  "name",
  "base_url",
  "wire_api",
  "requires_openai_auth",
  "supports_websockets",
];
const DESKTOP_KEY = "enabled-reasoning-efforts";
const REASONING_EFFORTS = '["low", "medium", "high", "xhigh", "max", "ultra"]';

function keyOf(line) {
  return /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1] ?? null;
}

function tomlCode(line) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (quote === "'") {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "#") return line.slice(0, index);
  }
  return line;
}

function decodeBasicTomlKey(source, start) {
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') return { value, end: index + 1 };
    if (character !== "\\") {
      if (character === "\n" || character === "\r") return null;
      value += character;
      continue;
    }
    const escape = source[index + 1];
    const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    if (Object.hasOwn(simple, escape)) {
      value += simple[escape];
      index += 1;
      continue;
    }
    const digits = escape === "u" ? 4 : escape === "U" ? 8 : 0;
    if (!digits) return null;
    const encoded = source.slice(index + 2, index + 2 + digits);
    if (!new RegExp(`^[0-9A-Fa-f]{${digits}}$`).test(encoded)) return null;
    const codePoint = Number.parseInt(encoded, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
    value += String.fromCodePoint(codePoint);
    index += 1 + digits;
  }
  return null;
}

function parseTomlKeyPath(source) {
  const path = [];
  let index = 0;
  const skipSpace = () => {
    while (source[index] === " " || source[index] === "\t") index += 1;
  };
  skipSpace();
  while (index < source.length) {
    let component;
    if (source[index] === '"') {
      const decoded = decodeBasicTomlKey(source, index);
      if (!decoded) return null;
      component = decoded.value;
      index = decoded.end;
    } else if (source[index] === "'") {
      const end = source.indexOf("'", index + 1);
      if (end === -1) return null;
      component = source.slice(index + 1, end);
      index = end + 1;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(source.slice(index));
      if (!match) return null;
      [component] = match;
      index += component.length;
    }
    path.push(component);
    skipSpace();
    if (index === source.length) return path;
    if (source[index] !== ".") return null;
    index += 1;
    skipSpace();
  }
  return null;
}

function tomlEqualsIndex(source) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (quote === "'") {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "=") return index;
  }
  return -1;
}

function tomlTablePath(line) {
  const code = tomlCode(line).trim();
  const arrayTable = code.startsWith("[[") && code.endsWith("]]");
  const regularTable = code.startsWith("[") && code.endsWith("]");
  if (!arrayTable && !regularTable) return null;
  const edge = arrayTable ? 2 : 1;
  return parseTomlKeyPath(code.slice(edge, -edge).trim());
}

function scanTomlValueLine(line, state, start = 0) {
  let quote = "";
  let escaped = false;
  for (let index = start; index < line.length; index += 1) {
    if (state.multiline) {
      if (line.startsWith(state.multiline, index)) {
        state.multiline = "";
        index += 2;
      } else if (state.multiline === '"""' && line[index] === "\\") {
        index += 1;
      }
      continue;
    }
    const character = line[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (quote === "'") {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "#") break;
    if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
      state.multiline = line.slice(index, index + 3);
      index += 2;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[" || character === "{") {
      state.closers.push(character === "[" ? "]" : "}");
    } else if (character === "]" || character === "}") {
      if (state.closers.at(-1) === character) state.closers.pop();
    }
  }
}

function scanToml(lines) {
  const declarations = [];
  const statementLines = new Set();
  let tablePath = [];
  const valueState = { multiline: "", closers: [] };
  for (let index = 0; index < lines.length; index += 1) {
    if (valueState.multiline || valueState.closers.length) {
      scanTomlValueLine(lines[index], valueState);
      continue;
    }
    statementLines.add(index);
    const parsedTable = tomlTablePath(lines[index]);
    if (parsedTable) {
      tablePath = parsedTable;
      declarations.push({ index, kind: "table", path: parsedTable, tablePath: [], keyPath: [] });
      continue;
    }
    const code = tomlCode(lines[index]);
    const equals = tomlEqualsIndex(code);
    const keyPath = equals === -1 ? null : parseTomlKeyPath(code.slice(0, equals).trim());
    if (keyPath) {
      declarations.push({
        index,
        kind: "key",
        path: [...tablePath, ...keyPath],
        tablePath,
        keyPath,
      });
      scanTomlValueLine(lines[index], valueState, equals + 1);
    }
  }
  return { declarations, statementLines };
}

function tomlDeclarations(lines) {
  return scanToml(lines).declarations;
}

function pathStartsWith(path, prefix) {
  return prefix.every((component, index) => path[index] === component);
}

function firstTableIndex(lines, scan = scanToml(lines)) {
  return scan.declarations.find((declaration) => declaration.kind === "table")?.index ?? lines.length;
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
  const baseUrl = routerBaseUrl(options);
  return [
    MANAGED_MARKER,
    `openai_base_url = ${quoteToml(baseUrl)}`,
    `experimental_realtime_ws_base_url = ${quoteToml(`${baseUrl}/realtime`)}`,
    'model_provider = "dscodex"',
    `model_catalog_json = ${quoteToml(options.catalogPath)}`,
  ];
}

function managedProviderLines(options) {
  const baseUrl = routerBaseUrl(options);
  return [
    MANAGED_MARKER,
    MANAGED_PROVIDER_HEADER,
    'name = "DSCodex"',
    `base_url = ${quoteToml(baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "supports_websockets = false",
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

function assignedBoolean(line) {
  const equals = line.indexOf("=");
  if (equals === -1) return null;
  const value = line.slice(equals + 1).trim();
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function managedRootBlockAt(lines, index, { allowCurrent = true, scan = scanToml(lines) } = {}) {
  if (!scan.statementLines.has(index)) return null;
  if (lines[index]?.trim() !== MANAGED_MARKER) return null;
  const matches = (order) => order.every((key, offset) => (
    scan.statementLines.has(index + 1 + offset)
    && keyOf(lines[index + 1 + offset] ?? "") === key
  ));
  const order = [
    ...(allowCurrent ? [MANAGED_ROOT_KEY_ORDER] : []),
    REALTIME_LEGACY_MANAGED_ROOT_KEY_ORDER,
    LEGACY_MANAGED_ROOT_KEY_ORDER,
  ].find(matches) ?? null;
  if (!order) return null;
  const values = {};
  for (let offset = 0; offset < order.length; offset += 1) {
    values[order[offset]] = assignedString(lines[index + 1 + offset]);
  }
  return { lines, start: index, end: index + 1 + order.length, values };
}

function managedRootBlockInLines(lines, options = {}) {
  const scan = options.scan ?? scanToml(lines);
  const allowCurrent = options.allowCurrent ?? Boolean(managedProviderBlockInLines(lines, scan));
  const rootEnd = firstTableIndex(lines, scan);
  for (let index = 0; index < rootEnd; index += 1) {
    const block = managedRootBlockAt(lines, index, { allowCurrent, scan });
    if (block) return block;
  }
  return null;
}

function managedRootBlock(content) {
  return managedRootBlockInLines(content.replaceAll("\r\n", "\n").split("\n"));
}

function managedProviderBlockAt(lines, index, scan = scanToml(lines)) {
  if (!scan.statementLines.has(index) || !scan.statementLines.has(index + 1)) return null;
  if (lines[index]?.trim() !== MANAGED_MARKER) return null;
  if (lines[index + 1]?.trim() !== MANAGED_PROVIDER_HEADER) return null;
  const values = {};
  for (let offset = 0; offset < MANAGED_PROVIDER_KEY_ORDER.length; offset += 1) {
    const key = MANAGED_PROVIDER_KEY_ORDER[offset];
    const line = lines[index + 2 + offset] ?? "";
    if (!scan.statementLines.has(index + 2 + offset) || keyOf(line) !== key) return null;
    values[key] = key === "requires_openai_auth" || key === "supports_websockets"
      ? assignedBoolean(line)
      : assignedString(line);
  }
  const end = index + 2 + MANAGED_PROVIDER_KEY_ORDER.length;
  const tableEnd = scan.declarations.find((declaration) => (
    declaration.kind === "table" && declaration.index >= end
  ))?.index ?? lines.length;
  if (lines.slice(end, tableEnd).some((line) => line.trim() !== "")) return null;
  return { lines, start: index, end, header: index + 1, values };
}

function managedProviderBlockInLines(lines, scan = scanToml(lines)) {
  for (let index = 0; index < lines.length; index += 1) {
    const block = managedProviderBlockAt(lines, index, scan);
    if (block) return block;
  }
  return null;
}

function managedProviderBlock(content) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  return managedProviderBlockInLines(lines, scanToml(lines));
}

function assertNoRootConflictOutsideBlock(block) {
  for (const declaration of tomlDeclarations(block.lines)) {
    if (declaration.kind !== "key" || declaration.tablePath.length) continue;
    if (declaration.index >= block.start && declaration.index < block.end) continue;
    const key = declaration.keyPath[0];
    if (ROOT_KEYS.has(key)) throw new Error(`Refusing to replace user-owned root key: ${key}`);
  }
}

function assertNoProviderConflictOutsideBlock(lines, block) {
  const providerPath = ["model_providers", "dscodex"];
  for (const declaration of tomlDeclarations(lines)) {
    const rootInlineTable = declaration.kind === "key"
      && declaration.tablePath.length === 0
      && declaration.keyPath.length === 1
      && declaration.keyPath[0] === "model_providers";
    if (!rootInlineTable && !pathStartsWith(declaration.path, providerPath)) continue;
    if (block && declaration.index >= block.start && declaration.index < block.end) continue;
    throw new Error("Refusing to replace user-owned provider: model_providers.dscodex");
  }
}

export function readManagedRouterToken(content) {
  const baseUrl = managedRootBlock(content)?.values.openai_base_url;
  if (!baseUrl) return "";
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

export function managedRouterConfigMatches(content, options) {
  const block = managedRootBlock(content);
  const provider = managedProviderBlock(content);
  if (!block || !provider) return false;
  const baseUrl = routerBaseUrl(options);
  return block.values.openai_base_url === baseUrl
    && block.values.experimental_realtime_ws_base_url === `${baseUrl}/realtime`
    && block.values.model_provider === "dscodex"
    && block.values.model_catalog_json === options.catalogPath
    && provider.values.name === "DSCodex"
    && provider.values.base_url === baseUrl
    && provider.values.wire_api === "responses"
    && provider.values.requires_openai_auth === true
    && provider.values.supports_websockets === false;
}

function rewriteManagedRouterConfig(content, options) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  let block = managedRootBlockInLines(lines);
  if (!block) {
    throw new Error("DSCodex managed router config is missing; run `node src/cli.mjs install`");
  }
  assertNoRootConflictOutsideBlock(block);
  const provider = managedProviderBlockInLines(lines);
  assertNoProviderConflictOutsideBlock(lines, provider);
  if (provider) lines.splice(provider.start, provider.end - provider.start);
  block = managedRootBlockInLines(lines, { allowCurrent: Boolean(provider) });
  lines.splice(block.start, block.end - block.start, ...managedRootLines(options));
  lines.splice(firstTableIndex(lines), 0, ...managedProviderLines(options));
  return lines.join("\n");
}

export function stripManagedConfig(content) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const scan = scanToml(lines);
  const kept = [];
  const rootEnd = firstTableIndex(lines, scan);
  const ownsCurrentRoot = Boolean(managedProviderBlockInLines(lines, scan));
  for (let index = 0; index < lines.length; index += 1) {
    const provider = managedProviderBlockAt(lines, index, scan);
    if (provider) {
      index = provider.end - 1;
      continue;
    }
    if (index < rootEnd) {
      const block = managedRootBlockAt(lines, index, { allowCurrent: ownsCurrentRoot, scan });
      if (block) {
        index = block.end - 1;
        continue;
      }
    }
    if (!scan.statementLines.has(index) || lines[index].trim() !== MANAGED_MARKER) {
      kept.push(lines[index]);
      continue;
    }
    if (scan.statementLines.has(index + 1) && keyOf(lines[index + 1] ?? "") === DESKTOP_KEY) {
      index += 1;
      continue;
    }
    kept.push(lines[index]);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

function assertNoRootConflict(content) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  for (const declaration of tomlDeclarations(lines)) {
    if (declaration.kind !== "key" || declaration.tablePath.length) continue;
    const key = declaration.keyPath[0];
    if (ROOT_KEYS.has(key)) {
      throw new Error(`Refusing to replace user-owned root key: ${key}`);
    }
  }
}

function assertNoProviderConflict(content) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  assertNoProviderConflictOutsideBlock(lines, null);
}

function injectRoot(content, { port, catalogPath, routerToken }) {
  const lines = content.split("\n");
  const insertAt = firstTableIndex(lines);
  const options = { port, catalogPath, routerToken };
  lines.splice(insertAt, 0, ...managedRootLines(options), ...managedProviderLines(options));
  return lines.join("\n");
}

function injectDesktopReasoning(content) {
  const lines = content.split("\n");
  const declarations = tomlDeclarations(lines);
  const desktop = declarations.find((declaration) => (
    declaration.kind === "table"
    && declaration.path.length === 1
    && declaration.path[0] === "desktop"
  ));
  if (!desktop) {
    const suffix = content.endsWith("\n") ? "" : "\n";
    return `${content}${suffix}\n[desktop]\n${MANAGED_MARKER}\n${DESKTOP_KEY} = ${REASONING_EFFORTS}\n`;
  }
  const desktopEnd = declarations.find((declaration) => (
    declaration.kind === "table" && declaration.index > desktop.index
  ))?.index ?? lines.length;
  const existingEffort = declarations.find((declaration) => (
    declaration.kind === "key"
    && declaration.tablePath.length === 1
    && declaration.tablePath[0] === "desktop"
    && declaration.keyPath.length === 1
    && declaration.keyPath[0] === DESKTOP_KEY
  ));
  if (existingEffort) {
    if (/\bmax\b/.test(lines[existingEffort.index])) return content;
    throw new Error(`Existing [desktop].${DESKTOP_KEY} does not expose max; update it manually`);
  }
  let insertAt = desktopEnd;
  while (insertAt > desktop.index + 1 && lines[insertAt - 1].trim() === "") insertAt -= 1;
  lines.splice(insertAt, 0, MANAGED_MARKER, `${DESKTOP_KEY} = ${REASONING_EFFORTS}`);
  return lines.join("\n");
}

export function buildInstalledConfig(content, options) {
  const clean = stripManagedConfig(content);
  assertNoRootConflict(clean);
  assertNoProviderConflict(clean);
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
  const lines = original.replaceAll("\r\n", "\n").split("\n");
  const block = managedRootBlockInLines(lines);
  if (!block) {
    const unprovenCurrent = managedRootBlockInLines(lines, { allowCurrent: true });
    if (unprovenCurrent?.values.model_provider !== undefined) {
      throw new Error("Refusing to replace user-owned root key: model_provider");
    }
    throw new Error("DSCodex managed router config is missing; run `node src/cli.mjs install`");
  }
  assertNoRootConflictOutsideBlock(block);
  const provider = managedProviderBlockInLines(block.lines);
  assertNoProviderConflictOutsideBlock(block.lines, provider);
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

function assertUninstallConfigSafe(content) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const currentRoot = managedRootBlockInLines(lines, { allowCurrent: true });
  if (!currentRoot || !Object.hasOwn(currentRoot.values, "model_provider")) return;
  const provider = managedProviderBlockInLines(lines);
  if (!provider) {
    throw new Error(
      "Refusing to uninstall while the managed DSCodex provider is customized; "
        + "restore its exact managed shape or remove the DSCodex config manually",
    );
  }
  try {
    assertNoProviderConflictOutsideBlock(lines, provider);
  } catch {
    throw new Error(
      "Refusing to uninstall while the managed DSCodex provider is customized; "
        + "restore its exact managed shape or remove the DSCodex config manually",
    );
  }
}

export function assertSafeToUninstall({ paths }) {
  if (!existsSync(paths.config)) return;
  assertUninstallConfigSafe(readFileSync(paths.config, "utf8"));
}

export function uninstall({ paths }) {
  assertSafeToUninstall({ paths });
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
