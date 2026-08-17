/**
 * Retired avatar acquisition route.
 *
 * V1 keeps this public compatibility endpoint fail-closed. This source-only
 * boundary does not purge a previously cached response or stop direct browser
 * image loads that do not use this route.
 */

import { NextResponse } from 'next/server'
import {
  V1_AVATAR_PROXY_NO_STORE_HEADERS,
  V1_AVATAR_PROXY_UNAVAILABLE_BODY,
} from '@/lib/security/v1-avatar-proxy-publication'

export const dynamic = 'force-dynamic'

/**
 * Keep this response independent of all input and outbound work.
 */
export function GET(): NextResponse {
  return NextResponse.json(V1_AVATAR_PROXY_UNAVAILABLE_BODY, {
    status: 410,
    headers: V1_AVATAR_PROXY_NO_STORE_HEADERS,
  })
}
