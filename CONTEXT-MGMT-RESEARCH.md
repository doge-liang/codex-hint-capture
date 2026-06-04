# Codex 上下文管理特性 · 研究 + 测试矩阵

> 来源：`/deep-research` 工作流（104 agents，多源联网 + openai/codex 源码 + 官方文档，3 票对抗式验证）。
> 目标：把 Codex CLI 0.137 的上下文管理特性查全查准，并为每个特性制定"**触发场景 + 在本 mock 平台上的验证手段**"，
> 明确区分【已验证】（场景 14-22，见 REPORT.md 第二部分）与【建议补测】（场景 23-30）。
> 所有结论均带官方来源；时效性提醒见文末。

---

## A. 特性全景（五大族）

| 族 | 关键事实（含官方依据） |
|---|---|
| **AGENTS.md 注入** | 三层优先级：全局 `~/.codex/AGENTS.override.md`(否则 `AGENTS.md`) → 项目(Git root 向下 walk 到 cwd) → 越靠近 cwd 越靠后、覆盖更早指引；每目录最多取一个文件；组合**预算 32 KiB**(`project_doc_max_bytes`，越界文件**静默截断**)。[1][2] |
| **压缩 Compaction** | `memento`/handoff 策略：反向保留最近**≤20000 token 的 user 消息** + 初始上下文 + 摘要，整体 `replace_compacted_history` 替换；摘要由 `CONTEXT CHECKPOINT COMPACTION` handoff 模板驱动。触发读 `last_token_usage.total_tokens` 越过 `model_auto_compact_token_limit`(**绝对 token 阈值**，另有 `context_window*90%` 硬上限)。[3][4][5] |
| **记忆 Memory** | 本地存 `~/.codex/memories/`，`features.memories` 默认 off；**后台异步**生成(跳过 active/短命会话、脱敏、需 idle)；双向独立开关 `generate_memories`/`use_memories`(均默认 true)；`extract_model`(per-thread 提取)/`consolidation_model`(global 整合) 可覆盖。[6][7][8] |
| **子代理 Subagents** | 仅在用户**显式**要求时 spawn（无自动后台 spawn）；内置三类 `default`/`worker`/`explorer`；`[agents]` `max_threads=6`/`max_depth=1`；协作工具 `spawn_agent`(带 `fork_context`)/`send_input`/`wait_agent`/`close_agent`。[9][10][11] |
| **血缘 Lineage** | 两套**独立**机制：`parentThreadId`(=header `x-codex-parent-thread-id`，spawn 父子血缘) vs `forkedFromId`(=body `forked_from_thread_id`，fork 源血缘)。[12] |
| **上下文窗口** | `model_context_window`(总窗口) 与 `model_auto_compact_token_limit`(触发阈值，通常设在窗口之下)；`model_auto_compact_token_limit_scope`(session vs thread)。⚠️ **设了 `model_context_window` 会因 `fill_to_context_window` 的 delta 计数 bug 让 auto-compaction 静默失效**。[3][13] |

---

## B. 测试矩阵

### 已验证（场景 14-22，见 REPORT.md 第二部分）
AGENTS.md 基础注入、--add-dir、fork(全新身份+复制历史+`forked_from_thread_id`)、compaction(`request_kind=compaction`+memento 指纹+亲和性保持)、tool_output 截断、memory(generate→`gpt-5.4-mini`+整合子代理`memory_consolidation`)、archive/unarchive(0 请求)、请求压缩开关(wire 无差异)。

### 建议补测（场景 23-30，本研究新增）

| # | 特性 | 平台触发方式 | 验证字段/预期 | 备注·坑 |
|---|---|---|---|---|
| **23** | AGENTS.md 层级与覆盖 [1] | 在子目录放 child `AGENTS.md` + 项目根放 `AGENTS.override.md`，各含唯一 SENTINEL；`codex exec -C <子目录>` | body `input` 里出现**多段**注入、越靠近 cwd 的 SENTINEL 越靠后；override 文件覆盖同名指引 | 每目录单文件；无 .git 时只扫 cwd |
| **24** | AGENTS.md 32 KiB 预算 [2] | 构造 >32768 字节的 `AGENTS.md`（含位于 ~32760 字节处的 END_SENTINEL）；跑一次 | 注入内容在 **32768 字节**处被截断，END_SENTINEL **不出现** | 静默截断、无警告(issue #7138) |
| **25** | auto-compaction 90% 硬上限 [3] | `__MOCK_BIGUSAGE__` 改造成可调值：分别上报落在 `[limit, 0.9*window)` 与 `>0.9*window`；`-c model_auto_compact_token_limit=<limit>` | 两档都应触发 `request_kind=compaction`（验证阈值是绝对 token、且 90% 钳制不影响"调小阈值"方向） | 需给 mock 加 usage 可配置（现固定 190000） |
| **26** | memento 保留窗口 + handoff 模板 [4][5] | 先用 `__MOCK_TOOL__`/`__MOCK_EXEC__` 制造含 function_call 的历史，再 `__MOCK_BIGUSAGE__` 触发压缩 | 压缩**后**那条 turn 的 `input` 只保留最近 user 消息(≤20k token)，**function_call/reasoning item 不在保留集**；压缩请求 input 含 `CONTEXT CHECKPOINT COMPACTION` 模板文本 | 我们之前压缩历史全是纯 message，未验证工具调用如何折叠 |
| **27** | model_context_window bug 负向测试 [3][13] | 同时 `-c model_context_window=200000` + `__MOCK_BIGUSAGE__`(190000) + `-c model_auto_compact_token_limit=500`，多轮 resume | 预期 auto-compaction **静默失效**（不出现 `compaction`）——复现 `fill_to_context_window` delta bug | 解释"为什么我们触发时不能设 model_context_window" |
| **28** | auto_compact_token_limit_scope [13] | `-c model_auto_compact_token_limit_scope=session` vs `=thread` 各跑一遍 | 观察触发点/scope token 计算差异 | scope 取值语义文档薄，需实测 |
| **29** | memory 双向开关 + 读取回流 [6][7] | (a) `-c memories.generate_memories=false` → 应无后台 `memory` 请求；(b) `use_memories=true` 起新 session → input 注入既有记忆；(c) `-c memories.extract_model=<X>` → memory 请求 model 变 | (a) 无 `request_kind=memory`；(b) 新 session 的 `input` 含记忆注入项；(c) memory 请求 `model` 字段=X | 记忆**读取回流**是我们完全没测的一环 |
| **30** | 子代理 spawn + fork_context [9][10][11][12] | prompt **显式**要求"spawn one worker/explorer per point"；给 mock 加 sentinel 回 `spawn_agent` 函数调用 | body `tools` 出现 `spawn_agent`/`send_input`/`wait_agent`/`close_agent`；子代理请求带 header `x-codex-parent-thread-id`；`fork_context=true` 时子 input 含父历史；`max_depth=1` 时二级 spawn 被拒 | 子代理只能自然语言触发；工具 schema 主源是 issue(medium 置信) |

---

## C. 时效性与坑（务必注意）

- **源码路径/行号会漂移**：compact 模板已于 2026-06-01 (PR #25151) 从 `codex-rs/core/templates/compact/prompt.md` 迁到
  `codex-rs/prompts/templates/compact/prompt.md`；引用源码时以 claim 内容为准、路径可能 404。
- **`model_context_window` + auto-compaction 静默失效**（issue #16068）：`fill_to_context_window` 把 `last_token_usage.total_tokens`
  设为近零 delta，触发器读到 ~0 → 永不压缩。我们用 `__MOCK_BIGUSAGE__` 触发压缩时**不要设 `model_context_window`**，否则失效。
- **子代理需显式授权**：无自动/后台 spawn，必须在 prompt 里明确要求。
- **记忆后台异步**：`generate_memories` 触发需 thread idle 足够久、且有未处理 rollout（已处理的被 `memories_1.sqlite` 标记跳过）。

## 来源
[1] developers.openai.com/codex/guides/agents-md · openai/codex `core/src/agents_md.rs`
[2] 同上 · `config/src/config_toml.rs` · issue #7138
[3] developers.openai.com/codex/config-reference · issue #11805
[4] openai/codex `core/src/compact.rs`
[5] openai/codex `prompts/templates/compact/prompt.md` (2026-06-01 迁移, PR #25151)
[6] developers.openai.com/codex/memories · issue #19732
[7] developers.openai.com/codex/memories · config-reference · deepwiki.com/openai/codex
[8] developers.openai.com/codex/memories · config-reference
[9] developers.openai.com/codex/subagents · issue #18513 · #16996
[10] subagents.md · simonwillison.net/2026/Mar/16/codex-subagents
[11] issue #14981 · #16371 · #20077
[12] openai/codex `app-server/README.md`
[13] issue #14456 · #16068 · `protocol/src/protocol.rs` · `core/src/context_manager/history.rs`
