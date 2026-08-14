import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";

export const SUPERVISOR_RESTART_DELAY_MS = 2_000;

function appendSupervisorLog(fd, message) {
  try {
    writeSync(fd, `${new Date().toISOString()} supervisor: ${message}\n`);
  } catch {
    // A logging failure must not take down the process that keeps the router alive.
  }
}

function childExit(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => finish({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => finish({ code, signal, error: null }));
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Windows Task Scheduler launches this long-lived process through a hidden VBS
// shim. Router stdout/stderr go straight to the log descriptor, so ordinary
// stderr output can never be mistaken for a supervisor failure. Exit 0 is the
// authenticated `dscodex stop` path and intentionally stops the loop; crashes
// and spawn failures are retried.
export async function superviseRouter({
  nodePath,
  cliPath,
  port,
  logPath,
  env = process.env,
  restartDelayMs = SUPERVISOR_RESTART_DELAY_MS,
}) {
  if (!nodePath || !cliPath || !logPath) throw new Error("Supervisor paths are required");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
  if (!Number.isInteger(restartDelayMs) || restartDelayMs < 0) {
    throw new Error(`Invalid restart delay: ${restartDelayMs}`);
  }

  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const logFd = openSync(logPath, "a", 0o600);
  const childEnv = { ...env };
  // Every supervised launch is a fresh top-level serve. Let it resolve the
  // stored proxy and perform its own --use-env-proxy re-exec when required.
  delete childEnv.DSCODEX_PROXY_REEXEC;

  try {
    appendSupervisorLog(logFd, `started (node ${process.version}, port ${port})`);
    while (true) {
      const child = spawn(nodePath, [cliPath, "serve", "--port", String(port)], {
        env: childEnv,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      });
      const result = await childExit(child);
      if (!result.error && result.code === 0 && !result.signal) {
        appendSupervisorLog(logFd, "router exited cleanly; staying stopped");
        return;
      }

      const detail = result.error
        ? `spawn failed: ${result.error.message}`
        : result.signal
          ? `router exited on ${result.signal}`
          : `router exited with code ${result.code}`;
      appendSupervisorLog(logFd, `${detail}; restarting in ${restartDelayMs}ms`);
      await wait(restartDelayMs);
    }
  } finally {
    closeSync(logFd);
  }
}
