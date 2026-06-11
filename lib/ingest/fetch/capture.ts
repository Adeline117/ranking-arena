/**
 * JSON-endpoint replay — the single biggest optimization (spec §2.2).
 *
 * After one warm page load establishes a session, adapters replay the
 * captured XHR endpoints directly with native page/cursor params instead
 * of clicking through the UI. This module provides the paginated replay
 * loop with the spec's data-quality rules built in:
 *   - completeness assertion: pages_fetched × page_size ≥ actual_count and
 *     the last page is short or empty (spec §5.6)
 *   - degenerate-page stop rule: stop when a full page fails the
 *     "non-degenerate row" predicate (the XT-spot all-zero failure mode)
 *
 * The replay loop depends only on the JsonFetcher interface so it is
 * unit-testable without Playwright; apiFetcher() adapts a Playwright
 * APIRequestContext (browser-context bound → same egress IP as session).
 */

import type { APIRequestContext } from 'playwright'
import type { FetchSession, ReplayRequestTemplate } from './types'
import type { RawPage } from '../core/types'
import { BlockedUpstreamError, isBlockedStatus } from './rate-limiter'

export interface JsonResponse {
  status: number
  json: unknown
}

export type JsonFetcher = (template: ReplayRequestTemplate) => Promise<JsonResponse>

/** Adapt a Playwright APIRequestContext into a JsonFetcher. */
export function apiFetcher(api: APIRequestContext): JsonFetcher {
  return async (template) => {
    const response =
      template.method === 'POST'
        ? await api.post(template.url, {
            headers: template.headers,
            data: template.body as Record<string, unknown> | string | undefined,
          })
        : await api.get(template.url, { headers: template.headers })
    const status = response.status()
    let json: unknown = null
    try {
      json = await response.json()
    } catch {
      // leave null — caller decides whether a non-JSON body is fatal
    }
    return { status, json }
  }
}

/** One paced replay request; throws BlockedUpstreamError on 401/403/429. */
export async function replayJson(
  session: FetchSession,
  fetcher: JsonFetcher,
  template: ReplayRequestTemplate
): Promise<unknown> {
  return session.paced(async () => {
    const { status, json } = await fetcher(template)
    if (isBlockedStatus(status)) throw new BlockedUpstreamError(status, template.url)
    if (status < 200 || status >= 300) {
      throw new Error(`[ingest] replay ${status} for ${template.url}`)
    }
    return json
  })
}

export class IncompleteCrawlError extends Error {
  constructor(
    public readonly details: {
      pagesFetched: number
      pageSize: number | null
      reportedTotal: number | null
      rowsSeen: number
    }
  ) {
    super(
      `[ingest] incomplete crawl: ${details.rowsSeen} rows over ` +
        `${details.pagesFetched} pages vs reported total ${details.reportedTotal}`
    )
    this.name = 'IncompleteCrawlError'
  }
}

export interface ReplayPagedOptions {
  session: FetchSession
  fetcher: JsonFetcher
  /** Build the request for a 1-based page index (mutate page/cursor params). */
  buildRequest: (pageIndex: number) => ReplayRequestTemplate
  /** Extract row count + source-reported total from a payload. */
  extractMeta: (payload: unknown) => { rowCount: number; reportedTotal: number | null }
  /** Expected page size (sources.page_size); null = stop only on empty page. */
  pageSize: number | null
  /** Degenerate-page predicate (spec §5.6 XT rule). */
  isDegenerate?: (payload: unknown) => boolean
  /** Consecutive degenerate pages before stopping (default 1). */
  degenerateStopAfter?: number
  /** Hard safety cap. */
  maxPages?: number
}

/**
 * Replay a paginated endpoint page by page. Yields RawPages; the caller
 * persists them to the RAW layer and parses afterwards. Randomized request
 * order within a page is NOT applied here (pagination must be sequential);
 * adapters randomize across traders instead (spec §4).
 */
export async function* replayPaged(opts: ReplayPagedOptions): AsyncGenerator<RawPage> {
  const {
    session,
    fetcher,
    buildRequest,
    extractMeta,
    pageSize,
    isDegenerate,
    degenerateStopAfter = 1,
    maxPages = 5_000,
  } = opts

  let reportedTotal: number | null = null
  let rowsSeen = 0
  let pagesFetched = 0
  let consecutiveDegenerate = 0
  let lastPageRowCount = 0

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
    const template = buildRequest(pageIndex)
    const payload = await replayJson(session, fetcher, template)

    pagesFetched += 1
    const meta = extractMeta(payload)
    if (meta.reportedTotal !== null) reportedTotal = meta.reportedTotal
    lastPageRowCount = meta.rowCount

    if (meta.rowCount === 0) break

    if (isDegenerate?.(payload)) {
      consecutiveDegenerate += 1
      if (consecutiveDegenerate >= degenerateStopAfter) break
    } else {
      consecutiveDegenerate = 0
      rowsSeen += meta.rowCount
      yield {
        pageIndex,
        payload,
        url: template.url,
        fetchedAt: new Date().toISOString(),
      }
    }

    // Natural end: a short page means there is no next page.
    if (pageSize !== null && meta.rowCount < pageSize) break
    // Reported-total end: we have everything the source claims to have.
    if (reportedTotal !== null && rowsSeen >= reportedTotal) break
  }

  // Completeness assertion (spec §5.6): the crawl must end naturally — last
  // page short or empty — OR cover the reported total. Ending on a FULL page
  // while short of the total means pagination was truncated (e.g. maxPages
  // hit, or the endpoint stopped advancing). A degenerate stop is legitimate
  // truncation (XT) — reportedTotal there is meaningless.
  const endedNaturally =
    lastPageRowCount === 0 || (pageSize !== null && lastPageRowCount < pageSize)
  if (
    reportedTotal !== null &&
    consecutiveDegenerate === 0 &&
    rowsSeen < reportedTotal &&
    !endedNaturally
  ) {
    throw new IncompleteCrawlError({ pagesFetched, pageSize, reportedTotal, rowsSeen })
  }
}
