/**
 * Database query functions for the trader detail API.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { ALL_SOURCES, type TraderSource as TraderSourceType } from '@/lib/constants/exchanges'
import type { TraderSource } from './trader-types'

// 支持的交易所 source 列表
export const TRADER_SOURCES = ALL_SOURCES
export type SourceType = TraderSourceType

// Legacy source name mapping: some tables (equity_curve, position_history, etc.)
// use old source names like 'binance' instead of 'binance_futures'
const SOURCE_ALIASES: Record<string, string[]> = {
  binance_futures: ['binance', 'binance_futures'],
  bitget_futures: ['bitget', 'bitget_futures'],
  binance_spot: ['binance_spot'],
  bitget_spot: ['bitget_spot'],
  bybit: ['bybit'],
  bybit_spot: ['bybit_spot'],
  okx_futures: ['okx_futures'],
  okx_spot: ['okx_spot'],
  okx_web3: ['okx', 'okx_web3'],
  okx_wallet: ['okx_wallet'],
  mexc: ['mexc'],
  kucoin: ['kucoin'],
  coinex: ['coinex'],
  htx_futures: ['htx_futures', 'htx'],
  weex: ['weex'],
  phemex: ['phemex'],
  bingx: ['bingx'],
  gateio: ['gateio'],
  xt: ['xt'],
  lbank: ['lbank'],
  blofin: ['blofin'],
  bitmart: ['bitmart'],
  hyperliquid: ['hyperliquid'],
  gmx: ['gmx'],
  dydx: ['dydx'],
  gains: ['gains'],
  jupiter_perps: ['jupiter_perps'],
  aevo: ['aevo'],
  binance_web3: ['binance_web3'],
  dune_gmx: ['dune_gmx'],
  dune_hyperliquid: ['dune_hyperliquid'],
  dune_uniswap: ['dune_uniswap'],
  dune_defi: ['dune_defi'],
  web3_bot: ['web3_bot'],
}

// Helper: get all source aliases for a given source type
export function getSourceAliases(sourceType: string): string[] {
  return SOURCE_ALIASES[sourceType] || [sourceType]
}

// Promise 超时包装器（防止数据库查询永久挂起）
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback?: T): Promise<T> {
  const timeout = new Promise<T>((_, reject) =>
    setTimeout(() => reject(new Error(`Query timeout after ${ms}ms`)), ms)
  )
  if (fallback !== undefined) {
    return Promise.race([promise, timeout]).catch(() => fallback)
  }
  return Promise.race([promise, timeout])
}

// 安全查询函数 - 处理可能不存在的表
export async function safeQuery<T>(
  queryFn: () => PromiseLike<{ data: T | null; error: { code?: string; message?: string } | null }>
): Promise<T | null> {
  try {
    const result = await queryFn()
    if (result.error && (
      result.error.code === '42P01' ||
      result.error.message?.includes('does not exist') ||
      result.error.message?.includes('relation')
    )) {
      return null
    }
    return result.data
  } catch {
    return null
  }
}

// 查找交易员来源 — single query instead of N+1 per platform
export async function findTraderSource(
  supabase: SupabaseClient,
  handle: string
): Promise<{ source: TraderSource; sourceType: SourceType } | null> {
  const decodedHandle = decodeURIComponent(handle)

  const { data: byHandle } = await supabase
    .from('trader_sources')
    .select('source, source_trader_id, handle, profile_url, avatar_url, market_type')
    .eq('handle', decodedHandle)
    .in('source', TRADER_SOURCES as unknown as string[])
    .limit(1)
    .maybeSingle()

  if (byHandle && TRADER_SOURCES.includes(byHandle.source as SourceType)) {
    return { source: byHandle as TraderSource, sourceType: byHandle.source as SourceType }
  }

  const { data: byId } = await supabase
    .from('trader_sources')
    .select('source, source_trader_id, handle, profile_url, avatar_url, market_type')
    .eq('source_trader_id', decodedHandle)
    .in('source', TRADER_SOURCES as unknown as string[])
    .limit(1)
    .maybeSingle()

  if (byId && TRADER_SOURCES.includes(byId.source as SourceType)) {
    return { source: byId as TraderSource, sourceType: byId.source as SourceType }
  }

  return null
}

// 从 trader_snapshots 直接查找交易员（当 trader_sources 没有数据时的回退方案）
export async function findTraderFromSnapshots(
  supabase: SupabaseClient,
  handle: string
): Promise<{ traderId: string; sourceType: SourceType } | null> {
  const decodedHandle = decodeURIComponent(handle)

  const { data } = await supabase
    .from('trader_snapshots')
    .select('source, source_trader_id')
    .eq('source_trader_id', decodedHandle)
    .in('source', TRADER_SOURCES as unknown as string[])
    .limit(1)
    .maybeSingle()

  if (data && TRADER_SOURCES.includes(data.source as SourceType)) {
    return { traderId: data.source_trader_id, sourceType: data.source as SourceType }
  }

  return null
}
