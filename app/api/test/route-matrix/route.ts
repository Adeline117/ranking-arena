/**
 * Route Matrix Test API — tests exchange API reachability from Vercel hnd1.
 *
 * GET /api/test/route-matrix?platforms=all
 * Authorization: Bearer CRON_SECRET
 *
 * This runs FROM Vercel, so "direct" means actual Vercel hnd1 datacenter IP.
 * Use scripts/test-route-matrix.ts for local testing.
 */

import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { PLATFORM_ROUTES } from '@/lib/connectors/route-config'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function GET(req: Request) {
  const auth = req.headers.get('Authorization')
  if (auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json({
    message: 'Use scripts/test-route-matrix.ts for full testing. This endpoint returns current route config.',
    route_config: PLATFORM_ROUTES,
    env: {
      vps_sg: process.env.VPS_PROXY_SG ? 'configured' : 'missing',
      vps_jp: process.env.VPS_PROXY_JP ? 'configured' : 'missing',
      mac_mini: process.env.MAC_MINI_URL ? 'configured' : 'missing',
    },
  })
}
