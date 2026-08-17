/**
 * Retired direct internal-notification-delivery ingress.
 *
 * Preserve the established service credential contract before revealing the
 * V1 hold: CRON_SECRET as a Bearer token or INTERNAL_API_KEY in
 * `x-internal-key`. After authentication, this source path must not read a
 * notification payload, rate-limit, initialize Supabase/logging, or insert a
 * notification row. It does not gate in-process notification helpers used by
 * normal user, Stripe, or group flows.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { verifyServiceAuth } from '@/lib/auth/verify-service-auth'
import {
  V1_INTERNAL_NOTIFICATION_DELIVERY_NO_STORE_HEADERS,
  V1_INTERNAL_NOTIFICATION_DELIVERY_UNAVAILABLE_BODY,
} from '@/lib/notifications/v1-internal-delivery-publication'

export const dynamic = 'force-dynamic'

export function POST(request: NextRequest): NextResponse {
  if (!verifyServiceAuth(request)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: V1_INTERNAL_NOTIFICATION_DELIVERY_NO_STORE_HEADERS }
    )
  }

  return NextResponse.json(V1_INTERNAL_NOTIFICATION_DELIVERY_UNAVAILABLE_BODY, {
    status: 410,
    headers: V1_INTERNAL_NOTIFICATION_DELIVERY_NO_STORE_HEADERS,
  })
}
