#!/usr/bin/env node
// Codex -> Mock 推理引擎入口。
//
// 作用：
//   1. 接收 Codex CLI 走 Responses API 发来的 POST /v1/responses 请求；
//   2. 把请求头 + body 全量"落盘"记录（控制台 + JSONL），并抽取出我们关心的
//      Agent "Hint"（哪个 Agent / 开了什么功能 / 缓存亲和性 key 等）；
//   3. 返回一个"长得像真 OpenAI"的 Responses API SSE 流，让 Codex 不报错。
//
// 默认 mock 模式无需任何 OpenAI 凭证。想让 Codex 真正干活，设
//   MODE=proxy UPSTREAM_BASE_URL=https://api.openai.com/v1 UPSTREAM_API_KEY=sk-xxx
// 即可切到"透传 + 记录"模式（记录后转发到真实上游）。
//
// 零依赖，只用 Node 内置模块。
'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const MODE = process.env.MODE || 'mock'; // 'mock' | 'proxy'
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || 'https://api.openai.com/v1';
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY || '';
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'codex-requests.jsonl');
const MOCK_REPLY = process.env.MOCK_REPLY || 'pong (来自本地 mock 推理引擎)';

// ── 工具函数 ────────────────────────────────────────────────────────────────
function nowIso() {
  return new Date().toISOString();
}

function shortId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 12);
}

function redactAuth(value) {
  if (!value) return value;
  const s = String(value);
  if (s.length <= 14) return s.slice(0, 6) + '…';
  return s.slice(0, 12) + '…(' + (s.length - 12) + ' more)';
}

// 从请求头 + body 里抽取我们做亲和性优化最关心的 Agent Hint。
function extractHints(headers, body) {
  const h = headers || {};
  const b = body && typeof body === 'object' ? body : {};

  // tools = "这个 Agent 开了什么功能"。逐个取出类型/名字。
  const tools = Array.isArray(b.tools)
    ? b.tools.map((t) => {
        if (!t || typeof t !== 'object') return String(t);
        if (t.type === 'function') return 'function:' + (t.name || t.function?.name || '?');
        if (t.type) return t.type; // web_search / local_shell / mcp / ...
        return t.name || '?';
      })
    : [];

  const instructions = typeof b.instructions === 'string' ? b.instructions : '';

  // Codex 把丰富的层级信息放在 x-codex-turn-metadata（一段 JSON 字符串）里。
  let turnMeta = {};
  try { turnMeta = JSON.parse(h['x-codex-turn-metadata'] || '{}'); } catch { turnMeta = {}; }

  // workspaces 里藏着 git 仓库身份（origin/commit/脏状态）—— 跨会话识别同一项目的强标识。
  const ws = Array.isArray(turnMeta.workspaces) && turnMeta.workspaces[0] ? turnMeta.workspaces[0] : null;

  return {
    // 「哪个 Agent」—— 主要靠请求头识别（注意 Codex 用连字符: session-id / thread-id）
    originator: h['originator'] || null,
    user_agent: h['user-agent'] || null,
    subagent: h['x-openai-subagent'] || null,            // review / memory_consolidation —— 直接的子代理类型标签
    memgen_request: h['x-openai-memgen-request'] || null, // true 表示记忆生成链路
    beta_features: h['x-codex-beta-features'] || null,
    window_id: h['x-codex-window-id'] || null,
    client_request_id: h['x-client-request-id'] || null,
    // 「四级粒度」安装 → 会话(thread) → 轮(turn) → 请求
    //  - session_id/thread_id：会话级，跨轮稳定（= prompt_cache_key）
    //  - turn_id：轮级，逐轮变化（同一轮的多次模型往返保持一致）
    session_id: h['session-id'] || turnMeta.session_id || null,
    thread_id: h['thread-id'] || turnMeta.thread_id || null,
    thread_source: turnMeta.thread_source || null,
    turn_id: turnMeta.turn_id || null,
    request_kind: turnMeta.request_kind || null,   // turn / compaction / memory ...
    // 血缘：fork 用 body-metadata 的 forked_from_thread_id；子代理用 header 的 parent-thread-id（两套并存）
    forked_from_thread_id: turnMeta.forked_from_thread_id || null,
    parent_thread_id: h['x-codex-parent-thread-id'] || null,
    // compaction 子对象：{trigger, reason, implementation, phase, strategy} —— 压缩请求的权威指纹
    compaction: turnMeta.compaction || null,
    // 项目身份（来自 turn-metadata.workspaces）
    workspace_origin: ws?.associated_remote_urls?.origin ?? null,
    workspace_commit: ws?.latest_git_commit_hash ?? null,
    workspace_has_changes: ws?.has_changes ?? null,
    sandbox: turnMeta.sandbox || null,             // seccomp / ...
    turn_started_at_unix_ms: turnMeta.turn_started_at_unix_ms || null,
    // 「开了什么功能 / 配置」—— 主要靠 body 字段
    model: b.model ?? null,
    reasoning: b.reasoning ?? null,           // { effort, summary }
    text_verbosity: b.text?.verbosity ?? null,
    text_format: b.text?.format?.type ?? null,
    tools,
    tool_choice: b.tool_choice ?? null,
    parallel_tool_calls: b.parallel_tool_calls ?? null,
    include: b.include ?? null,
    store: b.store ?? null,
    stream: b.stream ?? null,
    // 「缓存亲和性」—— 这是给推理引擎做 KV-cache 亲和路由的天然 key
    prompt_cache_key: b.prompt_cache_key ?? null,
    installation_id: b.client_metadata?.['x-codex-installation-id'] ?? null,
    // 上下文规模
    instructions_len: instructions.length,
    instructions_head: instructions.slice(0, 160),
    input_items: Array.isArray(b.input) ? b.input.length : null,
  };
}

function logRequest(meta) {
  const hints = meta.hints;
  const line = '─'.repeat(72);
  console.log('\n' + line);
  console.log(`📥  ${meta.time}  ${meta.method} ${meta.url}`);
  console.log(`    场景      : ${meta.scenario || '-'}   mock_response=${meta.mock_response}  has_tool_output=${meta.has_tool_output}`);
  console.log(`    Agent     : originator=${hints.originator}  subagent=${hints.subagent || '-'}  ua=${hints.user_agent}`);
  console.log(`    身份层级   : install=${hints.installation_id}  thread=${hints.thread_id}  turn=${hints.turn_id}`);
  console.log(`    会话       : request_kind=${hints.request_kind}  sandbox=${hints.sandbox}  beta=${hints.beta_features}`);
  if (hints.compaction) console.log(`    压缩       : ${JSON.stringify(hints.compaction)}`);
  if (hints.forked_from_thread_id || hints.parent_thread_id) console.log(`    血缘       : forked_from=${hints.forked_from_thread_id || '-'}  parent_thread=${hints.parent_thread_id || '-'}`);
  if (hints.workspace_origin) console.log(`    项目       : ${hints.workspace_origin} @${(hints.workspace_commit || '').slice(0, 8)} changes=${hints.workspace_has_changes}`);
  console.log(`    Model     : ${hints.model}   reasoning=${JSON.stringify(hints.reasoning)}  verbosity=${hints.text_verbosity}  text_format=${hints.text_format}`);
  console.log(`    功能(tools): [${hints.tools.join(', ')}]`);
  console.log(`    亲和性 key : prompt_cache_key=${hints.prompt_cache_key}  (== thread_id)`);
  console.log(`    上下文     : instructions=${hints.instructions_len}字  input_items=${hints.input_items}  stream=${hints.stream} store=${hints.store}`);
  console.log(`    instr.head: ${JSON.stringify(hints.instructions_head)}`);
  console.log(line);

  // 全量落盘，便于后续给推理引擎分析。
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(meta) + '\n');
  } catch (e) {
    console.error('⚠️  写入日志文件失败:', e.message);
  }
}

// ── SSE: 伪造一段合法的 Responses API 流 ────────────────────────────────────
function sse(res, type, data) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
}

// 当 prompt 里带 sentinel __MOCK_TOOL__ 时，先回一个 function_call（update_plan，
// 无副作用），借此跑通 Codex 的「函数调用 → 本地执行 → 回传 function_call_output」闭环。
function respondMockFunctionCall(res, reqBody) {
  const respId = shortId('resp');
  const fcId = shortId('fc');
  const callId = shortId('call');
  const model = (reqBody && reqBody.model) || 'mock-model';
  const args = JSON.stringify({
    explanation: 'mock 引擎下发的演示计划',
    plan: [
      { step: '解析 Agent Hint', status: 'completed' },
      { step: '做亲和性路由', status: 'in_progress' },
    ],
  });
  const fcItem = { id: fcId, type: 'function_call', status: 'completed', name: 'update_plan', call_id: callId, arguments: args };

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const baseResp = { id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), model, output: [] };

  sse(res, 'response.created', { response: { ...baseResp, status: 'in_progress' } });
  sse(res, 'response.output_item.added', { output_index: 0, item: { id: fcId, type: 'function_call', status: 'in_progress', name: 'update_plan', call_id: callId, arguments: '' } });
  sse(res, 'response.function_call_arguments.delta', { item_id: fcId, output_index: 0, delta: args });
  sse(res, 'response.function_call_arguments.done', { item_id: fcId, output_index: 0, arguments: args });
  sse(res, 'response.output_item.done', { output_index: 0, item: fcItem });
  sse(res, 'response.completed', {
    response: { ...baseResp, status: 'completed', output: [fcItem],
      usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 8, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 20 } },
  });
  res.end();
}

function respondMockStream(res, reqBody, opts = {}) {
  const respId = shortId('resp');
  const msgId = shortId('msg');
  const model = (reqBody && reqBody.model) || 'mock-model';
  // opts.text 覆盖回复正文（用于撑大上下文）；opts.usageTotal 覆盖回报的 token 数
  // （用于让 Codex 的 last_api_response_total_tokens 越过 auto-compact 阈值）。
  const text = opts.text != null ? opts.text : MOCK_REPLY;
  const message = {
    id: msgId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const baseResp = {
    id: respId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    output: [],
  };

  sse(res, 'response.created', { response: { ...baseResp, status: 'in_progress' } });
  sse(res, 'response.in_progress', { response: { ...baseResp, status: 'in_progress' } });
  sse(res, 'response.output_item.added', {
    output_index: 0,
    item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
  });
  sse(res, 'response.content_part.added', {
    item_id: msgId, output_index: 0, content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  });
  sse(res, 'response.output_text.delta', {
    item_id: msgId, output_index: 0, content_index: 0, delta: text,
  });
  sse(res, 'response.output_text.done', {
    item_id: msgId, output_index: 0, content_index: 0, text,
  });
  sse(res, 'response.content_part.done', {
    item_id: msgId, output_index: 0, content_index: 0,
    part: { type: 'output_text', text, annotations: [] },
  });
  sse(res, 'response.output_item.done', { output_index: 0, item: message });
  sse(res, 'response.completed', {
    response: {
      ...baseResp,
      status: 'completed',
      output: [message],
      usage: opts.usageTotal
        ? {
            input_tokens: opts.usageTotal - 5,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 5,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: opts.usageTotal,
          }
        : {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 5,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 15,
          },
    },
  });
  res.end();
}

// 下发一个 exec_command 的 function_call（运行会产生超长 stdout 的命令），
// 用于触发 Codex 对 function_call_output 的 tool_output_token_limit 截断。
function respondMockExecCommand(res, reqBody, cmd) {
  const respId = shortId('resp');
  const fcId = shortId('fc');
  const callId = shortId('call');
  const model = (reqBody && reqBody.model) || 'mock-model';
  // exec_command 的 cmd 是单条 shell 命令字符串；默认 seq 1 200000 产生约 1.2MB stdout。
  const args = JSON.stringify({ cmd: cmd || 'seq 1 200000', workdir: '.', yield_time_ms: 10000 });
  const fcItem = { id: fcId, type: 'function_call', status: 'completed', name: 'exec_command', call_id: callId, arguments: args };

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const baseResp = { id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), model, output: [] };
  sse(res, 'response.created', { response: { ...baseResp, status: 'in_progress' } });
  sse(res, 'response.output_item.added', { output_index: 0, item: { id: fcId, type: 'function_call', status: 'in_progress', name: 'exec_command', call_id: callId, arguments: '' } });
  sse(res, 'response.function_call_arguments.delta', { item_id: fcId, output_index: 0, delta: args });
  sse(res, 'response.function_call_arguments.done', { item_id: fcId, output_index: 0, arguments: args });
  sse(res, 'response.output_item.done', { output_index: 0, item: fcItem });
  sse(res, 'response.completed', {
    response: { ...baseResp, status: 'completed', output: [fcItem],
      usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 8, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 20 } },
  });
  res.end();
}

// 下发一个 spawn_agent 的 function_call（需 codex --enable multi_agent_v2 暴露该工具），
// 让 Codex 真的派生一个子代理，用于观察子代理请求的血缘 header(x-codex-parent-thread-id)。
function respondMockSpawnAgent(res, reqBody) {
  const respId = shortId('resp');
  const fcId = shortId('fc');
  const callId = shortId('call');
  const model = (reqBody && reqBody.model) || 'mock-model';
  // 子代理任务用无 sentinel 的普通 prompt，避免子代理再触发 spawn 造成递归。
  // 注意：0.137 的 spawn_agent 只需 task_name+message(均为 string)；fork_turns 是可选 string，此处省略。
  // task_name 只能小写字母/数字/下划线。
  const args = JSON.stringify({ task_name: 'explore_repo', message: 'Look around the repository and report the top-level files. Reply briefly.' });
  const fcItem = { id: fcId, type: 'function_call', status: 'completed', name: 'spawn_agent', call_id: callId, arguments: args };

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const baseResp = { id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), model, output: [] };
  sse(res, 'response.created', { response: { ...baseResp, status: 'in_progress' } });
  sse(res, 'response.output_item.added', { output_index: 0, item: { id: fcId, type: 'function_call', status: 'in_progress', name: 'spawn_agent', call_id: callId, arguments: '' } });
  sse(res, 'response.function_call_arguments.delta', { item_id: fcId, output_index: 0, delta: args });
  sse(res, 'response.function_call_arguments.done', { item_id: fcId, output_index: 0, arguments: args });
  sse(res, 'response.output_item.done', { output_index: 0, item: fcItem });
  sse(res, 'response.completed', {
    response: { ...baseResp, status: 'completed', output: [fcItem],
      usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 8, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 20 } },
  });
  res.end();
}

// 发一个 Responses API 的 context_length_exceeded 失败事件——Codex 据 error.code 判为
// ContextWindowExceeded，进而调 set_total_tokens_full → fill_to_context_window(毒化 token 计数)。
// 用于复现 issue #16068：设了 model_context_window 后 auto-compaction 静默失效。
function respondMockCtxExceeded(res, reqBody) {
  const respId = shortId('resp');
  const model = (reqBody && reqBody.model) || 'mock-model';
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  sse(res, 'response.created', { sequence_number: 0, response: { id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model, output: [] } });
  sse(res, 'response.failed', {
    sequence_number: 1,
    response: { id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'failed', background: false,
      error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model. Please adjust your input and try again.' },
      usage: null, metadata: {} },
  });
  res.end();
}

// ── proxy 模式：记录后转发到真实上游 ────────────────────────────────────────
function proxyToUpstream(req, res, rawBody) {
  const target = new URL(UPSTREAM_BASE_URL.replace(/\/$/, '') + '/responses');
  const headers = { ...req.headers, host: target.host };
  if (UPSTREAM_API_KEY) headers['authorization'] = 'Bearer ' + UPSTREAM_API_KEY;
  delete headers['content-length'];

  const lib = target.protocol === 'https:' ? https : http;
  const upstream = lib.request(
    target,
    { method: 'POST', headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on('error', (e) => {
    console.error('⚠️  上游请求失败:', e.message);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'upstream error: ' + e.message } }));
  });
  upstream.end(rawBody);
}

// 纯函数：根据请求体里的 sentinel 决定 mock 该回什么。抽出来便于单测。
// 返回 { kind, opts, hasToolOutput }。kind ∈ text/function_call/exec_command/read_mem/
// spawn_agent/ctx_exceed/proxy；opts 含可选的 text(撑大) 与 usageTotal(伪造用量)。
function decideResponse(body, url = '', mode = MODE) {
  if (mode === 'proxy') return { kind: 'proxy', opts: {}, hasToolOutput: false };
  const b = body && typeof body === 'object' ? body : {};
  const bodyStr = JSON.stringify(b);
  const hasToolOutput = Array.isArray(b.input) && b.input.some((i) => i && i.type === 'function_call_output');
  // __MOCK_CTXEXCEED__ 只看当前轮最后一条 user 消息，避免 resume 历史里的 sentinel 误触发。
  const lastUser = Array.isArray(b.input) ? [...b.input].reverse().find((i) => i && i.role === 'user') : null;
  const lastUserText = lastUser && Array.isArray(lastUser.content) ? lastUser.content.map((c) => c.text || '').join(' ') : '';
  const hasSpawnTool = Array.isArray(b.tools) && b.tools.some((t) => (t.name || t.type) === 'spawn_agent');
  const usageMatch = bodyStr.match(/__MOCK_USAGE:(\d+)__/);

  let kind;
  if (lastUserText.includes('__MOCK_CTXEXCEED__')) kind = 'ctx_exceed';
  else if (bodyStr.includes('__MOCK_SPAWN__') && hasSpawnTool && !hasToolOutput) kind = 'spawn_agent';
  else if (bodyStr.includes('__MOCK_READMEM__') && !hasToolOutput) kind = 'read_mem';
  else if (bodyStr.includes('__MOCK_EXEC__') && !hasToolOutput) kind = 'exec_command';
  else if (bodyStr.includes('__MOCK_TOOL__') && !hasToolOutput) kind = 'function_call';
  else kind = 'text';

  const opts = {};
  if (bodyStr.includes('__MOCK_BIG__')) opts.text = 'LOREM '.repeat(40000); // ~240KB
  if (usageMatch) opts.usageTotal = Number(usageMatch[1]);
  else if (bodyStr.includes('__MOCK_BIGUSAGE__')) opts.usageTotal = 190000;
  return { kind, opts, hasToolOutput };
}

// 纯函数：把一个请求体渲染成 mock 会回的 SSE 文本(用假 res 收集)，便于单测——
// 不起真实 HTTP server、不用 fetch，零 open handle(避免 node:test IPC flaky)。
function renderMockSSE(body, url = '/v1/responses', mode = MODE) {
  const chunks = [];
  let statusCode = 200;
  let headers = {};
  const res = {
    writeHead(code, h) { statusCode = code; headers = h || {}; },
    write(s) { chunks.push(s); },
    end(s) { if (s) chunks.push(s); },
  };
  const { kind, opts } = decideResponse(body, url, mode);
  if (kind === 'ctx_exceed') respondMockCtxExceeded(res, body);
  else if (kind === 'spawn_agent') respondMockSpawnAgent(res, body);
  else if (kind === 'read_mem') respondMockExecCommand(res, body, 'cat ~/.codex/memories/MEMORY.md');
  else if (kind === 'exec_command') respondMockExecCommand(res, body);
  else if (kind === 'function_call') respondMockFunctionCall(res, body);
  else respondMockStream(res, body, opts);
  return { kind, statusCode, headers, body: chunks.join('') };
}

// ── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mode: MODE, port: PORT }));
    return;
  }

  // Codex 把 base_url 拼上 /responses；宽松匹配 /responses 及其子路径（如 /responses/compact）。
  const isResponses = req.method === 'POST' && /\/responses(\/\w+)?\/?$/.test(url.split('?')[0]);

  let chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks);
    let body = null;
    try { body = JSON.parse(rawBody.toString('utf8') || '{}'); } catch { body = { _unparsed: rawBody.toString('utf8') }; }

    if (isResponses) {
      const { kind: mockResponse, opts, hasToolOutput } = decideResponse(body, url, MODE);
      const isCompact = /\/responses\/compact\/?$/.test(url.split('?')[0]);

      const hints = extractHints(req.headers, body);
      const headersForLog = { ...req.headers, authorization: redactAuth(req.headers['authorization']) };
      logRequest({ time: nowIso(), method: req.method, url, scenario: process.env.MOCK_SCENARIO || null, mock_response: mockResponse, has_tool_output: hasToolOutput, is_compact_endpoint: isCompact, headers: headersForLog, hints, body });

      if (mockResponse === 'proxy') return proxyToUpstream(req, res, rawBody);
      if (mockResponse === 'ctx_exceed') return respondMockCtxExceeded(res, body);
      if (mockResponse === 'spawn_agent') return respondMockSpawnAgent(res, body);
      if (mockResponse === 'read_mem') return respondMockExecCommand(res, body, 'cat ~/.codex/memories/MEMORY.md');
      if (mockResponse === 'exec_command') return respondMockExecCommand(res, body);
      if (mockResponse === 'function_call') return respondMockFunctionCall(res, body);
      return respondMockStream(res, body, opts);
    }

    // 其它路径（/models 等）：记录后给个空 200，方便发现 Codex 还摸了哪些端点。
    console.log(`ℹ️  其它请求: ${req.method} ${url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [] }));
  });
});

// 直接运行时才起服务；被 require() 时只导出函数，便于对已存日志做离线提取/测试。
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`🚀 Codex mock 推理引擎入口已启动`);
    console.log(`   地址 : http://${HOST}:${PORT}   (Codex base_url 用 http://${HOST}:${PORT}/v1)`);
    console.log(`   模式 : ${MODE}${MODE === 'proxy' ? '  →  ' + UPSTREAM_BASE_URL : '  (返回假响应，无需 OpenAI 凭证)'}`);
    console.log(`   日志 : ${LOG_FILE}`);
    console.log(`   等待 Codex 请求中… (Ctrl-C 退出)\n`);
  });
}

module.exports = { extractHints, decideResponse, renderMockSSE, server };
