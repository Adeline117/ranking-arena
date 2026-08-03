import type { Metadata } from 'next'
import TokensIndexClient from './TokensIndexClient'
import { BASE_URL } from '@/lib/constants/urls'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  getPopularTokenRankingSnapshot,
  type PopularTokenRankingSnapshot,
} from '@/lib/rankings/token-ranking-snapshot'

// The publication head is the cache boundary. Request-time rendering prevents
// an hour-old ISR payload from outliving the atomically published generation.
export const dynamic = 'force-dynamic'
export const revalidate = 0

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

export async function loadPopularTokensSSR(
  signal?: AbortSignal
): Promise<PopularTokenRankingSnapshot> {
  return getPopularTokenRankingSnapshot(
    getSupabaseAdmin(),
    { limit: 50 },
    signal ? { signal } : undefined
  )
}

async function withSsrTimeout<T>(loader: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      loader(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new Error('Token rankings SSR timed out'))
        }, SSR_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export default async function TokensPage() {
  let initialSnapshot: PopularTokenRankingSnapshot | null = null
  let initialStatus: 'success' | 'error' = 'success'
  try {
    initialSnapshot = await withSsrTimeout((signal) => loadPopularTokensSSR(signal))
  } catch {
    initialStatus = 'error'
  }

  return (
    <TokensIndexClient
      key={initialSnapshot?.generation ?? 'unavailable'}
      initialSnapshot={initialSnapshot}
      initialStatus={initialStatus}
    />
  )
}
