import assert from "node:assert/strict";
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  authenticateSupervisorOwner,
  readSupervisorState,
  removeSupervisorState,
  requestSupervisorStop,
  superviseRouter,
  supervisorControlPath,
  supervisorStatePath,
} from "../src/supervisor.mjs";

const FIXTURE_SOURCE = [
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

const LONG_RUNNING_FIXTURE_SOURCE = [
  'import { writeFileSync } from "node:fs";',
  'writeFileSync(process.env.DSCODEX_TEST_SUPERVISOR_STATE, "running");',
  'setInterval(() => {}, 1_000);',
  '',
].join("\n");

const DELAYED_EXIT_FIXTURE_SOURCE = [
  'import { writeFileSync } from "node:fs";',
  'writeFileSync(process.env.DSCODEX_TEST_SUPERVISOR_STATE, "running");',
  'setTimeout(() => process.exit(0), 400);',
  '',
].join("\n");

function fakeSupervisorState(pid = process.pid) {
  return {
    pid,
    instanceId: `${pid}-${Date.now()}-${randomBytes(8).toString("hex")}`,
    stopToken: randomBytes(32).toString("base64url"),
  };
}

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

test("supervisor logs stderr, restarts nonzero exits, and stops on exit zero", async () => {
  const temp = mkdtempSync(join(tmpdir(), "dscodex-supervisor-"));
  const fixturePath = join(temp, "supervisor-child.mjs");
  const statePath = join(temp, "attempts.txt");
  const logPath = join(temp, "server.log");
  try {
    writeFileSync(fixturePath, FIXTURE_SOURCE);
    await superviseRouter({
      nodePath: process.execPath,
      cliPath: fixturePath,
      port: 10110,
      logPath,
      restartDelayMs: 10,
      env: {
        ...process.env,
        DSCODEX_TEST_SUPERVISOR_STATE: statePath,
        DSCODEX_TEST_SUPERVISOR_FAILURES: "2",
        DSCODEX_PROXY_REEXEC: "1",
      },
    });

    assert.equal(readFileSync(statePath, "utf8"), "3");
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /fixture stderr attempt 1/);
    assert.match(log, /router exited with code 23; restarting/);
    assert.match(log, /router exited cleanly; staying stopped/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("authenticated stop cancels a supervisor while it is waiting to restart", async () => {
  const temp = mkdtempSync(join(tmpdir(), "dscodex-supervisor-stop-"));
  const fixturePath = join(temp, "supervisor-child.mjs");
  const statePath = join(temp, "attempts.txt");
  const logPath = join(temp, "server.log");
  try {
    writeFileSync(fixturePath, FIXTURE_SOURCE);
    const supervised = superviseRouter({
      nodePath: process.execPath,
      cliPath: fixturePath,
      port: 10110,
      logPath,
      restartDelayMs: 500,
      env: {
        ...process.env,
        DSCODEX_TEST_SUPERVISOR_STATE: statePath,
        DSCODEX_TEST_SUPERVISOR_FAILURES: "100",
        DSCODEX_PROXY_REEXEC: "1",
      },
    });

    await waitFor(
      () => existsSync(logPath) && /restarting in 500ms/.test(readFileSync(logPath, "utf8")),
      "supervisor restart delay",
    );
    const state = readSupervisorState(logPath);
    assert.ok(state);
    const requestPath = requestSupervisorStop(logPath, state);
    await supervised;
    await new Promise((resolve) => setTimeout(resolve, 550));

    assert.equal(readFileSync(statePath, "utf8"), "1");
    assert.equal(existsSync(supervisorStatePath(logPath)), false);
    assert.equal(existsSync(requestPath), false);
    assert.equal(readdirSync(temp).some((name) => name.startsWith("supervisor.pid.stop-")), false);
    assert.match(readFileSync(logPath, "utf8"), /authenticated stop requested during restart delay/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("a concurrent supervisor cannot replace the live supervisor identity", async () => {
  const temp = mkdtempSync(join(tmpdir(), "dscodex-supervisor-owner-"));
  const fixturePath = join(temp, "supervisor-child.mjs");
  const statePath = join(temp, "attempts.txt");
  const logPath = join(temp, "server.log");
  const options = {
    nodePath: process.execPath,
    cliPath: fixturePath,
    port: 10110,
    logPath,
    restartDelayMs: 500,
    env: {
      ...process.env,
      DSCODEX_TEST_SUPERVISOR_STATE: statePath,
      DSCODEX_TEST_SUPERVISOR_FAILURES: "100",
      DSCODEX_PROXY_REEXEC: "1",
    },
  };
  try {
    writeFileSync(fixturePath, FIXTURE_SOURCE);
    const first = superviseRouter(options);
    await waitFor(() => readSupervisorState(logPath) !== null, "first supervisor state");
    const owner = readSupervisorState(logPath);

    await superviseRouter(options);
    assert.deepEqual(readSupervisorState(logPath), owner);

    requestSupervisorStop(logPath, owner);
    await first;
    assert.match(readFileSync(logPath, "utf8"), /another supervisor already owns this router/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("a stale authenticated state is reclaimed even when its PID belongs to a live process", async () => {
  const temp = mkdtempSync(join(tmpdir(), "dscodex-supervisor-recycled-pid-"));
  const fixturePath = join(temp, "supervisor-child.mjs");
  const attemptsPath = join(temp, "attempts.txt");
  const logPath = join(temp, "server.log");
  const stale = fakeSupervisorState(process.pid);
  try {
    writeFileSync(fixturePath, FIXTURE_SOURCE);
    writeFileSync(supervisorStatePath(logPath), `${JSON.stringify(stale)}\n`);
    mkdirSync(supervisorControlPath(logPath));
    writeFileSync(
      join(supervisorControlPath(logPath), "owner.json"),
      `${JSON.stringify(stale)}\n`,
    );
    const staleStopPath = requestSupervisorStop(logPath, stale);

    assert.equal(await authenticateSupervisorOwner(logPath, stale, {
      livenessTimeoutMs: 30,
      pollIntervalMs: 5,
    }), false);

    const options = {
      nodePath: process.execPath,
      cliPath: fixturePath,
      port: 10110,
      logPath,
      restartDelayMs: 10,
      livenessTimeoutMs: 30,
      pollIntervalMs: 5,
      env: {
        ...process.env,
        DSCODEX_TEST_SUPERVISOR_STATE: attemptsPath,
        DSCODEX_TEST_SUPERVISOR_FAILURES: "0",
      },
    };
    await superviseRouter(options);

    assert.equal(readFileSync(attemptsPath, "utf8"), "1");
    assert.equal(existsSync(staleStopPath), true);
    assert.equal(existsSync(supervisorStatePath(logPath)), false);
    assert.equal(existsSync(supervisorControlPath(logPath)), true);
    assert.doesNotMatch(readFileSync(logPath, "utf8"), /another supervisor already owns/);

    // Normal cleanup deliberately leaves a stale generation instead of racing
    // to rename a possible replacement. The next launch authenticates, safely
    // reclaims it, and starts normally.
    await superviseRouter(options);
    assert.equal(readFileSync(attemptsPath, "utf8"), "2");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("supervisor ownership does not require filesystem hard-link support", async () => {
  const temp = mkdtempSync(join(tmpdir(), "dscodex-supervisor-no-hardlinks-"));
  const fixturePath = join(temp, "supervisor-child.mjs");
  const attemptsPath = join(temp, "attempts.txt");
  const logPath = join(temp, "server.log");
  const originalLinkSync = fs.linkSync;
  let first = null;
  let owner = null;
  try {
    fs.linkSync = () => {
      const error = new Error("hard links are unavailable on this filesystem");
      error.code = "ENOTSUP";
      throw error;
    };
    syncBuiltinESMExports();
    writeFileSync(fixturePath, FIXTURE_SOURCE);
    const options = {
      nodePath: process.execPath,
      cliPath: fixturePath,
      port: 10110,
      logPath,
      restartDelayMs: 500,
      livenessTimeoutMs: 150,
      pollIntervalMs: 5,
      env: {
        ...process.env,
        DSCODEX_TEST_SUPERVISOR_STATE: attemptsPath,
        DSCODEX_TEST_SUPERVISOR_FAILURES: "100",
      },
    };

    first = superviseRouter(options);
    await waitFor(
      () => existsSync(logPath) && /restarting in 500ms/.test(readFileSync(logPath, "utf8")),
      "supervisor without hard links",
    );
    owner = readSupervisorState(logPath);
    assert.equal(await authenticateSupervisorOwner(logPath, owner, {
      livenessTimeoutMs: 150,
      pollIntervalMs: 5,
    }), true);

    await superviseRouter(options);
    assert.deepEqual(readSupervisorState(logPath), owner);
    requestSupervisorStop(logPath, owner);
    await first;
    first = null;

    assert.equal(readFileSync(attemptsPath, "utf8"), "1");
    assert.equal(existsSync(supervisorControlPath(logPath)), true);
  } finally {
    if (first && owner) {
      try { requestSupervisorStop(logPath, owner); } catch {}
      await first.catch(() => {});
    }
    fs.linkSync = originalLinkSync;
    syncBuiltinESMExports();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("a fenced supervisor cannot remove replacement state during cleanup", async () => {
  const temp = mkdtempSync(join(tmpdir(), "dscodex-supervisor-fenced-cleanup-"));
  const fixturePath = join(temp, "supervisor-child.mjs");
  const childStatePath = join(temp, "child-state.txt");
  const logPath = join(temp, "server.log");
  const displacedControlPath = `${supervisorControlPath(logPath)}.displaced-for-test`;
  try {
    writeFileSync(fixturePath, LONG_RUNNING_FIXTURE_SOURCE);
    const supervised = superviseRouter({
      nodePath: process.execPath,
      cliPath: fixturePath,
      port: 10110,
      logPath,
      livenessTimeoutMs: 100,
      pollIntervalMs: 5,
      env: {
        ...process.env,
        DSCODEX_TEST_SUPERVISOR_STATE: childStatePath,
      },
    });
    await waitFor(() => existsSync(childStatePath), "long-running router child");
    const original = readSupervisorState(logPath);
    const replacement = fakeSupervisorState(process.pid);

    renameSync(supervisorControlPath(logPath), displacedControlPath);
    mkdirSync(supervisorControlPath(logPath));
    writeFileSync(
      join(supervisorControlPath(logPath), "owner.json"),
      `${JSON.stringify(replacement)}\n`,
    );
    writeFileSync(supervisorStatePath(logPath), `${JSON.stringify(replacement)}\n`);

    removeSupervisorState(logPath, original);
    assert.deepEqual(readSupervisorState(logPath), replacement);
    await supervised;

    assert.deepEqual(readSupervisorState(logPath), replacement);
    assert.deepEqual(
      JSON.parse(readFileSync(join(supervisorControlPath(logPath), "owner.json"), "utf8")),
      replacement,
    );
    assert.match(readFileSync(logPath, "utf8"), /ownership was replaced/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("a temporary control-directory displacement does not fence a restored owner", async () => {
  const temp = mkdtempSync(join(tmpdir(), "dscodex-supervisor-control-restore-"));
  const fixturePath = join(temp, "supervisor-child.mjs");
  const childStatePath = join(temp, "child-state.txt");
  const logPath = join(temp, "server.log");
  const displacedControlPath = `${supervisorControlPath(logPath)}.temporary-displacement`;
  try {
    writeFileSync(fixturePath, DELAYED_EXIT_FIXTURE_SOURCE);
    const supervised = superviseRouter({
      nodePath: process.execPath,
      cliPath: fixturePath,
      port: 10110,
      logPath,
      livenessTimeoutMs: 100,
      pollIntervalMs: 5,
      env: {
        ...process.env,
        DSCODEX_TEST_SUPERVISOR_STATE: childStatePath,
      },
    });
    await waitFor(() => existsSync(childStatePath), "delayed router child");

    renameSync(supervisorControlPath(logPath), displacedControlPath);
    await new Promise((resolve) => setTimeout(resolve, 20));
    renameSync(displacedControlPath, supervisorControlPath(logPath));
    await supervised;

    const log = readFileSync(logPath, "utf8");
    assert.match(log, /router exited cleanly; staying stopped/);
    assert.doesNotMatch(log, /ownership was replaced/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("a sustained control I/O failure fences the owned router child", async () => {
  const temp = mkdtempSync(join(tmpdir(), "dscodex-supervisor-control-io-failure-"));
  const fixturePath = join(temp, "supervisor-child.mjs");
  const childStatePath = join(temp, "child-state.txt");
  const logPath = join(temp, "server.log");
  const controlPath = supervisorControlPath(logPath);
  const originalReaddirSync = fs.readdirSync;
  try {
    writeFileSync(fixturePath, DELAYED_EXIT_FIXTURE_SOURCE);
    const supervised = superviseRouter({
      nodePath: process.execPath,
      cliPath: fixturePath,
      port: 10110,
      logPath,
      livenessTimeoutMs: 50,
      pollIntervalMs: 5,
      env: {
        ...process.env,
        DSCODEX_TEST_SUPERVISOR_STATE: childStatePath,
      },
    });
    await waitFor(() => existsSync(childStatePath), "router before control I/O failure");

    fs.readdirSync = (path, ...args) => {
      if (String(path) === controlPath) {
        const error = new Error("simulated sustained control I/O failure");
        error.code = "EACCES";
        throw error;
      }
      return originalReaddirSync(path, ...args);
    };
    syncBuiltinESMExports();
    await supervised;

    assert.match(readFileSync(logPath, "utf8"), /ownership was replaced; stopping owned router child/);
  } finally {
    fs.readdirSync = originalReaddirSync;
    syncBuiltinESMExports();
    rmSync(temp, { recursive: true, force: true });
  }
});
