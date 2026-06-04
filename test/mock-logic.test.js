'use strict';
// Tier 1 回归：mock 的 sentinel 决策逻辑(decideResponse 纯函数)。无需 server/codex。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decideResponse } = require('../mock-server.js');

const userMsg = (txt) => ({ input: [{ role: 'user', content: [{ type: 'input_text', text: txt }] }] });

test('默认无 sentinel → text', () => {
  assert.equal(decideResponse(userMsg('hi'), '', 'mock').kind, 'text');
});

test('__MOCK_TOOL__ → function_call', () => {
  assert.equal(decideResponse(userMsg('plan __MOCK_TOOL__'), '', 'mock').kind, 'function_call');
});

test('__MOCK_EXEC__ → exec_command', () => {
  assert.equal(decideResponse(userMsg('run __MOCK_EXEC__'), '', 'mock').kind, 'exec_command');
});

test('__MOCK_READMEM__ → read_mem', () => {
  assert.equal(decideResponse(userMsg('x __MOCK_READMEM__'), '', 'mock').kind, 'read_mem');
});

test('__MOCK_BIGUSAGE__ → text + usageTotal=190000', () => {
  const r = decideResponse(userMsg('x __MOCK_BIGUSAGE__'), '', 'mock');
  assert.equal(r.kind, 'text');
  assert.equal(r.opts.usageTotal, 190000);
});

test('__MOCK_USAGE:<n>__ → 精确 usageTotal', () => {
  assert.equal(decideResponse(userMsg('x __MOCK_USAGE:50000__'), '', 'mock').opts.usageTotal, 50000);
  assert.equal(decideResponse(userMsg('x __MOCK_USAGE:777__'), '', 'mock').opts.usageTotal, 777);
});

test('__MOCK_USAGE 优先于 __MOCK_BIGUSAGE__', () => {
  assert.equal(decideResponse(userMsg('__MOCK_BIGUSAGE__ __MOCK_USAGE:42__'), '', 'mock').opts.usageTotal, 42);
});

test('__MOCK_BIG__ → text + 精确 240000 字符', () => {
  const r = decideResponse(userMsg('x __MOCK_BIG__'), '', 'mock');
  assert.equal(r.kind, 'text');
  assert.equal(r.opts.text.length, 240000, 'LOREM x40000');
  assert.ok(r.opts.text.startsWith('LOREM '));
});

test('已知边界：非 CTXEXCEED 的 sentinel 在历史里也会触发(整 body 匹配)', () => {
  // 与 __MOCK_CTXEXCEED__ 的 lastUser 作用域【不一致】——锁定当前行为，防止未来静默漂移。
  const body = {
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'old turn __MOCK_TOOL__' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'current turn, no sentinel' }] },
    ],
  };
  assert.equal(decideResponse(body, '', 'mock').kind, 'function_call', '历史里的 __MOCK_TOOL__ 仍触发');
});

test('__MOCK_CTXEXCEED__ 仅当前轮 user 消息触发', () => {
  assert.equal(decideResponse(userMsg('x __MOCK_CTXEXCEED__'), '', 'mock').kind, 'ctx_exceed');
});

test('__MOCK_CTXEXCEED__ 在历史(非最后 user 消息)里不触发', () => {
  const body = {
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'old __MOCK_CTXEXCEED__' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'current turn no sentinel' }] },
    ],
  };
  assert.equal(decideResponse(body, '', 'mock').kind, 'text');
});

test('有 function_call_output 时不重复触发 function_call(避免死循环)', () => {
  const body = {
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '__MOCK_TOOL__' }] },
      { type: 'function_call_output', output: 'done' },
    ],
  };
  assert.equal(decideResponse(body, '', 'mock').kind, 'text');
});

test('__MOCK_SPAWN__ 仅在 spawn_agent 工具在场时触发', () => {
  assert.equal(decideResponse(userMsg('x __MOCK_SPAWN__'), '', 'mock').kind, 'text', '无工具→text');
  const withTool = { ...userMsg('x __MOCK_SPAWN__'), tools: [{ type: 'function', name: 'spawn_agent' }] };
  assert.equal(decideResponse(withTool, '', 'mock').kind, 'spawn_agent', '有工具→spawn_agent');
});

test('proxy 模式短路', () => {
  assert.equal(decideResponse(userMsg('__MOCK_TOOL__'), '', 'proxy').kind, 'proxy');
});
