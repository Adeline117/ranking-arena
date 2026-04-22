#!/bin/bash
# Lint: find API routes using ad-hoc error responses
# These should be migrated to use apiError() from lib/api/response.ts
echo "=== Ad-hoc error responses in API routes ==="
echo "(Should use: import { apiError } from '@/lib/api/response')"
echo ""
grep -rn 'NextResponse.json.*error.*status:' app/api/ --include="*.ts" \
  | grep -v node_modules | grep -v __tests__ | grep -v 'apiError' \
  | head -30
echo ""
TOTAL=$(grep -rn 'NextResponse.json.*error.*status:' app/api/ --include="*.ts" \
  | grep -v node_modules | grep -v __tests__ | grep -v 'apiError' | wc -l)
echo "Total: $TOTAL routes need migration"
