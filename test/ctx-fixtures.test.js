'use strict';
// Tier 1 回归：上下文管理与注入类场景(14-32 + 06/07/09/10/12)的 golden 断言。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFixture, hints, kinds, findKind } = require('./helpers.js');

const allText = (rec) => rec.body.input.flatMap((i) => i.content || []).map((c) => c.text || '').join('\n');
const fcOutputs = (recs) => recs.flatMap((m) => m.body.input).filter((x) => x && x.type === 'function_call_output');
const lastUserText = (b) => {
  const u = [...b.input].reverse().find((x) => x && x.role === 'user');
  return u && Array.isArray(u.content) ? u.content.map((c) => c.text || '').join(' ') : '';
};

test('06-sandbox：-s 只改 developer 消息的权限文本，不改顶层 instructions', () => {
  const r = loadFixture('06-sandbox-workspace-write')[0];
  const dev = r.body.input.find((i) => i.role === 'developer');
  assert.match(JSON.stringify(dev), /workspace-write/);
  assert.equal(r.body.instructions.length, 21335, 'instructions 不变');
});

test('07-output-schema：--output-schema → body.text.format.type=json_schema', () => {
  const r = loadFixture('07-output-schema')[0];
  assert.equal(r.body.text.format.type, 'json_schema');
});

test('09-tool-loop：同一逻辑轮 2 次往返 → thread_id 与 turn_id 都相同', () => {
  const recs = loadFixture('09-tool-call-loop');
  assert.equal(recs.length, 2);
  assert.equal(new Set(recs.map((m) => hints(m).thread_id)).size, 1);
  assert.equal(new Set(recs.map((m) => hints(m).turn_id)).size, 1, '同轮 turn_id 相同');
});

test('10-resume：同 thread 跨进程保留，但 turn_id 逐轮变', () => {
  const recs = loadFixture('10-multi-turn-resume');
  assert.equal(new Set(recs.map((m) => hints(m).thread_id)).size, 1, 'thread 粘性跨进程');
  assert.equal(new Set(recs.map((m) => hints(m).turn_id)).size, 2, 'turn_id 每轮不同');
});

test('12-image：-i → input 出现 input_image 内容块', () => {
  const r = loadFixture('12-image-input')[0];
  assert.ok(r.body.input.some((i) => (i.content || []).some((c) => c.type === 'input_image')));
});

test('14-AGENTS.md：折叠进 user 消息(input_items 仍 3) + 包裹头, instructions 不变', () => {
  const r = loadFixture('14-agents-md-injection')[0];
  assert.equal(r.body.input.length, 3, '不新增 item');
  assert.equal(r.body.instructions.length, 21335);
  assert.match(r.body.input[1].content[0].text, /^# AGENTS\.md instructions for /);
});

test('15-add-dir：environment_context 的 workspace_roots 多出 /tmp(2 root)；baseline 仅 1 root', () => {
  const env = allText(loadFixture('15-add-dir-workspace-roots')[0]);
  const m = env.match(/<workspace_roots>([\s\S]*?)<\/workspace_roots>/);
  assert.ok(m);
  assert.equal((m[1].match(/<root>/g) || []).length, 2);
  assert.match(m[1], /<root>\/tmp<\/root>/);
  const base = allText(loadFixture('01-baseline')[0]).match(/<workspace_roots>([\s\S]*?)<\/workspace_roots>/);
  assert.equal((base[1].match(/<root>/g) || []).length, 1);
});

test('23-AGENTS.md 层级：override 遮蔽同目录 AGENTS.md(无 ROOT)，子目录 CHILD 注入', () => {
  const t = allText(loadFixture('23-agentsmd-hierarchy')[0]);
  assert.ok(t.includes('SENTINEL_OVERRIDE_23'));
  assert.ok(!t.includes('SENTINEL_ROOT_23'), 'AGENTS.override.md 遮蔽 AGENTS.md');
  assert.ok(t.includes('SENTINEL_CHILD_23'));
});

test('24-AGENTS.md 32KiB 预算：保头丢尾，注入截到 ~32768 字节', () => {
  const t = allText(loadFixture('24-agentsmd-32kib')[0]);
  const agents = t.split('\n').reduce((a, _l) => a, t); // 整段文本
  assert.ok(agents.includes('START_SENTINEL_24'));
  assert.ok(!agents.includes('END_SENTINEL_24'), 'END 越过预算应被截掉');
  const payload = agents.match(/<INSTRUCTIONS>([\s\S]*)<\/INSTRUCTIONS>/);
  const bytes = Buffer.byteLength(payload[1], 'utf8');
  assert.ok(bytes >= 32700 && bytes <= 32800, `注入载荷应 ~32768 字节, 实际 ${bytes}`);
});

test('25-绝对 token 阈值：usage 50000 与 500000 都触发 compaction(memento)', () => {
  for (const f of ['25a-usage50k', '25-usage500k']) {
    const recs = loadFixture(f);
    assert.deepEqual(kinds(recs), ['turn', 'compaction', 'turn'], f);
    assert.equal(hints(findKind(recs, 'compaction')).compaction.strategy, 'memento');
  }
});

test('26-memento：压缩请求带工具调用历史+handoff 模板；压缩后保留历史丢弃工具调用', () => {
  const recs = loadFixture('26-memento-retention');
  const ci = recs.findIndex((r) => hints(r).request_kind === 'compaction');
  const comp = recs[ci];
  assert.ok(comp.body.input.some((i) => i.type === 'function_call'), '压缩请求带工具调用历史去做摘要');
  // 压缩请求带 handoff 提示模板(源码 compact/prompt.md)
  assert.match(JSON.stringify(comp.body.input), /CONTEXT CHECKPOINT COMPACTION/);
  const post = recs[ci + 1];
  assert.equal(hints(post).request_kind, 'turn');
  // 压缩后注入的摘要包裹模板出现在【后续轮】
  assert.match(JSON.stringify(post.body.input), /Another language model started to solve/);
  assert.equal(post.body.input.filter((i) => i.type === 'function_call').length, 0, '压缩后保留历史丢弃 function_call');
  assert.equal(post.body.input.filter((i) => i.type === 'function_call_output').length, 0);
});

test('27-ctxwindow bug 未复现：设 window + 伪造 usage 仍正常触发压缩(2 次)', () => {
  const recs = loadFixture('27-ctxwindow-bug');
  assert.deepEqual(kinds(recs), ['turn', 'compaction', 'turn', 'compaction', 'turn']);
});

test('28-scope：total 与 body_after_prefix 两个合法值都触发压缩', () => {
  for (const f of ['28a-scope-total', '28-scope-body_after_prefix']) {
    assert.deepEqual(kinds(loadFixture(f)), ['turn', 'compaction', 'turn'], f);
  }
});

test('29-extract_model：memory 抽取模型被覆盖为 gpt-5.4(非默认 mini)', () => {
  const mems = loadFixture('29-extract-model').filter((r) => hints(r).request_kind === 'memory');
  assert.ok(mems.length >= 1);
  assert.ok(mems.every((r) => hints(r).model === 'gpt-5.4'));
  assert.ok(!mems.some((r) => hints(r).model === 'gpt-5.4-mini'));
});

test('31-ctxwindow 毒化不跨进程：__MOCK_CTXEXCEED__ 仅当前轮触发，turn3 恢复正常', () => {
  const recs = loadFixture('31a-ctxwindow-poison');
  assert.deepEqual(kinds(recs), ['turn', 'turn', 'turn'], 'turn3 恢复(无 compaction/无毒化遗留)');
  assert.equal(new Set(recs.map((m) => hints(m).turn_id)).size, 3);
  assert.equal(new Set(recs.map((m) => hints(m).prompt_cache_key)).size, 1);
  assert.ok(lastUserText(recs[1].body).includes('__MOCK_CTXEXCEED__'), 'turn2 当前轮带 sentinel');
  assert.ok(!lastUserText(recs[2].body).includes('__MOCK_CTXEXCEED__'), 'turn3 当前轮不带');
});

test('32b-memread(对照)：use_memories=off 在 read-only 沙箱下仍能读回流', () => {
  const recs = loadFixture('32b-memread-use-off');
  const viaFco = fcOutputs(recs).some((i) => JSON.stringify(i).includes('SENTINEL_MEMREAD_42'));
  assert.ok(viaFco, 'use_memories off 仍经 function_call_output 读到 MEMORY.md');
});
