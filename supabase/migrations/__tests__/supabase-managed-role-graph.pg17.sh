#!/usr/bin/env bash

# PostgreSQL 17 disposable proof that the 2026-08-17 role-graph guards accept
# the Supabase-managed memberships present on the hosted project while still
# rejecting any widening of them. Each guarded migration's own proof runs three
# ways: unchanged (bare cluster), with the hosted role graph overlaid, and with
# that graph plus the hosted migration executor (supabase_admin bootstrap,
# non-superuser postgres). Never connects to application or remote databases.
#
# 20260817061000 is expected to stop in the hosted-executor run until its
# superuser requirement for the partition event trigger is resolved.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TEST_DIR="$ROOT_DIR/supabase/migrations/__tests__"
WORK_DIR="$(mktemp -d /tmp/supabase-managed-role-graph.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

PROOFS=(
  rank-history-service-only-acl
  trader-activities-publication-fence
  notification-ranking-change-reader-fence
  arena-bot-legacy-publication-isolation
  trader-series-publication-isolation
  legacy-raw-metric-publication-isolation
)
HOSTED_EXPECTED_FAILURE='legacy-raw-metric-publication-isolation'
HOSTED_EXPECTED_MESSAGE='requires a superuser migration executor for partition event triggers'

# Rewrite a proof so its cluster is bootstrapped by supabase_admin. Proofs that
# connect as postgres get a superuser postgres for fixture setup (the shared
# proof demotes it before migrating); proofs that connect as the bootstrap
# user keep doing so through PGUSER.
hosted_copy() {
  python3 - "$1" "$2" <<'PY'
import re
import sys

source = open(sys.argv[1]).read().split('\n')
out = []
started = False
bare = False
for line in source:
    if '"$PG_BIN/initdb"' in line and not line.lstrip().startswith('for'):
        if '--username=postgres' in line:
            line = line.replace('--username=postgres', '--username=supabase_admin')
        else:
            bare = True
            line = line.replace('"$PG_BIN/initdb"', '"$PG_BIN/initdb" --username=supabase_admin')
    out.append(line)
    if not started and re.search(r'-w start >/dev/null\s*$', line):
        started = True
        if bare:
            out.append('export PGUSER=supabase_admin')
        else:
            out.append(
                '"$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" '
                '-U supabase_admin -d postgres -c "CREATE ROLE postgres LOGIN SUPERUSER"'
            )
if not started:
    sys.exit('cluster start not found in ' + sys.argv[1])
open(sys.argv[2], 'w').write('\n'.join(out))
PY
}

failures=0
for proof in "${PROOFS[@]}"; do
  script="$TEST_DIR/$proof.pg17.sh"
  hosted="$TEST_DIR/.hosted-$proof.pg17.sh"
  log="$WORK_DIR/$proof"

  for mode in bare graph hosted; do
    status=0
    case "$mode" in
      bare)
        bash "$script" >"$log.$mode" 2>&1 || status=$?
        ;;
      graph)
        SUPABASE_MANAGED_GRAPH_PROOF=1 bash "$script" >"$log.$mode" 2>&1 || status=$?
        ;;
      hosted)
        hosted_copy "$script" "$hosted"
        SUPABASE_MANAGED_GRAPH_PROOF=1 SUPABASE_MANAGED_GRAPH_EXECUTOR=hosted \
          bash "$hosted" >"$log.$mode" 2>&1 || status=$?
        rm -f "$hosted"
        ;;
    esac

    if [[ "$mode" == hosted && "$proof" == "$HOSTED_EXPECTED_FAILURE" ]]; then
      if ((status != 0)) && grep -Fq "$HOSTED_EXPECTED_MESSAGE" "$log.$mode"; then
        echo "[supabase-managed-role-graph] $proof $mode: blocked as expected (superuser executor)"
        continue
      fi
      echo "[supabase-managed-role-graph] $proof $mode: expected the superuser-executor stop" >&2
      tail -20 "$log.$mode" >&2
      failures=$((failures + 1))
      continue
    fi

    if ((status == 0)); then
      echo "[supabase-managed-role-graph] $proof $mode: passed"
    else
      echo "[supabase-managed-role-graph] $proof $mode: FAILED" >&2
      tail -20 "$log.$mode" >&2
      failures=$((failures + 1))
    fi
  done
done

if ((failures > 0)); then
  echo "[supabase-managed-role-graph] $failures proof run(s) failed" >&2
  exit 1
fi
echo "[supabase-managed-role-graph] all proof runs passed"
