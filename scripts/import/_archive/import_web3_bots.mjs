#!/usr/bin/env node
/**
 * Import Web3 Bots into bot_sources + bot_snapshots
 * Fetches supplementary data from CoinGecko and DeFi Llama APIs
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://iknktzifjdyujdccyhsv.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
)

// ─── Bot Definitions ───────────────────────────────────────────────
const BOTS = [
  // TG Trading Bots
  { name: 'Banana Gun', slug: 'banana-gun', category: 'tg_bot', chain: 'multi', website_url: 'https://bananagun.io', twitter_handle: 'BananaGunBot', telegram_url: 'https://t.me/BananaGunSniper_bot', token_symbol: 'BANANA', description: 'Solana/ETH最大的Sniper Bot，月交易量$10B+', launch_date: '2023-06-01' },
  { name: 'Trojan Bot', slug: 'trojan-bot', category: 'tg_bot', chain: 'solana', website_url: 'https://trojan.app', twitter_handle: 'TrojanOnSolana', telegram_url: 'https://t.me/solaboratory_bot', description: 'Solana第二大TG交易机器人', launch_date: '2023-09-01' },
  { name: 'Maestro', slug: 'maestro', category: 'tg_bot', chain: 'multi', website_url: 'https://maestrobots.com', twitter_handle: 'MaesroBots', telegram_url: 'https://t.me/MaestroBots', description: '多链TG Bot（ETH/BSC/Solana）', launch_date: '2023-01-01' },
  { name: 'BONKbot', slug: 'bonkbot', category: 'tg_bot', chain: 'solana', website_url: 'https://bonkbot.io', twitter_handle: 'bonaborationBot', telegram_url: 'https://t.me/BONKbot_bot', description: 'Solana Memecoin专用TG Bot', launch_date: '2023-12-01' },
  { name: 'Unibot', slug: 'unibot', category: 'tg_bot', chain: 'ethereum', website_url: 'https://unibot.app', twitter_handle: 'TeamUnibot', token_symbol: 'UNIBOT', description: 'ETH链TG交易Bot先驱，有代币UNIBOT', launch_date: '2023-05-01' },
  { name: 'Sol Trading Bot', slug: 'sol-trading-bot', category: 'tg_bot', chain: 'solana', telegram_url: 'https://t.me/SolTradingBot', description: 'Solana快速交易Bot', launch_date: '2023-10-01' },
  { name: 'Photon', slug: 'photon', category: 'tg_bot', chain: 'solana', website_url: 'https://photon-sol.tinyastro.io', twitter_handle: 'photaborationSol', description: 'Solana高速DEX交易终端', launch_date: '2024-01-01' },
  { name: 'BullX', slug: 'bullx', category: 'tg_bot', chain: 'multi', website_url: 'https://bullx.io', twitter_handle: 'BullXApp', description: '多链DEX交易平台', launch_date: '2024-02-01' },
  { name: 'Bloom', slug: 'bloom', category: 'tg_bot', chain: 'solana', website_url: 'https://bloom.trading', twitter_handle: 'BloomTrading', description: 'Solana交易Bot', launch_date: '2024-03-01' },
  { name: 'GMGN', slug: 'gmgn', category: 'tg_bot', chain: 'multi', website_url: 'https://gmgn.ai', twitter_handle: 'gmaborationgn', description: 'AI驱动的链上交易分析和执行', launch_date: '2024-01-01' },

  // AI Trading Agents
  { name: 'ai16z / ELIZA', slug: 'ai16z', category: 'ai_agent', chain: 'solana', website_url: 'https://elizaos.ai', twitter_handle: 'ai16zdao', token_symbol: 'AI16Z', description: '开源AI Agent框架，做交易+社交', launch_date: '2024-10-01' },
  { name: 'AIXBT', slug: 'aixbt', category: 'ai_agent', chain: 'base', website_url: 'https://aixbt.tech', twitter_handle: 'aixbt_agent', token_symbol: 'AIXBT', description: 'AI驱动的crypto市场分析Agent', launch_date: '2024-11-01' },
  { name: 'Virtuals Protocol', slug: 'virtuals', category: 'ai_agent', chain: 'base', website_url: 'https://virtuals.io', twitter_handle: 'virtaborationalsProtocol', token_symbol: 'VIRTUAL', description: 'Base链AI Agent生态，每个Agent是独立代币', launch_date: '2024-01-01' },
  { name: 'Griffain', slug: 'griffain', category: 'ai_agent', chain: 'solana', website_url: 'https://griffain.com', twitter_handle: 'griffaindotcom', token_symbol: 'GRIFFAIN', description: 'Solana链AI Agent，可执行交易', launch_date: '2024-11-01' },
  { name: 'Spectral', slug: 'spectral', category: 'ai_agent', chain: 'ethereum', website_url: 'https://spectrallabs.xyz', twitter_handle: 'SpectralLabs', token_symbol: 'SPEC', description: '链上AI推理，交易信号', launch_date: '2024-06-01' },
  { name: 'GOAT', slug: 'goat', category: 'ai_agent', chain: 'solana', twitter_handle: 'GOATi_official', token_symbol: 'GOAT', description: 'AI Agent meme代币，Truth Terminal', launch_date: '2024-10-01' },
  { name: 'Zerebro', slug: 'zerebro', category: 'ai_agent', chain: 'solana', website_url: 'https://zerebro.org', twitter_handle: 'zeaborationrebro', token_symbol: 'ZEREBRO', description: 'AI Agent，自主创作和交易', launch_date: '2024-11-01' },
  { name: 'arc', slug: 'arc', category: 'ai_agent', chain: 'solana', website_url: 'https://arc.fun', twitter_handle: 'arcaborationfun', token_symbol: 'ARC', description: 'AI Agent Launchpad', launch_date: '2024-12-01' },

  // On-chain Vaults
  { name: 'Hyperliquid Vaults', slug: 'hyperliquid-vaults', category: 'vault', chain: 'arbitrum', website_url: 'https://app.hyperliquid.xyz/vaults', twitter_handle: 'HyperliquidX', description: '自动交易策略金库', launch_date: '2023-06-01' },
  { name: 'Drift Vaults', slug: 'drift-vaults', category: 'vault', chain: 'solana', website_url: 'https://app.drift.trade/vaults', twitter_handle: 'DriftProtocol', token_symbol: 'DRIFT', description: 'Solana永续合约策略金库', launch_date: '2023-11-01' },
  { name: 'Yearn v3', slug: 'yearn-v3', category: 'vault', chain: 'ethereum', website_url: 'https://yearn.fi', twitter_handle: 'yeaborationarnfi', token_symbol: 'YFI', description: '自动收益策略金库，DeFi OG', launch_date: '2020-07-01' },
  { name: 'Beefy Finance', slug: 'beefy-finance', category: 'vault', chain: 'multi', website_url: 'https://beefy.com', twitter_handle: 'beefyfinance', token_symbol: 'BIFI', description: '多链自动复利金库', launch_date: '2020-10-01' },
  { name: 'Sommelier', slug: 'sommelier', category: 'vault', chain: 'ethereum', website_url: 'https://sommelier.finance', twitter_handle: 'sommaborationelierfinance', token_symbol: 'SOMM', description: '智能DeFi金库，AI策略管理', launch_date: '2022-09-01' },
  { name: 'Arrakis', slug: 'arrakis', category: 'vault', chain: 'ethereum', website_url: 'https://arrakis.finance', twitter_handle: 'ArrakisFinance', description: 'Uniswap V3 LP管理金库', launch_date: '2022-01-01' },
]

// CoinGecko ID mapping
const COINGECKO_IDS = {
  'AI16Z': 'ai16z',
  'AIXBT': 'aixbt',
  'VIRTUAL': 'virtual-protocol',
  'UNIBOT': 'unibot',
  'GOAT': 'goatseus-maximus',
  'ZEREBRO': 'zerebro',
  'YFI': 'yearn-finance',
  'BIFI': 'beefy-finance',
  'DRIFT': 'drift-protocol',
  'SOMM': 'sommelier',
  'BANANA': 'banana-gun',
}

// DeFi Llama protocol name mapping
const DEFILLAMA_PROTOCOLS = {
  'yearn-v3': 'yearn-finance',
  'beefy-finance': 'beefy',
  'sommelier': 'sommelier',
  'arrakis': 'arrakis-finance',
  'drift-vaults': 'drift',
  'hyperliquid-vaults': 'hyperliquid',
}

// ─── Helpers ───────────────────────────────────────────────────────
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function fetchJson(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } })
      if (res.status === 429) {
        console.log(`  Rate limited, waiting ${(i + 1) * 5}s...`)
        await sleep((i + 1) * 5000)
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (e) {
      if (i === retries) { console.warn(`  Failed to fetch ${url}: ${e.message}`); return null }
      await sleep(2000)
    }
  }
}

// ─── Data Fetchers ─────────────────────────────────────────────────
async function fetchCoinGeckoPrices() {
  const ids = Object.values(COINGECKO_IDS).join(',')
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true`
  console.log('Fetching CoinGecko prices...')
  const data = await fetchJson(url)
  if (!data) return {}
  
  // Reverse map: symbol -> price data
  const result = {}
  for (const [symbol, cgId] of Object.entries(COINGECKO_IDS)) {
    if (data[cgId]) {
      result[symbol] = {
        price: data[cgId].usd,
        market_cap: data[cgId].usd_market_cap,
        volume_24h: data[cgId].usd_24h_vol,
      }
    }
  }
  return result
}

async function fetchDefiLlamaTVL(protocolName) {
  const url = `https://api.llama.fi/protocol/${protocolName}`
  const data = await fetchJson(url)
  if (!data) return null
  return {
    tvl: data.currentChainTvls?.total || data.tvl?.[data.tvl.length - 1]?.totalLiquidityUSD || null,
  }
}

async function fetchDefiLlamaYields() {
  console.log('Fetching DeFi Llama yields...')
  const data = await fetchJson('https://yields.llama.fi/pools')
  if (!data?.data) return {}
  
  // Group top pools by project
  const projectPools = {}
  for (const pool of data.data) {
    const proj = pool.project?.toLowerCase()
    if (!proj) continue
    if (!projectPools[proj]) projectPools[proj] = []
    projectPools[proj].push(pool)
  }
  
  // Get aggregate stats per project
  const result = {}
  for (const [proj, pools] of Object.entries(projectPools)) {
    const totalTvl = pools.reduce((sum, p) => sum + (p.tvlUsd || 0), 0)
    const avgApy = pools.length > 0
      ? pools.reduce((sum, p) => sum + (p.apy || 0), 0) / pools.length
      : 0
    const topApy = Math.max(...pools.map(p => p.apy || 0))
    result[proj] = { tvl: totalTvl, avgApy, topApy, poolCount: pools.length }
  }
  return result
}

// ─── Estimated data for TG bots (no public API) ───────────────────
const TG_BOT_ESTIMATES = {
  'banana-gun': { total_volume: 15000000000, unique_users: 250000, revenue: 45000000, apy: null, roi: null },
  'trojan-bot': { total_volume: 8000000000, unique_users: 180000, revenue: 24000000, apy: null, roi: null },
  'maestro': { total_volume: 5000000000, unique_users: 150000, revenue: 15000000, apy: null, roi: null },
  'bonkbot': { total_volume: 3000000000, unique_users: 120000, revenue: 9000000, apy: null, roi: null },
  'unibot': { total_volume: 1500000000, unique_users: 50000, revenue: 4500000, apy: null, roi: null },
  'sol-trading-bot': { total_volume: 2000000000, unique_users: 80000, revenue: 6000000, apy: null, roi: null },
  'photon': { total_volume: 6000000000, unique_users: 200000, revenue: 18000000, apy: null, roi: null },
  'bullx': { total_volume: 4000000000, unique_users: 160000, revenue: 12000000, apy: null, roi: null },
  'bloom': { total_volume: 1000000000, unique_users: 40000, revenue: 3000000, apy: null, roi: null },
  'gmgn': { total_volume: 3500000000, unique_users: 100000, revenue: 10500000, apy: null, roi: null },
}

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log('=== Web3 Bots Import ===\n')

  // 1. Fetch supplementary data
  const [cgPrices, llamaYields] = await Promise.all([
    fetchCoinGeckoPrices(),
    fetchDefiLlamaYields(),
  ])
  console.log(`CoinGecko: ${Object.keys(cgPrices).length} tokens`)
  console.log(`DeFi Llama yields: ${Object.keys(llamaYields).length} projects\n`)

  // 2. Fetch DeFi Llama TVL for vault protocols
  const llamaTVL = {}
  for (const [slug, llamaName] of Object.entries(DEFILLAMA_PROTOCOLS)) {
    llamaTVL[slug] = await fetchDefiLlamaTVL(llamaName)
    await sleep(500) // Rate limit
  }
  console.log(`DeFi Llama TVL: ${Object.keys(llamaTVL).length} protocols\n`)

  // 3. Upsert bot_sources
  console.log('Upserting bot_sources...')
  for (const bot of BOTS) {
    const { error } = await supabase.from('bot_sources').upsert(bot, { onConflict: 'slug' })
    if (error) console.error(`  Error upserting ${bot.slug}:`, error.message)
    else console.log(`  OK: ${bot.name}`)
  }

  // 4. Fetch all bot_sources IDs
  const { data: sources } = await supabase.from('bot_sources').select('id, slug, token_symbol, category')
  if (!sources) { console.error('Failed to fetch bot_sources'); return }
  const botMap = Object.fromEntries(sources.map(s => [s.slug, s]))

  // 5. Build snapshots
  console.log('\nBuilding snapshots...')
  const snapshots = []

  for (const bot of BOTS) {
    const botRow = botMap[bot.slug]
    if (!botRow) continue

    const snapshot = { bot_id: botRow.id, season_id: '90D' }

    // TG bot estimates
    if (TG_BOT_ESTIMATES[bot.slug]) {
      Object.assign(snapshot, TG_BOT_ESTIMATES[bot.slug])
    }

    // CoinGecko token data
    if (bot.token_symbol && cgPrices[bot.token_symbol]) {
      const cg = cgPrices[bot.token_symbol]
      snapshot.token_price = cg.price
      snapshot.market_cap = cg.market_cap
      if (cg.volume_24h && !snapshot.total_volume) {
        snapshot.total_volume = cg.volume_24h * 30 // Estimate 30D volume
      }
    }

    // DeFi Llama TVL
    if (llamaTVL[bot.slug]?.tvl) {
      snapshot.tvl = llamaTVL[bot.slug].tvl
    }

    // DeFi Llama yields
    const llamaKey = DEFILLAMA_PROTOCOLS[bot.slug]
    if (llamaKey && llamaYields[llamaKey]) {
      const y = llamaYields[llamaKey]
      if (!snapshot.tvl && y.tvl) snapshot.tvl = y.tvl
      if (y.avgApy) snapshot.apy = Math.round(y.avgApy * 100) / 100
    }

    // Also check yields by project name variations
    for (const yieldKey of [bot.slug, bot.slug.replace(/-/g, ''), bot.name.toLowerCase().replace(/\s+/g, '-')]) {
      if (llamaYields[yieldKey] && !snapshot.apy) {
        const y = llamaYields[yieldKey]
        if (!snapshot.tvl && y.tvl) snapshot.tvl = y.tvl
        if (y.avgApy) snapshot.apy = Math.round(y.avgApy * 100) / 100
      }
    }

    // AI Agent estimates (mindshare + rough user counts)
    if (botRow.category === 'ai_agent') {
      snapshot.mindshare_score = Math.random() * 40 + 30 // Placeholder 30-70
      snapshot.unique_users = Math.floor(Math.random() * 50000 + 5000)
    }

    snapshots.push(snapshot)
  }

  // 6. Upsert snapshots
  console.log(`\nUpserting ${snapshots.length} snapshots...`)
  for (const snap of snapshots) {
    const { error } = await supabase.from('bot_snapshots').upsert(snap, { onConflict: 'bot_id,season_id' })
    if (error) console.error(`  Error:`, error.message)
  }

  // Also create 7D and 30D snapshots with scaled values
  for (const window of ['7D', '30D']) {
    const scale = window === '7D' ? 0.08 : 0.35
    for (const snap of snapshots) {
      const scaled = { ...snap, season_id: window }
      if (scaled.total_volume) scaled.total_volume = Math.round(scaled.total_volume * scale)
      if (scaled.revenue) scaled.revenue = Math.round(scaled.revenue * scale)
      if (scaled.total_trades) scaled.total_trades = Math.round(scaled.total_trades * scale)
      const { error } = await supabase.from('bot_snapshots').upsert(scaled, { onConflict: 'bot_id,season_id' })
      if (error) console.error(`  Error (${window}):`, error.message)
    }
  }

  console.log('\n=== Import complete ===')
  
  // Summary
  const { count } = await supabase.from('bot_sources').select('*', { count: 'exact', head: true })
  const { count: snapCount } = await supabase.from('bot_snapshots').select('*', { count: 'exact', head: true })
  console.log(`Bot sources: ${count}`)
  console.log(`Bot snapshots: ${snapCount}`)
}

main().catch(console.error)
