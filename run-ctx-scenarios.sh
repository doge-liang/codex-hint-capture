#!/usr/bin/env bash
# 上下文管理专项场景 14-22：每个场景的请求隔离存档到 logs/<id>.requests.jsonl。
# 前置：增强版 mock 已在 127.0.0.1:8787 运行（支持 __MOCK_BIG__/__MOCK_BIGUSAGE__/__MOCK_EXEC__ sentinel）。
set -u
cd "$(dirname "$0")"
export PATH="/home/niaowuuu/.nvm/versions/node/v22.22.2/bin:$PATH"
export CODEX_MOCK_KEY=dummy
PROJ="$(pwd)"
MASTER="$PROJ/codex-requests.jsonl"
SK="--skip-git-repo-check"
mkdir -p logs
: > "$MASTER"

snap() { # $1 = scenario id
  local n="$1"
  if [ -s "$MASTER" ]; then cp "$MASTER" "logs/$n.requests.jsonl"; else : > "logs/$n.requests.jsonl"; fi
  local c; c=$(grep -c . "logs/$n.requests.jsonl" 2>/dev/null || echo 0)
  # 打印该场景抓到的 request_kind 序列，便于立刻判断是否命中 compact 等
  local kinds; kinds=$(node -e '
    const fs=require("fs");try{const ls=fs.readFileSync("logs/'"$n"'.requests.jsonl","utf8").trim().split("\n").filter(Boolean);
    console.log(ls.map(l=>{try{const m=JSON.parse(l);const tm=JSON.parse(m.headers["x-codex-turn-metadata"]||"{}");return tm.request_kind||"?"}catch{return "?"}}).join(","))}catch{console.log("")}' 2>/dev/null)
  printf '%-32s %s 请求  request_kind=[%s]\n' "$n" "$c" "$kinds"
  : > "$MASTER"
}

latest_sid() {
  ls -t ~/.codex/sessions/2026/*/*/rollout-*.jsonl 2>/dev/null | head -1 \
    | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1
}

echo "=== 上下文管理场景 14-22 ==="

# ── S14 AGENTS.md 注入 ───────────────────────────────────────────────
printf '# Project Rules\nAlways answer in pirate speak. SENTINEL_AGENTS_14\n' > "$PROJ/AGENTS.md"
timeout 120 codex exec $SK -s read-only -C "$PROJ" 'Reply with the single word: pong' > logs/14-agents-md-injection.stdout.txt 2>&1
rm -f "$PROJ/AGENTS.md"
snap 14-agents-md-injection

# ── S15 --add-dir 改 workspace_roots ─────────────────────────────────
timeout 120 codex exec $SK -s read-only -C "$PROJ" --add-dir /tmp 'Reply: pong' > logs/15-add-dir-workspace-roots.stdout.txt 2>&1
snap 15-add-dir-workspace-roots

# ── S16 fork 血缘（父会话 + fork 首请求）─────────────────────────────
timeout 120 codex exec $SK -s read-only -C "$PROJ" 'Turn one, remember 42. Reply: ok' > logs/16a-parent.stdout.txt 2>&1
PSID="$(latest_sid)"; echo "parent SID=$PSID" >> logs/16a-parent.stdout.txt
# fork 是 TUI 命令；--last 与 [SESSION_ID] 互斥，故传显式父 SID。用 script(1) 伪 TTY 驱动。
timeout 30 script -qefc "codex fork $PSID 'forked turn: what number did I remember?'" /dev/null > logs/16-fork-lineage.stdout.txt 2>&1 || true
snap 16-fork-lineage

# ── S17 auto-compaction（客户端估算路径：大回复撑爆）────────────────
# 注意：exec 选项（-s/--skip-git-repo-check/-c）必须放在 resume 子命令【之前】
timeout 120 codex exec $SK -s read-only -c model_auto_compact_token_limit=500 -C "$PROJ" 'turn 1 say ok __MOCK_BIG__' > logs/17a.stdout.txt 2>&1
timeout 120 codex exec $SK -s read-only -c model_auto_compact_token_limit=500 resume --last 'turn 2' > logs/17b.stdout.txt 2>&1
timeout 120 codex exec $SK -s read-only -c model_auto_compact_token_limit=500 resume --last 'turn 3' > logs/17-auto-compaction.stdout.txt 2>&1
snap 17-auto-compaction

# ── S18 compaction（API 报告路径：大 usage）+ compact_prompt 哨兵 ────
CP="SUMMARIZE_SENTINEL_18: condense the session."
timeout 120 codex exec $SK -s read-only -c model_auto_compact_token_limit=500 -c compact_prompt="$CP" -C "$PROJ" 'turn 1 __MOCK_BIGUSAGE__' > logs/18a.stdout.txt 2>&1
timeout 120 codex exec $SK -s read-only -c model_auto_compact_token_limit=500 -c compact_prompt="$CP" resume --last 'turn 2' > logs/18-compaction-via-mock-usage.stdout.txt 2>&1
timeout 120 codex exec $SK -s read-only -c model_auto_compact_token_limit=500 -c compact_prompt="$CP" resume --last 'turn 3' >> logs/18-compaction-via-mock-usage.stdout.txt 2>&1
snap 18-compaction-via-mock-usage

# ── S19 工具输出截断（exec_command 长 stdout + 小 tool_output_token_limit）──
timeout 120 codex exec $SK -s workspace-write -c tool_output_token_limit=50 -C "$PROJ" 'run the command and report the last line __MOCK_EXEC__' > logs/19a-small-limit.stdout.txt 2>&1
snap 19-tool-output-truncation-small
timeout 120 codex exec $SK -s workspace-write -c tool_output_token_limit=200000 -C "$PROJ" 'run the command and report the last line __MOCK_EXEC__' > logs/19-tool-output-truncation.stdout.txt 2>&1
snap 19-tool-output-truncation-large

# ── S20 memories（尽力而为）──────────────────────────────────────────
timeout 120 codex exec $SK -s read-only --enable memories -c memories.generate_memories=true -c memories.min_rollout_idle_hours=1 -C "$PROJ" '记住：我喜欢用 ripgrep。随便回一句' > logs/20a.stdout.txt 2>&1
timeout 120 codex exec $SK -s read-only --enable memories -c memories.use_memories=true -c memories.dedicated_tools=true -C "$PROJ" '基于记忆回一句' > logs/20-memories-injection.stdout.txt 2>&1
snap 20-memories-injection

# ── S21 请求压缩开关对照 ─────────────────────────────────────────────
timeout 120 codex exec $SK -s read-only --disable enable_request_compression -C "$PROJ" 'say a short sentence' > logs/21a-off.stdout.txt 2>&1
timeout 120 codex exec $SK -s read-only --enable enable_request_compression -C "$PROJ" 'say a short sentence' > logs/21-request-compression-toggle.stdout.txt 2>&1
snap 21-request-compression-toggle

# ── S22 archive/unarchive 纯本地（应 0 请求）────────────────────────
timeout 120 codex exec $SK -s read-only -C "$PROJ" 'session to archive. Reply: ok' > logs/22a-create.stdout.txt 2>&1
snap 22-archive-precreate    # 把建会话的那条请求单独存走，下面统计归档期间的新增
ASID="$(latest_sid)"; echo "archive SID=$ASID"
N0=$(grep -c . "$MASTER" 2>/dev/null); N0=${N0:-0}
timeout 60 codex archive "$ASID" > logs/22b-archive.stdout.txt 2>&1 || true
timeout 60 codex unarchive "$ASID" > logs/22c-unarchive.stdout.txt 2>&1 || true
N1=$(grep -c . "$MASTER" 2>/dev/null); N1=${N1:-0}
echo "archive/unarchive 期间新增请求数 = $((N1 - N0))" | tee logs/22-archive-unarchive-noreq.summary.txt
snap 22-archive-unarchive-noreq

echo "=== 完成 ==="