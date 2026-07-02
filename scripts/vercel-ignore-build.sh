#!/bin/bash
# Vercel Ignored Build Step（企业级差距整改 C2：CI 门禁部署）
#
# exit 0 = 跳过构建；exit 1 = 正常构建。
# 架构：main 的生产构建不再由 git push 直接触发，而是由
# .github/workflows/deploy-gate.yml 在 CI 门禁作业全绿后用 Vercel CLI 部署
# （CLI 部署不经过本脚本——Ignored Build Step 只对 git 集成触发的构建生效）。
#
# - Preview/PR 分支：照常构建（exit 1），开发体验不变
# - main 生产构建：跳过（exit 0），交给 deploy-gate
# - 逃生口：commit message 含 [deploy-force] → 立即直接构建（绕过 CI 门禁，
#   仅限紧急修复；用后必须在 RUNBOOK 事后补记原因）

REF="${VERCEL_GIT_COMMIT_REF:-}"
MSG="${VERCEL_GIT_COMMIT_MESSAGE:-}"

# 非生产环境（preview 等）照常构建
if [ "${VERCEL_ENV:-}" != "production" ]; then
  echo "[ignore-build] preview build — proceed"
  exit 1
fi

# 紧急逃生口
case "$MSG" in
  *"[deploy-force]"*)
    echo "[ignore-build] [deploy-force] detected — bypassing CI gate, building now"
    exit 1
    ;;
esac

if [ "$REF" = "main" ]; then
  echo "[ignore-build] main production push — skipped; deploy-gate.yml deploys after CI gate jobs pass"
  exit 0
fi

exit 1
