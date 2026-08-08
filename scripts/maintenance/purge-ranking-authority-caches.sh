#!/usr/bin/env bash

# Security cutover companion for public ranking/metric authority changes.
#
# A new cache key protects future writes, but it cannot retract an unsafe
# response that is already resident in Vercel's persistent Data or CDN cache.
# This command deliberately purges both cache classes for the exact linked
# production project. It is separate from the database migration transaction:
# operators run it after the fail-closed application release, before the
# authority migration enables the new reader. This keeps old CDN/Data entries
# out of the cutover while copier writers remain stopped.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="${1:-plan}"
PURGE_CONTRACT='public-rank-policy-v7+serving-metric-authority-v2+csr2'

usage() {
  printf '%s\n' \
    "usage: $0 {plan|apply}" \
    '' \
    'apply requires:' \
    "  ARENA_PUBLIC_RANKING_CACHE_PURGE_CONFIRM=$PURGE_CONTRACT:<org-id>:<project-id>:<release-sha>" \
    '  ARENA_EXPECTED_RELEASE_SHA=<pushed origin/main SHA>' \
    '  VERCEL_PROJECT_ID=<exact production project ID>' \
    '  VERCEL_ORG_ID=<exact production owner/team ID>' \
    '  an authenticated, current Vercel CLI'
}

safe_identifier() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9_-]{4,128}$ ]]
}

if [[ "$MODE" == 'plan' ]]; then
  printf '%s\n' \
    "cache purge contract: $PURGE_CONTRACT" \
    'scope: the exact VERCEL_PROJECT_ID + VERCEL_ORG_ID supplied at execution' \
    'effect: purge the project Data cache and CDN cache' \
    'ordering: safe application release -> this purge -> fail-closed production probes -> 0547 authority migration -> postflight -> writer restart' \
    'plan mode performs no network or cache mutation'
  exit 0
fi

if [[ "$MODE" != 'apply' ]]; then
  usage >&2
  exit 64
fi

EXPECTED_RELEASE="${ARENA_EXPECTED_RELEASE_SHA:-}"
PROJECT_ID="${VERCEL_PROJECT_ID:-}"
ORG_ID="${VERCEL_ORG_ID:-}"
if [[ ! "$EXPECTED_RELEASE" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'ARENA_EXPECTED_RELEASE_SHA must be one exact full Git SHA' >&2
  exit 1
fi
if ! safe_identifier "$PROJECT_ID" || ! safe_identifier "$ORG_ID"; then
  echo 'VERCEL_PROJECT_ID and VERCEL_ORG_ID must be explicit safe identifiers' >&2
  exit 1
fi
EXPECTED_CONFIRMATION="$PURGE_CONTRACT:$ORG_ID:$PROJECT_ID:$EXPECTED_RELEASE"
if [[ "${ARENA_PUBLIC_RANKING_CACHE_PURGE_CONFIRM:-}" != "$EXPECTED_CONFIRMATION" ]]; then
  echo 'cache purge confirmation is not bound to the exact contract, target, and release' >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1 || ! command -v vercel >/dev/null 2>&1; then
  echo 'git and an authenticated Vercel CLI are required' >&2
  exit 1
fi

if [[ -n "$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)" ]]; then
  echo 'cache purge requires a clean release worktree' >&2
  exit 1
fi

HEAD_SHA="$(git -C "$ROOT" rev-parse --verify HEAD)"
TRACKED_MAIN_SHA="$(git -C "$ROOT" rev-parse --verify refs/remotes/origin/main)"
LIVE_MAIN_SHA="$({ git -C "$ROOT" ls-remote --exit-code origin refs/heads/main || true; } | awk 'NR == 1 { print $1 }')"
if [[ "$HEAD_SHA" != "$EXPECTED_RELEASE" || "$TRACKED_MAIN_SHA" != "$EXPECTED_RELEASE" ]]; then
  echo 'cache purge release does not equal the expected local origin/main SHA' >&2
  exit 1
fi
if [[ "$LIVE_MAIN_SHA" != "$EXPECTED_RELEASE" ]]; then
  echo 'cache purge release does not equal the live pushed origin/main SHA' >&2
  exit 1
fi
if ! grep -Fq "PUBLIC_RANKING_CACHE_EPOCH = 'public-rank-policy-v7'" \
  "$ROOT/lib/rankings/publication-policy.ts" \
  || ! grep -Fq "SERVING_METRIC_AUTHORITY_CACHE_EPOCH = 'serving-metric-authority-v2'" \
    "$ROOT/lib/data/serving/cache-policy.ts" \
  || ! grep -Fq "COPIER_SNAPSHOT_RECORDS_CONTRACT = 'csr2'" \
    "$ROOT/lib/data/serving/cache-policy.ts"; then
  echo 'cache purge contract does not match the release cache authority epochs' >&2
  exit 1
fi

# Official Vercel CLI behavior: omitting --type purges both the project Data
# cache and CDN cache. --yes prevents an operator prompt after every provenance
# and target check above has already passed. Authentication remains in the
# Vercel CLI credential store; no token is placed in argv or logs.
vercel cache purge --yes --cwd "$ROOT" --no-color
printf '%s\n' "ranking authority Data/CDN cache purge completed for release $HEAD_SHA"
