import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { superviseRouter } from "../src/supervisor.mjs";

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
