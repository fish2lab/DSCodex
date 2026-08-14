import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  buildWindowsRegisterScript,
  buildWindowsVbs,
  encodeWindowsVbs,
} from "../src/autostart.mjs";
import { buildInstalledConfig } from "../src/config.mjs";
import { pathsFor } from "../src/constants.mjs";
import { ensureRouterToken } from "../src/keys.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const SUPERVISOR_FIXTURE_SOURCE = [
  'import { readFileSync, writeFileSync } from "node:fs";',
  'const statePath = process.env.DSCODEX_TEST_SUPERVISOR_STATE;',
  'let attempts = 0;',
  'try { attempts = Number(readFileSync(statePath, "utf8")) || 0; } catch {}',
  'attempts += 1;',
  'writeFileSync(statePath, String(attempts));',
  'console.error(`fixture stderr attempt ${attempts}`);',
  'const failures = Number(process.env.DSCODEX_TEST_SUPERVISOR_FAILURES ?? 0);',
  'process.exit(attempts <= failures ? 23 : 0);',
  '',
].join("\n");

function routerEnv(codexHome, source = process.env) {
  const env = { ...source, CODEX_HOME: codexHome };
  // Keep this case-insensitive so Linux/macOS CI with lowercase proxy names
  // exercises the intended direct serve process instead of its proxy re-exec.
  for (const name of Object.keys(env)) {
    if (/^(?:DSCODEX_)?HTTPS?_PROXY$/i.test(name)) delete env[name];
  }
  delete env.DSCODEX_PROXY_REEXEC;
  return env;
}

function prepareRouterHome(codexHome, port) {
  const paths = pathsFor(codexHome);
  const routerToken = ensureRouterToken(paths.keyFile);
  const config = buildInstalledConfig("", {
    port,
    catalogPath: paths.catalog,
    routerToken,
  });
  writeFileSync(paths.config, config.endsWith("\n") ? config : `${config}\n`);
  return paths;
}

async function waitForFile(path, message = "file") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function waitForPortToClose(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const closed = await new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(true));
    });
    if (closed) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the router port to close");
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("launchd plist embeds absolute paths and restarts only on failure", () => {
  const plist = buildLaunchdPlist({
    nodePath: "/opt/homebrew/bin/node",
    cliPath: "/x y/DSCodex/src/cli.mjs",
    port: 10110,
    logPath: "/u/.codex/dscodex/server.log",
  });
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.dscodex\.router<\/string>/);
  assert.ok(plist.includes("<string>/opt/homebrew/bin/node</string>"));
  assert.ok(plist.includes("<string>/x y/DSCodex/src/cli.mjs</string>"));
  assert.ok(plist.includes("<string>10110</string>"));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.ok(plist.includes("<string>/u/.codex/dscodex/server.log</string>"));
});

test("launchd plist XML-escapes paths", () => {
  const plist = buildLaunchdPlist({
    nodePath: "/weird/&<node>",
    cliPath: "/x/cli.mjs",
    port: 1,
    logPath: "/l",
  });
  assert.ok(plist.includes("/weird/&amp;&lt;node&gt;"));
  assert.ok(!plist.includes("/weird/&<node>"));
});

test("systemd unit quotes paths and restarts on failure only", () => {
  const unit = buildSystemdUnit({
    nodePath: "/usr/bin/node",
    cliPath: "/x y/DSCodex/src/cli.mjs",
    port: 10110,
    logPath: "/u/.codex/dscodex/server.log",
  });
  assert.ok(unit.includes('ExecStart="/usr/bin/node" "/x y/DSCodex/src/cli.mjs" serve --port 10110'));
  assert.ok(unit.includes("Restart=on-failure"));
  assert.ok(unit.includes("WantedBy=default.target"));
  assert.ok(unit.includes("StandardOutput=append:/u/.codex/dscodex/server.log"));
});

test("windows vbs waits for the hidden Node supervisor and quotes paths safely", () => {
  const vbs = buildWindowsVbs({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\x\\src\\cli.mjs",
    port: 10110,
    codexHome: "C:\\u\\.codex",
    homeDir: "C:\\Users\\tester",
  });
  assert.ok(vbs.includes('Set shell = CreateObject("Wscript.Shell")'));
  assert.ok(vbs.includes('nodePath = "C:\\Program Files\\nodejs\\node.exe"'));
  assert.ok(vbs.includes('cliPath = "C:\\x\\src\\cli.mjs"'));
  assert.ok(vbs.includes('codexHome = "C:\\u\\.codex"'));
  assert.ok(vbs.includes('" supervise --port 10110"'));
  assert.ok(vbs.includes("WScript.Quit shell.Run(command, 0, True)"));
  assert.ok(!vbs.includes("powershell"));
  assert.ok(!vbs.includes("Out-File"));
  assert.ok(!vbs.includes("cmd /c"));
});

test("windows task registration is user-scoped and restarts router crashes", () => {
  const script = buildWindowsRegisterScript({
    taskName: "DSCodex",
    vbsPath: "C:\\Users\\o'h\\.codex\\dscodex\\autostart-run.vbs",
    windowsDir: "C:\\Windows",
  });
  assert.ok(script.includes("New-ScheduledTaskTrigger -AtLogOn -User $user"));
  assert.ok(script.includes("New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited"));
  assert.ok(script.includes("-RestartCount 255"));
  assert.ok(script.includes("-RestartInterval (New-TimeSpan -Minutes 1)"));
  assert.ok(script.includes("-ExecutionTimeLimit ([TimeSpan]::Zero)"));
  assert.ok(script.includes("-MultipleInstances IgnoreNew"));
  assert.ok(script.includes("Register-ScheduledTask -TaskName 'DSCodex'"));
  assert.ok(script.includes("'\"C:\\Users\\o''h\\.codex\\dscodex\\autostart-run.vbs\"'"));
});

test("windows vbs escapes single quotes and is immune to cmd metacharacters in paths", () => {
  const vbs = buildWindowsVbs({
    nodePath: "C:\\a&b\\node.exe",
    cliPath: "C:\\o'h\\cli.mjs",
    port: 10110,
    codexHome: "C:\\u|v\\.codex",
    homeDir: "C:\\Users\\tester",
  });
  assert.ok(vbs.includes('nodePath = "C:\\a&b\\node.exe"'));
  assert.ok(vbs.includes('cliPath = "C:\\o\'h\\cli.mjs"'));
  assert.ok(vbs.includes('codexHome = "C:\\u|v\\.codex"'));
  assert.ok(!vbs.includes("cmd /c"));
});

test("windows vbs rejects invalid ports", () => {
  assert.throws(
    () => buildWindowsVbs({ nodePath: "n", cliPath: "c", port: 99999, codexHome: "h" }),
    /Invalid port/,
  );
});

test("router test environment removes proxy variables case-insensitively", () => {
  const env = routerEnv("/tmp/codex", {
    https_proxy: "http://lower.example",
    dscodex_http_proxy: "http://custom.example",
    KEEP_ME: "yes",
  });
  assert.equal(env.https_proxy, undefined);
  assert.equal(env.dscodex_http_proxy, undefined);
  assert.equal(env.KEEP_ME, "yes");
});

test("windows vbs resolves home-relative paths at runtime for non-ASCII homes", () => {
  const vbs = buildWindowsVbs({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\王小明\\DSCodex\\src\\cli.mjs",
    port: 10110,
    codexHome: "C:\\Users\\王小明\\.codex",
    homeDir: "C:\\Users\\王小明",
  });
  assert.ok(vbs.includes('shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\\DSCodex\\src\\cli.mjs"'));
  assert.ok(vbs.includes('shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\\.codex"'));
  assert.equal(vbs.match(/[^\x00-\x7F]/g), null);
});

test("windows vbs keeps literal Codex homes outside the user home", () => {
  const vbs = buildWindowsVbs({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\x\\src\\cli.mjs",
    port: 10110,
    codexHome: "D:\\state\\.codex",
    homeDir: "C:\\Users\\王小明",
  });
  assert.ok(vbs.includes('codexHome = "D:\\state\\.codex"'));
});

test("windows vbs is executable and propagates the hidden supervisor exit code", {
  skip: process.platform !== "win32" ? "Windows integration test" : false,
}, () => {
  const temp = mkdtempSync(join(tmpdir(), "dscodex-vbs-"));
  const vbsPath = join(temp, "autostart-run.vbs");
  const unicodeDir = join(temp, "测试目录");
  const fixturePath = join(unicodeDir, "supervisor-child.mjs");
  const statePath = join(temp, "attempts.txt");
  try {
    mkdirSync(unicodeDir);
    writeFileSync(fixturePath, SUPERVISOR_FIXTURE_SOURCE);
    writeFileSync(vbsPath, encodeWindowsVbs(buildWindowsVbs({
      nodePath: process.execPath,
      cliPath: fixturePath,
      port: 10110,
      codexHome: temp,
    })));
    const result = spawnSync("cscript.exe", ["//nologo", vbsPath], {
      env: {
        ...process.env,
        DSCODEX_TEST_SUPERVISOR_STATE: statePath,
        DSCODEX_TEST_SUPERVISOR_FAILURES: "1",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 23, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(statePath, "utf8"), "1");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("failed Windows autostart registration leaves a healthy manual router running", {
  timeout: 20_000,
  skip: process.platform !== "win32" ? "Windows integration test" : false,
}, async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-autostart-register-fail-"));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const paths = prepareRouterHome(codexHome, port);
  const env = routerEnv(codexHome);
  const child = spawn(process.execPath, [CLI, "serve", "--port", String(port)], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    await waitForFile(paths.pid, "router pid file");
    const failed = await runCli(["autostart", "enable", "--port", String(port)], {
      ...env,
      SystemRoot: "C:\\dscodex-missing-windows-root",
    });
    assert.notEqual(failed.code, 0, `${failed.stdout}\n${failed.stderr}`);

    const status = await runCli(["status", "--port", String(port)], env);
    assert.equal(status.code, 0, `${status.stdout}\n${status.stderr}`);
    assert.match(status.stdout, /running/);
    assert.equal(JSON.parse(readFileSync(paths.pid, "utf8")).pid, child.pid);
  } finally {
    await runCli(["stop", "--port", String(port)], env);
    child.kill("SIGKILL");
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("serve owns its pid file across start and graceful shutdown", { timeout: 20_000 }, async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-serve-"));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const paths = prepareRouterHome(codexHome, port);
  const env = routerEnv(codexHome);
  const child = spawn(process.execPath, [CLI, "serve", "--port", String(port)], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  try {
    await waitForFile(paths.pid, `pid file${stderr ? `: ${stderr.trim()}` : ""}`);
    assert.equal(JSON.parse(readFileSync(paths.pid, "utf8")).pid, child.pid);

    const stopper = spawnSync(process.execPath, [CLI, "stop", "--port", String(port)], {
      env,
      encoding: "utf8",
    });
    assert.equal(stopper.status, 0, `${stopper.stdout}\n${stopper.stderr}`);
    const [code] = await exited;
    assert.equal(code, 0);
    assert.equal(existsSync(paths.pid), false);
  } finally {
    child.kill("SIGKILL");
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("proxy re-exec forwards termination to the actual router process", {
  timeout: 20_000,
  skip: process.platform === "win32" ? "Windows child.kill does not deliver catchable signals" : false,
}, async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-proxy-reexec-"));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const paths = prepareRouterHome(codexHome, port);
  const env = {
    ...routerEnv(codexHome),
    DSCODEX_HTTP_PROXY: "http://127.0.0.1:1",
  };
  const parent = spawn(process.execPath, [CLI, "serve", "--port", String(port)], {
    env,
    stdio: "ignore",
  });
  const parentExited = once(parent, "exit");
  let routerPid;
  try {
    await waitForFile(paths.pid, "proxy re-exec router pid file");
    routerPid = JSON.parse(readFileSync(paths.pid, "utf8")).pid;
    assert.notEqual(routerPid, parent.pid);

    parent.kill("SIGTERM");
    const [code, signal] = await parentExited;
    assert.equal(code, 0);
    assert.equal(signal, null);
    await waitForPortToClose(port);
    assert.equal(existsSync(paths.pid), false);
  } finally {
    try { parent.kill("SIGKILL"); } catch {}
    if (routerPid) {
      try { process.kill(routerPid, "SIGKILL"); } catch {}
    }
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("loopback status and shutdown bypass an enabled environment proxy", { timeout: 20_000 }, async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-control-direct-"));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const paths = prepareRouterHome(codexHome, port);
  const directEnv = routerEnv(codexHome);
  delete directEnv.NODE_OPTIONS;
  delete directEnv.NODE_USE_ENV_PROXY;
  const child = spawn(process.execPath, [CLI, "serve", "--port", String(port)], {
    env: directEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const routerExited = once(child, "exit");
  let proxyHits = 0;
  const fakeProxy = createServer((_request, response) => {
    proxyHits += 1;
    response.writeHead(502, { connection: "close" });
    response.end();
  });
  fakeProxy.on("connect", (_request, socket) => {
    proxyHits += 1;
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  fakeProxy.listen(0, "127.0.0.1");
  await once(fakeProxy, "listening");
  try {
    await waitForFile(paths.pid, "router pid file");
    const proxyUrl = `http://127.0.0.1:${fakeProxy.address().port}`;
    const proxiedEnv = {
      ...directEnv,
      NODE_OPTIONS: "--use-env-proxy",
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: "",
      no_proxy: "",
    };

    const status = await runCli(["status", "--port", String(port)], proxiedEnv);
    assert.equal(status.code, 0, `${status.stdout}\n${status.stderr}`);
    assert.match(status.stdout, /running/);

    const stopped = await runCli(["stop", "--port", String(port)], proxiedEnv);
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    const [routerCode] = await routerExited;
    assert.equal(routerCode, 0);
    assert.equal(proxyHits, 0);
  } finally {
    child.kill("SIGKILL");
    fakeProxy.closeAllConnections?.();
    await new Promise((resolve) => fakeProxy.close(resolve));
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("stop preserves pid state written by a replacement instance", { timeout: 20_000 }, async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-stop-race-"));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const paths = prepareRouterHome(codexHome, port);
  const env = routerEnv(codexHome);
  const child = spawn(process.execPath, [CLI, "serve", "--port", String(port)], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const routerExited = once(child, "exit");
  let stopper;
  let heldSocket;
  try {
    await waitForFile(paths.pid, "old router pid file");
    const oldState = JSON.parse(readFileSync(paths.pid, "utf8"));

    // Keep one request active after server.close() releases the listening port,
    // creating the window in which a replacement can publish its own pid state.
    heldSocket = createConnection({ host: "127.0.0.1", port });
    await once(heldSocket, "connect");
    heldSocket.on("error", () => {});
    heldSocket.write([
      `POST /${oldState.routerToken}/v1/responses HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Content-Type: application/json",
      "Content-Length: 100",
      "Connection: keep-alive",
      "",
      "{",
    ].join("\r\n"));

    stopper = spawn(process.execPath, [CLI, "stop", "--port", String(port)], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stopperExited = once(stopper, "exit");
    await waitForPortToClose(port);

    const replacement = {
      ...oldState,
      pid: process.pid,
      instanceId: `${process.pid}-${Date.now()}-${"f".repeat(16)}`,
    };
    writeFileSync(paths.pid, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
    heldSocket.destroy();
    heldSocket = null;

    const [[routerCode], [stopCode]] = await Promise.all([routerExited, stopperExited]);
    assert.equal(routerCode, 0);
    assert.equal(stopCode, 0);
    assert.equal(existsSync(paths.pid), true);
    assert.deepEqual(JSON.parse(readFileSync(paths.pid, "utf8")), replacement);
  } finally {
    heldSocket?.destroy();
    child.kill("SIGKILL");
    stopper?.kill("SIGKILL");
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("graceful shutdown survives a managed environment rejecting pid-state deletion", { timeout: 20_000 }, async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-stop-delete-hook-"));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const paths = prepareRouterHome(codexHome, port);
  const hook = join(codexHome, "reject-unlink.cjs");
  writeFileSync(hook, [
    'const fs = require("node:fs");',
    'const original = fs.unlinkSync;',
    'fs.unlinkSync = function(path) {',
    '  if (String(path).includes("server.pid.remove-")) {',
    '    const error = new Error("managed delete rejected");',
    '    error.code = "EPERM";',
    '    throw error;',
    '  }',
    '  return original.apply(this, arguments);',
    '};',
    "",
  ].join("\n"));
  const env = {
    ...routerEnv(codexHome),
    NODE_OPTIONS: `--require=${hook}`,
  };
  const child = spawn(process.execPath, [CLI, "serve", "--port", String(port)], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = once(child, "exit");
  try {
    await waitForFile(paths.pid, "router pid file");
    const stopped = await runCli(["stop", "--port", String(port)], env);
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    const [code] = await exited;
    assert.equal(code, 0);
    assert.equal(existsSync(paths.pid), false);
    const leftovers = await import("node:fs").then(({ readdirSync }) => readdirSync(paths.stateDir));
    const claimed = leftovers.find((name) => name.startsWith("server.pid.remove-"));
    assert.ok(claimed);
    assert.equal(readFileSync(join(paths.stateDir, claimed), "utf8"), "");
    unlinkSync(join(paths.stateDir, claimed));
  } finally {
    child.kill("SIGKILL");
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("graceful shutdown survives a managed environment rejecting the pid-state claim", { timeout: 20_000 }, async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-stop-rename-hook-"));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const paths = prepareRouterHome(codexHome, port);
  const hook = join(codexHome, "reject-rename.cjs");
  writeFileSync(hook, [
    'const fs = require("node:fs");',
    'const original = fs.renameSync;',
    'fs.renameSync = function(source, destination) {',
    '  if (String(destination).includes("server.pid.remove-")) {',
    '    const error = new Error("managed rename rejected");',
    '    error.code = "EPERM";',
    '    throw error;',
    '  }',
    '  return original.apply(this, arguments);',
    '};',
    "",
  ].join("\n"));
  const env = {
    ...routerEnv(codexHome),
    NODE_OPTIONS: `--require=${hook}`,
  };
  const child = spawn(process.execPath, [CLI, "serve", "--port", String(port)], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = once(child, "exit");
  try {
    await waitForFile(paths.pid, "router pid file");
    const stopped = await runCli(["stop", "--port", String(port)], env);
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    const [code] = await exited;
    assert.equal(code, 0);
    assert.equal(existsSync(paths.pid), true);
    assert.equal(JSON.parse(readFileSync(paths.pid, "utf8")).pid, child.pid);
  } finally {
    child.kill("SIGKILL");
    rmSync(codexHome, { recursive: true, force: true });
  }
});
