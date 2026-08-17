/**
 * Retired direct rankings-export ingress.
 *
 * Preserve the established Edge cron credential before disclosing the V1
 * publication hold. This source-only boundary does not stop a deployed route
 * or repository-external automation that may hold the service credential.
 */

import { NextResponse } from 'next/server'
import { verifyEdgeCronSecret } from '@/lib/auth/edge-cron-auth'
import {
  V1_RANKINGS_EXPORT_NO_STORE_HEADERS,
  V1_RANKINGS_EXPORT_UNAVAILABLE_BODY,
} from '@/lib/rankings/v1-rankings-export-publication'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  if (!(await verifyEdgeCronSecret(request))) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: V1_RANKINGS_EXPORT_NO_STORE_HEADERS }
    )
  }

  return NextResponse.json(V1_RANKINGS_EXPORT_UNAVAILABLE_BODY, {
    status: 410,
    headers: V1_RANKINGS_EXPORT_NO_STORE_HEADERS,
  })
}
