#!/bin/bash
set -eu

# This legacy all-provider rotator is intentionally retired. Secret providers
# have different overlap, activation, and revocation semantics; one generic
# script cannot update every consumer atomically or prove that the old value is
# no longer accepted.
RETIRED_EXIT_CODE=2

printf '%s\n' \
  'ERROR: scripts/security/rotate-secrets.sh is retired and fail-closed.' \
  'No credential was read, generated, logged, or changed.' \
  'Do not use delete-then-add rotation or pass secret values in command arguments.' \
  'Any future credential change is owner-only; see:' \
  'docs/RUNBOOK.md#credential-rotation--v1-no-go--owner-only' >&2

exit "$RETIRED_EXIT_CODE"
