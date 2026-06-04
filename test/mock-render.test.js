'use strict';
// Tier 1 回归：mock 的 SSE 响应内容(renderMockSSE 纯函数)。不起真实 server、不用 fetch，
// 零 open handle——避免 node:test 在进程内 HTTP server 下偶发的 IPC 反序列化 flaky。
// 真实 HTTP 路径由 e2e(子进程 mock)覆盖。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderMockSSE } = require('../mock-server.js');

const userMsg = (text) => ({ model: 'm', stream: true, input: [{ role: 'user', content: [{ type: 'input_text', text }] }] });
const render = (text) => renderMockSSE(userMsg(text));

test('默认 → 合法 Responses SSE(created + completed + output_text)', () => {
  const { body } = render('hi');
  assert.match(body, /event: response\.created/);
  assert.match(body, /event: response\.completed/);
  assert.match(body, /output_text/);
});

test('__MOCK_BIGUSAGE__ → usage.total_tokens=190000', () => {
  assert.match(render('x __MOCK_BIGUSAGE__').body, /"total_tokens":190000/);
});

test('__MOCK_USAGE:12345__ → usage.total_tokens=12345', () => {
  assert.match(render('x __MOCK_USAGE:12345__').body, /"total_tokens":12345/);
});

test('__MOCK_CTXEXCEED__ → response.failed + context_length_exceeded', () => {
  const { kind, body } = render('x __MOCK_CTXEXCEED__');
  assert.equal(kind, 'ctx_exceed');
  assert.match(body, /event: response\.failed/);
  assert.match(body, /"code":"context_length_exceeded"/);
});

test('__MOCK_TOOL__ → update_plan function_call(name 字段)', () => {
  const { kind, body } = render('x __MOCK_TOOL__');
  assert.equal(kind, 'function_call');
  assert.match(body, /"type":"function_call"/);
  assert.match(body, /"name":"update_plan"/);
});

test('__MOCK_EXEC__ → exec_command function_call(seq 1 200000)', () => {
  const { kind, body } = render('x __MOCK_EXEC__');
  assert.equal(kind, 'exec_command');
  assert.match(body, /"name":"exec_command"/);
  assert.match(body, /seq 1 200000/);
});

test('__MOCK_READMEM__ → exec_command cat MEMORY.md', () => {
  const { kind, body } = render('x __MOCK_READMEM__');
  assert.equal(kind, 'read_mem');
  assert.match(body, /cat ~\/\.codex\/memories\/MEMORY\.md/);
});

test('SSE 每个 data 行都是合法 JSON 且带 type 字段', () => {
  const { body } = render('hi');
  const datas = body.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  assert.ok(datas.length >= 3);
  for (const d of datas) {
    const obj = JSON.parse(d); // 不合法会抛
    assert.ok(typeof obj.type === 'string', 'data 应带 type');
  }
});
