/**
 * Bitget adapter (Phase 0 reference source — spec §15 Phase 0, §11.4).
 * One adapter serves bitget_futures / bitget_spot / bitget_cfd; the board
 * is selected by src.meta.boardKey. Known JSON endpoints (from the legacy
 * connector, overridable per-source via src.meta.endpoints):
 *   list:       GET /v1/trigger/trace/public/currentTrader/list
 *   detail:     GET /v1/trigger/trace/public/trader/detail
 *   profitList: GET /v1/trigger/trace/public/trader/profitList
 *
 * WORKER-ONLY MODULE (imported via adapters/register in the worker).
 */

import type {
  HistoryKind,
  ParseCtx,
  ParsedHistoryRow,
  ParsedPosition,
  RankingTimeframe,
  RawBundle,
  RawPage,
  SourceRow,
  Timeframe,
} from '../../core/types'
import { registerAdapter, type SourceAdapter } from '../../core/adapter'
import type { FetchSession } from '../../fetch/types'
import { apiFetcher, replayJson, replayPaged } from '../../fetch/capture'
import { BITGET_TF_PARAM, parseBitgetLeaderboardPage, parseBitgetProfile } from './parsers'

const BASE = 'https://www.bitget.com/v1/trigger/trace/public'

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

const bitgetAdapter: SourceAdapter = {
  slug: 'bitget',
  capabilities: {
    profile: true,
    positions: false, // wired in the positions commit
    positionHistory: false,
    orders: false,
    transfers: false, // Bitget balance history — wired in the histories commit
    copiers: false,
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const api = await session.api()
    const fetcher = apiFetcher(api)
    const listUrl = endpoint(src, 'list', `${BASE}/currentTrader/list`)
    const pageSize = src.page_size ?? 100
    const timeRange = BITGET_TF_PARAM[timeframe]

    yield* replayPaged({
      session,
      fetcher,
      buildRequest: (pageIndex) => ({
        url:
          `${listUrl}?pageNo=${pageIndex}&pageSize=${pageSize}` +
          `&sortType=2&timeRange=${timeRange}`,
        method: 'GET',
        headers: { accept: 'application/json' },
      }),
      extractMeta: (payload) => {
        const page = parseBitgetLeaderboardPage(payload, dummyCtx(src))
        return { rowCount: page.rows.length, reportedTotal: page.reportedTotal }
      },
      pageSize,
    })
  },

  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    const api = await session.api()
    const fetcher = apiFetcher(api)
    const tf = (timeframe === 0 ? 90 : timeframe) as RankingTimeframe
    const detailUrl = endpoint(src, 'detail', `${BASE}/trader/detail`)
    const profitUrl = endpoint(src, 'profitList', `${BASE}/trader/profitList`)

    const detail = await replayJson(session, fetcher, {
      url: `${detailUrl}?traderId=${exchangeTraderId}&timeRange=${BITGET_TF_PARAM[tf]}`,
      method: 'GET',
      headers: { accept: 'application/json' },
    })
    const profitList = await replayJson(session, fetcher, {
      url: `${profitUrl}?traderId=${exchangeTraderId}`,
      method: 'GET',
      headers: { accept: 'application/json' },
    })

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: { detail, profitList, timeframe: tf },
          url: detailUrl,
          fetchedAt,
        },
      ],
      fetchedAt,
    }
  },

  async getPositions(): Promise<RawBundle> {
    throw new Error('[bitget] positions surface not implemented yet')
  },

  async *getHistory(
    _session: FetchSession,
    _src: SourceRow,
    _exchangeTraderId: string,
    kind: HistoryKind
  ): AsyncIterable<RawPage> {
    throw new Error(`[bitget] history surface ${kind} not implemented yet`)
  },

  parseLeaderboard: parseBitgetLeaderboardPage,
  parseProfile: parseBitgetProfile,

  parsePositions(): ParsedPosition[] {
    throw new Error('[bitget] positions parser not implemented yet')
  },

  parseHistory(_raw: unknown, kind: HistoryKind): ParsedHistoryRow[] {
    throw new Error(`[bitget] history parser ${kind} not implemented yet`)
  },
}

/** Parse-time ctx for extractMeta inside the replay loop (counts only). */
function dummyCtx(src: SourceRow): ParseCtx {
  return {
    sourceSlug: src.slug,
    currency: src.currency,
    tfLabelMap: src.tf_label_map,
    scrapedAt: new Date().toISOString(),
    meta: src.meta,
  }
}

registerAdapter(bitgetAdapter)

export { bitgetAdapter }
