import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  authenticateSupervisorOwner,
  readSupervisorState,
  removeSupervisorState,
  requestSupervisorStop,
  superviseRouter,
  supervisorStatePath,
} from "../src/supervisor.mjs";

const SUPERVISOR_MODULE = fileURLToPath(new URL("../src/supervisor.mjs", import.meta.url));
const mutableFs = createRequire(import.meta.url)("node:fs");

const FIXTURE_SOURCE = [
  'import { readFileSync, writeFileSync } from "node:fs";',
  'const attemptsPath = process.env.DSCODEX_TEST_SUPERVISOR_STATE;',
  'let attempts = 0;',
  'try { attempts = Number(readFileSync(attemptsPath, "utf8")) || 0; } catch {}',
  'attempts += 1;',
  'writeFileSync(attemptsPath, String(attempts));',
  'const failures = Number(process.env.DSCODEX_TEST_SUPERVISOR_FAILURES ?? 0);',
  'process.exit(attempts <= failures ? 23 : 0);',
  '',
].join("\n");

async function waitFor(check, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (check()) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${message}`, { cause: lastError });
}

function safeSupervisorState(logPath) {
  try {
    return readSupervisorState(logPath);
  } catch {
    return null;
  }
}

function supervisorOptions({ fixturePath, attemptsPath, logPath, failures, restartDelayMs }) {
  return {
    nodePath: process.execPath,
    cliPath: fixturePath,
    port: 10110,
    logPath,
    restartDelayMs,
    env: {
      ...process.env,
      DSCODEX_TEST_SUPERVISOR_STATE: attemptsPath,
      DSCODEX_TEST_SUPERVISOR_FAILURES: String(failures),
      DSCODEX_PROXY_REEXEC: "1",
    },
  };
}

function staleIdentity(pid = process.pid) {
  return {
    pid,
    instanceId: `${pid}-${Math.max(1, Date.now() - 60_000)}-0123456789abcdef`,
    stopToken: "A".repeat(43),
  };
}

function removeTestTree(path) {
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) removeTestTree(child);
    else unlinkSync(child);
  }
  rmdirSync(path);
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`Timed out terminating test helper PID ${child.pid}`)),
      3_000,
    )),
  ]);
}

async function settleAfterStop(logPath, promises) {
  const state = safeSupervisorState(logPath);
  if (state) {
    try { requestSupervisorStop(logPath, state); } catch {}
  }
  await Promise.race([
    Promise.allSettled(promises.filter(Boolean)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

test("a reused live PID without an owner response is stale and cannot suppress startup", {
  timeout: 10_000,
}, async () => {
  const temp = mkdtempSync(join(tmpdir(), "dscodex-supervisor-reused-pid-"));
  const fixturePath = join(temp, "router-fixture.mjs");
  const attemptsPath = join(temp, "attempts.txt");
  const logPath = join(temp, "server.log");
  try {
    writeFileSync(fixturePath, FIXTURE_SOURCE);
    const stale = staleIdentity();
    writeFileSync(supervisorStatePath(logPath), `${JSON.stringify(stale)}\n`);
    const oldRequestPath = requestSupervisorStop(logPath, stale);
    assert.equal(await authenticateSupervisorOwner(logPath, stale, {
      livenessTimeoutMs: 50,
      pollIntervalMs: 5,
    }), false);

    await superviseRouter(supervisorOptions({
      fixturePath,
      attemptsPath,
      logPath,
      failures: 0,
      restartDelayMs: 10,
    }));

    assert.equal(readFileSync(attemptsPath, "utf8"), "1");
    assert.equal(readSupervisorState(logPath), null);
    assert.doesNotMatch(readFileSync(logPath, "utf8"), /another supervisor already owns/);
    if (existsSync(oldRequestPath)) {
      const oldRequest = JSON.parse(readFileSync(oldRequestPath, "utf8"));
      assert.equal(oldRequest.instanceId, stale.instanceId);
      assert.equal(oldRequest.stopToken, stale.stopToken);
    }
  } finally {
    removeTestTree(temp);
  }
});

for (const hardLinkError of ["EPERM", "ENOTSUP"]) {
  test(`supervisor remains mutually exclusive and replacement-safe when linkSync throws ${hardLinkError}`, {
    timeout: 15_000,
  }, async () => {
    const temp = mkdtempSync(join(tmpdir(), `dscodex-supervisor-no-link-${hardLinkError.toLowerCase()}-`));
    const fixturePath = join(temp, "router-fixture.mjs");
    const attemptsPath = join(temp, "attempts.txt");
    const logPath = join(temp, "server.log");
    const originalLinkSync = mutableFs.linkSync;
    const promises = [];
    try {
      writeFileSync(fixturePath, FIXTURE_SOURCE);
      mutableFs.linkSync = () => {
        const error = new Error(`hard links unavailable in test (${hardLinkError})`);
        error.code = hardLinkError;
        throw error;
      };
      syncBuiltinESMExports();

      const options = supervisorOptions({
        fixturePath,
        attemptsPath,
        logPath,
        failures: 100,
        restartDelayMs: 10_000,
      });
      const ownerPromise = superviseRouter(options);
      promises.push(ownerPromise);
      const contenderPromise = superviseRouter(options);
      promises.push(contenderPromise);

      await contenderPromise;
      await waitFor(
        () => safeSupervisorState(logPath) !== null
          && existsSync(attemptsPath)
          && readFileSync(attemptsPath, "utf8") === "1",
        "one supervisor to launch exactly one child",
      );
      const firstOwner = readSupervisorState(logPath);
      assert.equal(await authenticateSupervisorOwner(logPath, firstOwner, {
        livenessTimeoutMs: 1_000,
        pollIntervalMs: 5,
      }), true);
      const samePidImpostor = staleIdentity(firstOwner.pid);
      assert.equal(await authenticateSupervisorOwner(logPath, samePidImpostor, {
        livenessTimeoutMs: 50,
        pollIntervalMs: 5,
      }), false);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(readFileSync(attemptsPath, "utf8"), "1");
      assert.deepEqual(readSupervisorState(logPath), firstOwner);

      requestSupervisorStop(logPath, firstOwner);
      await ownerPromise;
      assert.equal(readSupervisorState(logPath), null);

      const replacementPromise = superviseRouter(options);
      promises.push(replacementPromise);
      await waitFor(
        () => safeSupervisorState(logPath)?.instanceId !== undefined
          && safeSupervisorState(logPath)?.instanceId !== firstOwner.instanceId,
        "replacement supervisor identity",
      );
      const replacement = readSupervisorState(logPath);

      // Model a delayed finally block from the old owner after a replacement
      // has published. Cleanup is allowed to remove only its exact generation.
      removeSupervisorState(logPath, firstOwner);
      assert.deepEqual(readSupervisorState(logPath), replacement);

      requestSupervisorStop(logPath, replacement);
      await replacementPromise;
      assert.equal(readSupervisorState(logPath), null);
    } finally {
      mutableFs.linkSync = originalLinkSync;
      syncBuiltinESMExports();
      await settleAfterStop(logPath, promises);
      removeTestTree(temp);
    }
  });
}

test("a crashed supervisor's state and authenticated request cannot poison its replacement", {
  timeout: 15_000,
}, async () => {
  const temp = mkdtempSync(join(tmpdir(), "dscodex-supervisor-crash-recovery-"));
  const fixturePath = join(temp, "router-fixture.mjs");
  const helperPath = join(temp, "supervisor-helper.mjs");
  const attemptsPath = join(temp, "attempts.txt");
  const logPath = join(temp, "server.log");
  let helper;
  try {
    writeFileSync(fixturePath, FIXTURE_SOURCE);
    const helperOptions = supervisorOptions({
      fixturePath,
      attemptsPath,
      logPath,
      failures: 1,
      restartDelayMs: 30_000,
    });
    writeFileSync(helperPath, [
      `import { superviseRouter } from ${JSON.stringify(pathToFileURL(SUPERVISOR_MODULE).href)};`,
      `await superviseRouter(${JSON.stringify(helperOptions)});`,
      "",
    ].join("\n"));

    helper = spawn(process.execPath, [helperPath], {
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    });
    await waitFor(
      () => safeSupervisorState(logPath)?.pid === helper.pid
        && existsSync(logPath)
        && /restarting in 30000ms/.test(readFileSync(logPath, "utf8")),
      "the helper supervisor to own state and enter restart backoff",
    );
    const crashedOwner = readSupervisorState(logPath);
    assert.equal(readFileSync(attemptsPath, "utf8"), "1");

    await terminate(helper);
    helper = undefined;
    const staleRequestPath = requestSupervisorStop(logPath, crashedOwner);

    await superviseRouter(supervisorOptions({
      fixturePath,
      attemptsPath,
      logPath,
      failures: 1,
      restartDelayMs: 10,
    }));

    assert.equal(readFileSync(attemptsPath, "utf8"), "2");
    assert.equal(readSupervisorState(logPath), null);
    if (existsSync(staleRequestPath)) {
      const staleRequest = JSON.parse(readFileSync(staleRequestPath, "utf8"));
      assert.equal(staleRequest.instanceId, crashedOwner.instanceId);
      assert.equal(staleRequest.stopToken, crashedOwner.stopToken);
    }
  } finally {
    await terminate(helper);
    removeTestTree(temp);
  }
});
