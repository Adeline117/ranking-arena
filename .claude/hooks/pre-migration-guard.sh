#!/bin/bash
# Blocks direct writes to supabase/migrations/ without explicit user confirmation.
# Non-zero exit blocks the tool call.

TOOL_INPUT="${CLAUDE_TOOL_INPUT:-}"

if echo "$TOOL_INPUT" | grep -q "supabase/migrations"; then
  echo "BLOCKED: Direct edits to supabase/migrations/ are not allowed."
  echo "Reason: Schema migrations are irreversible and require explicit user confirmation."
  echo "Action: Ask the user to confirm before creating or editing migration files."
  exit 1
fi

exit 0
