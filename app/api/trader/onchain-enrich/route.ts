/**
 * On-demand on-chain enrichment (Phase A — 即看即算).
 *
 * When a web3 wallet profile (okx_web3_solana / binance_web3_bsc) is opened and
 * has no `onchain_*` data yet, the client POSTs here to compute it NOW instead
 * of waiting for the 12h rotation. Chain-specific signature/page budgets keep
 * it inside the serverless window; the cron later refreshes more deeply. Result
 * is persisted via the SECURITY DEFINER RPC arena_apply_onchain_enrichment,
 * then the client refetches /core to render it.
 *
 * Dedup: skips if the wallet was enriched within DEDUP_MINUTES.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  chainForSource,
  enrichWeb3Wallet,
  enrichmentExtras,
  onchainFetchBudget,
  scoreEligibleWinRate,
} from '@/lib/ingest/onchain/enrich'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'
import { hasCurrentStoredOnchainQualitySchema } from '@/lib/onchain-quality'

export const runtime = 'nodejs'
export const maxDuration = 60

const logger = createLogger('onchain-enrich-api')
const DEDUP_MINUTES = 30

export async function POST(req: NextRequest) {
  // 公开端点但每次调用消耗付费链上 API 配额（Alchemy/Etherscan）——
  // sensitive 限流(15/min, fail-close)防换钱包地址刷接口的成本放大攻击
  const rateLimitResponse = await checkRateLimit(req, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

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
    if (
      extras &&
      hasCurrentStoredOnchainQualitySchema(extras) &&
      typeof at === 'string' &&
      Date.now() - Date.parse(at) < DEDUP_MINUTES * 60_000
    ) {
      return NextResponse.json({ status: 'fresh', skipped: true })
    }
  } catch {
    /* dedup is best-effort — proceed to enrich */
  }

  try {
    // Bounded for the serverless window; no Dune on-demand (BSC realized may be
    // partial until the cron completes it).
    const e = await enrichWeb3Wallet(chain, exchangeTraderId, {
      lookbackDays: 90,
      ...onchainFetchBudget(chain, 'interactive'),
    })
    const extras = { ...enrichmentExtras(e), onchain_enriched_at: new Date().toISOString() }
    const { data: updated, error } = await supabase.rpc('arena_apply_onchain_enrichment', {
      p_source: source,
      p_exchange_trader_id: exchangeTraderId,
      p_extras: extras,
      // The current bounded accounting is useful profile evidence but is not
      // score-grade until opening inventory + execution-time prices are replayed.
      p_win_rate: scoreEligibleWinRate(e) ?? undefined,
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
