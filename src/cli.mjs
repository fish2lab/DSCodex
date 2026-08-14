#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { buildCatalog, isCatalogReady, syncCatalog } from "./catalog.mjs";
import {
  ensureManagedRouterBinding,
  install,
  managedRouterConfigMatches,
  stripBridgeCliPathFromConfig,
  uninstall,
} from "./config.mjs";
import {
  deleteStoredKey,
  readProxyUrl,
  readRouterToken,
  readStoredKey,
  writeProxyUrl,
  writeStoredKey,
} from "./keys.mjs";
import {
  envProxySupported,
  proxyEnvFor,
  proxySource,
  resolveProxy,
  redactProxyUrl,
  validateProxyUrl,
} from "./proxy-config.mjs";
import { createProxyServer } from "./proxy.mjs";
import {
  authenticateSupervisorOwner,
  readSupervisorState,
  removeSupervisorState,
  requestSupervisorStop,
  superviseRouter,
} from "./supervisor.mjs";
import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  WINDOWS_TASK,
  autostartKind,
  buildLaunchdPlist,
  buildSystemdUnit,
  buildWindowsRegisterScript,
  buildWindowsVbs,
  cleanupAutostart,
  encodeWindowsVbs,
  launchdPlistPath,
  systemdUnitPath,
} from "./autostart.mjs";
import { DEFAULT_PORT, HOST, VERSION, pathsFor, resolveCodexHome } from "./constants.mjs";
import { APP_SERVER_WRAPPER, resolveRealCodex } from "./real-codex.mjs";

function ts() {
  return new Date().toISOString();
}

function launchctlGet(name) {
  if (process.platform !== "darwin") return process.env[name]?.trim() ?? "";
  try {
    return execFileSync("/bin/launchctl", ["getenv", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function nodePath() {
  // Windows has no versioned-Cellar problem; the running interpreter is stable.
  if (process.platform === "win32") return process.execPath;
  // Prefer the PATH-resolved `node` (a stable Homebrew symlink); process.execPath
  // resolves to the versioned Cellar binary, which disappears on the next upgrade.
  try {
    const resolved = execFileSync("/usr/bin/which", ["node"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (resolved && existsSync(resolved)) return resolved;
  } catch {
    // Fall back to the current interpreter below.
  }
  return process.execPath;
}

function powershellPath() {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function windowsTaskInfo() {
  if (process.platform !== "win32") return null;
  try {
    const script = [
      `$task=Get-ScheduledTask -TaskName '${WINDOWS_TASK}' -ErrorAction Stop`,
      "$info=$task | Get-ScheduledTaskInfo",
      "[pscustomobject]@{state=[string]$task.State;lastTaskResult=[long]$info.LastTaskResult} | ConvertTo-Json -Compress",
    ].join("; ");
    return JSON.parse(execFileSync(powershellPath(), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
}

function windowsTaskResult(value) {
  if (!Number.isInteger(value)) return "unknown";
  return `0x${(value >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
}

function writeBridgeShim(path) {
  // GUI apps get a bare launchd PATH (/usr/bin:/bin:...), so a `#!/usr/bin/env node`
  // shebang fails there. Resolve node at runtime first, and only fall back to the
  // interpreter path baked at install time: a version-manager upgrade (fnm/nvm/
  // Homebrew) must not strand this shim on a deleted binary.
  const content = [
    "#!/bin/sh",
    "if command -v node >/dev/null 2>&1; then",
    `  exec node ${JSON.stringify(APP_SERVER_WRAPPER)} "$@"`,
    "fi",
    `exec ${JSON.stringify(nodePath())} ${JSON.stringify(APP_SERVER_WRAPPER)} "$@"`,
    "",
  ].join("\n");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o755 });
}

function bridgePlan(paths) {
  if (process.platform !== "darwin") return null;
  const existing = launchctlGet("CODEX_CLI_PATH");
  if (existing && existing !== paths.bridgeShim && existing !== APP_SERVER_WRAPPER) {
    throw new Error(`Refusing to replace user-owned CODEX_CLI_PATH: ${existing}`);
  }
  const realCodex = resolveRealCodex();
  if (!realCodex) throw new Error("Could not locate the stock Codex binary for the app-server bridge");
  return { realCodex, shim: paths.bridgeShim };
}

function activateBridge(plan) {
  if (!plan) return;
  writeBridgeShim(plan.shim);
  execFileSync("/bin/launchctl", ["setenv", "DSCODEX_REAL_CODEX", plan.realCodex]);
  execFileSync("/bin/launchctl", ["setenv", "CODEX_CLI_PATH", plan.shim]);
}

function deactivateBridge(paths) {
  if (process.platform !== "darwin") return;
  const current = launchctlGet("CODEX_CLI_PATH");
  if (current === paths.bridgeShim || current === APP_SERVER_WRAPPER) {
    execFileSync("/bin/launchctl", ["unsetenv", "CODEX_CLI_PATH"]);
    execFileSync("/bin/launchctl", ["unsetenv", "DSCODEX_REAL_CODEX"]);
  }
  // The Codex app snapshots CODEX_CLI_PATH into [mcp_servers.*.env]; clear
  // DSCodex-owned copies so Computer Use stops spawning the shim as well.
  stripBridgeCliPathFromConfig({ paths, ownedValues: [paths.bridgeShim, APP_SERVER_WRAPPER] });
}

function bridgeStateOk(paths) {
  const current = launchctlGet("CODEX_CLI_PATH");
  if (current !== paths.bridgeShim && current !== APP_SERVER_WRAPPER) return true;
  return existsSync(paths.bridgeShim) && Boolean(resolveRealCodex());
}

async function manageBridge(subcommand, paths) {
  if (process.platform !== "darwin") {
    console.log("The app-server bridge is macOS-only; model switching works without it elsewhere");
    return;
  }
  if (subcommand === "enable") {
    activateBridge(bridgePlan(paths));
    console.log("App-server bridge enabled for this login session; fully quit and restart Codex");
    console.log("Note: the bridge moves the app onto a stdio transport and can degrade Computer Use; `bridge disable` reverts");
    return;
  }
  if (subcommand === "disable") {
    deactivateBridge(paths);
    console.log("App-server bridge disabled; fully quit and restart Codex");
    return;
  }
  if (subcommand === "status") {
    const current = launchctlGet("CODEX_CLI_PATH");
    if (current === paths.bridgeShim || current === APP_SERVER_WRAPPER) {
      console.log(`bridge: enabled (CODEX_CLI_PATH=${current})`);
    } else if (current) {
      console.log(`bridge: disabled; CODEX_CLI_PATH is user-owned (${current})`);
    } else {
      console.log("bridge: disabled");
    }
    return;
  }
  throw new Error(`Unknown bridge subcommand: ${subcommand}`);
}

function parsePort(args, env = process.env) {
  const index = args.indexOf("--port");
  const raw = index === -1 ? env.DSCODEX_PORT : args[index + 1];
  const port = raw ? Number(raw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${raw}`);
  return port;
}

function runtime(env = process.env) {
  const codexHome = resolveCodexHome(env);
  return { codexHome, paths: pathsFor(codexHome) };
}

function launchctlKey() {
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync("/bin/launchctl", ["getenv", "DEEPSEEK_API_KEY"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// Resolution order: one-off env override, then the durable stored key, then the
// legacy macOS login-session value so installs created before `key set` keep working.
function resolveDeepSeekKey(env = process.env, keyFile = "") {
  if (env.DEEPSEEK_API_KEY?.trim()) return env.DEEPSEEK_API_KEY.trim();
  const stored = keyFile ? readStoredKey(keyFile) : "";
  if (stored) return stored;
  return launchctlKey();
}

function requireProxyRuntime(paths, env = process.env) {
  const proxyUrl = resolveProxy(env, readProxyUrl(paths.keyFile));
  if (proxyUrl && !envProxySupported()) {
    throw new Error(`proxy support requires Node.js >= 24.5 (found ${process.version}); upgrade Node or clear the proxy (proxy clear)`);
  }
  return proxyUrl;
}

function keySource(keyFile, env = process.env) {
  if (env.DEEPSEEK_API_KEY?.trim()) return "environment";
  if (readStoredKey(keyFile)) return `stored in ${keyFile}`;
  if (launchctlKey()) return "macOS launchctl login session";
  return "";
}

function promptSecret(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      reject(new Error("Interactive prompt unavailable; pass DEEPSEEK_API_KEY via the environment"));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (chunk) => {
      process.stdout.write(chunk.includes(prompt) ? chunk : "*");
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;

function loopbackRequest({ port, path, method = "GET", headers = {}, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const request = httpRequest({
      hostname: HOST,
      port,
      path,
      method,
      headers,
      // Never inherit a patched/global agent: control-plane credentials must
      // stay on loopback even when Node's global fetch uses an env proxy.
      agent: false,
    }, (response) => {
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_CONTROL_RESPONSE_BYTES) {
          const error = new Error("DSCodex loopback response exceeds the configured limit");
          settle(reject, error);
          response.destroy();
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        settle(resolve, {
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      response.once("error", (error) => settle(reject, error));
    });
    request.once("error", (error) => settle(reject, error));
    request.setTimeout(timeoutMs, () => request.destroy(new Error("DSCodex loopback request timed out")));
    request.end();
  });
}

async function health(port, routerToken = "") {
  try {
    const path = routerToken ? `/${routerToken}/health` : "/health";
    const response = await loopbackRequest({ port, path, timeoutMs: 700 });
    return response.statusCode >= 200 && response.statusCode < 300
      ? JSON.parse(response.body)
      : null;
  } catch {
    return null;
  }
}

function syncIfPossible(paths) {
  if (existsSync(paths.cache) && existsSync(paths.catalog)) {
    syncCatalog({ cachePath: paths.cache, catalogPath: paths.catalog });
  }
}

function loadModels(paths) {
  if (existsSync(paths.catalog)) return JSON.parse(readFileSync(paths.catalog, "utf8")).models ?? [];
  if (existsSync(paths.cache)) return buildCatalog(JSON.parse(readFileSync(paths.cache, "utf8"))).models;
  return [];
}

function catalogReady(paths) {
  try {
    return isCatalogReady({ models: loadModels(paths) });
  } catch {
    return false;
  }
}

function tokenValue(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function writePidState(paths, state) {
  const temporary = `${paths.pid}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, paths.pid);
}

function readPidState(paths) {
  if (!existsSync(paths.pid)) return null;
  let state;
  try {
    state = JSON.parse(readFileSync(paths.pid, "utf8"));
  } catch {
    throw new Error(`Invalid DSCodex pid state at ${paths.pid}; remove it after verifying no router is running`);
  }
  if (!Number.isInteger(state?.pid) || state.pid < 1
    || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535
    || !tokenValue(state.routerToken) || !tokenValue(state.shutdownToken)
    || typeof state.instanceId !== "string"
    || !new RegExp(`^${state.pid}-\\d+-[0-9a-f]{16}$`).test(state.instanceId)) {
    throw new Error(`Untrusted DSCodex pid state at ${paths.pid}; refusing to stop an unverified process`);
  }
  return state;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function removePidState(paths, expected) {
  if (!Number.isInteger(expected?.pid) || typeof expected.instanceId !== "string") {
    throw new Error("Refusing to remove DSCodex pid state without an instance identity");
  }
  if (!existsSync(paths.pid)) return;
  const claimed = `${paths.pid}.remove-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    // Claim the current pathname atomically. A replacement instance can publish
    // a new server.pid immediately afterwards without it being unlinked here.
    renameSync(paths.pid, claimed);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    // Some managed Windows environments temporarily deny mutations in the
    // Codex state directory. A stale owner-only pid file is replaced by the
    // next serve instance; do not turn graceful shutdown into a crash.
    if (error?.code === "EPERM" || error?.code === "EACCES") return;
    throw error;
  }
  let matches = false;
  try {
    const current = JSON.parse(readFileSync(claimed, "utf8"));
    matches = current?.pid === expected.pid && current?.instanceId === expected.instanceId;
  } catch {
    // An invalid or replacement state must be restored, not discarded.
  }
  if (matches) {
    try {
      unlinkSync(claimed);
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
      // Some managed agent environments intercept deletes and can reject them.
      // The live pid pathname is already gone; scrub control-plane tokens from
      // the claimed file and keep graceful shutdown from becoming a crash.
      try { writeFileSync(claimed, "", { mode: 0o600 }); } catch {}
    }
    return;
  }
  try {
    // linkSync is create-if-absent: it cannot overwrite a still newer pid file.
    linkSync(claimed, paths.pid);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  try {
    unlinkSync(claimed);
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
    // If the replacement state was hard-linked above, scrubbing the claimed
    // name would corrupt the live pid file. Preserve the owner-only duplicate.
  }
}

async function serve(port) {
  const { paths } = runtime();
  const binding = ensureManagedRouterBinding({ paths, port });
  const routerToken = binding.routerToken;
  if (binding.updated) console.log(`${ts()} Updated the managed router URL for the active token and port`);
  const proxyUrl = requireProxyRuntime(paths);
  // Node's fetch ignores proxy env vars unless --use-env-proxy is active.
  // Re-exec ourselves with the flag (and the resolved proxy in the env) so
  // `start`, autostart, and a manual `serve` all behave identically.
  if (proxyUrl && process.env.DSCODEX_PROXY_REEXEC !== "1") {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      env: { ...process.env, ...proxyEnvFor(proxyUrl, process.env), DSCODEX_PROXY_REEXEC: "1" },
      stdio: "inherit",
      windowsHide: true,
    });
    const forwardedSignals = new Map();
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => child.kill(signal);
      forwardedSignals.set(signal, handler);
      process.once(signal, handler);
    }
    child.once("error", (error) => {
      console.error(`${ts()} dscodex: failed to start proxy re-exec: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
    child.once("exit", (code, signal) => {
      if (signal) {
        const handler = forwardedSignals.get(signal);
        if (handler) process.removeListener(signal, handler);
        process.kill(process.pid, signal);
      }
      else process.exit(code ?? 1);
    });
    return;
  }
  syncIfPossible(paths);
  const deepSeekKey = resolveDeepSeekKey(process.env, paths.keyFile);
  const logger = {
    info: (message) => console.log(`${ts()} ${message}`),
    error: (message) => console.error(`${ts()} ${message}`),
  };
  const shutdownToken = randomBytes(32).toString("base64url");
  const instanceId = `${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`;
  let server;
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceTimer = setTimeout(() => server.closeAllConnections?.(), 5_000);
    server.close(() => {
      clearTimeout(forceTimer);
      removePidState(paths, { pid: process.pid, instanceId });
      process.exit(0);
    });
  };
  server = createProxyServer({
    deepSeekKey,
    models: loadModels(paths),
    logger,
    routerToken,
    shutdownToken,
    instanceId,
    onShutdown: shutdown,
  });
  // The serve process owns the pid file so `stop` works no matter who launched
  // it — `start`, launchd, systemd, or the Windows Task Scheduler.
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.once("error", (error) => {
    console.error(`${ts()} dscodex: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
  server.listen(port, HOST, () => {
    writePidState(paths, { pid: process.pid, port, routerToken, shutdownToken, instanceId });
    console.log(`${ts()} DSCodex ${VERSION} listening at http://${HOST}:${port}/v1`);
    console.log(`${ts()} DeepSeek key: ${deepSeekKey ? "configured" : "missing (GPT OAuth passthrough still works)"}`);
  });
}

async function stopRouterInstance(paths) {
  const state = readPidState(paths);
  if (!state) return "none";
  const expected = { pid: state.pid, instanceId: state.instanceId };
  if (!processAlive(state.pid)) {
    removePidState(paths, expected);
    return "stale";
  }
  try {
    const response = await loopbackRequest({
      port: state.port,
      path: `/${state.routerToken}/_dscodex/shutdown`,
      method: "POST",
      headers: { "x-dscodex-shutdown-token": state.shutdownToken },
      timeoutMs: 1_500,
    });
    if (response.statusCode !== 202) {
      throw new Error(`router rejected the authenticated shutdown request (${response.statusCode})`);
    }
  } catch (error) {
    if (!processAlive(state.pid)) {
      removePidState(paths, expected);
      return "stale";
    }
    throw new Error(`Could not authenticate shutdown for PID ${state.pid}: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!processAlive(state.pid) || !existsSync(paths.pid)) {
      removePidState(paths, expected);
      return "stopped";
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Router PID ${state.pid} did not exit after authenticated shutdown`);
}

function sameSupervisor(left, right) {
  return left?.pid === right?.pid && left?.instanceId === right?.instanceId;
}

async function stopInstance(paths) {
  const failures = [];
  const attemptedRouters = new Set();
  let supervisor = null;
  let sawSupervisor = false;
  let result = "none";

  try {
    supervisor = readSupervisorState(paths.log);
    if (supervisor) {
      sawSupervisor = true;
      // The request is scoped to this exact random instance token and never
      // signals the PID. Leave it even when the fresh liveness challenge times
      // out: a temporarily stalled real owner will honor it when it resumes,
      // while a recycled unrelated PID cannot observe or act on it.
      requestSupervisorStop(paths.log, supervisor);
      if (!(await authenticateSupervisorOwner(paths.log, supervisor))) {
        removeSupervisorState(paths.log, supervisor);
        supervisor = null;
      }
    }
  } catch (error) {
    failures.push(error);
  }

  try {
    const state = readPidState(paths);
    if (state) attemptedRouters.add(state.instanceId);
    result = await stopRouterInstance(paths);
  } catch (error) {
    failures.push(error);
  }

  // A stop request can race with a supervised child publishing server.pid.
  // Keep watching the authenticated supervisor instance and, if a fresh child
  // appears, stop that child through the normal authenticated HTTP endpoint.
  if (supervisor) {
    let supervisorStopped = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      let current;
      try {
        current = readSupervisorState(paths.log);
      } catch (error) {
        failures.push(error);
        break;
      }
      if (!current) {
        supervisorStopped = true;
        break;
      }
      if (!sameSupervisor(current, supervisor)) {
        supervisor = current;
        sawSupervisor = true;
        try {
          requestSupervisorStop(paths.log, current);
        } catch (error) {
          failures.push(error);
          break;
        }
      }
      let supervisorAuthenticated;
      try {
        supervisorAuthenticated = await authenticateSupervisorOwner(paths.log, current);
      } catch (error) {
        failures.push(error);
        break;
      }
      if (!supervisorAuthenticated) {
        try {
          removeSupervisorState(paths.log, current);
        } catch (error) {
          failures.push(error);
        }
        // Re-read on the next pass: a replacement may have published between
        // the failed challenge and conditional cleanup of this generation.
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      try {
        const router = readPidState(paths);
        if (router && !attemptedRouters.has(router.instanceId)) {
          attemptedRouters.add(router.instanceId);
          result = await stopRouterInstance(paths);
        }
      } catch (error) {
        failures.push(error);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!supervisorStopped) {
      failures.push(new Error(`Supervisor PID ${supervisor.pid} did not acknowledge the authenticated stop request`));
    }
  }

  if (failures.length) {
    throw new AggregateError(failures, failures.map((error) => (
      error instanceof Error ? error.message : String(error)
    )).join("; "));
  }
  return sawSupervisor && (result === "none" || result === "stale") ? "stopped" : result;
}

async function start(port) {
  const { paths } = runtime();
  const binding = ensureManagedRouterBinding({ paths, port });
  const routerToken = binding.routerToken;
  if (binding.updated) console.log("Updated the managed router URL for the active token and port");
  const running = await health(port, routerToken);
  if (running) {
    console.log(`DSCodex is already running on ${HOST}:${port}`);
    return;
  }
  requireProxyRuntime(paths);
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  syncIfPossible(paths);
  const logFd = openSync(paths.log, "a", 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", "--port", String(port)], {
    detached: true,
    windowsHide: true,
    env: { ...process.env },
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ready = await health(port, routerToken);
    if (ready) {
      let pid = child.pid;
      try {
        pid = JSON.parse(readFileSync(paths.pid, "utf8")).pid ?? pid;
      } catch {
        // The pid file appears slightly after readiness; keep the child pid.
      }
      console.log(`DSCodex started on ${HOST}:${port} (pid ${pid})`);
      console.log(`DeepSeek key: ${ready.deepseek_key ? "configured" : "missing"}`);
      return;
    }
  }
  throw new Error(`DSCodex did not become ready; inspect ${paths.log}`);
}

async function supervise(port) {
  const { paths } = runtime();
  await superviseRouter({
    nodePath: nodePath(),
    cliPath: fileURLToPath(import.meta.url),
    port,
    logPath: paths.log,
  });
}

async function waitForHealth(port, routerToken, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ready = await health(port, routerToken);
    if (ready) return ready;
  }
  return null;
}

async function waitForWindowsTaskState(expected, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const info = windowsTaskInfo();
    if (info?.state === expected) return info;
    // Registration or the previous task instance may still be settling.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Windows task ${WINDOWS_TASK} did not reach state ${expected}`);
}

async function restoreManualRouter(paths, port, cause, rollback) {
  if (rollback) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [cause, rollbackError],
        `Autostart failed and rollback was incomplete, so the previous manual router was not restarted: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
  }
  try {
    await start(port);
  } catch (restoreError) {
    throw new AggregateError(
      [cause, restoreError],
      `Autostart failed and the previous manual router could not be restored; inspect ${paths.log}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
    );
  }
  throw new Error(
    `Autostart failed; the previous manual router was restored: ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  );
}

async function throwAfterRollback(cause, rollback) {
  try {
    await rollback();
  } catch (rollbackError) {
    throw new AggregateError(
      [cause, rollbackError],
      `Autostart failed and rollback was incomplete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
    );
  }
  throw cause;
}

async function stop() {
  const { paths } = runtime();
  const result = await stopInstance(paths);
  if (result === "none") console.log(`${ts()} DSCodex is not running (no pid file)`);
  else if (result === "stale") console.log(`${ts()} Removed stale DSCodex pid file`);
  else console.log(`${ts()} Stopped DSCodex`);
}

function autostartFile(paths) {
  const kind = autostartKind();
  if (kind === "launchd") return launchdPlistPath();
  if (kind === "systemd") return systemdUnitPath();
  return join(paths.stateDir, "autostart-run.vbs");
}

function windowsTaskExists() {
  try {
    execFileSync("schtasks", ["/query", "/tn", WINDOWS_TASK], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function autostartEnabled(paths) {
  if (autostartKind() === "schtasks") return windowsTaskExists();
  return existsSync(autostartFile(paths));
}

function launchdLoaded(uid) {
  try {
    execFileSync("/bin/launchctl", ["print", `gui/${uid}/${LAUNCHD_LABEL}`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function bootoutLaunchd(uid) {
  if (!launchdLoaded(uid)) return;
  try {
    execFileSync("/bin/launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    // A service can finish between print and bootout; only surface the error if
    // launchd still reports that our label is loaded.
    if (launchdLoaded(uid)) throw error;
  }
}

function removeAutostartArtifact(file) {
  try {
    unlinkSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function deactivateWindowsTask() {
  const failures = [];
  try {
    execFileSync("schtasks", ["/end", "/tn", WINDOWS_TASK], { stdio: ["ignore", "ignore", "ignore"] });
  } catch (error) {
    if (windowsTaskInfo()?.state === "Running") failures.push(error);
  }
  try {
    execFileSync("schtasks", ["/delete", "/tn", WINDOWS_TASK, "/f"], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    if (windowsTaskExists()) failures.push(error);
  }
  if (failures.length) {
    throw new AggregateError(failures, failures.map((error) => (
      error instanceof Error ? error.message : String(error)
    )).join("; "));
  }
}

async function cleanupManagedAutostart(paths, {
  kind,
  file,
  stopRouter = false,
  deactivateManager = true,
  managerExpected = false,
  message,
}) {
  const uid = kind === "launchd" ? process.getuid() : null;
  let managerCleanup = null;
  if (deactivateManager) {
    if (kind === "launchd") {
      managerCleanup = () => bootoutLaunchd(uid);
    } else if (kind === "schtasks") {
      managerCleanup = () => deactivateWindowsTask();
    } else {
      managerCleanup = () => {
        try {
          execFileSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], {
            stdio: ["ignore", "ignore", "pipe"],
          });
        } catch (error) {
          if (managerExpected) throw error;
        }
      };
    }
  }
  await cleanupAutostart({
    stopRouter: stopRouter ? () => stopInstance(paths) : null,
    deactivateManager: managerCleanup,
    removeArtifact: () => removeAutostartArtifact(file),
    reloadManager: kind === "systemd" && managerExpected
      ? () => execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: ["ignore", "ignore", "pipe"] })
      : null,
    message,
  });
}

// The generated plist/unit/VBS never embeds the DeepSeek key: the router resolves
// it from the stored key file at runtime.
async function autostartEnable(paths, port) {
  const kind = autostartKind();
  const file = autostartFile(paths);
  const cliPath = fileURLToPath(import.meta.url);
  const binding = ensureManagedRouterBinding({ paths, port });
  const routerToken = binding.routerToken;
  if (binding.updated) console.log("Updated the managed router URL for the active token and port");
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  requireProxyRuntime(paths);
  const wasRunning = Boolean(await health(port, routerToken));
  if (kind === "schtasks") {
    const previousTaskExisted = autostartEnabled(paths);
    const previousArtifact = existsSync(file) ? readFileSync(file) : null;
    writeFileSync(file, encodeWindowsVbs(buildWindowsVbs({
      nodePath: nodePath(),
      cliPath,
      port,
      codexHome: dirname(paths.stateDir),
    })), { mode: 0o600 });
    // Register before touching a healthy manual router. A permissions/policy
    // failure must never turn a failed autostart attempt into an outage.
    try {
      execFileSync(powershellPath(), [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        buildWindowsRegisterScript({ taskName: WINDOWS_TASK, vbsPath: file }),
      ], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      const restorePreviousArtifact = async () => {
        if (previousArtifact) writeFileSync(file, previousArtifact, { mode: 0o600 });
        else removeAutostartArtifact(file);
      };
      // Never delete a task that existed before this registration attempt. If
      // there was no previous task, clean up only when a post-failure query can
      // positively identify a partially registered new task.
      const rollbackRegistration = !previousTaskExisted && autostartEnabled(paths)
        ? () => cleanupManagedAutostart(paths, {
            kind,
            file,
            managerExpected: true,
            message: "Failed to roll back Windows autostart registration",
          })
        : restorePreviousArtifact;
      return throwAfterRollback(error, rollbackRegistration);
    }
    let manualStopped = false;
    let taskStarted = false;
    const rollback = () => cleanupManagedAutostart(paths, {
      kind,
      file,
      stopRouter: taskStarted,
      managerExpected: true,
      message: "Failed to roll back Windows autostart",
    });
    try {
      if (wasRunning) {
        await stopInstance(paths);
        manualStopped = true;
      }
      // Register-ScheduledTask -Force can replace a definition while an older
      // task instance is still running. End that stale owner only after a
      // healthy router has been shut down through its authenticated endpoint.
      if (windowsTaskInfo()?.state !== "Ready") {
        try {
          execFileSync("schtasks", ["/end", "/tn", WINDOWS_TASK], { stdio: ["ignore", "ignore", "pipe"] });
        } catch {
          // It may have completed between the state query and /end.
        }
      }
      await waitForWindowsTaskState("Ready");
      // Take effect now, not only at the next logon.
      execFileSync("schtasks", ["/run", "/tn", WINDOWS_TASK], { stdio: ["ignore", "ignore", "pipe"] });
      taskStarted = true;
      const ready = await waitForHealth(port, routerToken);
      if (!ready) throw new Error(`Autostart is installed but the router did not become ready; inspect ${paths.log}`);
      const task = windowsTaskInfo();
      if (task?.state !== "Running") {
        throw new Error(`Router started without a live scheduled supervisor (task state: ${task?.state ?? "missing"})`);
      }
      console.log(`DSCodex autostart enabled (${kind}); router running on ${HOST}:${port}`);
      console.log(`DeepSeek key: ${ready.deepseek_key ? "configured" : "missing (resolves from the stored key at runtime)"}`);
      return;
    } catch (error) {
      if (manualStopped || (wasRunning && !(await health(port, routerToken)))) {
        return restoreManualRouter(paths, port, error, rollback);
      }
      return throwAfterRollback(error, rollback);
    }
  }

  // launchd/systemd start the service during registration, so release the port
  // immediately before handing ownership to the service manager.
  let manualStopped = false;
  let managerActivationAttempted = false;
  const rollback = () => cleanupManagedAutostart(paths, {
    kind,
    file,
    stopRouter: managerActivationAttempted,
    deactivateManager: managerActivationAttempted,
    managerExpected: managerActivationAttempted,
    message: `Failed to roll back ${kind} autostart`,
  });
  try {
    if (wasRunning) {
      await stopInstance(paths);
      manualStopped = true;
    }
    if (kind === "launchd") {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, buildLaunchdPlist({ nodePath: nodePath(), cliPath, port, logPath: paths.log }), { mode: 0o600 });
      const uid = process.getuid();
      bootoutLaunchd(uid);
      managerActivationAttempted = true;
      execFileSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, file], { stdio: ["ignore", "ignore", "pipe"] });
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, buildSystemdUnit({ nodePath: nodePath(), cliPath, port, logPath: paths.log }), { mode: 0o600 });
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: ["ignore", "ignore", "pipe"] });
      try {
        managerActivationAttempted = true;
        execFileSync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], { stdio: ["ignore", "ignore", "pipe"] });
      } catch (error) {
        throw new Error(`systemd user service unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }

    const ready = await waitForHealth(port, routerToken);
    if (!ready) throw new Error(`Autostart is installed but the router did not become ready; inspect ${paths.log}`);
    console.log(`DSCodex autostart enabled (${kind}); router running on ${HOST}:${port}`);
    console.log(`DeepSeek key: ${ready.deepseek_key ? "configured" : "missing (resolves from the stored key at runtime)"}`);
  } catch (error) {
    if (manualStopped || (wasRunning && !(await health(port, routerToken)))) {
      return restoreManualRouter(paths, port, error, rollback);
    }
    return throwAfterRollback(error, rollback);
  }
}

async function autostartDisable(paths, { quiet = false } = {}) {
  const kind = autostartKind();
  const file = autostartFile(paths);
  const wasEnabled = autostartEnabled(paths);
  const removed = wasEnabled || existsSync(file);
  await cleanupManagedAutostart(paths, {
    kind,
    file,
    stopRouter: wasEnabled,
    managerExpected: wasEnabled,
    message: `DSCodex autostart cleanup encountered errors (${kind})`,
  });
  if (quiet) return;
  if (removed) {
    console.log(`DSCodex autostart disabled (${kind}); the managed router was stopped`);
    console.log("Run `node src/cli.mjs start` to run the router manually");
  } else {
    console.log("DSCodex autostart is not enabled");
  }
}

async function autostartStatus(paths, port) {
  const kind = autostartKind();
  const enabled = autostartEnabled(paths);
  const ready = await health(port, readRouterToken(paths.keyFile));
  const task = kind === "schtasks" && enabled ? windowsTaskInfo() : null;
  const taskStatus = task
    ? `; task ${task.state}${task.state === "Running" ? "" : `, last result ${windowsTaskResult(task.lastTaskResult)}`}`
    : "";
  console.log(`autostart: ${enabled ? `enabled (${kind}${taskStatus}, port in config: see ${autostartFile(paths)})` : "not enabled"}`);
  console.log(`router: ${ready ? `running (${HOST}:${port})` : "stopped"}`);
  if (enabled && ready && kind === "schtasks" && task?.state !== "Running") {
    console.log("warning: the router is running manually; the scheduled supervisor is inactive");
  }
  if (!enabled || !ready || (kind === "schtasks" && task?.state !== "Running")) process.exitCode = 1;
}

async function manageAutostart(subcommand, paths, port) {
  if (subcommand === "enable") return autostartEnable(paths, port);
  if (subcommand === "disable") return autostartDisable(paths);
  if (subcommand === "status") return autostartStatus(paths, port);
  throw new Error(`Unknown autostart subcommand: ${subcommand}`);
}

async function status(port) {
  const { paths } = runtime();
  const ready = await health(port, readRouterToken(paths.keyFile));
  if (!ready) {
    console.log(`stopped (${HOST}:${port})`);
    process.exitCode = 1;
    return;
  }
  console.log(`running (${HOST}:${port}); DeepSeek key ${ready.deepseek_key ? "configured" : "missing"}`);
}

async function manageKey(subcommand, paths, port) {
  if (subcommand === "set") {
    const key = process.env.DEEPSEEK_API_KEY?.trim() || launchctlKey() || await promptSecret("DeepSeek API Key: ");
    writeStoredKey(paths.keyFile, key);
    console.log(`Stored DeepSeek API key in ${paths.keyFile} (${process.platform === "win32" ? "DPAPI-encrypted" : "mode 0600"})`);
    if (await health(port, readRouterToken(paths.keyFile))) console.log("Restart the router (stop && start) so the running server picks up the new key");
    return;
  }
  if (subcommand === "delete") {
    deleteStoredKey(paths.keyFile);
    console.log(`Removed the stored DeepSeek API key from ${paths.keyFile}`);
    if (await health(port, readRouterToken(paths.keyFile))) console.log("Restart the router (stop && start) to drop the in-memory key");
    return;
  }
  if (subcommand === "status") {
    const source = keySource(paths.keyFile);
    console.log(source ? `DeepSeek key: configured (${source})` : "DeepSeek key: missing");
    return;
  }
  throw new Error(`Unknown key subcommand: ${subcommand}`);
}

async function manageProxy(subcommand, args, paths, port) {
  if (subcommand === "set") {
    const url = (args[0] ?? "").trim() || process.env.DSCODEX_PROXY?.trim();
    if (!url) throw new Error("Usage: dscodex proxy set http://127.0.0.1:10808 (or set DSCODEX_PROXY)");
    const validated = validateProxyUrl(url);
    writeProxyUrl(paths.keyFile, validated);
    console.log(`Stored proxy ${redactProxyUrl(validated)} in ${paths.keyFile}`);
    if (await health(port, readRouterToken(paths.keyFile))) console.log("Restart the router (stop && start) so the running server picks it up");
    return;
  }
  if (subcommand === "status") {
    const stored = readProxyUrl(paths.keyFile);
    const resolved = resolveProxy(process.env, stored);
    console.log(resolved ? `proxy: configured (${proxySource(process.env, stored)})` : "proxy: missing");
    return;
  }
  if (subcommand === "clear") {
    writeProxyUrl(paths.keyFile, "");
    console.log(`Removed proxy from ${paths.keyFile}`);
    if (await health(port, readRouterToken(paths.keyFile))) console.log("Restart the router (stop && start) to drop the in-memory proxy");
    return;
  }
  throw new Error(`Unknown proxy subcommand: ${subcommand}`);
}

async function doctor(port) {
  const { paths } = runtime();
  const config = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "";
  const routerToken = readRouterToken(paths.keyFile);
  const ready = await health(port, routerToken);
  const checks = {
    config_injected: Boolean(routerToken) && managedRouterConfigMatches(config, {
      port,
      catalogPath: paths.catalog,
      routerToken,
    }),
    catalog_present: existsSync(paths.catalog) && catalogReady(paths),
    router_token_present: Boolean(routerToken),
    proxy_running: Boolean(ready),
    deepseek_key_in_proxy: Boolean(ready?.deepseek_key),
    // The app-server bridge is macOS-only and opt-in. The check passes when
    // the bridge is cleanly disabled (no DSCodex-owned CODEX_CLI_PATH) or
    // fully functional (shim present and the stock Codex binary resolvable).
    app_server_bridge: process.platform !== "darwin" || bridgeStateOk(paths),
  };
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "ok" : "missing"}  ${name}`);
  if (Object.values(checks).some((ok) => !ok)) process.exitCode = 1;
}

function usage() {
  console.log(`DSCodex ${VERSION}

Usage: dscodex <command> [--port ${DEFAULT_PORT}]

  install     merge 🐳 V4 Flash and 🐳 V4 Pro into the Codex model catalog
  sync        refresh native GPT entries in the merged catalog
  key set     store the DeepSeek API key (hidden prompt, or DEEPSEEK_API_KEY env)
  key status  show where the DeepSeek key comes from
  key delete  remove the stored DeepSeek key
  proxy set   store the outbound proxy for GPT/vision traffic (e.g. http://127.0.0.1:10808)
  proxy status  show where the proxy comes from
  proxy clear   remove the stored proxy
  start       run the loopback router in the background
  serve       run the loopback router in the foreground
  autostart enable|disable|status  run the router automatically at login
  bridge enable|disable|status  opt-in app-server bridge (provider effort memory; may degrade Computer Use)
  status      show router state
  doctor      verify catalog, routing, key, and app-server bridge state
  stop        stop the background router
  uninstall   remove only DSCodex-owned Codex configuration

Key sources, in order: DEEPSEEK_API_KEY env, ~/.codex/dscodex/config.json${
  process.platform === "darwin" ? ", then the macOS launchctl login session" : ""
}. The stored key survives reboots.

Proxy sources, in order: DSCODEX_HTTPS_PROXY / DSCODEX_HTTP_PROXY env,
standard HTTP(S)_PROXY env (lowercase names take precedence), then ~/.codex/dscodex/config.json (proxy set).
The router re-execs itself with Node's --use-env-proxy (Node >= 24.5); loopback and
api.deepseek.com stay outside the proxy while GPT passthrough and vision use it.`);
}

async function uninstallAll(paths) {
  const failures = [];
  const operations = [
    () => autostartDisable(paths, { quiet: true }),
    () => stopInstance(paths),
    () => uninstall({ paths }),
    () => deactivateBridge(paths),
  ];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    const details = failures.map((error) => (
      error instanceof Error ? error.message : String(error)
    )).join("; ");
    throw new AggregateError(
      failures,
      `Uninstall completed all possible cleanup steps but encountered errors: ${details}`,
    );
  }
  console.log("Removed DSCodex-owned config, catalog, selection state, autostart entry, and app-server bridge");
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  const port = parsePort(args);
  const { paths } = runtime();
  switch (command) {
    case "install": {
      const result = install({ paths, port });
      // The app-server bridge is opt-in: a global CODEX_CLI_PATH forces the
      // Codex app off its local daemon websocket (which supports reconnect)
      // onto stdio through our shim, breaking Computer Use. Undo any bridge
      // a previous DSCodex version installed globally; model switching works
      // through the catalog either way.
      deactivateBridge(paths);
      const installedDeepSeek = result.catalog.models
        .filter((model) => model.slug?.startsWith("deepseek/"))
        .map((model) => model.display_name)
        .join(" and ");
      console.log(`Installed ${installedDeepSeek} with default Max reasoning`);
      console.log(`Fully quit and restart Codex after starting DSCodex on ${HOST}:${port}`);
      console.log("Optional: `node src/cli.mjs autostart enable` starts the router at login");
      console.log("Optional: `node src/cli.mjs bridge enable` restores provider-specific effort memory in the ChatGPT app");
      break;
    }
    case "sync": {
      const catalog = syncCatalog({ cachePath: paths.cache, catalogPath: paths.catalog });
      console.log(`Synced ${catalog.models.length} catalog entries`);
      break;
    }
    case "key": await manageKey(args[0] ?? "status", paths, port); break;
    case "proxy": await manageProxy(args[0] ?? "status", args.slice(1), paths, port); break;
    case "start": await start(port); break;
    case "serve": await serve(port); break;
    case "supervise": await supervise(port); break;
    case "autostart": await manageAutostart(args[0] ?? "status", paths, port); break;
    case "bridge": await manageBridge(args[0] ?? "status", paths); break;
    case "status": await status(port); break;
    case "doctor": await doctor(port); break;
    case "stop": await stop(); break;
    case "uninstall": await uninstallAll(paths); break;
    case "--version":
    case "version": console.log(VERSION); break;
    case "help":
    case "--help":
    case "-h": usage(); break;
    default: throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(`dscodex: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
