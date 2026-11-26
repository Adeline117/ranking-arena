#!/usr/bin/env bash

# PostgreSQL 17 proof that 20261124225312_hero_stats_exclude_idle_window still
# applies on the public view as the LATEST migration chain defines it.
#
# hero-stats-exclude-idle-window.pg17.sh proves the migration itself on the
# 20260816184500 + 20261123021904 view. A later migration, 20261124114140,
# re-creates public.public_ranked_leaderboard and the functions it reads. This
# proof runs on that view:
#
#   1. The fixture is the one 20261124114140's own proof builds
#      (stale-source-hides-only-its-own-rows.pg17.sh): that script is sourced
#      unmodified, so its whole proof runs first and leaves its cluster, its
#      sealed seasons and its helpers (psql_as, assert_equal) in this shell.
#      Whatever chain that proof applies is the chain this one runs on.
#   2. The preflight of 20261124225312 still holds there: the function body is
#      the 20261114103025 one with the 2 second timeout (no later migration
#      redefined it) and the re-created view still has a boolean idle_window.
#   3. The migration applies as the non-superuser owner; afterwards the hero
#      counts are the served 90D rows that are not idle and their sources.
#   4. A replay changes nothing.
#
# Isolated cluster on a private socket; never touches application data.

set -Eeuo pipefail

HERO_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HERO_MIGRATIONS="$HERO_ROOT_DIR/supabase/migrations"
HERO_BASELINE_MIGRATION="$HERO_MIGRATIONS/20261114103025_hero_stats_sealed_public_cohort.sql"
HERO_IDLE_MIGRATION="$HERO_MIGRATIONS/20261124225312_hero_stats_exclude_idle_window.sql"
LATEST_VIEW_PROOF="$HERO_MIGRATIONS/__tests__/stale-source-hides-only-its-own-rows.pg17.sh"

HERO_CURRENT_STATE='9462c36f5e983078e8e25479aa8ad7235a448d428f7abeaebaa2ab3bfcaaf944|{"search_path=pg_catalog, pg_temp",statement_timeout=2s}'
HERO_NEW_STATE='9cfaca2859c780d4ae0b2c886a4f1c0f5cf48accb5341ff3308710a132528b4b|{"search_path=pg_catalog, pg_temp",statement_timeout=5s}'

# 1. Build the latest view chain by running its own proof in this shell. Its
#    EXIT trap stops the cluster and removes the data directory when this
#    script ends, whatever the outcome.
# shellcheck source=/dev/null
source "$LATEST_VIEW_PROOF"

for helper in psql_as assert_equal; do
  if [[ "$(type -t "$helper")" != "function" ]]; then
    echo "hero stats: $LATEST_VIEW_PROOF no longer defines $helper" >&2
    exit 1
  fi
done

hero_stats() {
  psql_as anon -Atqc "SELECT exchange_count || '|' || trader_count FROM public.get_hero_stats()"
}
hero_function() {
  psql_as postgres -Atqc "
    SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') || '|' || proconfig::text
      FROM pg_proc WHERE oid = to_regprocedure('public.get_hero_stats()')"
}
# Served 90D rows as "sources|rows", with an optional extra predicate.
served_90d() {
  psql_as anon -Atqc "
    SELECT count(DISTINCT source) || '|' || count(*) FROM public.public_ranked_leaderboard
     WHERE season_id = '90D' $1"
}

assert_equal "hero stats: migrations run as a non-superuser owner" "f" \
  "$(psql_as postgres -Atqc "SELECT rolsuper FROM pg_roles WHERE rolname = current_user")"

# 2. The function as the repository last defined it before 20261124225312,
#    installed on the latest view.
PGOPTIONS='-c client_min_messages=warning' psql_as postgres -q -f "$HERO_BASELINE_MIGRATION" >/dev/null
assert_equal "hero stats: the body and configuration 20261124225312 expects are the installed ones" \
  "$HERO_CURRENT_STATE" "$(hero_function)"
assert_equal "hero stats: the re-created view still has a boolean idle_window column" "boolean" \
  "$(psql_as postgres -Atqc "
     SELECT format_type(atttypid, atttypmod) FROM pg_attribute
      WHERE attrelid = 'public.public_ranked_leaderboard'::regclass AND attname = 'idle_window'")"

HERO_SERVED="$(served_90d '')"
if [[ "${HERO_SERVED%%|*}" -lt 2 ]]; then
  echo "hero stats: the fixture must serve at least two 90D sources (got $HERO_SERVED)" >&2
  exit 1
fi
assert_equal "hero stats before: every served 90D row and source" "$HERO_SERVED" "$(hero_stats)"

# One served source becomes idle-only (no ROI and no PnL in the period).
HERO_IDLE_SOURCE="$(psql_as anon -Atqc "SELECT min(source) FROM public.public_ranked_leaderboard WHERE season_id = '90D'")"
psql_as postgres -q -c "
  UPDATE public.leaderboard_ranks SET score_factors = '{\"idle_window\":true}'
   WHERE season_id = '90D' AND source = '$HERO_IDLE_SOURCE'" >/dev/null
assert_equal "hero stats: marking rows idle does not change what the view serves" \
  "$HERO_SERVED" "$(served_90d '')"
HERO_ACTIVE="$(served_90d 'AND NOT idle_window')"
assert_equal "hero stats: one source fewer has rows with performance" \
  "$(( ${HERO_SERVED%%|*} - 1 ))" "${HERO_ACTIVE%%|*}"
assert_equal "hero stats before 20261124225312: idle rows are counted" "$HERO_SERVED" "$(hero_stats)"

# 3. Apply on the latest view.
psql_as postgres -q -f "$HERO_IDLE_MIGRATION" >/dev/null
assert_equal "hero stats: 20261124225312 applies on the latest view, with its body and a 5 second timeout" \
  "$HERO_NEW_STATE" "$(hero_function)"
assert_equal "hero stats after: only served rows that are not idle, and their sources" \
  "$HERO_ACTIVE" "$(hero_stats)"

# 4. Replay.
psql_as postgres -q -f "$HERO_IDLE_MIGRATION" >/dev/null
assert_equal "hero stats: a replay leaves the function as it is" "$HERO_NEW_STATE" "$(hero_function)"
assert_equal "hero stats: a replay changes no count" "$HERO_ACTIVE" "$(hero_stats)"

echo "hero stats on the latest view chain PostgreSQL 17 proof passed"
