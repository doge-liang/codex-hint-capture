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

  return {
    // 「哪个 Agent」—— 主要靠请求头识别（注意 Codex 用连字符: session-id / thread-id）
    originator: h['originator'] || null,
    user_agent: h['user-agent'] || null,
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
    request_kind: turnMeta.request_kind || null,   // turn / compact / ...
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
  console.log(`    Agent     : originator=${hints.originator}  ua=${hints.user_agent}`);
  console.log(`    身份层级   : install=${hints.installation_id}  thread=${hints.thread_id}  turn=${hints.turn_id}`);
  console.log(`    会话       : session_id=${hints.session_id}  request_kind=${hints.request_kind}  sandbox=${hints.sandbox}  beta=${hints.beta_features}`);
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

function respondMockStream(res, reqBody) {
  const respId = shortId('resp');
  const msgId = shortId('msg');
  const model = (reqBody && reqBody.model) || 'mock-model';
  const text = MOCK_REPLY;
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
      usage: {
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

// ── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mode: MODE, port: PORT }));
    return;
  }

  // Codex 把 base_url 拼上 /responses；这里宽松匹配任何以 /responses 结尾的路径。
  const isResponses = req.method === 'POST' && /\/responses\/?$/.test(url.split('?')[0]);

  let chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks);
    let body = null;
    try { body = JSON.parse(rawBody.toString('utf8') || '{}'); } catch { body = { _unparsed: rawBody.toString('utf8') }; }

    if (isResponses) {
      const hasToolOutput = Array.isArray(body.input) && body.input.some((i) => i && i.type === 'function_call_output');
      const wantTool = JSON.stringify(body).includes('__MOCK_TOOL__');
      const mockResponse = MODE === 'proxy' ? 'proxy' : wantTool && !hasToolOutput ? 'function_call' : 'text';

      const hints = extractHints(req.headers, body);
      const headersForLog = { ...req.headers, authorization: redactAuth(req.headers['authorization']) };
      logRequest({ time: nowIso(), method: req.method, url, scenario: process.env.MOCK_SCENARIO || null, mock_response: mockResponse, has_tool_output: hasToolOutput, headers: headersForLog, hints, body });

      if (MODE === 'proxy') return proxyToUpstream(req, res, rawBody);
      if (mockResponse === 'function_call') return respondMockFunctionCall(res, body);
      return respondMockStream(res, body);
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

module.exports = { extractHints };
