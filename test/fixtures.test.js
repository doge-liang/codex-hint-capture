'use strict';
// Tier 1 回归：对已存的场景日志(logs/*.requests.jsonl)断言所有已验证的不变量。
// 这些是 "golden" —— 若 extractHints 逻辑回归、或重新抓取后 Codex 行为漂移，立刻报警。
// 无需 codex、无需 server，纯解析，CI 友好。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFixture, hints, kinds, hasKind, findKind } = require('./helpers.js');

test('01-baseline：单轮结构锚点(input=3, instr=21335, 11 工具, codex_exec)', () => {
  const [r] = loadFixture('01-baseline');
  const h = hints(r);
  assert.equal(r.body.input.length, 3);
  assert.equal(r.body.instructions.length, 21335);
  assert.equal(h.tools.length, 11);
  assert.equal(h.originator, 'codex_exec');
  assert.equal(h.store, false);
  assert.equal(h.stream, true);
  assert.ok(h.include.includes('reasoning.encrypted_content'));
  assert.equal(h.prompt_cache_key, h.thread_id, 'prompt_cache_key == thread_id');
});

test('05-disable-goals：--disable goals 去掉 3 个 goal 工具(11→8)', () => {
  const [r] = loadFixture('05-disable-goals');
  const h = hints(r);
  assert.equal(h.tools.length, 8);
  for (const t of ['get_goal', 'create_goal', 'update_goal']) {
    assert.ok(!h.tools.includes('function:' + t) && !h.tools.includes(t), `${t} 应被移除`);
  }
});

test('11-review：子代理身份(subagent=review)、6 工具、instr 不同、session!=thread', () => {
  const [r] = loadFixture('11-review');
  const h = hints(r);
  assert.equal(h.tools.length, 6);
  assert.equal(r.body.instructions.length, 6419);
  assert.equal(h.subagent, 'review');
  assert.notEqual(h.session_id, h.thread_id);
});

test('13-interactive：originator=codex-tui(交互式入口)', () => {
  const [r] = loadFixture('13-interactive');
  assert.equal(hints(r).originator, 'codex-tui');
});

test('16-fork：全新身份 + forked_from_thread_id 回指父 thread', () => {
  const recs = loadFixture('16-fork-lineage');
  assert.ok(recs.length >= 2);
  const parent = hints(recs[0]);
  const fork = hints(recs[1]);
  assert.equal(fork.forked_from_thread_id, parent.thread_id, 'fork 回指父 thread');
  assert.notEqual(fork.thread_id, parent.thread_id);
  assert.notEqual(fork.session_id, parent.session_id);
  assert.equal(fork.prompt_cache_key, fork.thread_id);
});

test('18-compaction：request_kind=compaction + memento 指纹 + 亲和性保持', () => {
  const recs = loadFixture('18-compaction-via-mock-usage');
  assert.ok(hasKind(recs, 'compaction'), '应出现 compaction 请求');
  const c = hints(findKind(recs, 'compaction'));
  assert.equal(c.compaction.strategy, 'memento');
  assert.equal(c.compaction.reason, 'context_limit');
  assert.equal(c.tools.length, 0, '压缩请求 tools=[]');
  assert.equal(c.parallel_tool_calls, false);
  // 全程 prompt_cache_key 不变(亲和性免疫)
  const keys = new Set(recs.map((r) => hints(r).prompt_cache_key));
  assert.equal(keys.size, 1, '压缩前后 prompt_cache_key 不变');
});

test('19-truncation：function_call_output 被截断并带 truncated 标记', () => {
  const recs = loadFixture('19-tool-output-truncation-small');
  const fco = recs.flatMap((m) => m.body.input).find((x) => x.type === 'function_call_output');
  assert.ok(fco, '应有 function_call_output');
  const out = typeof fco.output === 'string' ? fco.output : JSON.stringify(fco.output);
  assert.match(out, /truncat/i, '应含截断标记');
});

test('20-memories：request_kind=memory 用 gpt-5.4-mini + memory_consolidation 子代理', () => {
  const recs = loadFixture('20-memories-injection');
  assert.ok(hasKind(recs, 'memory'), '应出现 memory 后台请求');
  const mem = hints(findKind(recs, 'memory'));
  assert.equal(mem.model, 'gpt-5.4-mini');
  const subagents = new Set(recs.map((r) => hints(r).subagent).filter(Boolean));
  assert.ok(subagents.has('memory_consolidation'), '应有 memory_consolidation 子代理');
  // 多模型复用
  const models = new Set(recs.map((r) => hints(r).model));
  assert.ok(models.has('gpt-5.5-codex') && models.has('gpt-5.4-mini'));
});

test('30-subagent-spawn：子代理请求带 parent_thread_id + subagent=collab_spawn', () => {
  const recs = loadFixture('30-subagent-spawn');
  const sub = recs.find((r) => hints(r).parent_thread_id);
  assert.ok(sub, '应有带 parent_thread_id 的子代理请求');
  assert.equal(hints(sub).subagent, 'collab_spawn');
});

test('32a-memread：记忆内容回流进 input(读取回流)', () => {
  const recs = loadFixture('32a-memread-use-on');
  const back = recs.some((m) => JSON.stringify(m.body.input).includes('SENTINEL_MEMREAD_42'));
  assert.ok(back, '记忆 SENTINEL 应回流进某个请求的 input');
});

test('全场景：每条记录都带稳定的 installation_id 与 prompt_cache_key', () => {
  for (const name of ['01-baseline', '18-compaction-via-mock-usage', '20-memories-injection']) {
    for (const r of loadFixture(name)) {
      const h = hints(r);
      assert.ok(h.installation_id, `${name} 缺 installation_id`);
      assert.ok(h.prompt_cache_key, `${name} 缺 prompt_cache_key`);
    }
  }
});
