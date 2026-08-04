#!/usr/bin/env bash

# The irreversible 055000 proof deliberately requires an explicit opt-in mode;
# the ordinary 054000 proof never executes the cutover migration.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COPIER_SNAPSHOT_PROOF_MODE=cutover \
  exec bash "$SCRIPT_DIR/copier-snapshot-publication-authority.pg17.sh"
