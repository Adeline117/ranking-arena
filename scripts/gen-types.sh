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
# 生产输入（全部必需）:
#   - DATABASE_URL:唯一生成源；证明通过后只以 PG_META_DB_URL 环境变量传给
#     固定版本的官方 postgres-meta server，绝不进入 CLI/Docker/进程 argv
#   - SUPABASE_URL + SUPABASE_SECRET_KEY（或 legacy service-role key）:
#     REST OpenAPI 身份/版本证明
# 缺失、目标项目不符或 PostgREST major 不支持时全部失败；schema 门禁不得
# 把“没检查”伪装成通过。

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
POSTGRES_META_VERSION="0.96.6"
POSTGRES_META_PACKAGE="@supabase/postgres-meta@$POSTGRES_META_VERSION"
OUT="${GEN_TYPES_OUT:-$ROOT/lib/supabase/database.types.ts}"
ATTESTOR="$ROOT/scripts/attest-production-types-source.mjs"
POSTPROCESS="$ROOT/scripts/postprocess-database-types.mjs"
HEADER="// AUTO-GENERATED from production schema via scripts/gen-types.sh — DO NOT EDIT BY HAND.
// Regenerate: npm run gen:types   |   Drift gate: CI 'gen-types-check' job.

"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "❌ gen-types: DATABASE_URL is required" >&2
  exit 1
fi

# 先把数据库凭据移到 generator 专用环境名并删除原变量。数据库项目归属
# 仍由 production attestor 模块中的同一严格验证函数证明，但 REST attestor
# 子进程会同时移除两个数据库环境名，只继承 REST 所需凭据。
export PG_META_DB_URL="$DATABASE_URL"
unset DATABASE_URL
node --input-type=module -e '
  import { pathToFileURL } from "node:url"
  const { validateDatabaseUrl } = await import(pathToFileURL(process.argv[2]))
  validateDatabaseUrl(process.env.PG_META_DB_URL)
' gen-types-module "$ATTESTOR"

# 测试可注入离线 attestor；真实流程导入同一 production attestor 并给它
# 一个公开、无凭据的占位 DSN，以满足组合 attestation API 的已验证前置
# 条件。真实 PG_META_DB_URL/DATABASE_URL 均不会进入这个 REST 子进程。
if [ -n "${GEN_TYPES_ATTESTOR_BIN:-}" ]; then
  POSTGREST_VERSION="$(
    env -u DATABASE_URL -u PG_META_DB_URL "$GEN_TYPES_ATTESTOR_BIN"
  )"
else
  POSTGREST_VERSION="$(
    env -u DATABASE_URL -u PG_META_DB_URL node --input-type=module -e '
      import { pathToFileURL } from "node:url"
      const { attestProductionTypesSource } = await import(pathToFileURL(process.argv[2]))
      const env = {
        ...process.env,
        DATABASE_URL:
          "postgresql://postgres:unused@db.iknktzifjdyujdccyhsv.supabase.co:5432/postgres",
      }
      const { postgrestVersion } = await attestProductionTypesSource({ env })
      process.stdout.write(`${postgrestVersion}\n`)
    ' gen-types-module "$ATTESTOR"
  )"
fi

# Supabase CLI 的 --db-url 路径最终也只是以这些环境变量运行同一版
# postgres-meta server，但会先把连接串放入 CLI/Docker argv，并要求本机
# Docker daemon。这里直接运行官方 npm 包：精确版本、禁用所有安装脚本，
# 再在执行前校验实际包版本与 server 路径。npx 下载/缺包/版本漂移均
# fail-closed，不会回退到 global CLI 或 Docker。
POSTGRES_META_NPX_BIN="${POSTGRES_META_NPX_BIN:-npx}"
if ! command -v "$POSTGRES_META_NPX_BIN" >/dev/null 2>&1; then
  echo "❌ gen-types: npx is required for pinned postgres-meta" >&2
  exit 1
fi

POSTGRES_META_BOOTSTRAP='
set -eu
fail() {
  echo "❌ gen-types: pinned postgres-meta package is unavailable or mismatched" >&2
  exit 70
}

bin_dir=${PATH%%:*}
case "$bin_dir" in
  */node_modules/.bin) ;;
  *) fail ;;
esac

modules_dir=${bin_dir%/.bin}
package_dir="$modules_dir/@supabase/postgres-meta"
package_json="$package_dir/package.json"
server="$package_dir/dist/server/server.js"

[ -f "$package_json" ] && [ -f "$server" ] || fail
if ! actual_version=$(node -p "require(process.argv[1]).version" "$package_json" 2>/dev/null); then
  fail
fi
[ "$actual_version" = "$EXPECTED_POSTGRES_META_VERSION" ] || fail

exec node "$server"
'

# REST 证明已经完成；generator 只保留数据库连接串，不继承无关的 REST
# 凭据。
unset SUPABASE_URL SUPABASE_SECRET_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_ACCESS_TOKEN
export EXPECTED_POSTGRES_META_VERSION="$POSTGRES_META_VERSION"
export PG_META_GENERATE_TYPES="typescript"
export PG_META_GENERATE_TYPES_INCLUDED_SCHEMAS="public"
export PG_META_GENERATE_TYPES_DETECT_ONE_TO_ONE_RELATIONSHIPS="true"
export PG_CONN_TIMEOUT_SECS="15"
export PG_QUERY_TIMEOUT_SECS="15"

# 在 OUT 同目录建立随机私有目录，既避免可预测临时文件/symlink 覆写，也
# 保证最终 rename 不跨文件系统。所有门禁通过后才原子替换 canonical。
OUT_DIR="$(dirname "$OUT")"
TMP_DIR="$(mktemp -d "$OUT_DIR/.arena-database-types.XXXXXX")"
TMP="$TMP_DIR/database.types.ts"
GENERATOR_STDERR="$TMP_DIR/postgres-meta.stderr"
trap 'rm -rf "$TMP_DIR"' EXIT

# 生产 public schema → TypeScript
printf '%s' "$HEADER" > "$TMP"
if "$POSTGRES_META_NPX_BIN" \
    --yes \
    --ignore-scripts \
    "--package=$POSTGRES_META_PACKAGE" \
    -- \
    sh -c "$POSTGRES_META_BOOTSTRAP" >> "$TMP" 2> "$GENERATOR_STDERR"; then
  GENERATOR_STATUS=0
else
  GENERATOR_STATUS=$?
fi

# postgres-meta/npx 不再运行后立刻清除连接串与所有 generator 配置，保证
# postprocess/Prettier 不能继承。第三方 stderr 可能回显连接信息，因此无论
# 成败都不转发；失败只输出稳定、无凭据的诊断。
unset PG_META_DB_URL
unset EXPECTED_POSTGRES_META_VERSION
unset PG_META_GENERATE_TYPES
unset PG_META_GENERATE_TYPES_INCLUDED_SCHEMAS
unset PG_META_GENERATE_TYPES_DETECT_ONE_TO_ONE_RELATIONSHIPS
unset PG_CONN_TIMEOUT_SECS
unset PG_QUERY_TIMEOUT_SECS
if [ "$GENERATOR_STATUS" -ne 0 ]; then
  echo "❌ gen-types: pinned postgres-meta generation failed (details withheld)" >&2
  exit 1
fi
rm -f "$GENERATOR_STDERR"

# 生成器无法推断少量 SQL 语义（view 只读性、nullable RPC 参数）。
# AST 后处理对目标对象和原始形状做精确断言；任何未知漂移都会失败。
POSTGREST_VERSION="$POSTGREST_VERSION" node "$POSTPROCESS" "$TMP"

# postgres-meta 输出是双引号；仓库 canonical 文件使用 Prettier。格式化失败也必须
# 让门禁失败，不能继续比较一个未经规范化的临时文件。
npx prettier \
  --config "$ROOT/.prettierrc" \
  --parser typescript \
  --write "$TMP" >/dev/null

if [ "${CHECK:-0}" = "1" ]; then
  # CI 模式：与已提交版本比对,有 diff 即非零退出
  if ! diff -q "$TMP" "$OUT" >/dev/null 2>&1; then
    echo "❌ gen-types: 生成的类型与 $OUT 不一致 —— schema 漂移!" >&2
    echo "   本地跑 \`npm run gen:types\` 重新生成并提交。" >&2
    echo "--- diff (前 40 行) ---" >&2
    diff "$OUT" "$TMP" 2>/dev/null | head -40 >&2 || true
    exit 1
  fi
  echo "✅ gen-types: 类型与生产 schema 一致（env-only postgres-meta + REST attested）"
  exit 0
fi

# 正常模式：覆盖
mv "$TMP" "$OUT"
echo "✅ gen-types: $OUT 已从生产 schema 重新生成（env-only postgres-meta + REST attested）"
echo "   下一步：npm run type-check —— 看是否有代码引用了已不存在的列/表。"
