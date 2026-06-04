'use strict';
// Tier 2 端到端：真跑 codex 打到【子进程】mock，断言行为。慢、需 codex、opt-in。
// 运行：RUN_E2E=1 node --test test/e2e.test.js
// 注意：mock 必须跑在独立子进程——spawnSync(codex) 会阻塞测试进程的事件循环，
// 进程内 server 无法在此期间响应连接。
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(os.tmpdir(), `e2e-${process.pid}.jsonl`);

function findCodex() {
  const r = spawnSync('bash', ['-lc', 'command -v codex || true'], { encoding: 'utf8' });
  return (r.stdout || '').trim() || null;
}
const CODEX = findCodex();
const ENABLED = !!process.env.RUN_E2E && !!CODEX;

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });

async function waitHealth(port, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('mock 未能在超时内 healthy');
}

describe('e2e (需 RUN_E2E=1 且 codex 在 PATH)', { skip: ENABLED ? false : 'set RUN_E2E=1 and install codex' }, () => {
  let port;
  let child;
  before(async () => {
    port = await freePort();
    child = spawn(process.execPath, [path.join(ROOT, 'mock-server.js')], {
      env: { ...process.env, PORT: String(port), LOG_FILE: LOG, MODE: 'mock', CODEX_MOCK_KEY: 'dummy' },
      stdio: 'ignore',
    });
    await waitHealth(port);
  });
  after(() => child && child.kill('SIGKILL'));

  function runCodex(args) {
    fs.writeFileSync(LOG, '');
    const r = spawnSync(
      CODEX,
      ['exec', '--skip-git-repo-check', '-s', 'read-only', '-c', `model_providers.mock.base_url="http://127.0.0.1:${port}/v1"`, ...args],
      { encoding: 'utf8', timeout: 90000, env: { ...process.env, CODEX_MOCK_KEY: 'dummy' } }
    );
    const recs = fs.existsSync(LOG)
      ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', recs };
  }

  test('baseline：11 工具 + originator=codex_exec', () => {
    const { recs } = runCodex(['Reply with the single word: pong']);
    assert.ok(recs.length >= 1, '应至少捕获 1 个请求');
    assert.equal(recs[0].hints.tools.length, 11);
    assert.equal(recs[0].hints.originator, 'codex_exec');
  });

  test('函数调用闭环：__MOCK_TOOL__ → function_call 然后 function_call_output', () => {
    const { recs } = runCodex(['Make a plan. __MOCK_TOOL__']);
    assert.ok(recs.length >= 2, '应有 2 个请求(调用+回传)');
    assert.ok(recs.some((m) => m.mock_response === 'function_call'));
    assert.ok(recs.some((m) => m.body.input.some((i) => i.type === 'function_call_output')));
  });

  test('context_window 错误识别：__MOCK_CTXEXCEED__ + window → 报 out of room', () => {
    const { status, stdout, stderr } = runCodex(['-c', 'model_context_window=200000', 'turn __MOCK_CTXEXCEED__']);
    assert.notEqual(status, 0, 'overflow 应非零退出');
    assert.match(stdout + stderr, /out of room|context window/i);
  });
});
