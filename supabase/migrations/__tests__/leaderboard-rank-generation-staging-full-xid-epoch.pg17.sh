#!/usr/bin/env bash

# Run the complete staging-only writer proof after moving a disposable
# PostgreSQL 17 cluster into transaction-ID epoch 1. Then repeat with a real
# epoch-zero staged batch preserved across the offline epoch advance, proving
# both fresh writes and legacy metadata repair at the wrap boundary.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

ARENA_ATOMIC_WRITER_STAGING_ONLY=1 \
ARENA_ATOMIC_WRITER_STAGING_XID_EPOCH=1 \
  bash "$ROOT_DIR/supabase/migrations/__tests__/leaderboard-rank-generation-atomic-writer.pg17.sh"

ARENA_ATOMIC_WRITER_STAGING_ONLY=1 \
ARENA_ATOMIC_WRITER_STAGING_XID_EPOCH=1 \
ARENA_ATOMIC_WRITER_STAGING_XID_REPAIR_TIMING=after-batch-zero \
  bash "$ROOT_DIR/supabase/migrations/__tests__/leaderboard-rank-generation-atomic-writer.pg17.sh"
