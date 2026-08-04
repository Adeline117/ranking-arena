/**
 * GET /api/exchange/oauth/authorize — RETIRED IN V1
 */

import { retiredExchangeOAuthResponse } from '../retired'

export const dynamic = 'force-dynamic'

export async function GET() {
  return retiredExchangeOAuthResponse()
}
