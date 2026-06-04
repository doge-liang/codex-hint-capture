# Codex → 本地 Mock 推理引擎入口 · 使用文档

把 OpenAI **Codex CLI** 的模型请求路由到本地 mock server，用于观察 Agent 侧传来的
**Hint**（哪个 Agent、开了什么功能、缓存亲和性 key 等），为"面向 Agent 请求的推理引擎"
做亲和性优化。

---

## 1. 目录产物

| 文件 | 作用 |
|---|---|
| `mock-server.js` | Node 零依赖 mock：记录请求头+body，返回合法 Responses API SSE 假响应；支持透传模式 |
| `~/.codex/config.toml` | Codex 路由配置（把 `model_provider` 指向本地 mock） |
| `run-scenarios.sh` | 批量跑 13 个场景，隔离存档每个场景的请求/输出 |
| `summarize.js` | 读取 `logs/*.requests.jsonl`，输出横向对比表 |
| `logs/` | 每场景一份 `*.requests.jsonl`（请求全量）+ `*.stdout.txt`（codex 输出） |
| `codex-requests.jsonl` | 运行时的"主日志"，每条 = 一个被捕获的请求（含完整 headers+body） |
| `REPORT.md` | 13 场景测试报告与 Hint 分析结论 |

---

## 2. 环境前置

- 已安装 Codex CLI：`npm i -g @openai/codex`（本机实测 `codex-cli 0.137.0`）
- Node.js（mock server 用，零额外依赖）
- 自 **2026-02** 起 Codex 只支持 **Responses API**（`wire_api = "responses"`，Chat Completions 已移除），mock 已按此实现。

---

## 3. 路由配置（`~/.codex/config.toml`）

```toml
model_provider = "mock"
model = "gpt-5.5-codex"

# 让 Codex 主动带上 reasoning Hint
model_reasoning_effort = "high"
model_reasoning_summary = "auto"
model_supports_reasoning_summaries = true

[model_providers.mock]
name = "Local Mock Inference Engine"
base_url = "http://127.0.0.1:8787/v1"   # Codex 会 POST 到 .../v1/responses
env_key = "CODEX_MOCK_KEY"              # 读这个环境变量当 Bearer Token，值随便填
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
```

> 另一种更省事的写法：只加一行 `openai_base_url = "http://127.0.0.1:8787/v1"`
> 覆盖内置 openai provider（但会和 ChatGPT 登录态混用，自定义 provider 更干净）。

**改回官方**：把 `model_provider = "mock"` 改成 `"openai"`，或删除该配置文件。

---

## 4. 启动 mock server

```bash
cd /mnt/d/Workspace/project/codex

# 纯 mock 模式（默认，无需 OpenAI 凭证，返回固定假响应）
CODEX_MOCK_KEY=dummy node mock-server.js

# 透传模式（记录后转发到真实上游，让 codex 真正干活）
MODE=proxy UPSTREAM_BASE_URL=https://api.openai.com/v1 UPSTREAM_API_KEY=sk-xxx \
  node mock-server.js
```

可调环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 监听地址 |
| `MODE` | `mock` | `mock`=假响应；`proxy`=透传 |
| `UPSTREAM_BASE_URL` / `UPSTREAM_API_KEY` | — | proxy 模式的上游 |
| `LOG_FILE` | `./codex-requests.jsonl` | 全量请求落盘文件 |
| `MOCK_REPLY` | `pong (来自本地 mock 推理引擎)` | mock 模式回复文本 |

健康检查：`curl http://127.0.0.1:8787/health`

---

## 5. 跑 Codex（请求会自动路由到 mock）

```bash
export CODEX_MOCK_KEY=dummy

# 非交互（推荐做抓取，最稳定）
codex exec --skip-git-repo-check -s read-only "随便说点啥"

# 交互式 TUI（originator 会变成 codex-tui）
codex -s read-only "你好"

# 续接上一会话（验证 prompt_cache_key 跨轮稳定）
codex exec -s read-only --skip-git-repo-check resume --last "第二轮"

# 代码审查 agent（需在 git 仓库内；instructions/工具集都不同）
codex exec --skip-git-repo-check -s read-only -C <repo> review --uncommitted

# 结构化输出（请求体会带 text.format=json_schema）
codex exec --skip-git-repo-check -s read-only --output-schema schema.json "..."

# 图片输入（prompt 放前面，-i 在后，避免变长参数吞掉 prompt）
codex exec --skip-git-repo-check -s read-only "描述图片" -i pic.png

# 开关功能 → 改变 tools[]
codex exec --skip-git-repo-check -s read-only --disable goals "..."

# 改 reasoning 强度（minimal/low/medium/high/xhigh）
codex exec --skip-git-repo-check -s read-only -c model_reasoning_effort="minimal" "..."
```

> **触发函数调用闭环**：prompt 里包含 sentinel `__MOCK_TOOL__` 时，mock 会先回一个
> `update_plan` 的 `function_call`，Codex 执行后回传 `function_call_output`，可观察完整
> 的 agentic 多轮请求。

---

## 6. 批量场景测试 + 分析

```bash
# 1) 确保 mock server 在跑
# 2) 批量跑 13 个场景（每个场景的请求/输出隔离存到 logs/）
bash run-scenarios.sh

# 3) 横向对比分析
node summarize.js
```

常用 jq 取数（也可直接用 `node summarize.js`）：

```bash
# 某场景的 originator / model / tools / 亲和性 key
jq -r '.headers.originator, .body.model, .body.prompt_cache_key,
       (.body.tools|map(.name//.type)|join(","))' logs/01-baseline.requests.jsonl

# 看 developer 消息里的沙箱权限文本
jq -r '.body.input[]|select(.role=="developer").content[].text' logs/06-*.requests.jsonl | head
```

---

## 7. 关于 Hint 的速记（详见 REPORT.md）

- **哪个 Agent** → 请求头 `originator`（`codex_exec` / `codex-tui` …）、`User-Agent`、
  body `client_metadata.x-codex-installation-id`（每安装稳定）。
- **开了什么功能** → body `tools[]`（功能开关会增减其中的工具）。
- **亲和性 key** → body `prompt_cache_key`（= 会话 id，会话内跨轮稳定、每新会话唯一，
  `resume` 保留）。因 `store=false` 每轮重发全部上下文，这是唯一稳定的跨轮句柄。
- 其它：`reasoning.effort/summary`、`text.verbosity/format`、
  `include=["reasoning.encrypted_content"]`、`tool_choice`、`parallel_tool_calls`。
