/**
 * Config-Driven Fetcher Factory
 *
 * Creates a PlatformFetcher from a declarative ExchangeConfig.
 * Handles pagination, field mapping, normalization, scoring, and upsert.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  type PlatformFetcher,
  calculateArenaScore,
  upsertTraders,
  fetchJson,
  fetchWithFallback,
  sleep,
  normalizeWinRate,
} from './shared'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

export interface PaginationConfig {
  type: 'page_number' | 'offset' | 'none'
  pageSize: number
  maxPages: number
  target: number
  delayMs?: number
}

export interface RequestConfig {
  url: string | ((period: string, page: number, pageSize: number) => string)
  method: 'GET' | 'POST'
  headers?: Record<string, string>
  bodyBuilder?: (period: string, page: number, pageSize: number) => unknown
  timeoutMs?: number
  useProxyFallback?: boolean
}

export interface MappedTraderFields {
  source_trader_id: string
  handle: string | null
  profile_url?: string | null
  roi: number | null
  pnl: number | null
  win_rate?: number | null
  max_drawdown?: number | null
  followers?: number | null
  trades_count?: number | null
  sharpe_ratio?: number | null
  aum?: number | null
  avatar_url?: string | null
}

export interface TraderMapping {
  extractList: (response: unknown) => unknown[]
  mapItem: (item: unknown, index: number) => MappedTraderFields | null
  roiIsDecimal?: boolean
  winRateIsDecimal?: boolean
  minRoi?: number
}

export interface ExchangeConfig {
  source: string
  displayName: string
  periodMap: Record<string, string>
  request: RequestConfig
  pagination: PaginationConfig
  mapping: TraderMapping
  validateResponse?: (data: unknown) => boolean
  periodDelayMs?: number
}

async function fetchPage(
  config: ExchangeConfig,
  exchangePeriod: string,
  page: number,
  pageSize: number
): Promise<unknown> {
  const url = typeof config.request.url === 'function'
    ? config.request.url(exchangePeriod, page, pageSize)
    : config.request.url

  const opts = {
    method: config.request.method,
    headers: config.request.headers,
    body: config.request.bodyBuilder
      ? config.request.bodyBuilder(exchangePeriod, page, pageSize)
      : undefined,
    timeoutMs: config.request.timeoutMs,
  }

  try {
    if (config.request.useProxyFallback) {
      const { data } = await fetchWithFallback(url, { ...opts, platform: config.source })
      return data
    }
    return await fetchJson(url, opts)
  } catch (err) {
    logger.warn(`[${config.source}] Page ${page} failed: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

async function fetchPeriod(
  config: ExchangeConfig,
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const exchangePeriod = config.periodMap[period]
  if (!exchangePeriod) return { total: 0, saved: 0, error: `No period mapping for ${period}` }

  const allItems = new Map<string, unknown>()
  let lastError: string | undefined

  for (let page = 1; page <= config.pagination.maxPages; page++) {
    const data = await fetchPage(config, exchangePeriod, page, config.pagination.pageSize)
    if (!data) { lastError = 'API returned no data'; break }
    if (config.validateResponse && !config.validateResponse(data)) { lastError = 'Response validation failed'; break }

    const items = config.mapping.extractList(data)
    if (items.length === 0) break

    for (const item of items) {
      const mapped = config.mapping.mapItem(item, allItems.size)
      if (mapped && !allItems.has(mapped.source_trader_id)) {
        allItems.set(mapped.source_trader_id, item)
      }
    }

    if (items.length < config.pagination.pageSize) break
    if (allItems.size >= config.pagination.target) break
    await sleep(config.pagination.delayMs ?? 500)
  }

  if (allItems.size === 0) return { total: 0, saved: 0, error: lastError || 'No data retrieved' }

  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = []
  let rank = 0

  for (const [, item] of allItems) {
    const mapped = config.mapping.mapItem(item, rank)
    if (!mapped) continue

    let roi = mapped.roi
    if (roi == null) continue
    if (config.mapping.roiIsDecimal) roi = Math.abs(roi) < 10 ? roi * 100 : roi
    if (roi <= (config.mapping.minRoi ?? 0)) continue

    let winRate = mapped.win_rate ?? null
    if (winRate != null && config.mapping.winRateIsDecimal) winRate = normalizeWinRate(winRate)

    const maxDrawdown = mapped.max_drawdown ?? null
    rank++

    traders.push({
      source: config.source,
      source_trader_id: mapped.source_trader_id,
      handle: mapped.handle,
      profile_url: mapped.profile_url || null,
      season_id: period,
      rank,
      roi,
      pnl: mapped.pnl,
      win_rate: winRate,
      max_drawdown: maxDrawdown != null ? Math.abs(maxDrawdown) : null,
      followers: mapped.followers,
      trades_count: mapped.trades_count,
      sharpe_ratio: mapped.sharpe_ratio,
      aum: mapped.aum,
      avatar_url: mapped.avatar_url,
      arena_score: calculateArenaScore(roi, mapped.pnl, maxDrawdown, winRate, period),
      captured_at: capturedAt,
    })
  }

  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, config.pagination.target)
  const { saved, error } = await upsertTraders(supabase, top)
  return { total: top.length, saved, error }
}

export function createConfigDrivenFetcher(config: ExchangeConfig): PlatformFetcher {
  return async (supabase: SupabaseClient, periods: string[]): Promise<FetchResult> => {
    const start = Date.now()
    const result: FetchResult = { source: config.source, periods: {}, duration: 0 }

    try {
      for (const period of periods) {
        try {
          result.periods[period] = await fetchPeriod(config, supabase, period)
        } catch (err) {
          result.periods[period] = { total: 0, saved: 0, error: err instanceof Error ? err.message : String(err) }
        }
        if (periods.indexOf(period) < periods.length - 1) await sleep(config.periodDelayMs ?? 1000)
      }
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)), { tags: { platform: config.source } })
      logger.error(`[${config.source}] Fetch failed`, err instanceof Error ? err : new Error(String(err)))
    }

    result.duration = Date.now() - start
    return result
  }
}
