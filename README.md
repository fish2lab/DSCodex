# DSCodex — 在 Codex / ChatGPT 桌面端同时使用 DeepSeek 与 GPT

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
  <a href="#环境要求"><img src="https://img.shields.io/badge/macOS_%7C_Linux_%7C_Windows-supported-000000?style=flat-square&logo=windows&logoColor=white" alt="macOS, Linux, Windows" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-F1C40F?style=flat-square" alt="MIT license" /></a>
</p>

<p><strong>DeepSeek V4 Flash and Pro for the stock ChatGPT desktop app, Codex CLI and IDE — native Responses API, full agentic tool loops, no fork.</strong></p>
<p>在原版 ChatGPT 桌面端与 Codex 中使用 DeepSeek V4 Flash / Pro，同时保留 GPT OAuth 模型。</p>

</div>

简体中文 · [English](README.en.md)

---

## DSCodex 是什么？

**DSCodex 是一个开源、本地运行的 Codex 多模型路由器。** 它让 DeepSeek V4 Flash / Pro 出现在 ChatGPT 桌面端的 Codex 原生模型选择器、Codex CLI 和 IDE 扩展中，同时保留 ChatGPT OAuth 登录与 GPT 模型。DeepSeek 请求使用原生 Responses API；GPT 请求继续通过 `chatgpt.com` OAuth 透明转发。

DSCodex 适合想要 **Codex 接入 DeepSeek**、又不想在 DeepSeek API Key 与 ChatGPT 订阅之间反复改配置或重新登录的用户。它不是 ChatGPT 网页版插件，也不 fork、不 patch ChatGPT 或 Codex App。

### 何时选择 DSCodex？

| 需求 | [DeepSeek 官方 Codex 直连](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/) | DSCodex |
|---|---|---|
| 在 Codex 使用 V4 Flash / Pro | 支持 | 支持 |
| 同一客户端保留 GPT OAuth 模型 | 切换到 API Key 登录；恢复配置后切回 | 按模型名路由，DeepSeek 与 GPT 同时留在模型菜单 |
| DeepSeek API Key | 写入 `config.toml` 的 bearer token 字段 | 独立存储于 `~/.codex/dscodex/config.json`（0600；Windows DPAPI） |
| Codex 兼容适配 | 直接连接 DeepSeek | 工具重放、上下文压缩、GPT 识图与 provider 状态适配 |

## 快速开始

**环境要求：** macOS / Linux / Windows（原生），Node.js 24.5+，ChatGPT 桌面端或 Codex CLI，DeepSeek API Key。

### 交给 AI Agent 安装（推荐）

克隆仓库后让 Agent 读本 README 或 `AGENTS.md`：

```bash
# 1. 存入 API Key（不打印不进仓库，0600 / Windows DPAPI）
DEEPSEEK_API_KEY=sk-... node src/cli.mjs key set

# 2. 安装、启动、验证
node src/cli.mjs install
node src/cli.mjs start
node src/cli.mjs doctor    # 六项必须全部 ok

# 3. 验证
npm test
```

完全退出（⌘Q）重开 ChatGPT 桌面端，新建任务选择 `🐳 V4 Flash` 或 `🐳 V4 Pro`。

### 手动安装

```bash
node src/cli.mjs key set
node src/cli.mjs proxy set http://127.0.0.1:10808   # 可选
node src/cli.mjs install && node src/cli.mjs start && node src/cli.mjs doctor
node src/cli.mjs autostart enable   # 可选：登录自启；路由崩溃后自动恢复
```

CLI 默认 **High**；加 `-c 'model_reasoning_effort="max"'` 使用 **Max**。

```bash
codex -m deepseek/deepseek-v4-flash -c 'model_reasoning_effort="max"'
codex -m deepseek/deepseek-v4-pro -c 'model_reasoning_effort="max"'
```

所有命令：`install` `sync` `key set|status|delete` `proxy set|status|clear` `start` `serve`
`autostart enable|disable|status` `status` `doctor` `stop` `uninstall`

## 架构

```text
Codex App / CLI / IDE
        │  HTTP/SSE（zstd 压缩、OAuth 头）
        ▼
http://127.0.0.1:10110/<router-token>/v1   ← DSCodex 本地路由
        │
        ├── DeepSeek 模型 → api.deepseek.com/responses
        │     （图片经 GPT 识图后以文字注入，需代理时自动走代理）
        └── 其他模型     → chatgpt.com/backend-api/codex（OAuth 原样转发）
```

按模型名分流。路由仅改写 DeepSeek-bound 请求，GPT 流量透明旁路。

## 兼容性

| 场景 | 状态 |
|---|---|
| ChatGPT macOS 桌面端原生模型菜单 | 支持 |
| Codex CLI / IDE 扩展 | 支持 |
| Windows 原生（Codex CLI / IDE 扩展） | 支持 |
| DeepSeek 多轮工具调用（shell / apply_patch / function call / web search） | 原生 Responses API |
| 上下文压缩（自动 / 手动） | 支持 — DeepSeek 摘要加密封装为 Codex 压缩项 |
| GPT / Codex OAuth 模型 | 透明旁路 |
| app-server bridge（桌面端模型菜单状态记忆） | 可选，macOS 专属；默认不启以保 Computer Use |
| chatgpt.com 网页版 | 不支持（接入的是本地 Codex 运行时） |

## 常见问题

### 能在同一个 Codex / ChatGPT 桌面端里同时使用 DeepSeek 和 GPT 吗？

能。模型菜单保留 GPT，并新增 `🐳 V4 Flash` 与 `🐳 V4 Pro`；路由器按模型名选择 DeepSeek API 或 ChatGPT OAuth，不需要为每次切换重写 provider。

### 支持 Codex CLI、IDE 和 Windows 吗？

支持。Codex CLI 与 IDE 扩展支持 macOS、Linux、Windows；ChatGPT 桌面端的原生模型菜单集成当前以 macOS 为主。Windows 桌面端不支持可选的 app-server bridge，但 CLI / IDE 路由不受影响。

### DeepSeek 能使用 shell、apply_patch、web search、图片和上下文压缩吗？

能。工具调用和 web search 走 DeepSeek Responses API；文字模型无法直接看到图片，因此 DSCodex 先用 GPT 生成图片描述；自动或手动压缩由 DSCodex 生成加密的 Codex compaction item。

## 已知边界

- **用量统计。** Codex 的 Profile 页面只读，无法计入 DeepSeek 用量。
- **思考反复折叠。** DeepSeek 每轮工具调用结束发 `response.completed`，Codex 折叠→执行→展开下一轮思考。这是 API 行为。无工具的单轮只折叠一次。
- **GPT 识图。** 借用请求自带的 OAuth 头，无需额外 key。无 OAuth 时图片原样透传。默认模型 `gpt-5.6-sol`，`DSCODEX_VISION_MODEL` 可换。
- **Key 存储、代理解析、bridge 细节、平台差异。** 详见 `AGENTS.md`。
- **Voice / Pets / 插件 / 技能 / MCP。** 均为客户端功能；Voice 由 GPT-Live 驱动，不会路由到 DeepSeek。
- **DeepSeek → GPT 任务历史。** 同一任务从 DeepSeek 切回 GPT 时，历史中的明文 `reasoning_text` 目前可能导致 GPT 请求返回 400；见 [#17](https://github.com/fish2lab/DSCodex/issues/17)。切回 DeepSeek 或新建 GPT 任务可继续使用。

## 卸载

```bash
node src/cli.mjs stop && node src/cli.mjs uninstall
```

只删除 DSCodex 写入的配置和文件。备份保留在 `~/.codex/config.toml.pre-dscodex.bak`。

## 参考

- [DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)
- [DeepSeek Codex 接入](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/)
- [OpenAI Codex manual](https://developers.openai.com/codex/codex-manual.md)

## 许可证

[MIT](LICENSE)
