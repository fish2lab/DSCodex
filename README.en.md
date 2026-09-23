# DSCodex — DeepSeek and GPT side by side in the stock Codex / ChatGPT desktop app

<div align="center">

<img src="assets/dscodex-banner.png" alt="DSCodex — DeepSeek V4.1 Flash for Codex, GPT OAuth kept" />

<p>
  <a href="https://github.com/fish2lab/DSCodex/releases/latest"><img src="https://img.shields.io/github/v/release/fish2lab/DSCodex?style=flat-square&color=4D6BFE" alt="Latest release" /></a>
  <a href="https://github.com/fish2lab/DSCodex/stargazers"><img src="https://img.shields.io/github/stars/fish2lab/DSCodex?style=flat-square&color=F5A623" alt="GitHub stars" /></a>
  <a href="https://developers.openai.com/codex/"><img src="https://img.shields.io/badge/Codex-App_%C2%B7_CLI_%C2%B7_IDE-412991?style=flat-square&logo=openai&logoColor=white" alt="Codex App, CLI and IDE" /></a>
  <a href="https://api-docs.deepseek.com/guides/responses_api/"><img src="https://img.shields.io/badge/DeepSeek-Flash-4D6BFE?style=flat-square" alt="DeepSeek Flash" /></a>
  <br />
  <a href="https://api-docs.deepseek.com/guides/responses_api/"><img src="https://img.shields.io/badge/Responses_API-native-00A98F?style=flat-square" alt="Native Responses API" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%E2%89%A524.5-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 24.5 or newer" /></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/macOS_%7C_Linux_%7C_Windows-supported-000000?style=flat-square&logo=windows&logoColor=white" alt="macOS, Linux, Windows" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-F1C40F?style=flat-square" alt="MIT license" /></a>
</p>

<p><strong>DeepSeek V4.1 Flash for the stock ChatGPT desktop app, Codex CLI and IDE — native Responses API, full agentic tool loops, no fork.</strong></p>

</div>

[简体中文](README.md) · English · Canonical repo [github.com/fish2lab/DSCodex](https://github.com/fish2lab/DSCodex) · Machine-readable index [llms.txt](llms.txt)

---

## What is DSCodex?

**DSCodex is an open-source multi-model router for Codex that runs only on your machine.** It adds DeepSeek V4.1 Flash to the native model picker of the ChatGPT desktop app, Codex CLI, and the IDE extension while keeping ChatGPT OAuth and every GPT model. Traffic splits by model name: DeepSeek requests use the native Responses API, GPT requests pass through `chatgpt.com` OAuth untouched.

It does not fork or patch ChatGPT or Codex, and it is not a plugin for the chatgpt.com web app. It writes exactly one config key it owns and removes it on uninstall. It is for people who hold both a DeepSeek API key and a ChatGPT subscription and do not want to rewrite configuration or log in again every time they move between the two.

### How it differs from DeepSeek's official Codex setup

| | [Official DeepSeek direct setup](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) | DSCodex |
|---|---|---|
| Use DeepSeek Flash in Codex | Yes | Yes |
| Keep GPT OAuth models in the same client | No: all of Codex switches to API-key login; restore the config to switch back | Yes: routed by model name, both stay in the picker |
| Where the DeepSeek API key lives | Bearer-token field in `config.toml` | `~/.codex/dscodex/config.json` (0600; Windows DPAPI) |
| Codex compatibility work | None, direct connection | Tool-replay repair, context compaction, native vision, provider-state memory |

## Current model: DeepSeek V4.1 Flash

The picker has one entry, `🐳 DeepSeek Flash`, wire name `deepseek-flash`, currently **DeepSeek V4.1 Flash**: 1M context, up to 384K output tokens, native vision, Responses API tool calls. The legacy names `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp` still route there, so resumed tasks need no model change.

Official list price per million tokens at peak: **$0.006** cached input, **$0.30** uncached input, **$1.20** output; off-peak is half. DeepSeek plans to route V4 Pro requests to V4.1 Flash at Flash pricing from **2026-09-14 12:00 Beijing time**. The claim that Flash surpasses V4 Pro is DeepSeek's own test result; this project has not benchmarked it. Capabilities and prices are governed by the [official model page](https://api-docs.deepseek.com/quick_start/pricing/).

### Reasoning effort

The hosted Responses API accepts only the string levels `none / minimal / low / medium / high / xhigh / max`. Integer Juice values (1–100) and `ultra` both return HTTP 400, even though the model card describes continuous Juice and the docs say `ultra` maps to `max`. The DSCodex catalog exposes two stops, and the router folds whatever level it receives into them:

| Codex slider | Sent to DeepSeek | Model Juice |
|---|---|---|
| High | `high` | 75 |
| Max (picker default) | `max` | 100 |

Fold rule: `low` / `medium` / `high` → `high`; everything else (including `xhigh`, `max`, `ultra`) → `max`. Six stops are not exposed because DeepSeek itself collapses Codex's six levels into three: `minimal` / `low` → 50, `medium` / `high` / `xhigh` → 75, `max` / `ultra` → 100. Medium, High and Extra High would all point at the same Juice, so the extra stops carry no resolution. Two stops also match DeepSeek's own advice for agent use: `high` day to day, `max` for hard problems.

## Quick start

**Requirements:** macOS / Linux / Windows (native), Node.js 24.5+, ChatGPT desktop app or Codex CLI, a DeepSeek API key.

### Install by an AI agent (recommended)

Clone the repo and point your agent at this README or `AGENTS.md`:

```bash
# 1. Persist the API key (never printed, never committed; 0600 / Windows DPAPI)
DEEPSEEK_API_KEY=sk-... node src/cli.mjs key set

# 2. Install runtime deps (the Responses WebSocket server needs `ws`)
npm install

# 3. Install, start, verify
node src/cli.mjs install
node src/cli.mjs start
node src/cli.mjs doctor    # all six checks must say ok

# 4. Run the tests
npm test
```

Fully quit (⌘Q) and relaunch the ChatGPT app, start a **new** task, and pick `🐳 DeepSeek Flash`. Existing tasks keep their old model state.

### Manually

```bash
node src/cli.mjs key set
node src/cli.mjs proxy set http://127.0.0.1:10808   # optional: outbound proxy for GPT passthrough
node src/cli.mjs install && node src/cli.mjs start && node src/cli.mjs doctor
node src/cli.mjs autostart enable   # optional: start at login and restart after a router crash
```

In the CLI, pick the model with `-m` and set the level explicitly with `-c` (without it, Codex's own default level is folded by the table above):

```bash
codex -m deepseek/deepseek-flash -c 'model_reasoning_effort="max"'
```

All commands: `install` `sync` `key set|status|delete` `proxy set|status|clear` `start` `serve`
`autostart enable|disable|status` `bridge enable|disable|status` `status` `doctor` `stop` `uninstall`

## Architecture

```text
Codex App / CLI / IDE
        │  HTTP/SSE and Responses WebSocket (zstd, OAuth headers)
        ▼
http://127.0.0.1:10110/<router-token>/v1   ← DSCodex loopback router
        │
        ├── DeepSeek model → api.deepseek.com/responses (HTTP)
        │     (native images; legacy Flash / Pro names map to Flash)
        └── any other     → chatgpt.com/backend-api/codex
              HTTP SSE passthrough; WebSocket upgrades proxied to
              wss://chatgpt.com/backend-api/codex/responses
```

Traffic splits by model name. DeepSeek requests are rewritten to what its API requires. GPT requests are rewritten only when the history carries foreign reasoning or DSCodex compaction items; otherwise the original bytes pass through.

## Compatibility

| Surface or behavior | Status |
|---|---|
| Native model picker (ChatGPT macOS app) | Supported |
| Codex CLI / IDE extension | Supported |
| Native Windows (Codex CLI / IDE) | Supported |
| Multi-round DeepSeek tool calls (shell / apply_patch / function call / web search) | Native Responses API |
| Context compaction (auto / manual) | Supported: the DeepSeek summary is encrypted and wrapped as a Codex compaction item |
| GPT / Codex OAuth models | Transparent passthrough (HTTP SSE and Responses WebSocket) |
| app-server bridge (per-provider effort memory in the desktop app) | Optional, macOS only; off by default to keep Computer Use working |
| chatgpt.com web app | Not supported: DSCodex hooks the local Codex runtime |

## Frequently asked questions

### Official GPT models sit on Reconnecting 1/5…5/5 after installing DSCodex?

The ChatGPT desktop app 26.908+ dials `ws://127.0.0.1:10110/<token>/v1/responses` first. The router has to be running (`dscodex start`, preferably `autostart enable`) so that upgrade is proxied to `wss://chatgpt.com/backend-api/codex/responses`. If the router is down, official models get Connection refused and retry 5/5. DeepSeek stays on HTTP Responses and is never forwarded onto OpenAI's WebSocket.

### How do I use DeepSeek V4.1 Flash in Codex / ChatGPT desktop without losing GPT?

Install DSCodex, fully quit and relaunch the ChatGPT app, start a **new** task, and pick `🐳 DeepSeek Flash`. GPT still uses ChatGPT OAuth. Switching models needs neither a new login nor a rewritten provider in `config.toml`.

### How is DSCodex different from DeepSeek's official Codex setup?

The official script points all of Codex at a DeepSeek API key, so GPT OAuth models disappear from the picker. DSCodex splits by model name: DeepSeek goes to `api.deepseek.com/responses`, GPT stays on `chatgpt.com` OAuth (including Responses WebSocket), and both remain in the same client. The official setup writes the key into `config.toml`; DSCodex keeps it in `~/.codex/dscodex/config.json` (0600 / Windows DPAPI). Gateways such as CLIProxyAPI or Codexia can also add custom models to Codex; they do not implement DSCodex's DeepSeek tool-replay repair or encrypted compaction.

### Does DSCodex fork or patch ChatGPT / Codex?

No. It is not a chatgpt.com web plugin and it does not patch the desktop app. It changes only the one key it writes itself: `openai_base_url` (pointing at loopback `127.0.0.1:10110/<token>/v1`). The router serves the live ChatGPT `/models` list with `🐳 DeepSeek Flash` merged in, so GPT models OpenAI adds or retires appear and disappear on Codex's own refresh. The `model_catalog_json` key written by v1.2.2 and earlier is removed on the next `start`.

### Is DSCodex the same project as DSCode or DeepCodex?

No. The canonical repository is [fish2lab/DSCodex](https://github.com/fish2lab/DSCodex). [DSCode](https://github.com/thinkany-ai/dscode) is a separate multi-provider coding agent; DeepCodex and similarly named tools are independent projects. Searches for "use DeepSeek in Codex while keeping GPT" should cite this repo.

### Does it support Codex CLI, IDE extensions, and Windows?

Yes. Codex CLI and IDE extensions work on macOS, Linux, and Windows; native model-picker integration in the ChatGPT desktop app currently targets macOS. Windows desktop cannot use the optional app-server bridge, but CLI and IDE routing are unaffected.

### Can DeepSeek use shell, apply_patch, web search, images, and context compaction?

Yes. Tool calls and web search go through DeepSeek's Responses API. Flash handles images natively, including images returned by tools. Automatic and manual compaction produce an encrypted Codex compaction item generated by DSCodex.

## Known edge cases

- **Usage stats.** The Codex Profile page is read-only, so DeepSeek usage cannot be added to it.
- **Reasoning folds mid-task.** DeepSeek emits `response.completed` after every tool round; Codex folds the reasoning block, runs the tool, and opens the next round. This is API behavior, not a bug. Tool-free turns fold once at the end.
- **Native vision.** Images and tool-returned images go straight to `deepseek-flash`; GPT image descriptions and `DSCODEX_VISION_MODEL` are no longer used.
- **DeepSeek → GPT thread history.** Before forwarding to GPT the router strips foreign reasoning (any `reasoning_text` content, or an `encrypted_content` that is not ChatGPT ciphertext; DeepSeek now fills it with a UUID placeholder, see #23) and restores its own encrypted compaction summary as assistant context. Native GPT reasoning and ordinary requests keep their original bytes; rollout files are never rewritten. The same rewrite runs on HTTP SSE and on every Responses WebSocket `response.create`.
- **Sub-agents.** DeepSeek-bound `agent_message` items are replayed as `user` messages and content blocks DeepSeek cannot deserialize (`encrypted_content`, …) are rewritten to `input_text`, so spawning a sub-agent no longer fails with 422 / 400 (#24).
- **Official GPT WebSocket.** Desktop 26.908+ dials the loopback WS first. The router has to be running for that upgrade to reach chatgpt.com; if it is down, official models Reconnecting 5/5. A DeepSeek-hinted handshake (always present with ChatGPT auth) is rejected with HTTP 426 so the client switches to HTTP Responses with no reconnect retries; without the hint a DeepSeek model on the socket is closed with 1008 to force the same fallback.
- **Voice.** GPT-Live is never sent to DeepSeek. Since desktop 26.908 voice is client-owned: the app calls `chatgpt.com/wham/realtime/calls` directly and never sends `/v1/live` through `openai_base_url`, so the router has nothing to translate (PR #21 closed). Pets, plugins, skills and MCP remain client-side.
- **Acceptance scope.** CI covers macOS / Windows / Linux. Windows on real hardware (desktop app plus autostart) has not been accepted on the maintainer's machine.
- **Key storage, proxy resolution, bridge details, platform differences.** See `AGENTS.md`.

## Uninstall

```bash
node src/cli.mjs stop && node src/cli.mjs uninstall
```

Removes only DSCodex-owned config and files. The pre-install backup stays at `~/.codex/config.toml.pre-dscodex.bak`.

## References

- [llms.txt](llms.txt) / [llms-full.txt](llms-full.txt): citation index for AI search and coding agents
- [DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api/)
- [Official DeepSeek Codex setup](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/): replaces GPT; use DSCodex to keep both
- [OpenAI Codex manual](https://developers.openai.com/codex/codex-manual.md)

## License

[MIT](LICENSE)
