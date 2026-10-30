#!/usr/bin/env bash
# Retired V1 compatibility tombstone.
#
# This path is retained only so a legacy invocation fails loudly instead of
# invoking a production fetch endpoint.

printf '%s\n' '[RETIRED] vps-cron-htx.sh is disabled during the V1 NO-GO.' >&2
printf '%s\n' 'Source acquisition requires a separately approved provenance-bound release plan.' >&2
exit 2
