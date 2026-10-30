/**
 * Retired anonymous market-sparklines acquisition ingress.
 *
 * V1 keeps this public compatibility endpoint fail-closed. This source-only
 * boundary does not alter code already deployed, prior data, or external markets.
 */

import { NextResponse } from 'next/server'
import {
  V1_PUBLIC_EGRESS_NO_STORE_HEADERS,
  V1_PUBLIC_EGRESS_UNAVAILABLE_BODY,
} from '@/lib/security/v1-public-egress-publication'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

/** Keep this response independent of caller-controlled values and outbound operations. */
export function GET(): NextResponse {
  return NextResponse.json(V1_PUBLIC_EGRESS_UNAVAILABLE_BODY, {
    status: 410,
    headers: V1_PUBLIC_EGRESS_NO_STORE_HEADERS,
  })
}
