import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  getTokenTraderRankingSnapshot,
  TOKEN_RANKING_MAX_GENERATION,
  TokenRankingReadError,
  type TokenRankingPeriod,
  type TokenTraderRankingSnapshot,
} from '@/lib/rankings/token-ranking-snapshot'
import { isValidTokenSymbol } from '@/lib/utils/token-symbol'
import TokenRankingClient from './TokenRankingClient'
import { BASE_URL } from '@/lib/constants/urls'

const PAGE_SIZE = 50
const MAX_PAGE_INDEX = 40_000
const SSR_TIMEOUT_MS = 4_000

// The current DB head must be read for every request. A one-hour Full Route
// Cache could otherwise pin HTML to a retired generation after the API moved.
export const dynamic = 'force-dynamic'
export const revalidate = 0

type RawSearchParams = Record<string, string | string[] | undefined>

export interface TokenPageQuery {
  period: TokenRankingPeriod
  page: number
  generation?: string
  canonical: boolean
}

function oneValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function parseTokenPageQuery(searchParams: RawSearchParams): TokenPageQuery {
  const allowedKeys = new Set(['generation', 'page', 'period'])
  const exactKeys = Object.keys(searchParams).every(
    (key) => allowedKeys.has(key) && !Array.isArray(searchParams[key])
  )
  const rawPeriod = oneValue(searchParams.period)
  const normalizedPeriod = rawPeriod?.toUpperCase()
  const period: TokenRankingPeriod =
    normalizedPeriod === '7D' || normalizedPeriod === '30D' || normalizedPeriod === '90D'
      ? normalizedPeriod
      : '90D'

  const rawPage = oneValue(searchParams.page)
  const page =
    rawPage && /^[1-9]\d{0,4}$/.test(rawPage) ? Math.min(Number(rawPage), MAX_PAGE_INDEX) : 0
  const rawGeneration = oneValue(searchParams.generation)
  let generation: string | undefined
  if (rawGeneration && /^[1-9]\d{0,15}$/.test(rawGeneration)) {
    const parsed = BigInt(rawGeneration)
    if (parsed <= BigInt(TOKEN_RANKING_MAX_GENERATION) && String(parsed) === rawGeneration) {
      generation = rawGeneration
    }
  }

  const canonicalPeriod =
    (rawPeriod === undefined && period === '90D') || (rawPeriod === period && period !== '90D')
  const canonicalPage =
    (rawPage === undefined && page === 0) || (page > 0 && rawPage === String(page))
  const canonicalGeneration = rawGeneration === undefined || rawGeneration === generation

  return {
    period,
    page,
    generation,
    canonical: exactKeys && canonicalPeriod && canonicalPage && canonicalGeneration,
  }
}

function tokenPagePath(
  token: string,
  period: TokenRankingPeriod,
  page: number,
  generation?: string
): string {
  const params = new URLSearchParams()
  if (period !== '90D') params.set('period', period)
  if (page > 0) params.set('page', String(page))
  if (generation) params.set('generation', generation)
  const query = params.toString()
  return `/rankings/tokens/${encodeURIComponent(token)}${query ? `?${query}` : ''}`
}

export async function loadTokenTradersSSR(
  token: string,
  period: TokenRankingPeriod,
  page: number,
  generation?: string,
  signal?: AbortSignal
): Promise<TokenTraderRankingSnapshot> {
  return getTokenTraderRankingSnapshot(
    getSupabaseAdmin(),
    {
      token,
      period,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      generation,
    },
    { signal }
  )
}

async function withSsrTimeout<T>(load: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      load(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new Error('Token ranking SSR timed out'))
        }, SSR_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>
}): Promise<Metadata> {
  const { token: rawToken } = await params
  const token = rawToken.toUpperCase()
  const title = `${token} Token Ranking Verification`
  const ogTitle = `${title} | Arena`
  const description = `${token} trader rankings publish only after history, price, cost-basis, and FX evidence pass authority-snapshot verification.`

  return {
    title,
    description,
    alternates: { canonical: `${BASE_URL}/rankings/tokens/${token}` },
    keywords: [
      `${token} trader rankings`,
      `${token} trading leaderboard`,
      'verified crypto trader ranking',
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
          alt: `Arena ${token} ranking verification`,
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
    robots: { index: false, follow: true },
  }
}

export default async function TokenDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<RawSearchParams>
}) {
  const { token: rawToken } = await params
  const token = rawToken.toUpperCase()
  if (!isValidTokenSymbol(token)) notFound()

  const query = parseTokenPageQuery(await searchParams)
  const canonicalPath = tokenPagePath(token, query.period, query.page, query.generation)
  if (rawToken !== token || !query.canonical) redirect(canonicalPath)

  let initial: TokenTraderRankingSnapshot | null = null
  let initialStatus: 'success' | 'unpublished' | 'error' = 'success'
  try {
    initial = await withSsrTimeout((signal) =>
      loadTokenTradersSSR(token, query.period, query.page, query.generation, signal)
    )
  } catch (error) {
    initialStatus =
      error instanceof TokenRankingReadError && error.kind === 'not_published'
        ? 'unpublished'
        : 'error'
  }

  if (initial) {
    const totalPages = Math.ceil(initial.total / PAGE_SIZE)
    const lastPage = Math.max(totalPages - 1, 0)
    if (query.page > lastPage) {
      redirect(tokenPagePath(token, query.period, lastPage, initial.generation))
    }
  }

  return (
    <TokenRankingClient
      key={`${token}:${initial?.generation ?? initialStatus}`}
      token={token}
      initialPeriod={query.period}
      initialPage={query.page}
      requestedGeneration={query.generation ?? null}
      initialSnapshot={initial}
      initialStatus={initialStatus}
    />
  )
}
