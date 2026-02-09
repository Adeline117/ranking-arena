/**
 * @deprecated This webhook endpoint has been consolidated into /api/stripe/webhook
 * All tip and subscription handling is now in the unified webhook handler.
 * Update your Stripe Dashboard webhook URL to: /api/stripe/webhook
 *
 * This file proxies requests to the new endpoint for backwards compatibility.
 */

import { NextRequest, NextResponse } from 'next/server'
import logger from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  // Forward to the consolidated webhook handler
  const baseUrl = request.nextUrl.origin
  const body = await request.text()

  try {
    const response = await fetch(`${baseUrl}/api/stripe/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'stripe-signature': request.headers.get('stripe-signature') || '',
      },
      body,
    })

    const result = await response.json()
    return NextResponse.json(result, { status: response.status })
  } catch (error: unknown) {
    logger.error('[webhook/stripe] Proxy to /api/stripe/webhook failed:', error)
    return NextResponse.json(
      { error: 'Webhook proxy failed' },
      { status: 500 }
    )
  }
}
