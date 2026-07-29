#!/usr/bin/env bash

# Reuse the full PostgreSQL 17 staging-only dependency and attestation fixture,
# then select the publication-plan-specific transaction/ACL proof.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

for scenario in \
  'omit-identity:legacy' \
  'profit-factor:legacy' \
  'none:legacy' \
  'none:trusted' \
  'none:expired'; do
  manifest_mutation="${scenario%%:*}"
  retain_mode="${scenario##*:}"
  ARENA_ATOMIC_WRITER_STAGING_ONLY=1 \
  ARENA_ATOMIC_WRITER_STAGING_XID_REPAIR_TIMING=before-writes \
  ARENA_ATOMIC_WRITER_PUBLICATION_PLAN=1 \
  ARENA_ATOMIC_WRITER_PUBLICATION_PLAN_MANIFEST_MUTATION="$manifest_mutation" \
  ARENA_ATOMIC_WRITER_PUBLICATION_PLAN_RETAIN_MODE="$retain_mode" \
    bash "$ROOT_DIR/supabase/migrations/__tests__/leaderboard-rank-generation-atomic-writer.pg17.sh"
done
