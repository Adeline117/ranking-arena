#!/bin/bash
# Generate a new migration filename with collision-proof timestamp prefix.
#
# Usage:
#   scripts/new-migration.sh add_trader_stats_index
#   scripts/new-migration.sh "add trader stats index"
#
# Output: prints the full path to an empty new migration file, ready for editing.
#
# ── Migration Rollback Guide ──────────────────────────────────────────
#
# Supabase Pro includes Point-in-Time Recovery (PITR):
#   1. Go to Supabase Dashboard → Database → Backups
#   2. Choose "Restore to point in time" before the migration was applied
#   3. This rolls back ALL changes (schema + data) to that exact moment
#   Note: PITR restores the entire database — not just one migration.
#
# For non-destructive migrations (ADD COLUMN, CREATE INDEX, etc.):
#   Write a compensating "down" migration instead of using PITR:
#     scripts/new-migration.sh rollback_add_trader_stats_index
#   Then write the reverse SQL (DROP INDEX, DROP COLUMN, etc.)
#
# For destructive migrations (DROP TABLE, ALTER COLUMN type, etc.):
#   PITR is the only safe rollback path. Always test destructive migrations
#   on a Supabase branch first (see `list_branches` / `create_branch`).
# ──────────────────────────────────────────────────────────────────────
#
# ROOT CAUSE FIX (2026-04-09): the previous convention used
# YYYYMMDD<letter>_description.sql (e.g. 20260408h_foo.sql). Two agents
# creating migrations on the same day would independently guess the next
# letter and collide, triggering pre-commit hook errors. The YYYYMMDDHHMMSS
# format adds minute+second precision so parallel agents cannot collide
# unless they commit within the exact same second (astronomically unlikely).
#
# Ordering vs legacy letter-suffix files: new files sort AFTER old ones as
# long as the new date is strictly greater than the latest legacy date.
# As of 2026-04-09 the latest legacy file is 20260409a_*; all new files
# should use dates >= 2026-04-10 to maintain clean lexicographic ordering.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <description>" >&2
  echo "Example: $0 add_trader_stats_index" >&2
  exit 1
fi

# Normalize the description: lowercase, replace spaces/dashes with underscores
DESC=$(echo "$*" | tr '[:upper:]' '[:lower:]' | tr ' -' '__' | tr -cd 'a-z0-9_')

if [ -z "$DESC" ]; then
  echo "Error: description empty after normalization" >&2
  exit 1
fi

MIGRATIONS_DIR="supabase/migrations"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "Error: $MIGRATIONS_DIR not found. Run from repo root." >&2
  exit 1
fi

# YYYYMMDDHHMMSS — 14 digit timestamp, minute+second precision.
# On the vanishingly rare chance that two agents hit the same second with the
# same description, retry with +1s up to 10 times. After that, fall back to
# appending a short random suffix — still sorts correctly since digits come
# before letters in ASCII.
TIMESTAMP=$(date +%Y%m%d%H%M%S)
for i in 0 1 2 3 4 5 6 7 8 9; do
  CANDIDATE_TS=$(( TIMESTAMP + i ))
  FILENAME="${CANDIDATE_TS}_${DESC}.sql"
  FULL_PATH="$MIGRATIONS_DIR/$FILENAME"
  if [ ! -e "$FULL_PATH" ]; then
    break
  fi
done

if [ -e "$FULL_PATH" ]; then
  RANDOM_SUFFIX=$(printf '%04d' $(( RANDOM % 10000 )))
  FILENAME="${TIMESTAMP}${RANDOM_SUFFIX}_${DESC}.sql"
  FULL_PATH="$MIGRATIONS_DIR/$FILENAME"
fi

cat > "$FULL_PATH" <<EOF
-- Migration: $FILENAME
-- Created: $(date -u +%Y-%m-%dT%H:%M:%SZ)
-- Description: TODO — explain what this migration does and why

-- Concurrency Safety Checklist (delete after reviewing):
-- [ ] New tables with one-per-user rows: add UNIQUE or partial unique index
-- [ ] Counter columns: use atomic RPC (lib 00021), NOT trigger-based count+1
-- [ ] Check-then-act patterns: use pg_advisory_xact_lock or SELECT FOR UPDATE
-- [ ] FK to parent: include ON DELETE CASCADE
-- [ ] New functions: add SET search_path = public, SECURITY DEFINER if needed
-- [ ] 应用后跑 npm run qa:schema 核对落地 —— "写进仓库 ≠ 应用到生产"(2026-06 漂移教训)

-- Up
-- TODO — write the migration SQL here
EOF

# 验证即副产品(2026-06 教训):迁移"写进仓库"≠"应用到生产"。
# 应用 + 核对落地是这个迁移的 definition-of-done,不是可选项。提示走 stderr,
# 不污染 stdout 返回的路径(调用方会 capture $FULL_PATH)。
cat >&2 <<NUDGE

下一步(别只写不应用 —— ~200 迁移漂移就是这么来的):
  1. 写 SQL 进上面的文件
  2. 应用到生产: Supabase MCP apply_migration (单文件,name=文件描述)
     禁止裸跑 db push;当前远端历史仍不可直接重放。只有 db push --dry-run 明确
     只列目标文件时才可继续,否则停止并按 CLAUDE.md/ADR-023 处理。
  3. 核对落地: npm run qa:schema   (代码 DB 依赖 vs 生产现实)
NUDGE

echo "$FULL_PATH"
