import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";

export const SUPERVISOR_RESTART_DELAY_MS = 2_000;
const SUPERVISOR_STATE_FILE = "supervisor.pid";
const SUPERVISOR_POLL_MS = 25;
const SUPERVISOR_LIVENESS_TIMEOUT_MS = 750;
const SUPERVISOR_CONTROL_SUFFIX = ".control";
const SUPERVISOR_OWNER_FILE = "owner.json";
const SUPERVISOR_CHALLENGE_PREFIX = "challenge-";
const SUPERVISOR_CLAIM_ATTEMPTS = 32;

function tokenValue(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function supervisorIdentity(value) {
  return Number.isInteger(value?.pid) && value.pid > 0
    && typeof value.instanceId === "string"
    && new RegExp(`^${value.pid}-\\d+-[0-9a-f]{16}$`).test(value.instanceId)
    && tokenValue(value.stopToken);
}

export function supervisorStatePath(logPath) {
  if (!logPath) throw new Error("Supervisor log path is required");
  return join(dirname(logPath), SUPERVISOR_STATE_FILE);
}

export function supervisorControlPath(logPath) {
  return `${supervisorStatePath(logPath)}${SUPERVISOR_CONTROL_SUFFIX}`;
}

function supervisorOwnerPath(logPath) {
  return join(supervisorControlPath(logPath), SUPERVISOR_OWNER_FILE);
}

function supervisorRequestPath(logPath, instanceId) {
  return `${supervisorStatePath(logPath)}.stop-${instanceId}`;
}

function atomicWrite(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function sameSupervisorIdentity(left, right) {
  return supervisorIdentity(left)
    && supervisorIdentity(right)
    && left.pid === right.pid
    && left.instanceId === right.instanceId
    && left.stopToken === right.stopToken;
}

function readSupervisorOwner(logPath) {
  const owner = readJson(supervisorOwnerPath(logPath));
  return supervisorIdentity(owner) ? owner : null;
}

function ownsSupervisorControl(logPath, state) {
  return sameSupervisorIdentity(readSupervisorOwner(logPath), state);
}

function ensureSupervisorStatePublished(logPath, state) {
  if (sameSupervisorIdentity(readJson(supervisorStatePath(logPath)), state)) return true;
  if (!ownsSupervisorControl(logPath, state)) return false;
  atomicWrite(supervisorStatePath(logPath), state);
  if (ownsSupervisorControl(logPath, state)) return true;

  // We were fenced during publication. Remove only the identity just written;
  // the replacement owner's pump will republish its own generation if needed.
  removeSupervisorState(logPath, state);
  return false;
}

function validateControlTimings(livenessTimeoutMs, pollIntervalMs) {
  if (!Number.isInteger(livenessTimeoutMs) || livenessTimeoutMs < 1) {
    throw new Error(`Invalid supervisor liveness timeout: ${livenessTimeoutMs}`);
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error(`Invalid supervisor poll interval: ${pollIntervalMs}`);
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function challengePath(logPath, nonce) {
  return join(supervisorControlPath(logPath), `${SUPERVISOR_CHALLENGE_PREFIX}${nonce}.json`);
}

function responsePath(logPath, nonce) {
  return `${challengePath(logPath, nonce)}.response`;
}

function livenessProof(state, nonce, issuedAt) {
  return createHmac("sha256", Buffer.from(state.stopToken, "base64url"))
    .update(`dscodex-supervisor-live\0${state.instanceId}\0${nonce}\0${issuedAt}`)
    .digest("base64url");
}

function proofMatches(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function readSupervisorState(logPath) {
  const path = supervisorStatePath(logPath);
  if (!existsSync(path)) return null;
  let state;
  try {
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Invalid DSCodex supervisor state at ${path}`);
  }
  if (!supervisorIdentity(state)) {
    throw new Error(`Untrusted DSCodex supervisor state at ${path}; refusing to control an unverified process`);
  }
  return state;
}

// The request is authenticated with a per-instance token and names the exact
// supervisor instance. It never sends a signal to a possibly recycled PID.
export function requestSupervisorStop(logPath, state) {
  if (!supervisorIdentity(state)) {
    throw new Error("Refusing to stop a supervisor without a trusted instance identity");
  }
  const path = supervisorRequestPath(logPath, state.instanceId);
  atomicWrite(path, { instanceId: state.instanceId, stopToken: state.stopToken });
  return path;
}

function stopRequested(logPath, state) {
  const path = supervisorRequestPath(logPath, state.instanceId);
  if (!existsSync(path)) return false;
  try {
    const request = JSON.parse(readFileSync(path, "utf8"));
    return request?.instanceId === state.instanceId && request?.stopToken === state.stopToken;
  } catch {
    return false;
  }
}

function removeMatchingFile(path, expected) {
  const before = readJson(path);
  if (!matchesExpected(before, expected)) return;
  const claimed = `${path}.remove-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    renameSync(path, claimed);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error?.code === "EPERM" || error?.code === "EACCES") return;
    throw error;
  }
  let current = null;
  let raw = null;
  try {
    raw = readFileSync(claimed, "utf8");
    current = JSON.parse(raw);
  } catch {
    // Restore invalid or replacement state below.
  }
  if (matchesExpected(current, expected)) {
    try {
      unlinkSync(claimed);
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
      try { writeFileSync(claimed, "", { mode: 0o600 }); } catch {}
    }
    return;
  }
  if (raw !== null) {
    try {
      // Reserving the pathname with `wx` never overwrites state published by a
      // replacement and works on filesystems which do not support hard links.
      writeFileSync(path, raw, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  try {
    unlinkSync(claimed);
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
    // The uniquely named displaced copy is harmless if Windows still has it open.
  }
}

function matchesExpected(current, expected) {
  return current?.instanceId === expected.instanceId
    && (expected.pid === undefined || current?.pid === expected.pid)
    && (expected.stopToken === undefined || current?.stopToken === expected.stopToken);
}

export function removeSupervisorState(logPath, expected) {
  if (!supervisorIdentity(expected)) {
    throw new Error("Refusing to remove supervisor state without a trusted instance identity");
  }
  removeMatchingFile(supervisorStatePath(logPath), expected);
}

function respondToSupervisorChallenges(logPath, state) {
  if (!ownsSupervisorControl(logPath, state)) return false;
  let names;
  try {
    names = readdirSync(supervisorControlPath(logPath));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  for (const name of names) {
    const match = /^challenge-([0-9a-f]{32})\.json$/.exec(name);
    if (!match) continue;
    const nonce = match[1];
    const request = readJson(challengePath(logPath, nonce));
    if (request?.instanceId !== state.instanceId
      || request?.nonce !== nonce
      || !Number.isSafeInteger(request?.issuedAt)) {
      continue;
    }
    const proof = livenessProof(state, nonce, request.issuedAt);
    const existing = readJson(responsePath(logPath, nonce));
    if (existing?.instanceId === state.instanceId
      && existing?.nonce === nonce
      && existing?.issuedAt === request.issuedAt
      && proofMatches(existing?.proof, proof)) {
      continue;
    }
    if (!ownsSupervisorControl(logPath, state)) return false;
    atomicWrite(responsePath(logPath, nonce), {
      instanceId: state.instanceId,
      nonce,
      issuedAt: request.issuedAt,
      proof,
    });
  }
  return ownsSupervisorControl(logPath, state);
}

async function challengeSupervisorOwner(logPath, target, {
  livenessTimeoutMs,
  pollIntervalMs,
}) {
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = Date.now();
  const requestPath = challengePath(logPath, nonce);
  const replyPath = responsePath(logPath, nonce);
  const expectedProof = livenessProof(target, nonce, issuedAt);
  try {
    atomicWrite(requestPath, { instanceId: target.instanceId, nonce, issuedAt });
  } catch (error) {
    if (error?.code === "ENOENT") return "changed";
    throw error;
  }

  const deadline = Date.now() + livenessTimeoutMs;
  try {
    while (true) {
      const current = readSupervisorOwner(logPath);
      if (!sameSupervisorIdentity(current, target)) return "changed";
      const response = readJson(replyPath);
      if (response?.instanceId === target.instanceId
        && response?.nonce === nonce
        && response?.issuedAt === issuedAt
        && proofMatches(response?.proof, expectedProof)) {
        return "live";
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "stale";
      await wait(Math.min(pollIntervalMs, remaining));
    }
  } finally {
    for (const path of [requestPath, replyPath]) {
      try {
        unlinkSync(path);
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "EPERM" && error?.code !== "EACCES") {
          throw error;
        }
      }
    }
  }
}

export async function authenticateSupervisorOwner(logPath, state, {
  livenessTimeoutMs = SUPERVISOR_LIVENESS_TIMEOUT_MS,
  pollIntervalMs = SUPERVISOR_POLL_MS,
} = {}) {
  if (!supervisorIdentity(state)) return false;
  validateControlTimings(livenessTimeoutMs, pollIntervalMs);
  const owner = readSupervisorOwner(logPath);
  if (!sameSupervisorIdentity(owner, state)) return false;
  return await challengeSupervisorOwner(logPath, owner, {
    livenessTimeoutMs,
    pollIntervalMs,
  }) === "live";
}

// Alias kept intentionally terse for CLI callers which only need a boolean
// replacement for PID-based liveness checks.
export const verifySupervisorOwner = authenticateSupervisorOwner;

function restoreDisplacedControl(logPath, quarantine) {
  const path = supervisorControlPath(logPath);
  try {
    // Renaming a directory over an already populated replacement directory is
    // rejected on supported platforms. Thus either this restores the displaced
    // generation, or the generation currently at `path` remains the singleton.
    renameSync(quarantine, path);
    return true;
  } catch (error) {
    const replacementExists = existsSync(path);
    if (replacementExists && ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error?.code)) {
      return false;
    }
    throw error;
  }
}

function quarantineSupervisorControl(logPath, state, expectedOwner) {
  const path = supervisorControlPath(logPath);
  const quarantine = `${path}.stale-${state.instanceId}-${randomBytes(8).toString("hex")}`;
  try {
    renameSync(path, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const displaced = readJson(join(quarantine, SUPERVISOR_OWNER_FILE));
  const expectedMatches = expectedOwner
    ? sameSupervisorIdentity(displaced, expectedOwner)
    : !supervisorIdentity(displaced);
  if (expectedMatches) return quarantine;

  // The owner changed between the pre-rename check and rename. Never delete
  // that replacement generation; restore it when the canonical path is free.
  // If a still newer generation already occupies the path, leaving this one in
  // quarantine fences it without disturbing the current singleton.
  restoreDisplacedControl(logPath, quarantine);
  return null;
}

function removeControlTree(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "EPERM" && error?.code !== "EACCES") {
      throw error;
    }
  }
}

function tryClaimSupervisorControl(logPath, state) {
  const controlPath = supervisorControlPath(logPath);
  try {
    mkdirSync(controlPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") return "occupied";
    throw error;
  }

  try {
    writeFileSync(supervisorOwnerPath(logPath), `${JSON.stringify(state)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    if (!ownsSupervisorControl(logPath, state)) return "retry";
    atomicWrite(supervisorStatePath(logPath), state);
    if (!ownsSupervisorControl(logPath, state)) {
      removeSupervisorState(logPath, state);
      return "retry";
    }
    return "acquired";
  } catch (error) {
    // Leave a partially initialized generation in place. A later claimant will
    // give it the normal liveness grace period and reclaim it safely; cleanup
    // here would race with a replacement generation at the fixed path.
    throw error;
  }
}

async function acquireSupervisorState(logPath, state, timings) {
  for (let attempt = 0; attempt < SUPERVISOR_CLAIM_ATTEMPTS; attempt += 1) {
    const claim = tryClaimSupervisorControl(logPath, state);
    if (claim === "acquired") return true;
    if (claim === "retry") continue;

    const observed = readSupervisorOwner(logPath);
    if (observed) {
      const result = await challengeSupervisorOwner(logPath, observed, timings);
      if (result === "live") return false;
      if (result === "changed") continue;
      const latest = readSupervisorOwner(logPath);
      if (!sameSupervisorIdentity(latest, observed)) continue;
    } else {
      // An owner may have crashed between mkdir and publishing owner.json. Give
      // an initializing process the same grace period as an established owner.
      await wait(timings.livenessTimeoutMs);
      if (readSupervisorOwner(logPath)) continue;
    }

    const quarantine = quarantineSupervisorControl(logPath, state, observed);
    if (!quarantine) continue;
    removeControlTree(quarantine);
  }
  throw new Error(`Could not claim DSCodex supervisor state at ${supervisorStatePath(logPath)}`);
}

function startSupervisorControlPump(
  logPath,
  state,
  pollIntervalMs,
  livenessTimeoutMs,
  onLost,
) {
  let stopped = false;
  let mismatchSince = null;
  const noteUnconfirmed = () => {
    if (mismatchSince === null) mismatchSince = Date.now();
    if (Date.now() - mismatchSince >= livenessTimeoutMs) onLost();
  };
  const service = () => {
    if (stopped) return;
    try {
      if (respondToSupervisorChallenges(logPath, state)
        && ensureSupervisorStatePublished(logPath, state)) {
        mismatchSince = null;
        return;
      }
      noteUnconfirmed();
    } catch {
      // A single transient error is tolerated. A sustained inability to prove
      // ownership must fence this instance, because a claimant can otherwise
      // take over while this process keeps its old router child alive.
      noteUnconfirmed();
    }
  };
  service();
  const timer = setInterval(service, pollIntervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

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

async function waitForRestart(milliseconds, shouldStop, pollIntervalMs = SUPERVISOR_POLL_MS) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (shouldStop()) return true;
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())),
    ));
  }
  return shouldStop();
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
  livenessTimeoutMs = SUPERVISOR_LIVENESS_TIMEOUT_MS,
  pollIntervalMs = SUPERVISOR_POLL_MS,
}) {
  if (!nodePath || !cliPath || !logPath) throw new Error("Supervisor paths are required");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
  if (!Number.isInteger(restartDelayMs) || restartDelayMs < 0) {
    throw new Error(`Invalid restart delay: ${restartDelayMs}`);
  }
  validateControlTimings(livenessTimeoutMs, pollIntervalMs);

  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const logFd = openSync(logPath, "a", 0o600);
  const state = {
    pid: process.pid,
    instanceId: `${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`,
    stopToken: randomBytes(32).toString("base64url"),
  };
  const childEnv = { ...env };
  // Every supervised launch is a fresh top-level serve. Let it resolve the
  // stored proxy and perform its own --use-env-proxy re-exec when required.
  delete childEnv.DSCODEX_PROXY_REEXEC;
  childEnv.DSCODEX_SUPERVISOR_INSTANCE_ID = state.instanceId;
  let ownsState = false;
  let ownershipLost = false;
  let resolveOwnershipLost;
  const ownershipLostPromise = new Promise((resolve) => {
    resolveOwnershipLost = resolve;
  });
  const markOwnershipLost = () => {
    if (ownershipLost) return;
    ownershipLost = true;
    resolveOwnershipLost();
  };
  let stopControlPump = () => {};

  try {
    ownsState = await acquireSupervisorState(logPath, state, {
      livenessTimeoutMs,
      pollIntervalMs,
    });
    if (!ownsState) {
      appendSupervisorLog(logFd, "another supervisor already owns this router; exiting");
      return;
    }
    stopControlPump = startSupervisorControlPump(
      logPath,
      state,
      pollIntervalMs,
      livenessTimeoutMs,
      markOwnershipLost,
    );
    appendSupervisorLog(logFd, `started (node ${process.version}, port ${port})`);
    while (true) {
      if (ownershipLost) {
        appendSupervisorLog(logFd, "supervisor ownership was replaced; exiting");
        return;
      }
      if (!ownsSupervisorControl(logPath, state)) {
        // A competing stale-owner cleanup can move then restore this directory.
        // Do not spawn while it is absent, and fence only after the control pump
        // has observed a continuous mismatch for the full liveness timeout.
        await Promise.race([ownershipLostPromise, wait(pollIntervalMs)]);
        continue;
      }
      if (stopRequested(logPath, state)) {
        appendSupervisorLog(logFd, "authenticated stop requested; staying stopped");
        return;
      }
      const child = spawn(nodePath, [cliPath, "serve", "--port", String(port)], {
        env: childEnv,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      });
      const exitPromise = childExit(child);
      const outcome = await Promise.race([
        exitPromise.then((result) => ({ kind: "exit", result })),
        ownershipLostPromise.then(() => ({ kind: "lost" })),
      ]);
      if (outcome.kind === "lost") {
        appendSupervisorLog(logFd, "supervisor ownership was replaced; stopping owned router child");
        // This is the ChildProcess handle returned by our own spawn, never a PID
        // recovered from disk, so a recycled or unverified PID is not signalled.
        try { child.kill(); } catch {}
        const exited = await Promise.race([
          exitPromise.then(() => true),
          wait(1_000).then(() => false),
        ]);
        if (!exited && child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch {}
          await Promise.race([exitPromise, wait(1_000)]);
        }
        return;
      }
      const { result } = outcome;
      if (!result.error && result.code === 0 && !result.signal) {
        appendSupervisorLog(logFd, "router exited cleanly; staying stopped");
        return;
      }

      if (stopRequested(logPath, state)) {
        appendSupervisorLog(logFd, "authenticated stop requested after router exit; staying stopped");
        return;
      }

      const detail = result.error
        ? `spawn failed: ${result.error.message}`
        : result.signal
          ? `router exited on ${result.signal}`
          : `router exited with code ${result.code}`;
      appendSupervisorLog(logFd, `${detail}; restarting in ${restartDelayMs}ms`);
      if (await waitForRestart(
        restartDelayMs,
        () => ownershipLost || stopRequested(logPath, state),
        pollIntervalMs,
      )) {
        if (ownershipLost) {
          appendSupervisorLog(logFd, "supervisor ownership was replaced during restart delay; exiting");
          return;
        }
        appendSupervisorLog(logFd, "authenticated stop requested during restart delay; staying stopped");
        return;
      }
    }
  } finally {
    stopControlPump();
    try {
      if (ownsState && ownsSupervisorControl(logPath, state)) {
        removeMatchingFile(supervisorRequestPath(logPath, state.instanceId), {
          instanceId: state.instanceId,
          stopToken: state.stopToken,
        });
      }
      if (ownsState && ownsSupervisorControl(logPath, state)) {
        removeSupervisorState(logPath, state);
      }
    } finally {
      closeSync(logFd);
    }
  }
}
