#!/bin/bash
set -euo pipefail

# Only run in remote Claude Code environment
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Change to project directory
cd "$CLAUDE_PROJECT_DIR"

# Skip Puppeteer Chrome download (not needed for linting/testing)
export PUPPETEER_SKIP_DOWNLOAD=true

# Install npm dependencies
echo "Installing npm dependencies..."
npm install

echo "Session start hook completed successfully!"
