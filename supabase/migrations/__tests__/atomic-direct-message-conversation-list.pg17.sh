#!/usr/bin/env bash

# PostgreSQL 17 proof for the statement-snapshot direct-message inbox. The
# conversation-page harness owns the isolated cluster and production-shaped DM
# dependencies; this extension installs and exercises the list authority.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export DM_PAGE_EXTRA_MIGRATION="$ROOT_DIR/supabase/migrations/20260729170000_atomic_direct_message_conversation_list.sql"
export DM_PAGE_EXTRA_PROOF="$ROOT_DIR/supabase/migrations/__tests__/atomic-direct-message-conversation-list.proof.pg17.sh"

exec "$ROOT_DIR/supabase/migrations/__tests__/atomic-direct-message-conversation-page.pg17.sh"
