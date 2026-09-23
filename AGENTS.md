# DSCodex install instructions for coding agents

Canonical repository: https://github.com/fish2lab/DSCodex (not DSCode, not DeepCodex).
This repository adds DeepSeek V4.1 Flash to the stock ChatGPT / Codex app through a loopback router.
If a user asks you to install it, follow the "Install by an AI agent" section in `README.md` (中文版：「交给 AI Agent 安装」).
The non-negotiable details:

## Install and verify

1. Never print or commit the DeepSeek API key. Persist it with `node src/cli.mjs key set`
   (`DEEPSEEK_API_KEY` env or the hidden prompt). It is stored at `~/.codex/dscodex/config.json`
   with mode 0600 (DPAPI-encrypted on Windows) and survives logout and reboot. Resolution order at
   runtime: `DEEPSEEK_API_KEY` env (one-off override), then the stored file, then the legacy macOS
   login-session value. Never store the key in `~/.codex/config.toml`. `uninstall` deletes the
   stored key file.
2. Run `npm install` in the checkout (the router needs the `ws` package), then
   `node src/cli.mjs install`, then `node src/cli.mjs start`, then `node src/cli.mjs doctor`.
   Doctor must report `ok` for all six checks: config, catalog, router token, proxy, key, and the
   app-server bridge state. `key set` / `install` / `stop` / `doctor` do not load `ws`; only
   `start` / `serve` do.
3. Run `npm test`; every test must pass (Windows-native tests are skipped on other platforms).
4. The ChatGPT desktop app must be fully quit (`⌘Q`) and relaunched, and the user must start a NEW
   task to see `🐳 DeepSeek Flash`. Existing tasks keep their old model state.
5. Verify Flash with a real tool loop:
   `codex -m deepseek/deepseek-flash -c 'model_reasoning_effort="max"' -a never exec --skip-git-repo-check 'call a shell tool exactly once …'`.
   The legacy identifiers `deepseek-v4-flash`, `deepseek-v4-pro`, and `deepseek-v4-flash-vision-exp`
   must keep routing to `deepseek-flash` so resumed tasks still work.
6. Do not edit `~/.codex/config.toml` by hand unless the user asks. The CLI owns exactly one
   marker-owned root key, `openai_base_url`. GUI-written `model` / `model_reasoning_effort` lines
   are user-owned and must be preserved. Codex rewrites the file and can drop the marker comment,
   so a root `openai_base_url` of the tokenized loopback form `http://127.0.0.1:<port>/<token>/v1`
   and a root `model_catalog_json` pointing at `dscodex-models.json` are DSCodex-owned by value;
   `start` re-marks them and `uninstall` removes them. Never write `model_catalog_json`: Codex reads
   a static catalog once at startup and never refreshes it, which froze the GPT list at install
   time and hid every model OpenAI shipped later. `start` removes the key left by v1.2.2 and earlier.
6a. `GET /models` forwards to `chatgpt.com/backend-api/codex/models` with the client's query string
   (`client_version` decides which models ChatGPT returns) and its forwarded OAuth headers, merges
   the DeepSeek entry, and keeps the upstream `etag`. Upstream 4xx pass through unchanged so Codex
   can refresh its login; network errors and 5xx serve the last good list from
   `~/.codex/dscodex-models.json`, which every successful fetch rewrites.

## Model, effort, and vision

7. The single catalog entry is `deepseek-flash` (DeepSeek V4.1 Flash) with native vision. Forward
   `input_image` parts in messages and in tool outputs directly to DeepSeek. The entry keeps
   `input_modalities = ["text", "image"]` so the desktop app may issue `view_image` calls. GPT
   image descriptions and `DSCODEX_VISION_MODEL` are not used by the router.
8. The hosted DeepSeek Responses API accepts only the string levels
   `none|minimal|low|medium|high|xhigh|max`; integer Juice values and `ultra` are rejected with
   HTTP 400. The catalog exposes exactly two stops, High (`high`) and Max (`max`, the default), and
   the router folds every incoming level: `low` / `medium` / `high` → `high`, anything else →
   `max`. Never forward a raw Codex level or an integer to DeepSeek.
9. Provider selection memory lives in `~/.codex/dscodex/model-selections.json`. OpenAI and DeepSeek
   have separate reasoning-effort slots; only OpenAI owns the saved service tier. The file also
   persists per-thread provider memory (bounded, last 500 threads) so resumed threads switch like
   live ones, and a `staleEffort` marker so a model-only config write never leaks the other
   provider's effort into a new session. On load, the bridge must reconcile its remembered active
   provider with the live `config.toml` model (the GUI keeps switching models while the bridge is
   off) and adopt that config's effort / tier into the matching slots; otherwise the next
   cross-provider switch is misclassified as an in-provider effort change and the carried effort
   overwrites the family slot instead of restoring it. The wrapper must forward all other
   app-server JSONL RPC unchanged to the stock Codex binary.

## App-server bridge (macOS only, opt-in)

10. The bridge is opt-in (`node src/cli.mjs bridge enable`) because a global `CODEX_CLI_PATH`
    demotes the app from its local daemon websocket (which supports reconnect) to stdio and breaks
    Computer Use. `install` therefore never sets `CODEX_CLI_PATH` and actively removes
    DSCodex-owned copies left by older versions, including any value the Codex app snapshotted into
    `[mcp_servers.*.env]`. `bridge enable` must refuse a user-owned `CODEX_CLI_PATH`.
11. When enabled, `CODEX_CLI_PATH` must point at the generated shim
    `~/.codex/dscodex/codex-cli-bridge.sh`, never directly at `src/codex-wrapper.mjs`: GUI apps get
    a bare launchd PATH without Homebrew, so a `#!/usr/bin/env node` shebang fails there. The shim
    resolves node from PATH at runtime and only falls back to the absolute path baked at install
    time. The wrapper must resolve the stock Codex binary through the shared fallback chain
    (`src/real-codex.mjs`) instead of exiting when `DSCODEX_REAL_CODEX` is missing: launchctl login
    variables do not survive reboots, and a stale `CODEX_CLI_PATH` must degrade to stock Codex, not
    hard-fail every spawn.
12. Windows desktop apps spawn `CODEX_CLI_PATH` directly and cannot run a script shim
    (CreateProcess requires an `.exe`), so on Windows the bridge is unavailable and the `doctor`
    bridge check passes trivially.

## Router lifecycle, autostart, and proxy

13. Autostart is opt-in: `node src/cli.mjs autostart enable` (launchd `com.dscodex.router` on
    macOS, systemd user service `dscodex.service` on Linux, Task Scheduler `DSCodex` plus a hidden
    wscript shim on Windows). The generated plist / unit / VBS must never embed the DeepSeek API
    key; the router resolves it from the stored key file at runtime. KeepAlive / Restart cover
    crashes only: the Windows VBS must wait for a hidden supervisor that restarts nonzero router
    exits, with Task Scheduler restart settings as a second fallback. Registration must finish
    before replacing a healthy manual router, and a failed handoff must restore that router. `stop`
    uses the authenticated shutdown endpoint, the router exits 0 gracefully, and it must stay down.
    The `serve` process owns `~/.codex/dscodex/server.pid` no matter who launched it, so `stop`
    works for autostarted instances too. `uninstall` must disable autostart and delete the
    generated artifacts.
14. `install` generates a 256-bit router token and writes it into the managed `openai_base_url`.
    `start` / `serve` must reconcile that marker-owned URL with the persisted token and selected
    port, and `doctor` must verify the exact binding. The proxy must reject requests without that
    path token. `serve` owns a 0600 pid-state file with a per-instance shutdown token. `stop` may
    only use the authenticated shutdown endpoint and must atomically preserve replacement-instance
    state; it must never terminate an unverified or recycled PID. Cap both compressed and
    decompressed request bytes before parsing JSON.
15. The router must reach chatgpt.com for GPT passthrough. Node's fetch ignores proxy environment
    variables by default, so DSCodex resolves a proxy itself, in this order: `DSCODEX_HTTPS_PROXY` /
    `DSCODEX_HTTP_PROXY`, then the standard proxy variables (Node gives lowercase names
    precedence), then the stored `proxy_url` written by `node src/cli.mjs proxy set <url>` into
    `~/.codex/dscodex/config.json`. It then re-execs itself with Node's `--use-env-proxy` (requires
    Node >= 24.5); uppercase and lowercase proxy variables are synchronized, and `NO_PROXY` always
    includes loopback plus `api.deepseek.com`. Proxy credentials are redacted in CLI output and
    DPAPI-protected on Windows. The proxy URL must never be confused with the DeepSeek key, which
    stays DPAPI / 0600-protected and is never printed or committed.

## Request rewriting

16. DeepSeek does not implement Codex remote compaction v2. For a DeepSeek-bound request containing
    `compaction_trigger`, the router must remove tools and the trigger, ask the same DeepSeek model
    for a compact handoff summary, and return exactly one synthetic `compaction` output item before
    `response.completed`. Encrypt the summary with AES-256-GCM using a key derived from the stable
    router token; on later DeepSeek requests, decrypt only DSCodex-prefixed compaction items and
    restore them as assistant summary context. A compaction item that cannot be decrypted
    (GPT-sealed after a provider switch, or a rotated token) must be dropped, never forwarded raw
    to DeepSeek. Never route compaction through GPT or store the summary as plaintext in the
    rollout file.
17. DeepSeek's Responses API is stricter than OpenAI's about replaying tool-call turns, and a
    rejected replay wedges the session permanently because the bad shape stays in the history.
    Every tool output must directly follow its call. Codex inserts PostToolUse hook context as a
    `developer` message that can land inside the pair, so the router re-pairs them for
    `function_call`, `custom_tool_call`, and `local_shell_call`; the repair must preserve the
    relative order of every other item and must leave a call whose output is missing where it is.
    Pair on `call_id`, never on `id`: Codex sends both, but `id` is a local UUID and only `call_id`
    carries the `call_…` value the API matches on. A turn must never replay more than one tool call
    behind a single `reasoning` item (DeepSeek reports a misleading "reasoning_text must be passed
    back"), so the catalog entry sets `supports_parallel_tool_calls = false` and the router forces
    `parallel_tool_calls: false`. Duplicating the turn's reasoning for extra calls is replay repair
    for already-wedged sessions only, and must never copy reasoning across a turn boundary. A turn
    runs from its `reasoning` item through its calls and includes the assistant preamble message
    Codex emits in between (real rollouts show `reasoning` → `message(assistant)` → call, call);
    a tool output ends it.
18. Before GPT-bound requests, remove foreign reasoning items and preserve native encrypted GPT
    reasoning. Native GPT reasoning carries `summary` plus ChatGPT ciphertext (base64 beginning
    `gAAAAA`) and never a `content` array; DeepSeek reasoning carries `reasoning_text` content and
    a non-null UUID placeholder in `encrypted_content` (#23), so never decide on the emptiness of
    `encrypted_content`. A reasoning item is foreign when it has any `reasoning_text` content or a
    non-null `encrypted_content` that is not ChatGPT ciphertext. Decrypt DSCodex-prefixed
    compaction into assistant context; drop any compaction that is neither ChatGPT ciphertext nor
    decryptable DSCodex. Ordinary GPT requests remain byte-for-byte intact. A rewritten compressed
    request must lose its original content-encoding header. The same rewrite runs on HTTP and on
    every Responses WebSocket `response.create`.
    DeepSeek-bound messages must only carry `input_text` / `output_text` / `input_image` /
    `input_file` content blocks; DeepSeek returns 422 on any other block type. Rewrite unknown
    blocks that carry text (Codex ships inter-agent tasks as `encrypted_content` blocks) into
    `input_text` and drop blocks with no readable text. Replay `agent_message` items as `user`
    messages: as `assistant`, DeepSeek demands the turn's `reasoning_text` and every spawned
    sub-agent fails with 400 (#24). Strip `internal_chat_message_metadata_passthrough`.

## Platform and client boundaries

19. Routing, key storage, and model-list merging work identically on all platforms. Windows config
    lives under `%USERPROFILE%\.codex`; `0600` file permissions do not apply on NTFS, so DSCodex
    relies on the user account ACL there. Autostart uses the platform-native scheduler on all three
    OSes (launchd / systemd / Task Scheduler + VBS). The app-server bridge is macOS-only (see 10–12).
20. Pets, plugins, skills, and MCP remain client-side. Voice uses GPT-Live and must never route to
    DeepSeek. Since desktop 26.908 voice is client-owned: the app calls
    `chatgpt.com/wham/realtime/calls` from its own backend client and never sends `/v1/live` to
    `openai_base_url`, so the router has no voice path to translate (PR #21 closed). DeepSeek catalog
    entries keep `prefer_websockets = false`. Native GPT entries keep `prefer_websockets = true`.
    Authorized `/v1/responses` WebSocket upgrades are proxied to chatgpt.com. When the handshake
    carries a DeepSeek model in `x-codex-routing-hint` (ChatGPT-auth clients send
    `model=<slug>;tier=<tier>`), reject the upgrade with HTTP 426: the client maps that response to
    a direct HTTP fallback with no reconnect retries. When the hint is missing, a DeepSeek model on
    the accepted socket is still closed with 1008 to force the same fallback. Other upgrade probes
    still receive 426.
