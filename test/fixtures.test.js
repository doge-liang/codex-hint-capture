'use strict';
// Tier 1 回归：对已存场景日志断言核心 golden 不变量。强断言(集合/序列/尺寸/血缘)，
// 而非"只测存在"——经覆盖审计补强。无需 codex/server。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadFixture, hints, kinds, hasKind, findKind } = require('./helpers.js');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const allText = (rec) => rec.body.input.flatMap((i) => i.content || []).map((c) => c.text || '').join('\n');
const fcOutputs = (recs) => recs.flatMap((m) => m.body.input).filter((x) => x && x.type === 'function_call_output');

const BASELINE_TOOLS = [
  'function:exec_command', 'function:write_stdin', 'function:update_plan',
  'function:get_goal', 'function:create_goal', 'function:update_goal',
  'function:request_user_input', 'custom', 'function:view_image', 'tool_search', 'web_search',
];

test('01-baseline：工具【有序集合】+ 结构锚点 + 恒定指纹', () => {
  const [r] = loadFixture('01-baseline');
  const h = hints(r);
  assert.deepEqual(h.tools, BASELINE_TOOLS, '工具集合(不止数量)');
  assert.equal(r.body.input.length, 3);
  assert.equal(r.body.instructions.length, 21335);
  assert.equal(h.store, false);
  assert.equal(h.stream, true);
  assert.equal(h.parallel_tool_calls, true);
  assert.equal(h.tool_choice, 'auto');
  assert.ok(h.include.includes('reasoning.encrypted_content'));
  assert.equal(h.prompt_cache_key, h.thread_id);
});

test('05-disable-goals：精确移除 3 个 goal 工具(11→8)', () => {
  const h = hints(loadFixture('05-disable-goals')[0]);
  assert.equal(h.tools.length, 8);
  for (const t of ['get_goal', 'create_goal', 'update_goal']) {
    assert.ok(!h.tools.includes('function:' + t), `${t} 应被移除`);
  }
  // 非 goal 工具仍在
  assert.ok(h.tools.includes('function:exec_command'));
});

test('11-review：subagent=review、6 工具、instr=6419、session!=thread', () => {
  const r = loadFixture('11-review')[0];
  const h = hints(r);
  assert.equal(h.tools.length, 6);
  assert.equal(r.body.instructions.length, 6419);
  assert.equal(h.subagent, 'review');
  assert.notEqual(h.session_id, h.thread_id);
});

test('13-interactive：codex-tui 入口与 exec 共享会话级不变量', () => {
  const h = hints(loadFixture('13-interactive')[0]);
  assert.equal(h.originator, 'codex-tui');
  assert.match(h.user_agent, /codex/);
  assert.equal(h.prompt_cache_key, h.thread_id);
});

test('16-fork：血缘回指父 thread + 复制父转录进 input', () => {
  const recs = loadFixture('16-fork-lineage');
  const parent = hints(recs[0]);
  const fork = hints(recs[1]);
  assert.equal(fork.forked_from_thread_id, parent.thread_id);
  assert.notEqual(fork.thread_id, parent.thread_id);
  assert.notEqual(fork.session_id, parent.session_id);
  assert.equal(fork.prompt_cache_key, fork.thread_id);
  // 父转录被复制：fork input 明显多于全新会话的 3
  assert.ok(recs[1].body.input.length > recs[0].body.input.length, 'fork 复制了父历史');
});

test('18-compaction：完整序列 + memento 指纹 + turn_id 共享 + window 递增 + instr 一致 + 亲和性免疫', () => {
  const recs = loadFixture('18-compaction-via-mock-usage');
  assert.deepEqual(kinds(recs), ['turn', 'compaction', 'turn', 'compaction', 'turn']);
  const comp = findKind(recs, 'compaction');
  const ch = hints(comp);
  assert.equal(ch.compaction.strategy, 'memento');
  assert.equal(ch.compaction.reason, 'context_limit');
  assert.equal(ch.compaction.trigger, 'auto');
  assert.equal(ch.compaction.phase, 'pre_turn');
  assert.equal(ch.tools.length, 0);
  assert.equal(ch.parallel_tool_calls, false);
  // 压缩与其后一个 turn 共享 turn_id；window_id 末段递增
  assert.deepEqual(recs.map((m) => hints(m).window_id.split(':').pop()), ['0', '0', '1', '1', '2']);
  const ci = recs.indexOf(comp);
  assert.equal(hints(recs[ci]).turn_id, hints(recs[ci + 1]).turn_id, 'compaction 与下一 turn 共享 turn_id');
  // 压缩请求 instructions 与普通 turn 逐字相同
  const aTurn = findKind(recs, 'turn');
  assert.equal(md5(comp.body.instructions), md5(aTurn.body.instructions));
  // 全程 prompt_cache_key 不变(亲和性免疫)
  assert.equal(new Set(recs.map((m) => hints(m).prompt_cache_key)).size, 1);
});

test('19-truncation：小限额尺寸/标记 + 大限额对照(两档 fixture 都断言)', () => {
  const small = fcOutputs(loadFixture('19-tool-output-truncation-small'))[0];
  const large = fcOutputs(loadFixture('19-tool-output-truncation-large'))[0];
  assert.ok(small && large);
  const so = typeof small.output === 'string' ? small.output : JSON.stringify(small.output);
  const lo = typeof large.output === 'string' ? large.output : JSON.stringify(large.output);
  // 富结构头 + 截断标记 + 尺寸：小限额被截到很短，大限额留得多但仍被截
  assert.match(so, /Original token count: 322224/);
  assert.match(so, /tokens truncated/);
  assert.ok(so.length < 2000, `小限额应很短, 实际 ${so.length}`);
  assert.match(lo, /tokens truncated/);
  assert.ok(lo.length > 5000, `大限额应留更多, 实际 ${lo.length}`);
});

test('20-memories：memory 请求指纹 + 整合子代理 + memories 命名空间工具(11→12)', () => {
  const recs = loadFixture('20-memories-injection');
  const mem = findKind(recs, 'memory');
  const mh = hints(mem);
  assert.equal(mh.model, 'gpt-5.4-mini');
  assert.equal(mh.tools.length, 0, 'memory 抽取请求 0 工具');
  assert.match(mem.body.instructions, /Memory Writing Agent: Phase 1/);
  assert.equal(mem.body.text?.format?.name, 'codex_output_schema');
  // 整合子代理
  const cons = recs.find((m) => hints(m).subagent === 'memory_consolidation');
  assert.ok(cons, '应有 memory_consolidation 子代理');
  assert.equal(hints(cons).model, 'gpt-5.4');
  // dedicated_tools 后主轮多出 memories(namespace)，12 工具
  const nsTurn = recs.find((m) => Array.isArray(m.body.tools) && m.body.tools.some((t) => t && t.type === 'namespace'));
  assert.ok(nsTurn, '应有带 memories namespace 工具的主轮');
  assert.equal(nsTurn.body.tools.length, 12);
  assert.equal(nsTurn.body.tools.find((t) => t.type === 'namespace').name, 'memories');
  assert.match(hints(nsTurn).beta_features, /memories/);
});

test('30-spawn：子代理 parent_thread_id 指回父 + 父侧 multi_agent_v2 暴露 spawn_agent(16 工具)', () => {
  const recs = loadFixture('30-subagent-spawn');
  const parent = recs.find((m) => !hints(m).parent_thread_id);
  const sub = recs.find((m) => hints(m).parent_thread_id);
  assert.ok(parent && sub);
  assert.equal(hints(sub).parent_thread_id, hints(parent).thread_id, 'parent_thread_id 指回父 thread');
  assert.notEqual(hints(sub).thread_id, hints(parent).thread_id);
  assert.equal(hints(sub).subagent, 'collab_spawn');
  // 父侧暴露 spawn_agent 且工具数=16
  assert.ok(parent.body.tools.some((t) => (t.name || t.type) === 'spawn_agent'), '父侧应有 spawn_agent 工具');
  assert.equal(hints(parent).tools.length, 16);
});

test('32a-memread：记忆内容确经 function_call_output 回流(非 prompt 自带)', () => {
  const recs = loadFixture('32a-memread-use-on');
  const viaFco = recs.some((m) => m.body.input.some((i) => i.type === 'function_call_output' && JSON.stringify(i).includes('SENTINEL_MEMREAD_42')));
  assert.ok(viaFco, '记忆 SENTINEL 应经 function_call_output 回流');
});

test('全场景恒定：installation_id 与 prompt_cache_key 非空', () => {
  for (const name of ['01-baseline', '18-compaction-via-mock-usage', '20-memories-injection']) {
    for (const r of loadFixture(name)) {
      const h = hints(r);
      assert.ok(h.installation_id, `${name} 缺 installation_id`);
      assert.ok(h.prompt_cache_key, `${name} 缺 prompt_cache_key`);
    }
  }
});
