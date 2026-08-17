/**
 * Retired anonymous document-proxy ingress.
 *
 * V1 keeps this public compatibility endpoint fail-closed. This source-only
 * boundary does not purge a previously cached response or stop older deployed
 * code from reaching an external host.
 */

import { NextResponse } from 'next/server'
import {
  V1_PUBLIC_EGRESS_NO_STORE_HEADERS,
  V1_PUBLIC_EGRESS_UNAVAILABLE_BODY,
} from '@/lib/security/v1-public-egress-publication'

export const dynamic = 'force-dynamic'

/** Keep this response independent of every request value and outbound operation. */
export function GET(): NextResponse {
  return NextResponse.json(V1_PUBLIC_EGRESS_UNAVAILABLE_BODY, {
    status: 410,
    headers: V1_PUBLIC_EGRESS_NO_STORE_HEADERS,
  })
}
