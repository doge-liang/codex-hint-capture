# codex-hint-capture

> 把 OpenAI **Codex CLI** 的模型请求路由到本地 mock server，**抓取并分析 Agent 侧传来的 Hint**
> （哪个 Agent、开了什么功能、缓存亲和性 key 等），为"面向 Agent 请求的推理引擎"做亲和性优化。
>
> Route Codex CLI's Responses-API traffic to a local mock to capture per-request agent hints
> (identity, enabled tools, cache-affinity key) for inference-engine affinity optimization.

实测环境：Codex `0.137.0`，全部请求走 Responses API（`POST /v1/responses`）。

## 这个仓库有什么

| 文件 | 作用 |
|---|---|
| [`mock-server.js`](mock-server.js) | Node 零依赖 mock：记录请求头+body，返回合法 Responses API SSE 假响应；支持透传(proxy)模式 |
| [`run-scenarios.sh`](run-scenarios.sh) | 批量跑 13 个场景，隔离存档每个场景的请求/输出 |
| [`summarize.js`](summarize.js) | 读取 `logs/*.requests.jsonl`，输出横向对比表 |
| [`logs/`](logs/) | 13 个场景的请求全量（`*.requests.jsonl`）+ codex 输出（`*.stdout.txt`） |
| [`USAGE.md`](USAGE.md) | 安装 / 路由 / 启动 / 跑场景 / 分析 / 还原的完整使用文档 |
| [`REPORT.md`](REPORT.md) | 13 场景测试报告 + Hint 七大分类 + 引擎优化建议 |

## 快速开始

```bash
# 0) 装 Codex CLI
npm i -g @openai/codex

# 1) 配置路由：把下面写进 ~/.codex/config.toml
#    [model_providers.mock] base_url="http://127.0.0.1:8787/v1" wire_api="responses" env_key="CODEX_MOCK_KEY"
#    并设 model_provider="mock"（完整示例见 USAGE.md）

# 2) 起 mock server
CODEX_MOCK_KEY=dummy node mock-server.js

# 3) 跑 codex，请求会被路由+记录
export CODEX_MOCK_KEY=dummy
codex exec --skip-git-repo-check -s read-only "随便说点啥"

# 4)（可选）批量场景 + 分析
bash run-scenarios.sh && node summarize.js
```

## 回归测试（零依赖，`node:test`）

把所有已验证的行为沉淀成回归测试——codex 升级或 mock 改动导致行为漂移时立刻报警。

```bash
npm test          # Tier 1：快、确定、无需 codex（CI 友好）
npm run test:e2e  # Tier 2：真跑 codex 打到子进程 mock（需装 codex）
```

- **Tier 1（47 例）**：① `test/fixtures.test.js` + `test/ctx-fixtures.test.js` 对已存的 `logs/*.requests.jsonl`
  断言所有 golden 不变量（工具有序集合、compaction 完整序列+memento 指纹+turn_id 共享+window 递增+亲和性免疫、
  fork 血缘回指父、memory 多模型链路、子代理 `parent_thread_id` 指回父、截断尺寸+标记、AGENTS.md 折叠/层级/32KiB、
  记忆读取回流…）；② `test/mock-logic.test.js` 测 sentinel 决策纯函数；③ `test/mock-http.test.js` 进程内验证 SSE。
- **Tier 2（3 例，opt-in）**：`test/e2e.test.js` 真跑 codex 验证 11 工具/originator、函数调用闭环、
  context_window 错误识别。

## 核心结论（详见 REPORT.md）

- **会话粘性 key**：`prompt_cache_key`（= session_id, uuid v7）会话内跨轮稳定、每新会话唯一、`resume` 保留；
  因 `store=false` 每轮重发全部上下文，这是唯一可靠的跨轮句柄 → 适合做 KV-cache 亲和路由。
- **Agent 身份**：请求头 `originator`（`codex_exec` / `codex-tui`）+ `User-Agent` + body `client_metadata.x-codex-installation-id`。
- **开了什么功能**：body `tools[]` 集合 + `instructions` 指纹，网关层免解析对话即可判定 Agent 类型与能力面。
- **引擎硬要求**：`include=["reasoning.encrypted_content"]` —— 必须支持加密推理回显，否则多轮退化。

## 说明

- `logs/` 为真实抓取的请求样本，含示例 `x-codex-installation-id` 与 Codex 系统提示词，仅供研究参考。
- 默认 mock 模式无需任何 OpenAI 凭证；`MODE=proxy` 可切到"记录后转发到真实上游"。
