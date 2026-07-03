#!/bin/bash
# gen-types.sh — 从 *生产* schema 重新生成 Supabase 类型(P0 键石:类型自动接地)
#
# 背景（2026-06 漂移审计）：lib/supabase/database.types.ts 一直是手工维护、
# 陈旧的(320KB,6-01)。代码凭"用户表应该有 display_name"的先验写查询,
# tsc 对着陈旧类型校验 → 引用已删列也编译通过 → 漂移静默累积。
#
# 此脚本让"生产真实 schema"成为可重生成的类型契约。CI 会重生成 + diff,
# 有 diff 即失败(意味着 schema 变了没同步类型,或代码依赖的列已不存在)。
#
# 用法:
#   npm run gen:types                 # 写 lib/supabase/database.types.ts
#   CHECK=1 npm run gen:types         # 只生成到临时文件 + diff,不覆盖(CI 用)
#
# 认证:
#   - 本地:先 `supabase login`(一次),或设 SUPABASE_ACCESS_TOKEN
#   - CI:仓库 secret SUPABASE_ACCESS_TOKEN(Supabase 个人访问令牌)

set -euo pipefail

PROJECT_REF="iknktzifjdyujdccyhsv"
OUT="lib/supabase/database.types.ts"
HEADER="// AUTO-GENERATED from production schema via scripts/gen-types.sh — DO NOT EDIT BY HAND.
// Regenerate: npm run gen:types   |   Drift gate: CI 'gen-types-check' job.
"

# CLI 解析:优先全局 supabase,否则回退 npx（CI 无需预装全局）
if command -v supabase >/dev/null 2>&1; then
  SUPABASE_BIN="supabase"
else
  SUPABASE_BIN="npx --yes supabase"
fi

# CHECK 模式（CI 门禁）在缺认证时优雅跳过——这样把本 job 接进 CI 不会在
# SUPABASE_ACCESS_TOKEN secret 配好前就把 CI 弄红。设 token 即激活硬门。
if [ "${CHECK:-0}" = "1" ] && [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "⏭️  gen-types CHECK 跳过 —— 未设 SUPABASE_ACCESS_TOKEN（设 secret 即启用类型漂移门）"
  exit 0
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# 生产 public schema → TypeScript
echo "$HEADER" > "$TMP"
$SUPABASE_BIN gen types typescript --project-id "$PROJECT_REF" --schema public >> "$TMP"

# 用仓库 prettier 统一格式(CLI 输出是双引号,已提交文件是 prettier 单引号)——
# 否则 CHECK 模式的 diff 永远因引号/换行差异误判为 schema 漂移(2026-07 修)。
npx prettier --config "$(git rev-parse --show-toplevel)/.prettierrc" --parser typescript --write "$TMP" >/dev/null 2>&1 || true

if [ "${CHECK:-0}" = "1" ]; then
  # CI 模式：与已提交版本比对,有 diff 即非零退出
  if ! diff -q "$TMP" "$OUT" >/dev/null 2>&1; then
    echo "❌ gen-types: 生成的类型与 $OUT 不一致 —— schema 漂移!" >&2
    echo "   本地跑 \`npm run gen:types\` 重新生成并提交。" >&2
    echo "--- diff (前 40 行) ---" >&2
    diff "$OUT" "$TMP" 2>/dev/null | head -40 >&2 || true
    exit 1
  fi
  echo "✅ gen-types: 类型与生产 schema 一致"
  exit 0
fi

# 正常模式：覆盖
mv "$TMP" "$OUT"
trap - EXIT
echo "✅ gen-types: $OUT 已从生产 schema 重新生成"
echo "   下一步：npm run type-check —— 看是否有代码引用了已不存在的列/表。"
