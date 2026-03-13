#!/bin/bash
# Apply branded email templates to Supabase Auth
#
# Usage:
#   export SUPABASE_ACCESS_TOKEN="sbp_xxxx"  # from https://supabase.com/dashboard/account/tokens
#   bash scripts/setup-email-templates.sh
#
# Get your access token from: https://supabase.com/dashboard/account/tokens

set -e

PROJECT_REF="iknktzifjdyujdccyhsv"
API_URL="https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth"

if [ -z "$SUPABASE_ACCESS_TOKEN" ]; then
  echo "❌ SUPABASE_ACCESS_TOKEN not set"
  echo "   Get one from: https://supabase.com/dashboard/account/tokens"
  echo "   Then: export SUPABASE_ACCESS_TOKEN='sbp_xxxx'"
  exit 1
fi

echo "📧 Applying email templates to project ${PROJECT_REF}..."

# Read template files
CONFIRM_HTML=$(cat scripts/email-templates/confirm-signup.html)
RESET_HTML=$(cat scripts/email-templates/reset-password.html)
MAGIC_HTML=$(cat scripts/email-templates/magic-link.html)

# Build JSON payload (escape for JSON)
PAYLOAD=$(python3 -c "
import json
confirm = open('scripts/email-templates/confirm-signup.html').read()
reset = open('scripts/email-templates/reset-password.html').read()
magic = open('scripts/email-templates/magic-link.html').read()
print(json.dumps({
    'mailer_subjects_confirmation': 'Confirm your email — Arena',
    'mailer_templates_confirmation_content': confirm,
    'mailer_subjects_recovery': 'Reset your password — Arena',
    'mailer_templates_recovery_content': reset,
    'mailer_subjects_magic_link': 'Sign in to Arena',
    'mailer_templates_magic_link_content': magic,
}))
")

# Apply via Management API
RESPONSE=$(curl -s -w "\n%{http_code}" -X PATCH "$API_URL" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -1)

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ Email templates applied successfully!"
  echo "   - Confirm Signup"
  echo "   - Reset Password"
  echo "   - Magic Link"
else
  echo "❌ Failed with HTTP $HTTP_CODE"
  echo "$BODY"
  exit 1
fi
