#!/usr/bin/env bash

# Reuse the exact PostgreSQL 17 dependency/fixture harness while selecting the
# staging-only writer cutover scenario. The legacy writer scenario remains the
# default in the underlying proof so both contracts stay independently gated.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

ARENA_ATOMIC_WRITER_STAGING_ONLY=1 \
  bash "$ROOT_DIR/supabase/migrations/__tests__/leaderboard-rank-generation-atomic-writer.pg17.sh"
