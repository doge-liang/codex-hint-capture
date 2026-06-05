# 面向 Agent 请求的推理引擎 — 综合落地设计（锚定 Codex CLI 0.137 实际暴露信号）

> 目标 agent：OpenAI Codex CLI 0.137（走 Responses API，`POST /v1/responses`）。
> 全部结论锚定在本仓库 `/mnt/d/Workspace/project/codex` 已实测的信号上（`mock-server.js:extractHints`、`logs/*.requests.jsonl`、`REPORT.md`），并按 NVIDIA Dynamo（KVBM / KV-Router / SLA-Planner / nvext.agent_hints）与学术（KVFlow / Autellix / Parrot / vLLM-LTR）机制做消费侧映射。
> **本次实读核验过的关键事实**（用于校准研究 JSON 的少量出入）：
> - `prompt_cache_key == thread_id == session_id`（实测 6 个不同会话文件全 `match=true`，uuid v7 时间有序）。
> - `store=false`、`stream=true`、`include=["reasoning.encrypted_content"]`、`tool_choice=auto`、`parallel_tool_calls=true`、请求体**无** `temperature/top_p`。
> - 请求体**无任何 top-level 输出长度字段**：`max_tokens` 0 命中；`max_output_tokens` 的命中全部来自 `tools[].parameters.properties.max_output_tokens`（那是 `exec_command` 工具自己 arg 的 JSON Schema 描述，**不是**请求级输出预算）；`osl/deadline/priority` 均 0 命中 → **OSL/SLO/优先级必须引擎侧推导**。
> - 请求体**无** `cached_tokens`（`cached_tokens` 0 命中）→ KV 命中是**响应侧 usage** 字段，请求侧拿不到 → 须引擎侧测量。
> - `turn-metadata` 键全集（跨全部 log union）：`{session_id, thread_id, thread_source, turn_id, request_kind, window_id, sandbox, turn_started_at_unix_ms, compaction, forked_from_thread_id, parent_thread_id, subagent_kind, workspaces}`。其中 **`workspaces` 这个键存在但值数组恒为空**（git origin/commit 项目身份当前未捕获到）。
> - `request_kind ∈ {turn, compaction, memory}`；`subagent_kind ∈ {review, thread_spawn}`，header `x-openai-subagent ∈ {review, memory_consolidation, collab_spawn}`；`compaction` 子键 `{trigger, reason, implementation, phase, strategy}`。
> - 模型全集：`gpt-5.5-codex / gpt-5.5 / gpt-5.4 / gpt-5.4-mini`；`effort ∈ {minimal, low, medium, high, xhigh}`（实测 turn=high、memory=low、memory_consolidation=medium）。

---

## (A) Codex 信息收集规格

下面对三类能力逐条列：**需要什么信号 → Codex 在哪暴露 → 状态 → 引擎怎么用**。状态四档：`已抓取` / `需补采`（mock 已能抓但当前数据集没覆盖/字段空） / `需引擎侧测量`（Codex 协议层不可能给，必须在推理引擎自测） / `Codex不暴露`。

### 能力1 — KVCache 主动管理（预加载/驱逐）

| 信号 | Codex 暴露处 | 状态 | 引擎用法 |
|---|---|---|---|
| 会话亲和 key（KV 复用句柄） | body `prompt_cache_key`（== `thread-id` header == turn-metadata `thread_id`，uuid v7） | 已抓取 | 一致性哈希粘性路由到固定 worker，最大化 device prefix overlap（对标 Dynamo KvIndexer/RadixTree + `--router-kv-overlap-score-credit`；学术对标 Autellix program-ID 局部性）。`store=false` 下这是**唯一**跨轮稳定句柄。 |
| 稳定前缀身份（system+工具 schema 是否可 pin） | body `instructions`（md5 指纹，baseline 21335 字 md5=`14c501c2`）+ `tools[]`（集合+type，逐字稳定） | 已抓取 | 对“instructions+tools”这段恒定前缀做 TTL pin（对标 Dynamo `cache_control{ephemeral, ttl}` / SGLang `--radix-eviction-policy priority`），防工具调用空隙被驱逐。 |
| 会话内是否还在同一逻辑轮（避免误驱逐） | header `x-codex-turn-metadata.turn_id`（同轮多次模型往返 turn_id 不变；不同轮变）+ `window_id`（`<thread>:N`，N 随 compaction 递增） | 已抓取 | 同 turn_id 的 function-call 闭环视为一次连续上下文，pin 不释放；window_id 序号区分“压缩后新窗口” vs “真新轮”，避免压缩把暖 KV 误判为可驱逐。 |
| 压缩是否破坏缓存亲和 | turn-metadata `request_kind=compaction` + `compaction{trigger:auto, reason:context_limit, implementation:responses, phase:pre_turn, strategy:memento}`；压缩全程 `prompt_cache_key` 不变 | 已抓取 | 压缩请求继续 pin 同副本 KV（亲和性免疫）；`strategy` 暴露压缩算法名可用于预测压缩后前缀形态。 |
| KV 暖启动血缘（父会话/子代理 KV 预热） | turn-metadata `forked_from_thread_id`（fork）、`parent_thread_id`、`subagent_kind`；header `x-codex-parent-thread-id`、`x-openai-subagent` | 已抓取 | 见到血缘即把父 thread 的前缀 KV 从 CPU/SSD onboard 到子会话目标 worker（对标 KVFlow prefetch / Dynamo speculative_prefill）。 |
| 该会话将用到哪些能力（预热子系统） | body `tools[]`（type/name：function/custom/web_search/tool_search/namespace） | 已抓取 | tools 集合判定开了什么功能 → 预热对应 KV 域（如 memories namespace、web_search）。 |
| 项目级亲和（同 repo 跨会话） | turn-metadata `workspaces[].{origin, commit, has_changes}` | 需补采（键在、值空） | 若能 populate（疑需 ChatGPT-auth/官方 provider 或特定配置），可做项目级 KV 亲和；当前**不能据此路由**。 |
| 实际 KV 命中率 / 命中 token 数 | — | 需引擎侧测量 | 请求侧无 `cached_tokens`（实测 0 命中）；对标 Dynamo `kvbm_host/disk_cache_hit_rate`、`kvbm_matched_tokens` 须在引擎侧采。 |
| 真实可复用前缀长度（决定 pin/swap/重算边界） | 间接：`store=false` 每轮重发全 `input[]`（实测 09 轮 input_items 3→5 单调增）+ tool_output 截断标记 `…N tokens truncated…` | 需引擎侧测量 | 请求侧只给“重发了多少 item”，真实 token 级前缀匹配长度须引擎 tokenizer + RadixTree 算。 |
| encrypted reasoning 对 KV 复用的影响 | body `include=["reasoning.encrypted_content"]`（契约存在，但 mock 从不回 → input[] 里 0 个 reasoning-item） | 需补采 | 真实上游必须原样回传该字段否则多轮退化；其体积/对前缀连续性的影响须在带真实响应的环境标定。 |

### 能力2 — Agent 状态感知调度（执行图 / 预取重叠 / decode 长度 / DP 均衡）

| 信号 | Codex 暴露处 | 状态 | 引擎用法 |
|---|---|---|---|
| 一级分流（工作负载类型） | turn-metadata `request_kind ∈ {turn, compaction, memory}` + body `model ∈ {gpt-5.5-codex, gpt-5.5, gpt-5.4, gpt-5.4-mini}` | 已抓取 | turn→主线高优 GPU/缓存域；memory→`gpt-5.4-mini` 低优队列；compaction→同 cache_key 粘同副本。直接映射 Dynamo `nvext.agent_hints.priority` / `agent_context.session_type_id`。 |
| Agent 类型画像（区分 baseline/review/memory-extract/memory-consolidate） | 链路指纹 `(request_kind, model, reasoning.effort, text.verbosity, instructions_md5, x-openai-subagent)`；实测 4 个不同 md5 干净区分 | 已抓取 | 按指纹分桶维护历史经验分布（OSL/到达间隔），做画像驱动的调度先验。 |
| 算力档 / decode 预算先验 | body `reasoning.effort ∈ {minimal,low,medium,high,xhigh}`（随 kind 变：turn=high、memory=low、consolidation=medium）；`reasoning.summary=auto` | 已抓取 | effort 当 OSL/算力档位的**强先验**（minimal→短、xhigh→长），喂给 Dynamo decode Load 的 osl 分数权重（对标 vLLM-LTR 相对排序 / Response-Length-Perception）。 |
| 输出形态先验（约束解码 / 输出长度倾向） | body `text.verbosity ∈ {low(turn), medium(memory)}`；`text.format.type=json_schema`（如 memory 的 `codex_output_schema{rollout_summary,rollout_slug,raw_memory}`） | 已抓取 | verbosity 作 OSL 弱先验；见 json_schema 走约束/引导解码路径、OSL 更可预测（结构化输出长度近似有界）。 |
| 实测 ISL（输入长度，免预测） | body `input[]` item 数（实测单调增）+ raw body 字节（content-length 可达 ~522KB），`store=false` 全量重发 | 已抓取（可直接量） | 直接在网关量出 ISL，无需 Dynamo 的 next_isl 预测器，误差预算全留给 OSL。 |
| 执行图 / 多轮依赖（producer→consumer 闭环） | body `input[]`：`function_call`(10) ↔ `function_call_output`(10) 配对 + role(developer/user/assistant)；turn-metadata `turn_id`（同轮往返不变） | 已抓取 | 重建轻量执行图（对标 Parrot GetProducer/GetConsumers DAG、KVFlow steps-to-execution）：function_call 下发→工具执行→resume，可识别 prefill/decode 重叠窗口做预取。 |
| 工具往返时序（预测下一请求到达，做预取重叠） | 跨请求 `turn_started_at_unix_ms`（turn-metadata）+ mock 落盘时间戳 `time` | 已抓取（时间戳）/ 需补采（分布） | 学 per-(agent,tool) 的 think→tool→resume 时间分布，提前 onboard 该会话前缀，与当前 decode 重叠（对标 KVFlow prefetch / Dynamo speculative_prefill）。当前数据是离线单跑，到达分布需多会话补采。 |
| 前台/后台优先级（user-facing vs background） | header `x-openai-subagent`、turn-metadata `subagent_kind`、`request_kind=memory` + `x-openai-memgen-request=true` | 已抓取 | user turn 先于 background memory 跑（对标 Dynamo BinaryHeap 让前台请求“显得更早到”）。 |
| 真实 decode 输出长度（OSL 真值，校准 effort→OSL 映射） | — | 需引擎侧测量 | 请求体无 OSL 字段（实测确认）；mock 日志只含请求不含响应/usage，OSL 真值须在引擎侧采 output_tokens 标定。 |
| TTFT / TPOT(ITL) / 队列时延（agent 时延归因） | — | 需引擎侧测量 | Codex 协议层无；须引擎/网关打点（首 token 时刻、token 间隔）。 |
| DP 各 worker 负载（sum_prefill_tokens / sum_decode_kv_tokens） | — | 需引擎侧测量 | 对标 Dynamo ForwardPassMetrics；引擎侧采集做 DP 均衡。 |

### 能力3 — SLO 感知调度（有/无 hint 下选 swap/pin/重算）

| 信号 | Codex 暴露处 | 状态 | 引擎用法 |
|---|---|---|---|
| SLO 分级（construct per-request SLO-class） | **派生**自 `(reasoning.effort, request_kind, model, subagent)`：minimal/low→紧 TTFT，high/xhigh→宽 ITL 高 OSL；turn 严、memory/compaction 松 | 已抓取（原料）/ 需引擎侧合成（SLO-class 本身） | Dynamo 原生只有全局 `ttft_ms/itl_ms` 两标量，无 per-request SLO-class；须网关侧用 Codex hint 合成 SLO-class 再注入（对标 Parrot Performance Objective）。 |
| 优先级（队列排序 / 优先级驱逐） | **派生**自 request_kind + effort + subagent（Codex 不发 `priority`，实测 0 命中） | Codex不暴露（须派生） | 派生后注入 `nvext.agent_hints.priority` → SGLang `--enable-priority-scheduling` / `--radix-eviction-policy priority`。 |
| pin vs swap vs 重算 的 KV-在不在判据 | `prompt_cache_key` 跨轮稳定 + compaction 亲和免疫 + `window_id` 序号 | 已抓取（启发原料） | 同 ptc 副本上 KV 大概率还在 → pin/复用优于重算；这是“swap-vs-recompute”启发式的输入。 |
| 重算长度边界（可复用前缀长度） | `store=false` 全量重发 + tool_output 截断标记 `…N tokens truncated…` + input_items 计数 | 已抓取（粗）/ 需引擎侧测量（精） | 粗估可复用前缀；精确 token 级边界须引擎 RadixTree。 |
| deadline / SLA 截止时间 | — | Codex不暴露 | 请求体无 deadline（实测 0 命中）；若要 deadline 语义须在 priority 之上自叠（Dynamo 也无一等 deadline 字段）。 |
| 无-hint 兜底亲和 | header `originator ∈ {codex_exec, codex-tui}`、body `client_metadata.x-codex-installation-id`（装机级稳定）、`instructions_md5` | 已抓取 | 拿不到细粒度 hint 时用 installation-id 做粗亲和、md5 反推 agent 类型；最末退化对标 Dynamo ApproxKvIndexer 120s TTL（用最近路由历史近似命中）。 |
| 真实 SLO 达成 / goodput（闭环反馈） | — | 需引擎侧测量 | 须引擎侧采 TTFT/TPOT + SLO attainment 做闭环。 |
| 压缩触发真值（token 水位线） | `request_kind=compaction` 暴露“已触发”这一事实；但 `usage.total_tokens` 只在响应 | 已抓取（事件）/ 需引擎侧测量（水位） | 压缩“已发生”可从请求读，触发判据（token 水位）须引擎侧自测。 |

**一句话总览**：Codex 直接给的是**身份/亲和/画像/算力档**（`prompt_cache_key`、`request_kind`、`tools[]`+`instructions_md5`、`reasoning.effort`、`text.*`、血缘），引擎侧必须自测的是**性能与命中真值**（真实 OSL、TTFT/TPOT、KV 命中率、DP 负载、SLO 达成、token 水位）。所有 Dynamo `nvext.agent_hints`（priority/osl）与 SLO-class 都是**网关侧从前者合成**，引擎无需理解 Codex 协议。

---

## (B) 分层测试台架构

总体五层。**复用现有**：mock-server.js（抓 hint + 回假 SSE）、`extractHints`、`logs/*.requests.jsonl`、`summarize.js`、`test/*.test.js`（node:test 零依赖回归）。**新建**：重放器、引擎适配层、策略注入点、指标层。

### ① Trace 采集层（已有，几乎不动）
- **复用**：`mock-server.js` 的 HTTP 入口 + `extractHints`（header+body 全量落盘 JSONL）+ `MODE=proxy` 透传记录。这一层已能逐请求抓全 Codex 信号。
- **新建（小）**：在落盘 meta 里补 `recv_unix_ms`（接收时刻，用于重放到达时序）、`raw_body_bytes`（量 ISL）。当前 `time` 是 ISO 字符串，加一个毫秒整数字段即可。

### ② Trace 重放层（新建，核心）
- 角色：把 `logs/*.requests.jsonl` 转成可复现负载，带**到达时序 / 多轮依赖 / 会话亲和**。
- **新建 `replay/codex-to-mooncake.js`**：把抓到的 trace 转成 **Mooncake JSONL**（业界标准 trace-replay 格式，AIPerf 原生支持）：
  - `timestamp ← recv_unix_ms`（相对首请求；可按倍速过载）
  - `session_id ← prompt_cache_key`（会话亲和，对齐 Mooncake `session_id`）
  - `input_length ← 实测 input 字节/token`（ISL 直接量，不预测）
  - `output_length ← effort→OSL 经验分布采样`（先用先验，真值标定后回填）
  - `hash_ids ← 对全量重发 input 按 512-token 块做前缀哈希`（控制 prefix 重叠率/KV 可复用）
  - `priority ← 由 (request_kind,effort,subagent) 派生`
- **新建会话/血缘还原器**：用 `turn_id` 串同一轮的 function-call 闭环、用 `forked_from_thread_id/parent_thread_id` 还原 fork/子代理依赖边（producer→consumer），保证重放时严格因果序（对标 AIPerf User-Centric Timing + session_id 因果排序）。
- **复用**：`summarize.js` 的逐请求指纹抽取逻辑直接迁过来做分桶。

### ③ 引擎适配层（新建）
- 角色：把重放流量打到**被测系统**。两条腿：
  - **腿 A：真实引擎**（vLLM / SGLang / Dynamo）。把 Codex hint 翻译成 `nvext.agent_context/agent_hints/cache_control` 注入下游（schema 已是 Dynamo 现成）。**复用** mock 的 `MODE=proxy`：扩成 `MODE=engine`，落盘记录的同时转发到真实引擎 base_url。
  - **腿 B：what-if 模拟器**（Vidur）做低成本扫调度/批/并行参数。**注意盲区**：Vidur 不支持 prefix-cache / KV-aware routing / 多轮 → **能力1 和能力3 涉 KV 复用的结论必须回真实引擎复验**，模拟器只配能力2/3 的纯调度 what-if。
- **新建 hint→nvext 翻译器**（网关中间件）：`prompt_cache_key→session_id/cache_control`、`(request_kind,effort,subagent)→priority`、`effort/verbosity→osl`、血缘→speculative_prefill 触发。

### ④ 策略注入点（新建）
- 角色：可插拔策略钩子，A/B 对照“被动基线 vs Codex-hint 驱动”。
- **KV 策略**：pin（cache_control.ttl）/ swap（onboard-offload）/ recompute（及重算长度）。基线=纯 LRU/无预取；实验=`prompt_cache_key`+血缘驱动主动预加载/驱逐（对标 KVFlow workflow-aware eviction）。
- **路由策略**：基线=random/round-robin / 一致性哈希；实验=KV-aware（overlap+load）+ request_kind 一级分流。对标 Dynamo `--router-mode`、`--router-kv-overlap-score-credit`、`--router-temperature`。
- **预取策略**：基线=无；实验=血缘/工具时序驱动 speculative_prefill。
- **SLO 调度**：基线=FCFS；实验=派生 priority 队列 + swap/pin/重算启发式。
- **复用**：mock 的 sentinel 机制（`__MOCK_TOOL__/__MOCK_BIGUSAGE__/__MOCK_CTXEXCEED__`）作策略触发开关原型。

### ⑤ 指标与评测层（新建）
- 角色：统一口径出 TTFT / TPOT(ITL) / e2e / goodput / KV命中 / SLO达成。
- **照搬 GenAI-Perf/AIPerf 口径**（避免自定义不可比）：`ITL=(e2e−TTFT)/(out_tokens−1)`、`goodput=单位时间内满足全部 SLO 约束的请求数`（`--goodput 'time_to_first_token:500'`）。
- **会话级聚合（新建后处理）**：agent 真正关心的是“整 turn/整会话”端到端时延，AIPerf 现成 goodput 只到单请求 → 须在 `session_id(=prompt_cache_key)` 维度自写聚合。
- **避坑**：用 **smooth goodput**（TPOT deadline 相对**首 token** 而非逐 token 相对前一 token），防“延迟投递平滑 tail”“丢请求刷 goodput”退化（arXiv 2410.14257）。
- **KV 命中判据**：黑盒=同会话 turn0 vs turn1+ 的 TTFT 下降；白盒=引擎侧 `kvbm_*cache_hit_rate`/`matched_tokens`。
- **复用**：`test/*.test.js` 的 node:test 框架做指标计算单测 + trace 不变式回归（如 `ptc==thread` 断言）。

---

## (C) 落地路线（分阶段）

### 阶段 0（1 周，纯 mock，零引擎）— 信号闭环 + trace 资产化
- **能验证**：信号采集完整性（不变式回归：`ptc==thread==session`、request_kind/effort/血缘分桶）、hint→nvext 翻译器正确性（纯函数单测）、Codex→Mooncake 转换器。
- **产物**：可复现 Mooncake trace 库 + 翻译器 + 指标计算库（全部 node:test 覆盖）。
- **当前数据足够**：因为这些都不需要真实响应。

### 阶段 1（2–3 周，mock + 模拟器）— what-if 扫调度（非 KV 部分）
- **能验证**：能力2/3 的纯调度/批/优先级队列策略（用 Vidur 扫 request-rate/concurrency）；effort→OSL 先验 + request_kind 一级分流对**调度延迟**的影响；开环(goodput)/闭环(饱和吞吐)双模式。
- **必须接真实引擎的部分（明确不做）**：任何 KV 命中/prefix 复用/会话亲和结论（Vidur 盲区）。
- **数据缺口**：OSL 先验此时仍是 effort 假设，需阶段 2 标定。

### 阶段 2（接真实引擎，4–6 周）— KV + 亲和 + SLO 真测
- **何时接**：当要验证“能力1 主动 KV 管理收益”“能力3 swap/pin/重算”“DP 负载均衡”——这些都依赖真实 KV 命中/TTFT/TPOT，**mock 测不了**。
- **首选 SGLang/Dynamo**（RadixAttention/KVBM 有现成 hit-rate 指标 + nvext schema）。
- **做的事**：① 用 `MODE=engine` 把 Codex（或重放 trace）打到真实引擎，注入 nvext hint；② 标定 effort→OSL 真值分布（采 output_tokens），回填阶段 0 的 trace；③ A/B：被动 LRU vs `prompt_cache_key`+血缘主动预取/pin；random vs KV-aware 路由；FCFS vs 派生 priority + swap/pin/重算；④ 采 `kvbm_*` 指标 + TTFT/TPOT 做闭环。
- **数据缺口补齐**：KV 命中真值、TTFT/TPOT、DP 负载、SLO 达成全部在此阶段获得。

### 阶段 3（强化，持续）— 闭环学习 + 项目级亲和
- 用阶段 2 标注数据训练 per-桶 OSL/到达预测器（ARIMA/Kalman，对标 Dynamo Load Predictor）；
- 若 `workspaces` 字段能 populate（需补采），加项目级 KV 亲和；
- 引入 Dynamo correction-factor 式在线校准 + smooth-goodput 主指标。

**贯穿原则**：mock 平台能独立验证“信号正确性 + 调度逻辑 + trace 重放”；**一旦结论依赖真实 KV 命中或真实 OSL/延迟，必须接真实引擎**——这是 mock 的硬边界（mock 不产生 token、不维护真实 KV、不回 usage）。


---

## 附录 D · 信息收集规格(结构化, 30 条)

| 能力 | 信号 | Codex 暴露处 | 状态 | 引擎用法 |
|---|---|---|---|---|
| KV管理 | prompt_cache_key (== thread-id == session-id, uuid v7, store=false 下唯一跨轮亲和 key) | body.prompt_cache_key / header thread-id / turn-metadata.thread_id | 已抓取 | 一致性哈希粘性路由到固定 worker 最大化 device prefix overlap，对标 Dynamo KvIndexer/RadixTree + --router-kv-overlap-score-credit |
| KV管理 | 稳定前缀身份 instructions_md5(baseline 21335字 md5=14c501c2) + tools[] 集合(逐字稳定) | body.instructions / body.tools[].{type,name} | 已抓取 | 对 instructions+tools 恒定前缀做 TTL pin，对标 Dynamo cache_control{ephemeral,ttl} / SGLang --radix-eviction-policy priority，防工具空隙被驱逐 |
| KV管理 | turn_id(同轮多次往返不变)/window_id(<thread>:N, N随compaction递增) | header x-codex-turn-metadata.turn_id / window_id | 已抓取 | 同 turn_id 闭环 pin 不释放；window_id 序号区分压缩后新窗口 vs 真新轮，避免误驱逐暖 KV |
| KV管理 | compaction 事件 + 亲和免疫(压缩全程 ptc 不变) | turn-metadata.request_kind=compaction + compaction{trigger,reason,implementation,phase,strategy:memento} | 已抓取 | 压缩请求继续 pin 同副本 KV；strategy 暴露压缩算法名预测压缩后前缀形态 |
| KV管理 | 血缘(fork/子代理/spawn)做 KV 暖启动 | turn-metadata.{forked_from_thread_id,parent_thread_id,subagent_kind} / header x-codex-parent-thread-id / x-openai-subagent | 已抓取 | 见血缘即把父 thread 前缀 KV 从 CPU/SSD onboard 到子会话 worker，对标 KVFlow prefetch / Dynamo speculative_prefill |
| KV管理 | 会话将用到的能力集合(预热子系统) | body.tools[] (function/custom/web_search/tool_search/namespace) | 已抓取 | 按 tools 集合预热对应 KV 域(如 memories namespace) |
| KV管理 | 项目级亲和 git origin/commit/has_changes | turn-metadata.workspaces[].{origin,commit,has_changes} | 需补采 | 键存在但值数组实测恒为空，当前不能据此项目级路由；若 populate(疑需 ChatGPT-auth/官方 provider)可做项目级 KV 亲和 |
| KV管理 | 真实 KV 命中率 / 命中 token 数 | 无(请求体无 cached_tokens，实测 0 命中；为响应侧 usage 字段) | 需引擎侧测量 | 引擎侧采 kvbm_host/disk_cache_hit_rate、kvbm_matched_tokens 做收益评估与闭环 |
| KV管理 | 真实可复用前缀长度(pin/swap/重算边界) | 间接: store=false 全量重发 input[](input_items 单调增) + tool_output 截断标记 …N tokens truncated… | 需引擎侧测量 | 请求侧只给重发 item 数，token 级前缀匹配长度须引擎 tokenizer+RadixTree 算 |
| KV管理 | encrypted reasoning 回显对 KV 复用影响 | body.include=[reasoning.encrypted_content] (契约存在但 mock 从不回，input[] 0 个 reasoning-item) | 需补采 | 真实上游须原样回传否则多轮退化；体积/前缀连续性影响须带真实响应环境标定 |
| 状态感知调度 | 一级分流 request_kind + model | turn-metadata.request_kind∈{turn,compaction,memory} + body.model∈{gpt-5.5-codex,gpt-5.5,gpt-5.4,gpt-5.4-mini} | 已抓取 | turn→高优GPU/缓存域; memory→gpt-5.4-mini低优队列; compaction→粘同副本。映射 Dynamo nvext.agent_hints.priority / agent_context.session_type_id |
| 状态感知调度 | Agent 类型画像链路指纹(4个干净 md5 区分) | 派生(request_kind,model,reasoning.effort,text.verbosity,instructions_md5,x-openai-subagent) | 已抓取 | 按指纹分桶维护历史 OSL/到达间隔经验分布做调度先验 |
| 状态感知调度 | 算力档/decode 预算先验 reasoning.effort(随kind变:turn=high,memory=low,consolidation=medium) | body.reasoning.effort∈{minimal,low,medium,high,xhigh} + reasoning.summary=auto | 已抓取 | effort 当 OSL/算力档强先验喂 Dynamo decode Load osl 权重，对标 vLLM-LTR 相对排序 |
| 状态感知调度 | 输出形态先验 verbosity/json_schema | body.text.verbosity∈{low(turn),medium(memory)} + text.format.type=json_schema(codex_output_schema) | 已抓取 | verbosity 作 OSL 弱先验; 见 json_schema 走约束解码且 OSL 更可预测 |
| 状态感知调度 | 实测 ISL(免预测) | body.input[] item 数(单调增) + raw body 字节(可达~522KB), store=false 全量重发 | 已抓取 | 网关直接量 ISL，无需 Dynamo next_isl 预测器，误差预算全留 OSL |
| 状态感知调度 | 执行图/多轮依赖(producer→consumer 闭环) | body.input[] function_call↔function_call_output 配对 + role(developer/user/assistant) + turn_id 同轮不变 | 已抓取 | 重建轻量执行图(对标 Parrot DAG / KVFlow steps-to-execution)识别 prefill/decode 重叠窗口做预取 |
| 状态感知调度 | 工具往返时序(预测下一请求到达) | 跨请求 turn_started_at_unix_ms(turn-metadata) + mock 落盘时间戳 | 需补采 | 学 per-(agent,tool) think→tool→resume 分布提前 onboard 前缀与 decode 重叠; 当前离线单跑, 到达分布需多会话补采 |
| 状态感知调度 | 前台/后台优先级 | header x-openai-subagent / turn-metadata.subagent_kind / request_kind=memory + x-openai-memgen-request=true | 已抓取 | user turn 先于 background memory 跑，对标 Dynamo BinaryHeap 让前台请求显得更早到 |
| 状态感知调度 | 真实 decode 输出长度(OSL 真值) | 无(请求体无 OSL 字段; mock 日志只含请求不含响应/usage) | 需引擎侧测量 | 引擎侧采 output_tokens 标定 effort→OSL 映射 |
| 状态感知调度 | TTFT/TPOT(ITL)/队列时延 | 无(Codex 协议层不暴露) | 需引擎侧测量 | 引擎/网关打点首token时刻与token间隔做 agent 时延归因 |
| 状态感知调度 | DP 各 worker 负载 | 无 | 需引擎侧测量 | 采 sum_prefill_tokens/sum_decode_kv_tokens(对标 Dynamo ForwardPassMetrics)做 DP 均衡 |
| SLO调度 | SLO 分级原料(派生 SLO-class) | 派生(reasoning.effort,request_kind,model,subagent): minimal/low→紧TTFT; high/xhigh→宽ITL高OSL; turn严 memory/compaction松 | 需引擎侧测量 | Dynamo 原生仅全局 ttft_ms/itl_ms 标量, 须网关用 Codex hint 合成 per-request SLO-class 再注入(对标 Parrot Performance Objective) |
| SLO调度 | 优先级 priority(Codex 不发, 须派生) | 派生 request_kind+effort+subagent (body 无 priority, 实测 0 命中) | Codex不暴露 | 派生后注入 nvext.agent_hints.priority → SGLang --enable-priority-scheduling / --radix-eviction-policy priority |
| SLO调度 | pin vs swap vs 重算的 KV-在不在判据 | prompt_cache_key 跨轮稳定 + compaction 亲和免疫 + window_id 序号 | 已抓取 | 同 ptc 副本 KV 大概率还在→pin/复用优于重算, 作 swap-vs-recompute 启发输入 |
| SLO调度 | 重算长度边界(可复用前缀长度) | store=false 全量重发 + tool_output 截断标记 …N tokens truncated… + input_items 计数 | 需引擎侧测量 | 粗估可复用前缀; 精确 token 级边界须引擎 RadixTree |
| SLO调度 | deadline/SLA 截止时间 | 无(请求体无 deadline, 实测 0 命中) | Codex不暴露 | 须在 priority 之上自叠 deadline 语义(Dynamo 亦无一等 deadline 字段) |
| SLO调度 | 无-hint 兜底亲和 | header originator∈{codex_exec,codex-tui} / body client_metadata.x-codex-installation-id(装机级稳定) / instructions_md5 | 已抓取 | 拿不到细粒度 hint 时用 installation-id 粗亲和、md5 反推 agent 类型; 最末退化对标 Dynamo ApproxKvIndexer 120s TTL |
| SLO调度 | 真实 SLO 达成/goodput | 无 | 需引擎侧测量 | 采 TTFT/TPOT + SLO attainment 做闭环, 用 smooth goodput 防丢请求刷分 |
| SLO调度 | 压缩触发真值(token 水位线) | request_kind=compaction 暴露已触发事实; usage.total_tokens 只在响应 | 需引擎侧测量 | 压缩已发生可从请求读, 触发判据(token 水位)须引擎侧自测 |
| 通用 | 恒定指纹识别 Codex 流量 | body store=false/stream=true/tool_choice=auto/parallel_tool_calls=true/无temperature,top_p; header originator,user-agent(含版本/OS/终端); x-codex-beta-features∈{terminal_resize_reflow[,memories]}; sandbox=seccomp | 已抓取 | 识别并归类 Codex 流量, 作画像与一级路由前置过滤 |

## 附录 E · 必须引擎侧测量/推导的缺口(11)

- 真实 decode 输出长度(OSL 真值): 请求体无 top-level 输出长度字段(实测确认 max_tokens 0命中; max_output_tokens 命中全部来自 tools[].parameters JSON Schema 描述, 非请求级预算; osl 0命中), mock 日志只含请求不含响应/usage → 须引擎侧采 output_tokens 才能标定 effort/verbosity/request_kind → OSL 的映射分布
- KV 命中率与命中 token 数: 请求体无 cached_tokens(实测 0命中, 为响应侧 usage 字段) → 须引擎侧 kvbm_host/disk_cache_hit_rate、kvbm_matched_tokens
- token 级真实可复用前缀长度: 请求侧只给重发 input_items 数与 tool_output 截断标记, 精确前缀匹配长度须引擎 tokenizer + RadixTree(决定 pin/swap/重算边界与重算长度)
- TTFT / TPOT(ITL) / 排队时延: Codex 协议层完全不暴露, 须引擎或网关打点(首 token 时刻、token 间隔、入队/出队时刻)
- DP 各 worker 实时负载(sum_prefill_tokens / sum_decode_kv_tokens / queued_requests): 对标 Dynamo ForwardPassMetrics, 须引擎侧采集
- SLO 达成 / goodput: 须引擎侧采 TTFT/TPOT + per-session 聚合, 用 smooth goodput(相对首 token 的 TPOT deadline)
- 压缩触发的 token 水位线: usage.total_tokens 只在响应; request_kind=compaction 只暴露已触发事实, 触发阈值须引擎侧自测
- 工具往返到达时序分布: turn_started_at_unix_ms 与落盘时间戳已抓但当前是离线单跑, per-(agent,tool) think→tool→resume 分布须多会话/并发场景补采
- encrypted_content 回显的真实多轮 input: mock 从不回加密推理(input[] 0 个 reasoning-item), 其体积与对前缀连续性的影响须带真实响应的环境标定
- 项目级身份(workspaces git origin/commit/has_changes): turn-metadata.workspaces 键存在但值数组实测恒为空, 须先复现 populate(疑需 ChatGPT-auth/官方 provider 或特定配置)才能做项目级亲和
- priority / deadline / SLO-class: Codex 完全不发(实测 priority、deadline 0命中), 全部须网关侧从 (effort,request_kind,model,subagent) 合成后注入下游

## 附录 F · 测试台组件(5)

| 层 | 角色 | 复用/新建 |
|---|---|---|
| ① Trace 采集层 | 逐请求抓全 Codex header+body 信号并落盘 JSONL | 复用: mock-server.js HTTP 入口 + extractHints + MODE=proxy 透传记录 + logs/*.requests.jsonl。新建(小): 落盘 meta 补 recv_unix_ms(毫秒到达时刻, 现仅 ISO time) 与 raw_body_bytes(量 ISL) |
| ② Trace 重放层 | 把 trace 转可复现负载, 带到达时序/多轮依赖/会话亲和 | 新建: replay/codex-to-mooncake.js 转 Mooncake JSONL(session_id←prompt_cache_key, timestamp←recv_unix_ms, input_length←实测字节, output_length←effort→OSL先验, hash_ids←512-token块前缀哈希, priority←派生) + 会话/血缘还原器(turn_id 串闭环, forked_from/parent_thread_id 还原依赖边)。复用: summarize.js 的指纹抽取做分桶 |
| ③ 引擎适配层 | 把重放流量打到被测系统(真实引擎或模拟器) | 新建: 腿A 真实引擎(vLLM/SGLang/Dynamo)+ hint→nvext 翻译器(prompt_cache_key→session_id/cache_control, (request_kind,effort,subagent)→priority, effort/verbosity→osl, 血缘→speculative_prefill); 腿B Vidur what-if(注意 prefix-cache/KV-aware/多轮盲区, 只配纯调度扫参)。复用: mock 的 MODE=proxy 扩成 MODE=engine 边记录边转发 |
| ④ 策略注入点 | 可插拔 KV pin/swap/recompute、路由、预取、SLO 调度策略, A/B 对照 | 新建: KV策略(pin via cache_control.ttl / swap / recompute) + 路由(random|round-robin|KV-aware + request_kind 一级分流) + 预取(血缘/工具时序驱动 speculative_prefill) + SLO(派生 priority 队列 + swap/pin/重算启发式)。复用: mock 的 sentinel 机制(__MOCK_TOOL__/__MOCK_BIGUSAGE__/__MOCK_CTXEXCEED__)作策略触发开关原型 |
| ⑤ 指标与评测层 | 统一口径出 TTFT/TPOT/e2e/goodput/KV命中/SLO达成 | 新建: 照搬 AIPerf 口径 ITL=(e2e-TTFT)/(out-1) + goodput; per-session(=prompt_cache_key) 端到端聚合后处理; smooth goodput(相对首token的TPOT deadline 防退化); KV命中黑盒(turn0 vs turn1+ TTFT)与白盒(引擎 kvbm_*)。复用: test/*.test.js node:test 框架做指标单测 + trace 不变式回归(如 ptc==thread 断言) |

## 附录 G · 待决策(7)

- OSL 来源策略: effort+request_kind+verbosity 当先验已确定, 但 minimal..xhigh 各档与各 request_kind 桶的真实 OSL 分布需在真实引擎标定(阶段2)才能从假设升为可靠 hint; 在此之前 Mooncake output_length 用先验采样会引入偏差
- SLO-class 与 priority 的具体映射系数(effort/request_kind → ttft_ms/itl_ms 档位 + priority 整数)目前无实测支撑, 需用阶段2 真实 TTFT/TPOT 反推, 否则是拍脑袋常数
- 真实引擎选型(SGLang vs Dynamo vs vLLM): SGLang RadixAttention + agentic-workloads flags(priority/eviction/spec-prefill)落地最细但仅 SGLang; Dynamo nvext schema 最全但部分 agent_hints 字段可能仍是博客级前瞻; 需按目标引擎核对 KV 事件字段语义(跨引擎不一致, TRT-LLM parent_hash 曾有 bug)
- Mooncake hash_ids 与引擎实际分块是否对齐: store=false 全量重发逐字节高度重叠, 但中途动态注入(env_context/AGENTS.md/截断标记)会打断前缀连续性 → 按 hash_ids 估的命中率可能高于真实, 须用引擎侧 hit-rate 校验
- workspaces 项目级亲和是否值得投入: 该字段当前恒空, 复现 populate 的条件(ChatGPT-auth/官方 provider/特定配置)未知, 决定阶段3 是否纳入项目级路由
- Vidur 盲区边界: 已确认不支持 prefix-cache/KV-aware/多轮 → 需明确划线哪些实验(能力1全部、能力3的KV相关)禁用模拟器只走真实引擎, 避免误用模拟器结论
- encrypted_content 回显契约: mock 不回加密推理导致无法评估其对 KV 复用/多轮的真实影响; 是否需要在 proxy 模式接真实上游采一批带响应的 trace 来标定


> 生成自 deep-research workflow(6 agents, ~46万 tokens)，来源含 NVIDIA Dynamo 官方文档/源码、KVFlow/Autellix/Parrot 论文、AIPerf/Vidur 方法学；结论锚定本仓库实测 Codex 信号。
