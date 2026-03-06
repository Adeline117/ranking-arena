#!/bin/bash
# Weekly self-check runner for OpenClaw
# Schedule: Every Friday at 10:00 AM
#
# This script launches a Claude Code session to run the weekly self-check.
# It should be configured as an OpenClaw scheduled task.

ARENA_DIR="${ARENA_DIR:-/Users/adelinewen/ranking-arena}"

cd "$ARENA_DIR" || exit 1

# Pull latest changes
git checkout main && git pull

# Run the weekly self-check via Claude Code
# OpenClaw will invoke this; if running standalone, ensure claude is in PATH
claude --print "/weekly-self-check"
