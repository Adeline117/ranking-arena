#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_SCRIPT="$SCRIPT_DIR/deploy.sh"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SG_CONFIG="$ROOT_DIR/infra/vps-playwright/ecosystem.config.js"
JP_CONFIG="$ROOT_DIR/infra/vps-playwright/ecosystem-jp.config.js"

if [[ ! -x "$DEPLOY_SCRIPT" ]]; then
  echo "retired compatibility path must remain executable" >&2
  exit 1
fi

expected_script=$'#!/bin/bash\necho "[RETIRED] V1 NO-GO" >&2\nexit 2'
actual_script="$(<"$DEPLOY_SCRIPT")"
if [[ "$actual_script" != "$expected_script" ]]; then
  echo "retired compatibility path must contain only the fixed V1 NO-GO contract" >&2
  exit 1
fi

for forbidden_token in ssh scp pm2 curl wget rsync http https env host deploy; do
  if grep -Fqi "$forbidden_token" "$DEPLOY_SCRIPT"; then
    echo "retired compatibility path contains forbidden runtime token: $forbidden_token" >&2
    exit 1
  fi
done

if grep -Eq '([[:digit:]]{1,3}\.){3}[[:digit:]]{1,3}' "$DEPLOY_SCRIPT"; then
  echo "retired compatibility path contains an IP address" >&2
  exit 1
fi

assert_config_names() {
  local config_path="$1"
  local expected_names="$2"
  local actual_names

  actual_names="$(sed -nE "s/^[[:space:]]*name:[[:space:]]*'([^']+)',[[:space:]]*$/\1/p" "$config_path")"
  if [[ "$actual_names" != "$expected_names" ]]; then
    echo "unexpected local PM2 topology in $config_path" >&2
    exit 1
  fi
}

assert_config_names "$SG_CONFIG" $'arena-scraper\narena-proxy'
assert_config_names "$JP_CONFIG" 'arena-proxy'

if grep -Eq '^[[:space:]]*cron_restart[[:space:]]*:' "$SG_CONFIG" "$JP_CONFIG"; then
  echo "V1 NO-GO ecosystem configs must not schedule autonomous process restarts" >&2
  exit 1
fi

echo "VPS deploy source containment safety passed"
