/**
 * Weekly Cross-Exchange ROI Arena (spec §12.6 counter-feature): BitMart runs
 * a weekly single-exchange "ROI Arena" — Arena pools the SAME competition
 * across every tracked source. The arena_weekly_leaders RPC returns the top
 * 7d-ROI traders from each source's latest PASSED weekly snapshot, plus
 * BitMart's official weekly results (sources.meta.weekly_arena_latest) as a
 * reference panel. Money values carry their currency and are NEVER summed
 * across sources (spec §5.8).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getTraderAvatarSrc } from '@/lib/utils/avatar'
import { logRpcError } from './log-rpc-error'
import type { Money, Provenance, ServingCurrency } from './types'

export interface WeeklyLeaderRow {
  source: string
  exchangeSlug: string
  exchangeName: string
  productType: 'spot' | 'futures' | 'cfd' | 'onchain'
  exchangeTraderId: string
  nickname: string | null
  traderKind: 'human' | 'bot'
  avatarSrc: string | null
  /** Rank on the trader's own exchange board (not the pooled rank). */
  sourceRank: number | null
  roi: number
  pnl: Money | null
  winRate: number | null
  provenance: Provenance
}

export interface BitmartWeeklyEntry {
  name: string
  /** ROI percent (BitMart publishes fractions — 0.796 → 79.6). */
  roiPct: number
  leverageLimit: string | null
}

export type BitmartWeeklyCategoryKey = 'open' | 'low_lev' | 'protected'

export interface BitmartWeeklyCategory {
  key: BitmartWeeklyCategoryKey
  entries: BitmartWeeklyEntry[]
  lastUpdate: string | null
}

export interface BitmartWeekly {
  year: number
  week: number
  startDate: string
  endDate: string
  isCurrentWeek: boolean
  categories: BitmartWeeklyCategory[]
  fetchedAt: string | null
}

export interface WeeklyLeaders {
  /** Sources with serving_mode <> 'legacy' — page gates on >= 3. */
  nonLegacyCount: number
  rows: WeeklyLeaderRow[]
  bitmart: BitmartWeekly | null
}

const PRODUCT_TYPES: ReadonlySet<string> = new Set(['spot', 'futures', 'cfd', 'onchain'])
const CURRENCIES: ReadonlySet<string> = new Set(['USDT', 'USDx', 'USDC'])
const CATEGORY_KEYS: readonly BitmartWeeklyCategoryKey[] = ['open', 'low_lev', 'protected']

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function parseBitmart(raw: unknown): BitmartWeekly | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const week = (d.week as Record<string, unknown>) ?? {}
  const year = numOrNull(week.year)
  const weekNo = numOrNull(week.week)
  const startDate = strOrNull(week.start_date)
  const endDate = strOrNull(week.end_date)
  if (year === null || weekNo === null || !startDate || !endDate) return null

  const rawCategories = (d.categories as Record<string, unknown>) ?? {}
  const categories: BitmartWeeklyCategory[] = []
  for (const key of CATEGORY_KEYS) {
    const cat = rawCategories[key]
    if (!cat || typeof cat !== 'object') continue
    const c = cat as Record<string, unknown>
    const entries: BitmartWeeklyEntry[] = []
    for (const item of Array.isArray(c.list) ? c.list : []) {
      if (!item || typeof item !== 'object') continue
      const e = item as Record<string, unknown>
      const name = strOrNull(e.master_name)
      const roi = numOrNull(e.roi)
      if (!name || roi === null) continue
      entries.push({
        name,
        roiPct: Math.round(roi * 100 * 100) / 100,
        leverageLimit: strOrNull(e.leverage_limit),
      })
    }
    if (entries.length > 0) {
      categories.push({ key, entries, lastUpdate: strOrNull(c.last_update_time) })
    }
  }
  if (categories.length === 0) return null

  return {
    year,
    week: weekNo,
    startDate,
    endDate,
    isCurrentWeek: week.is_current_week === true,
    categories,
    fetchedAt: strOrNull(d.fetched_at),
  }
}

export async function getWeeklyLeaders(
  supabase: SupabaseClient,
  limit = 50
): Promise<WeeklyLeaders> {
  const { data, error } = await supabase.rpc('arena_weekly_leaders', { p_limit: limit })
  logRpcError('arena_weekly_leaders', error)
  if (error) {
    throw new Error('Weekly rankings request failed', { cause: error })
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Weekly rankings returned an invalid response')
  }
  const d = data as Record<string, unknown>
  const nonLegacyCount = numOrNull(d.nonLegacyCount)
  if (nonLegacyCount === null || !Array.isArray(d.rows)) {
    throw new Error('Weekly rankings returned an invalid response')
  }

  const rows: WeeklyLeaderRow[] = []
  for (const raw of d.rows) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const roi = numOrNull(r.roi)
    if (typeof r.source !== 'string' || typeof r.exchangeTraderId !== 'string') continue
    if (typeof r.asOf !== 'string' || roi === null) continue

    const currency =
      r.pnl && typeof r.pnl === 'object' && CURRENCIES.has((r.pnl as Money).currency)
        ? ((r.pnl as Money).currency as ServingCurrency)
        : 'USDT'
    const pnlValue =
      r.pnl && typeof r.pnl === 'object'
        ? numOrNull((r.pnl as Record<string, unknown>).value)
        : null
    const avatarMirrorUrl = strOrNull(r.avatarMirrorUrl)
    const avatarOriginUrl = strOrNull(r.avatarOriginUrl)

    rows.push({
      source: r.source,
      exchangeSlug: strOrNull(r.exchangeSlug) ?? r.source,
      exchangeName: strOrNull(r.exchangeName) ?? r.source,
      productType: PRODUCT_TYPES.has(r.productType as string)
        ? (r.productType as WeeklyLeaderRow['productType'])
        : 'futures',
      exchangeTraderId: r.exchangeTraderId,
      nickname: strOrNull(r.nickname),
      traderKind: r.traderKind === 'bot' ? 'bot' : 'human',
      avatarSrc: getTraderAvatarSrc({ avatarMirrorUrl, avatarOriginUrl }),
      sourceRank: numOrNull(r.sourceRank),
      roi,
      pnl: pnlValue === null ? null : { value: pnlValue, currency },
      winRate: numOrNull(r.winRate),
      provenance: { source: r.source, asOf: r.asOf, derived: r.derived === true },
    })
  }

  return {
    nonLegacyCount,
    rows,
    bitmart: parseBitmart(d.bitmartWeekly),
  }
}
