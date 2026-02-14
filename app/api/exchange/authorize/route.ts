/**
 * Generate exchange authorization URL
 * GET /api/exchange/authorize?exchange=binance
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'
import logger from '@/lib/logger'

const EXCHANGE_AUTH_URLS: Record<string, string> = {
  binance: 'https://www.binance.com/en/my/settings/api-management',
  bybit: 'https://www.bybit.com/app/user/api-management',
  bitget: 'https://www.bitget.com/zh-CN/user/api',
  mexc: 'https://www.mexc.com/user/api',
  coinex: 'https://www.coinex.com/api',
}

export async function GET(req: NextRequest) {
  try {
    const user = await getAuthUser(req)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const searchParams = req.nextUrl.searchParams
    const exchange = searchParams.get('exchange')
    const userId = user.id

    if (!exchange) {
      return NextResponse.json(
        { error: 'Missing parameter: exchange' },
        { status: 400 }
      )
    }

    const authUrl = EXCHANGE_AUTH_URLS[exchange.toLowerCase()]

    if (!authUrl) {
      return NextResponse.json(
        { error: `Unsupported exchange: ${exchange}` },
        { status: 400 }
      )
    }

    const state = Buffer.from(JSON.stringify({
      exchange,
      userId,
      timestamp: Date.now(),
    })).toString('base64')

    const redirectUrl = new URL('/exchange/authorize/callback', req.nextUrl.origin)
    redirectUrl.searchParams.set('state', state)
    redirectUrl.searchParams.set('exchange', exchange)

    return NextResponse.json({
      authUrl,
      redirectUrl: redirectUrl.toString(),
      exchange,
      instructions: getInstructions(exchange),
    })
  } catch (error: unknown) {
    logger.error('[exchange/authorize] error:', error)
    const message = error instanceof Error ? error.message : 'Failed to generate authorization URL'
    return NextResponse.json(
      { error: message },
      { status: 500 }
    )
  }
}

function getInstructions(exchange: string): string[] {
  const instructions: Record<string, string[]> = {
    binance: [
      '1. Log in to your Binance account on the new page',
      '2. Go to API Management and click "Create API"',
      '3. Select "System generated API key"',
      '4. Set an API label (e.g., Arena)',
      '5. Complete security verification',
      '6. After creation, copy the API Key and Secret',
      '7. Return to this page and paste the API Key and Secret',
      '8. Click "Confirm Connection" to complete',
    ],
    bybit: [
      '1. Log in to your Bybit account on the new page',
      '2. Go to API Management and create a new API Key',
      '3. Set API permissions (read-only)',
      '4. Complete security verification',
      '5. Copy the API Key and Secret',
      '6. Return to this page and paste the API Key and Secret',
      '7. Click "Confirm Connection" to complete',
    ],
    bitget: [
      '1. Log in to your Bitget account on the new page',
      '2. Go to API Management and create a new API Key',
      '3. Set API permissions (read-only)',
      '4. Complete security verification',
      '5. Copy the API Key and Secret',
      '6. Return to this page and paste the API Key and Secret',
      '7. Click "Confirm Connection" to complete',
    ],
    mexc: [
      '1. Log in to your MEXC account on the new page',
      '2. Go to API Management and create a new API Key',
      '3. Set API permissions (read-only)',
      '4. Complete security verification',
      '5. Copy the API Key and Secret',
      '6. Return to this page and paste the API Key and Secret',
      '7. Click "Confirm Connection" to complete',
    ],
    coinex: [
      '1. Log in to your CoinEx account on the new page',
      '2. Go to API Management and create a new API Key',
      '3. Set API permissions (read-only)',
      '4. Complete security verification',
      '5. Copy the API Key and Secret',
      '6. Return to this page and paste the API Key and Secret',
      '7. Click "Confirm Connection" to complete',
    ],
  }

  return instructions[exchange.toLowerCase()] || [
    '1. Log in to your exchange account',
    '2. Create an API Key',
    '3. Copy the API Key and Secret',
    '4. Return to this page to complete the connection',
  ]
}
