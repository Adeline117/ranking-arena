import type { Metadata } from 'next'
import { unstable_cache } from 'next/cache'
import TokensIndexClient from './TokensIndexClient'
import { BASE_URL } from '@/lib/constants/urls'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { isValidTokenSymbol } from '@/lib/utils/token-symbol'

export const revalidate = 3600 // ISR: 1 hour (matches API cache)

// SSR timeout guard: getPopularTokens now reads the pre-aggregated MV via RPC
// (fast), but keep a bound so a cold cache-miss never hangs the page render.
const SSR_TIMEOUT_MS = 4000

export const metadata: Metadata = {
  title: 'Token Rankings — Who Trades BTC Best?',
  description:
    'Discover the best traders for every token. See who profits most trading BTC, ETH, SOL, and other assets across current ranking source boards.',
  alternates: {
    canonical: `${BASE_URL}/rankings/tokens`,
  },
  openGraph: {
    title: 'Token Rankings — Who Trades BTC Best?',
    description:
      'Token-level trader rankings across current public source boards. Find the best BTC, ETH, and SOL traders by PnL.',
    url: `${BASE_URL}/rankings/tokens`,
    siteName: 'Arena',
    type: 'website',
    images: [
      { url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena Token Rankings' },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Token Rankings — Who Trades BTC Best?',
    description: 'Token-level trader rankings. Find the best BTC, ETH, SOL traders.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

export interface PopularToken {
  token: string
  trade_count: number
  trader_count: number
  total_pnl: number
}

export async function loadPopularTokensSSR(): Promise<PopularToken[]> {
  const supabase = getSupabaseAdmin()
  // SQL aggregate via the same RPC as /api/rankings/by-token — replaces the
  // cold-path 50k-row trader_position_history scan into JS (was guarded only
  // by a 4s SSR timeout). The MV now filters junk symbols at source
  // (migration 20260709232817 — mirrors isValidTokenSymbol), so the RPC's
  // top-50 is already clean; the filter below is belt-and-suspenders.
  const { data, error } = await supabase.rpc('get_popular_tokens', {
    lookback_days: 90,
    max_tokens: 50,
  })
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) return []

  return (
    data as Array<{
      token: string
      trade_count: number
      trader_count: number
      total_pnl: number
    }>
  )
    .filter((row) => isValidTokenSymbol(String(row.token ?? '').toUpperCase()))
    .map((row) => ({
      token: row.token,
      trade_count: Number(row.trade_count),
      trader_count: Number(row.trader_count),
      total_pnl: Number(row.total_pnl),
    }))
}

// Bump the cache namespace so empty values written by the former fail-soft
// loader cannot survive this error-contract change for another ISR window.
const getPopularTokens = unstable_cache(loadPopularTokensSSR, ['popular-tokens-ssr-v2'], {
  revalidate: 3600,
  tags: ['rankings', 'popular-tokens'],
})

async function withSsrTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Token rankings SSR timed out')),
          SSR_TIMEOUT_MS
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export default async function TokensPage() {
  let initialTokens: PopularToken[] = []
  let initialStatus: 'success' | 'error' = 'success'
  try {
    initialTokens = await withSsrTimeout(getPopularTokens())
  } catch {
    initialStatus = 'error'
  }

  return <TokensIndexClient initialTokens={initialTokens} initialStatus={initialStatus} />
}
