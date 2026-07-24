#!/usr/bin/env bash
# Transactional deployment for the Singapore PM2 ingest worker.
#
# Production mutations require an explicit full target SHA that is still exact
# origin/main. The committed source is materialized once, a complete candidate
# is prepared beside the live tree, and PM2 is stopped only for the atomic
# directory cutover. Any failure after stop restores the previous directory and
# process while the same token-fenced remote lease is still held.
#
# Usage:
#   bash worker/deploy-ingest-sg.sh --target-sha=<40hex> --dry-run
#   bash worker/deploy-ingest-sg.sh --target-sha=<40hex> --code-only
#   bash worker/deploy-ingest-sg.sh --target-sha=<40hex>
#   bash worker/deploy-ingest-sg.sh --target-sha=<40hex> \
#     --from-artifact=arena-ingest-deps.tgz \
#     --artifact-manifest=arena-ingest-deps.manifest
#
# `--force-npm-ci` is an emergency-only fallback. It runs in the isolated
# candidate tree, never in the live worker directory, and the candidate must
# pass module-load verification before cutover.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

VPS_HOST="${INGEST_SG_HOST:-root@45.76.152.169}"
if [[ ! "$VPS_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "✗ INGEST_SG_HOST must be a fixed user@hostname value" >&2
  exit 2
fi
REMOTE_DIR="/opt/arena-ingest"
PM2_APP="arena-ingest-worker-sg"
DEPLOY_LOCK_DIR="$REMOTE_DIR.deploy-lock"
DEPLOY_LOCK_STALE_SECONDS=900

MODE="full"
FORCE_NPM_CI=0
FROM_ARTIFACT=""
ARTIFACT_MANIFEST=""
TARGET_SHA=""
MODE_ARGUMENTS=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) MODE="dry-run"; MODE_ARGUMENTS=$((MODE_ARGUMENTS + 1)) ;;
    --code-only) MODE="code-only"; MODE_ARGUMENTS=$((MODE_ARGUMENTS + 1)) ;;
    --force-npm-ci) FORCE_NPM_CI=1 ;;
    --from-artifact=*) FROM_ARTIFACT="${arg#*=}"; MODE="artifact"; MODE_ARGUMENTS=$((MODE_ARGUMENTS + 1)) ;;
    --artifact-manifest=*) ARTIFACT_MANIFEST="${arg#*=}" ;;
    --target-sha=*) TARGET_SHA="${arg#*=}" ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done
if [ "$MODE_ARGUMENTS" -gt 1 ]; then
  echo "✗ choose exactly one of --dry-run, --code-only, or --from-artifact" >&2
  exit 2
fi
if [ "$FORCE_NPM_CI" = 1 ] && [ "$MODE" != "full" ]; then
  echo "✗ --force-npm-ci is valid only in full mode" >&2
  exit 2
fi

if [ -z "$TARGET_SHA" ] && [ "$MODE" = "dry-run" ]; then
  TARGET_SHA="HEAD"
elif [ -z "$TARGET_SHA" ]; then
  echo "✗ mutating deploy requires --target-sha=<full origin/main SHA>" >&2
  exit 2
fi

SHA="$(GIT_NO_REPLACE_OBJECTS=1 git rev-parse --verify --quiet --end-of-options "${TARGET_SHA}^{commit}")" || {
  echo "✗ target SHA does not resolve to a commit" >&2
  exit 2
}
if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "✗ target must resolve to one full lowercase SHA-1 commit" >&2
  exit 2
fi

require_exact_main() {
  local main_sha
  git fetch --force --no-tags origin refs/heads/main:refs/remotes/origin/main --quiet
  main_sha="$(GIT_NO_REPLACE_OBJECTS=1 git rev-parse --verify origin/main^{commit})"
  if [ "$SHA" != "$main_sha" ]; then
    echo "✗ target $SHA is not exact origin/main $main_sha" >&2
    return 1
  fi
}

if [ "$MODE" != "dry-run" ]; then
  require_exact_main
fi

TS="$(date +%Y%m%d-%H%M%S)"
DEPLOY_LOCK_TOKEN="${SHA}-${TS}-$$-${RANDOM}"
STAGING_DIR="$REMOTE_DIR.staging-$DEPLOY_LOCK_TOKEN"
BACKUP_DIR="$REMOTE_DIR.bak-$TS"
REMOTE_ARTIFACT="/tmp/arena-ingest-deps-$DEPLOY_LOCK_TOKEN.tgz"
DEPLOY_LOCK_HELD=0
DEPLOY_LOCK_RENEW_PID=""
DEPLOY_SOURCE_DIR=""
RECOVERY_REQUIRED=0
CUTOVER_STARTED=0
DEPLOY_SUCCEEDED=0

CODE_PATHS=(.npmrc lib worker package.json package-lock.json tsconfig.json)
FULL_PATHS=("${CODE_PATHS[@]}")
RSYNC_EXCLUDES=(
  --exclude '.git' --exclude '.env' --exclude 'node_modules'
  --exclude 'worker/logs' --exclude '.arena-ingest' --exclude '*.log'
)

cleanup_local_source() {
  if [ -n "$DEPLOY_SOURCE_DIR" ]; then
    rm -rf "$DEPLOY_SOURCE_DIR"
  fi
}

# Archive output can diverge from blobs through export-subst attributes. Refuse
# that rarely-used mechanism instead of stamping bytes different from the
# helper's Git-object-derived release identity.
RELEASE_ATTRIBUTES="$(
  GIT_NO_REPLACE_OBJECTS=1 git ls-tree -r --name-only "$SHA" -- \
    .gitattributes lib/.gitattributes worker/.gitattributes \
    ':(glob)lib/**/.gitattributes' ':(glob)worker/**/.gitattributes'
)" || {
  echo "✗ unable to inspect worker release attributes" >&2
  exit 1
}
if grep -Eq '(^|/)\.gitattributes$' <<<"$RELEASE_ATTRIBUTES"; then
  echo "✗ worker release contains .gitattributes; exact archive bytes are not proven" >&2
  exit 1
fi

DEPLOY_SOURCE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/arena-ingest-release.XXXXXX")"
trap cleanup_local_source EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
GIT_NO_REPLACE_OBJECTS=1 git archive "$SHA" -- \
  .npmrc lib worker package.json package-lock.json tsconfig.json \
  scripts/ci/worker-release-id.mjs \
  | tar -xf - -C "$DEPLOY_SOURCE_DIR"
WORKER_RELEASE_ID="$(node "$DEPLOY_SOURCE_DIR/scripts/ci/worker-release-id.mjs" "$SHA")"
if [[ ! "$WORKER_RELEASE_ID" =~ ^[0-9a-f]{64}$ ]]; then
  echo "✗ worker release helper returned a malformed identity" >&2
  exit 1
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

dependency_input_hash() {
  local root="$1"
  local file digest
  {
    for file in .npmrc package.json package-lock.json; do
      digest="$(sha256_file "$root/$file")"
      printf '%s  %s\n' "$digest" "$file"
    done
  } | sha256_stdin
}

LOCAL_DEP_INPUTS_HASH="$(dependency_input_hash "$DEPLOY_SOURCE_DIR")"

parse_artifact_manifest() {
  local file="$1" key value
  local seen_target=0 seen_release=0 seen_dep=0 seen_node=0 seen_arch=0 seen_tar=0
  MF_TARGET_SHA="" MF_RELEASE_ID="" MF_DEP_HASH=""
  MF_NODE_MAJOR="" MF_ARCH="" MF_TARBALL_HASH=""

  [ -f "$file" ] || { echo "✗ artifact manifest not found: $file" >&2; return 1; }
  [ "$(wc -c < "$file" | tr -d ' ')" -le 4096 ] || {
    echo "✗ artifact manifest is oversized" >&2; return 1;
  }
  while IFS='=' read -r key value || [ -n "$key$value" ]; do
    case "$key" in
      TARGET_SHA) [ "$seen_target" = 0 ] || return 1; seen_target=1; MF_TARGET_SHA="$value" ;;
      WORKER_RELEASE_ID) [ "$seen_release" = 0 ] || return 1; seen_release=1; MF_RELEASE_ID="$value" ;;
      DEP_INPUTS_SHA256) [ "$seen_dep" = 0 ] || return 1; seen_dep=1; MF_DEP_HASH="$value" ;;
      NODE_MAJOR) [ "$seen_node" = 0 ] || return 1; seen_node=1; MF_NODE_MAJOR="$value" ;;
      ARCH) [ "$seen_arch" = 0 ] || return 1; seen_arch=1; MF_ARCH="$value" ;;
      TARBALL_SHA256) [ "$seen_tar" = 0 ] || return 1; seen_tar=1; MF_TARBALL_HASH="$value" ;;
      *) echo "✗ artifact manifest contains an unknown or blank key" >&2; return 1 ;;
    esac
  done < "$file"

  [ "$seen_target$seen_release$seen_dep$seen_node$seen_arch$seen_tar" = 111111 ] || {
    echo "✗ artifact manifest is incomplete" >&2; return 1;
  }
  [ "$MF_TARGET_SHA" = "$SHA" ] || { echo "✗ artifact target SHA mismatch" >&2; return 1; }
  [ "$MF_RELEASE_ID" = "$WORKER_RELEASE_ID" ] || { echo "✗ artifact release ID mismatch" >&2; return 1; }
  [ "$MF_DEP_HASH" = "$LOCAL_DEP_INPUTS_HASH" ] || { echo "✗ artifact dependency-input hash mismatch" >&2; return 1; }
  [[ "$MF_NODE_MAJOR" =~ ^[0-9]+$ ]] || { echo "✗ artifact Node major is malformed" >&2; return 1; }
  [ "$MF_ARCH" = "x64" ] || { echo "✗ artifact architecture must be x64" >&2; return 1; }
  [ "$MF_TARBALL_HASH" = "$(sha256_file "$FROM_ARTIFACT")" ] || {
    echo "✗ artifact tarball hash mismatch" >&2; return 1;
  }
}

if [ "$MODE" = "artifact" ]; then
  [ -f "$FROM_ARTIFACT" ] || { echo "✗ artifact not found: $FROM_ARTIFACT" >&2; exit 1; }
  [ -n "$ARTIFACT_MANIFEST" ] || { echo "✗ artifact mode requires --artifact-manifest" >&2; exit 1; }
  parse_artifact_manifest "$ARTIFACT_MANIFEST"
  tar -tzf "$FROM_ARTIFACT" | while IFS= read -r member; do
    normalized_member="${member%/}"
    case "$normalized_member" in
      node_modules|node_modules/*) ;;
      *) echo "✗ artifact contains an out-of-scope path: $member" >&2; exit 1 ;;
    esac
    case "/$normalized_member/" in
      */../*|*//*) echo "✗ artifact contains an unsafe path: $member" >&2; exit 1 ;;
    esac
  done
elif [ -n "$ARTIFACT_MANIFEST" ]; then
  echo "✗ --artifact-manifest is only valid with --from-artifact" >&2
  exit 2
fi

export RSYNC_RSH='ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=20'
ssh_sg() {
  ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=20 \
    -o ServerAliveInterval=20 -o ServerAliveCountMax=15 "$VPS_HOST" "$@"
}

assert_deploy_lock() {
  ssh_sg "test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'" || {
    echo "✗ lost the SG deploy lease; refusing further remote mutation" >&2
    return 1
  }
}

wait_for_fresh_ready() {
  local marker="$1" expected_sha="$2" expected_release="$3"
  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$expected_release" =~ ^[0-9a-f]{64}$ ]] || return 1
  ssh_sg "for i in \$(seq 1 90); do
    awk -v marker='$marker' -v sha='$expected_sha' -v release='$expected_release' '
      index(\$0, marker) { after = 1; ready = 0; heartbeat = 0; next }
      after && index(\$0, \"[ingest-worker] ready\") { ready = 1 }
      after && index(\$0, \"[heartbeat]\") &&
        index(\$0, \"sha=\" sha) && index(\$0, \"release=\" release) { heartbeat = 1 }
      END { exit !(ready && heartbeat) }
    ' '$REMOTE_DIR/worker/logs/ingest-out.log' && { echo READY; exit 0; }
    sleep 1
  done
  exit 1"
}

start_exact_pm2() {
  ssh_sg "set -eu
    pm2 delete '$PM2_APP' >/dev/null 2>&1 || true
    pm2 start '$REMOTE_DIR/worker/ecosystem.sg.config.cjs' --only '$PM2_APP'
    pm2 save >/dev/null
    pm2 jlist | node -e '
      let raw=""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => {
        const apps = JSON.parse(raw).filter(a => a.name === process.argv[1]);
        if (apps.length !== 1 || apps[0].pm2_env?.status !== "online" ||
            apps[0].pm2_env?.pm_cwd !== process.argv[2]) process.exit(1);
      });
    ' '$PM2_APP' '$REMOTE_DIR'"
}

recover_previous_release() {
  local rollback_sha rollback_release marker
  assert_deploy_lock || {
    echo "✗✗ lease lost after cutover; automatic rollback is unsafe, manual intervention required" >&2
    return 1
  }

  if [ "$CUTOVER_STARTED" = 1 ]; then
    ssh_sg "set -eu
      pm2 stop '$PM2_APP' >/dev/null 2>&1 || true
      pm2 delete '$PM2_APP' >/dev/null 2>&1 || true
      if [ -d '$BACKUP_DIR' ]; then
        rm -rf '$REMOTE_DIR.failed-$TS'
        if [ -e '$REMOTE_DIR' ]; then mv '$REMOTE_DIR' '$REMOTE_DIR.failed-$TS'; fi
        mv '$BACKUP_DIR' '$REMOTE_DIR'
        rm -rf '$REMOTE_DIR.failed-$TS'
      else
        test -d '$REMOTE_DIR'
      fi"
  fi

  rollback_sha="$(ssh_sg "cat '$REMOTE_DIR/DEPLOYED_SHA' 2>/dev/null" || true)"
  rollback_release="$(ssh_sg "cat '$REMOTE_DIR/WORKER_RELEASE_ID' 2>/dev/null" || true)"
  marker="arena-rollback-$TS"
  ssh_sg "mkdir -p '$REMOTE_DIR/worker/logs'; printf '%s\n' '$marker' >> '$REMOTE_DIR/worker/logs/ingest-out.log'"
  start_exact_pm2 || {
    echo "✗✗ previous SG release could not restart" >&2
    return 1
  }
  if ! wait_for_fresh_ready "$marker" "$rollback_sha" "$rollback_release"; then
    echo "✗✗ previous SG release restarted but exact rollback identity/ready evidence is unavailable" >&2
    return 1
  fi
  echo "✓ previous SG release restored with exact fresh identity evidence" >&2
}

release_deploy_lock() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [ "$status" -ne 0 ] && [ "$RECOVERY_REQUIRED" = 1 ] && [ "$DEPLOY_SUCCEEDED" = 0 ]; then
    recover_previous_release || status=1
  fi
  if [ -n "$DEPLOY_LOCK_RENEW_PID" ]; then
    kill "$DEPLOY_LOCK_RENEW_PID" 2>/dev/null || true
    wait "$DEPLOY_LOCK_RENEW_PID" 2>/dev/null || true
  fi
  if [ "$DEPLOY_LOCK_HELD" = 1 ]; then
    ssh_sg "if [ \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN' ]; then
      rm -rf '$STAGING_DIR'; rm -f '$REMOTE_ARTIFACT'; rm -rf '$DEPLOY_LOCK_DIR';
    fi" >/dev/null 2>&1 || true
  fi
  cleanup_local_source
  exit "$status"
}

acquire_deploy_lock() {
  local output
  if ! output="$(ssh_sg "set -eu
    lock_dir='$DEPLOY_LOCK_DIR'; token='$DEPLOY_LOCK_TOKEN'; stale_after='$DEPLOY_LOCK_STALE_SECONDS'
    now=\$(date +%s); created=0
    if mkdir \"\$lock_dir\" 2>/dev/null; then
      created=1
    else
      heartbeat=\$(stat -c %Y \"\$lock_dir/heartbeat\" 2>/dev/null || stat -c %Y \"\$lock_dir\" 2>/dev/null || echo 0)
      age=\$((now - heartbeat))
      if [ \"\$heartbeat\" -gt 0 ] && [ \"\$age\" -gt \"\$stale_after\" ]; then
        stale_dir=\"\$lock_dir.stale.\$token\"
        if mv \"\$lock_dir\" \"\$stale_dir\" 2>/dev/null; then
          rm -rf \"\$stale_dir\"; mkdir \"\$lock_dir\"; created=1
        fi
      fi
    fi
    if [ \"\$created\" -ne 1 ]; then
      owner=\$(cat \"\$lock_dir/owner\" 2>/dev/null || echo unknown)
      printf 'BUSY: SG ingest deploy lease is held by %s\n' \"\$owner\" >&2; exit 75
    fi
    printf '%s\n' \"\$token\" > \"\$lock_dir/owner\"; touch \"\$lock_dir/heartbeat\"; printf 'LOCKED\n'")"; then
    printf '%s\n' "$output" >&2
    return 1
  fi
  [ "$output" = LOCKED ] || { echo "✗ unexpected SG deploy lease evidence" >&2; return 1; }

  DEPLOY_LOCK_HELD=1
  trap release_deploy_lock EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  (
    while sleep 30; do
      ssh_sg "if [ \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN' ]; then touch '$DEPLOY_LOCK_DIR/heartbeat'; else exit 1; fi" \
        >/dev/null 2>&1 || exit 0
    done
  ) >/dev/null 2>&1 &
  DEPLOY_LOCK_RENEW_PID=$!
}

echo "=== SG ingest candidate $SHA release=$WORKER_RELEASE_ID mode=$MODE ==="

if [ "$MODE" = "dry-run" ]; then
  DRY_PATHS=()
  for path in "${FULL_PATHS[@]}"; do DRY_PATHS+=("$DEPLOY_SOURCE_DIR/$path"); done
  rsync -az --dry-run --itemize-changes --delete \
    "${RSYNC_EXCLUDES[@]}" "${DRY_PATHS[@]}" "$VPS_HOST:$REMOTE_DIR/" | sed 's/^/  /'
  exit 0
fi

echo "0/7 acquiring token-fenced SG deploy lease"
acquire_deploy_lock
assert_deploy_lock

# All remote inspection is inside the lease. Otherwise a Docker cutover or a
# second deploy could race between the check and our first mutation.
RUNNING_INGEST_CONTAINERS="$(
  ssh_sg "if command -v docker >/dev/null 2>&1; then
    { docker ps --format '{{.Names}}' | grep -E '^arena-ingest-worker-sg([_-].*)?$' || true;
      docker ps --filter 'label=com.arenafi.role=ingest-worker' --format '{{.Names}}' || true; } | sort -u
  fi"
)"
if [ -n "$RUNNING_INGEST_CONTAINERS" ]; then
  echo "✗ PM2 deploy refused: SG ingest container is running:" >&2
  printf '  %s\n' "$RUNNING_INGEST_CONTAINERS" >&2
  exit 1
fi

ssh_sg "pm2 jlist | node -e '
  let raw=""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => {
    const apps = JSON.parse(raw).filter(a => a.name === process.argv[1]);
    if (apps.length !== 1 || apps[0].pm2_env?.status !== "online" ||
        apps[0].pm2_env?.pm_cwd !== process.argv[2]) process.exit(1);
  });
' '$PM2_APP' '$REMOTE_DIR'" || {
  echo "✗ SG must have exactly one online PM2 owner in $REMOTE_DIR before deployment" >&2
  exit 1
}

REMOTE_RUNTIME="$(ssh_sg "node -p \"process.versions.node.split('.')[0] + ' ' + process.arch\"")"
if [ "$MODE" = "artifact" ]; then
  EXPECTED_RUNTIME="$MF_NODE_MAJOR $MF_ARCH"
else
  EXPECTED_RUNTIME='22 x64'
fi
if [ "$REMOTE_RUNTIME" != "$EXPECTED_RUNTIME" ]; then
  echo "✗ SG runtime mismatch: expected $EXPECTED_RUNTIME, got ${REMOTE_RUNTIME:-unknown}" >&2
  exit 1
fi

REMOTE_DEP_INPUTS_HASH="$(ssh_sg "set -eu; cd '$REMOTE_DIR'
  for f in .npmrc package.json package-lock.json; do
    test -f \"\$f\"; digest=\$(sha256sum \"\$f\" | awk '{print \$1}')
    printf '%s  %s\\n' \"\$digest\" \"\$f\"
  done | sha256sum | awk '{print \$1}'" || true)"
DEP_INPUTS_CHANGED=1
[ "$REMOTE_DEP_INPUTS_HASH" = "$LOCAL_DEP_INPUTS_HASH" ] && DEP_INPUTS_CHANGED=0
echo "dependency inputs changed vs remote: $([ "$DEP_INPUTS_CHANGED" = 1 ] && echo YES || echo no)"

if [ "$MODE" = "code-only" ] && [ "$DEP_INPUTS_CHANGED" = 1 ]; then
  echo "✗ --code-only refused: dependency install inputs differ" >&2
  exit 1
fi
if [ "$MODE" = "full" ] && [ "$DEP_INPUTS_CHANGED" = 1 ] && [ "$FORCE_NPM_CI" = 0 ]; then
  echo "✗ dependency inputs changed; use the attested CI artifact path" >&2
  exit 1
fi

echo "1/7 cloning live tree into an isolated candidate"
assert_deploy_lock
ssh_sg "set -eu; test -d '$REMOTE_DIR'; rm -rf '$STAGING_DIR'; cp -a '$REMOTE_DIR' '$STAGING_DIR'"

echo "2/7 syncing exact committed source into the candidate"
SOURCE_PATHS=()
for path in "${FULL_PATHS[@]}"; do SOURCE_PATHS+=("$DEPLOY_SOURCE_DIR/$path"); done
assert_deploy_lock
rsync -az --delete "${RSYNC_EXCLUDES[@]}" "${SOURCE_PATHS[@]}" "$VPS_HOST:$STAGING_DIR/"

echo "3/7 preparing candidate dependencies"
assert_deploy_lock
if [ "$MODE" = "artifact" ]; then
  scp -q -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=20 \
    "$FROM_ARTIFACT" "$VPS_HOST:$REMOTE_ARTIFACT"
  assert_deploy_lock
  ssh_sg "set -eu
    test \"\$(cat '$DEPLOY_LOCK_DIR/owner')\" = '$DEPLOY_LOCK_TOKEN'
    test \"\$(sha256sum '$REMOTE_ARTIFACT' | awk '{print \$1}')\" = '$MF_TARBALL_HASH'
    rm -rf '$STAGING_DIR/node_modules'
    tar --no-same-owner --no-same-permissions -xzf '$REMOTE_ARTIFACT' -C '$STAGING_DIR'
    test -d '$STAGING_DIR/node_modules'"
elif [ "$MODE" = "full" ] && [ "$DEP_INPUTS_CHANGED" = 1 ] && [ "$FORCE_NPM_CI" = 1 ]; then
  ssh_sg "cd '$STAGING_DIR' && npm ci"
fi

echo "4/7 loading every critical module from the isolated candidate"
assert_deploy_lock
ssh_sg "set -eu; cd '$STAGING_DIR'
  for m in bullmq ioredis viem abitype luxon @supabase/supabase-js pg ccxt playwright tsx dotenv esbuild; do
    node -e \"require.resolve(process.argv[1])\" \"\$m\"
  done
  test -x node_modules/.bin/tsx
  node_modules/.bin/tsx --eval '
    (async () => {
      for (const m of [\"bullmq\",\"ioredis\",\"pg\",\"ccxt\",\"viem\",\"abitype\",\"luxon\",\"@supabase/supabase-js\",\"dotenv\",\"esbuild\",\"playwright\"])
        await import(m)
    })().catch(error => { console.error(error); process.exit(1) })
  '"

echo "5/7 stamping candidate and rechecking exact main"
assert_deploy_lock
ssh_sg "set -eu
  printf '%s\n' '$SHA' > '$STAGING_DIR/.DEPLOYED_SHA.tmp'
  printf '%s\n' '$WORKER_RELEASE_ID' > '$STAGING_DIR/.WORKER_RELEASE_ID.tmp'
  mv '$STAGING_DIR/.DEPLOYED_SHA.tmp' '$STAGING_DIR/DEPLOYED_SHA'
  mv '$STAGING_DIR/.WORKER_RELEASE_ID.tmp' '$STAGING_DIR/WORKER_RELEASE_ID'"
require_exact_main

READY_MARKER="arena-deploy-$TS-${SHA:0:9}"
ssh_sg "mkdir -p '$STAGING_DIR/worker/logs'; printf '%s\n' '$READY_MARKER' >> '$STAGING_DIR/worker/logs/ingest-out.log'"

echo "6/7 stopping the sole PM2 owner and atomically switching directories"
assert_deploy_lock
RECOVERY_REQUIRED=1
ssh_sg "set -eu
  pm2 stop '$PM2_APP' >/dev/null
  for i in \$(seq 1 30); do
    pid=\$(pm2 pid '$PM2_APP' | tr -d '[:space:]')
    [ \"\$pid\" = 0 ] && exit 0
    sleep 1
  done
  exit 1"
assert_deploy_lock
CUTOVER_STARTED=1
ssh_sg "set -eu
  test \"\$(cat '$DEPLOY_LOCK_DIR/owner')\" = '$DEPLOY_LOCK_TOKEN'
  test ! -e '$BACKUP_DIR'
  mv '$REMOTE_DIR' '$BACKUP_DIR'
  mv '$STAGING_DIR' '$REMOTE_DIR'"

echo "7/7 starting and proving the exact fresh release"
start_exact_pm2
if ! wait_for_fresh_ready "$READY_MARKER" "$SHA" "$WORKER_RELEASE_ID"; then
  echo "✗ candidate did not report exact fresh ready evidence" >&2
  exit 1
fi

assert_deploy_lock
require_exact_main
DEPLOY_SUCCEEDED=1
RECOVERY_REQUIRED=0
ssh_sg "ls -d '$REMOTE_DIR'.bak-* 2>/dev/null | sort | head -n -3 | xargs -r rm -rf"
echo "✓ SG deploy complete: sha=$SHA release=$WORKER_RELEASE_ID"
