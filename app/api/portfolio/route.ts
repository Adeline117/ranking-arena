/**
 * Portfolio CRUD API
 * GET /api/portfolio - List user portfolios
 * POST /api/portfolio - Add exchange connection
 * DELETE /api/portfolio?id=xxx - Remove exchange connection
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { encryptApiKey } from '@/lib/exchange/secure-encryption'

export const dynamic = 'force-dynamic'

// Exchanges the connect UI offers (mirror of AddExchangeModal's list). Stored
// values are validated against this so only known exchange ids get persisted.
const ALLOWED_EXCHANGES = new Set([
  'binance',
  'bybit',
  'okx',
  'bitget',
  'mexc',
  'kucoin',
  'gateio',
  'htx',
  'phemex',
  'dydx',
  'hyperliquid',
  'blofin',
  'coinex',
  'bitmart',
])

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const { data, error } = await supabase
      .from('user_portfolios')
      .select('id, exchange, label, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (error) throw error

    return success(data || [])
  } catch (err) {
    return handleError(err)
  }
}

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const body = await request.json()

    const { exchange, api_key, api_secret, api_passphrase, label } = body
    if (!exchange || !api_key || !api_secret) {
      return NextResponse.json(
        { error: 'Missing required fields: exchange, api_key, api_secret' },
        { status: 400 }
      )
    }
    // Validate exchange against the allowlist at storage time (defense-in-depth;
    // sync also allowlists). Prevents persisting arbitrary/garbage exchange ids.
    if (typeof exchange !== 'string' || !ALLOWED_EXCHANGES.has(exchange.toLowerCase())) {
      return NextResponse.json({ error: 'Unsupported exchange' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    const { data, error } = await supabase
      .from('user_portfolios')
      .insert({
        user_id: user.id,
        exchange: exchange.toLowerCase(),
        api_key_encrypted: encryptApiKey(api_key, user.id),
        api_secret_encrypted: encryptApiKey(api_secret, user.id),
        api_passphrase_encrypted:
          typeof api_passphrase === 'string' && api_passphrase.trim()
            ? encryptApiKey(api_passphrase.trim(), user.id)
            : null,
        label: label || exchange,
      })
      .select('id, exchange, label, created_at')
      .single()

    if (error) throw error

    return success(data, 201)
  } catch (err) {
    return handleError(err)
  }
}

export async function DELETE(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return NextResponse.json({ error: 'Missing portfolio id' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    // Verify ownership
    const { data: portfolio } = await supabase
      .from('user_portfolios')
      .select('id')
      .eq('id', id)
      .eq('user_id', user.id)
      .single()

    if (!portfolio) {
      return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 })
    }

    const { error } = await supabase.from('user_portfolios').delete().eq('id', id)

    if (error) throw error

    return success({ deleted: true })
  } catch (err) {
    return handleError(err)
  }
}
