#!/bin/bash
# Code Quality Evaluator with pipeline_state reporting + Telegram alerts
#
# Usage: ./scripts/evaluate-and-report.sh
# Called from git pre-push hook.
#
# After running local evaluate.sh, POSTs the score to production
# pipeline-evaluate endpoint which writes to pipeline_state.
# If score < 80, sends Telegram alert.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
THRESHOLD=80

# Run the local evaluator and capture score
OUTPUT=$("$SCRIPT_DIR/evaluate.sh" 2>&1)
EXIT_CODE=$?
echo "$OUTPUT"

# Extract score from output
SCORE=$(echo "$OUTPUT" | grep "Score:" | grep -o '[0-9]*/' | tr -d '/')

if [ -z "$SCORE" ]; then
  echo "Could not extract score from evaluate output."
  exit $EXIT_CODE
fi

# Write score to pipeline_state via production API (non-blocking)
CRON_SECRET="${CRON_SECRET:-arena-cron-secret-2025}"
SITE_URL="${NEXT_PUBLIC_SITE_URL:-https://www.arenafi.org}"

# Fire-and-forget: POST score to a lightweight endpoint
# This triggers pipeline_state write + Telegram alert if < 80
(
  curl -s --max-time 10 \
    -H "Authorization: Bearer $CRON_SECRET" \
    "${SITE_URL}/api/health/evaluate-report?score=${SCORE}&source=pre-push" \
    > /dev/null 2>&1 &
) 2>/dev/null

exit $EXIT_CODE
