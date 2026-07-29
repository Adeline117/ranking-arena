import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { unstable_cache } from 'next/cache'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import TokenRankingClient, { type Period, type TokenTrader } from './TokenRankingClient'
import { BASE_URL } from '@/lib/constants/urls'
import { readSealedTokenTraderRankings } from '@/lib/rankings/token-traders'
import { readSealedRankingAuthorityGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
const CURRENT_YEAR = new Date().getFullYear()

// The page must establish current publication authority before selecting its
// generation-keyed data cache entry; persisted ISR HTML would bypass that step.
export const dynamic = 'force-dynamic'
export const revalidate = 0

// Only allow 1-20 uppercase alphanumeric characters (valid crypto token symbols)
const VALID_TOKEN_RE = /^[A-Z0-9]{1,20}$/

const PAGE_SIZE = 50
// SSR fetch budget: the position-history aggregation can be slow on a cold
// cache during cron contention; past it we mark the seed failed so the client
// can retry without presenting a fabricated empty ranking.
const SSR_TIMEOUT_MS = 4000

/**
 * Server-side first-page prefetch — replicates the GET /api/rankings/by-token
 * aggregation for offset 0 so the board paints rows on first byte instead of a
 * client-only spinner. The live publication identity participates in the cache
 * key, and the loader verifies it again before publishing the entry.
 */
const getTokenTradersSSREntry = unstable_cache(
  async (token: string, period: Period, expectedPublicationIdentity: string) => {
    const sealedRead = await readSealedTokenTraderRankings(
      getSupabaseAdmin(),
      token,
      period,
      PAGE_SIZE,
      0
    )
    if (sealedRead.publicationIdentity !== expectedPublicationIdentity) {
      throw new Error('token ranking generation changed before SSR cache publication')
    }
    return sealedRead
  },
  ['token-traders-ssr-sealed-v5'],
  { revalidate: 3600, tags: ['rankings', 'by-token'] }
)

export async function loadTokenTradersSSR(
  token: string,
  period: Period
): Promise<{ traders: TokenTrader[]; total: number }> {
  const currentGeneration = await readSealedRankingAuthorityGeneration(
    getSupabaseAdmin(),
    period,
    async () => null,
    { timeoutMs: SSR_TIMEOUT_MS }
  )
  const sealedRead = await getTokenTradersSSREntry(
    token,
    period,
    currentGeneration.publicationIdentity
  )
  if (sealedRead.publicationIdentity !== currentGeneration.publicationIdentity) {
    throw new Error('token ranking SSR cache is not the current sealed publication')
  }
  return sealedRead.value
}

async function withSsrTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Token ranking SSR timed out')), SSR_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function normalizePeriod(raw: string | undefined): Period {
  const up = (raw || '').toUpperCase()
  return (['7D', '30D', '90D'] as const).includes(up as Period) ? (up as Period) : '90D'
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>
}): Promise<Metadata> {
  const { token: rawToken } = await params
  const token = rawToken.toUpperCase()

  // Root layout template appends ' | Arena' to the metadata title; keep it out
  // here to avoid a doubled '… | Arena | Arena'. OG/Twitter bypass the template.
  const title = `Best ${token} Traders ${CURRENT_YEAR} — Who Trades ${token} Best?`
  const ogTitle = `${title} | Arena`
  const description = `Top traders for ${token} ranked by PnL across current public source boards. Rankings use the latest published data and recompute every two hours.`

  return {
    title,
    description,
    alternates: {
      canonical: `${BASE_URL}/rankings/tokens/${token}`,
    },
    keywords: [
      `best ${token} traders`,
      `top ${token} traders ${CURRENT_YEAR}`,
      `${token} trading leaderboard`,
      `${token} PnL ranking`,
      'crypto trader ranking',
      'Arena',
    ],
    openGraph: {
      title: ogTitle,
      description,
      url: `${BASE_URL}/rankings/tokens/${token}`,
      siteName: 'Arena',
      type: 'website',
      images: [
        {
          url: `${BASE_URL}/og-image.png`,
          width: 1200,
          height: 630,
          alt: `Arena ${token} Rankings`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: ogTitle,
      description,
      images: [`${BASE_URL}/og-image.png`],
      creator: '@arenafi',
    },
    robots: { index: true, follow: true },
  }
}

export default async function TokenDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ period?: string }>
}) {
  const { token: rawToken } = await params
  const token = rawToken.toUpperCase()

  // Reject malformed token symbols (SQL injection, XSS, garbage URLs)
  if (!VALID_TOKEN_RE.test(token)) {
    notFound()
  }

  const period = normalizePeriod((await searchParams).period)

  let initial: { traders: TokenTrader[]; total: number } = { traders: [], total: 0 }
  let initialStatus: 'success' | 'error' = 'success'
  try {
    initial = await withSsrTimeout(loadTokenTradersSSR(token, period))
  } catch {
    initialStatus = 'error'
  }

  return (
    <TokenRankingClient
      token={token}
      initialPeriod={period}
      initialTraders={initial.traders}
      initialTotal={initial.total}
      initialStatus={initialStatus}
      asOf={new Date().toISOString()}
    />
  )
}
