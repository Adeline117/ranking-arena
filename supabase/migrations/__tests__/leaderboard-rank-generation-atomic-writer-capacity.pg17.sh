#!/usr/bin/env bash

# Durable release-capacity gate for the atomic leaderboard-rank batch writer.
# The shared proof owns the real PG17 dependency bootstrap; benchmark mode keeps
# fsync and synchronous_commit enabled and executes 64 independent transactions.
# Insert and update run in fresh clusters so shared-buffer warmth cannot let one
# scenario subsidize the other. Release evidence may request up to five repeats.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
REPETITIONS="${ARENA_ATOMIC_WRITER_BENCHMARK_REPETITIONS:-1}"

if [[ ! "$REPETITIONS" =~ ^[1-5]$ ]]; then
  echo 'ARENA_ATOMIC_WRITER_BENCHMARK_REPETITIONS must be between 1 and 5' >&2
  exit 1
fi

for ((repetition = 1; repetition <= REPETITIONS; repetition += 1)); do
  for scenario in insert update; do
    printf 'capacity-run|repetition=%d|scenario=%s\n' "$repetition" "$scenario"
    ARENA_ATOMIC_WRITER_BENCHMARK_64K=1 \
      ARENA_ATOMIC_WRITER_BENCHMARK_SCENARIO="$scenario" \
      "$ROOT_DIR/supabase/migrations/__tests__/leaderboard-rank-generation-atomic-writer.pg17.sh"
  done
done
