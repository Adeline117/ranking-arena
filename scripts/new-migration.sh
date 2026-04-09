#!/bin/bash
# Generate a new migration filename with collision-proof timestamp prefix.
#
# Usage:
#   scripts/new-migration.sh add_trader_stats_index
#   scripts/new-migration.sh "add trader stats index"
#
# Output: prints the full path to an empty new migration file, ready for editing.
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

-- Up
-- TODO — write the migration SQL here
EOF

echo "$FULL_PATH"
