/**
 * Attestation Minting API
 * POST /api/attestation/mint - Record an on-chain attestation
 *
 * The actual minting happens client-side via ethers/viem.
 * This endpoint records the attestation in our database.
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateString,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    // Must be a verified trader
    const { data: verifiedTrader } = await supabase
      .from('verified_traders')
      .select('trader_id, source')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!verifiedTrader) {
      return handleError(new Error('Only verified traders can mint attestations'), 'attestation mint')
    }

    const body = await request.json()
    const attestation_uid = validateString(body.attestation_uid, { required: true, fieldName: 'attestation_uid' })
    const tx_hash = validateString(body.tx_hash, { required: true, fieldName: 'tx_hash' })
    const arena_score = typeof body.arena_score === 'number' ? Math.round(body.arena_score) : null
    const chain_id = typeof body.chain_id === 'number' ? body.chain_id : 8453

    if (!attestation_uid || !tx_hash) {
      return handleError(new Error('attestation_uid and tx_hash are required'), 'attestation mint')
    }

    // Look up trader handle
    const { data: traderSource } = await supabase
      .from('trader_sources')
      .select('handle')
      .eq('source_trader_id', verifiedTrader.trader_id)
      .eq('source', verifiedTrader.source)
      .maybeSingle()

    const traderHandle = traderSource?.handle || verifiedTrader.trader_id

    const { data, error } = await supabase
      .from('trader_attestations')
      .upsert({
        trader_handle: traderHandle,
        attestation_uid,
        tx_hash,
        arena_score,
        chain_id,
        score_period: body.score_period || 'overall',
        minted_by: user.id,
        published_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'trader_handle' })
      .select()
      .single()

    if (error) {
      return handleError(error, 'attestation mint')
    }

    return success({
      attestation: data,
      message: 'Attestation recorded',
    })
  } catch (error: unknown) {
    return handleError(error, 'attestation mint')
  }
}

/**
 * GET /api/attestation/mint?handle=xxx - Check if attestation exists
 */
export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)
    const handle = searchParams.get('handle')

    if (!handle) {
      return success({ attestation: null })
    }

    const { data } = await supabase
      .from('trader_attestations')
      .select('*')
      .eq('trader_handle', handle)
      .maybeSingle()

    return success({ attestation: data })
  } catch (error: unknown) {
    return handleError(error, 'attestation GET')
  }
}
