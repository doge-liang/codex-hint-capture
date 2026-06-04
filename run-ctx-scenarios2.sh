#!/usr/bin/env bash
# 上下文管理研究补测场景 23-30（基于 CONTEXT-MGMT-RESEARCH.md）。
# 前置：增强版 mock 在 127.0.0.1:8787（支持 __MOCK_USAGE:<n>__ / __MOCK_SPAWN__ 等 sentinel）。
set -u
cd "$(dirname "$0")"
export PATH="/home/niaowuuu/.nvm/versions/node/v22.22.2/bin:$PATH"
export CODEX_MOCK_KEY=dummy
PROJ="$(pwd)"; MASTER="$PROJ/codex-requests.jsonl"; SK="--skip-git-repo-check"
mkdir -p logs; : > "$MASTER"

snap() { # $1 = id
  local n="$1"
  if [ -s "$MASTER" ]; then cp "$MASTER" "logs/$n.requests.jsonl"; else : > "logs/$n.requests.jsonl"; fi
  local kinds; kinds=$(node -e 'try{const ls=require("fs").readFileSync("logs/'"$n"'.requests.jsonl","utf8").trim().split("\n").filter(Boolean);console.log(ls.map(l=>{try{return JSON.parse(l).hints.request_kind}catch{return"?"}}).join(","))}catch{console.log("")}' 2>/dev/null)
  printf '%-30s %s req  kinds=[%s]\n' "$n" "$(grep -c . logs/$n.requests.jsonl 2>/dev/null||echo 0)" "$kinds"
  : > "$MASTER"
}

echo "=== 研究补测场景 23-30 ==="

# S23 AGENTS.md 层级与覆盖：根 override 优先于根 AGENTS.md；子目录(更近 cwd)更靠后
mkdir -p sub23
printf '# Root\nSENTINEL_ROOT_23 (should be SHADOWED by override)\n' > AGENTS.md
printf '# Override\nSENTINEL_OVERRIDE_23\n' > AGENTS.override.md
printf '# Child\nSENTINEL_CHILD_23\n' > sub23/AGENTS.md
timeout 90 codex exec $SK -s read-only -C "$PROJ/sub23" 'Reply: pong' > logs/23-agentsmd-hierarchy.stdout.txt 2>&1
rm -f AGENTS.md AGENTS.override.md; rm -rf sub23
snap 23-agentsmd-hierarchy

# S24 AGENTS.md 32KiB 预算截断：40KB 文件，START 在头、END 在 ~33000 字节(应被截掉)
node -e 'const s="START_SENTINEL_24\n"+"x".repeat(33000)+"\nEND_SENTINEL_24\n"+"y".repeat(8000);require("fs").writeFileSync("AGENTS.md","# Big\n"+s)'
timeout 90 codex exec $SK -s read-only -C "$PROJ" 'Reply: pong' > logs/24-agentsmd-32kib.stdout.txt 2>&1
rm -f AGENTS.md
snap 24-agentsmd-32kib

# S25 绝对 token 阈值：两档 usage 都 > 阈值500 → 都应触发 compaction
timeout 90 codex exec $SK -s read-only -c model_auto_compact_token_limit=500 -C "$PROJ" 'turn1 __MOCK_USAGE:50000__' > logs/25a.stdout.txt 2>&1
timeout 90 codex exec $SK -s read-only -c model_auto_compact_token_limit=500 resume --last 'turn2' > logs/25a2.stdout.txt 2>&1
snap 25a-usage50k
timeout 90 codex exec $SK -s read-only -c model_auto_compact_token_limit=500 -C "$PROJ" 'turn1 __MOCK_USAGE:500000__' > logs/25b.stdout.txt 2>&1
timeout 90 codex exec $SK -s read-only -c model_auto_compact_token_limit=500 resume --last 'turn2' > logs/25-usage500k.stdout.txt 2>&1
snap 25-usage500k

# S26 memento：先造含 function_call 的历史，再触发压缩，看压缩请求是否保留工具调用 + handoff 模板
timeout 90 codex exec $SK -s read-only -c model_auto_compact_token_limit=500 -C "$PROJ" 'turn1 make a plan __MOCK_TOOL__' > logs/26a.stdout.txt 2>&1
timeout 90 codex exec $SK -s read-only -c model_auto_compact_token_limit=500 resume --last 'turn2 __MOCK_BIGUSAGE__' > logs/26b.stdout.txt 2>&1
timeout 90 codex exec $SK -s read-only -c model_auto_compact_token_limit=500 resume --last 'turn3 next step' > logs/26-memento-retention.stdout.txt 2>&1
snap 26-memento-retention

# S27 model_context_window bug 负向：设了窗口 + usage≈窗口 → auto-compaction 应静默失效(无 compaction)
timeout 90 codex exec $SK -s read-only -c model_context_window=200000 -c model_auto_compact_token_limit=500 -C "$PROJ" 'turn1 __MOCK_USAGE:200000__' > logs/27a.stdout.txt 2>&1
timeout 90 codex exec $SK -s read-only -c model_context_window=200000 -c model_auto_compact_token_limit=500 resume --last 'turn2' > logs/27b.stdout.txt 2>&1
timeout 90 codex exec $SK -s read-only -c model_context_window=200000 -c model_auto_compact_token_limit=500 resume --last 'turn3' > logs/27-ctxwindow-bug.stdout.txt 2>&1
snap 27-ctxwindow-bug

# S28 scope: session vs thread（探索性，取值不确定）
timeout 90 codex exec $SK -s read-only -c model_auto_compact_token_limit=500 -c model_auto_compact_token_limit_scope=session -C "$PROJ" 'turn1 __MOCK_BIGUSAGE__' > logs/28a.stdout.txt 2>&1
timeout 90 codex exec $SK -s read-only -c model_auto_compact_token_limit=500 -c model_auto_compact_token_limit_scope=session resume --last 'turn2' > logs/28a2.stdout.txt 2>&1
snap 28a-scope-session
timeout 90 codex exec $SK -s read-only -c model_auto_compact_token_limit=500 -c model_auto_compact_token_limit_scope=thread -C "$PROJ" 'turn1 __MOCK_BIGUSAGE__' > logs/28b.stdout.txt 2>&1
timeout 90 codex exec $SK -s read-only -c model_auto_compact_token_limit=500 -c model_auto_compact_token_limit_scope=thread resume --last 'turn2' > logs/28-scope-thread.stdout.txt 2>&1
snap 28-scope-thread

# S29 memory 双向开关 + 读取回流（探索性，后台非确定性）
timeout 90 codex exec $SK -s read-only --enable memories -c memories.generate_memories=false -C "$PROJ" '记住我喜欢 ripgrep。回 ok' > logs/29a-gen-off.stdout.txt 2>&1
snap 29a-gen-off
timeout 90 codex exec $SK -s read-only --enable memories -c memories.use_memories=true -C "$PROJ" '我喜欢什么工具？回 ok' > logs/29b-use.stdout.txt 2>&1
snap 29b-use-memories
timeout 90 codex exec $SK -s read-only --enable memories -c memories.generate_memories=true -c memories.extract_model=gpt-5.4 -c memories.min_rollout_idle_hours=0 -c memories.max_rollouts_per_startup=50 -C "$PROJ" '记住我用 conventional commits。回 ok' > logs/29-extract-model.stdout.txt 2>&1
snap 29-extract-model

# S30 子代理 spawn：--enable multi_agent_v2 暴露 spawn_agent，mock 回 spawn_agent function_call
timeout 120 codex exec $SK -s read-only --enable multi_agent_v2 -C "$PROJ" 'Spawn an explorer subagent to look around the repo. __MOCK_SPAWN__' > logs/30-subagent-spawn.stdout.txt 2>&1
snap 30-subagent-spawn

echo "=== 完成 ==="