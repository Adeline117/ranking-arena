/**
 * Web3 Bot — Inline fetcher for Vercel serverless
 *
 * Fetches data for 3 categories of Web3 bots:
 * 1. TG Bots (Banana Gun, Trojan, Photon, etc.) — fees from DeFi Llama
 * 2. Vaults (Yearn, Beefy, etc.) — TVL from DeFi Llama
 * 3. AI Agents (ai16z, Virtuals, etc.) — market cap from CoinGecko
 *
 * Scoring: fees/TVL/mcap normalized → Arena Score
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  upsertTraders,
  fetchJson,
  sleep,
} from '../shared'
import { logger } from '@/lib/logger'

const SOURCE = 'web3_bot'

// ── Bot Registry ──

interface BotConfig {
  id: string
  name: string
  category: 'tg_bot' | 'vault' | 'ai_agent'
  defillamaSlug?: string    // For fees/TVL
  coingeckoId?: string      // For market cap
  profileUrl: string
}

const BOTS: BotConfig[] = [
  // TG Trading Bots (ranked by fees = user activity)
  { id: 'banana-gun', name: 'Banana Gun', category: 'tg_bot', defillamaSlug: 'banana-gun', coingeckoId: 'banana-gun', profileUrl: 'https://bananagun.io' },
  { id: 'trojan', name: 'Trojan', category: 'tg_bot', defillamaSlug: 'trojan', profileUrl: 'https://trojan.app' },
  { id: 'photon', name: 'Photon', category: 'tg_bot', defillamaSlug: 'photon', profileUrl: 'https://photon-sol.tinyastro.io' },
  { id: 'maestro', name: 'Maestro', category: 'tg_bot', defillamaSlug: 'maestro', profileUrl: 'https://www.maestrobots.com' },
  { id: 'bonkbot', name: 'BONKbot', category: 'tg_bot', defillamaSlug: 'bonkbot', profileUrl: 'https://bonkbot.io' },
  { id: 'sol-trading-bot', name: 'SolTradingBot', category: 'tg_bot', defillamaSlug: 'sol-trading-bot', profileUrl: 'https://soltradingbot.com' },
  { id: 'bloom', name: 'Bloom', category: 'tg_bot', defillamaSlug: 'bloom', profileUrl: 'https://bloom.trading' },
  { id: 'pepeboost', name: 'PepeBoost', category: 'tg_bot', defillamaSlug: 'pepeboost', profileUrl: 'https://t.me/pepeboost_sol_bot' },

  // Yield Vaults (ranked by TVL = trust)
  { id: 'yearn', name: 'Yearn Finance', category: 'vault', defillamaSlug: 'yearn-finance', coingeckoId: 'yearn-finance', profileUrl: 'https://yearn.fi' },
  { id: 'beefy', name: 'Beefy', category: 'vault', defillamaSlug: 'beefy', coingeckoId: 'beefy-finance', profileUrl: 'https://beefy.com' },
  { id: 'sommelier', name: 'Sommelier', category: 'vault', defillamaSlug: 'sommelier', coingeckoId: 'sommelier', profileUrl: 'https://www.sommelier.finance' },
  { id: 'harvest', name: 'Harvest Finance', category: 'vault', defillamaSlug: 'harvest-finance', coingeckoId: 'harvest-finance', profileUrl: 'https://harvest.finance' },

  // AI Trading Agents (ranked by market cap = market confidence)
  { id: 'ai16z', name: 'ai16z', category: 'ai_agent', coingeckoId: 'ai16z', profileUrl: 'https://ai16z.ai' },
  { id: 'virtuals', name: 'Virtuals Protocol', category: 'ai_agent', coingeckoId: 'virtual-protocol', profileUrl: 'https://virtuals.io' },
  { id: 'aixbt', name: 'AIXBT', category: 'ai_agent', coingeckoId: 'aixbt', profileUrl: 'https://aixbt.tech' },
  { id: 'griffain', name: 'Griffain', category: 'ai_agent', coingeckoId: 'griffain', profileUrl: 'https://griffain.com' },
]

// ── Data fetchers ──

interface BotMetrics {
  fees24h?: number
  fees30d?: number
  tvl?: number
  mcap?: number
  price?: number
  vol24h?: number
}

async function fetchDefiLlamaFees(slug: string): Promise<{ fees24h: number; fees30d: number } | null> {
  const data = await fetchJson(`https://api.llama.fi/summary/fees/${slug}`) as {
    total24h?: number; total30d?: number
  } | null
  if (!data) return null
  return {
    fees24h: data.total24h || 0,
    fees30d: data.total30d || 0,
  }
}

async function fetchDefiLlamaTvl(slug: string): Promise<number | null> {
  const data = await fetchJson(`https://api.llama.fi/protocol/${slug}`) as {
    currentChainTvls?: Record<string, number>
  } | null
  if (!data?.currentChainTvls) return null
  return Object.values(data.currentChainTvls).reduce((sum, v) => sum + (v || 0), 0)
}

async function fetchCoinGeckoData(id: string): Promise<{ mcap: number; price: number; vol24h: number } | null> {
  const data = await fetchJson(
    `https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false`
  ) as { market_data?: { market_cap?: { usd?: number }; current_price?: { usd?: number }; total_volume?: { usd?: number } } } | null
  if (!data?.market_data) return null
  return {
    mcap: data.market_data.market_cap?.usd || 0,
    price: data.market_data.current_price?.usd || 0,
    vol24h: data.market_data.total_volume?.usd || 0,
  }
}

async function fetchBotMetrics(bot: BotConfig): Promise<BotMetrics> {
  const metrics: BotMetrics = {}

  if (bot.defillamaSlug) {
    if (bot.category === 'tg_bot') {
      const fees = await fetchDefiLlamaFees(bot.defillamaSlug)
      if (fees) {
        metrics.fees24h = fees.fees24h
        metrics.fees30d = fees.fees30d
      }
    } else if (bot.category === 'vault') {
      metrics.tvl = (await fetchDefiLlamaTvl(bot.defillamaSlug)) || undefined
    }
  }

  if (bot.coingeckoId) {
    const cg = await fetchCoinGeckoData(bot.coingeckoId)
    if (cg) {
      metrics.mcap = cg.mcap
      metrics.price = cg.price
      metrics.vol24h = cg.vol24h
    }
  }

  return metrics
}

// ── Scoring ──

function computeBotScore(metrics: BotMetrics, category: string, maxInCategory: number): number {
  if (maxInCategory <= 0) return 0

  let rawValue = 0
  switch (category) {
    case 'tg_bot':
      rawValue = metrics.fees30d || metrics.fees24h || 0
      break
    case 'vault':
      rawValue = metrics.tvl || 0
      break
    case 'ai_agent':
      rawValue = metrics.mcap || 0
      break
  }

  // Normalize to 0-100 score relative to category max
  const normalized = Math.min(rawValue / maxInCategory, 1)
  return Math.round(normalized * 100 * 10) / 10
}

// ── Main fetcher ──

async function fetchAllBots(
  supabase: SupabaseClient,
): Promise<{ total: number; saved: number; error?: string }> {
  const period = '90D' // Bots always use 90D (lifetime metrics)
  const allMetrics: Map<string, BotMetrics> = new Map()

  // Fetch metrics for all bots (with rate limiting)
  for (const bot of BOTS) {
    try {
      const metrics = await fetchBotMetrics(bot)
      allMetrics.set(bot.id, metrics)
    } catch (error) {
      logger.warn(`[web3_bot] Failed to fetch ${bot.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    await sleep(300) // Respect rate limits
  }

  // Calculate category maximums for normalization
  const categoryMaxes: Record<string, number> = { tg_bot: 0, vault: 0, ai_agent: 0 }
  for (const bot of BOTS) {
    const m = allMetrics.get(bot.id)
    if (!m) continue
    switch (bot.category) {
      case 'tg_bot':
        categoryMaxes.tg_bot = Math.max(categoryMaxes.tg_bot, m.fees30d || m.fees24h || 0)
        break
      case 'vault':
        categoryMaxes.vault = Math.max(categoryMaxes.vault, m.tvl || 0)
        break
      case 'ai_agent':
        categoryMaxes.ai_agent = Math.max(categoryMaxes.ai_agent, m.mcap || 0)
        break
    }
  }

  // Build trader records
  const traders: TraderData[] = []
  const sortedBots = [...BOTS].sort((a, b) => {
    const ma = allMetrics.get(a.id)
    const mb = allMetrics.get(b.id)
    const sa = ma ? computeBotScore(ma, a.category, categoryMaxes[a.category]) : 0
    const sb = mb ? computeBotScore(mb, b.category, categoryMaxes[b.category]) : 0
    return sb - sa
  })

  for (let i = 0; i < sortedBots.length; i++) {
    const bot = sortedBots[i]
    const metrics = allMetrics.get(bot.id)
    if (!metrics) continue

    const score = computeBotScore(metrics, bot.category, categoryMaxes[bot.category])
    const pnl = metrics.fees30d || metrics.tvl || metrics.mcap || 0

    traders.push({
      source: SOURCE,
      source_trader_id: bot.id,
      handle: bot.name,
      profile_url: bot.profileUrl,
      season_id: period,
      rank: i + 1,
      roi: score, // Score used as ROI proxy
      pnl,
      win_rate: null,
      max_drawdown: null,
      followers: null,
      arena_score: score,
      captured_at: new Date().toISOString(),
      avatar_url: null,
    })
  }

  if (traders.length > 0) {
    await upsertTraders(supabase, traders)
  }

  logger.info(`[web3_bot] Fetched ${traders.length} bots (TG:${BOTS.filter(b => b.category === 'tg_bot').length}, Vault:${BOTS.filter(b => b.category === 'vault').length}, AI:${BOTS.filter(b => b.category === 'ai_agent').length})`)

  return { total: BOTS.length, saved: traders.length }
}

export async function fetchWeb3Bot(
  supabase: SupabaseClient,
  _periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  try {
    // Web3 bots use lifetime metrics, stored under 90D
    const periodResult = await fetchAllBots(supabase)
    result.periods['90D'] = periodResult
  } catch (err) {
    logger.error(`[${SOURCE}] Fetch failed`, err instanceof Error ? err : new Error(String(err)))
    result.periods['90D'] = { total: 0, saved: 0, error: err instanceof Error ? err.message : String(err) }
  }

  result.duration = Date.now() - start
  return result
}
