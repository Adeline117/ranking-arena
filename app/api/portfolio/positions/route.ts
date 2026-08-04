/** GET /api/portfolio/positions — retired legacy credential projection in V1. */

import { NextRequest } from 'next/server'
import { retiredPortfolioCapability } from '../retired'

export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest) {
  return retiredPortfolioCapability('positions')
}
