#!/usr/bin/env bash
# 批量跑 Codex 各类场景，把每个场景的「请求日志」「stdout」隔离存档到 logs/。
# 前置：mock server 已在 127.0.0.1:8787 运行。
set -u
cd "$(dirname "$0")"
export PATH="/home/niaowuuu/.nvm/versions/node/v22.22.2/bin:$PATH"
export CODEX_MOCK_KEY=dummy

COMMON="--skip-git-repo-check"
MASTER=codex-requests.jsonl
mkdir -p logs
: > logs/INDEX.txt
: > "$MASTER"

snap() { # $1 = scenario 名
  local n="$1"
  if [ -s "$MASTER" ]; then cp "$MASTER" "logs/$n.requests.jsonl"; else : > "logs/$n.requests.jsonl"; fi
  local c; c=$(grep -c . "logs/$n.requests.jsonl" 2>/dev/null || echo 0)
  printf '%-28s %s 个请求\n' "$n" "$c" | tee -a logs/INDEX.txt
  : > "$MASTER"
}

echo "=== 开始批量场景测试 ==="

# S01 基线：默认配置（reasoning=high）
timeout 120 codex exec $COMMON -s read-only "Reply with the single word: pong" > logs/01-baseline.stdout.txt 2>&1
snap 01-baseline

# S02 reasoning=minimal
timeout 120 codex exec $COMMON -s read-only -c model_reasoning_effort="minimal" "Reply: pong" > logs/02-reasoning-minimal.stdout.txt 2>&1
snap 02-reasoning-minimal

# S03 reasoning=xhigh
timeout 120 codex exec $COMMON -s read-only -c model_reasoning_effort="xhigh" "Reply: pong" > logs/03-reasoning-xhigh.stdout.txt 2>&1
snap 03-reasoning-xhigh

# S04 换模型：gpt-5.5（非 codex 版）
timeout 120 codex exec $COMMON -s read-only -m gpt-5.5 "Reply: pong" > logs/04-model-gpt5_5.stdout.txt 2>&1
snap 04-model-gpt5_5

# S05 关闭 goals 功能 → tools[] 里的 goal 工具应消失
timeout 120 codex exec $COMMON -s read-only --disable goals "Reply: pong" > logs/05-disable-goals.stdout.txt 2>&1
snap 05-disable-goals

# S06 沙箱改 workspace-write → developer 消息里的 permissions 指令应变化
timeout 120 codex exec $COMMON -s workspace-write "Reply: pong" > logs/06-sandbox-workspace-write.stdout.txt 2>&1
snap 06-sandbox-workspace-write

# S07 结构化输出 → 请求体应带 text.format(json_schema)
printf '%s\n' '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}' > logs/schema.json
timeout 120 codex exec $COMMON -s read-only --output-schema logs/schema.json "Return JSON with answer=pong" > logs/07-output-schema.stdout.txt 2>&1
snap 07-output-schema

# S08 尝试关掉 web_search（观察 tools[] 是否变化）
timeout 120 codex exec $COMMON -s read-only -c tools.web_search=false "Reply: pong" > logs/08-web-search-off.stdout.txt 2>&1
snap 08-web-search-off

# S09 函数调用闭环：mock 回 update_plan(function_call) → codex 执行 → 回传 function_call_output
timeout 120 codex exec $COMMON -s read-only "Outline a 2-step plan via update_plan. __MOCK_TOOL__" > logs/09-tool-call-loop.stdout.txt 2>&1
snap 09-tool-call-loop

# S10 多轮 resume：验证 prompt_cache_key 是否跨轮稳定
timeout 120 codex exec $COMMON -s read-only "Turn one, remember 42. Reply: ok" > logs/10a-turn1.stdout.txt 2>&1
timeout 120 codex exec -s read-only $COMMON resume --last "Turn two. Reply: ping" > logs/10-multi-turn-resume.stdout.txt 2>&1
snap 10-multi-turn-resume

# S11 代码审查 agent：临时 git 仓库里跑 codex exec review
RD=/tmp/codex-review-demo
rm -rf "$RD"; mkdir -p "$RD"
( cd "$RD" && git init -q && git config user.email t@t && git config user.name t \
  && printf 'def f():\n    return 1\n' > a.py && git add -A && git commit -qm init \
  && printf 'def f():\n    return 2  # changed\n' > a.py )
timeout 120 codex exec $COMMON -s read-only -C "$RD" review --uncommitted "Review the change" > logs/11-review.stdout.txt 2>&1
snap 11-review

# S12 图片输入 → 请求 input 里应出现 input_image
node -e 'require("fs").writeFileSync("logs/tiny.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=","base64"))'
timeout 120 codex exec $COMMON -s read-only -i logs/tiny.png "What is in the image? Reply: ok" > logs/12-image-input.stdout.txt 2>&1
snap 12-image-input

# S13 交互式 TUI（尽力而为）：期望 originator 变为 codex_cli_rs
script -qfc "timeout 25 codex $COMMON -s read-only 'Reply: pong'" /dev/null > logs/13-interactive.stdout.txt 2>&1 || true
snap 13-interactive

echo "=== 完成。汇总： ==="
cat logs/INDEX.txt
