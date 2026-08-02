#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { buildCatalog, syncCatalog } from "./catalog.mjs";
import { install, uninstall } from "./config.mjs";
import { deleteStoredKey, readStoredKey, writeStoredKey } from "./keys.mjs";
import { createProxyServer } from "./proxy.mjs";
import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  WINDOWS_TASK,
  autostartKind,
  buildLaunchdPlist,
  buildSystemdUnit,
  buildWindowsVbs,
  launchdPlistPath,
  systemdUnitPath,
} from "./autostart.mjs";
import { DEFAULT_PORT, HOST, VERSION, pathsFor, resolveCodexHome } from "./constants.mjs";

const APP_SERVER_WRAPPER = fileURLToPath(new URL("./codex-wrapper.mjs", import.meta.url));

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

function stockCodexPath() {
  const candidates = [
    launchctlGet("DSCODEX_REAL_CODEX"),
    process.env.DSCODEX_REAL_CODEX?.trim(),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  ];
  try {
    candidates.push(execFileSync("/usr/bin/which", ["codex"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim());
  } catch {
    // The bundled ChatGPT path above is the normal macOS install.
  }
  return candidates.find((candidate) => candidate && candidate !== APP_SERVER_WRAPPER && existsSync(candidate)) ?? "";
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

function writeBridgeShim(path) {
  // GUI apps get a bare launchd PATH (/usr/bin:/bin:...), so a `#!/usr/bin/env node`
  // shebang fails there. Point CODEX_CLI_PATH at a shim with absolute paths instead.
  const content = `#!/bin/sh\nexec ${JSON.stringify(nodePath())} ${JSON.stringify(APP_SERVER_WRAPPER)} "$@"\n`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o755 });
}

function bridgePlan(paths) {
  if (process.platform !== "darwin") return null;
  const existing = launchctlGet("CODEX_CLI_PATH");
  if (existing && existing !== paths.bridgeShim && existing !== APP_SERVER_WRAPPER) {
    throw new Error(`Refusing to replace user-owned CODEX_CLI_PATH: ${existing}`);
  }
  const realCodex = stockCodexPath();
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
  if (current !== paths.bridgeShim && current !== APP_SERVER_WRAPPER) return;
  execFileSync("/bin/launchctl", ["unsetenv", "CODEX_CLI_PATH"]);
  execFileSync("/bin/launchctl", ["unsetenv", "DSCODEX_REAL_CODEX"]);
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

async function health(port) {
  try {
    const response = await fetch(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(700) });
    return response.ok ? await response.json() : null;
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

async function serve(port) {
  process.title = "dscodex";
  const { paths } = runtime();
  syncIfPossible(paths);
  const deepSeekKey = resolveDeepSeekKey(process.env, paths.keyFile);
  const server = createProxyServer({ deepSeekKey, models: loadModels(paths) });
  // The serve process owns the pid file so `stop` works no matter who launched
  // it — `start`, launchd, systemd, or the Windows Task Scheduler.
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.pid, `${JSON.stringify({ pid: process.pid, port })}\n`, { mode: 0o600 });
  const shutdown = () => server.close(() => {
    try {
      unlinkSync(paths.pid);
    } catch {
      // Already removed by `stop`.
    }
    process.exit(0);
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.listen(port, HOST, () => {
    console.log(`DSCodex ${VERSION} listening at http://${HOST}:${port}/v1`);
    console.log(`DeepSeek key: ${deepSeekKey ? "configured" : "missing (GPT OAuth passthrough still works)"}`);
  });
}

function stopInstance(paths) {
  if (!existsSync(paths.pid)) return "none";
  const state = JSON.parse(readFileSync(paths.pid, "utf8"));
  try {
    process.kill(state.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    if (existsSync(paths.pid)) unlinkSync(paths.pid);
    return "stale";
  }
  // The graceful shutdown (exit 0) is exactly what launchd KeepAlive
  // (SuccessfulExit=false) and systemd Restart=on-failure leave alone.
  if (existsSync(paths.pid)) unlinkSync(paths.pid);
  return "stopped";
}

async function start(port) {
  const running = await health(port);
  if (running) {
    console.log(`DSCodex is already running on ${HOST}:${port}`);
    return;
  }
  const { paths } = runtime();
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  syncIfPossible(paths);
  const deepSeekKey = resolveDeepSeekKey(process.env, paths.keyFile);
  const logFd = openSync(paths.log, "a", 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", "--port", String(port)], {
    detached: true,
    windowsHide: true,
    env: { ...process.env, ...(deepSeekKey ? { DEEPSEEK_API_KEY: deepSeekKey } : {}) },
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ready = await health(port);
    if (ready) {
      console.log(`DSCodex started on ${HOST}:${port} (pid ${child.pid})`);
      console.log(`DeepSeek key: ${ready.deepseek_key ? "configured" : "missing"}`);
      return;
    }
  }
  throw new Error(`DSCodex did not become ready; inspect ${paths.log}`);
}

async function stop() {
  const { paths } = runtime();
  const result = stopInstance(paths);
  if (result === "none") console.log("DSCodex is not running (no pid file)");
  else if (result === "stale") console.log("Removed stale DSCodex pid file");
  else console.log("Stopped DSCodex");
}

function autostartFile(paths) {
  const kind = autostartKind();
  if (kind === "launchd") return launchdPlistPath();
  if (kind === "systemd") return systemdUnitPath();
  return join(paths.stateDir, "autostart-run.vbs");
}

function autostartEnabled(paths) {
  if (autostartKind() === "schtasks") {
    try {
      execFileSync("schtasks", ["/query", "/tn", WINDOWS_TASK], { stdio: ["ignore", "ignore", "ignore"] });
      return true;
    } catch {
      return false;
    }
  }
  return existsSync(autostartFile(paths));
}

// The generated plist/unit/VBS never embeds the DeepSeek key: the router resolves
// it from the stored key file at runtime.
async function autostartEnable(paths, port) {
  const kind = autostartKind();
  const file = autostartFile(paths);
  const cliPath = fileURLToPath(import.meta.url);
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });

  // Free the port so the manager-launched instance can bind immediately.
  if (await health(port)) {
    stopInstance(paths);
    for (let attempt = 0; attempt < 30 && (await health(port)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (kind === "launchd") {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, buildLaunchdPlist({ nodePath: nodePath(), cliPath, port, logPath: paths.log }), { mode: 0o600 });
    const uid = process.getuid();
    try {
      execFileSync("/bin/launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      // Not loaded yet.
    }
    execFileSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, file], { stdio: ["ignore", "ignore", "pipe"] });
  } else if (kind === "schtasks") {
    writeFileSync(file, buildWindowsVbs({ nodePath: nodePath(), cliPath, port, logPath: paths.log }), { mode: 0o600 });
    const wscript = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
    execFileSync("schtasks", ["/create", "/tn", WINDOWS_TASK, "/sc", "onlogon", "/rl", "limited", "/f", "/tr", `"${wscript}" "${file}"`], { stdio: ["ignore", "ignore", "pipe"] });
    // Take effect now, not only at the next logon.
    execFileSync("schtasks", ["/run", "/tn", WINDOWS_TASK], { stdio: ["ignore", "ignore", "pipe"] });
  } else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, buildSystemdUnit({ nodePath: nodePath(), cliPath, port, logPath: paths.log }), { mode: 0o600 });
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: ["ignore", "ignore", "pipe"] });
      execFileSync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      throw new Error(`systemd user service unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ready = await health(port);
    if (ready) {
      console.log(`DSCodex autostart enabled (${kind}); router running on ${HOST}:${port}`);
      console.log(`DeepSeek key: ${ready.deepseek_key ? "configured" : "missing (resolves from the stored key at runtime)"}`);
      return;
    }
  }
  throw new Error(`Autostart is installed but the router did not become ready; inspect ${paths.log}`);
}

function autostartDisable(paths, { quiet = false } = {}) {
  const kind = autostartKind();
  const file = autostartFile(paths);
  let removed = false;
  if (kind === "launchd") {
    try {
      execFileSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${LAUNCHD_LABEL}`], { stdio: ["ignore", "ignore", "ignore"] });
      removed = true;
    } catch {
      // Not loaded.
    }
  } else if (kind === "schtasks") {
    try {
      execFileSync("schtasks", ["/delete", "/tn", WINDOWS_TASK, "/f"], { stdio: ["ignore", "ignore", "ignore"] });
      removed = true;
    } catch {
      // Task absent.
    }
  } else {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], { stdio: ["ignore", "ignore", "ignore"] });
      removed = true;
    } catch {
      // Unit absent or systemd unavailable.
    }
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      // Best effort.
    }
  }
  if (existsSync(file)) {
    unlinkSync(file);
    removed = true;
  }
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
  const ready = await health(port);
  console.log(`autostart: ${enabled ? `enabled (${kind}, port in config: see ${autostartFile(paths)})` : "not enabled"}`);
  console.log(`router: ${ready ? `running (${HOST}:${port})` : "stopped"}`);
  if (!enabled) process.exitCode = 1;
}

async function manageAutostart(subcommand, paths, port) {
  if (subcommand === "enable") return autostartEnable(paths, port);
  if (subcommand === "disable") return autostartDisable(paths);
  if (subcommand === "status") return autostartStatus(paths, port);
  throw new Error(`Unknown autostart subcommand: ${subcommand}`);
}

async function status(port) {
  const ready = await health(port);
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
    if (await health(port)) console.log("Restart the router (stop && start) so the running server picks up the new key");
    return;
  }
  if (subcommand === "delete") {
    deleteStoredKey(paths.keyFile);
    console.log(`Removed ${paths.keyFile}`);
    if (await health(port)) console.log("Restart the router (stop && start) to drop the in-memory key");
    return;
  }
  if (subcommand === "status") {
    const source = keySource(paths.keyFile);
    console.log(source ? `DeepSeek key: configured (${source})` : "DeepSeek key: missing");
    return;
  }
  throw new Error(`Unknown key subcommand: ${subcommand}`);
}

async function doctor(port) {
  const { paths } = runtime();
  const config = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "";
  const ready = await health(port);
  const checks = {
    config_injected: config.includes("# DSCodex managed"),
    catalog_present: existsSync(paths.catalog),
    proxy_running: Boolean(ready),
    deepseek_key_in_proxy: Boolean(ready?.deepseek_key),
    // The app-server bridge is macOS-only: Windows GUI apps cannot spawn a script
    // shim (CreateProcess requires an .exe), so the check is skipped elsewhere.
    app_server_bridge: process.platform !== "darwin" || (
      launchctlGet("CODEX_CLI_PATH") === paths.bridgeShim && Boolean(launchctlGet("DSCODEX_REAL_CODEX"))
    ),
  };
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "ok" : "missing"}  ${name}`);
  if (Object.values(checks).some((ok) => !ok)) process.exitCode = 1;
}

function usage() {
  console.log(`DSCodex ${VERSION}

Usage: dscodex <command> [--port ${DEFAULT_PORT}]

  install     merge 🐳 V4 Flash into the Codex model catalog
  sync        refresh native GPT entries in the merged catalog
  key set     store the DeepSeek API key (hidden prompt, or DEEPSEEK_API_KEY env)
  key status  show where the DeepSeek key comes from
  key delete  remove the stored DeepSeek key
  start       run the loopback router in the background
  serve       run the loopback router in the foreground
  autostart enable|disable|status  run the router automatically at login
  status      show router state
  doctor      verify catalog, routing, key, and app-server bridge state
  stop        stop the background router
  uninstall   remove only DSCodex-owned Codex configuration

Key sources, in order: DEEPSEEK_API_KEY env, ~/.codex/dscodex/config.json${
  process.platform === "darwin" ? ", then the macOS launchctl login session" : ""
}. The stored key survives reboots.`);
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  const port = parsePort(args);
  const { paths } = runtime();
  switch (command) {
    case "install": {
      const plan = bridgePlan(paths);
      const result = install({ paths, port });
      activateBridge(plan);
      console.log(`Installed ${result.catalog.models[0].display_name} with default Max reasoning`);
      console.log("Installed provider-specific effort and speed memory for the ChatGPT app");
      console.log(`Fully quit and restart Codex after starting DSCodex on ${HOST}:${port}`);
      console.log("Optional: `node src/cli.mjs autostart enable` starts the router at login");
      break;
    }
    case "sync": {
      const catalog = syncCatalog({ cachePath: paths.cache, catalogPath: paths.catalog });
      console.log(`Synced ${catalog.models.length} catalog entries`);
      break;
    }
    case "key": await manageKey(args[0] ?? "status", paths, port); break;
    case "start": await start(port); break;
    case "serve": await serve(port); break;
    case "autostart": await manageAutostart(args[0] ?? "status", paths, port); break;
    case "status": await status(port); break;
    case "doctor": await doctor(port); break;
    case "stop": await stop(); break;
    case "uninstall":
      autostartDisable(paths, { quiet: true });
      await stop();
      uninstall({ paths });
      deactivateBridge(paths);
      console.log("Removed DSCodex-owned config, catalog, selection state, autostart entry, and app-server bridge");
      break;
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
