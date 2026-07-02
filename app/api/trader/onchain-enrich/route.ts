/**
 * On-demand on-chain enrichment (Phase A — 即看即算).
 *
 * When a web3 wallet profile (okx_web3_solana / binance_web3_bsc) is opened and
 * has no `onchain_*` data yet, the client POSTs here to compute it NOW instead
 * of waiting for the 12h rotation. Bounded (maxSigs cap + no Dune) so it fits in
 * the serverless window; the cron later produces the complete version. Result is
 * persisted via the SECURITY DEFINER RPC arena_apply_onchain_enrichment, then
 * the client refetches /core to render it.
 *
 * Dedup: skips if the wallet was enriched within DEDUP_MINUTES.
 */
import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { chainForSource, enrichWeb3Wallet, enrichmentExtras } from '@/lib/ingest/onchain/enrich'
import { createLogger } from '@/lib/utils/logger'

export const runtime = 'nodejs'
export const maxDuration = 60

const logger = createLogger('onchain-enrich-api')
const DEDUP_MINUTES = 30

export async function POST(req: Request) {
  let source: string
  let exchangeTraderId: string
  try {
    const body = (await req.json()) as { source?: string; exchangeTraderId?: string }
    source = String(body.source ?? '')
    exchangeTraderId = String(body.exchangeTraderId ?? '')
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const chain = chainForSource(source)
  if (!chain || !exchangeTraderId) {
    return NextResponse.json({ error: 'not_onchain_source' }, { status: 400 })
  }

  const supabase = getSupabaseAdmin()

  // Dedup: recently enriched? read the current onchain_enriched_at.
  try {
    const { data } = await supabase.rpc('arena_core_modules', {
      p_source: source,
      p_trader: exchangeTraderId,
      p_timeframe: 90,
    })
    const extras = (data as { extras?: Record<string, unknown> } | null)?.extras
    const at = extras?.onchain_enriched_at
    if (typeof at === 'string' && Date.now() - Date.parse(at) < DEDUP_MINUTES * 60_000) {
      return NextResponse.json({ status: 'fresh', skipped: true })
    }
  } catch {
    /* dedup is best-effort — proceed to enrich */
  }

  try {
    // Bounded for the serverless window; no Dune on-demand (BSC realized may be
    // partial until the cron completes it).
    const e = await enrichWeb3Wallet(chain, exchangeTraderId, { lookbackDays: 90, maxSigs: 150 })
    const extras = { ...enrichmentExtras(e), onchain_enriched_at: new Date().toISOString() }
    const { data: updated, error } = await supabase.rpc('arena_apply_onchain_enrichment', {
      p_source: source,
      p_exchange_trader_id: exchangeTraderId,
      p_extras: extras,
      p_win_rate: e.winRate ?? undefined,
    })
    if (error) throw error
    return NextResponse.json({
      status: 'enriched',
      rows: updated ?? 0,
      realizedPnl: e.realizedPnlUsd,
      unrealizedPnl: e.unrealizedPnlUsd,
      winRate: e.winRate,
      tokensTraded: e.tokensTraded,
    })
  } catch (err) {
    logger.error('enrich failed', { source, exchangeTraderId, err })
    return NextResponse.json({ error: 'enrich_failed' }, { status: 500 })
  }
}
