#!/usr/bin/env bash
# Transactional deployment for the Singapore PM2 ingest worker.
#
# Production mutations require an explicit full target SHA that is still exact
# origin/main. The committed source is materialized once, a complete candidate
# is prepared beside the live tree, and PM2 is stopped only for the atomic
# directory cutover. A failure after stop restores the previous directory and
# process while remote connectivity and the same token-fenced lease remain
# available; otherwise the script fails loudly for supervised recovery.
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
SG_WORKER_NODE_ID="vps_sg"
SG_ROSTER_READY_TOKEN="[sg-heartbeat-proof] exact fresh Redis roster identity ready"
DEPLOY_LOCK_DIR="$REMOTE_DIR.deploy-lock"
# Manual removal is safe only after proving either (a) PM2 jlist plus both
# dump.pm2 files contain no untrusted SG owner, or (b) the current owner has
# exact SHA, release, PM2-process, and fresh Redis-roster evidence.
DEPLOY_RECOVERY_GUARD="$REMOTE_DIR.deploy-recovery-required"
DEPLOY_LOCK_STALE_SECONDS=900
DEPLOY_LOCK_MAX_HEARTBEAT_AGE_SECONDS=120

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
FAILED_DIR="$REMOTE_DIR.failed-$TS"
REMOTE_ARTIFACT="/tmp/arena-ingest-deps-$DEPLOY_LOCK_TOKEN.tgz"
DEPLOY_LOCK_HELD=0
DEPLOY_LOCK_RENEW_PID=""
DEPLOY_SOURCE_DIR=""
RECOVERY_REQUIRED=0
CUTOVER_STARTED=0
DEPLOY_SUCCEEDED=0
ROLLBACK_COMMITTED=0

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
  if [ -z "$DEPLOY_LOCK_RENEW_PID" ] || ! kill -0 "$DEPLOY_LOCK_RENEW_PID" 2>/dev/null; then
    echo "✗ lost the SG deploy lease renewer; refusing further remote mutation" >&2
    return 1
  fi
  ssh_sg "set -eu
    test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'
    now=\$(date +%s)
    heartbeat=\$(stat -c %Y '$DEPLOY_LOCK_DIR/heartbeat' 2>/dev/null || echo 0)
    age=\$((now - heartbeat))
    test \"\$heartbeat\" -gt 0
    test \"\$age\" -ge 0
    test \"\$age\" -le '$DEPLOY_LOCK_MAX_HEARTBEAT_AGE_SECONDS'" || {
    echo "✗ lost or stale SG deploy lease; refusing further remote mutation" >&2
    return 1
  }
}

arm_recovery_guard() {
  assert_deploy_lock || return 1
  ssh_sg "set -eu
    test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'
    printf '%s\n' '$SHA' > '$DEPLOY_RECOVERY_GUARD.tmp-$DEPLOY_LOCK_TOKEN'
    mv '$DEPLOY_RECOVERY_GUARD.tmp-$DEPLOY_LOCK_TOKEN' '$DEPLOY_RECOVERY_GUARD'
    test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'"
}

clear_recovery_guard() {
  assert_deploy_lock || return 1
  ssh_sg "set -eu
    test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'
    rm -f '$DEPLOY_RECOVERY_GUARD'
    test ! -e '$DEPLOY_RECOVERY_GUARD'
    test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'"
}

remote_now_ms() {
  local value
  value="$(ssh_sg "node -e 'process.stdout.write(String(Date.now()))'")" || return 1
  [[ "$value" =~ ^[0-9]{13}$ ]] || {
    echo "✗ SG clock returned a malformed millisecond timestamp" >&2
    return 1
  }
  printf '%s\n' "$value"
}

wait_for_candidate_log_evidence() {
  local marker="$1" expected_sha="$2" expected_release="$3"
  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$expected_release" =~ ^[0-9a-f]{64}$ ]] || return 1
  ssh_sg "for i in \$(seq 1 90); do
    test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN' || exit 1
    awk -v marker='$marker' -v node='$SG_WORKER_NODE_ID' \
      -v sha='$expected_sha' -v release='$expected_release' \
      -f '$REMOTE_DIR/worker/verify-sg-ready-log.awk' \
      '$REMOTE_DIR/worker/logs/ingest-out.log' && exit 0
    sleep 1
  done
  exit 1"
}

exact_pm2_pid() {
  local pid
  pid="$(ssh_sg "pm2 jlist | node -e '
    let raw=\"\"; process.stdin.on(\"data\", c => raw += c); process.stdin.on(\"end\", () => {
      const apps = JSON.parse(raw).filter(a => a.name === process.argv[1]);
      const pid = apps[0]?.pid;
      if (apps.length !== 1 || apps[0].pm2_env?.status !== \"online\" ||
          apps[0].pm2_env?.pm_cwd !== process.argv[2] || apps[0].pm2_env?.restart_time !== 0 ||
          !Number.isSafeInteger(pid) || pid <= 0)
        process.exit(1);
      process.stdout.write(String(pid));
    });
  ' '$PM2_APP' '$REMOTE_DIR'")" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$pid"
}

assert_exact_pm2_process() {
  local expected_pid="$1"
  [[ "$expected_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  ssh_sg "pm2 jlist | node -e '
    let raw=\"\"; process.stdin.on(\"data\", c => raw += c); process.stdin.on(\"end\", () => {
      const apps = JSON.parse(raw).filter(a => a.name === process.argv[1]);
      if (apps.length !== 1 || apps[0].pm2_env?.status !== \"online\" ||
          apps[0].pm2_env?.pm_cwd !== process.argv[2] || apps[0].pm2_env?.restart_time !== 0 ||
          String(apps[0].pid) !== process.argv[3])
        process.exit(1);
    });
  ' '$PM2_APP' '$REMOTE_DIR' '$expected_pid'"
}

prove_exact_pm2_stability() {
  local expected_pid="$1"
  [[ "$expected_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  ssh_sg "set -eu
    for sample in \$(seq 1 11); do
      test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'
      pm2 jlist | node -e '
        let raw=\"\"; process.stdin.on(\"data\", c => raw += c); process.stdin.on(\"end\", () => {
          const apps = JSON.parse(raw).filter(a => a.name === process.argv[1]);
          if (apps.length !== 1 || apps[0].pm2_env?.status !== \"online\" ||
              apps[0].pm2_env?.pm_cwd !== process.argv[2] || apps[0].pm2_env?.restart_time !== 0 ||
              String(apps[0].pid) !== process.argv[3])
            process.exit(1);
        });
      ' '$PM2_APP' '$REMOTE_DIR' '$expected_pid'
      if [ \"\$sample\" -lt 11 ]; then sleep 1; fi
    done"
}

verify_sg_roster() {
  local mode="$1" expected_sha="$2" expected_release="$3" not_before_ms="$4" pm2_pid="$5"
  local proof_root="${6:-$REMOTE_DIR}"
  [[ "$mode" = --candidate || "$mode" = --rollback ]] || return 1
  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  if [ "$mode" = --candidate ]; then
    [[ "$expected_release" =~ ^[0-9a-f]{64}$ ]] || return 1
  else
    [[ "$expected_release" = unknown || "$expected_release" =~ ^[0-9a-f]{64}$ ]] || return 1
  fi
  [[ "$not_before_ms" =~ ^[0-9]{13}$ ]] || return 1
  [[ "$pm2_pid" =~ ^[1-9][0-9]*$ ]] || return 1

  ssh_sg "set -eu
    test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'
    cd '$REMOTE_DIR'
    test -f '$proof_root/node_modules/tsx/dist/cli.mjs'
    test -f '$proof_root/worker/verify-sg-heartbeat.ts'
    node '$proof_root/node_modules/tsx/dist/cli.mjs' \
      '$proof_root/worker/verify-sg-heartbeat.ts' \
      '$mode' '$expected_sha' '$expected_release' '$not_before_ms' '$pm2_pid'
    test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'" |
    awk -v token="$SG_ROSTER_READY_TOKEN" '
      $0 == token { count += 1 }
      END { exit !(count == 1) }
    '
}

start_exact_pm2() {
  ssh_sg "set -eu
    test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'
    pm2 delete '$PM2_APP' >/dev/null 2>&1 || true
    pm2 start '$REMOTE_DIR/worker/ecosystem.sg.config.cjs' --only '$PM2_APP'
    pm2 jlist | node -e '
      let raw=\"\"; process.stdin.on(\"data\", c => raw += c); process.stdin.on(\"end\", () => {
        const apps = JSON.parse(raw).filter(a => a.name === process.argv[1]);
        if (apps.length !== 1 || apps[0].pm2_env?.status !== \"online\" ||
            apps[0].pm2_env?.pm_cwd !== process.argv[2] || apps[0].pm2_env?.restart_time !== 0)
          process.exit(1);
      });
    ' '$PM2_APP' '$REMOTE_DIR'
    test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'"
}

commit_exact_pm2() {
  local expected_pid="$1"
  [[ "$expected_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  ssh_sg "set -eu
    test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'
    pm2 jlist | node -e '
      let raw=\"\"; process.stdin.on(\"data\", c => raw += c); process.stdin.on(\"end\", () => {
        const apps = JSON.parse(raw).filter(a => a.name === process.argv[1]);
        if (apps.length !== 1 || apps[0].pm2_env?.status !== \"online\" ||
            apps[0].pm2_env?.pm_cwd !== process.argv[2] || apps[0].pm2_env?.restart_time !== 0 ||
            String(apps[0].pid) !== process.argv[3])
          process.exit(1);
      });
    ' '$PM2_APP' '$REMOTE_DIR' '$expected_pid'
    pm2 save >/dev/null
    test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'
    pm2 jlist | node -e '
      let raw=\"\"; process.stdin.on(\"data\", c => raw += c); process.stdin.on(\"end\", () => {
        const apps = JSON.parse(raw).filter(a => a.name === process.argv[1]);
        if (apps.length !== 1 || apps[0].pm2_env?.status !== \"online\" ||
            apps[0].pm2_env?.pm_cwd !== process.argv[2] || apps[0].pm2_env?.restart_time !== 0 ||
            String(apps[0].pid) !== process.argv[3])
          process.exit(1);
      });
    ' '$PM2_APP' '$REMOTE_DIR' '$expected_pid'"
}

clear_saved_pm2_owner() {
  ssh_sg "set -eu
    test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'
    pm2 delete '$PM2_APP' >/dev/null 2>&1 || true
    # PM2 intentionally returns success without replacing a non-empty dump when
    # the live list is empty unless --force is used. Save twice so both the
    # primary dump and PM2's fallback backup exclude this stable-path owner.
    pm2 save --force >/dev/null
    pm2 save --force >/dev/null
    node -e '
      const fs = require(\"node:fs\");
      const os = require(\"node:os\");
      const path = require(\"node:path\");
      const home = process.env.PM2_HOME || path.join(os.homedir(), \".pm2\");
      if (!path.isAbsolute(home)) process.exit(1);
      for (const filename of [\"dump.pm2\", \"dump.pm2.bak\"]) {
        const apps = JSON.parse(fs.readFileSync(path.join(home, filename), \"utf8\"));
        if (!Array.isArray(apps) || apps.some(app => app && app.name === process.argv[1]))
          process.exit(1);
      }
    ' '$PM2_APP'
    test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'
    pm2 jlist | node -e '
      let raw=\"\"; process.stdin.on(\"data\", c => raw += c); process.stdin.on(\"end\", () => {
        const apps = JSON.parse(raw).filter(a => a.name === process.argv[1]);
        if (apps.length !== 0) process.exit(1);
      });
    ' '$PM2_APP'"
}

quarantine_uncommitted_pm2_owner() {
  assert_deploy_lock || {
    echo "✗✗ uncommitted SG owner may still be running; lease unavailable, manual intervention required" >&2
    return 1
  }
  clear_saved_pm2_owner || {
    echo "✗✗ uncommitted SG owner could not be removed from live and saved PM2 state" >&2
    return 1
  }
  assert_deploy_lock || {
    echo "✗✗ uncommitted SG owner was stopped, but the deploy lease was lost before final quarantine proof" >&2
    return 1
  }
  clear_recovery_guard || {
    echo "✗✗ uncommitted SG owner was stopped, but the durable recovery guard could not be cleared" >&2
    return 1
  }
  echo "✗ uncommitted SG owner quarantined from live and saved PM2 state" >&2
}

recover_previous_release() {
  local rollback_sha rollback_release rollback_not_before_ms rollback_pm2_pid
  local rollback_proof_root="$STAGING_DIR"
  assert_deploy_lock || {
    echo "✗✗ lease lost after cutover; automatic rollback is unsafe, manual intervention required" >&2
    return 1
  }

  if [ "$CUTOVER_STARTED" = 1 ]; then
    ssh_sg "set -eu
      test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'
      pm2 stop '$PM2_APP' >/dev/null 2>&1 || true
      pm2 delete '$PM2_APP' >/dev/null 2>&1 || true
      if [ -d '$BACKUP_DIR' ]; then
        rm -rf '$FAILED_DIR'
        if [ -e '$REMOTE_DIR' ]; then mv '$REMOTE_DIR' '$FAILED_DIR'; fi
        mv '$BACKUP_DIR' '$REMOTE_DIR'
      else
        test -d '$REMOTE_DIR'
      fi
      test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'" || {
      echo "✗✗ previous SG release directory could not be restored" >&2
      return 1
    }
    if ssh_sg "test -f '$FAILED_DIR/worker/verify-sg-heartbeat.ts'"; then
      rollback_proof_root="$FAILED_DIR"
    else
      rollback_proof_root="$STAGING_DIR"
    fi
  fi

  rollback_sha="$(ssh_sg "cat '$REMOTE_DIR/DEPLOYED_SHA' 2>/dev/null" || true)"
  rollback_release="$(ssh_sg "cat '$REMOTE_DIR/WORKER_RELEASE_ID' 2>/dev/null" || true)"
  [[ "$rollback_sha" =~ ^[0-9a-f]{40}$ ]] || {
    echo "✗✗ previous SG release has no exact SHA stamp" >&2
    return 1
  }
  if [ -z "$rollback_release" ]; then
    rollback_release=unknown
  elif [[ ! "$rollback_release" =~ ^[0-9a-f]{64}$ ]]; then
    echo "✗✗ previous SG release has a malformed release stamp" >&2
    return 1
  fi
  rollback_not_before_ms="$(remote_now_ms)" || return 1
  assert_deploy_lock || return 1
  start_exact_pm2 || {
    echo "✗✗ previous SG release could not restart" >&2
    return 1
  }
  rollback_pm2_pid="$(exact_pm2_pid)" || {
    echo "✗✗ previous SG release has no exact live PM2 PID" >&2
    return 1
  }
  if ! verify_sg_roster --rollback "$rollback_sha" "$rollback_release" \
      "$rollback_not_before_ms" "$rollback_pm2_pid" "$rollback_proof_root"; then
    echo "✗✗ previous SG release restarted but fresh Redis roster evidence is unavailable" >&2
    return 1
  fi
  assert_exact_pm2_process "$rollback_pm2_pid" || {
    echo "✗✗ previous SG process changed after Redis roster proof" >&2
    return 1
  }
  assert_deploy_lock || return 1
  prove_exact_pm2_stability "$rollback_pm2_pid" || {
    echo "✗✗ previous SG process was not stable through its minimum uptime window" >&2
    return 1
  }
  if ! verify_sg_roster --rollback "$rollback_sha" "$rollback_release" \
      "$rollback_not_before_ms" "$rollback_pm2_pid" "$rollback_proof_root"; then
    echo "✗✗ previous SG release lost Redis roster evidence after its stability window" >&2
    return 1
  fi
  assert_exact_pm2_process "$rollback_pm2_pid" || {
    echo "✗✗ previous SG process changed after its stability proof" >&2
    return 1
  }
  assert_deploy_lock || return 1
  commit_exact_pm2 "$rollback_pm2_pid" || {
    echo "✗✗ previous SG process could not commit its proven PM2 state" >&2
    return 1
  }
  if [ "$rollback_proof_root" = "$FAILED_DIR" ]; then
    if ! ssh_sg "set -eu
      test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'
      rm -rf '$FAILED_DIR'"; then
      echo "⚠ previous SG release is proven, but failed-candidate cleanup did not complete" >&2
    fi
  fi
  assert_exact_pm2_process "$rollback_pm2_pid" || {
    echo "✗✗ previous SG process changed during rollback cleanup" >&2
    return 1
  }
  assert_deploy_lock || return 1
  ROLLBACK_COMMITTED=1
  clear_recovery_guard || {
    echo "✗✗ previous SG release is safely committed, but recovery-guard cleanup is uncertain; inspect '$DEPLOY_RECOVERY_GUARD' manually" >&2
    return 1
  }
  echo "✓ previous SG release restored with exact fresh Redis identity evidence" >&2
}

release_deploy_lock() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [ "$status" -ne 0 ] && [ "$RECOVERY_REQUIRED" = 1 ] && [ "$DEPLOY_SUCCEEDED" = 0 ]; then
    if ! recover_previous_release; then
      status=1
      if [ "$ROLLBACK_COMMITTED" = 0 ]; then
        quarantine_uncommitted_pm2_owner || {
          echo "✗✗ automatic SG quarantine failed; manual intervention required" >&2
        }
      fi
    fi
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
    lock_dir='$DEPLOY_LOCK_DIR'; guard='$DEPLOY_RECOVERY_GUARD'
    token='$DEPLOY_LOCK_TOKEN'; stale_after='$DEPLOY_LOCK_STALE_SECONDS'
    if [ -e \"\$guard\" ]; then
      printf 'BLOCKED: SG recovery guard requires manual inspection: %s\n' \"\$guard\" >&2
      exit 76
    fi
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
        >/dev/null 2>&1 || true
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
if ! RUNNING_INGEST_CONTAINERS="$(
  ssh_sg "set -eu
  set -o pipefail
  if command -v docker >/dev/null 2>&1; then
    snapshot=\$(docker ps --format '{{.Names}}|{{.Label \"com.arenafi.role\"}}') || exit 1
    printf '%s\n' \"\$snapshot\" | awk -F '|' '
      \$1 ~ /^arena-ingest-worker-sg([_-].*)?\$/ || \$2 == \"ingest-worker\" { print \$1 }
    ' | sort -u
  fi"
)"; then
  echo "✗ PM2 deploy refused: SG Docker ownership inspection failed" >&2
  exit 1
fi
if [ -n "$RUNNING_INGEST_CONTAINERS" ]; then
  echo "✗ PM2 deploy refused: SG ingest container is running:" >&2
  printf '  %s\n' "$RUNNING_INGEST_CONTAINERS" >&2
  exit 1
fi

ssh_sg "pm2 jlist | node -e '
  let raw=\"\"; process.stdin.on(\"data\", c => raw += c); process.stdin.on(\"end\", () => {
    const apps = JSON.parse(raw).filter(a => a.name === process.argv[1]);
    if (apps.length !== 1 || apps[0].pm2_env?.status !== \"online\" ||
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
  '
  node node_modules/tsx/dist/cli.mjs worker/preflight-sg-runtime.ts"

echo "5/7 stamping candidate and rechecking exact main"
assert_deploy_lock
ssh_sg "set -eu
  printf '%s\n' '$SHA' > '$STAGING_DIR/.DEPLOYED_SHA.tmp'
  printf '%s\n' '$WORKER_RELEASE_ID' > '$STAGING_DIR/.WORKER_RELEASE_ID.tmp'
  mv '$STAGING_DIR/.DEPLOYED_SHA.tmp' '$STAGING_DIR/DEPLOYED_SHA'
  mv '$STAGING_DIR/.WORKER_RELEASE_ID.tmp' '$STAGING_DIR/WORKER_RELEASE_ID'"
require_exact_main

assert_deploy_lock
CANDIDATE_NOT_BEFORE_MS="$(remote_now_ms)"
READY_MARKER="arena-deploy-$DEPLOY_LOCK_TOKEN"
ssh_sg "set -eu
  test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'
  mkdir -p '$STAGING_DIR/worker/logs'
  printf '%s\n' '$READY_MARKER' >> '$STAGING_DIR/worker/logs/ingest-out.log'"

echo "6/7 stopping the sole PM2 owner and atomically switching directories"
assert_deploy_lock
arm_recovery_guard
RECOVERY_REQUIRED=1
ssh_sg "set -eu
  test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'
  pm2 stop '$PM2_APP' >/dev/null
  for i in \$(seq 1 30); do
    test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'
    pid=\$(pm2 pid '$PM2_APP' | tr -d '[:space:]')
    [ \"\$pid\" = 0 ] && exit 0
    sleep 1
  done
  exit 1"
assert_deploy_lock
clear_saved_pm2_owner || {
  echo "✗ could not remove the unproven SG owner from saved PM2 state" >&2
  exit 1
}
assert_deploy_lock
CUTOVER_STARTED=1
ssh_sg "set -eu
  test \"\$(cat '$DEPLOY_LOCK_DIR/owner')\" = '$DEPLOY_LOCK_TOKEN'
  test ! -e '$BACKUP_DIR'
  mv '$REMOTE_DIR' '$BACKUP_DIR'
  mv '$STAGING_DIR' '$REMOTE_DIR'"

echo "7/7 starting and proving the exact fresh release"
start_exact_pm2
CANDIDATE_PM2_PID="$(exact_pm2_pid)" || {
  echo "✗ candidate has no exact live PM2 PID" >&2
  exit 1
}
if ! wait_for_candidate_log_evidence "$READY_MARKER" "$SHA" "$WORKER_RELEASE_ID"; then
  echo "✗ candidate did not report fresh Redis-committed log evidence" >&2
  exit 1
fi
assert_deploy_lock
if ! verify_sg_roster --candidate "$SHA" "$WORKER_RELEASE_ID" \
    "$CANDIDATE_NOT_BEFORE_MS" "$CANDIDATE_PM2_PID"; then
  echo "✗ candidate did not publish exact fresh Redis roster evidence" >&2
  exit 1
fi
assert_exact_pm2_process "$CANDIDATE_PM2_PID" || {
  echo "✗ candidate process changed after Redis roster proof" >&2
  exit 1
}
prove_exact_pm2_stability "$CANDIDATE_PM2_PID" || {
  echo "✗ candidate process was not stable through its minimum uptime window" >&2
  exit 1
}
if ! verify_sg_roster --candidate "$SHA" "$WORKER_RELEASE_ID" \
    "$CANDIDATE_NOT_BEFORE_MS" "$CANDIDATE_PM2_PID"; then
  echo "✗ candidate lost Redis roster evidence after its stability window" >&2
  exit 1
fi

assert_deploy_lock
require_exact_main
assert_exact_pm2_process "$CANDIDATE_PM2_PID" || {
  echo "✗ candidate process changed during final origin/main verification" >&2
  exit 1
}
assert_deploy_lock
if ! verify_sg_roster --candidate "$SHA" "$WORKER_RELEASE_ID" \
    "$CANDIDATE_NOT_BEFORE_MS" "$CANDIDATE_PM2_PID"; then
  echo "✗ candidate lost Redis roster evidence during final origin/main verification" >&2
  exit 1
fi
assert_exact_pm2_process "$CANDIDATE_PM2_PID" || {
  echo "✗ candidate process changed during final Redis roster verification" >&2
  exit 1
}
assert_deploy_lock
commit_exact_pm2 "$CANDIDATE_PM2_PID" || {
  echo "✗ candidate could not commit its proven PM2 state" >&2
  exit 1
}
assert_deploy_lock
DEPLOY_SUCCEEDED=1
RECOVERY_REQUIRED=0
if ! clear_recovery_guard; then
  echo "✗ candidate is safely committed, but recovery-guard cleanup is uncertain; inspect '$DEPLOY_RECOVERY_GUARD' manually" >&2
  exit 1
fi
if ! ssh_sg "set -eu
  test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'
  ls -d '$REMOTE_DIR'.bak-* 2>/dev/null | sort | head -n -3 | xargs -r rm -rf
  test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'"; then
  echo "⚠ SG deploy succeeded, but old-backup retention cleanup failed" >&2
fi
echo "✓ SG deploy complete: sha=$SHA release=$WORKER_RELEASE_ID"
