'use strict';
// 回归测试共用工具：加载已存的场景日志(fixture) + 提取 hints。
const fs = require('node:fs');
const path = require('node:path');
const { extractHints } = require('../mock-server.js');

const ROOT = path.join(__dirname, '..');
const LOGS = path.join(ROOT, 'logs');

function loadFixture(name) {
  const file = path.join(LOGS, name + '.requests.jsonl');
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const hints = (rec) => extractHints(rec.headers, rec.body);
const kinds = (recs) => recs.map((r) => hints(r).request_kind);
const hasKind = (recs, k) => recs.some((r) => hints(r).request_kind === k);
const findKind = (recs, k) => recs.find((r) => hints(r).request_kind === k);

module.exports = { ROOT, LOGS, loadFixture, hints, kinds, hasKind, findKind };
