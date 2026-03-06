/**
 * Exchange Configs — Declarative configs for config-driven fetchers
 *
 * Each config produces a PlatformFetcher via createConfigDrivenFetcher().
 * To add a new exchange, add an ExchangeConfig here and register in index.ts.
 */

import { type ExchangeConfig, createConfigDrivenFetcher } from './config-driven-fetcher'
import type { PlatformFetcher } from './shared'
import { parseNum, normalizeWinRate, normalizeROI } from './shared'

function genericExtractList(response: unknown): unknown[] {
  if (!response || typeof response !== 'object') return []
  if (Array.isArray(response)) return response
  const resp = response as Record<string, unknown>
  const data = resp.data
  if (!data) return []
  if (Array.isArray(data)) return data
  if (typeof data === 'object' && data !== null) {
    const d = data as Record<string, unknown>
    for (const key of ['list', 'rows', 'records']) {
      if (Array.isArray(d[key])) return d[key] as unknown[]
    }
  }
  return []
}

type AnyItem = Record<string, any>

const toobitConfig: ExchangeConfig = {
  source: 'toobit',
  displayName: 'Toobit',
  periodMap: { '7D': '7', '30D': '30', '90D': '90' },
  request: {
    url: (period, page, pageSize) =>
      `https://www.toobit.com/api/v1/copy/leader/rank?sortBy=roi&period=${period}&page=${page}&pageSize=${pageSize}`,
    method: 'GET',
    headers: { Referer: 'https://www.toobit.com/en-US/copy-trading', Origin: 'https://www.toobit.com' },
    timeoutMs: 10000,
  },
  pagination: { type: 'page_number', pageSize: 50, maxPages: 10, target: 500, delayMs: 300 },
  mapping: {
    extractList: genericExtractList,
    mapItem: (raw) => {
      const item = raw as AnyItem
      const id = String(item.leaderId || item.uid || item.userId || item.id || '')
      if (!id || id === 'undefined') return null
      let roi = parseNum(item.roi)
      if (roi === null) return null
      roi = normalizeROI(roi, 'toobit') ?? roi
      return {
        source_trader_id: id,
        handle: item.nickname || item.nickName || item.name || `Trader_${id.slice(0, 8)}`,
        avatar_url: item.avatar || null,
        profile_url: `https://www.toobit.com/en-US/copy-trading/leader/${id}`,
        roi,
        pnl: parseNum(item.pnl),
        win_rate: normalizeWinRate(parseNum(item.winRate)),
        max_drawdown: parseNum(item.maxDrawdown),
        followers: parseNum(item.followers ?? item.followerCount ?? item.copiers),
      }
    },
    minRoi: 0,
  },
  periodDelayMs: 1000,
}

const btseConfig: ExchangeConfig = {
  source: 'btse',
  displayName: 'BTSE',
  periodMap: { '7D': '7D', '30D': '30D', '90D': '90D' },
  request: {
    url: (period, page, pageSize) =>
      `https://www.btse.com/api/copy-trading/leaders?sort=roi&period=${period}&page=${page}&size=${pageSize}`,
    method: 'GET',
    headers: { Referer: 'https://www.btse.com/en/copy-trading', Origin: 'https://www.btse.com' },
    timeoutMs: 10000,
  },
  pagination: { type: 'page_number', pageSize: 50, maxPages: 10, target: 500, delayMs: 300 },
  mapping: {
    extractList: genericExtractList,
    mapItem: (raw) => {
      const item = raw as AnyItem
      const id = String(item.leaderId || item.uid || item.id || '')
      if (!id || id === 'undefined') return null
      let roi = parseNum(item.roi)
      if (roi === null) return null
      roi = normalizeROI(roi, 'btse') ?? roi
      return {
        source_trader_id: id,
        handle: item.nickname || `Trader_${id.slice(0, 8)}`,
        avatar_url: item.avatar || null,
        profile_url: `https://www.btse.com/en/copy-trading/leader/${id}`,
        roi,
        pnl: parseNum(item.pnl),
        win_rate: normalizeWinRate(parseNum(item.winRate)),
        max_drawdown: parseNum(item.maxDrawdown),
        followers: parseNum(item.followers ?? item.copiers),
      }
    },
    minRoi: 0,
  },
  periodDelayMs: 1000,
}

const cryptocomConfig: ExchangeConfig = {
  source: 'cryptocom',
  displayName: 'Crypto.com',
  periodMap: { '7D': '7d', '30D': '30d', '90D': '90d' },
  request: {
    url: (period, page, pageSize) =>
      `https://crypto.com/fe-ex-api/copy/leader/list?sort=roi&period=${period}&page=${page}&pageSize=${pageSize}`,
    method: 'GET',
    headers: { Referer: 'https://crypto.com/exchange/copy-trading', Origin: 'https://crypto.com' },
    timeoutMs: 10000,
  },
  pagination: { type: 'page_number', pageSize: 50, maxPages: 10, target: 500, delayMs: 300 },
  mapping: {
    extractList: genericExtractList,
    mapItem: (raw) => {
      const item = raw as AnyItem
      const id = String(item.leaderId || item.uid || item.id || '')
      if (!id || id === 'undefined') return null
      let roi = parseNum(item.roi)
      if (roi === null) return null
      roi = normalizeROI(roi, 'cryptocom') ?? roi
      return {
        source_trader_id: id,
        handle: item.nickname || `Trader_${id.slice(0, 8)}`,
        avatar_url: item.avatar || item.avatarUrl || null,
        profile_url: `https://crypto.com/exchange/copy-trading/leader/${id}`,
        roi,
        pnl: parseNum(item.pnl),
        win_rate: normalizeWinRate(parseNum(item.winRate ?? item.win_rate)),
        max_drawdown: parseNum(item.maxDrawdown ?? item.max_drawdown),
        followers: parseNum(item.followers ?? item.followerCount ?? item.copiers),
      }
    },
    minRoi: 0,
  },
  periodDelayMs: 1000,
}

export const EXCHANGE_CONFIGS: ExchangeConfig[] = [toobitConfig, btseConfig, cryptocomConfig]

export const CONFIG_DRIVEN_FETCHERS: Record<string, PlatformFetcher> = {}
for (const config of EXCHANGE_CONFIGS) {
  CONFIG_DRIVEN_FETCHERS[config.source] = createConfigDrivenFetcher(config)
}
