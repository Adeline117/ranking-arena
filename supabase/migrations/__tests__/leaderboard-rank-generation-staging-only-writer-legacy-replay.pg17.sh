#!/usr/bin/env bash

# Reuse the exact PostgreSQL 17 dependency/fixture harness while proving that
# staging-only cutover preserves receipts written before private staging.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

ARENA_ATOMIC_WRITER_LEGACY_CUTOVER_REPLAY=1 \
  bash "$ROOT_DIR/supabase/migrations/__tests__/leaderboard-rank-generation-atomic-writer.pg17.sh"
