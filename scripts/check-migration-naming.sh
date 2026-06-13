#!/bin/bash
# check-migration-naming.sh — pre-push guard: reject non-timestamp migration names.
#
# 根源（2026-06 schema 漂移审计）：字母后缀命名的迁移（20260319h_*、
# 20260402g_*）无法被 supabase CLI 的 ledger 追踪 → 应用与否无记录 →
# ~200 个迁移漂移、发帖/支付/点赞长期静默 500。
#
# 此守卫强制所有新迁移用纯 14 位时间戳命名（scripts/new-migration.sh
# 的产物），让"应用到生产"始终可被 ledger 记录。只检查本次推送 *新增*
# 的迁移文件 —— 历史字母后缀文件不在 diff 里，不受影响。
#
# 接口：与 check-service-layer.sh 一致 —— 从 stdin 读变更文件列表。
# 在 .git/hooks/pre-push 中如此调用：
#   echo "$CHANGED_FILES_INCL_SQL" | scripts/check-migration-naming.sh || exit 1
# （注意：pre-push 的 $CHANGED_FILES 只含 .ts/.tsx — 需单独取 .sql 变更，
#   见 README / 钩子内的接入片段。）

set -uo pipefail   # 注意:不用 -e —— git diff 超时/失败时要 fail-open,不能中断

# 有界 + fail-open（2026-06-13 实测根因修复）：
# 此守卫在 pre-push 关键路径、early-exit 之前对每次推送都跑。原版无超时,
# 机器高负载时 git diff 排队 >120s,拖垮看门狗、卡死所有人的推送。
# 命名守卫是 nicety(防字母后缀新迁移)非安全门 —— 慢了就跳过(fail-open),
# 绝不拖死推送。单次 diff(去掉原来的重复 diff)。
RANGE='@{push}..'
git rev-parse '@{push}' >/dev/null 2>&1 || RANGE='HEAD~1'
ADDED_MIGRATIONS=$(timeout 15 git diff --diff-filter=A --name-only "$RANGE" 2>/dev/null \
  | grep -E '^supabase/migrations/.*\.sql$' || true)

[ -z "$ADDED_MIGRATIONS" ] && exit 0

BAD=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  base=$(basename "$f")
  # 合法：14 位时间戳 + 下划线（YYYYMMDDHHMMSS_）。
  # 拒绝：8 位日期 + 字母（20260319h_）或任何非纯时间戳前缀。
  if ! echo "$base" | grep -qE '^[0-9]{14}_'; then
    BAD="$BAD  $f"$'\n'
  fi
done <<< "$ADDED_MIGRATIONS"

if [ -n "$BAD" ]; then
  echo "" >&2
  echo "❌ 迁移命名守卫：以下新迁移不是纯 14 位时间戳命名：" >&2
  echo "$BAD" >&2
  echo "字母后缀/非时间戳命名无法进 supabase ledger → schema 漂移根源。" >&2
  echo "请用 scripts/new-migration.sh <description> 重新生成，或改名为" >&2
  echo "YYYYMMDDHHMMSS_<desc>.sql 格式。" >&2
  exit 1
fi

exit 0
