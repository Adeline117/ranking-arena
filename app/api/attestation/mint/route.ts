/**
 * Attestation Minting API
 * POST /api/attestation/mint - Quarantined until score evidence is authoritative
 * GET  /api/attestation/mint?handle=xxx - Check if attestation exists
 *
 * Existing attestations remain readable. New irreversible claims fail closed
 * until a DB-owned history/price/cost-basis proof contract is live and tested.
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
import type { SupabaseClient } from '@supabase/supabase-js'

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    await requireAuth(request)

    // Minting is an irreversible public claim. The current leaderboard rows do
    // not yet carry a verified score-input manifest binding, so no row is safe
    // to attest. Keep the read endpoint available while the DB proof contract
    // and recoverable publish protocol are installed and exercised.
    return NextResponse.json(
      {
        error: 'attestation_minting_unavailable',
        reason: 'trusted_score_evidence_required',
      },
      { status: 503 }
    )
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
    const supabase = getSupabaseAdmin() as SupabaseClient
    const { searchParams } = new URL(request.url)
    const handle = searchParams.get('handle')

    if (!handle) {
      return success({ attestation: null })
    }

    const { data } = await supabase
      .from('trader_attestations')
      .select(
        'id, trader_handle, attestation_uid, tx_hash, arena_score, chain_id, score_period, minted_by, published_at, updated_at'
      )
      .eq('trader_handle', handle)
      .maybeSingle()

    return success({ attestation: data })
  } catch (error: unknown) {
    return handleError(error, 'attestation GET')
  }
}
