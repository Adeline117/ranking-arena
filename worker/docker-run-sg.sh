#!/usr/bin/env bash
# Intentionally disabled production entrypoint.
#
# SG has one authorized deployment channel: the exact-main, token-fenced,
# transactional PM2 path in worker/deploy-ingest-sg.sh, normally invoked by
# .github/workflows/deploy-ingest-sg.yml. Keeping a second Docker cutover path
# allowed PM2, docker-run, and Compose to race as hidden duplicate consumers
# under the same Redis node identity, and the old Docker path had no reliable
# automatic rollback.
#
# The image workflow only builds, smoke-tests, and pushes an OCI image; it
# deploys nothing. Re-enable container deployment only together with a host-level
# owner lease, digest-bound rollout transaction, and tested automatic rollback.

set -euo pipefail

echo "[docker-run-sg] disabled: use the exact-main transactional SG deploy workflow" >&2
exit 2
