'use strict';
// Tier 1 回归：进程内起 mock server，验证各 sentinel 的 HTTP/SSE 响应。无需 codex。
const os = require('node:os');
const path = require('node:path');
// 在 require mock-server 前把日志导到临时文件，避免污染 codex-requests.jsonl。
process.env.LOG_FILE = path.join(os.tmpdir(), `mock-http-test-${process.pid}.jsonl`);
process.env.MODE = 'mock';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../mock-server.js');

let base;
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
// 强制关掉 fetch(undici) 留下的 keep-alive 连接，避免进程带着 open handle 退出——
// 否则 node:test 在 teardown 时偶发 "Unable to deserialize cloned data"(IPC 损坏)。
after(() => {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
});

async function post(text, extra = {}) {
  const r = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ model: 'm', stream: true, input: [{ role: 'user', content: [{ type: 'input_text', text }] }], ...extra }),
  });
  return { status: r.status, text: await r.text() };
}

test('GET /health → {ok:true}', async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test('默认 → 合法 Responses SSE(created + completed + output_text)', async () => {
  const { text } = await post('hi');
  assert.match(text, /event: response\.created/);
  assert.match(text, /event: response\.completed/);
  assert.match(text, /output_text/);
});

test('__MOCK_BIGUSAGE__ → usage.total_tokens=190000', async () => {
  assert.match((await post('x __MOCK_BIGUSAGE__')).text, /"total_tokens":190000/);
});

test('__MOCK_USAGE:12345__ → usage.total_tokens=12345', async () => {
  assert.match((await post('x __MOCK_USAGE:12345__')).text, /"total_tokens":12345/);
});

test('__MOCK_CTXEXCEED__ → response.failed + context_length_exceeded', async () => {
  const { text } = await post('x __MOCK_CTXEXCEED__');
  assert.match(text, /event: response\.failed/);
  assert.match(text, /context_length_exceeded/);
});

test('__MOCK_TOOL__ → update_plan function_call(校验在 item.name 字段)', async () => {
  const { text } = await post('x __MOCK_TOOL__');
  assert.match(text, /"type":"function_call"/);
  assert.match(text, /"name":"update_plan"/, 'update_plan 应在 function_call 的 name 字段');
});
