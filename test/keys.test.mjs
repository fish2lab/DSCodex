import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { uninstall } from "../src/config.mjs";
import { pathsFor } from "../src/constants.mjs";
import { deleteStoredKey, readStoredKey, writeStoredKey } from "../src/keys.mjs";

test("stored key roundtrips with owner-only file permissions", () => {
  const keyFile = join(mkdtempSync(join(tmpdir(), "dscodex-key-")), "dscodex", "config.json");
  writeStoredKey(keyFile, "  sk-test-123  ");
  assert.equal(readStoredKey(keyFile), "sk-test-123");
  // Windows has no POSIX mode bits; the file is protected by the account ACL
  // (and, since the DPAPI change, the ciphertext itself).
  if (process.platform !== "win32") {
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  }
});

test("key file never stores the plaintext on Windows", () => {
  const keyFile = join(mkdtempSync(join(tmpdir(), "dscodex-key-")), "dscodex", "config.json");
  writeStoredKey(keyFile, "sk-test-123");
  const raw = readFileSync(keyFile, "utf8");
  if (process.platform === "win32") {
    assert.equal(raw.includes("sk-test-123"), false);
  } else {
    assert.ok(raw.includes("sk-test-123"));
  }
  assert.equal(readStoredKey(keyFile), "sk-test-123");
});

test("missing or corrupt key files resolve to empty", () => {
  const keyFile = join(mkdtempSync(join(tmpdir(), "dscodex-key-")), "config.json");
  assert.equal(readStoredKey(keyFile), "");
  writeFileSync(keyFile, "not json");
  assert.equal(readStoredKey(keyFile), "");
  writeFileSync(keyFile, JSON.stringify({ unrelated: true }));
  assert.equal(readStoredKey(keyFile), "");
});

test("writeStoredKey rejects an empty key", () => {
  const keyFile = join(mkdtempSync(join(tmpdir(), "dscodex-key-")), "config.json");
  assert.throws(() => writeStoredKey(keyFile, "   "), /Empty DeepSeek API key/);
  assert.equal(existsSync(keyFile), false);
});

test("deleteStoredKey removes the file and uninstall takes it too", () => {
  const paths = pathsFor(mkdtempSync(join(tmpdir(), "dscodex-test-")));
  writeStoredKey(paths.keyFile, "sk-x");
  deleteStoredKey(paths.keyFile);
  assert.equal(existsSync(paths.keyFile), false);

  writeStoredKey(paths.keyFile, "sk-x");
  uninstall({ paths });
  assert.equal(existsSync(paths.keyFile), false);
});
