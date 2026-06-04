# Codex Agent Hint 抓取测试报告

> 目标：把 Codex CLI 路由到本地 mock，**实测**它在各类场景下发送的请求，提炼出可用于
> "面向 Agent 请求的推理引擎"做**亲和性优化**的 Hint 信号。
> 日期：2026-06-04 · Codex `0.137.0` · 全部请求走 Responses API（`POST /v1/responses`）。

---

## 1. 摘要

- 共设计并跑通 **13 个场景**，覆盖：reasoning 强度、换模型、功能开关、沙箱模式、结构化输出、
  函数调用闭环、多轮 resume、代码审查 agent、图片输入、交互式 TUI。
- 所有场景的完整请求（headers + body）已隔离存档于 `logs/<场景>.requests.jsonl`。
- **核心结论**：Codex 在每个请求里携带了足够的 Hint，可在网关层**无需解析对话内容**即可识别
  "**哪个 Agent / 开了什么功能 / 该粘到哪台机器**"。

---

## 2. 场景矩阵与结果

| # | 场景 | 命令要点 | 请求数 | 关键观察 | 结果 |
|---|---|---|---|---|---|
| 01 | 基线 | `codex exec` 默认 | 1 | originator=`codex_exec`，11 个工具，effort=high | ✅ |
| 02 | reasoning=minimal | `-c model_reasoning_effort=minimal` | 1 | `reasoning.effort` → minimal | ✅ |
| 03 | reasoning=xhigh | `-c model_reasoning_effort=xhigh` | 1 | `reasoning.effort` → xhigh | ✅ |
| 04 | 换模型 | `-m gpt-5.5` | 1 | `model` → gpt-5.5（非 codex 版） | ✅ |
| 05 | 关闭 goals | `--disable goals` | 1 | tools 11→**8**，去掉 3 个 goal 工具 | ✅ |
| 06 | 沙箱 workspace-write | `-s workspace-write` | 1 | **developer 消息**里 permissions 文本改变 | ✅ |
| 07 | 结构化输出 | `--output-schema schema.json` | 1 | body 多出 `text.format=json_schema` | ✅ |
| 08 | 关 web_search（尝试）| `-c tools.web_search=false` | 1 | **无效**：tools 不变，仍含 web_search | ⚠️ |
| 09 | 函数调用闭环 | prompt 带 `__MOCK_TOOL__` | **2** | function_call(update_plan) → function_call_output | ✅ |
| 10 | 多轮 resume | `exec resume --last` | **2** | 两轮 `prompt_cache_key` **相同** | ✅ |
| 11 | 代码审查 agent | `exec review --uncommitted` | 1 | instructions 全换(6419字)，工具仅 **6** 个 | ✅ |
| 12 | 图片输入 | `-i pic.png` | 1 | input 出现 `input_image` 内容块 | ✅ |
| 13 | 交互式 TUI | `codex "..."`（pty） | 1 | originator=**`codex-tui`** | ✅ |

> 08 是有意的反例：用 `-c tools.web_search=false` 关 web_search **不生效**（该 key 在 0.137 无效），
> web_search 的开关需走 feature/其它配置，后续若要按功能精确建模需注意。

---

## 3. Hint 分类发现

### 3.1 「哪个 Agent」——身份类（主要在请求头 + client_metadata）

| 信号 | 位置 | 实测值/说明 |
|---|---|---|
| `originator` | header | `codex_exec`（exec）、`codex-tui`（交互式）、review 仍走 exec=`codex_exec`。**最直接的入口识别** |
| `User-Agent` | header | `codex_exec/0.137.0 (Ubuntu 24.4.0; x86_64) WezTerm/...`：含**版本/OS/终端** |
| `x-codex-installation-id` | body `client_metadata` | `b5430d73-…`：**每安装稳定**，跨所有场景不变 → 机器/装机维度的身份 |
| `session-id` / `thread-id` | header | 会话级 id（uuid v7），跨轮稳定，== body `prompt_cache_key` |
| `x-codex-window-id` | header | `<session-id>:0`，窗口/pane 维度 |
| `x-codex-beta-features` | header | 启用的 beta 开关，如 `terminal_resize_reflow` |
| `x-codex-turn-metadata` | header(JSON) | **信息最密集**：`{session_id, thread_id, thread_source, turn_id, sandbox, request_kind, turn_started_at_unix_ms, window_id}` |
| `Authorization` | header | Bearer（来自 `env_key`），mock 不校验 |

**四级粒度（来自 `x-codex-turn-metadata`，实测验证）**：`安装(installation_id) → 会话(thread_id) → 轮(turn_id) → 请求`。
- 场景 09（函数闭环 2 请求）：`thread_id` 与 **`turn_id` 都相同** → 同一逻辑轮内的多次模型往返。
- 场景 10（resume 2 请求）：`thread_id` 相同、**`turn_id` 不同** → 同一会话的两个独立轮。
- `request_kind`（实测恒为 `turn`，另有 compact 等）可用于区分"正常轮 / 上下文压缩 / 标题生成"等请求，分别路由；`sandbox`(=`seccomp`) 暴露执行后端。

### 3.2 「开了什么功能」——能力类（body `tools[]`）

- 基线 **11** 个工具：`exec_command, write_stdin, update_plan, get_goal, create_goal,
  update_goal, request_user_input, apply_patch(custom型), view_image, tool_search, web_search`。
- 功能开关直接增减 `tools[]`：
  - `--disable goals` → 移除 `get_goal/create_goal/update_goal`（11→8）。
  - **review agent** 工具集收缩到 6 个（再去掉 `tool_search/web_search`），且 `instructions`
    完全换成 review 专用提示（21335字 → 6419字）。
- 工具类型混合：多数是 `function`，`apply_patch` 是 `custom`，`tool_search`/`web_search` 是各自专属类型。
- ⇒ **网关可直接用 `tools[]` 集合 + `instructions` 指纹判定"这是哪类 Agent、开了哪些能力"**。

### 3.3 「亲和性 key」——缓存/粘性路由（body `prompt_cache_key`）

- `prompt_cache_key` == 会话 `session_id` == header `thread-id`（uuid v7，时间有序）。
- **会话内跨轮稳定**：场景 09（函数闭环 2 请求）、10（resume 2 请求）两次请求的 key **完全一致**；
  `resume` 即使是新进程也**保留**同一 key。
- **每新会话唯一**：01–08 各自不同。
- 与 `turn_id` 配合：`thread_id` 做**亲和/粘性**（粗粒度、跨轮稳定），`turn_id` 做**单轮追踪/去重**（细粒度）。
- 因为 `store=false`（见 3.6），Codex **每轮重发全部上下文**，`prompt_cache_key` 是**唯一稳定的
  跨轮句柄** → 是做 **KV-cache 亲和 / 会话粘性路由** 的天然 key。

### 3.4 推理类（body `reasoning` / `include`）

- `reasoning.effort`：实测 `minimal / low / medium / high / xhigh` 均有效。
- `reasoning.summary`：恒为 `auto`。
- `include`：恒为 `["reasoning.encrypted_content"]` —— Codex 要求**回显加密推理内容**以支持多轮推理续接。
  **推理引擎必须支持原样存取/回传该字段**，否则多轮会退化。

### 3.5 输出模式类（body `text`）

- `text.verbosity`：恒为 `low`。
- `text.format`：仅在 `--output-schema` 时出现，值为 `json_schema`（携带传入的 schema）→ 结构化输出 Hint。

### 3.6 对话形态类（body `input`）

- `input` 是 Responses API item 数组，类型实测包含：`message`(role=developer/user/assistant)、
  `function_call`、`function_call_output`、以及 message 内容块 `input_text` / `input_image`。
- **developer 消息**承载系统级上下文：权限/沙箱说明（随 `-s` 变化）、skills 列表等。
  沙箱模式只改这里的文本，不改顶层 `instructions`。
- 函数调用闭环（09）：`function_call(update_plan)` → 本地执行 → 下一请求带 `function_call_output:"Plan updated"`。

### 3.7 恒定字段（可作为 Codex 流量的指纹）

`store=false`、`stream=true`、`parallel_tool_calls=true`、`tool_choice="auto"`、`wire_api=responses`。

---

## 4. 对推理引擎/亲和性优化的建议

1. **会话粘性路由**：以 `prompt_cache_key`（+ `x-codex-installation-id` 兜底）作为一致性哈希 key，
   把同一会话的多轮请求**粘到同一副本**，最大化 KV-cache 复用。`store=false` 决定了这是唯一可靠 key。
2. **按 Agent 类型选择引擎策略**：用 `originator` + `tools[]` 指纹 + `instructions` 长度/特征，
   区分「编码主 agent / review agent / 交互式」等，分别匹配并发、显存、推测解码等配置。
3. **必须支持加密推理回显**：尊重 `include=["reasoning.encrypted_content"]`，存储并在下一轮原样返回，
   否则多轮推理质量下降。
4. **reasoning.effort 作为算力档位 Hint**：minimal↔xhigh 可直接映射到不同的推理预算/批调度优先级。
5. **结构化输出**：见到 `text.format=json_schema` 时走约束解码路径。
6. **能力感知预热**：`tools[]` 暴露了本会话会用到的功能（如 web_search/apply_patch），可据此预取/预热相关子系统。

---

## 5. 异常与注意事项

- **extractHints 曾认错 header 名（已修复）**：mock 的便捷摘要最初按 `session_id/conversation_id/openai-beta`
  取值，而 Codex 实际用连字符的 `session-id/thread-id` 与 `x-codex-turn-metadata`，导致**摘要里这些字段显示
  `null`**。注意：**原始 headers/body 一直是全量落盘的**（每条记录的 `.headers`/`.body`），数据无丢失，受影响的只是
  `.hints` 摘要；已在 `mock-server.js` 修正为正确字段并解析 turn-metadata（用旧日志离线复跑验证通过）。
- **bubblewrap 缺失**：read-only/workspace-write 沙箱会告警"找不到 bubblewrap，使用内置版"。不影响发请求。
- **`-c tools.web_search=false` 无效**（场景 08）：关 web_search 需另寻配置/feature，按功能精确建模时注意。
- **图片需合法**：客户端会校验图片，CRC 损坏的 PNG 会被**降级成一段 input_text 错误说明**而非 `input_image`
  （首次用错误 PNG 复现过，换 zlib 生成的合法 PNG 后正常）。
- **变长参数 `-i` 会吞 prompt**：`-i file` 要放在 prompt 之后。
- **`review --uncommitted` 不能再带 PROMPT**；交互式顶层 `codex` 不认 `--skip-git-repo-check`（exec 专属）。
- 首次交互式运行会写入 `~/.codex/config.toml` 的 `[projects."…"] trust_level="trusted"`（信任目录）。

---

## 6. 日志位置

- 每场景请求全量：`logs/<场景>.requests.jsonl`（一行一个请求，含完整 headers+body）
- 每场景 codex 输出：`logs/<场景>.stdout.txt`
- 场景请求计数：`logs/INDEX.txt`（1-13）、`logs/INDEX-ctx.txt`（14-22）
- 横向对比：`node summarize.js`
- 运行时主日志：`codex-requests.jsonl`

---

# 第二部分 · 上下文管理专项（场景 14-22）

> 目标：第一部分 13 个场景的 `request_kind` **全是 `turn`**，只压了"正常对话轮"。本部分专门探索
> Codex 的**上下文管理核心特性**（压缩 / 注入 / 截断 / 血缘 / 记忆），并经一轮**对抗式复核**（W2）定稿。
> 执行脚本 `run-ctx-scenarios.sh`，索引 `logs/INDEX-ctx.txt`。

## 7. 覆盖评估与结果总表

第一部分覆盖了单轮结构、resume 重放、review 子代理、工具闭环、沙箱/结构化/图片/交互式，但
**上下文管理维度几乎空白**。本批补齐后，关键指标的取值空间被显著扩大：

- **`request_kind`**：`turn` → 新增 **`compaction`**（S18）、**`memory`**（S20）。
- **`model`**：`gpt-5.5-codex` → 新增 **`gpt-5.4-mini`**（记忆抽取）、**`gpt-5.4`**（记忆整合）。**Codex 按链路复用多个模型。**

| # | 场景 | 请求数 | request_kind 序列 | 结果 |
|---|---|---|---|---|
| 14 | AGENTS.md 注入 | 1 | turn | ✅ 折叠进 user 消息 |
| 15 | --add-dir 工作区根 | 1 | turn | ✅ 改 environment_context |
| 16 | fork 血缘 | 2 | turn,turn | ✅ 全新身份+复制历史 |
| 17 | auto-compaction（客户端估算路径） | 3 | turn,turn,turn | ⚠️ **未触发**（见 §11） |
| 18 | compaction（API-usage 路径） | 5 | turn,**compaction**,turn,**compaction**,turn | ✅ 抓到压缩请求 |
| 19 | 工具输出截断（小/大限额） | 2 / 2 | turn,turn | ✅ 截断标记 |
| 20 | memories | 5 | turn,**memory**,**memory**,turn,turn | ✅ 多模型+子代理（非确定性，重置记忆状态后干净复现，见 §11） |
| 21 | 请求压缩开关 | 2 | turn,turn | ⚠️ wire 无差异（边界） |
| 22 | archive/unarchive | 0 | — | ✅ 0 模型请求 |

## 8. 核心发现

### 8.1 压缩 Compaction（S18）—— 本批最重要
- **触发**：靠上一轮 API 上报的 `usage.total_tokens` 越过 `model_auto_compact_token_limit`（本测用 mock 的
  `__MOCK_BIGUSAGE__` 把 usage 伪造成 190000、阈值压到 500 强制触发）。
- **识别方式**：**只能靠 header `x-codex-turn-metadata`**——`request_kind="compaction"`，且带一个权威指纹子对象：
  `compaction = {trigger:"auto", reason:"context_limit", implementation:"responses", phase:"pre_turn", strategy:"memento"}`。
  **`strategy=memento` 直接暴露压缩算法名**。URL 仍是普通 `/v1/responses`（**没有独立 /compact 端点**，`is_compact_endpoint` 从未命中）。
- **请求形态**：压缩请求 **`tools=[]`（0 工具）**、**`parallel_tool_calls=false`**，但 `instructions` 与普通 turn
  **逐字相同**（md5 一致、21335 字）、采样参数（reasoning/verbosity/include/store/stream/model）也完全一致。
- **亲和性**：**压缩全程 `thread_id` 与 `prompt_cache_key` 不变** → **压缩不会让会话缓存亲和性失效**。
- **压缩与其后 turn 共享 `turn_id`**，但 `window_id` 末尾序号递增（:0→:1→:2）。
  ⇒ 按"一轮一请求"统计须用 `(request_kind, window_id)`，否则会把 compaction 和真实 turn 合并计数。
- **本地明文路径**：非 OpenAI(mock/Bearer) provider 下，压缩后把摘要以 **user 角色明文消息**注入下一轮，
  固定引导模板 `"Another language model started to solve this problem and produced a summary..."`（实测含我们的
  `SUMMARIZE_SENTINEL_18`）。**注意**：`compact_prompt` 不是请求体里的独立字段，而是作为最后一条 user 消息出现。

### 8.2 fork 血缘（S16）
- fork 产生**全新** `session_id` + `thread_id` + `prompt_cache_key`（三者互等但均≠父）→ **相对父会话缓存亲和性断裂**。
- 但 turn-metadata 带 **`forked_from_thread_id` 回指父 thread** → 血缘可重建。
- fork **把父转录复制进 input**（`input_items` 3→7）→ 内容与父高度重复但缓存全冷 ⇒ **可借父会话 KV-cache 暖启动**的优化点。
- 两套血缘通道并存：**fork 用 body 的 `forked_from_thread_id`；子代理（review/memory）用 header `x-codex-parent-thread-id`**。

### 8.3 memory 多模型链路（S20）
> ⚠️ **非确定性触发**：memory 后台请求依赖"存在未处理的 rollout"——已处理的 rollout 被 `~/.codex/memories_1.sqlite`
> 标记后不再重抽，故同一状态下重跑会只剩 `[turn,turn]`。**重置记忆状态后已干净复现** `[turn,memory,memory,turn,turn]`
> （当前提交的 S20 log 即此干净工件，已被 W2 逐字段复核）。下列字段值来自该捕获。

- `request_kind="memory"` 的**后台请求**：模型 **`gpt-5.4-mini`**、**0 工具**、系统提示 `"## Memory Writing Agent: Phase 1"`、
  单条 user input、带结构化输出 `text.format=codex_output_schema {rollout_summary, rollout_slug, raw_memory}`，
  且其 turn-metadata **几乎为空**（无 session/thread/turn id）——是**游离的后台抽取请求**。
- 记忆**整合**走子代理：header `x-openai-subagent=memory_consolidation`、`x-openai-memgen-request=true`、模型 `gpt-5.4`。
- 开 `dedicated_tools` 后主轮多出 **`memories`（type=namespace）** 工具（含 add_ad_hoc_note/list/read/search 子工具），工具数 11→12，
  beta 标志多出 `memories`。
- ⇒ **同一 Agent 多模型复用**：`(request_kind, model, effort, verbosity, instructions_len)` 构成可哈希的**链路指纹**，
  推理引擎可据此把"主对话/记忆抽取/记忆整合"分流到不同底座与优先级队列。

### 8.4 项目上下文注入（S14 / S15）
- **AGENTS.md**：以 **user 角色**注入，包裹头 `"# AGENTS.md instructions for <cwd>"` + `<INSTRUCTIONS>…`；
  **`input_items` 仍是 3**（折叠进既有 user 项、与 environment_context 串接，**不新增 item**）；`instructions` 字段不变（21335）。
- **--add-dir**：只在 `environment_context`（input[1]）的 `<workspace_roots>` 里多出一个 `<root>/tmp</root>`（逐字 diff 仅 +17 字符），
  **不读文件内容、不新增 item**。两者形成对照：一个改文本、一个也只改文本但语义不同。

### 8.5 工具输出截断（S19）
- `tool_output_token_limit` 控制超长工具输出嵌入历史的体积：**保头 + 保尾、中间以 `…N tokens truncated…` 省略**。
- 小限额 50 → `function_call_output` 约 **259** 字符；大限额 200000 → 约 **40160** 字符（原始 ~1.2MB 仍被截）。
- 富结构头：`Chunk ID / Wall time / Process exited with code / Original token count: 322224 / Total output lines`。

## 9. 新增的 Agent Hint 信号（W2 复核挖出，已并入 `extractHints`）

这些是第一部分**遗漏、但对"识别 Agent / 做亲和性"价值很高**的信号：

| 信号 | 位置 | 用途 |
|---|---|---|
| `x-openai-subagent` | header | **直接的子代理类型**（`review` / `memory_consolidation`），比 originator 推断更准 |
| `x-openai-memgen-request` | header | 标记记忆生成链路 |
| `x-codex-parent-thread-id` | header | 子代理父血缘（与 fork 的 forked_from 并存的另一通道） |
| `x-codex-turn-metadata.compaction` | header(JSON) | 压缩指纹 `{trigger,reason,implementation,phase,strategy}` |
| `x-codex-turn-metadata.forked_from_thread_id` | header(JSON) | fork 血缘回指 |
| `x-codex-turn-metadata.workspaces` | header(JSON) | **git 仓库身份**：origin URL + commit hash + has_changes（跨会话识别同一项目/用户） |
| `text.format=codex_output_schema` | body | 记忆链路的结构化输出契约 |

## 10. 对推理引擎的增量建议

1. **一级路由用 `request_kind`**：`turn` / `compaction` / `memory` 各自有独立的 model/工具/采样指纹，分流到不同模型与缓存域。
2. **压缩亲和性免疫**：`compaction` 请求保持同一 `prompt_cache_key`，可继续粘在同一副本，复用 KV-cache。
3. **子代理识别优先看 header**：`x-openai-subagent` 直接给类型，无需从 instructions/tools 反推。
4. **fork 暖启动**：见到 `forked_from_thread_id` 时，新 thread 内容≈父 thread，可用父的 KV-cache 预热而非冷启。
5. **项目级亲和**：`workspaces.origin + commit` 可把"同一仓库的不同会话"聚到相近节点。
6. **计费/调度分层**：memory 链路用 `gpt-5.4-mini`，可走低优先级/低成本队列；主 turn 用 `gpt-5.5-codex` 高优先级。
7. **统计口径**：聚合"一轮"须用 `(request_kind, window_id)`，不能只用 `turn_id`（compaction 与其 turn 共享 turn_id）。

## 11. 重要局限与未覆盖（如实标注）

**数据质量警告（mock 环境固有）**：
- **S17 未真正触发压缩**：3 个请求全是 `turn`、无任何 compaction 元数据，只观测到上下文增长（content-length 涨到 ~522KB）。
  **真正的压缩证据全部来自 S18**，且 S18 是用 `__MOCK_BIGUSAGE__` **伪造 usage** 强制触发的。
  → **结论**：在 0.137 + mock 下，**API 上报的 `total_tokens` 路径**会触发压缩；**单纯大回复撑字节的客户端估算路径**在 3 轮内未触发。
- **压缩只验证了"协议骨架"**：因 mock 对摘要 prompt 只回固定 `pong`，**注入的"摘要"是空壳**，且 memento 策略把
  原始消息+摘要+重追加的 developer/env 一起塞回，**历史体积反而单调增长（3→5→7）**，未观测到真实的"压缩后体积下降"。
- **S21 wire 零信号**：开/关 `enable_request_compression` 两请求字节级相同（content-length 同为 42202、无 content-encoding）。
  该特性受 ChatGPT-auth + 官方 provider 门控，**mock/Bearer 下不可复现**；若是 HTTP 传输层压缩，mock 抓取层也看不到。
- **请求日志只含请求**（不含响应/usage）：压缩触发判据（total_tokens 越限）**无法从请求字段直接证实**，仅由 mock 构造 + stdout 间接一致。
- **memory 请求 input 泄露真实磁盘路径**（`/home/niaowuuu/.codex/sessions/…/rollout-*.jsonl`），且 cwd 大小写不一致（`/mnt/d/workspace` vs `/mnt/d/Workspace`）。
- **S20 memory 请求非确定性**：memory 后台抽取只在"有未处理 rollout"时触发，`~/.codex/memories_1.sqlite` 把 rollout 标记处理后
  同状态重跑只剩 `[turn,turn]`。**已在授权下重置记忆状态（备份后移走 `~/.codex/memories` 与 `memories_1.sqlite`）一次命中、干净复现**
  `[turn,memory,memory,turn,turn]`，当前提交的 S20 log 即此工件。
  但因 mock 对摘要 prompt 只回 `pong`，`~/.codex/memories/rollout_summaries` 为空、`raw_memories.md`="No raw memories"——
  即记忆**抽取链路被真实触发并落了状态库，但抽取内容是空壳**（同压缩，只验证了链路骨架，未验证真实记忆质量）。

**仍未覆盖、值得后续补的上下文管理特性**：
- **真实自然阈值的 auto-compaction**（非伪造 usage），以观察 `trigger` 是否出现 `auto` 以外取值、真实摘要的体积与结构。
- **含工具调用/reasoning 的历史的压缩**：本测 input 全是纯 message，未看 memento 如何折叠 `function_call`/`reasoning.encrypted_content`。
- **记忆"读取/命中"回流**：只测了记忆生成与整合，未抓到 `memories.search/read` 命中后把记忆注入后续 turn 的请求。
- **多代理 spawn 与其他子代理类型**（explore/plan 等）：tool_search 描述提到 "Spawn and manage sub-agents"，未专门测。
- **多级 fork / fork+compaction 叠加 / 多次连续压缩的水位线行为**。
- **手动 `/compact`**（TUI）与非 `memento` 策略、非 `pre_turn` 阶段的取值空间。

---

# 第三部分 · 研究驱动补测（场景 23-30）

> 基于 `CONTEXT-MGMT-RESEARCH.md`（/deep-research 工作流，官方文档+源码）落地的 8 个补测场景，
> 脚本 `run-ctx-scenarios2.sh`，索引 `logs/INDEX-ctx2.txt`。**实测过程中对研究/直觉做了多处修正**。

## 12. 结果总表

| # | 特性 | 结果 | 关键证据 |
|---|---|---|---|
| 23 | AGENTS.md 层级/覆盖 | ✅ 证实 | `AGENTS.override.md` 遮蔽同目录 `AGENTS.md`（ROOT sentinel 不出现）；子目录(更近 cwd)的 CHILD 比根的 OVERRIDE **更靠后**(@9924 > @9893) |
| 24 | AGENTS.md 32 KiB 预算 | ✅ 证实 | 40KB 文件注入被截到 ~32768 字节预算，START 在、**END 被截掉** |
| 25 | 绝对 token 阈值 | ✅ 证实 | usage **50000 与 500000 都触发 compaction**（阈值是绝对 token，非百分比） |
| 26 | memento 折叠语义 | ✅✅ 精确证实 | 压缩**请求**带完整历史(含 function_call/output)去摘要；压缩**后**的下一轮 input **只剩 message、工具调用被丢弃**；压缩请求含 handoff 模板(CHECKPOINT/resume the task) |
| 27 | model_context_window bug | ⚠️ **未复现** | 设 window=200000 + usage=200000 仍触发 compaction——mock 直接上报 usage **绕过了** codex 内部 `fill_to_context_window` 的 delta 重算路径，故该 bug 复现不出 |
| 28 | auto_compact scope | ✅ **修正研究** | scope 合法值是 **`total` / `body_after_prefix`**（非研究猜的 session/thread；错值报 `unknown variant`）；两者都触发压缩 |
| 29 | memory 双向开关 | 🔶 部分 | `extract_model=gpt-5.4` **生效**(memory 请求模型 mini→5.4)；但 `generate_memories=false` **仍冒出 memory**(后台在处理积压 rollout，非当前线程)；`use_memories` 无可见注入(记忆内容是 mock 空壳) |
| 30 | 子代理 spawn 血缘 | ✅ 证实 | `--enable multi_agent_v2` 暴露 spawn_agent(16工具)；mock 回 spawn_agent → 子代理请求带 **`x-codex-parent-thread-id`=父thread** + **`x-openai-subagent=collab_spawn`**，与 fork 的 `forked_from_thread_id` 是两套独立血缘 |

## 13. 对研究/直觉的实测修正（重要）

- **`model_auto_compact_token_limit_scope`** 取值是 **`total` / `body_after_prefix`**，不是 session/thread。
- **`spawn_agent` 工具仅在 `--enable multi_agent_v2` 下暴露**（默认 11 工具里没有；`enable_fanout` 则给 `spawn_agents_on_csv`）；
  参数是 `task_name`+`message`(均 **string**)，`fork_turns` 是**可选 string**(传 boolean 会报 `expected a string`)；
  `task_name` 只能**小写字母/数字/下划线**(含连字符报错)。
- **memento 的"丢弃工具调用"** 发生在压缩**之后**的保留历史里，而非压缩请求本身——压缩请求仍带全量历史供摘要。
- **`model_context_window` 静默失效 bug 复现不出**：它依赖 codex 内部把 last_token_usage 重算成近零 delta；
  我们用 mock 直接上报 usage 触发压缩，不经过那条路径，所以触发照常。**反过来印证**：真正踩坑的是"设了 model_context_window 让 codex 自己算 token"的场景，而非我们的 mock 触发法。

## 14. 仍未解决/值得继续

- 真实 `fill_to_context_window` 路径下复现 model_context_window bug（需让 codex 自己累积 token，而非 mock 报 usage）。
- memory 的**读取回流**：需要 `~/.codex/memories` 里有**真实**记忆内容（非 mock pong 空壳），才能看 use_memories 把记忆注入新 session 的 input。
- 子代理 `fork_turns` 的取值语义（string，但具体取值空间未知）与 `wait_agent` 驱动下子代理的完整往返。
