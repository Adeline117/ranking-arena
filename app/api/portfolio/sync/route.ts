/**
 * POST /api/portfolio/sync
 *
 * The legacy portfolio credential plane did not have exchange-authoritative
 * read-only verification or a server-only lifecycle boundary. V1 therefore
 * retires this route before parsing a body, reading credentials, or making an
 * outbound exchange request.
 */

import { NextRequest } from 'next/server'
import { retiredPortfolioWrite } from '../retired'

export const dynamic = 'force-dynamic'

export async function POST(_request: NextRequest) {
  return retiredPortfolioWrite('sync')
}
