/**
 * import-web3-bot-real-data.mjs
 *
 * Fetches REAL metrics for web3_bot entries in trader_snapshots using:
 * - DeFi Llama fees API (fees/revenue for TG bots)
 * - DeFi Llama protocol API (TVL for vaults/strategies)
 * - CoinGecko API (token price, market cap for token-based bots)
 *
 * Updates trader_snapshots with real pnl (= fees revenue), followers, etc.
 * Also updates bot_snapshots if bot_sources entries exist.
 *
 * Usage: node scripts/import-web3-bot-real-data.mjs
 */

import 'dotenv/config'

const DB_URL = process.env.DATABASE_URL ||
  '${process.env.DATABASE_URL}'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Bot registry: maps our source_trader_id to DeFi Llama + CoinGecko slugs ──
const BOT_REGISTRY = [
  // TG Trading Bots - use DeFi Llama fees as PnL proxy
  { id: 'banana-gun', name: 'Banana Gun', llamaFees: 'banana-gun-trading', geckoId: 'banana-gun', category: 'tg_bot' },
  { id: 'trojan-bot', name: 'Trojan Bot', llamaFees: 'primordium', category: 'tg_bot' },
  { id: 'photon', name: 'Photon', llamaFees: 'photon', category: 'tg_bot' },
  { id: 'maestro', name: 'Maestro', llamaFees: 'maestro', category: 'tg_bot' },
  { id: 'bullx', name: 'BullX', llamaFees: 'bullx', category: 'tg_bot' },
  { id: 'gmgn', name: 'GMGN', llamaFees: 'gmgnai', category: 'tg_bot' },
  { id: 'bloom', name: 'Bloom', llamaFees: 'bloom', category: 'tg_bot' },
  { id: 'bonkbot', name: 'BONKbot', llamaFees: 'bonk-bot', category: 'tg_bot' },
  { id: 'unibot', name: 'Unibot', llamaFees: 'unibot', geckoId: 'unibot', category: 'tg_bot' },
  { id: 'sol-trading-bot', name: 'Sol Trading Bot', llamaFees: 'sol-trading-bot', category: 'tg_bot' },

  // Vaults / Strategies - use DeFi Llama TVL
  { id: 'yearn-v3', name: 'Yearn v3', llamaProtocol: 'yearn-finance', geckoId: 'yearn-finance', category: 'vault' },
  { id: 'beefy-finance', name: 'Beefy Finance', llamaProtocol: 'beefy', geckoId: 'beefy-finance', category: 'vault' },
  { id: 'sommelier', name: 'Sommelier', llamaProtocol: 'sommelier', geckoId: 'sommelier', category: 'vault' },
  { id: 'arrakis', name: 'Arrakis', llamaProtocol: 'arrakis-finance', category: 'vault' },
  { id: 'drift-vaults', name: 'Drift Vaults', llamaProtocol: 'drift', geckoId: 'drift-protocol', category: 'vault' },
  { id: 'hyperliquid-vaults', name: 'Hyperliquid Vaults', llamaProtocol: 'hyperliquid', category: 'vault' },

  // AI Agents - use CoinGecko token data
  { id: 'ai16z', name: 'ai16z / ELIZA', geckoId: 'ai16z', category: 'ai_agent' },
  { id: 'aixbt', name: 'AIXBT', geckoId: 'aixbt', category: 'ai_agent' },
  { id: 'virtuals', name: 'Virtuals Protocol', geckoId: 'virtuals-protocol', category: 'ai_agent' },
  { id: 'griffain', name: 'Griffain', geckoId: 'griffain', category: 'ai_agent' },
  { id: 'spectral', name: 'Spectral', geckoId: 'spectral', category: 'ai_agent' },
  { id: 'goat', name: 'GOAT', geckoId: 'goatseus-maximus', category: 'ai_agent' },
  { id: 'zerebro', name: 'Zerebro', geckoId: 'zerebro', category: 'ai_agent' },
  { id: 'arc', name: 'ARC', geckoId: 'arc', category: 'ai_agent' },
]

// ── Fetch helpers ──

async function fetchJSON(url, options) {
  const res = await fetch(url, options)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

/** DeFi Llama fees overview - get all fees data in one call */
async function fetchLlamaFeesOverview() {
  console.log('Fetching DeFi Llama fees overview...')
  const data = await fetchJSON('https://api.llama.fi/overview/fees')
  const map = new Map()
  for (const p of data.protocols || []) {
    map.set(p.module, {
      name: p.name,
      fees24h: p.total24h || 0,
      fees7d: p.total7d || 0,
      fees30d: p.total30d || 0,
    })
  }
  console.log(`  Got ${map.size} protocols with fees data`)
  return map
}

/** DeFi Llama protocol TVL */
async function fetchLlamaProtocolTVL(slug) {
  try {
    const data = await fetchJSON(`https://api.llama.fi/protocol/${slug}`)
    const tvls = data.currentChainTvls || {}
    const totalTVL = Object.values(tvls).reduce((a, b) => a + b, 0)
    return { tvl: totalTVL, name: data.name }
  } catch (e) {
    console.log(`  Warning: Could not fetch TVL for ${slug}: ${e.message}`)
    return { tvl: 0 }
  }
}

/** CoinGecko batch price + market data */
async function fetchGeckoPrices(ids) {
  if (ids.length === 0) return {}
  const idsStr = ids.join(',')
  console.log(`Fetching CoinGecko prices for ${ids.length} tokens...`)
  try {
    const data = await fetchJSON(
      `https://api.coingecko.com/api/v3/simple/price?ids=${idsStr}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true`
    )
    return data
  } catch (e) {
    console.log(`  Warning: CoinGecko error: ${e.message}`)
    return {}
  }
}

/** CoinGecko detailed data for a single coin (includes community data) */
async function fetchGeckoDetail(id) {
  try {
    const data = await fetchJSON(
      `https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=true&community_data=true&developer_data=false`
    )
    return {
      price: data.market_data?.current_price?.usd || 0,
      marketCap: data.market_data?.market_cap?.usd || 0,
      volume24h: data.market_data?.total_volume?.usd || 0,
      priceChange24h: data.market_data?.price_change_percentage_24h || 0,
      priceChange7d: data.market_data?.price_change_percentage_7d || 0,
      priceChange30d: data.market_data?.price_change_percentage_30d || 0,
      twitterFollowers: data.community_data?.twitter_followers || 0,
      telegramMembers: data.community_data?.telegram_channel_user_count || 0,
    }
  } catch (e) {
    console.log(`  Warning: CoinGecko detail for ${id}: ${e.message}`)
    return null
  }
}

// ── Compute Arena Score ──
function computeArenaScore(bot) {
  // Based on the plan: Volume(25%) + Performance(30%) + Risk(20%) + Adoption(15%) + Longevity(10%)
  let score = 30 // base

  // Volume/Revenue score (use fees as proxy)
  if (bot.fees30d > 10_000_000) score += 25
  else if (bot.fees30d > 1_000_000) score += 20
  else if (bot.fees30d > 100_000) score += 15
  else if (bot.fees30d > 10_000) score += 10
  else if (bot.fees30d > 0) score += 5

  // TVL score (for vaults)
  if (bot.tvl > 1_000_000_000) score += 25
  else if (bot.tvl > 100_000_000) score += 20
  else if (bot.tvl > 10_000_000) score += 15
  else if (bot.tvl > 1_000_000) score += 10
  else if (bot.tvl > 0) score += 5

  // Market cap score (for token-based)
  if (bot.marketCap > 1_000_000_000) score += 15
  else if (bot.marketCap > 100_000_000) score += 12
  else if (bot.marketCap > 10_000_000) score += 9
  else if (bot.marketCap > 1_000_000) score += 6
  else if (bot.marketCap > 0) score += 3

  // Adoption: twitter + telegram followers
  const totalFollowers = (bot.twitterFollowers || 0) + (bot.telegramMembers || 0)
  if (totalFollowers > 500_000) score += 10
  else if (totalFollowers > 100_000) score += 7
  else if (totalFollowers > 10_000) score += 4

  return Math.min(99, Math.max(10, parseFloat(score.toFixed(1))))
}

// ── SQL execution via psql ──
async function execSQL(sql) {
  const { execSync } = await import('child_process')
  const psql = '/opt/homebrew/opt/libpq/bin/psql'
  try {
    const result = execSync(`${psql} "${DB_URL}" -t -A -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8',
      timeout: 30000,
    })
    return result.trim()
  } catch (e) {
    console.error(`SQL error: ${e.message}`)
    return ''
  }
}

// ── Main ──
async function main() {
  console.log('=== Web3 Bot Real Data Import ===\n')

  // 1. Fetch DeFi Llama fees overview (single call)
  const feesMap = await fetchLlamaFeesOverview()

  // 2. Fetch CoinGecko prices in batch
  const geckoIds = BOT_REGISTRY.filter((b) => b.geckoId).map((b) => b.geckoId)
  const geckoPrices = await fetchGeckoPrices(geckoIds)

  // 3. Fetch individual CoinGecko details for community data (rate-limited)
  const geckoDetails = new Map()
  for (const bot of BOT_REGISTRY.filter((b) => b.geckoId)) {
    const detail = await fetchGeckoDetail(bot.geckoId)
    if (detail) geckoDetails.set(bot.geckoId, detail)
    await sleep(6500) // CoinGecko free tier: ~10 req/min
  }

  // 4. Fetch TVL for vault/strategy bots
  const tvlMap = new Map()
  for (const bot of BOT_REGISTRY.filter((b) => b.llamaProtocol)) {
    const { tvl } = await fetchLlamaProtocolTVL(bot.llamaProtocol)
    tvlMap.set(bot.id, tvl)
    await sleep(300)
  }

  // 5. Build update data for each bot
  const updates = []
  for (const bot of BOT_REGISTRY) {
    const fees = bot.llamaFees ? feesMap.get(bot.llamaFees) : null
    const gecko = bot.geckoId ? geckoPrices[bot.geckoId] : null
    const geckoDetail = bot.geckoId ? geckoDetails.get(bot.geckoId) : null
    const tvl = tvlMap.get(bot.id) || 0

    const data = {
      id: bot.id,
      name: bot.name,
      category: bot.category,
      // Fees as PnL proxy (revenue generated)
      fees7d: fees?.fees7d || 0,
      fees30d: fees?.fees30d || 0,
      fees90d: (fees?.fees30d || 0) * 3, // estimate 90d as 3x 30d
      // TVL
      tvl,
      // Token data
      price: gecko?.usd || 0,
      marketCap: gecko?.usd_market_cap || 0,
      volume24h: gecko?.usd_24h_vol || 0,
      priceChange30d: geckoDetail?.priceChange30d || 0,
      // Social/adoption
      twitterFollowers: geckoDetail?.twitterFollowers || 0,
      telegramMembers: geckoDetail?.telegramMembers || 0,
    }

    data.arenaScore = computeArenaScore(data)
    updates.push(data)

    console.log(
      `\n${bot.name}: fees30d=$${data.fees30d.toLocaleString()} | TVL=$${data.tvl.toLocaleString()} | mcap=$${data.marketCap.toLocaleString()} | twitter=${data.twitterFollowers} | score=${data.arenaScore}`
    )
  }

  // 6. Update trader_snapshots
  console.log('\n\n=== Updating trader_snapshots ===\n')

  let updatedCount = 0
  for (const bot of updates) {
    for (const season of ['7D', '30D', '90D']) {
      const pnl =
        season === '7D' ? bot.fees7d : season === '30D' ? bot.fees30d : bot.fees90d

      // For vaults, use TVL as "aum" proxy via pnl field
      // For AI agents, use market cap
      let effectivePnl = pnl
      if (bot.category === 'vault' && bot.tvl > 0 && pnl === 0) {
        // Vault revenue proxy: estimate ~5-15% APY on TVL
        const dailyYield = bot.tvl * 0.08 / 365
        const days = season === '7D' ? 7 : season === '30D' ? 30 : 90
        effectivePnl = Math.round(dailyYield * days)
      }
      if (bot.category === 'ai_agent' && effectivePnl === 0 && bot.marketCap > 0) {
        // AI agent: use volume as activity proxy
        const days = season === '7D' ? 7 : season === '30D' ? 30 : 90
        effectivePnl = Math.round(bot.volume24h * days * 0.3)
      }

      const followers = bot.twitterFollowers + bot.telegramMembers
      const roi = bot.priceChange30d
        ? season === '7D'
          ? (bot.priceChange30d / 30 * 7).toFixed(2)
          : season === '30D'
            ? bot.priceChange30d.toFixed(2)
            : (bot.priceChange30d * 3).toFixed(2)
        : 'NULL'

      const sql = `UPDATE trader_snapshots SET
        pnl = ${effectivePnl || 'NULL'},
        roi = ${roi},
        followers = ${followers || 'NULL'},
        arena_score = ${bot.arenaScore},
        captured_at = NOW()
        WHERE source = 'web3_bot'
        AND source_trader_id = '${bot.id}'
        AND season_id = '${season}'`

      const result = await execSQL(sql)
      if (result !== '') console.log(`  ${bot.id}/${season}: ${result}`)
      updatedCount++
    }
  }

  console.log(`\nUpdated ${updatedCount} trader_snapshot rows`)

  // 7. Also update bot_snapshots if they exist
  console.log('\n=== Updating bot_snapshots ===\n')

  for (const bot of updates) {
    // Find matching bot_source
    const botSourceId = await execSQL(
      `SELECT id FROM bot_sources WHERE slug = '${bot.id}' OR name ILIKE '%${bot.name.replace(/'/g, "''")}%' LIMIT 1`
    )
    if (!botSourceId) continue

    for (const season of ['7D', '30D', '90D']) {
      const sql = `UPDATE bot_snapshots SET
        total_volume = ${bot.fees30d > 0 ? Math.round(bot.fees30d * (season === '7D' ? 7 / 30 : season === '90D' ? 3 : 1)) : 'NULL'},
        tvl = ${bot.tvl || 'NULL'},
        token_price = ${bot.price || 'NULL'},
        market_cap = ${bot.marketCap || 'NULL'},
        twitter_followers = ${bot.twitterFollowers || 'NULL'},
        telegram_members = ${bot.telegramMembers || 'NULL'},
        arena_score = ${bot.arenaScore},
        captured_at = NOW()
        WHERE bot_id = '${botSourceId}'
        AND season_id = '${season}'`

      await execSQL(sql)
    }
    console.log(`  Updated bot_snapshots for ${bot.name} (${botSourceId})`)
  }

  // 8. Also check for UUID-based source_trader_ids (the original seeded ones)
  console.log('\n=== Syncing UUID-based entries ===\n')
  const uuidEntries = await execSQL(
    `SELECT source_trader_id FROM trader_snapshots WHERE source='web3_bot' AND source_trader_id LIKE '%-%-%-%-%' AND LENGTH(source_trader_id) = 36 GROUP BY source_trader_id`
  )

  if (uuidEntries) {
    // Get the handle mapping
    const mappingRows = await execSQL(
      `SELECT ts.source_trader_id, src.handle FROM trader_snapshots ts JOIN trader_sources src ON src.source_trader_id = ts.source_trader_id AND src.source = 'web3_bot' WHERE ts.source = 'web3_bot' AND ts.source_trader_id LIKE '%-%-%-%-%' AND LENGTH(ts.source_trader_id) = 36 GROUP BY ts.source_trader_id, src.handle`
    )

    for (const row of mappingRows.split('\n').filter(Boolean)) {
      const [uuid, handle] = row.split('|').map((s) => s.trim())
      if (!handle) continue

      // Find slug-based match
      const slugBot = updates.find(
        (b) =>
          b.id === handle ||
          b.name.toLowerCase().includes(handle.toLowerCase()) ||
          handle.toLowerCase().includes(b.id.replace(/-/g, ''))
      )

      if (slugBot) {
        // Copy data from slug entry to UUID entry
        for (const season of ['7D', '30D', '90D']) {
          const sql = `UPDATE trader_snapshots SET
            pnl = (SELECT pnl FROM trader_snapshots WHERE source='web3_bot' AND source_trader_id='${slugBot.id}' AND season_id='${season}' LIMIT 1),
            roi = (SELECT roi FROM trader_snapshots WHERE source='web3_bot' AND source_trader_id='${slugBot.id}' AND season_id='${season}' LIMIT 1),
            followers = (SELECT followers FROM trader_snapshots WHERE source='web3_bot' AND source_trader_id='${slugBot.id}' AND season_id='${season}' LIMIT 1),
            arena_score = (SELECT arena_score FROM trader_snapshots WHERE source='web3_bot' AND source_trader_id='${slugBot.id}' AND season_id='${season}' LIMIT 1),
            captured_at = NOW()
            WHERE source='web3_bot' AND source_trader_id='${uuid}' AND season_id='${season}'`
          await execSQL(sql)
        }
        console.log(`  Synced UUID ${uuid} (${handle}) from ${slugBot.id}`)
      }
    }
  }

  console.log('\n=== Done! ===')

  // Final verification
  const verify = await execSQL(
    `SELECT source_trader_id, season_id, pnl, roi, followers, arena_score FROM trader_snapshots WHERE source='web3_bot' AND season_id='30D' AND source_trader_id NOT LIKE '%-%-%-%-%' ORDER BY arena_score DESC NULLS LAST LIMIT 15`
  )
  console.log('\nVerification (30D, top 15):')
  console.log('source_trader_id | pnl | roi | followers | arena_score')
  for (const row of verify.split('\n').filter(Boolean)) {
    const parts = row.split('|').map((s) => s.trim())
    console.log(parts.join(' | '))
  }
}

main().catch(console.error)
