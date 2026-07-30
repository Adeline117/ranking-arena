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
import {
  READ_ONLY_ACCESS_PLATFORMS,
  validateExchangeReadOnlyAccess,
} from '@/lib/validators/api-key-validator'
import type { Json } from '@/lib/supabase/database.types'

export const dynamic = 'force-dynamic'

// Never persist a credential based on format or exchange name alone. Each
// platform here has an exchange-owned permission endpoint used below.
const ALLOWED_EXCHANGES = new Set<string>(READ_ONLY_ACCESS_PLATFORMS)

type PortfolioSaveAck = {
  status: 'saved'
  userId: string
  portfolioId: string
  exchange: string
  label: string
  credentialGeneration: number
  createdAt: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

function parsePortfolioSaveAck(value: unknown): PortfolioSaveAck | string | null {
  const result = record(value)
  if (!result || typeof result.status !== 'string') return null
  if (result.status !== 'saved') return result.status
  if (
    typeof result.user_id !== 'string' ||
    typeof result.portfolio_id !== 'string' ||
    typeof result.exchange !== 'string' ||
    typeof result.label !== 'string' ||
    !Number.isSafeInteger(result.credential_generation) ||
    Number(result.credential_generation) <= 0 ||
    typeof result.created_at !== 'string'
  ) {
    return null
  }
  return {
    status: 'saved',
    userId: result.user_id,
    portfolioId: result.portfolio_id,
    exchange: result.exchange,
    label: result.label,
    credentialGeneration: Number(result.credential_generation),
    createdAt: result.created_at,
  }
}

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const { data, error } = await supabase
      .from('user_portfolios')
      .select(
        'id, exchange, label, created_at, is_active, current_equity, current_pnl, current_equity_generation'
      )
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
    if (
      typeof exchange !== 'string' ||
      !exchange.trim() ||
      typeof api_key !== 'string' ||
      !api_key.trim() ||
      typeof api_secret !== 'string' ||
      !api_secret.trim()
    ) {
      return NextResponse.json(
        { error: 'Missing required fields: exchange, api_key, api_secret' },
        { status: 400 }
      )
    }
    const normalizedExchange = exchange.trim().toLowerCase()
    if (!ALLOWED_EXCHANGES.has(normalizedExchange)) {
      return NextResponse.json({ error: 'Unsupported exchange' }, { status: 400 })
    }

    const normalizedPassphrase =
      typeof api_passphrase === 'string' && api_passphrase.trim()
        ? api_passphrase.trim()
        : undefined
    const normalizedLabel =
      typeof label === 'string' && label.trim() ? label.trim() : normalizedExchange
    if (normalizedLabel.length > 255) {
      return NextResponse.json({ error: 'Label is too long' }, { status: 400 })
    }
    const validation = await validateExchangeReadOnlyAccess(normalizedExchange, {
      apiKey: api_key,
      apiSecret: api_secret,
      passphrase: normalizedPassphrase,
    })
    if (!validation.isValid) {
      return NextResponse.json(
        {
          error: validation.error || 'Could not verify that this API key is valid and read-only.',
        },
        { status: 400 }
      )
    }

    const supabase = getSupabaseAdmin()
    const permissions = validation.permissions?.length ? validation.permissions : ['read']
    const { data: rawSaved, error } = await supabase.rpc(
      'save_user_portfolio_for_active_profile_atomic',
      {
        p_user_id: user.id,
        p_exchange: normalizedExchange,
        p_api_key_encrypted: encryptApiKey(api_key, user.id),
        p_api_secret_encrypted: encryptApiKey(api_secret, user.id),
        p_api_passphrase_encrypted: normalizedPassphrase
          ? encryptApiKey(normalizedPassphrase, user.id)
          : null,
        p_label: normalizedLabel,
        p_read_only_permissions: permissions as Json,
      }
    )
    if (error) throw error

    const saved = parsePortfolioSaveAck(rawSaved)
    if (saved === 'missing_account' || saved === 'suspended') {
      return NextResponse.json({ error: 'Account is inactive' }, { status: 403 })
    }
    if (saved === 'already_exists') {
      return NextResponse.json(
        { error: 'A portfolio with this exchange and label already exists' },
        { status: 409 }
      )
    }
    if (
      !saved ||
      typeof saved === 'string' ||
      saved.userId !== user.id ||
      saved.exchange !== normalizedExchange ||
      saved.label !== normalizedLabel
    ) {
      throw new Error('Portfolio save authority returned an invalid acknowledgement')
    }

    return success(
      {
        id: saved.portfolioId,
        exchange: saved.exchange,
        label: saved.label,
        created_at: saved.createdAt,
        viewer_id: user.id,
      },
      201
    )
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

    // Keep the ownership predicate on the destructive statement itself. A
    // separate read followed by an id-only delete leaves a check/use race.
    const { data: portfolio, error } = await supabase
      .from('user_portfolios')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id)
      .select('id')
      .maybeSingle()

    if (error) throw error
    if (!portfolio) {
      return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 })
    }

    return success({ deleted: true, portfolio_id: portfolio.id, viewer_id: user.id })
  } catch (err) {
    return handleError(err)
  }
}
