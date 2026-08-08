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
    "  ARENA_PUBLIC_RANKING_CACHE_PURGE_CONFIRM=$PURGE_CONTRACT:<org-id>:<project-id>:<production-hostname>:<release-sha>" \
    '  ARENA_EXPECTED_RELEASE_SHA=<pushed origin/main SHA>' \
    '  ARENA_VERCEL_PRODUCTION_ALIAS=<exact production hostname>' \
    '  VERCEL_PROJECT_ID=<exact production project ID>' \
    '  VERCEL_ORG_ID=<exact production owner/team ID>' \
    '  an authenticated, current Vercel CLI'
}

safe_identifier() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9_-]{4,128}$ ]]
}

safe_hostname() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] \
    && [[ "$value" == *.* ]] \
    && [[ "$value" != *..* ]]
}

attest_production_deployment() {
  local inspect_json deployment_id deployment_json rolling_release_json
  if ! inspect_json="$(
    vercel inspect "$PRODUCTION_ALIAS" \
      --format=json --cwd "$ROOT" --no-color
  )"; then
    echo 'failed to resolve the exact Vercel production alias' >&2
    return 1
  fi
  if ! deployment_id="$(
    jq -er --arg alias "$PRODUCTION_ALIAS" '
      select(
        type == "object"
        and .readyState == "READY"
        and .target == "production"
        and ((.aliases // []) | index($alias)) != null
      )
      | .id
      | select(type == "string" and test("^[A-Za-z0-9_]+$"))
    ' <<<"$inspect_json"
  )"; then
    echo 'Vercel alias does not resolve to one READY production deployment' >&2
    return 1
  fi
  if ! deployment_json="$(
    vercel api "/v13/deployments/$deployment_id" \
      --raw --cwd "$ROOT" --no-color
  )"; then
    echo 'failed to attest the resolved Vercel production deployment' >&2
    return 1
  fi
  if ! jq -e \
    --arg deployment_id "$deployment_id" \
    --arg project_id "$PROJECT_ID" \
    --arg org_id "$ORG_ID" \
    --arg release_sha "$EXPECTED_RELEASE" '
      type == "object"
      and .id == $deployment_id
      and .projectId == $project_id
      and .teamId == $org_id
      and .target == "production"
      and .readyState == "READY"
      and .meta.githubCommitSha == $release_sha
    ' <<<"$deployment_json" >/dev/null; then
    echo 'Vercel production deployment does not equal the exact project, owner, target, and release' >&2
    return 1
  fi
  if ! rolling_release_json="$(
    vercel api "/v1/projects/$PROJECT_ID/rolling-release?teamId=$ORG_ID" \
      --raw --cwd "$ROOT" --no-color
  )"; then
    echo 'failed to attest Vercel rolling-release state' >&2
    return 1
  fi
  if ! jq -e '
      type == "object"
      and has("rollingRelease")
      and .rollingRelease == null
    ' <<<"$rolling_release_json" >/dev/null; then
    echo 'an active Vercel rolling release can still route production traffic to old code' >&2
    return 1
  fi
  printf '%s\n' "$deployment_id"
}

if [[ "$MODE" == 'plan' ]]; then
  printf '%s\n' \
    "cache purge contract: $PURGE_CONTRACT" \
    'scope: the exact production alias + VERCEL_PROJECT_ID + VERCEL_ORG_ID supplied at execution' \
    'effect: purge the project Data cache and CDN cache' \
    'ordering: safe application release -> this purge -> fail-closed production probes -> 0547 authority migration -> postflight -> bounded V2 canary -> writer scale-up' \
    'plan mode performs no network or cache mutation'
  exit 0
fi

if [[ "$MODE" != 'apply' ]]; then
  usage >&2
  exit 64
fi

EXPECTED_RELEASE="${ARENA_EXPECTED_RELEASE_SHA:-}"
PRODUCTION_ALIAS="${ARENA_VERCEL_PRODUCTION_ALIAS:-}"
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
if ! safe_hostname "$PRODUCTION_ALIAS"; then
  echo 'ARENA_VERCEL_PRODUCTION_ALIAS must be one exact safe production hostname' >&2
  exit 1
fi
EXPECTED_CONFIRMATION="$PURGE_CONTRACT:$ORG_ID:$PROJECT_ID:$PRODUCTION_ALIAS:$EXPECTED_RELEASE"
if [[ "${ARENA_PUBLIC_RANKING_CACHE_PURGE_CONFIRM:-}" != "$EXPECTED_CONFIRMATION" ]]; then
  echo 'cache purge confirmation is not bound to the exact contract, target, and release' >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1 \
  || ! command -v jq >/dev/null 2>&1 \
  || ! command -v vercel >/dev/null 2>&1; then
  echo 'git, jq, and an authenticated Vercel CLI are required' >&2
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

# Git provenance is necessary but not sufficient: a failed deploy, rollback,
# or unpromoted build can leave the production alias on a different commit.
# Resolve the alias, reject split production traffic from a rolling release,
# and bind authenticated deployment metadata to the exact project/team/release
# before and after the cache mutation.
LIVE_DEPLOYMENT_ID="$(attest_production_deployment)"

# Official Vercel CLI behavior: omitting --type purges both the project Data
# cache and CDN cache. --yes prevents an operator prompt after every provenance
# and target check above has already passed. Authentication remains in the
# Vercel CLI credential store; no token is placed in argv or logs.
vercel cache purge --yes --cwd "$ROOT" --no-color
POST_PURGE_DEPLOYMENT_ID="$(attest_production_deployment)"
if [[ "$POST_PURGE_DEPLOYMENT_ID" != "$LIVE_DEPLOYMENT_ID" ]]; then
  echo 'Vercel production deployment changed during cache purge; cutover is NO-GO' >&2
  exit 1
fi
printf '%s\n' \
  "ranking authority Data/CDN cache purge completed for release $HEAD_SHA deployment $LIVE_DEPLOYMENT_ID"
