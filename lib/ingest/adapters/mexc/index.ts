/**
 * MEXC Futures copy-trading adapter ("MEXC AI 大模型跟单交易竞技",
 * spec §7 #10 / §11.6). REAL URL confirmed 2026-06-11 (spec §9.1):
 *   https://www.mexc.com/{locale}/futures/copyTrade/home
 * (the survey note's futures.mexc.com/.../copy-trading is an Akamai-blocked
 * dead end, NOT the product page — www.mexc.com is open to headless.)
 *
 * Endpoints (verified by live capture 2026-06-11; overridable per-source
 * via src.meta.endpoints), base /api/platform/futures/copyFutures/api/v1:
 *   list:      GET traders/v2?condition=[]&limit≤100&orderBy=COMPREHENSIVE&page=N
 *   aiRoster:  GET traders/ai                       (AI 交易员 tab roster)
 *   aiDetail:  GET traders/aiDetail?interval=...&uids=a,b,c
 *   profile:   GET trader?intervalType=...&uid=     (带单表现 stats block)
 *              GET trader/statAccumulate?dataType=ACCUMULATE_PNL_ROI|DAY_PNL
 *              GET trader/abilityRating / trader/holdStats / trader/contract/stat
 *   positions: GET trader/orders/v2?orderListType=ORDER (当前带单)
 *   history:   GET trader/ordersHis/v2 (历史带单, 90d public retention)
 *   copiers:   GET trader/followers/v2 (跟随者; PII stored, never rendered)
 *
 * Native board is 7d ONLY — the 30/90 boards are SYNTHESIZED from the
 * profile stats this adapter crawls (derive-boards processor, spec §1.1-C).
 *
 * WORKER-ONLY MODULE (imported via adapters/register in the worker).
 */

import type {
  HistoryKind,
  ParseCtx,
  RankingTimeframe,
  RawBundle,
  RawPage,
  SourceRow,
  Timeframe,
} from '../../core/types'
import { registerAdapter, type SourceAdapter } from '../../core/adapter'
import type { FetchSession } from '../../fetch/types'
import { pageFetcher, replayJson, replayPaged } from '../../fetch/capture'
import {
  parseMexcHistory,
  parseMexcLeaderboardPage,
  parseMexcPositions,
  parseMexcProfile,
} from './parsers'

const BASE = 'https://www.mexc.com/api/platform/futures/copyFutures/api/v1'

const TF_INTERVAL: Record<RankingTimeframe, string> = {
  7: 'SEVEN_DAYS',
  30: 'THIRTY_DAYS',
  90: 'NINETY_DAYS',
}

const HEADERS = { accept: 'application/json' }

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

/**
 * One page load establishes cookies/fingerprint; everything after is pure
 * same-origin JSON replay (spec §2.2). www.mexc.com accepts the bundled
 * Chromium headless (verified 2026-06-11) — no browser_channel knob needed.
 */
const warmedSessions = new WeakSet<FetchSession>()

async function warmSession(session: FetchSession, src: SourceRow): Promise<void> {
  if (warmedSessions.has(session)) return
  const page = await session.page()
  const url = src.leaderboard_url ?? 'https://www.mexc.com/zh-CN/futures/copyTrade/home'
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {
    // networkidle is best-effort — a busy page still yields valid cookies
  })
  warmedSessions.add(session)
}

/** AI 交易员 roster uids (traders/ai), cached per session — consulted on
 *  every board page so AI traders are bot-marked wherever they appear. */
const aiRosterCache = new WeakMap<FetchSession, string[]>()

async function getAiRoster(session: FetchSession, src: SourceRow): Promise<string[]> {
  const cached = aiRosterCache.get(session)
  if (cached) return cached
  const url = endpoint(src, 'aiRoster', `${BASE}/traders/ai`)
  try {
    const payload = (await replayJson(session, pageFetcher(session), {
      url,
      method: 'GET',
      headers: HEADERS,
    })) as { data?: { traders?: Array<{ uid?: unknown }> } }
    const uids = (payload?.data?.traders ?? [])
      .map((t) => (t.uid ? String(t.uid) : null))
      .filter((u): u is string => u !== null)
    aiRosterCache.set(session, uids)
    return uids
  } catch (err) {
    // The roster is additive (bot marking) — a miss must not kill Tier A.
    console.warn(
      `[mexc] AI roster fetch failed (continuing without bot marks):`,
      err instanceof Error ? err.message : err
    )
    aiRosterCache.set(session, [])
    return []
  }
}

const mexcAdapter: SourceAdapter = {
  slug: 'mexc',
  capabilities: {
    profile: true,
    positions: true, // GET trader/orders/v2 (当前带单)
    positionHistory: true, // GET trader/ordersHis/v2 (90d public retention)
    orders: false, // no public sub-order surface
    transfers: false, // no public balance-history surface
    copiers: true, // GET trader/followers/v2
  },

  /**
   * 全部交易员 board (native 7d only) + the AI 交易员 tab appended as one
   * extra page. Pages are composite payloads { list|aiDetail, aiUids } so
   * parseLeaderboard stays a pure function of stored RAW (spec §5.5).
   */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const aiUids = await getAiRoster(session, src)
    const listUrl = endpoint(src, 'list', `${BASE}/traders/v2`)
    const pageSize = src.page_size ?? 100
    const orderBy =
      typeof src.meta.list_order_by === 'string' ? src.meta.list_order_by : 'COMPREHENSIVE'
    // Validation knob: src.meta.max_pages caps the crawl (smoke runs). Early
    // generator return — replayPaged never sees a truncation, so its
    // completeness assertion stays scoped to real crawls.
    const maxPages = Number(src.meta.max_pages) || null

    let pagesYielded = 0
    let truncated = false
    for await (const page of replayPaged({
      session,
      fetcher,
      buildRequest: (pageIndex) => ({
        url:
          `${listUrl}?condition=%5B%5D&limit=${pageSize}` + `&orderBy=${orderBy}&page=${pageIndex}`,
        method: 'GET',
        headers: HEADERS,
      }),
      extractMeta: (payload) => {
        const parsed = parseMexcLeaderboardPage({ list: payload, aiUids: [] }, dummyCtx(src))
        return { rowCount: parsed.rows.length, reportedTotal: parsed.reportedTotal }
      },
      pageSize,
    })) {
      yield { ...page, payload: { list: page.payload, aiUids } }
      pagesYielded += 1
      if (maxPages !== null && pagesYielded >= maxPages) {
        truncated = true
        break
      }
    }

    // AI 交易员 tab as a final page — bot rows rank after the main board;
    // duplicates collapse in staging dedupe (better rank wins). The tab is
    // additive: a failure here must not fail the whole crawl.
    if (aiUids.length > 0) {
      const aiUrl = endpoint(src, 'aiDetail', `${BASE}/traders/aiDetail`)
      try {
        const aiDetail = await replayJson(session, fetcher, {
          url: `${aiUrl}?interval=${TF_INTERVAL[timeframe]}&uids=${encodeURIComponent(aiUids.join(','))}`,
          method: 'GET',
          headers: HEADERS,
        })
        yield {
          pageIndex: pagesYielded + 1,
          payload: { aiDetail, aiUids },
          url: aiUrl,
          fetchedAt: new Date().toISOString(),
        }
      } catch (err) {
        if (truncated) return // smoke runs: don't even warn
        console.warn(
          `[mexc] AI tab fetch failed (board published without AI rows):`,
          err instanceof Error ? err.message : err
        )
      }
    }
  },

  /**
   * Profile bundle per TF (6 replayed requests): stats block + 累计收益
   * dual chart + daily bars + 能力分析 radar + 持仓时长 + 合约偏好. These
   * profile stats are the SUBSTRATE of the derived 30/90 boards.
   */
  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const tf = (timeframe === 0 ? 90 : timeframe) as RankingTimeframe
    const interval = TF_INTERVAL[tf]
    const uid = encodeURIComponent(exchangeTraderId)
    const get = (url: string) =>
      replayJson(session, fetcher, { url, method: 'GET', headers: HEADERS })

    const traderUrl = endpoint(src, 'profile', `${BASE}/trader`)
    const accumUrl = endpoint(src, 'statAccumulate', `${BASE}/trader/statAccumulate`)
    const abilityUrl = endpoint(src, 'abilityRating', `${BASE}/trader/abilityRating`)
    const holdUrl = endpoint(src, 'holdStats', `${BASE}/trader/holdStats`)
    const contractUrl = endpoint(src, 'contractStat', `${BASE}/trader/contract/stat`)

    const trader = await get(`${traderUrl}?intervalType=${interval}&uid=${uid}`)
    const accumulate = await get(
      `${accumUrl}?dataType=ACCUMULATE_PNL_ROI&statsIntervalType=${interval}&uid=${uid}`
    )
    const dayPnl = await get(
      `${accumUrl}?dataType=DAY_PNL&statsIntervalType=${interval}&uid=${uid}`
    )
    const ability = await get(`${abilityUrl}?intervalType=${interval}&uid=${uid}`)
    // 持仓时长: 按订单 (ORDER) AND 按仓位 (POSITION) — the user asked for both
    // toggles (逐图核对). Same endpoint, dataType param varies.
    const hold = await get(`${holdUrl}?dataType=ORDER&interval=${interval}&uid=${uid}`)
    const holdByPosition = await get(
      `${holdUrl}?dataType=POSITION&interval=${interval}&uid=${uid}`
    ).catch(() => null)
    const contractStat = await get(`${contractUrl}?statsIntervalType=${interval}&uid=${uid}`)

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: {
            trader,
            accumulate,
            dayPnl,
            ability,
            hold,
            holdByPosition,
            contractStat,
            timeframe: tf,
          },
          url: traderUrl,
          fetchedAt,
        },
      ],
      fetchedAt,
    }
  },

  async getPositions(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string
  ): Promise<RawBundle> {
    await warmSession(session, src)
    const url = endpoint(src, 'positions', `${BASE}/trader/orders/v2`)
    const payload = await replayJson(session, pageFetcher(session), {
      url: `${url}?limit=20&orderListType=ORDER&page=1&uid=${encodeURIComponent(exchangeTraderId)}`,
      method: 'GET',
      headers: HEADERS,
    })
    const fetchedAt = new Date().toISOString()
    return { pages: [{ pageIndex: 1, payload, url, fetchedAt }], fetchedAt }
  },

  /**
   * 历史带单: newest-first numeric pages; stop on empty/short page, on
   * cursor overlap (oldest closeTime ≤ cursor — the processor's dedupe
   * upserts make the overlap page idempotent), or at the safety cap.
   * 跟随者: snapshot-style full pagination via reported totalPage.
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncIterable<RawPage> {
    if (kind !== 'position_history' && kind !== 'copiers') {
      throw new Error(`[mexc] history surface ${kind} not supported`)
    }
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const ctx = dummyCtx(src)

    if (kind === 'position_history') {
      const url = endpoint(src, 'positionHistory', `${BASE}/trader/ordersHis/v2`)
      const limit = 20
      const maxPages = Number(src.meta.history_max_pages) || 20
      for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
        const payload = await replayJson(session, fetcher, {
          url: `${url}?limit=${limit}&page=${pageIndex}&uid=${encodeURIComponent(exchangeTraderId)}`,
          method: 'GET',
          headers: HEADERS,
        })
        const rows = parseMexcHistory(payload, 'position_history', ctx)
        if (rows.length === 0) return
        yield { pageIndex, payload, url, fetchedAt: new Date().toISOString() }
        if (rows.length < limit) return // last (short) page
        if (cursor !== null) {
          const oldest = rows[rows.length - 1]
          if (oldest.kind === 'position_history' && oldest.closedAt && oldest.closedAt <= cursor) {
            return // overlap reached — older pages are already stored
          }
        }
      }
      return
    }

    // copiers
    const url = endpoint(src, 'copiers', `${BASE}/trader/followers/v2`)
    const limit = 10 // verified server page size; larger limits unverified
    const maxPages = Number(src.meta.copier_max_pages) || 30
    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
      const payload = await replayJson(session, fetcher, {
        url: `${url}?limit=${limit}&page=${pageIndex}&uid=${encodeURIComponent(exchangeTraderId)}`,
        method: 'GET',
        headers: HEADERS,
      })
      const rows = parseMexcHistory(payload, 'copiers', ctx)
      if (rows.length === 0) return
      yield { pageIndex, payload, url, fetchedAt: new Date().toISOString() }
      const totalPage = Number((payload as { data?: { totalPage?: unknown } })?.data?.totalPage)
      if (Number.isFinite(totalPage) && totalPage > 0 && pageIndex >= totalPage) return
      if (rows.length < limit) return
    }
  },

  parseLeaderboard: parseMexcLeaderboardPage,
  parseProfile: parseMexcProfile,
  parsePositions: parseMexcPositions,
  parseHistory: parseMexcHistory,
}

/** Parse-time ctx for in-adapter parsing (counts/stop rules only). */
function dummyCtx(src: SourceRow): ParseCtx {
  return {
    sourceSlug: src.slug,
    currency: src.currency,
    tfLabelMap: src.tf_label_map,
    scrapedAt: new Date().toISOString(),
    meta: src.meta,
  }
}

registerAdapter(mexcAdapter)

export { mexcAdapter }
