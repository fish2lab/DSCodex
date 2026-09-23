# DSCodex — 在原版 Codex / ChatGPT 桌面端同时使用 DeepSeek 与 GPT

<div align="center">

<img src="assets/dscodex-banner.png" alt="DSCodex — DeepSeek V4.1 Flash for Codex, GPT OAuth kept" />

<p>
  <a href="https://github.com/fish2lab/DSCodex/releases/latest"><img src="https://img.shields.io/github/v/release/fish2lab/DSCodex?style=flat-square&color=4D6BFE" alt="Latest release" /></a>
  <a href="https://github.com/fish2lab/DSCodex/stargazers"><img src="https://img.shields.io/github/stars/fish2lab/DSCodex?style=flat-square&color=F5A623" alt="GitHub stars" /></a>
  <a href="https://developers.openai.com/codex/"><img src="https://img.shields.io/badge/Codex-App_%C2%B7_CLI_%C2%B7_IDE-412991?style=flat-square&logo=openai&logoColor=white" alt="Codex App, CLI and IDE" /></a>
  <a href="https://api-docs.deepseek.com/zh-cn/guides/responses_api/"><img src="https://img.shields.io/badge/DeepSeek-Flash-4D6BFE?style=flat-square" alt="DeepSeek Flash" /></a>
  <br />
  <a href="https://api-docs.deepseek.com/zh-cn/guides/responses_api/"><img src="https://img.shields.io/badge/Responses_API-native-00A98F?style=flat-square" alt="Native Responses API" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%E2%89%A524.5-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 24.5 or newer" /></a>
  <a href="#快速开始"><img src="https://img.shields.io/badge/macOS_%7C_Linux_%7C_Windows-supported-000000?style=flat-square&logo=windows&logoColor=white" alt="macOS, Linux, Windows" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-F1C40F?style=flat-square" alt="MIT license" /></a>
</p>

<p><strong>DeepSeek V4.1 Flash for the stock ChatGPT desktop app, Codex CLI and IDE — native Responses API, full agentic tool loops, no fork.</strong></p>
<p>在原版 ChatGPT 桌面端与 Codex 中使用 DeepSeek V4.1 Flash，GPT 的 ChatGPT OAuth 登录原样保留。</p>

</div>

简体中文 · [English](README.en.md) · 规范仓库 [github.com/fish2lab/DSCodex](https://github.com/fish2lab/DSCodex) · 给模型看的索引 [llms.txt](llms.txt)

---

## DSCodex 是什么？

**DSCodex 是一个开源、只在本机运行的 Codex 多模型路由器。** 它把 DeepSeek V4.1 Flash 加进 ChatGPT 桌面端、Codex CLI 和 IDE 扩展的原生模型菜单，同时保留 ChatGPT OAuth 登录和全部 GPT 模型。请求按模型名分流：DeepSeek 走原生 Responses API，GPT 继续经 `chatgpt.com` OAuth 原样转发。

它不 fork、不 patch ChatGPT 或 Codex，也不是 chatgpt.com 网页版的插件。它只写入一个自己拥有的配置键，卸载时原样撤回。适合既有 DeepSeek API Key 又有 ChatGPT 订阅、不想在两者之间反复改配置或重新登录的人。

### 与 DeepSeek 官方 Codex 接入的区别

| | [DeepSeek 官方 Codex 直连](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/) | DSCodex |
|---|---|---|
| 在 Codex 使用 DeepSeek Flash | 支持 | 支持 |
| 同一客户端保留 GPT OAuth 模型 | 不保留：整个 Codex 切到 API Key 登录，切回要恢复配置 | 保留：按模型名分流，两者同时在菜单里 |
| DeepSeek API Key 存放 | `config.toml` 的 bearer token 字段 | `~/.codex/dscodex/config.json`（0600；Windows DPAPI） |
| Codex 兼容适配 | 无，直接连接 | 工具调用重放修复、上下文压缩、原生识图、provider 状态记忆 |

## 当前模型：DeepSeek V4.1 Flash

模型菜单只有一条 `🐳 DeepSeek Flash`，API 名 `deepseek-flash`，对应 **DeepSeek V4.1 Flash**：1M 上下文、最高 384K 输出、原生视觉、Responses API 工具调用。旧的 `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp` 名称仍可路由，恢复旧任务不需要改模型设置。

官方牌价（每百万 token，高峰期）：缓存命中输入 **$0.006**、未命中输入 **$0.30**、输出 **$1.20**，低谷期减半。DeepSeek 计划于 **2026-09-14 12:00（北京时间）**起把 V4 Pro 请求转到 V4.1 Flash 并按 Flash 计费。「全面超过 V4 Pro」是官方测试结论，本项目未做独立评测。能力与价格以[官方模型说明](https://api-docs.deepseek.com/quick_start/pricing/)为准。

### 思考强度

托管 Responses API 只接受字符串档位 `none / minimal / low / medium / high / xhigh / max`。整数 Juice（1–100）和 `ultra` 都返回 HTTP 400，尽管模型卡写了连续 Juice、文档写了 `ultra` 会映射到 `max`。DSCodex 的目录只暴露两档，路由器把收到的任何档位折进这两档：

| Codex 滑块 | 发给 DeepSeek | 模型 Juice |
|---|---|---|
| High | `high` | 75 |
| Max（菜单默认） | `max` | 100 |

折算规则：`low` / `medium` / `high` → `high`，其余（含 `xhigh`、`max`、`ultra`）→ `max`。不展开六档，是因为官方本身把 Codex 六档收成三档：`minimal` / `low` → 50，`medium` / `high` / `xhigh` → 75，`max` / `ultra` → 100。Medium、High、Extra High 指向同一个 Juice，多出的档位没有分辨率。两档也对准 DeepSeek 给 agent 场景的建议：日常 `high`，难题 `max`。

## 快速开始

**环境要求：** macOS / Linux / Windows（原生），Node.js 24.5+，ChatGPT 桌面端或 Codex CLI，DeepSeek API Key。

### 交给 AI Agent 安装（推荐）

克隆仓库后让 Agent 读本 README 或 `AGENTS.md`：

```bash
# 1. 存入 API Key（不打印、不进仓库；0600 / Windows DPAPI）
DEEPSEEK_API_KEY=sk-... node src/cli.mjs key set

# 2. 安装依赖（路由器的 Responses WebSocket 服务端需要 ws）
npm install

# 3. 安装、启动、验证
node src/cli.mjs install
node src/cli.mjs start
node src/cli.mjs doctor    # 六项必须全部 ok

# 4. 跑测试
npm test
```

完全退出（⌘Q）再重开 ChatGPT 桌面端，**新建任务**，在模型菜单选 `🐳 DeepSeek Flash`。已有任务保留旧模型状态。

### 手动安装

```bash
node src/cli.mjs key set
node src/cli.mjs proxy set http://127.0.0.1:10808   # 可选：GPT 直通走的出站代理
node src/cli.mjs install && node src/cli.mjs start && node src/cli.mjs doctor
node src/cli.mjs autostart enable   # 可选：登录自启，路由崩溃后自动拉起
```

CLI 用 `-m` 选模型，用 `-c` 显式指定档位（不写则由 Codex 自己的默认档位经上表折算）：

```bash
codex -m deepseek/deepseek-flash -c 'model_reasoning_effort="max"'
```

全部命令：`install` `sync` `key set|status|delete` `proxy set|status|clear` `start` `serve`
`autostart enable|disable|status` `bridge enable|disable|status` `status` `doctor` `stop` `uninstall`

## 架构

```text
Codex App / CLI / IDE
        │  HTTP/SSE 与 Responses WebSocket（zstd、OAuth 头）
        ▼
http://127.0.0.1:10110/<router-token>/v1   ← DSCodex 本机路由器
        │
        ├── DeepSeek 模型 → api.deepseek.com/responses（HTTP）
        │     （图片原生输入；旧 Flash / Pro 名称映射到 Flash）
        └── 其他模型     → chatgpt.com/backend-api/codex
              HTTP SSE 原样转发；WebSocket upgrade 透传到
              wss://chatgpt.com/backend-api/codex/responses
```

按模型名分流。DeepSeek 请求按其 API 的要求改写；GPT 请求只在历史里含有外来 reasoning 或 DSCodex 压缩项时才改写，其余保持原始字节。

## 兼容性

| 场景 | 状态 |
|---|---|
| ChatGPT macOS 桌面端原生模型菜单 | 支持 |
| Codex CLI / IDE 扩展 | 支持 |
| Windows 原生（Codex CLI / IDE 扩展） | 支持 |
| DeepSeek 多轮工具调用（shell / apply_patch / function call / web search） | 原生 Responses API |
| 上下文压缩（自动 / 手动） | 支持：DeepSeek 摘要加密后封装为 Codex 压缩项 |
| GPT / Codex OAuth 模型 | 透明直通（HTTP SSE 与 Responses WebSocket） |
| app-server bridge（桌面端按 provider 记忆档位） | 可选，仅 macOS；默认关闭以保住 Computer Use |
| chatgpt.com 网页版 | 不支持：接入的是本地 Codex 运行时 |

## 常见问题

### 装完 DSCodex 后官方 GPT 一直 Reconnecting 1/5…5/5？

ChatGPT 桌面端 26.908+ 会先连 `ws://127.0.0.1:10110/<token>/v1/responses`。路由器必须在跑（`dscodex start`，建议 `autostart enable`），GPT 的 upgrade 才会透传到 `wss://chatgpt.com/backend-api/codex/responses`。路由器停掉时官方模型会 Connection refused 后 5/5。DeepSeek 仍走 HTTP Responses，不会接到 OpenAI 的 WebSocket 上。

### 如何在 Codex / ChatGPT 桌面端里用 DeepSeek V4.1 Flash，同时保留 GPT？

装 DSCodex，完全退出后重开 ChatGPT 桌面端，**新建任务**，在模型菜单选 `🐳 DeepSeek Flash`。GPT 仍走 ChatGPT OAuth，切换模型不必重新登录，也不必改写 `config.toml` 里的 provider。

### DSCodex 和 DeepSeek 官方 Codex 接入有什么区别？

官方一键脚本把整个 Codex 切到 DeepSeek API Key，GPT OAuth 模型从菜单消失。DSCodex 按模型名分流：DeepSeek 走 `api.deepseek.com/responses`，GPT 继续走 `chatgpt.com` OAuth（含 Responses WebSocket），同一客户端里两者都在。官方接入把 Key 写进 `config.toml`；DSCodex 把 Key 存在 `~/.codex/dscodex/config.json`（0600 / Windows DPAPI）。CLIProxyAPI / Codexia 一类网关也能给 Codex 加自定义模型，但不做 DSCodex 这条 DeepSeek 工具重放修复和加密 compaction。

### DSCodex 会 fork 或修改 ChatGPT / Codex App 吗？

不会。它不是 chatgpt.com 网页插件，也不 patch 桌面端。它只改一处自己写入的配置：`openai_base_url`（指向本机 `127.0.0.1:10110/<token>/v1`）。模型列表由路由器实时转发 ChatGPT 的 `/models` 并插入 `🐳 DeepSeek Flash`，所以 OpenAI 新上线或下架的 GPT 模型会跟着 Codex 自己的刷新出现或消失。v1.2.2 及更早版本写入的 `model_catalog_json` 会在下次 `start` 时自动删除。

### DSCodex 和 DSCode、DeepCodex 是同一个项目吗？

不是。规范仓库是 [fish2lab/DSCodex](https://github.com/fish2lab/DSCodex)。[DSCode](https://github.com/thinkany-ai/dscode) 是另一套多供应商 coding agent；DeepCodex 等是名称相近的独立项目。搜「Codex 接入 DeepSeek 同时保留 GPT」应对准本仓库。

### 支持 Codex CLI、IDE 和 Windows 吗？

支持。Codex CLI 与 IDE 扩展在 macOS、Linux、Windows 上都可用；ChatGPT 桌面端的原生模型菜单集成目前以 macOS 为主。Windows 桌面端用不了可选的 app-server bridge，但 CLI / IDE 路由不受影响。

### DeepSeek 能用 shell、apply_patch、web search、图片和上下文压缩吗？

能。工具调用和 web search 走 DeepSeek Responses API；Flash 原生处理图片，包括工具返回的图片；自动或手动压缩由 DSCodex 生成加密的 Codex compaction item。

## 已知边界

- **用量统计。** Codex 的 Profile 页面只读，DeepSeek 用量无法计入。
- **思考块反复折叠。** DeepSeek 每轮工具调用结束都发 `response.completed`，Codex 随之折叠思考、执行工具、再展开下一轮。这是 API 行为，不是 bug；无工具的单轮只折叠一次。
- **原生识图。** 图片和工具返回的图片直接交给 `deepseek-flash`，不再借 GPT 代读；`DSCODEX_VISION_MODEL` 不再生效。
- **DeepSeek → GPT 任务历史。** 转发 GPT 前剥掉外来 reasoning（带 `reasoning_text` 内容，或 `encrypted_content` 非 ChatGPT 密文；DeepSeek 现在会填一个 UUID 占位串，见 #23），把 DSCodex 自己的加密压缩摘要恢复为助手上下文；GPT 原生 reasoning 与普通请求保持原始字节，rollout 文件不改写。HTTP SSE 与每条 Responses WebSocket `response.create` 都做这件事。
- **子 agent。** 发给 DeepSeek 的 `agent_message` 以 `user` 角色重放，`encrypted_content` 等 DeepSeek 不认识的内容块改写成 `input_text`，spawn 子 agent 不再 422 / 400（#24）。
- **官方 GPT WebSocket。** 桌面端 26.908+ 先连 loopback WS。路由器必须在跑，upgrade 才会透传到 chatgpt.com；停掉就 Reconnecting 5/5。DeepSeek 的 WS 握手带模型提示（ChatGPT 登录始终会带）时会被直接拒绝（HTTP 426），客户端零重试切到 HTTP Responses；提示缺失时仍在首帧按 close 1008 回退。
- **Voice。** GPT-Live 从不发给 DeepSeek。桌面端 26.908 起语音由客户端自己直连 `chatgpt.com/wham/realtime/calls`，不经过 `openai_base_url`，路由器无事可做（PR #21 已关闭）。Pets、插件、技能与 MCP 仍由客户端处理。
- **验收范围。** CI 覆盖 macOS / Windows / Linux；Windows 实机（桌面端 + 自启动）尚未在维护者机器上验收。
- **Key 存储、代理解析、bridge 细节、平台差异。** 见 `AGENTS.md`。

## 卸载

```bash
node src/cli.mjs stop && node src/cli.mjs uninstall
```

只删除 DSCodex 写入的配置和文件。安装前的备份保留在 `~/.codex/config.toml.pre-dscodex.bak`。

## 参考

- [llms.txt](llms.txt) / [llms-full.txt](llms-full.txt)：给 AI 搜索与 coding agent 的引用索引
- [DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)
- [DeepSeek 官方 Codex 接入](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/)：会替换 GPT；要共存请用 DSCodex
- [OpenAI Codex manual](https://developers.openai.com/codex/codex-manual.md)

## 许可证

[MIT](LICENSE)
