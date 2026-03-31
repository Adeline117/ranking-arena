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

export const runtime = 'edge'
export const preferredRegion = ['iad1'] // US East — different from default hnd1

export async function GET(req: NextRequest) {
  // SECURITY: Reject if CRON_SECRET not configured in production
  if (!env.CRON_SECRET && process.env.NODE_ENV === 'production') {
    console.error('[phemex-proxy] CRON_SECRET not configured')
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 503 })
  }

  const auth = req.headers.get('Authorization')
  if (!env.CRON_SECRET || auth !== `Bearer ${env.CRON_SECRET}`) {
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
    console.error('[phemex-proxy] Error:', (e as Error).message)
    // SECURITY: Do not leak internal error details to client
    return NextResponse.json({ error: 'Upstream service error' }, { status: 502 })
  }
}
