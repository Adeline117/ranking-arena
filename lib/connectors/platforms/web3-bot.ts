/**
 * Web3 Bot Connector
 *
 * Aggregates bot/vault/AI agent data from DeFi Llama and CoinGecko.
 * Not a traditional leaderboard — scores bots by category-relative performance.
 *
 * Sources:
 * - DeFi Llama fees API: https://api.llama.fi/summary/fees/{slug}
 * - DeFi Llama TVL API: https://api.llama.fi/protocol/{slug}
 * - CoinGecko: https://api.coingecko.com/api/v3/coins/{id}
 *
 * Categories:
 * - tg_bot: scored by 30D fees
 * - vault: scored by TVL
 * - ai_agent: scored by market cap
 */

import { BaseConnector } from '../base'
import type {
  LeaderboardPlatform,
  MarketType,
  Window,
  PlatformCapabilities,
  DiscoverResult,
  ProfileResult,
  SnapshotResult,
  TimeseriesResult,
  TraderSource,
} from '../../types/leaderboard'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('connector:web3-bot')

interface BotConfig {
  slug: string
  name: string
  category: 'tg_bot' | 'vault' | 'ai_agent'
  coingeckoId?: string
  llamaSlug?: string
}

const BOTS: BotConfig[] = [
  // Telegram Bots
  { slug: 'banana-gun', name: 'Banana Gun', category: 'tg_bot', llamaSlug: 'banana-gun', coingeckoId: 'banana-gun' },
  { slug: 'maestro', name: 'Maestro', category: 'tg_bot', llamaSlug: 'maestro' },
  { slug: 'unibot', name: 'Unibot', category: 'tg_bot', llamaSlug: 'unibot', coingeckoId: 'unibot' },
  { slug: 'bonkbot', name: 'BonkBot', category: 'tg_bot', llamaSlug: 'bonkbot' },
  { slug: 'sol-trading-bot', name: 'Sol Trading Bot', category: 'tg_bot', llamaSlug: 'sol-trading-bot' },
  { slug: 'trojan', name: 'Trojan', category: 'tg_bot', llamaSlug: 'trojan' },
  { slug: 'photon', name: 'Photon', category: 'tg_bot', llamaSlug: 'photon' },
  { slug: 'bloom', name: 'Bloom', category: 'tg_bot', llamaSlug: 'bloom' },
  // Vaults
  { slug: 'yearn-finance', name: 'Yearn Finance', category: 'vault', llamaSlug: 'yearn-finance', coingeckoId: 'yearn-finance' },
  { slug: 'beefy-finance', name: 'Beefy Finance', category: 'vault', llamaSlug: 'beefy-finance', coingeckoId: 'beefy-finance' },
  { slug: 'sommelier', name: 'Sommelier', category: 'vault', llamaSlug: 'sommelier', coingeckoId: 'sommelier' },
  { slug: 'enzyme-finance', name: 'Enzyme Finance', category: 'vault', llamaSlug: 'enzyme-finance', coingeckoId: 'enzyme-finance' },
  // AI Agents
  { slug: 'autonolas', name: 'Autonolas', category: 'ai_agent', coingeckoId: 'autonolas' },
  { slug: 'fetch-ai', name: 'Fetch.ai', category: 'ai_agent', coingeckoId: 'fetch-ai' },
  { slug: 'ocean-protocol', name: 'Ocean Protocol', category: 'ai_agent', coingeckoId: 'ocean-protocol' },
  { slug: 'singularitynet', name: 'SingularityNET', category: 'ai_agent', coingeckoId: 'singularitynet' },
  { slug: 'morpheus-ai', name: 'Morpheus', category: 'ai_agent', coingeckoId: 'morpheus-ai' },
]

export class Web3BotConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'web3_bot'
  readonly marketType: MarketType = 'web3'

  readonly capabilities: PlatformCapabilities = {
    platform: 'web3_bot',
    market_types: ['web3'],
    native_windows: ['90d'],
    available_fields: ['roi', 'pnl'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 1,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: [
      'Aggregates DeFi Llama + CoinGecko data',
      '17 bots: 8 TG bots, 4 vaults, 5 AI agents',
      'Score = category-relative normalized 0-100',
      'Always stored as 90D',
    ],
  }

  async discoverLeaderboard(
    _window: Window,
    limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    const results: Array<{ bot: BotConfig; value: number; raw: Record<string, unknown> }> = []

    for (const bot of BOTS) {
      try {
        let value = 0
        const raw: Record<string, unknown> = { slug: bot.slug, name: bot.name, category: bot.category }

        if (bot.category === 'tg_bot' && bot.llamaSlug) {
          // Score by 30D fees
          const fees = await this.request<{ total30d?: number }>(`https://api.llama.fi/summary/fees/${bot.llamaSlug}`)
          value = fees?.total30d || 0
          raw.fees30d = value
        } else if (bot.category === 'vault' && bot.llamaSlug) {
          // Score by TVL
          const protocol = await this.request<{ tvl?: Array<{ totalLiquidityUSD: number }> }>(`https://api.llama.fi/protocol/${bot.llamaSlug}`)
          const tvlArr = protocol?.tvl
          value = Array.isArray(tvlArr) && tvlArr.length > 0
            ? tvlArr[tvlArr.length - 1]?.totalLiquidityUSD || 0
            : 0
          raw.tvl = value
        } else if (bot.category === 'ai_agent' && bot.coingeckoId) {
          // Score by market cap
          const coin = await this.request<{ market_data?: { market_cap?: { usd?: number } } }>(`https://api.coingecko.com/api/v3/coins/${bot.coingeckoId}?localization=false&tickers=false&community_data=false&developer_data=false`)
          value = coin?.market_data?.market_cap?.usd || 0
          raw.mcap = value
        }

        results.push({ bot, value, raw })
        // CoinGecko free tier: ~10 req/min. DeFi Llama is more generous.
        const delay = bot.coingeckoId ? 2500 : 500
        await this.sleep(delay)
      } catch (err) {
        // Log but continue — don't silently drop bots
        log.warn(`Failed to fetch ${bot.name}`, { error: err instanceof Error ? err.message : 'unknown' })
      }
    }

    // Normalize scores within each category (0-100)
    const categories = ['tg_bot', 'vault', 'ai_agent'] as const
    for (const cat of categories) {
      const catResults = results.filter(r => r.bot.category === cat)
      const maxVal = Math.max(...catResults.map(r => r.value), 1)
      for (const r of catResults) {
        r.raw.score = (r.value / maxVal) * 100
      }
    }

    const traders: TraderSource[] = results
      .sort((a, b) => ((b.raw.score as number) || 0) - ((a.raw.score as number) || 0))
      .slice(0, limit)
      .map(r => ({
        platform: this.platform,
        market_type: this.marketType,
        trader_key: r.bot.slug,
        display_name: r.bot.name,
        profile_url: null,
        discovered_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        is_active: true,
        raw: r.raw,
      }))

    return {
      traders,
      total_available: results.length,
      window: '90d',
      fetched_at: new Date().toISOString(),
    }
  }

  async fetchTraderProfile(_traderKey: string): Promise<ProfileResult | null> {
    return null
  }

  async fetchTraderSnapshot(_traderKey: string, _window: Window): Promise<SnapshotResult | null> {
    return null
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  normalize(raw: unknown): Record<string, unknown> {
    const e = raw as Record<string, unknown>
    return {
      trader_key: e.slug || null,
      display_name: e.name || null,
      roi: e.score != null ? Number(e.score) : null,
      pnl: e.fees30d ?? e.tvl ?? e.mcap ?? null,
      win_rate: null,
      max_drawdown: null,
      followers: null,
      trades_count: null,
      sharpe_ratio: null,
      aum: e.tvl != null ? Number(e.tvl) : null,
      copiers: null,
      avatar_url: null,
      platform_rank: null,
    }
  }
}
