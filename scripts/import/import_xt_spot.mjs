#!/usr/bin/env node
/**
 * Import XT.com spot copy-trading leaders into trader_sources_v2
 * API: /sapi/v4/account/public/copy-trade/leader-list-v2
 */
import pg from 'pg'

const DB_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
const BASE_URL = 'https://www.xt.com/sapi/v4/account/public/copy-trade/leader-list-v2'
const PROXY = 'http://127.0.0.1:7890'

// Use undici ProxyAgent for fetch through proxy
import { ProxyAgent } from 'undici'
const proxyAgent = new ProxyAgent(PROXY)

async function fetchPage(page = 1, limit = 50, sortType = 'INCOME_RATE', days = 90) {
  const params = new URLSearchParams({
    sortType,
    days: String(days),
    sortDirection: 'DESC',
    limit: String(limit),
    offset: String((page - 1) * limit),
    canFollow: 'false',
    nickName: '',
    elite: 'false',
  })
  
  const url = `${BASE_URL}?${params}`
  console.log(`Fetching: ${url}`)
  
  const resp = await fetch(url, {
    dispatcher: proxyAgent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.xt.com/en/copy-trading/spot',
    },
  })
  
  const data = await resp.json()
  if (data.rc !== 0 && data.returnCode !== 0) {
    throw new Error(`API error: ${JSON.stringify(data)}`)
  }
  
  return data.result || data
}

async function fetchAllTraders() {
  const allTraders = []
  const seen = new Set()
  
  // Try different sort types to get more traders
  const sortTypes = ['INCOME_RATE', 'INCOME', 'FOLLOWER_COUNT']
  
  for (const sortType of sortTypes) {
    let page = 1
    let hasMore = true
    
    while (hasMore && page <= 20) {
      try {
        const result = await fetchPage(page, 50, sortType, 90)
        const items = result.items || result
        
        if (!Array.isArray(items) || items.length === 0) {
          hasMore = false
          break
        }
        
        for (const item of items) {
          const key = item.accountId || item.aid
          if (!seen.has(key)) {
            seen.add(key)
            allTraders.push(item)
          }
        }
        
        console.log(`  Sort=${sortType} Page ${page}: ${items.length} items (total unique: ${allTraders.length})`)
        
        if (items.length < 50) hasMore = false
        page++
        
        // Rate limit
        await new Promise(r => setTimeout(r, 500))
      } catch (e) {
        console.error(`Error on page ${page}:`, e.message)
        hasMore = false
      }
    }
  }
  
  return allTraders
}

async function importToDB(traders) {
  const client = new pg.Client(DB_URL)
  await client.connect()
  
  let inserted = 0, updated = 0
  
  for (const t of traders) {
    const traderKey = t.accountId || String(t.aid)
    const displayName = t.nickName || 'Unknown'
    const profileUrl = `https://www.xt.com/en/copy-trading/spot/detail/${traderKey}`
    const raw = {
      accountId: t.accountId,
      aid: t.aid,
      avatar: t.avatar,
      level: t.level,
      levelName: t.levelName,
      days: t.days,
      income: t.income,
      winRate: t.winRate,
      incomeRate: t.incomeRate,
      followerCount: t.followerCount,
      maxFollowerSize: t.maxFollowerSize,
      followerProfit: t.followerProfit,
      followerMargin: t.followerMargin,
      maxRetraction: t.maxRetraction,
      tradeDays: t.tradeDays,
      displayEquity: t.displayEquity,
    }
    
    try {
      const res = await client.query(
        `INSERT INTO trader_sources_v2 (platform, market_type, trader_key, display_name, profile_url, raw, discovered_at, last_seen_at, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), true)
         ON CONFLICT (platform, market_type, trader_key)
         DO UPDATE SET display_name = $4, profile_url = $5, raw = $6, last_seen_at = NOW(), is_active = true
         RETURNING (xmax = 0) AS is_new`,
        ['xt', 'spot', traderKey, displayName, profileUrl, JSON.stringify(raw)]
      )
      
      if (res.rows[0]?.is_new) inserted++
      else updated++
    } catch (e) {
      console.error(`Error inserting ${displayName}:`, e.message)
    }
  }
  
  await client.end()
  return { inserted, updated }
}

async function main() {
  console.log('=== XT Spot Copy Trading Import ===\n')
  
  const traders = await fetchAllTraders()
  console.log(`\nTotal unique traders found: ${traders.length}`)
  
  if (traders.length === 0) {
    console.log('No traders found, exiting')
    return
  }
  
  // Sample
  console.log('\nSample traders:')
  for (const t of traders.slice(0, 5)) {
    console.log(`  ${t.nickName}: ROI=${(parseFloat(t.incomeRate) * 100).toFixed(2)}%, WinRate=${(parseFloat(t.winRate) * 100).toFixed(1)}%, Followers=${t.followerCount}/${t.maxFollowerSize}`)
  }
  
  console.log('\nImporting to DB...')
  const { inserted, updated } = await importToDB(traders)
  console.log(`Done! Inserted: ${inserted}, Updated: ${updated}`)
}

main().catch(console.error)
