/**
 * Phemex Proxy — Edge Function in iad1 (US East) to bypass CloudFront geo-block.
 *
 * CloudFront blocks all Asian datacenter IPs (Vercel hnd1, VPS SG/JP).
 * This Edge Function deploys to iad1 (US East) which may not be blocked.
 *
 * GET /api/proxy/phemex?page=1&pageSize=50&sortBy=roi&period=30d
 * Authorization: Bearer CRON_SECRET
 */

import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('api:phemex-proxy')

export const runtime = 'edge'
export const preferredRegion = ['iad1'] // US East — different from default hnd1

export async function GET(req: NextRequest) {
  const auth = req.headers.get('Authorization')
  if (auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const page = url.searchParams.get('page') || '1'
  const pageSize = url.searchParams.get('pageSize') || '50'
  const sortBy = url.searchParams.get('sortBy') || 'roi'
  const period = url.searchParams.get('period') || '30d'

  try {
    const targetUrl = `https://api.phemex.com/copy-trading/public/traders?page=${page}&pageSize=${pageSize}&sortBy=${sortBy}&sortOrder=desc&period=${period}`

    const resp = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    })

    const text = await resp.text()

    // Pass through the response
    return new NextResponse(text, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
    })
  } catch (e) {
    log.error('Upstream error', { error: (e as Error).message })
    // SECURITY: Do not leak internal error details to client
    return NextResponse.json({ error: 'Upstream service error' }, { status: 502 })
  }
}
