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
- 场景请求计数：`logs/INDEX.txt`
- 横向对比：`node summarize.js`
- 运行时主日志：`codex-requests.jsonl`
