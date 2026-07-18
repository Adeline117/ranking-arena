import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { unstable_cache } from 'next/cache'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import TokenRankingClient, { type Period, type TokenTrader } from './TokenRankingClient'
import { BASE_URL } from '@/lib/constants/urls'
import { getTokenTraderRankings } from '@/lib/rankings/token-traders'
const CURRENT_YEAR = new Date().getFullYear()

// ISR: 1 hour (matches the by-token API cold-cache TTL).
export const revalidate = 3600

// Only allow 1-20 uppercase alphanumeric characters (valid crypto token symbols)
const VALID_TOKEN_RE = /^[A-Z0-9]{1,20}$/

const PAGE_SIZE = 50
// SSR fetch budget: the position-history aggregation can be slow on a cold
// cache during cron contention; past it we hand an empty seed to the client,
// which then fetches on the wire (mirrors the tokens index page).
const SSR_TIMEOUT_MS = 4000

/**
 * Server-side first-page prefetch — replicates the GET /api/rankings/by-token
 * aggregation for offset 0 so the board paints rows on first byte instead of a
 * client-only spinner. Wrapped in unstable_cache (keyed on token+period) and
 * de-duped with the API's own Redis layer by the shared 1h ISR window.
 */
const getTokenTradersSSR = unstable_cache(
  async (token: string, period: Period): Promise<{ traders: TokenTrader[]; total: number }> => {
    try {
      return await getTokenTraderRankings(getSupabaseAdmin(), token, period, PAGE_SIZE, 0)
    } catch {
      // Cold-cache timeout / transient DB error — empty seed, client refetches.
      return { traders: [], total: 0 }
    }
  },
  ['token-traders-ssr'],
  { revalidate: 3600, tags: ['rankings', 'by-token'] }
)

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
  try {
    initial = await Promise.race([
      getTokenTradersSSR(token, period),
      new Promise<{ traders: TokenTrader[]; total: number }>((resolve) =>
        setTimeout(() => resolve({ traders: [], total: 0 }), SSR_TIMEOUT_MS)
      ),
    ])
  } catch {
    // Timeout or error — render with empty seed, client fetches on mount.
  }

  return (
    <TokenRankingClient
      token={token}
      initialPeriod={period}
      initialTraders={initial.traders}
      initialTotal={initial.total}
      asOf={new Date().toISOString()}
    />
  )
}
