/**
 * BingX adapter (spec §11.12) — one adapter serves bingx_futures +
 * bingx_spot via src.meta.boardKey. v1 crawls only the Perpetual product.
 *
 * SIGNED BOARD. The board endpoint POST .../copy-trade-facade/v1/trader/search
 * requires a per-request `sign` header computed by the site's JS from a
 * runtime secret (not self-reproducible — verified by brute force), and the
 * API host rotates (qq-os.com ↔ we-api.com). The sign covers the request
 * BODY + headers but NOT the URL query, and stays valid for ≥12 min (verified).
 * So the adapter HARVESTS one live signed request from the page (via
 * session.capture(), triggered by a pagination click), then replays every
 * page by mutating only the `pageId` query param while reusing the captured
 * host + signed headers + body verbatim.
 *
 * One harvest serves all three TFs: the board row's `rankStat` carries EVERY
 * metric for ALL periods (7/30/90 ROI, win rate, sharpe, max drawdown,
 * cumulative PnL, riskLevel 1-10), so parseBingxLeaderboardPage extracts the
 * requested TF's headline from the same payload. CAVEAT: the board ORDERING
 * reflects the harvested filterDays (default 30d) for every TF board — the
 * per-TF STATS are exact, only the rank ordering is shared (acceptable: Arena
 * Score uses per-TF stats, not board rank).
 *
 * WORKER-ONLY MODULE (imported via adapters/register in the worker).
 */

import type {
  HistoryKind,
  ParsedHistoryRow,
  ParsedPosition,
  RankingTimeframe,
  RawBundle,
  RawPage,
  SourceRow,
  Timeframe,
} from '../../core/types'
import { registerAdapter, type SourceAdapter } from '../../core/adapter'
import type { FetchSession, ReplayRequestTemplate } from '../../fetch/types'
import { apiFetcher, replayPaged } from '../../fetch/capture'
import { parseBingxLeaderboardPage, parseBingxHistory, parseBingxPositions } from './parsers'

const SEARCH_RE = /copy-trade-facade\/v\d+\/trader\/search/

/** Harvested signed search template, cached per session (valid ≥12 min). */
const harvestedTemplate = new WeakMap<FetchSession, ReplayRequestTemplate>()

/**
 * Load the board and capture one live signed trader/search request. A
 * pagination click makes the SPA fire it with a fresh `sign`; capture()
 * records the host + signed headers + body, which we then replay verbatim.
 */
async function harvestSignedSearch(
  session: FetchSession,
  src: SourceRow
): Promise<ReplayRequestTemplate> {
  const cached = harvestedTemplate.get(session)
  if (cached) return cached

  const page = await session.page()
  const url = src.leaderboard_url ?? 'https://bingx.com/en/CopyTrading'
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})

  const capture = await session.capture(SEARCH_RE)
  // Trigger the SPA to issue a signed search (pagination → trader/search).
  const next = page
    .locator('[class*=pagination] [class*=next], li[title="Next"], button:has-text("Next")')
    .first()
  await next.click({ timeout: 8_000 }).catch(() => {
    // Some layouts page via a "load more" / page-number control instead.
  })

  const exchange = await capture.first(20_000)
  capture.dispose()
  const template = exchange.template
  harvestedTemplate.set(session, template)
  return template
}

/** Rewrite the `pageId` query param of the captured search URL. */
function withPageId(rawUrl: string, pageId: number): string {
  const u = new URL(rawUrl)
  u.searchParams.set('pageId', String(pageId))
  return u.toString()
}

const ACCOUNT_ENUM: Record<string, string> = {
  futures: 'BINGX_SWAP_FUTURES',
  spot: 'BINGX_SPOT',
}
/** Detail-page record endpoints (signed GET; sign covers the query so pages
 *  can't be replayed — we capture the browser's own signed response). */
const POSITION_RE = /copy-trade-processor\/trader-open\/current-position/
const HISTORY_RE = /copy-trade-processor\/trader-open\/history-order/
const FOLLOWERS_RE = /copy-trade-processor\/trader-open\/followers/
const TRANSFER_RE = /copy-trade-processor\/trader-open\/transfer-detail/

function boardKey(src: SourceRow): 'futures' | 'spot' {
  return src.meta.boardKey === 'spot' ? 'spot' : 'futures'
}

function detailUrl(src: SourceRow, uid: string, apiIdentity: string): string {
  const account = ACCOUNT_ENUM[boardKey(src)] ?? ACCOUNT_ENUM.futures
  return `https://bingx.com/en/CopyTrading/${uid}?accountEnum=${account}&apiIdentity=${apiIdentity}`
}

/**
 * Harvest ONE record surface from the trader detail SPA: navigate (uid +
 * apiIdentity route the API account), then capture the browser's own signed
 * response — the sign covers the URL query so a plain replay 401s (code
 * 100005). `tabLabel` triggers tab-lazy surfaces (Trades/Copier Data);
 * positions load on the default tab. Returns the parsed JSON or null.
 */
async function harvestRecordSurface(
  session: FetchSession,
  src: SourceRow,
  uid: string,
  traderMeta: Record<string, unknown> | null | undefined,
  matcher: RegExp,
  tabLabel: string | null
): Promise<unknown> {
  const apiIdentity = traderMeta?.bingx_api_identity
  if (typeof apiIdentity !== 'string' || apiIdentity === '') return null // can't route without it
  const page = await session.page()
  const capture = await session.capture(matcher)
  try {
    await page.goto(detailUrl(src, uid, apiIdentity), {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    // Activity/marketing overlays can intercept the tab click.
    await page
      .evaluate(() =>
        document
          .querySelectorAll('[class*=mask],[class*=Modal],[class*=modal]')
          .forEach((e) => e.remove())
      )
      .catch(() => {})
    if (tabLabel) {
      await page
        .getByText(tabLabel, { exact: true })
        .first()
        .click({ timeout: 8_000 })
        .catch(() => {})
    }
    const exchange = await capture.first(20_000)
    return exchange.responseJson
  } catch {
    return null // one dead surface must never sink the tier-C job
  } finally {
    capture.dispose()
  }
}

const bingxAdapter: SourceAdapter = {
  slug: 'bingx',
  capabilities: {
    // Per-TF stats come from the board's all-period rankStat. Records
    // (positions/orders/copiers) harvested from the signed detail SPA
    // (headful capture 2026-07-02). No position_history endpoint (open+close
    // are separate order rows → orders); no transfers surface.
    profile: false,
    positions: true,
    positionHistory: false,
    orders: true,
    transfers: true,
    copiers: true,
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const template = await harvestSignedSearch(session, src)
    const fetcher = apiFetcher(await session.api())
    const pageSize = src.page_size ?? 12
    const maxPages = Number(src.meta.max_pages) || null
    const ctx = () => ({
      sourceSlug: src.slug,
      currency: src.currency,
      tfLabelMap: src.tf_label_map,
      scrapedAt: new Date().toISOString(),
      meta: { ...src.meta, timeframe },
    })

    let pagesYielded = 0
    for await (const page of replayPaged({
      session,
      fetcher,
      buildRequest: (pageIndex) => ({
        url: withPageId(template.url, pageIndex),
        method: 'POST',
        headers: template.headers, // signed headers verbatim (sign covers body)
        body: template.body,
      }),
      // extractMeta sees the raw search payload (rankStat holds all TFs, so the
      // count is TF-independent here).
      extractMeta: (payload) => {
        const parsed = parseBingxLeaderboardPage(payload, ctx())
        return { rowCount: parsed.rows.length, reportedTotal: parsed.reportedTotal }
      },
      pageSize,
    })) {
      // Store the TF WITH the payload so the pure parser re-reads it from RAW
      // (the rankStat carries every period; the TF can't be inferred otherwise).
      yield { ...page, payload: { search: page.payload, timeframe } }
      pagesYielded += 1
      if (maxPages !== null && pagesYielded >= maxPages) return
    }
  },

  // Profile stats are fully covered by the board rankStat superset — no
  // separate profile fetch needed (parseProfile is a no-op).
  async getProfile(): Promise<RawBundle> {
    return { pages: [], fetchedAt: new Date().toISOString() }
  },

  async getPositions(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    traderMeta?: Record<string, unknown> | null
  ): Promise<RawBundle> {
    const fetchedAt = new Date().toISOString()
    const url =
      'https://bingx.com/api/copy-trade-facade/v1/copy-trade-processor/trader-open/current-position'
    const payload = await harvestRecordSurface(
      session,
      src,
      exchangeTraderId,
      traderMeta,
      POSITION_RE,
      null
    )
    if (payload === null) return { pages: [], fetchedAt }
    return { pages: [{ pageIndex: 1, payload, url, fetchedAt }], fetchedAt }
  },

  /** Records via the signed detail SPA (headful). The sign covers the query so
   *  pages can't be replayed — we harvest the browser's first-page response
   *  (deeper pagination is served from arena.* by the records route). */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    _cursor: string | null,
    traderMeta?: Record<string, unknown> | null
  ): AsyncIterable<RawPage> {
    const fetchedAt = new Date().toISOString()
    let matcher: RegExp
    let tab: string
    let url: string
    if (kind === 'orders') {
      matcher = HISTORY_RE
      tab = 'Trades'
      url =
        'https://bingx.com/api/copy-trade-facade/v1/copy-trade-processor/trader-open/history-order'
    } else if (kind === 'copiers') {
      matcher = FOLLOWERS_RE
      tab = 'Copier Data'
      url = 'https://bingx.com/api/copy-trade-facade/v1/copy-trade-processor/trader-open/followers'
    } else if (kind === 'transfers') {
      matcher = TRANSFER_RE
      tab = 'Transfer Records'
      url =
        'https://bingx.com/api/copy-trade-facade/v1/copy-trade-processor/trader-open/transfer-detail'
    } else {
      return // position_history not exposed by bingx
    }
    const payload = await harvestRecordSurface(
      session,
      src,
      exchangeTraderId,
      traderMeta,
      matcher,
      tab
    )
    if (payload === null) return
    yield { pageIndex: 1, payload, url, fetchedAt }
  },

  parseLeaderboard: parseBingxLeaderboardPage,
  parseProfile: () => ({ stats: [], series: [], nickname: null, avatarUrlOrigin: null }),
  parsePositions: parseBingxPositions,
  parseHistory: parseBingxHistory,
}

registerAdapter(bingxAdapter)

export { bingxAdapter }
