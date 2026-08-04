import type { Metadata } from 'next'
import TokensIndexClient from './TokensIndexClient'
import { BASE_URL } from '@/lib/constants/urls'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  getPopularTokenRankingSnapshot,
  TokenRankingReadError,
  type PopularTokenRankingSnapshot,
} from '@/lib/rankings/token-ranking-snapshot'

// The publication head is the cache boundary. Request-time rendering prevents
// an hour-old ISR payload from outliving the atomically published generation.
export const dynamic = 'force-dynamic'
export const revalidate = 0

// Keep a bound so a cold publication-head/cache read never hangs the page render.
const SSR_TIMEOUT_MS = 4000

export const metadata: Metadata = {
  title: 'Token Ranking Verification',
  description:
    'Token-level trader rankings publish only from verified authority snapshots. Partial history, untrusted prices, unknown cost basis, and incomplete FX evidence are excluded.',
  alternates: {
    canonical: `${BASE_URL}/rankings/tokens`,
  },
  robots: {
    index: false,
    follow: true,
  },
  openGraph: {
    title: 'Token Ranking Verification | Arena',
    description:
      'Token-level rankings publish only after history, price, cost-basis, and FX evidence pass verification.',
    url: `${BASE_URL}/rankings/tokens`,
    siteName: 'Arena',
    type: 'website',
    images: [
      { url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena Token Rankings' },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Token Ranking Verification | Arena',
    description: 'Token-level rankings backed by verified authority snapshots.',
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
  let initialStatus: 'success' | 'unpublished' | 'error' = 'success'
  try {
    initialSnapshot = await withSsrTimeout((signal) => loadPopularTokensSSR(signal))
  } catch (error) {
    initialStatus =
      error instanceof TokenRankingReadError && error.kind === 'not_published'
        ? 'unpublished'
        : 'error'
  }

  return (
    <TokensIndexClient
      key={initialSnapshot?.generation ?? 'unavailable'}
      initialSnapshot={initialSnapshot}
      initialStatus={initialStatus}
    />
  )
}
