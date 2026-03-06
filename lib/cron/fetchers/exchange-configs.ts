import { type ExchangeConfig, createConfigDrivenFetcher } from './config-driven-fetcher'
import type { PlatformFetcher } from './shared'
import { parseNum, normalizeWinRate } from './shared'

function genericExtractList(
  response: unknown,
  keys: string[] = ['list', 'rows', 'records']
): unknown[] {
  if (!response || typeof response !== 'object') return []
  if (Array.isArray(response)) return response

  const resp = response as Record<string, unknown>
  const data = resp.data
  if (!data) return []
  if (Array.isArray(data)) return data

  if (typeof data === 'object' && data !== null) {
    const d = data as Record<string, unknown>
    for (const key of keys) {
      if (Array.isArray(d[key])) return d[key] as unknown[]
    }
  }

  return []
}

// ---- Toobit ----
// Original: lib/cron/fetchers/toobit.ts

interface ToobitItem {
  leaderId?: string
  uid?: string
  userId?: string
  id?: string | number
  nickname?: string
  nickName?: string
  displayName?: string
  name?: string
  avatar?: string
  avatarUrl?: string
  roi?: number | string
  returnRate?: number | string
  pnl?: number | string
  profit?: number | string
  winRate?: number | string
  win_rate?: number | string
  maxDrawdown?: number | string
  max_drawdown?: number | string
  followers?: number | string
  followerCount?: number | string
  copiers?: number | string
  copyCount?: number | string
}

const toobitConfig: ExchangeConfig = {
  source: 'toobit',
  displayName: 'Toobit',
  periodMap: { '7D': '7', '30D': '30', '90D': '90' },
  request: {
    url: (period: string, page: number, pageSize: number) =>
      `https://www.toobit.com/api/v1/copy/leader/rank?sortBy=roi&period=${period}&page=${page}&pageSize=${pageSize}`,
    method: 'GET',
    headers: {
      Referer: 'https://www.toobit.com/en-US/copy-trading',
      Origin: 'https://www.toobit.com',
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeoutMs: 10000,
  },
  pagination: { type: 'page_number', pageSize: 50, maxPages: 10, target: 500, delayMs: 300 },
  mapping: {
    extractList: (response: unknown) => genericExtractList(response),
    mapItem: (raw: unknown) => {
      const item = raw as ToobitItem
      const id = String(item.leaderId || item.uid || item.userId || item.id || '')
      if (!id || id === 'undefined') return null

      let roi = parseNum(item.roi ?? item.returnRate)
      if (roi === null) return null
      if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

      const pnl = parseNum(item.pnl ?? item.profit)
      const winRate = normalizeWinRate(parseNum(item.winRate ?? item.win_rate))

      let maxDrawdown = parseNum(item.maxDrawdown ?? item.max_drawdown)
      if (maxDrawdown !== null && Math.abs(maxDrawdown) > 0 && Math.abs(maxDrawdown) <= 1) {
        maxDrawdown *= 100
      }

      const followers = parseNum(
        item.followers ?? item.followerCount ?? item.copiers ?? item.copyCount
      )
      const handle =
        item.nickname || item.nickName || item.displayName || item.name || `Trader_${id.slice(0, 8)}`

      return {
        source_trader_id: id,
        handle,
        avatar_url: item.avatar || item.avatarUrl || null,
        profile_url: `https://www.toobit.com/en-US/copy-trading/leader/${id}`,
        roi,
        pnl,
        win_rate: winRate,
        max_drawdown: maxDrawdown,
        followers: followers ? Math.round(followers) : null,
      }
    },
    roiIsDecimal: false,
    winRateIsDecimal: false,
    minRoi: 0,
  },
  periodDelayMs: 1000,
}

// ---- BTSE ----
// Original: lib/cron/fetchers/btse.ts

interface BtseItem {
  leaderId?: string
  uid?: string
  id?: string | number
  nickname?: string
  displayName?: string
  avatar?: string
  roi?: number | string
  pnl?: number | string
  winRate?: number | string
  maxDrawdown?: number | string
  followers?: number | string
  copiers?: number | string
}

const btseConfig: ExchangeConfig = {
  source: 'btse',
  displayName: 'BTSE',
  periodMap: { '7D': '7D', '30D': '30D', '90D': '90D' },
  request: {
    url: (period: string, page: number, pageSize: number) =>
      `https://www.btse.com/api/copy-trading/leaders?sort=roi&period=${period}&page=${page}&size=${pageSize}`,
    method: 'GET',
    headers: {
      Referer: 'https://www.btse.com/en/copy-trading',
      Origin: 'https://www.btse.com',
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeoutMs: 10000,
  },
  pagination: { type: 'page_number', pageSize: 50, maxPages: 10, target: 500, delayMs: 300 },
  mapping: {
    extractList: (response: unknown) => genericExtractList(response),
    mapItem: (raw: unknown) => {
      const item = raw as BtseItem
      const id = String(item.leaderId || item.uid || item.id || '')
      if (!id || id === 'undefined') return null

      let roi = parseNum(item.roi)
      if (roi === null) return null
      if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

      const pnl = parseNum(item.pnl)
      const winRate = normalizeWinRate(parseNum(item.winRate))

      let maxDrawdown = parseNum(item.maxDrawdown)
      if (maxDrawdown !== null && Math.abs(maxDrawdown) > 0 && Math.abs(maxDrawdown) <= 1) {
        maxDrawdown *= 100
      }

      const followers = parseNum(item.followers ?? item.copiers)
      const handle = item.nickname || item.displayName || `Trader_${id.slice(0, 8)}`

      return {
        source_trader_id: id,
        handle,
        avatar_url: item.avatar || null,
        profile_url: `https://www.btse.com/en/copy-trading/leader/${id}`,
        roi,
        pnl,
        win_rate: winRate,
        max_drawdown: maxDrawdown,
        followers: followers ? Math.round(followers) : null,
      }
    },
    roiIsDecimal: false,
    winRateIsDecimal: false,
    minRoi: 0,
  },
  periodDelayMs: 1000,
}

// ---- Crypto.com ----
// Original: lib/cron/fetchers/cryptocom.ts

interface CryptoComItem {
  leaderId?: string
  uid?: string
  id?: string | number
  nickname?: string
  displayName?: string
  avatar?: string
  avatarUrl?: string
  roi?: number | string
  pnl?: number | string
  winRate?: number | string
  win_rate?: number | string
  maxDrawdown?: number | string
  max_drawdown?: number | string
  followers?: number | string
  followerCount?: number | string
  copiers?: number | string
}

const cryptocomConfig: ExchangeConfig = {
  source: 'cryptocom',
  displayName: 'Crypto.com',
  periodMap: { '7D': '7d', '30D': '30d', '90D': '90d' },
  request: {
    url: (period: string, page: number, pageSize: number) =>
      `https://crypto.com/fe-ex-api/copy/leader/list?sort=roi&period=${period}&page=${page}&pageSize=${pageSize}`,
    method: 'GET',
    headers: {
      Referer: 'https://crypto.com/exchange/copy-trading',
      Origin: 'https://crypto.com',
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeoutMs: 10000,
  },
  pagination: { type: 'page_number', pageSize: 50, maxPages: 10, target: 500, delayMs: 300 },
  mapping: {
    extractList: (response: unknown) => genericExtractList(response),
    mapItem: (raw: unknown) => {
      const item = raw as CryptoComItem
      const id = String(item.leaderId || item.uid || item.id || '')
      if (!id || id === 'undefined') return null

      let roi = parseNum(item.roi)
      if (roi === null) return null
      if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

      const pnl = parseNum(item.pnl)
      let winRate = parseNum(item.winRate ?? item.win_rate)
      winRate = normalizeWinRate(winRate)

      let maxDrawdown = parseNum(item.maxDrawdown ?? item.max_drawdown)
      if (maxDrawdown !== null && Math.abs(maxDrawdown) > 0 && Math.abs(maxDrawdown) <= 1) {
        maxDrawdown *= 100
      }

      const followers = parseNum(item.followers ?? item.followerCount ?? item.copiers)
      const handle = item.nickname || item.displayName || `Trader_${id.slice(0, 8)}`

      return {
        source_trader_id: id,
        handle,
        avatar_url: item.avatar || item.avatarUrl || null,
        profile_url: `https://crypto.com/exchange/copy-trading/leader/${id}`,
        roi,
        pnl,
        win_rate: winRate,
        max_drawdown: maxDrawdown,
        followers: followers ? Math.round(followers) : null,
      }
    },
    roiIsDecimal: false,
    winRateIsDecimal: false,
    minRoi: 0,
  },
  periodDelayMs: 1000,
}

// ---- Export ----

export const EXCHANGE_CONFIGS: ExchangeConfig[] = [
  toobitConfig,
  btseConfig,
  cryptocomConfig,
]

export const CONFIG_DRIVEN_FETCHERS: Record<string, PlatformFetcher> = {}

for (const config of EXCHANGE_CONFIGS) {
  CONFIG_DRIVEN_FETCHERS[config.source] = createConfigDrivenFetcher(config)
}
