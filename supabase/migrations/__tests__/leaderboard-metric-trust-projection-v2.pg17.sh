#!/usr/bin/env bash

# PostgreSQL 17 production-shaped proof for the inert Arena Score v5 trust
# projection. The shared harness installs the full staging/publication chain;
# this scenario exits before any writer activation after proving projection v2.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

ARENA_ATOMIC_WRITER_STAGING_ONLY=1 \
ARENA_ATOMIC_WRITER_STAGING_XID_REPAIR_TIMING=before-writes \
ARENA_ATOMIC_WRITER_PUBLICATION_PLAN=1 \
ARENA_ATOMIC_WRITER_PUBLICATION_PLAN_MANIFEST_MUTATION=none \
ARENA_ATOMIC_WRITER_PUBLICATION_PLAN_RETAIN_MODE=legacy \
ARENA_ATOMIC_WRITER_PROJECTION_V2=1 \
  bash "$ROOT_DIR/supabase/migrations/__tests__/leaderboard-rank-generation-atomic-writer.pg17.sh"
