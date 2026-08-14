import { homedir } from "node:os";
import { join, win32 } from "node:path";

export const LAUNCHD_LABEL = "com.dscodex.router";
export const SYSTEMD_UNIT = "dscodex.service";
export const WINDOWS_TASK = "DSCodex";
export const WINDOWS_RESTART_COUNT = 255;
export const WINDOWS_RESTART_INTERVAL_MINUTES = 1;

export function autostartKind(platform = process.platform) {
  if (platform === "darwin") return "launchd";
  if (platform === "win32") return "schtasks";
  return "systemd";
}

export function launchdPlistPath(home = homedir()) {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function systemdUnitPath(home = homedir()) {
  return join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// KeepAlive.SuccessfulExit=false: crashes are relaunched, but a graceful SIGTERM
// (`dscodex stop` exits 0) stays down — a manual stop must never be resurrected.
export function buildLaunchdPlist({ nodePath, cliPath, port, logPath }) {
  const args = [nodePath, cliPath, "serve", "--port", String(port)]
    .map((arg) => `    <string>${xml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

function systemdQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

// Restart=on-failure mirrors the launchd semantics above: the router exits 0 on
// SIGTERM, so only crashes are restarted.
export function buildSystemdUnit({ nodePath, cliPath, port, logPath }) {
  return `[Unit]
Description=DSCodex loopback router (DeepSeek V4 Flash and Pro for Codex)

[Service]
ExecStart=${systemdQuote(nodePath)} ${systemdQuote(cliPath)} serve --port ${port}
Restart=on-failure
RestartSec=2
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function vbsString(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function vbsPath(value, homeDir) {
  const path = String(value);
  const homePrefix = String(homeDir).replace(/[\\/]+$/, "");
  const lowerPath = path.toLowerCase();
  const lowerHome = homePrefix.toLowerCase();
  if (homePrefix && lowerPath === lowerHome) {
    return 'shell.ExpandEnvironmentStrings("%USERPROFILE%")';
  }
  if (homePrefix && (lowerPath.startsWith(`${lowerHome}\\`) || lowerPath.startsWith(`${lowerHome}/`))) {
    // wscript reads generated .vbs files through the active ANSI code page.
    // Keep non-ASCII user names out of the VBS source and resolve them at run time.
    return `shell.ExpandEnvironmentStrings("%USERPROFILE%") & ${vbsString(path.slice(homePrefix.length))}`;
  }
  return vbsString(path);
}

// The task runs wscript.exe on this shim so no console window flashes at logon.
// VBS waits for the Node supervisor and propagates its exit code. The supervisor
// owns log redirection and crash restarts; avoiding a Windows PowerShell pipeline
// is important because PowerShell 5 turns redirected native stderr into a
// terminating NativeCommandError when ErrorActionPreference is Stop.
export function buildWindowsVbs({ nodePath, cliPath, port, codexHome = homedir(), homeDir = homedir() }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  return [
    'Set shell = CreateObject("Wscript.Shell")',
    `nodePath = ${vbsPath(nodePath, homeDir)}`,
    `cliPath = ${vbsPath(cliPath, homeDir)}`,
    `codexHome = ${vbsPath(codexHome, homeDir)}`,
    'shell.Environment("Process")("CODEX_HOME") = codexHome',
    `command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & cliPath & Chr(34) & " supervise --port ${port}"`,
    'WScript.Quit shell.Run(command, 0, True)',
    "",
  ].join("\r\n");
}

export function encodeWindowsVbs(source) {
  // WSH reliably reads UTF-16LE scripts with a BOM. This covers repositories
  // and custom CODEX_HOME paths containing characters outside the ANSI codepage.
  return Buffer.from(`\uFEFF${source}`, "utf16le");
}

// Register through the ScheduledTasks PowerShell module instead of schtasks'
// CLI-only defaults. The explicit interactive principal scopes the logon
// trigger to the current user, needs no stored password, and allows a standard
// user to own the task. RestartOnFailure makes Windows match launchd/systemd.
export function buildWindowsRegisterScript({ taskName, vbsPath, windowsDir = process.env.SystemRoot ?? "C:\\Windows" }) {
  const wscript = win32.join(windowsDir, "System32", "wscript.exe");
  return [
    "$ErrorActionPreference='Stop'",
    `$action=New-ScheduledTaskAction -Execute ${psQuote(wscript)} -Argument ${psQuote(`"${vbsPath}"`)}`,
    "$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()",
    "$user=$identity.Name",
    "$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user",
    "$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited",
    `$settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount ${WINDOWS_RESTART_COUNT} -RestartInterval (New-TimeSpan -Minutes ${WINDOWS_RESTART_INTERVAL_MINUTES}) -StartWhenAvailable`,
    `Register-ScheduledTask -TaskName ${psQuote(taskName)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'DSCodex loopback router' -Force | Out-Null`,
  ].join("; ");
}
