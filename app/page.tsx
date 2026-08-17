import type { Metadata } from 'next'
import { getInitialTraders } from '@/lib/getInitialTraders'
import { getHeroStats } from '@/lib/data/hero-stats'
import SSRRankingTable from './components/home/SSRRankingTable'
import HomeHeroSSR from './components/home/HomeHeroSSR'
import RankingControls from './components/home/RankingControls'
import HomeFirstPaintShell from './components/home/HomeFirstPaintShell'
import TopNav from './components/layout/TopNav'
import HomePageLoader from './components/home/HomePageLoader'
import { SkipLink } from './components/Providers/Accessibility'
import { JsonLd } from './components/Providers/JsonLd'
import { PageErrorBoundary } from './components/utils/ErrorBoundary'
import { BASE_URL } from '@/lib/constants/urls'
import {
  HOMEPAGE_TRUST_COPY,
  PRODUCT_FACTS,
  formatLiveSourceBoardCoverage,
} from '@/lib/config/product-facts'
import { generateTraderItemListSchema } from '@/lib/seo/structured-data'
import type { Period } from '@/lib/utils/arena-score'

export const metadata: Metadata = {
  title: 'Arena | Crypto Trader Rankings & Community',
  description: HOMEPAGE_TRUST_COPY.metadataDescription,
  alternates: {
    canonical: BASE_URL,
  },
  openGraph: {
    title: 'Arena | Crypto Trader Rankings & Community',
    description: HOMEPAGE_TRUST_COPY.metadataDescription,
    url: BASE_URL,
    siteName: 'Arena',
    type: 'website',
    images: [
      {
        url: `${BASE_URL}/api/og/homepage`,
        width: 1200,
        height: 630,
        alt: 'Arena - Crypto Trader Rankings',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Arena | Crypto Trader Rankings & Community',
    description: HOMEPAGE_TRUST_COPY.metadataDescription,
    images: [`${BASE_URL}/api/og/homepage`],
    creator: '@arenafi',
  },
}

// Request-rendered from the publication-fenced shared Redis generation. ISR can
// finish an old render after revalidatePath('/') and restore stale HTML with no
// generation CAS, so it cannot be part of the sealed ranking surface.
export const dynamic = 'force-dynamic'

// Site-level JSON-LD structured data. The hero RPC currently reports a
// deduplicated source-family count, not a canonical arena.exchanges count, so
// describe it as source coverage and fall back to neutral wording when absent.
function buildOrganizationJsonLd(sourceBoardCount?: number | null) {
  const sourceCoverage = formatLiveSourceBoardCoverage(sourceBoardCount)
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Arena',
    url: BASE_URL,
    logo: `${BASE_URL}/logo-symbol.png`,
    sameAs: ['https://twitter.com/arenafi'],
    description: `Arena aggregates public trader rankings from ${sourceCoverage}. Rankings are recomputed every ${PRODUCT_FACTS.leaderboardRefreshHours} hours from the latest available source data.`,
  }
}

const PER_PAGE = 50
const VALID_RANGES = new Set<Period>(['7D', '30D', '90D'])
const MAX_HOME_PAGE_INDEX = 40_000

type HomeSearchParams = Record<string, string | string[] | undefined>

export interface HomeRankingQuery {
  timeRange: Period
  /** Zero-based, for the data reader/API boundary. The public URL is one-based. */
  pageIndex: number
  /** Stable complete URL cohort identity used to remount client filter state. */
  clientCohortKey: string
  /** True only for `/`, the canonical ItemList URL. */
  isCanonical: boolean
  /** Query state that the SSR cohort reader cannot faithfully apply. */
  requiresClientCohortFetch: boolean
}

function oneSearchParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function canonicalClientCohortKey(
  searchParams: HomeSearchParams,
  timeRange: Period,
  pageIndex: number
): string {
  // Preserve every query dimension in a stable order. Page/range are normalized
  // at the server boundary; legacy alpha links share the same client state as
  // their canonical score equivalent. The key deliberately remains broader
  // than the currently server-supported filters: an unknown future query may
  // cause an extra remount, but it can never reuse rows for a different URL.
  const params = new URLSearchParams()
  params.set('range', timeRange)
  params.set('page', String(pageIndex + 1))

  for (const key of Object.keys(searchParams).sort()) {
    if (key === 'range' || key === 'page') continue
    const raw = searchParams[key]
    const values = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []
    for (const value of [...values].sort()) {
      params.append(key, key === 'sort' && value === 'alpha' ? 'score' : value)
    }
  }

  return params.toString()
}

/**
 * Parse the only homepage query dimensions that the server ranking shell owns.
 *
 * `page` is intentionally human/URL one-based (`?page=2` is the second page),
 * while every data reader remains zero-based. Invalid, repeated, fractional,
 * and oversized values fail closed to the first page instead of creating an
 * unbounded offset or a client/server page disagreement.
 */
export function parseHomeRankingQuery(searchParams: HomeSearchParams): HomeRankingQuery {
  const rawRange = oneSearchParam(searchParams.range)
  const timeRange = rawRange && VALID_RANGES.has(rawRange as Period) ? (rawRange as Period) : '90D'

  const rawPage = oneSearchParam(searchParams.page)
  const parsedPage = rawPage && /^[1-9]\d{0,4}$/.test(rawPage) ? Number(rawPage) : null
  const requestedPage =
    parsedPage !== null && Number.isSafeInteger(parsedPage) && parsedPage <= MAX_HOME_PAGE_INDEX + 1
      ? parsedPage
      : 1

  return {
    timeRange,
    pageIndex: requestedPage - 1,
    clientCohortKey: canonicalClientCohortKey(searchParams, timeRange, requestedPage - 1),
    // Any query can describe a client-side filter/search state. Do not attach
    // the canonical Top-20 ItemList to those URLs; it only belongs to `/`.
    isCanonical: Object.keys(searchParams).length === 0,
    // The server reader owns only range/page. Sort, category, exchange, search,
    // and advanced-filter URLs must stay neutral until the client obtains the
    // matching cohort instead of relabelling default SSR rows as filtered data.
    requiresClientCohortFetch: Object.keys(searchParams).some(
      (key) => key !== 'range' && key !== 'page'
    ),
  }
}

/**
 * Homepage — Two-phase SSR + interactive rendering.
 *
 * Phase 1 (SSR): Hero + ranking table render as pure HTML in the initial payload.
 *   LCP = FCP ≈ 1.5s. Zero JS needed to see above-fold content.
 *
 * Phase 2 (Client): HomePageLoader defers the full interactive three-column layout
 *   (discussions, watchlist, flash news) until user interaction or idle callback.
 *   When Phase 2 mounts, it replaces the SSR ranking table with the interactive version.
 */
// This route is already force-dynamic because ranking publication generations
// must be read per request. The SSR shell therefore owns range/page as well:
// a clickable server pager must never point at a page whose rows were not read.
export default async function Page({ searchParams }: { searchParams: Promise<HomeSearchParams> }) {
  const { timeRange, pageIndex, clientCohortKey, isCanonical, requiresClientCohortFetch } =
    parseHomeRankingQuery(await searchParams)

  // Fetch data in parallel
  const [
    {
      traders,
      lastUpdated,
      isStale,
      totalCount,
      totalCountIsExact,
      hasMore,
      categoryCounts,
      categoryCountsAreExact,
    },
    heroStats,
  ] = await Promise.all([getInitialTraders(timeRange, PER_PAGE, pageIndex), getHeroStats()])

  // ItemList for the 90D leaderboard — the actual ranking users land on. Built
  // from the SSR-fetched traders (no extra query); top 20 keeps the payload lean.
  // /rankings 301-redirects here, so this is the canonical rankings ItemList too.
  const itemListJsonLd =
    isCanonical && timeRange === '90D' && pageIndex === 0
      ? generateTraderItemListSchema({
          name: 'Top Crypto Traders — 90-Day Ranking',
          description:
            'Top-ranked crypto traders on Arena by Arena Score over the trailing 90 days.',
          url: BASE_URL,
          // Schema.org ItemList must not receive a page-derived lower bound.
          // With no same-cohort count proof, describe only these concrete rows.
          numberOfItems:
            totalCountIsExact && totalCount !== null ? totalCount : traders.slice(0, 20).length,
          traders: traders.slice(0, 20).map((t) => ({
            handle: t.handle,
            arenaScore: t.arena_score,
            roi: t.roi,
          })),
        })
      : null

  return (
    <>
      {/* First focusable element on the page — lets keyboard/SR users skip the
          nav. SkipLink uses useLanguage()'s hydration-safe fallback, so it works
          without Providers (homepage deliberately omits them for LCP). */}
      <SkipLink targetId="main-content" />
      <JsonLd data={buildOrganizationJsonLd(heroStats?.sourceBoardCount)} />
      {itemListJsonLd && <JsonLd data={itemListJsonLd} />}

      {/* SSR TopNav — stays visible permanently (see HomePage.tsx). Outside
          <main> so the skip link actually skips it in the tab order. */}
      <div id="ssr-topnav">
        <TopNav />
      </div>

      <main id="main-content" tabIndex={-1}>
        {/* WelcomeBanner moved to HomePageLoader Phase 2 (client-only) */}

        {/* SSR Hero — stays visible permanently. Outside #ssr-ranking-table so
          Phase 2 hiding the table doesn't affect it. Constrained to center
          column width via max-width + margin for alignment with three-col grid. */}
        <div
          id="ssr-hero-shell"
          style={{ maxWidth: 1400, margin: '0 auto', padding: '12px 20px 0' }}
        >
          <HomeHeroSSR sourceBoardCount={heroStats?.sourceBoardCount} />
        </div>

        {/* Keep the final desktop information architecture visible from the
          first server paint. The old shell intentionally rendered rankings as
          one full-width column and introduced both sidebars only after a large
          client bundle arrived (25s on a throttled mobile connection). */}
        <HomeFirstPaintShell>
          <div className="ssr-t" style={{ marginTop: 8 }}>
            {/* A target cohort the server did not read has no trustworthy
                look-ahead witness either. Keep the first paint neutral. */}
            <RankingControls
              activeRange={timeRange}
              page={pageIndex}
              totalCount={totalCount}
              totalCountIsExact={totalCountIsExact}
              hasMore={requiresClientCohortFetch ? false : hasMore}
              perPage={PER_PAGE}
              lastUpdated={lastUpdated}
            />
            <SSRRankingTable traders={requiresClientCohortFetch ? [] : traders} />
          </div>
        </HomeFirstPaintShell>

        <PageErrorBoundary>
          <HomePageLoader
            initialTraders={traders}
            initialLastUpdated={lastUpdated}
            initialIsStale={isStale}
            heroStats={heroStats}
            initialTotalCount={totalCount}
            initialTotalCountIsExact={totalCountIsExact}
            initialHasMore={hasMore}
            initialCategoryCounts={categoryCounts}
            initialCategoryCountsAreExact={categoryCountsAreExact}
            initialTimeRange={timeRange}
            initialPageIndex={pageIndex}
            initialClientCohortPending={requiresClientCohortFetch}
            initialClientCohortKey={clientCohortKey}
          />
        </PageErrorBoundary>
      </main>
    </>
  )
}
