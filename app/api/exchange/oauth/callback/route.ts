/**
 * POST /api/exchange/oauth/callback — RETIRED IN V1
 */

import { retiredExchangeOAuthResponse } from '../retired'

export const dynamic = 'force-dynamic'

export async function POST() {
  return retiredExchangeOAuthResponse()
}
