#!/usr/bin/env bash

# PostgreSQL 17 proof for atomic, clear-safe direct-message search.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export DM_PAGE_EXTRA_MIGRATION="$ROOT_DIR/supabase/migrations/20260729171000_atomic_direct_message_search.sql"
export DM_PAGE_EXTRA_PROOF="$ROOT_DIR/supabase/migrations/__tests__/atomic-direct-message-search.proof.pg17.sh"

exec "$ROOT_DIR/supabase/migrations/__tests__/atomic-direct-message-conversation-page.pg17.sh"
