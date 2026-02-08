import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { publishAttestation, createDataHash } from '@/lib/web3/eas'
import { ARENA_SCORE_SCHEMA_UID } from '@/lib/web3/contracts'
import type { Address } from 'viem'
import { logger } from '@/lib/logger'

const CRON_SECRET = process.env.CRON_SECRET

/**
 * POST /api/cron/publish-attestations
 *
 * Daily cron job that publishes Arena Score attestations for top traders.
 * Only publishes for traders who have a linked wallet address.
 *
 * Protected by CRON_SECRET header.
 */
export async function POST(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Check if EAS is configured
  if (!ARENA_SCORE_SCHEMA_UID || !process.env.ARENA_ATTESTER_PRIVATE_KEY) {
    return NextResponse.json({
      skipped: true,
      reason: 'EAS not configured (missing ARENA_SCORE_SCHEMA_UID or ARENA_ATTESTER_PRIVATE_KEY)',
    })
  }

  const supabase = getSupabaseAdmin()
  const results: { handle: string; uid?: string; error?: string }[] = []

  try {
    // Get top 100 traders with wallet addresses
    // Join traders with user_profiles that have wallet_address
    const { data: traders, error: fetchError } = await supabase
      .from('traders')
      .select(`
        handle,
        exchange,
        arena_score,
        roi,
        pnl,
        updated_at
      `)
      .not('arena_score', 'is', null)
      .order('arena_score', { ascending: false })
      .limit(100)

    if (fetchError || !traders) {
      return NextResponse.json({ error: 'Failed to fetch traders' }, { status: 500 })
    }

    // For each trader, check if they have a wallet address in user_profiles
    // (traders who have claimed their profile and linked a wallet)
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('handle, wallet_address')
      .not('wallet_address', 'is', null)

    const walletMap = new Map<string, string>()
    for (const p of profiles || []) {
      if (p.wallet_address) walletMap.set(p.handle, p.wallet_address)
    }

    // Fetch recent attestations to skip traders already attested in the last 24h
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: recentAttestations } = await supabase
      .from('trader_attestations')
      .select('trader_handle')
      .gte('published_at', oneDayAgo)

    const recentlyAttested = new Set(recentAttestations?.map(a => a.trader_handle) || [])

    const now = Math.floor(Date.now() / 1000)
    let skipped = 0

    for (const trader of traders) {
      // Skip if already attested within the last 24 hours
      if (recentlyAttested.has(trader.handle)) {
        skipped++
        continue
      }
      const walletAddress = walletMap.get(trader.handle)
      // Skip traders without a linked wallet
      if (!walletAddress) {
        skipped++
        continue
      }
      const recipient = walletAddress as Address

      try {
        const dataHash = createDataHash({
          handle: trader.handle,
          score: trader.arena_score ?? 0,
          roi: trader.roi ?? 0,
          pnl: trader.pnl ?? 0,
          timestamp: now,
        })

        const { uid, txHash } = await publishAttestation(recipient, {
          traderHandle: trader.handle,
          arenaScore: trader.arena_score ?? 0,
          exchange: trader.exchange ?? 'unknown',
          snapshotTimestamp: now,
          dataHash,
        })

        // Store attestation reference in DB
        await supabase
          .from('trader_attestations')
          .upsert({
            trader_handle: trader.handle,
            attestation_uid: uid,
            tx_hash: txHash,
            arena_score: trader.arena_score,
            published_at: new Date().toISOString(),
          }, { onConflict: 'trader_handle' })

        results.push({ handle: trader.handle, uid })
      } catch (err) {
        results.push({
          handle: trader.handle,
          error: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }

    const successful = results.filter(r => r.uid).length
    const failed = results.filter(r => r.error).length

    return NextResponse.json({
      total: traders.length,
      skipped,
      published: successful,
      failed,
      results,
    })
  } catch (err) {
    logger.apiError('/api/cron/publish-attestations', err, {})
    return NextResponse.json({ error: 'Cron job failed' }, { status: 500 })
  }
}
