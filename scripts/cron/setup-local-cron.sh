#!/bin/bash

# Uninstall/status helper for the retired local refresh job. Installation and
# manual execution are intentionally blocked: local-cron-backup never created
# a backup, and every refresh endpoint it called has been removed.

set -euo pipefail

PLIST_NAME="com.ranking-arena.cron-backup"
PLIST_FILE="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"

retired() {
  echo "RETIRED: local-cron-backup created no backup and its refresh routes no longer exist." >&2
  echo "Use the reviewed ingest scheduler and BACKUP_SCHEMAS=arena,public npm run backup:r2." >&2
  exit 2
}

uninstall() {
  if [ -f "$PLIST_FILE" ]; then
    launchctl unload "$PLIST_FILE" 2>/dev/null || true
    rm -f "$PLIST_FILE"
    echo "Removed retired launchd job: $PLIST_FILE"
  else
    echo "Retired launchd job is not installed: $PLIST_FILE"
  fi
}

status() {
  if [ -f "$PLIST_FILE" ]; then
    echo "RETIRED job is still installed: $PLIST_FILE"
    exit 1
  fi
  echo "Retired launchd job is not installed."
}

case "${1:-install}" in
  uninstall|remove)
    uninstall
    ;;
  status)
    status
    ;;
  install|run|now)
    retired
    ;;
  *)
    echo "Usage: $0 [uninstall|status]" >&2
    exit 2
    ;;
esac
