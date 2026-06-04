#!/usr/bin/env node
// 读取 logs/*.requests.jsonl，抽取每个场景的关键 Hint，输出横向对比表。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, 'logs');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.requests.jsonl')).sort();

function toolName(t) {
  if (!t || typeof t !== 'object') return String(t);
  if (t.type === 'function') return t.name;
  return t.type; // web_search / tool_search / custom(apply_patch) ...
}

const rows = [];
const baselineTools = new Set();

for (const f of files) {
  const name = f.replace('.requests.jsonl', '');
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean);
  if (!lines.length) { rows.push({ name, empty: true }); continue; }
  // 取该场景最后一条「请求」做主特征；记录请求条数。
  const recs = lines.map((l) => JSON.parse(l));
  const last = recs[recs.length - 1];
  const b = last.body;
  const h = last.headers;
  const tools = Array.isArray(b.tools) ? b.tools.map(toolName) : [];
  const row = {
    name,
    reqs: recs.length,
    originator: h['originator'],
    ua: (h['user-agent'] || '').split(' ')[0],
    model: b.model,
    effort: b.reasoning && b.reasoning.effort,
    summary: b.reasoning && b.reasoning.summary,
    verbosity: b.text && b.text.verbosity,
    textFormat: b.text && b.text.format ? (b.text.format.type || 'set') : '-',
    nTools: tools.length,
    tools,
    toolChoice: b.tool_choice,
    parallel: b.parallel_tool_calls,
    include: (b.include || []).join('|') || '-',
    store: b.store,
    stream: b.stream,
    cacheKey: b.prompt_cache_key,
    instrLen: typeof b.instructions === 'string' ? b.instructions.length : 0,
    inputItems: Array.isArray(b.input) ? b.input.length : 0,
    inputTypes: Array.isArray(b.input) ? [...new Set(b.input.map((i) => i.type || i.role))].join(',') : '-',
    hasToolOut: Array.isArray(b.input) ? b.input.some((i) => i.type === 'function_call_output') : false,
    instId: (last.body.client_metadata && last.body.client_metadata['x-codex-installation-id']) || '-',
    // 多轮：所有请求的 cacheKey 是否一致
    cacheKeys: [...new Set(recs.map((r) => r.body.prompt_cache_key))],
  };
  rows.push(row);
  if (name.startsWith('01-')) tools.forEach((t) => baselineTools.add(t));
}

// 主对比表
const cols = ['name', 'reqs', 'originator', 'model', 'effort', 'verbosity', 'textFormat', 'nTools', 'toolChoice', 'include', 'inputItems', 'instrLen'];
console.log('\n========== 场景横向对比 ==========');
const head = cols.map((c) => c.padEnd(c === 'name' ? 26 : c === 'include' ? 26 : c === 'originator' ? 13 : c === 'model' ? 14 : 9)).join(' ');
console.log(head);
for (const r of rows) {
  if (r.empty) { console.log(r.name.padEnd(26) + ' (空)'); continue; }
  console.log(cols.map((c) => String(r[c]).padEnd(c === 'name' ? 26 : c === 'include' ? 26 : c === 'originator' ? 13 : c === 'model' ? 14 : 9)).join(' '));
}

// tools 差异（相对基线）
console.log('\n========== tools 相对基线(01) 的差异 ==========');
console.log('基线 tools (' + baselineTools.size + '):', [...baselineTools].join(', '));
for (const r of rows) {
  if (r.empty || r.name.startsWith('01-')) continue;
  const cur = new Set(r.tools);
  const removed = [...baselineTools].filter((t) => !cur.has(t));
  const added = [...cur].filter((t) => !baselineTools.has(t));
  if (removed.length || added.length) {
    console.log(`  ${r.name}:  -[${removed.join(',')}]  +[${added.join(',')}]`);
  }
}

// 缓存亲和性 key
console.log('\n========== prompt_cache_key（亲和性 key）==========');
for (const r of rows) {
  if (r.empty) continue;
  const stable = r.cacheKeys.length === 1 ? '稳定' : '变化(' + r.cacheKeys.length + '个)';
  console.log(`  ${r.name.padEnd(26)} reqs=${r.reqs}  ${stable}  ${r.cacheKeys.join(' , ')}`);
}

// 特征字段
console.log('\n========== 多轮/工具/结构化 关键字段 ==========');
for (const r of rows) {
  if (r.empty) continue;
  console.log(`  ${r.name.padEnd(26)} inputTypes=[${r.inputTypes}] hasToolOut=${r.hasToolOut} textFormat=${r.textFormat} summary=${r.summary} parallel=${r.parallel} store=${r.store} stream=${r.stream}`);
}
console.log('\n安装ID(client_metadata) 示例:', rows.find((r) => !r.empty)?.instId);
