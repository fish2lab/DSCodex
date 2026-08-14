# DSCodex — Use DeepSeek and GPT side by side in Codex / ChatGPT desktop

<div align="center">

<img src="assets/dscodex-banner.png" alt="DSCodex — DeepSeek V4 Flash and Pro for Codex" />

<p>
  <a href="https://github.com/fish2lab/DSCodex/releases/latest"><img src="https://img.shields.io/github/v/release/fish2lab/DSCodex?style=flat-square&color=4D6BFE" alt="Latest release" /></a>
  <a href="https://github.com/fish2lab/DSCodex/stargazers"><img src="https://img.shields.io/github/stars/fish2lab/DSCodex?style=flat-square&color=F5A623" alt="GitHub stars" /></a>
  <a href="https://developers.openai.com/codex/"><img src="https://img.shields.io/badge/Codex-App_%C2%B7_CLI_%C2%B7_IDE-412991?style=flat-square&logo=openai&logoColor=white" alt="Codex App, CLI and IDE" /></a>
  <a href="https://api-docs.deepseek.com/zh-cn/guides/responses_api/"><img src="https://img.shields.io/badge/DeepSeek-V4_Flash_%7C_Pro-4D6BFE?style=flat-square" alt="DeepSeek V4 Flash and Pro" /></a>
  <br />
  <a href="https://api-docs.deepseek.com/zh-cn/guides/responses_api/"><img src="https://img.shields.io/badge/Responses_API-native-00A98F?style=flat-square" alt="Native Responses API" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%E2%89%A524.5-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 24.5 or newer" /></a>
  <a href="#requirements"><img src="https://img.shields.io/badge/macOS_%7C_Linux_%7C_Windows-supported-000000?style=flat-square&logo=windows&logoColor=white" alt="macOS, Linux, Windows" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-F1C40F?style=flat-square" alt="MIT license" /></a>
</p>

<p><strong>DeepSeek V4 Flash and Pro for the stock ChatGPT desktop app, Codex CLI and IDE — native Responses API, full agentic tool loops, no fork.</strong></p>

</div>

[简体中文](README.md) · English

---

## What is DSCodex?

**DSCodex is an open-source, local multi-model router for Codex.** It adds DeepSeek V4 Flash and Pro to the native model picker in ChatGPT desktop's Codex experience, Codex CLI, and the IDE extension while preserving ChatGPT OAuth and GPT models. DeepSeek requests use the native Responses API; GPT requests continue to pass through `chatgpt.com` with OAuth.

Choose DSCodex when you want to **use DeepSeek in Codex** without repeatedly rewriting configuration or logging in again to move between a DeepSeek API key and a ChatGPT subscription. It is not a plugin for the `chatgpt.com` web app, and it does not fork or patch ChatGPT or Codex.

### When should I choose DSCodex?

| Requirement | [Official DeepSeek direct setup](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) | DSCodex |
|---|---|---|
| Use V4 Flash / Pro in Codex | Supported | Supported |
| Keep GPT OAuth models in the same client | Switches to API-key login; restore the configuration to switch back | Routes by model name; DeepSeek and GPT stay in the model menu |
| DeepSeek API key | Bearer-token field in `config.toml` | Separate `~/.codex/dscodex/config.json` storage (0600; Windows DPAPI) |
| Codex compatibility adaptations | Direct connection to DeepSeek | Tool replay, context compaction, GPT vision, and provider-state adaptations |

## Quick start

**Requirements:** macOS / Linux / Windows (native), Node.js 24.5+, ChatGPT desktop app or Codex CLI, DeepSeek API key.

### Install by an AI agent (recommended)

Clone the repo and point your agent at this README or `AGENTS.md`:

```bash
# 1. Persist the API key (never printed, never committed; 0600 / Windows DPAPI)
DEEPSEEK_API_KEY=sk-... node src/cli.mjs key set

# 2. Install, start, verify
node src/cli.mjs install
node src/cli.mjs start
node src/cli.mjs doctor    # all six checks must say ok

# 3. Run tests
npm test
```

Fully quit (⌘Q) and relaunch the ChatGPT app, start a **new** task, and pick `🐳 V4 Flash` or `🐳 V4 Pro`.

### Manually

```bash
node src/cli.mjs key set
node src/cli.mjs proxy set http://127.0.0.1:10808   # optional
node src/cli.mjs install && node src/cli.mjs start && node src/cli.mjs doctor
node src/cli.mjs autostart enable   # optional: start at login and recover router crashes
```

CLI default: **High**; add `-c 'model_reasoning_effort="max"'` for **Max**.

```bash
codex -m deepseek/deepseek-v4-flash -c 'model_reasoning_effort="max"'
codex -m deepseek/deepseek-v4-pro -c 'model_reasoning_effort="max"'
```

Commands: `install` `sync` `key set|status|delete` `proxy set|status|clear` `start` `serve`
`autostart enable|disable|status` `status` `doctor` `stop` `uninstall`

## Architecture

```text
Codex App / CLI / IDE
        │  HTTP/SSE (zstd, OAuth headers)
        ▼
http://127.0.0.1:10110/<router-token>/v1   ← DSCodex loopback router
        │
        ├── DeepSeek model → api.deepseek.com/responses
        │     (images described by GPT, proxied automatically if needed)
        └── any other     → chatgpt.com/backend-api/codex (untouched OAuth)
```

Traffic is split by model name. Only DeepSeek-bound requests are rewritten; GPT traffic is forwarded transparently.

## Compatibility

| Surface or behavior | Status |
|---|---|
| Native model picker (ChatGPT macOS app) | Supported |
| Codex CLI / IDE extension | Supported |
| Native Windows (Codex CLI / IDE) | Supported |
| Multi-round DeepSeek tool calls (shell / apply_patch / function call / web search) | Native Responses API |
| Context compaction (auto / manual) | Supported — DeepSeek summary encrypted as a Codex compaction item |
| GPT / Codex OAuth models | Transparent passthrough |
| app-server bridge (picker state memory for the desktop app) | Optional, macOS-only; off by default to preserve Computer Use |
| chatgpt.com web app | Not supported (DSCodex hooks into the local Codex runtime) |

## Frequently asked questions

### Can I use DeepSeek and GPT in the same Codex / ChatGPT desktop app?

Yes. The model menu keeps GPT and adds `🐳 V4 Flash` and `🐳 V4 Pro`. The router selects the DeepSeek API or ChatGPT OAuth by model name, so switching models does not require rewriting the provider configuration.

### Does it support Codex CLI, IDE extensions, and Windows?

Yes. Codex CLI and IDE extensions are supported on macOS, Linux, and Windows; native model-picker integration in ChatGPT desktop currently targets macOS. Windows desktop cannot use the optional app-server bridge, but CLI and IDE routing are unaffected.

### Can DeepSeek use shell, apply_patch, web search, images, and context compaction?

Yes. Tool calls and web search use DeepSeek's Responses API. Because the text-only models cannot see images directly, DSCodex first asks GPT for an image description. Automatic and manual compaction produce an encrypted Codex compaction item.

## Known edge cases

- **Usage stats.** The Codex app's Profile page is read-only — DeepSeek usage cannot be added.
- **Why reasoning folds mid-task.** DeepSeek emits `response.completed` after every tool round; Codex folds the reasoning block, runs the tool, and opens a new request. API behavior, not a bug. No-tool turns fold once at the end.
- **GPT vision.** Borrows the request's ChatGPT OAuth headers (no extra key). Without OAuth headers images pass through untouched. Default model `gpt-5.6-sol`, override with `DSCODEX_VISION_MODEL`.
- **Key storage, proxy resolution, bridge details, platform differences.** See `AGENTS.md`.
- **Voice / Pets / plugins / skills / MCP.** All client-side; Voice runs on GPT-Live and is never routed to DeepSeek.
- **DeepSeek → GPT thread history.** Switching an existing task from DeepSeek back to GPT can currently leave plaintext `reasoning_text` in history and cause a persistent GPT 400 response; see [#17](https://github.com/fish2lab/DSCodex/issues/17). Switching back to DeepSeek or starting a new GPT task remains available.

## Uninstall

```bash
node src/cli.mjs stop && node src/cli.mjs uninstall
```

Removes only DSCodex-owned config and files. The pre-install backup stays at `~/.codex/config.toml.pre-dscodex.bak`.

## References

- [DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)
- [DeepSeek Codex integration](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/)
- [OpenAI Codex manual](https://developers.openai.com/codex/codex-manual.md)

## License

[MIT](LICENSE)
