#!/usr/bin/env bash
# Retired V1 compatibility tombstone.
#
# This path is retained only so a legacy invocation fails loudly instead of
# changing host credentials or process state.

printf '%s\n' '[RETIRED] sync-vps-key.sh is disabled during the V1 NO-GO.' >&2
printf '%s\n' 'Use the owner-approved incident and release process for any proposed remediation.' >&2
exit 2
