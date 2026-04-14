/**
 * Attestation Minting API
 * POST /api/attestation/mint - Mint on-chain attestation via Arena attester
 * GET  /api/attestation/mint?handle=xxx - Check if attestation exists
 *
 * Uses the server-side Arena attester key to publish EAS attestations on Base.
 * If EAS is not configured, falls back to recording intent in DB.
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ARENA_SCORE_SCHEMA_UID } from '@/lib/web3/contracts'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin() as SupabaseClient

    // Must be a verified trader
    const { data: verifiedTrader } = await supabase
      .from('verified_traders')
      .select('trader_id, source')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!verifiedTrader) {
      return handleError(new Error('Only verified traders can mint attestations'), 'attestation mint')
    }

    // Look up trader handle and score
    const { data: traderSource } = await supabase
      .from('trader_sources')
      .select('handle')
      .eq('source_trader_id', verifiedTrader.trader_id)
      .eq('source', verifiedTrader.source)
      .maybeSingle()

    const traderHandle = traderSource?.handle || verifiedTrader.trader_id

    // Get latest arena score
    const { data: snapshot } = await supabase
      .from('trader_snapshots_v2')
      .select('arena_score, roi, pnl')
      .eq('source_trader_id', verifiedTrader.trader_id)
      .eq('source', verifiedTrader.source)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const arenaScore = snapshot?.arena_score ?? 0

    // Get user's wallet address (for attestation recipient)
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('wallet_address')
      .eq('id', user.id)
      .maybeSingle()

    let attestationUid = `pending_${Date.now()}`
    let txHash = 'pending'

    // Try on-chain attestation if EAS is configured
    if (ARENA_SCORE_SCHEMA_UID && process.env.ARENA_ATTESTER_PRIVATE_KEY) {
      try {
        const { publishAttestation, createDataHash } = await import('@/lib/web3/eas')
        const now = Math.floor(Date.now() / 1000)
        const recipient = (profile?.wallet_address || '0x0000000000000000000000000000000000000000') as `0x${string}`

        const dataHash = createDataHash({
          handle: traderHandle,
          score: arenaScore,
          roi: snapshot?.roi ?? 0,
          pnl: snapshot?.pnl ?? 0,
          timestamp: now,
        })

        const result = await publishAttestation(recipient, {
          traderHandle,
          arenaScore,
          exchange: verifiedTrader.source,
          snapshotTimestamp: now,
          dataHash,
        })

        attestationUid = result.uid
        txHash = result.txHash
        logger.info(`[attestation] Minted on-chain for ${traderHandle}: ${result.uid}`)
      } catch (err) {
        logger.warn(`[attestation] On-chain mint failed for ${traderHandle}, recording intent`, err)
        // Fall through to record intent in DB
      }
    }

    const { data, error } = await supabase
      .from('trader_attestations')
      .upsert({
        trader_handle: traderHandle,
        attestation_uid: attestationUid,
        tx_hash: txHash,
        arena_score: arenaScore,
        chain_id: 8453,
        score_period: 'overall',
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
      message: txHash !== 'pending' ? 'Attestation published on-chain' : 'Attestation recorded (pending on-chain)',
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
    const supabase = getSupabaseAdmin() as SupabaseClient
    const { searchParams } = new URL(request.url)
    const handle = searchParams.get('handle')

    if (!handle) {
      return success({ attestation: null })
    }

    const { data } = await supabase
      .from('trader_attestations')
      .select('id, trader_handle, attestation_uid, tx_hash, arena_score, chain_id, score_period, minted_by, published_at, updated_at')
      .eq('trader_handle', handle)
      .maybeSingle()

    return success({ attestation: data })
  } catch (error: unknown) {
    return handleError(error, 'attestation GET')
  }
}
