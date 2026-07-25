#!/usr/bin/env bash
# Offline contract and behavior tests for the transactional Mac Mini ingest
# deploy. Every production-facing executable is replaced with an exported Bash
# function. The tests may create disposable local directories, but they never
# invoke real PM2, npm, SSH, or a database connection.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY_SCRIPT="$ROOT/worker/deploy-ingest-local.sh"
PREFLIGHT_SCRIPT="$ROOT/worker/preflight-local-release.ts"
HEARTBEAT_PROOF_SCRIPT="$ROOT/worker/verify-local-heartbeat.ts"
LOCAL_ECOSYSTEM="$ROOT/worker/ecosystem.local-ingest.config.cjs"
WORKER_ENV_EXAMPLE="$ROOT/worker/.env.example"
TEST_SHA='0123456789abcdef0123456789abcdef01234567'
OTHER_SHA='89abcdef0123456789abcdef0123456789abcdef'
TEST_RELEASE="$(printf 'a%.0s' {1..64})"
OLD_SHA="$(printf 'f%.0s' {1..40})"
OLD_RELEASE="$(printf 'e%.0s' {1..64})"
export TEST_SHA OTHER_SHA TEST_RELEASE OLD_SHA OLD_RELEASE

fail() {
  echo "not ok - $*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$label (missing: $needle)"
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  [[ "$haystack" != *"$needle"* ]] || fail "$label (unexpected: $needle)"
}

assert_matches() {
  local haystack="$1"
  local pattern="$2"
  local label="$3"
  grep -Eq -- "$pattern" <<<"$haystack" || fail "$label (pattern: $pattern)"
}

first_line_matching() {
  local pattern="$1"
  grep -nE -- "$pattern" "$DEPLOY_SCRIPT" | head -1 | cut -d: -f1
}

last_line_matching() {
  local pattern="$1"
  grep -nE -- "$pattern" "$DEPLOY_SCRIPT" | tail -1 | cut -d: -f1
}

assert_before() {
  local before_pattern="$1"
  local after_pattern="$2"
  local label="$3"
  local before_line after_line
  before_line="$(last_line_matching "$before_pattern")"
  after_line="$(last_line_matching "$after_pattern")"
  [ -n "$before_line" ] && [ -n "$after_line" ] || fail "$label (contract line absent)"
  [ "$before_line" -lt "$after_line" ] || fail "$label ($before_line !< $after_line)"
}

emit_test_archive() {
  command tar -cf - \
    .npmrc package.json package-lock.json tsconfig.json \
    scripts/ci/worker-release-id.mjs lib worker
}
export -f emit_test_archive

write_function_wrapper() {
  local path="$1"
  local function_name="$2"
  mkdir -p "$(dirname "$path")"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf 'export EVENT_LOG=%q\n' "$EVENT_LOG"
    printf 'export ACTIVE_CWD_FILE=%q\n' "$ACTIVE_CWD_FILE"
    printf 'export OLD_CWD=%q\n' "$OLD_CWD"
    printf 'export CANDIDATE_FAILED_FILE=%q\n' "$CANDIDATE_FAILED_FILE"
    printf 'export TEST_SHA=%q\n' "$TEST_SHA"
    printf 'export TEST_RELEASE=%q\n' "$TEST_RELEASE"
    printf 'export FAKE_NODE_PATH=%q\n' "${FAKE_NODE_PATH:-}"
    printf 'export FAKE_PM2_PATH=%q\n' "${FAKE_PM2_PATH:-}"
    printf 'export FAKE_GIT_COMMON_DIR=%q\n' "${FAKE_GIT_COMMON_DIR:-}"
    printf 'export ROOT=%q\n' "$ROOT"
    printf 'export FAIL_FIRST_CANDIDATE_READY=%q\n' \
      "${FAIL_FIRST_CANDIDATE_READY:-0}"
    printf 'export FAIL_ROLLBACK_START=%q\n' "${FAIL_ROLLBACK_START:-0}"
    printf 'export FAKE_MODULE_STATUS=%q\n' "${FAKE_MODULE_STATUS:-0}"
    printf 'export FAKE_PREFLIGHT_STATUS=%q\n' "${FAKE_PREFLIGHT_STATUS:-0}"
    declare -f fail emit_test_archive fake_npm_ci fake_git_environment fake_git_provenance \
      "$function_name"
    printf '%s "$@"\n' "$function_name"
  } > "$path"
  chmod +x "$path"
}

install_fake_command_wrappers() {
  local tmp="$1"
  export FAKE_NODE_PATH="$tmp/bin/node"
  export FAKE_PM2_PATH="$tmp/bin/pm2"
  export FAKE_GIT_COMMON_DIR="$tmp/fake-git-common"
  mkdir -p "$tmp/bin" "$tmp/pm2-home" "$FAKE_GIT_COMMON_DIR/objects/info"
  printf '%s\n' '// fake npm CLI; interpreted only by the fake Node command' > \
    "$tmp/bin/npm-cli.js"
  write_function_wrapper "$FAKE_NODE_PATH" fake_node
  write_function_wrapper "$FAKE_PM2_PATH" fake_pm2
  write_function_wrapper "$tmp/bin/git" git
}

fake_git_provenance() {
  local destination
  case "$*" in
    *'rev-parse --show-toplevel'*) printf '%s\n' "$ROOT" ;;
    *'remote get-url origin'*) printf '%s\n' 'git@github.com:Adeline117/ranking-arena.git' ;;
    *'rev-parse --git-common-dir'*) printf '%s\n' "$FAKE_GIT_COMMON_DIR" ;;
    *'init --bare --quiet '*)
      destination="${!#}"
      mkdir -p "$destination/objects" "$destination/refs"
      ;;
    *) return 64 ;;
  esac
}

fake_git_environment() {
  local forbidden
  [ "${GIT_ATTR_NOSYSTEM:-}" = 1 ] || fail 'fake Git requires system attributes disabled'
  [ "${GIT_CONFIG_NOSYSTEM:-}" = 1 ] || fail 'fake Git requires system config disabled'
  [ "${GIT_CONFIG_GLOBAL:-}" = /dev/null ] || fail 'fake Git requires global config disabled'
  for forbidden in GIT_WORK_TREE GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_COUNT \
    GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 GIT_CONFIG_SYSTEM; do
    [ -z "${!forbidden:-}" ] || fail "hostile $forbidden leaked into fake Git"
  done
  case "$*" in
    *archive*)
      [[ "${GIT_DIR:-}" = */.arena-isolated-git ]] || \
        fail 'archive must use an isolated bare GIT_DIR'
      [ "${GIT_OBJECT_DIRECTORY:-}" = "$FAKE_GIT_COMMON_DIR/objects" ] || \
        fail 'archive must use only the proven object directory'
      [ "${GIT_NO_REPLACE_OBJECTS:-}" = 1 ] || \
        fail 'archive must disable replacement objects'
      [ "${GIT_OPTIONAL_LOCKS:-}" = 0 ] || \
        fail 'archive must disable optional repository locks'
      ;;
    *)
      [ -z "${GIT_DIR:-}" ] || fail 'repository command inherited a foreign GIT_DIR'
      [ -z "${GIT_OBJECT_DIRECTORY:-}" ] || \
        fail 'repository command inherited a foreign object directory'
      ;;
  esac
}

fake_npm_ci() {
  printf 'npm cwd=%s args=ci\n' "$PWD" >> "$EVENT_LOG"
  mkdir -p \
    "$PWD/node_modules/tsx/dist" \
    "$PWD/node_modules/playwright" \
    "$PWD/node_modules/.bin" \
    "$PWD/.playwright-browsers/chromium-test"
  printf '%s\n' 'export {}' > "$PWD/node_modules/tsx/dist/cli.mjs"
  printf '%s\n' 'export {}' > "$PWD/node_modules/tsx/dist/loader.mjs"
  printf '%s\n' 'export {}' > "$PWD/node_modules/playwright/cli.js"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$PWD/node_modules/.bin/tsx"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$PWD/node_modules/.bin/playwright"
  chmod +x "$PWD/node_modules/.bin/tsx" "$PWD/node_modules/.bin/playwright"
}

make_old_release() {
  local release_root="$1"
  local shared_dir="$2"
  local old_dir="$3"
  mkdir -p \
    "$release_root" \
    "$shared_dir/.arena-ingest" \
    "$shared_dir/worker/logs" \
    "$shared_dir/worker" \
    "$old_dir/worker" \
    "$old_dir/worker/src" \
    "$old_dir/node_modules/tsx/dist" \
    "$old_dir/.playwright-browsers/chromium-test"
  printf '%s\n' \
    'WORKER_NODE_ID=mac-mini' \
    'INGEST_LOCAL_REGION=local' \
    'INGEST_REGIONS=local' \
    'INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED=true' \
    'REDIS_URL=rediss://offline.invalid:6380' \
    > "$shared_dir/worker/.env"
  chmod 600 "$shared_dir/worker/.env"
  printf '%s\n' "$OLD_SHA" > "$old_dir/DEPLOYED_SHA"
  printf '%s\n' "$OLD_RELEASE" > "$old_dir/WORKER_RELEASE_ID"
  printf '%s\n' 'export {}' > "$old_dir/node_modules/tsx/dist/cli.mjs"
  printf '%s\n' 'export {}' > "$old_dir/node_modules/tsx/dist/loader.mjs"
  printf '%s\n' 'export {}' > "$old_dir/worker/src/ingest-worker.ts"
  chmod +x "$old_dir/node_modules/tsx/dist/cli.mjs"
  ln -s "$shared_dir/.arena-ingest" "$old_dir/.arena-ingest"
  ln -s "$shared_dir/worker/logs" "$old_dir/worker/logs"
  ln -s "$shared_dir/worker/.env" "$old_dir/worker/.env"
  cp "$ROOT/worker/ecosystem.local-ingest.config.cjs" \
    "$old_dir/worker/ecosystem.local-ingest.config.cjs"
}

install_common_fake_functions() {
  git() {
    local provenance_status
    fake_git_environment "$@"
    printf 'git %s\n' "$*" >> "$EVENT_LOG"
    if fake_git_provenance "$@"; then return 0; else provenance_status=$?; fi
    [ "$provenance_status" -eq 64 ] || return "$provenance_status"
    case "$*" in
      *'fetch --force --no-tags origin refs/heads/main:refs/remotes/origin/main'*) return 0 ;;
      *'hash-object'*deploy-ingest-local.sh*) printf '%s\n' "$TEST_SHA" ;;
      *'rev-parse'*) printf '%s\n' "$TEST_SHA" ;;
      *'ls-tree'*worker/deploy-ingest-local.sh*)
        printf '100755 blob %s\tworker/deploy-ingest-local.sh\n' "$TEST_SHA"
        ;;
      *'ls-tree -r --name-only'*)
        printf '%s\n' .npmrc package.json package-lock.json tsconfig.json \
          scripts/ci/worker-release-id.mjs worker/deploy-ingest-local.sh
        ;;
      *'ls-tree -r '*' -- .npmrc'*)
        printf '100644 blob %s\t.npmrc\n' "$TEST_SHA"
        printf '100755 blob %s\tworker/deploy-ingest-local.sh\n' "$TEST_SHA"
        ;;
      *'archive'*) emit_test_archive ;;
      *) fail "unexpected fake git invocation: $*" ;;
    esac
  }

  npm() {
    [ "${1:-}" = ci ] || fail "only npm ci is allowed in deploy tests: $*"
    fake_npm_ci
  }

  npx() {
    printf 'npx cwd=%s args=%s\n' "$PWD" "$*" >> "$EVENT_LOG"
    mkdir -p "${PLAYWRIGHT_BROWSERS_PATH:-$PWD/.playwright-browsers}/chromium-test"
  }

  df() {
    printf '%s\n' \
      'Filesystem 1024-blocks Used Available Capacity Mounted on' \
      '/dev/fake 100000000 1000 99999000 1% /tmp'
  }

  ssh() { fail "local deployment must never invoke SSH: $*"; }
  scp() { fail "local deployment must never invoke SCP: $*"; }
  rsync() { fail "local deployment must never invoke rsync: $*"; }
  ps() {
    printf 'ps %s\n' "$*" >> "$EVENT_LOG"
    case "$*" in
      *'-axo pid=,ppid='*)
        printf '%s\n' '1 0' '4242 1' '4243 4242'
        ;;
      *'-axo pid=,command='*) printf '%s\n' '1 /sbin/launchd' ;;
      *'-p 4243'*) printf '%s\n' 4242 ;;
      *'-p 4242'*) printf '%s\n' 1 ;;
      *) fail "unexpected fake ps invocation: $*" ;;
    esac
  }

  fake_node() {
    local joined="$*"
    printf 'node cwd=%s args=%s\n' "$PWD" "$joined" >> "$EVENT_LOG"
    case "$joined" in
      *worker-release-id.mjs*) printf '%s\n' "$TEST_RELEASE" ;;
      *process.versions.node*process.arch*) printf '%s\n' '22 arm64 darwin' ;;
      *crypto.createHash*sha256*) printf '%s' "$TEST_RELEASE" ;;
      *'rows.some'*'const children'*) printf '%s\n' 4242 4243 ;;
      *releasePrefix*sharedPrefix*)
        while IFS= read -r _; do :; done
        ;;
      *verify-local-heartbeat.ts*--discover-existing*|*discover-local*|*discover*worker*node*)
        printf '%s\n' \
          '[redis] offline fake connection ready' \
          $'ARENA_LOCAL_EXISTING_ROSTER\tmac-mini\t4243'
        ;;
      *'new Set'*pm_cwd*)
        while IFS= read -r _; do :; done
        if [ -s "$ACTIVE_CWD_FILE" ] && [ ! -e "$ACTIVE_CWD_FILE.absent" ]; then
          printf '%s\n' "$(<"$ACTIVE_CWD_FILE")"
        fi
        ;;
      *'matches.length === 0'*)
        while IFS= read -r _; do :; done
        [ -e "$ACTIVE_CWD_FILE.absent" ] && return 0
        return 46
        ;;
      *'const appName'*pm_cwd*|*'const apps'*pm_cwd*)
        while IFS= read -r _; do :; done
        if [ -s "$ACTIVE_CWD_FILE" ] && [ ! -e "$ACTIVE_CWD_FILE.absent" ]; then
          printf '4242\037online\037%s\037%s\037%s/worker/src/ingest-worker.ts\0370\037[]\037["--max-old-space-size=2560","--import","%s/node_modules/tsx/dist/loader.mjs"]\037fork_mode\0371\n' \
            "$(<"$ACTIVE_CWD_FILE")" "$FAKE_NODE_PATH" \
            "$(<"$ACTIVE_CWD_FILE")" "$(<"$ACTIVE_CWD_FILE")"
        else
          return 41
        fi
        ;;
      *npm-cli.js*' ci') fake_npm_ci ;;
      *fs.renameSync*lock_token*|*lock_token*fs.renameSync*)
        printf '%s\n' \
          "${5:-arena.local-ingest-cutover-journal@1}" \
          "lock_token=${6:-missing}" \
          "phase=${7:-unknown}" \
          "target_sha=${8:-unknown}" \
          "target_release=${9:-unknown}" \
          "candidate_cwd=${10:-unknown}" \
          "old_cwd=${11:-unknown}" \
          "old_sha=${12:-unknown}" \
          "old_release=${13:-legacy}" \
          "old_pid=${14:-unknown}" \
          "old_node=${15:-unknown}" \
          "old_heartbeat_pid=${16:-unknown}" \
          "old_interpreter=${17:-unknown}" \
          "old_entrypoint=${18:-unknown}" \
          "old_args=${19:-unknown}" \
          "old_node_args=${20:-unknown}" \
          "old_exec_mode=${21:-unknown}" \
          "old_instances=${22:-unknown}" \
          "shared_env_sha256=${23:-unknown}" \
          > "${3:?fake recovery record path missing}"
        mv -f "$3" "${4:?fake recovery destination missing}"
        ;;
      *fs.openSync*lock_token*|*lock_token*fs.openSync*)
        printf '%s\n' \
          "${4:-arena.local-ingest-cutover-journal@1}" \
          "lock_token=${5:-missing}" \
          "phase=${6:-unknown}" \
          "target_sha=${7:-unknown}" \
          "target_release=${8:-unknown}" \
          "candidate_cwd=${9:-unknown}" \
          > "${3:?fake recovery record path missing}"
        ;;
      *fs.unlinkSync*) rm -f "${3:?fake recovery target missing}" ;;
      *JSON.stringify*max-old-space-size*)
        printf '["--max-old-space-size=2560","--import","%s"]' \
          "${3:?fake loader path missing}"
        ;;
      *Date.now*) printf '%s\n' 2000000000000 ;;
      *playwright/cli.js*install*)
        mkdir -p "${PLAYWRIGHT_BROWSERS_PATH:-$PWD/.playwright-browsers}/chromium-test"
        ;;
      *preflight-local-release.ts*) [ "${FAKE_PREFLIGHT_STATUS:-0}" -eq 0 ] ;;
      *require.resolve*|*'await import'*|*metric-trust*|*MetricTrust*)
        [ "${FAKE_MODULE_STATUS:-0}" -eq 0 ]
        ;;
      *) return 0 ;;
    esac
  }

  fake_pm2() {
    local command="${1:-}" active config release_dir log_file sha release marker
    printf 'pm2 %s\n' "$*" >> "$EVENT_LOG"
    active="$(<"$ACTIVE_CWD_FILE")"
    case "$command" in
      jlist)
        if [ -e "$ACTIVE_CWD_FILE.absent" ]; then
          printf '%s\n' '[]'
        else
          printf '[{"name":"arena-ingest-worker","pid":4242,"pm2_env":{"status":"online","pm_cwd":"%s","exec_interpreter":"%s","pm_exec_path":"%s/worker/src/ingest-worker.ts","restart_time":0,"args":[],"node_args":["--max-old-space-size=2560","--import","%s/node_modules/tsx/dist/loader.mjs"],"exec_mode":"fork_mode","instances":1}}]\n' \
            "$active" "$FAKE_NODE_PATH" "$active" "$active"
        fi
        ;;
      describe|show|status) return 0 ;;
      pid)
        if [ -e "$ACTIVE_CWD_FILE.absent" ]; then printf '%s\n' 0; else printf '%s\n' 4242; fi
        ;;
      stop|save) return 0 ;;
      delete) : > "$ACTIVE_CWD_FILE.absent" ;;
      start)
        config="${2:-}"
        case "$config" in
          */worker/ecosystem.local-ingest.config.cjs)
            release_dir="${config%/worker/ecosystem.local-ingest.config.cjs}"
            ;;
          *)
            release_dir="${ARENA_INGEST_RELEASE_DIR:-$active}"
            ;;
        esac
        if [ "${FAIL_ROLLBACK_START:-0}" = 1 ] && [ "$release_dir" = "$OLD_CWD" ] && \
          [ -e "$CANDIDATE_FAILED_FILE" ]; then
          return 73
        fi
        printf '%s\n' "$release_dir" > "$ACTIVE_CWD_FILE"
        rm -f "$ACTIVE_CWD_FILE.absent"
        log_file="$release_dir/worker/logs/ingest-out.log"
        mkdir -p "$(dirname "$log_file")"
        if [ "${FAIL_FIRST_CANDIDATE_READY:-0}" = 1 ] && \
          [ "$release_dir" != "$OLD_CWD" ] && [ ! -e "$CANDIDATE_FAILED_FILE" ]; then
          : > "$CANDIDATE_FAILED_FILE"
          return 0
        fi
        sha="$(<"$release_dir/DEPLOYED_SHA")"
        release="$(<"$release_dir/WORKER_RELEASE_ID")"
        marker="$(grep 'arena-\(deploy\|rollback\)-' "$log_file" | tail -1 || true)"
        [ -n "$marker" ] || marker='arena-test-marker'
        printf '%s\n' \
          '[ingest-worker] metric-trust database release contract ready' \
          '[ingest-worker] ready (regions=local, concurrency=5)' \
          "[heartbeat] node=mac-mini pid=4242 sha=$sha release=$release" \
          >> "$log_file"
        ;;
      *) fail "unexpected fake PM2 command: $*" ;;
    esac
  }

  export -f git npm npx df ssh scp rsync ps fake_node fake_pm2 fake_npm_ci fail emit_test_archive
}

run_fake_deploy() {
  local tmp="$1"
  shift
  ARENA_LOCAL_RELEASE_ROOT="$tmp/releases" \
  ARENA_LOCAL_SHARED_DIR="$tmp/shared" \
  ARENA_LOCAL_LOCK_DIR="$tmp/releases/.arena-ingest-deploy-lock-test" \
  ARENA_GIT_BIN="$tmp/bin/git" \
  ARENA_NODE_BIN="$tmp/bin/node" \
  ARENA_NPM_CLI="$tmp/bin/npm-cli.js" \
  ARENA_PM2_BIN="$tmp/bin/pm2" \
  ARENA_PM2_HOME="$tmp/pm2-home" \
  ARENA_READY_TIMEOUT_SECONDS=1 \
  GIT_ATTR_NOSYSTEM=0 GIT_CONFIG_NOSYSTEM=0 \
  GIT_CONFIG_GLOBAL="$tmp/hostile-global-config" \
  GIT_CONFIG_SYSTEM="$tmp/hostile-system-config" \
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.attributesFile \
  GIT_CONFIG_VALUE_0="$tmp/hostile-attributes" \
  GIT_DIR="$tmp/hostile-git-dir" GIT_WORK_TREE="$tmp/hostile-worktree" \
  GIT_OBJECT_DIRECTORY="$tmp/hostile-objects" \
  GIT_ALTERNATE_OBJECT_DIRECTORIES="$tmp/hostile-alternates" \
  "$@" bash "$DEPLOY_SCRIPT" "--target-sha=$TEST_SHA"
}

block_for_archive() {
  awk '
    /"\$GIT_BIN" archive "\$SHA" --/ { capture = 1 }
    capture { print }
    capture && /\|[[:space:]]*\/usr\/bin\/tar[[:space:]]+-xf/ { exit }
  ' "$DEPLOY_SCRIPT"
}

test_exact_target_and_archive_contract() {
  local deploy archive_block executable_lines
  deploy="$(<"$DEPLOY_SCRIPT")"
  archive_block="$(block_for_archive)"
  executable_lines="$(sed -E '/^[[:space:]]*#/d; /^[[:space:]]*$/d' "$DEPLOY_SCRIPT")"

  assert_contains "$deploy" '--target-sha=<40hex>' \
    'mutating local deploy must document an explicit full target'
  assert_contains "$deploy" 'GIT_INPUT="${ARENA_GIT_BIN:-/usr/bin/git}"' \
    'Git provenance must begin with one explicit absolute executable'
  assert_contains "$deploy" 'GIT_BIN="$(canonical_executable "$GIT_INPUT"' \
    'Git executable must be canonical, real, and executable'
  assert_contains "$deploy" '"$GIT_BIN" -C "$REPO_DIR" "$@"' \
    'all repository reads must bind the exact canonical worktree'
  assert_contains "$deploy" 'GIT_CONFIG_GLOBAL=/dev/null' \
    'repository reads must ignore user-global Git configuration'
  assert_contains "$deploy" 'GIT_CONFIG_NOSYSTEM=1' \
    'repository reads must ignore system Git configuration'
  assert_contains "$deploy" 'GIT_ATTR_NOSYSTEM=1' \
    'repository reads must ignore system Git attributes'
  assert_contains "$deploy" 'git_command rev-parse --show-toplevel' \
    'deploy must prove the exact Git worktree root'
  assert_contains "$deploy" 'git_command remote get-url origin' \
    'deploy must prove the authorized origin identity'
  assert_contains "$deploy" "git@github.com:Adeline117/ranking-arena.git" \
    'authorized origin must be an exact repository identity'
  assert_contains "$deploy" 'GIT_OBJECT_DIR="$(canonical_directory "$GIT_COMMON_DIR/objects"' \
    'archive must bind one canonical local object store'
  assert_contains "$deploy" '$GIT_OBJECT_DIR/info/alternates' \
    'alternate object stores must fail closed'
  assert_contains "$deploy" 'isolated_git="$destination/.arena-isolated-git"' \
    'archive must use candidate-owned isolated Git metadata'
  assert_contains "$deploy" '"$GIT_BIN" init --bare --quiet "$isolated_git"' \
    'archive metadata must be an empty isolated bare repository'
  assert_contains "$deploy" 'GIT_DIR="$isolated_git" GIT_OBJECT_DIRECTORY="$GIT_OBJECT_DIR"' \
    'archive must combine isolated metadata only with the proven object directory'
  assert_matches "$deploy" '\[\[.*SHA.*\^\[0-9a-f\].*40' \
    'resolved target must be checked as a full lowercase SHA'
  assert_contains "$deploy" \
    'git_command fetch --force --no-tags origin refs/heads/main:refs/remotes/origin/main' \
    'local deploy must fetch the authoritative main ref'
  assert_contains "$deploy" 'git_command rev-parse --verify origin/main^{commit}' \
    'local deploy must resolve the fetched main commit'
  assert_matches "$deploy" '\[ "\$SHA" (=|!=) "\$main_sha" \]' \
    'local deploy must reject a target other than exact main'
  assert_matches "$deploy" 'git_command hash-object .*deploy-ingest-local\.sh|git_command hash-object .*"\$SCRIPT_PATH"' \
    'running deploy orchestrator must hash its own exact bytes'
  assert_matches "$deploy" '\$SHA:worker/deploy-ingest-local\.sh|git_command ls-tree "\$SHA" -- worker/deploy-ingest-local\.sh' \
    'orchestrator self-hash must compare with the reviewed target blob'
  assert_contains "$deploy" '100755' \
    'reviewed deploy orchestrator must retain its executable Git mode'
  assert_contains "$archive_block" '"$GIT_BIN" archive "$SHA" --' \
    'release source must be archived from the exact reviewed commit'

  for required in .npmrc lib worker package.json package-lock.json tsconfig.json \
    scripts/ci/worker-release-id.mjs; do
    assert_contains "$archive_block" "$required" "exact archive must include $required"
  done
  for forbidden in app components public styles .env.local; do
    assert_not_contains "$archive_block" "$forbidden" \
      "worker archive must exclude UI or local-secret path $forbidden"
  done
  assert_contains "$deploy" 'WORKER_RELEASE_ID' \
    'candidate must carry the deterministic reviewed release identity'
  assert_matches "$deploy" '"\$(source_root|STAGING_DIR)/scripts/ci/worker-release-id\.mjs"' \
    'release identity helper must execute from the exact archived candidate'
  assert_before 'archive_worker_release "\$STAGING_DIR"' \
    '\$STAGING_DIR/scripts/ci/worker-release-id\.mjs' \
    'exact archive materialization must precede release identity derivation'
  assert_contains "$deploy" 'DEPLOYED_SHA' \
    'candidate must carry the exact reviewed commit identity'
  assert_not_contains "$executable_lines" 'git checkout' \
    'deployment must not materialize a mutable worktree checkout'
  echo 'ok - exact current-main target and worker-only archive are mandatory'
}

test_non_main_target_fails_before_local_mutation() {
  local tmp event_log old_dir output status events
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  event_log="$tmp/events"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  : > "$event_log"
  export EVENT_LOG="$event_log" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions

  git() {
    local provenance_status
    fake_git_environment "$@"
    printf 'git %s\n' "$*" >> "$EVENT_LOG"
    if fake_git_provenance "$@"; then return 0; else provenance_status=$?; fi
    [ "$provenance_status" -eq 64 ] || return "$provenance_status"
    case "$*" in
      *'fetch --force --no-tags origin refs/heads/main:refs/remotes/origin/main'*) return 0 ;;
      *'rev-parse'*'origin/main'*) printf '%s\n' "$OTHER_SHA" ;;
      *'rev-parse'*) printf '%s\n' "$TEST_SHA" ;;
      *) fail "unexpected git after non-main mismatch: $*" ;;
    esac
  }
  export -f git
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail 'non-main target must fail closed'
  assert_contains "$output" 'not exact origin/main' \
    'target mismatch must be explicit'
  events="$(<"$event_log")"
  [[ "$events" != *'archive'* ]] || \
    fail 'target mismatch must precede source materialization'
  assert_not_contains "$events" 'npm cwd=' 'target mismatch must precede candidate install'
  assert_not_contains "$events" 'pm2 stop' 'target mismatch must precede PM2 stop'
  [ ! -e "$tmp/releases/.arena-ingest-deploy-lock-test" ] || \
    fail 'target mismatch must precede deploy lock mutation'
  rm -rf "$tmp"
  echo 'ok - stale or unreviewed target fails before local mutation'
}

test_dirty_or_stale_orchestrator_fails_before_local_mutation() {
  local tmp old_dir output status events
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions
  git() {
    local provenance_status
    fake_git_environment "$@"
    printf 'git %s\n' "$*" >> "$EVENT_LOG"
    if fake_git_provenance "$@"; then return 0; else provenance_status=$?; fi
    [ "$provenance_status" -eq 64 ] || return "$provenance_status"
    case "$*" in
      *'fetch --force --no-tags origin refs/heads/main:refs/remotes/origin/main'*) return 0 ;;
      *'hash-object'*deploy-ingest-local.sh*) printf '%s\n' "$OTHER_SHA" ;;
      *'rev-parse'*) printf '%s\n' "$TEST_SHA" ;;
      *'ls-tree'*worker/deploy-ingest-local.sh*)
        printf '100755 blob %s\tworker/deploy-ingest-local.sh\n' "$TEST_SHA"
        ;;
      *) fail "unexpected git after orchestrator mismatch: $*" ;;
    esac
  }
  export -f git
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail 'dirty or stale deploy orchestrator must fail closed'
  assert_matches "$output" 'orchestrator|deploy script|reviewed.*script|self.*mismatch' \
    'self-attestation failure must explain the reviewed-script mismatch'
  events="$(<"$EVENT_LOG")"
  assert_not_contains "$events" 'git archive' 'self mismatch must precede release materialization'
  assert_not_contains "$events" 'npm cwd=' 'self mismatch must precede candidate install'
  assert_not_contains "$events" 'pm2 stop' 'self mismatch must precede PM2 stop'
  [ ! -e "$tmp/releases/.arena-ingest-deploy-lock-test" ] || \
    fail 'self mismatch must precede deploy lock mutation'
  rm -rf "$tmp"
  echo 'ok - dirty or stale orchestrator fails before any local mutation'
}

test_archive_invocation_has_no_ui_paths() {
  local tmp event_log old_dir output status archive_event events
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  event_log="$tmp/events"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  : > "$event_log"
  export EVENT_LOG="$event_log" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions

  git() {
    local provenance_status
    fake_git_environment "$@"
    printf 'git %s\n' "$*" >> "$EVENT_LOG"
    if fake_git_provenance "$@"; then return 0; else provenance_status=$?; fi
    [ "$provenance_status" -eq 64 ] || return "$provenance_status"
    case "$*" in
      *'fetch --force --no-tags origin refs/heads/main:refs/remotes/origin/main'*) return 0 ;;
      *'hash-object'*deploy-ingest-local.sh*) printf '%s\n' "$TEST_SHA" ;;
      *'rev-parse'*) printf '%s\n' "$TEST_SHA" ;;
      *'ls-tree'*worker/deploy-ingest-local.sh*)
        printf '100755 blob %s\tworker/deploy-ingest-local.sh\n' "$TEST_SHA"
        ;;
      *'ls-tree -r --name-only'*)
        printf '%s\n' .npmrc package.json package-lock.json tsconfig.json \
          scripts/ci/worker-release-id.mjs worker/deploy-ingest-local.sh
        ;;
      *'ls-tree -r '*' -- .npmrc'*)
        printf '100644 blob %s\t.npmrc\n' "$TEST_SHA"
        printf '100755 blob %s\tworker/deploy-ingest-local.sh\n' "$TEST_SHA"
        ;;
      *'archive'*) return 71 ;;
      *) fail "unexpected git before deliberate archive failure: $*" ;;
    esac
  }
  export -f git
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail 'deliberate archive failure must fail deployment'
  events="$(<"$event_log")"
  assert_contains "$events" 'rev-parse --show-toplevel' \
    'executed deploy must prove its canonical Git worktree'
  assert_contains "$events" 'remote get-url origin' \
    'executed deploy must prove its authorized origin'
  assert_contains "$events" 'rev-parse --git-common-dir' \
    'executed deploy must resolve its canonical Git object store'
  assert_contains "$events" 'init --bare --quiet' \
    'executed archive must create isolated bare metadata'
  archive_event="$(grep 'git archive' "$event_log" || true)"
  [ -n "$archive_event" ] || { printf '%s\n' "$output" >&2; fail 'test must reach exact archive'; }
  for required in .npmrc lib worker package.json package-lock.json tsconfig.json \
    scripts/ci/worker-release-id.mjs; do
    assert_contains "$archive_event" "$required" "archive command must include $required"
  done
  for forbidden in ' app ' ' components ' ' public ' ' styles ' '.env.local'; do
    assert_not_contains " $archive_event " "$forbidden" \
      "archive command must exclude $forbidden"
  done
  assert_not_contains "$events" 'npm cwd=' 'failed archive must precede candidate install'
  assert_not_contains "$events" 'pm2 stop' 'failed archive must precede PM2 stop'
  rm -rf "$tmp"
  echo 'ok - executed archive is exact-worker-only and cannot carry UI paths'
}

test_release_owned_dependencies_and_secret_scope() {
  local deploy executable_lines install_block
  deploy="$(<"$DEPLOY_SCRIPT")"
  executable_lines="$(sed -E '/^[[:space:]]*#/d; /^[[:space:]]*$/d' "$DEPLOY_SCRIPT")"
  install_block="$(awk '
    /installing release-owned dependencies/ { capture = 1 }
    capture { print }
    capture && /installing and launching release-owned Chromium/ { exit }
  ' "$DEPLOY_SCRIPT")"

  assert_contains "$install_block" 'cd "$STAGING_DIR"' \
    'npm ci must enter the isolated candidate, never the development worktree'
  assert_contains "$install_block" '"$NPM_CLI" ci' \
    'isolated install must invoke the Node-22-bound npm CLI'
  assert_contains "$deploy" '.playwright-browsers' \
    'browser bytes must be owned by the immutable candidate release'
  assert_matches "$deploy" '(test|\[)[[:space:]]+![[:space:]]+-L.*node_modules' \
    'candidate must prove node_modules is not a symlink'
  assert_matches "$deploy" '(test|\[)[[:space:]]+![[:space:]]+-L.*(PLAYWRIGHT|\.playwright-browsers)' \
    'candidate must prove browser dependencies are not a symlink'
  if grep -Eq 'ln[[:space:]].*\.env\.local|\.env\.local.*ln[[:space:]]' \
    <<<"$executable_lines"; then
    fail 'local application secrets must never be linked into a worker release'
  fi
  if grep -Eq '^[[:space:]]*(ssh|scp|rsync|npm)[[:space:]]' \
    <<<"$executable_lines"; then
    fail 'local transaction must not invoke SSH, SCP, rsync, or ambient npm commands'
  fi
  if grep -Eq 'ln[[:space:]].*node_modules|node_modules.*ln[[:space:]]' <<<"$executable_lines"; then
    fail 'node_modules must never be shared or symlinked between releases'
  fi
  assert_contains "$deploy" 'worker/.env' \
    'the dedicated mode-0600 worker secret is the only env file in scope'
  assert_matches "$deploy" 'portable_mode.*SHARED_ENV_FILE|SHARED_ENV_FILE.*mode 0600' \
    'shared worker secret must be proven mode 0600'
  echo 'ok - dependencies are release-owned and secret linking is narrowly scoped'
}

test_all_candidate_gates_precede_pm2_stop() {
  local deploy stop_line runtime_line disk_line modules_line db_line
  deploy="$(<"$DEPLOY_SCRIPT")"
  stop_line="$(last_line_matching 'pm2[[:space:]].*stop.*arena-ingest-worker|\$PM2_BIN.*stop.*\$PM2_APP|pm2_command[[:space:]]+stop')"
  runtime_line="$(last_line_matching '22 arm64|NODE_MAJOR.*22.*ARCH.*arm64')"
  disk_line="$(last_line_matching 'df[[:space:]].*-P|DISK.*(FREE|AVAILABLE)|available.*disk')"
  modules_line="$(last_line_matching 'require\.resolve|critical module|critical-module')"
  db_line="$(last_line_matching 'metric-trust|MetricTrust|database release.*ready|release-readiness')"

  for item in stop_line runtime_line disk_line modules_line db_line; do
    [ -n "${!item}" ] || fail "pre-stop contract marker missing: $item"
  done
  [ "$runtime_line" -lt "$stop_line" ] || fail 'Node 22 arm64 gate must precede PM2 stop'
  [ "$disk_line" -lt "$stop_line" ] || fail 'disk-capacity gate must precede PM2 stop'
  [ "$modules_line" -lt "$stop_line" ] || fail 'actual module-load gate must precede PM2 stop'
  [ "$db_line" -lt "$stop_line" ] || fail 'production DB release gate must precede PM2 stop'

  assert_contains "$deploy" 'process.versions.node' \
    'runtime gate must inspect the effective Node executable'
  assert_contains "$deploy" 'process.arch' \
    'runtime gate must inspect arm64 architecture'
  assert_contains "$deploy" '22 arm64 darwin' \
    'Mac runtime must be exactly Node 22 arm64 on Darwin'
  echo 'ok - runtime, disk, modules, browser, and database all gate cutover'
}

test_deploy_lock_and_signal_recovery_contract() {
  local deploy
  deploy="$(<"$DEPLOY_SCRIPT")"
  assert_contains "$deploy" 'ARENA_LOCAL_LOCK_DIR' \
    'tests and operators need one explicit local deploy lock location'
  assert_matches "$deploy" 'mkdir[[:space:]].*\$.*LOCK' \
    'deploy lock acquisition must use atomic mkdir'
  assert_contains "$deploy" 'BUSY:' \
    'concurrent local deployment must fail with explicit lock evidence'
  assert_matches "$deploy" "trap[[:space:]]+.*INT" \
    'SIGINT must route through cleanup and recovery'
  assert_matches "$deploy" "trap[[:space:]]+.*TERM" \
    'SIGTERM must route through cleanup and recovery'
  assert_matches "$deploy" "exit[[:space:]]+130|return[[:space:]]+130" \
    'SIGINT must preserve a non-zero terminal status'
  assert_matches "$deploy" "exit[[:space:]]+143|return[[:space:]]+143" \
    'SIGTERM must preserve a non-zero terminal status'
  assert_contains "$deploy" 'recover_previous_release' \
    'post-stop EXIT and signal failures must share centralized rollback'
  echo 'ok - atomic local lock and signal-safe centralized rollback are required'
}

test_busy_lock_refuses_before_candidate_or_pm2_stop() {
  local tmp old_dir output status events
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions
  install_fake_command_wrappers "$tmp"
  mkdir -p "$tmp/releases/.arena-ingest-deploy-lock-test"
  printf '%s\n%s\n' 'another-deployment' "$$" > \
    "$tmp/releases/.arena-ingest-deploy-lock-test/owner"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail 'a live local deploy lock must refuse concurrency'
  assert_contains "$output" 'BUSY:' 'lock contention must identify the existing deploy'
  events="$(<"$EVENT_LOG")"
  assert_not_contains "$events" 'npm cwd=' 'lock contention must precede candidate install'
  assert_not_contains "$events" 'pm2 stop' 'lock contention must precede PM2 stop'
  assert_not_contains "$events" 'pm2 delete' 'lock contention must precede PM2 mutation'
  [ -d "$tmp/releases/.arena-ingest-deploy-lock-test" ] || \
    fail 'a contender must not remove the owner lock'
  rm -rf "$tmp"
  echo 'ok - live deploy lock rejects a contender before candidate or PM2 mutation'
}

test_runtime_mismatch_fails_before_pm2_stop() {
  local tmp old_dir output status events
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions
  fake_node() {
    local joined="$*"
    printf 'node cwd=%s args=%s\n' "$PWD" "$joined" >> "$EVENT_LOG"
    case "$joined" in
      *worker-release-id.mjs*) printf '%s\n' "$TEST_RELEASE" ;;
      *process.versions.node*process.arch*) printf '%s\n' '21 x64 linux' ;;
      *verify-local-heartbeat.ts*--discover-existing*|*discover-local*|*discover*worker*node*)
        printf '%s\n' \
          '[redis] offline fake connection ready' \
          $'ARENA_LOCAL_EXISTING_ROSTER\tmac-mini\t4243'
        ;;
      *'new Set'*pm_cwd*)
        while IFS= read -r _; do :; done
        printf '%s\n' "$(<"$ACTIVE_CWD_FILE")"
        ;;
      *'const appName'*pm_cwd*|*JSON.parse*filter*)
        while IFS= read -r _; do :; done
        printf '4242\037online\037%s\037%s\037%s/worker/src/ingest-worker.ts\0370\037[]\037["--max-old-space-size=2560","--import","%s/node_modules/tsx/dist/loader.mjs"]\037fork_mode\0371\n' \
          "$(<"$ACTIVE_CWD_FILE")" "$FAKE_NODE_PATH" \
          "$(<"$ACTIVE_CWD_FILE")" "$(<"$ACTIVE_CWD_FILE")"
        ;;
      *) return 0 ;;
    esac
  }
  export -f fake_node
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail 'wrong local Node runtime must fail deployment'
  assert_matches "$output" 'runtime mismatch|expected 22 arm64|requires Node 22 arm64' \
    'runtime mismatch must explain the exact required platform'
  events="$(<"$EVENT_LOG")"
  assert_not_contains "$events" 'pm2 stop' 'runtime gate must precede PM2 stop'
  assert_not_contains "$events" 'pm2 delete' 'runtime gate must precede PM2 mutation'
  [ "$(<"$ACTIVE_CWD_FILE")" = "$old_dir" ] || \
    fail 'runtime failure must leave the old cwd active'
  rm -rf "$tmp"
  echo 'ok - exact Node 22 arm64 gate fails before PM2 stop'
}

test_disk_module_and_database_failures_precede_pm2_stop() {
  local gate tmp old_dir output status events
  for gate in disk_free disk_pressure module database; do
    tmp="$(mktemp -d)"
    tmp="$(cd "$tmp" && pwd -P)"
    old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
    export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
    export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
    export FAIL_FIRST_CANDIDATE_READY=0 FAKE_MODULE_STATUS=0 FAKE_PREFLIGHT_STATUS=0
    : > "$EVENT_LOG"
    printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
    make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
    install_common_fake_functions

    case "$gate" in
      disk_free)
        df() {
          printf '%s\n' \
            'Filesystem 1024-blocks Used Available Capacity Mounted on' \
            '/dev/fake 100000000 99999999 1 1% /tmp'
        }
        export -f df
        ;;
      disk_pressure)
        df() {
          printf '%s\n' \
            'Filesystem 1024-blocks Used Available Capacity Mounted on' \
            '/dev/fake 100000000 93708544 6291456 96% /tmp'
        }
        export -f df
        ;;
      module) export FAKE_MODULE_STATUS=65 ;;
      database) export FAKE_PREFLIGHT_STATUS=66 ;;
    esac
    install_fake_command_wrappers "$tmp"

    set +e
    output="$(run_fake_deploy "$tmp" 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "$gate gate failure must abort deployment"
    events="$(<"$EVENT_LOG")"
    assert_not_contains "$events" 'pm2 stop' "$gate gate must precede PM2 stop"
    assert_not_contains "$events" 'pm2 delete' "$gate gate must precede PM2 mutation"
    assert_not_contains "$events" 'pm2 start' "$gate gate must precede candidate start"
    [ "$(<"$ACTIVE_CWD_FILE")" = "$old_dir" ] || \
      fail "$gate gate must leave the old exact cwd active"
    case "$gate" in
      disk_free)
        assert_matches "$output" 'at least 5 GiB|free.*storage' \
          'free-space failure must state the capacity gate'
        assert_not_contains "$events" 'npm cwd=' \
          'disk capacity must be proven before npm ci'
        ;;
      disk_pressure)
        assert_matches "$output" 'full data volume|at most 85%' \
          'disk pressure must fail even while more than 5 GiB remains free'
        assert_not_contains "$events" 'npm cwd=' \
          'disk percentage must be proven before npm ci'
        ;;
      module)
        assert_contains "$events" 'npm cwd=' 'module failure must occur after isolated npm ci'
        assert_contains "$events" '--eval' 'module test must reach actual import evaluation'
        ;;
      database)
        assert_contains "$events" 'preflight-local-release.ts' \
          'database test must reach the production readiness preflight'
        ;;
    esac
    rm -rf "$tmp"
    unset FAIL_FIRST_CANDIDATE_READY FAKE_MODULE_STATUS FAKE_PREFLIGHT_STATUS
  done
  echo 'ok - disk, actual-module, and production-DB gates all fail before PM2 stop'
}

test_failed_candidate_readiness_restores_old_exact_cwd() {
  local tmp old_dir output status events start_count last_start
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  export FAIL_FIRST_CANDIDATE_READY=1 FAKE_MODULE_STATUS=0 FAKE_PREFLIGHT_STATUS=0
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e
  unset FAIL_FIRST_CANDIDATE_READY FAKE_MODULE_STATUS FAKE_PREFLIGHT_STATUS

  [ "$status" -ne 0 ] || fail 'candidate without fresh readiness must fail deployment'
  events="$(<"$EVENT_LOG")"
  assert_contains "$events" 'pm2 stop' 'test must reach the guarded PM2 stop'
  start_count="$(grep -c '^pm2 start ' "$EVENT_LOG" || true)"
  [ "$start_count" -ge 2 ] || fail 'candidate and rollback must both perform exact PM2 starts'
  last_start="$(grep '^pm2 start ' "$EVENT_LOG" | tail -1)"
  assert_contains "$last_start" "$old_dir/worker/ecosystem.local-ingest.config.cjs" \
    'rollback must restart from the complete old exact cwd'
  [ "$(<"$ACTIVE_CWD_FILE")" = "$old_dir" ] || \
    fail 'failed candidate must leave the old exact cwd active'
  if ! grep -Eq 'previous.*release restored|rollback.*fresh.*identity' <<<"$output"; then
    printf '%s\n' "$output" >&2
    fail 'rollback success must report fresh old identity evidence'
  fi
  [ ! -e "$tmp/releases/.arena-ingest-deploy-lock-test" ] || \
    fail 'rollback completion must release the local lock'
  rm -rf "$tmp"
  echo 'ok - failed candidate readiness restores and proves the old exact cwd'
}

test_unproven_rollback_preserves_candidate_and_blocks_redeploy() {
  local tmp old_dir output status candidate=''
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  export FAIL_FIRST_CANDIDATE_READY=1 FAIL_ROLLBACK_START=1
  export FAKE_MODULE_STATUS=0 FAKE_PREFLIGHT_STATUS=0
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e
  unset FAIL_FIRST_CANDIDATE_READY FAIL_ROLLBACK_START
  unset FAKE_MODULE_STATUS FAKE_PREFLIGHT_STATUS

  [ "$status" -ne 0 ] || fail 'unproven rollback must keep deployment failed'
  for candidate_dir in "$tmp/releases"/*; do
    [ -d "$candidate_dir" ] && [ ! -L "$candidate_dir" ] || continue
    if [ -f "$candidate_dir/DEPLOYED_SHA" ] && \
      [ "$(<"$candidate_dir/DEPLOYED_SHA")" = "$TEST_SHA" ]; then
      candidate="$candidate_dir"
    fi
  done
  [ -n "$candidate" ] || fail 'unproven rollback must preserve the candidate for forensics'
  assert_contains "$output" 'preserving failed candidate for supervised recovery' \
    'operator must receive explicit candidate-preservation evidence'
  [ -f "$tmp/releases/.arena-ingest-deploy-blocked" ] || \
    fail 'unproven rollback must durably block the next deployment'
  assert_contains "$(<"$tmp/releases/.arena-ingest-deploy-blocked")" "$candidate" \
    'recovery block must identify the exact preserved candidate cwd'
  rm -rf "$tmp"
  echo 'ok - unproven rollback preserves evidence and blocks automatic redeploy'
}

test_fresh_identity_and_retention_contract() {
  local deploy
  deploy="$(<"$DEPLOY_SCRIPT")"
  assert_matches "$deploy" '(READY|DEPLOY)_MARKER=' \
    'each start must write a unique readiness boundary'
  assert_contains "$deploy" 'index($0, marker)' \
    'readiness must ignore all log evidence before the marker'
  assert_contains "$deploy" '[ingest-worker] ready' \
    'readiness must require a fresh worker-ready line'
  assert_matches "$deploy" 'sha=.*expected_sha|sha=.*\$.*SHA|index\(\$0,.*sha' \
    'readiness must bind the exact deployed SHA'
  assert_matches "$deploy" 'release=.*expected_release|release=.*\$.*RELEASE|index\(\$0,.*release' \
    'readiness must bind the deterministic worker release ID'
  assert_not_contains "$deploy" 'pm2 logs $PM2_APP --lines' \
    'a historical fixed PM2 window must never count as readiness'

  assert_matches "$deploy" 'Retain the current and immediate previous|current.*previous|previous.*current' \
    'retention must preserve only the active and immediately previous release'
  assert_contains "$deploy" '.ARENA_LOCAL_RELEASE' \
    'retention may delete only directories carrying the exact generated-release marker'
  assert_matches "$deploy" '\[ ! -L "\$candidate" \]' \
    'retention must refuse symlink release candidates'
  assert_matches "$deploy" 'DEPLOY_SUCCEEDED=1' \
    'retention cleanup must be reachable only after transactional success'
  echo 'ok - fresh identity evidence and current-plus-previous retention are enforced'
}

test_deep_runtime_and_crash_recovery_contracts() {
  local deploy preflight proof ecosystem env_example discover_file='' discover=''
  deploy="$(<"$DEPLOY_SCRIPT")"
  preflight="$(<"$PREFLIGHT_SCRIPT")"
  proof="$(<"$HEARTBEAT_PROOF_SCRIPT")"
  ecosystem="$(<"$LOCAL_ECOSYSTEM")"
  env_example="$(<"$WORKER_ENV_EXAMPLE")"

  assert_contains "$deploy" 'git_command ls-tree -r --name-only "$SHA"' \
    'archive attestation must enumerate the entire exact target tree'
  assert_not_contains "$deploy" ':(glob)' \
    'deploy must not use ls-tree pathspec magic unsupported by the production Git'
  assert_matches "$deploy" 'canonical_directory "\$OLD_CWD"|pwd -P.*OLD_CWD|OLD_CWD.*pwd -P' \
    'rollback cwd must be canonicalized before release-root containment checks'
  assert_matches "$deploy" '\[ -f "\$OLD_EXEC_PATH" \]|canonical.*OLD_EXEC_PATH' \
    'stamped direct-TypeScript rollback entrypoint must be a canonical regular file'
  assert_not_contains "$deploy" 'pm2_env?.env?.WORKER_NODE_ID' \
    'PM2 nested env is not evidence of the dotenv-loaded logical node identity'
  assert_matches "$deploy" 'existing.*(heartbeat|roster).*node|resolve.*worker.*node|discover.*(worker|node)|OLD_NODE_ID.*(heartbeat|roster)' \
    'existing logical node identity must be derived from runtime heartbeat or roster evidence'
  for candidate in "$ROOT"/worker/discover-local-*.ts; do
    if [ -f "$candidate" ]; then discover_file="$candidate"; break; fi
  done
  if [ -z "$discover_file" ] && [[ "$proof" == *'discoverExistingLocalNode'* ]]; then
    discover_file="$HEARTBEAT_PROOF_SCRIPT"
  fi
  [ -n "$discover_file" ] || fail 'old logical node identity needs an independent Redis discovery helper'
  discover="$(<"$discover_file")"
  assert_contains "$deploy" "$(basename "$discover_file")" \
    'deploy must invoke the exact old-node Redis discovery helper'
  assert_contains "$deploy" '--discover-existing' \
    'old-node discovery mode must be explicit and separate from post-start proof'
  for field in pid sha release_id regions ts; do
    assert_contains "$discover" "$field" "old-node discovery must validate $field"
  done
  assert_matches "$discover" 'LEGACY.*KEYS|legacy.*(disk|attempt_bound_capture)' \
    'old-node discovery must accept the exact legacy roster schema without release/capture'
  assert_matches "$discover" 'length[[:space:]]*!==?[[:space:]]*1|length[[:space:]]*===[[:space:]]*1' \
    'old-node discovery must accept exactly one matching fresh roster field'
  assert_matches "$discover" 'ARENA_LOCAL_(NODE|DISCOVERY|EXISTING_ROSTER)|machine.*marker' \
    'old-node discovery must emit one parseable machine marker despite connection logs'
  assert_matches "$deploy" 'ps[[:space:]].*-o[[:space:]]+ppid|descendant.*pid|pid.*descendant' \
    'legacy heartbeat PID must be proven a descendant of the old PM2 wrapper PID'
  assert_contains "$deploy" 'OLD_PROCESS_TREE="$(process_tree_pids "$OLD_PID")"' \
    'cutover must snapshot the complete old process tree before PM2 stop'
  assert_contains "$deploy" 'wait_for_pid_set_exit "$OLD_PROCESS_TREE"' \
    'cutover must prove every old descendant exited, not only the PM2 wrapper'
  assert_contains "$deploy" 'NEW_PROCESS_TREE="$(process_tree_pids "$NEW_PID")"' \
    'rollback must retain the complete candidate process tree for residual checks'
  assert_contains "$deploy" 'wait_for_profile_owners_exit "$OLD_CWD"' \
    'cutover must prove old browser profile owners exited'
  assert_contains "$deploy" 'wait_for_profile_owners_exit "$RELEASE_DIR"' \
    'rollback must prove failed-candidate browser profile owners exited'

  for field in pm_exec_path args node_args exec_mode instances; do
    assert_contains "$deploy" "$field" "PM2 snapshot must include exact $field evidence"
  done
  assert_matches "$deploy" 'expected_exec(_path)?|worker/src/ingest-worker\.ts' \
    'PM2 readiness must compare the direct worker entrypoint path'
  assert_matches "$deploy" 'expected_(node_)?args|tsx/dist/loader\.mjs' \
    'PM2 readiness must compare the release-owned TypeScript loader arguments'
  assert_matches "$deploy" 'fork(_mode)?|exec_mode.*fork' \
    'PM2 readiness must require fork mode'
  assert_matches "$deploy" 'instances.*1|expected_instances' \
    'PM2 readiness must require one process instance'
  assert_matches "$deploy" '\[ "\$restarts" = 0 \]|expected_restarts' \
    'candidate PM2 readiness must require zero restarts at both proofs'

  assert_contains "$ecosystem" "join(workerDir, 'src', 'ingest-worker.ts')" \
    'ecosystem must derive the direct worker entrypoint inside the release'
  assert_contains "$ecosystem" 'script: entrypoint' \
    'PM2 must execute the worker entrypoint directly without a spawning CLI wrapper'
  assert_contains "$ecosystem" "join(releaseDir, 'node_modules', 'tsx', 'dist', 'loader.mjs')" \
    'PM2 must preload the exact release-owned tsx loader'
  assert_contains "$ecosystem" "'--import'" \
    'PM2 must register tsx through Node import hooks in the same process'
  assert_not_contains "$ecosystem" "script: tsxCli" \
    'tsx CLI cannot own PM2 because it spawns a different heartbeat PID'
  assert_matches "$ecosystem" 'max-old-space-size=2560' \
    'direct Node execution must retain the production heap ceiling'

  assert_contains "$preflight" "import('@/lib/ingest/adapters/register')" \
    'pre-stop gate must load all first-party adapter registration side effects'
  assert_not_contains "$preflight" '.sort()' \
    'pre-stop region gate must preserve canonical ownership order'
  assert_contains "$preflight" "['local']" \
    'pre-stop region gate must require exact local-only ownership'
  assert_not_contains "$preflight" 'vps_jp' \
    'Mac must not claim the unconfigured JP lane'
  assert_matches "$preflight" '\.ping\(' \
    'pre-stop gate must prove Redis connectivity'
  assert_contains "$preflight" 'Promise.race' \
    'Redis preflight must have a bounded timeout'
  assert_matches "$preflight" '\.disconnect\(' \
    'Redis preflight must synchronously disconnect on every exit path'

  assert_matches "$proof" '\.hget\(|\.hGet\(' \
    'post-start proof must read the exact Redis roster field'
  assert_contains "$proof" 'WORKER_ROSTER_KEY' \
    'post-start proof must use the canonical worker roster key'
  for field in pid node sha release_id attempt_bound_capture regions ts; do
    assert_contains "$proof" "$field" "post-start roster proof must validate $field"
  done
  assert_matches "$proof" "REQUIRED_REGIONS[[:space:]]*=[[:space:]]*\\['local'\\]" \
    'post-start roster proof must require exact local-only ownership'
  assert_matches "$proof" 'legacy.*LEGACY_LOCAL_REGIONS|LEGACY_LOCAL_REGIONS.*legacy' \
    'JP may appear only in the isolated legacy-discovery compatibility branch'
  assert_matches "$env_example" '^INGEST_REGIONS=local$' \
    'operator template must configure the Mac as local-only'
  assert_matches "$proof" 'notBefore|not_before|cutover' \
    'post-start roster timestamp must be newer than this cutover'
  assert_contains "$deploy" 'verify-local-heartbeat.ts' \
    'deploy must invoke strict post-start Redis roster proof'
  assert_before 'wait_for_stamped_ready "\$DEPLOY_MARKER"' \
    'verify-local-heartbeat\.ts' \
    'log readiness must precede independent Redis roster proof'
  assert_before 'verify-local-heartbeat\.ts' 'DEPLOY_SUCCEEDED=1' \
    'Redis roster proof must precede transactional success'
  assert_matches "$deploy" 'index\(\$0, "node=" node " "\)|exactToken\(\$0, "node=" node\)' \
    'log readiness must delimit the exact logical node identity'
  assert_before 'HEARTBEAT_NOT_BEFORE_MS=' \
    'start_release_config "\$RELEASE_DIR"' \
    'Redis freshness boundary must be captured before candidate start'

  assert_contains "$deploy" 'wait_for_pm2_absent' \
    'an ignored PM2 delete exit must be followed by exact absence proof'
  assert_before 'pm2_command delete "\$PM2_APP"' \
    'wait_for_pm2_absent "\$OLD_PID"' \
    'cutover must prove the deleted old PM2 owner is absent before candidate start'
  assert_matches "$deploy" 'ROLLBACK_SUCCEEDED|rollback.*succeeded' \
    'candidate cleanup must be fenced by proven rollback success'
  assert_contains "$deploy" 'preserving failed candidate for supervised recovery' \
    'unproven rollback must retain candidate evidence'
  assert_matches "$deploy" 'pm2_referenced_cwds|referenced_cwd' \
    'retention must preserve every directory referenced by any PM2 process'
  assert_contains "$deploy" 'SHARED_ENV_SHA256="$(hash_shared_env)"' \
    'the transaction must bind the exact shared worker environment before cutover'
  assert_contains "$deploy" 'shared_env_sha256=${envSha256}' \
    'the durable recovery journal must identify the bound worker environment'

  assert_matches "$deploy" 'INFLIGHT|JOURNAL|transaction.*(journal|block)' \
    'cutover must have a durable SIGKILL/host-loss recovery journal'
  assert_contains "$deploy" 'recovery-record.tmp' \
    'durable cutover journal must stage into a private temporary file'
  assert_contains "$deploy" 'fs.renameSync(path, destination)' \
    'durable cutover journal must publish with one atomic rename'
  assert_contains "$deploy" 'fs.fsyncSync(fd)' \
    'durable cutover journal bytes must be fsynced before publication'
  assert_contains "$deploy" 'fs.openSync(pathModule.dirname(destination), "r")' \
    'durable cutover journal rename must be followed by directory fsync'
  assert_before 'write_cutover_journal' \
    'pm2_command stop' \
    'durable recovery journal must exist before the old PM2 process stops'
  assert_matches "$deploy" 'blocked pending supervised recovery|supervised recovery' \
    'a surviving journal must fail closed on the next deployment'
  echo 'ok - runtime ownership, Redis proof, PM2 shape, and crash recovery are closed'
}

test_success_keeps_only_current_and_previous_immutable_releases() {
  local tmp old_dir stale_one stale_two outside new_dir output status release_count link rel
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  stale_one="$tmp/releases/1111111111111111111111111111111111111111-$(printf '1%.0s' {1..64})"
  stale_two="$tmp/releases/2222222222222222222222222222222222222222-$(printf '2%.0s' {1..64})"
  outside="$tmp/outside-must-survive"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  export FAIL_FIRST_CANDIDATE_READY=0 FAKE_MODULE_STATUS=0 FAKE_PREFLIGHT_STATUS=0
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  cp -a "$old_dir" "$stale_one"
  cp -a "$old_dir" "$stale_two"
  printf '%s\n' '1111111111111111111111111111111111111111' > "$stale_one/DEPLOYED_SHA"
  printf '%s\n' "$(printf '1%.0s' {1..64})" > "$stale_one/WORKER_RELEASE_ID"
  printf '%s\n' 'arena.local-ingest-release@1' > "$stale_one/.ARENA_LOCAL_RELEASE"
  printf '%s\n' '2222222222222222222222222222222222222222' > "$stale_two/DEPLOYED_SHA"
  printf '%s\n' "$(printf '2%.0s' {1..64})" > "$stale_two/WORKER_RELEASE_ID"
  printf '%s\n' 'arena.local-ingest-release@1' > "$stale_two/.ARENA_LOCAL_RELEASE"
  printf '%s\n' SAFE > "$outside"
  ln -s "$outside" "$tmp/releases/outside-link"
  install_common_fake_functions
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e
  unset FAIL_FIRST_CANDIDATE_READY FAKE_MODULE_STATUS FAKE_PREFLIGHT_STATUS

  [ "$status" -eq 0 ] || { printf '%s\n' "$output" >&2; fail 'fully gated fake deploy must succeed'; }
  [ -f "$outside" ] && [ "$(<"$outside")" = SAFE ] || \
    fail 'safe retention must never follow an out-of-root symlink'
  release_count="$(find "$tmp/releases" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  [ "$release_count" -eq 2 ] || \
    fail "retention must leave exactly current and previous directories (got $release_count)"
  [ -d "$old_dir" ] || fail 'successful cutover must retain the immediately previous release'

  new_dir=''
  for rel in "$tmp/releases"/*; do
    [ -d "$rel" ] && [ ! -L "$rel" ] || continue
    if [ -f "$rel/DEPLOYED_SHA" ] && [ "$(<"$rel/DEPLOYED_SHA")" = "$TEST_SHA" ]; then
      new_dir="$rel"
    fi
  done
  [ -n "$new_dir" ] || fail 'current release must retain the exact target stamp'
  [ "$(<"$new_dir/WORKER_RELEASE_ID")" = "$TEST_RELEASE" ] || \
    fail 'current release must retain the deterministic release stamp'
  [ -d "$new_dir/node_modules" ] && [ ! -L "$new_dir/node_modules" ] || \
    fail 'current node_modules must be a release-owned real directory'
  [ -d "$new_dir/.playwright-browsers" ] && [ ! -L "$new_dir/.playwright-browsers" ] || \
    fail 'current browser bytes must be a release-owned real directory'
  [ ! -e "$new_dir/.env.local" ] || fail '.env.local must never enter a worker release'
  while IFS= read -r link; do
    case "${link#"$new_dir"/}" in
      .arena-ingest|worker/logs|worker/.env) ;;
      *) fail "unexpected shared symlink in immutable release: $link" ;;
    esac
  done < <(find "$new_dir" -type l -print)
  [ "$(<"$ACTIVE_CWD_FILE")" = "$new_dir" ] || \
    fail 'successful PM2 owner must use the exact immutable current cwd'
  rm -rf "$tmp"
  echo 'ok - success keeps only immutable current and previous releases safely'
}

bash -n "$DEPLOY_SCRIPT" "$0"
test_exact_target_and_archive_contract
test_non_main_target_fails_before_local_mutation
test_dirty_or_stale_orchestrator_fails_before_local_mutation
test_archive_invocation_has_no_ui_paths
test_release_owned_dependencies_and_secret_scope
test_all_candidate_gates_precede_pm2_stop
test_deploy_lock_and_signal_recovery_contract
test_busy_lock_refuses_before_candidate_or_pm2_stop
test_runtime_mismatch_fails_before_pm2_stop
test_disk_module_and_database_failures_precede_pm2_stop
test_failed_candidate_readiness_restores_old_exact_cwd
test_unproven_rollback_preserves_candidate_and_blocks_redeploy
test_fresh_identity_and_retention_contract
test_deep_runtime_and_crash_recovery_contracts
test_success_keeps_only_current_and_previous_immutable_releases
