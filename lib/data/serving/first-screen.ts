/**
 * Tier-A first screen (spec §2.4-1): one RPC call returns everything the
 * profile page needs to render with ZERO on-demand fetching — identity +
 * the latest passing leaderboard entry per timeframe, including the board
 * extras the exchange itself displayed (win rate, MDD, copiers, sparkline).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { money } from '@/lib/utils/money'
import { getTraderAvatarSrc } from '@/lib/utils/avatar'
import { projectBoardExtras } from './board-extras'
import type { ServingCurrency, TraderFirstScreen } from './types'

const CURRENCIES: ReadonlySet<string> = new Set(['USDT', 'USDx', 'USDC', 'USD'])

function asCurrency(v: unknown, fallback: ServingCurrency = 'USDT'): ServingCurrency {
  return typeof v === 'string' && CURRENCIES.has(v) ? (v as ServingCurrency) : fallback
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

interface RpcEntry {
  timeframe: number
  rank: number
  headlineRoi: number | string | null
  headlinePnl: number | string | null
  headlineWinRate: number | string | null
  currency: string | null
  extras: Record<string, unknown> | null
  asOf: string
}

export async function getFirstScreen(
  supabase: SupabaseClient,
  source: string,
  exchangeTraderId: string
): Promise<TraderFirstScreen | null> {
  const { data, error } = await supabase.rpc('arena_first_screen', {
    p_source: source,
    p_trader: exchangeTraderId,
  })
  if (error || !data) return null
  const d = data as Record<string, unknown>
  if (typeof d.source !== 'string' || typeof d.exchangeTraderId !== 'string') return null

  const sourceCurrency = asCurrency(d.currency)
  const rawEntries = Array.isArray(d.entries) ? (d.entries as RpcEntry[]) : []
  const avatarMirrorUrl = typeof d.avatarMirrorUrl === 'string' ? d.avatarMirrorUrl : null
  const avatarOriginUrl = typeof d.avatarOriginUrl === 'string' ? d.avatarOriginUrl : null

  return {
    source: d.source,
    exchangeTraderId: d.exchangeTraderId,
    nickname: typeof d.nickname === 'string' ? d.nickname : null,
    avatarMirrorUrl,
    avatarOriginUrl,
    avatarSrc: getTraderAvatarSrc({ avatarMirrorUrl, avatarOriginUrl }),
    walletAddress: typeof d.walletAddress === 'string' ? d.walletAddress : null,
    traderKind: d.traderKind === 'bot' ? 'bot' : 'human',
    botStrategy:
      d.botStrategy === 'martingale' || d.botStrategy === 'grid' || d.botStrategy === 'ai'
        ? d.botStrategy
        : null,
    entries: rawEntries
      .filter((e) => e.timeframe === 7 || e.timeframe === 30 || e.timeframe === 90)
      .map((e) => {
        const pnl = numOrNull(e.headlinePnl)
        return {
          timeframe: e.timeframe as 7 | 30 | 90,
          rank: e.rank,
          headlineRoi: numOrNull(e.headlineRoi),
          headlinePnl: pnl === null ? null : money(pnl, asCurrency(e.currency, sourceCurrency)),
          headlineWinRate: numOrNull(e.headlineWinRate),
          extras: projectBoardExtras(d.source as string, e.extras),
          provenance: { source: d.source as string, asOf: e.asOf },
        }
      }),
  }
}
