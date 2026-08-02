import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const FIELD = "deepseek_api_key";
const ENCODING_FIELD = "key_encoding";
const DPAPI = "dpapi";
const PLAIN = "plain";

// Windows stores the key with DPAPI (CurrentUser scope) so other accounts and
// casual file reads (backups, copies) cannot recover the plaintext. The same
// user's router can still decrypt it at startup. Non-Windows keeps the
// plaintext file (mode 0600) exactly as before.
function dpapiProtect(plain) {
  const encoded = Buffer.from(plain, "utf8").toString("base64");
  const script = `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String('${encoded}'), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
}

function dpapiUnprotect(encoded) {
  const script = `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${encoded}'), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  const base64 = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
  return Buffer.from(base64, "base64").toString("utf8");
}

export function readStoredKey(keyFile) {
  if (!existsSync(keyFile)) return "";
  try {
    const parsed = JSON.parse(readFileSync(keyFile, "utf8"));
    const stored = typeof parsed?.[FIELD] === "string" ? parsed[FIELD].trim() : "";
    if (!stored) return "";
    // Legacy files written before key_encoding existed store the plaintext.
    return parsed?.[ENCODING_FIELD] === DPAPI ? dpapiUnprotect(stored) : stored;
  } catch {
    return "";
  }
}

export function writeStoredKey(keyFile, key) {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("Empty DeepSeek API key");
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  const encoding = process.platform === "win32" ? DPAPI : PLAIN;
  const stored = encoding === DPAPI ? dpapiProtect(trimmed) : trimmed;
  const temporary = `${keyFile}.dscodex-tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ [FIELD]: stored, [ENCODING_FIELD]: encoding }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, keyFile);
}

export function deleteStoredKey(keyFile) {
  if (existsSync(keyFile)) unlinkSync(keyFile);
}
