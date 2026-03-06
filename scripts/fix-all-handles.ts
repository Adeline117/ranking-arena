/**
 * Comprehensive handle fix script.
 * Fetches real nicknames from exchange leaderboard APIs and updates DB.
 * 
 * For XT: direct API works
 * For MEXC/CoinEx/KuCoin: need to run from VPS (geo-blocked)
 * 
 * Usage: npx tsx scripts/fix-all-handles.ts [--source xt|mexc|coinex|kucoin|bitget] [--dry-run]
 */
import { createClient } from '@supabase/supabase-js'
import pg from 'pg'
const { Client: PgClient } = pg

const DB_URL = '${process.env.DATABASE_URL}'
const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const SOURCE_FILTER = args[args.indexOf('--source') + 1] || null

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'

// =================== XT ===================
async function fetchXT(): Promise<Map<string, { nickname: string; avatar: string | null }>> {
  const traders = new Map<string, { nickname: string; avatar: string | null }>()
  
  for (const d of [7, 30, 90]) {
    let page = 1, noNew = 0
    while (noNew < 10 && page <= 200) {
      try {
        const url = `https://www.xt.com/fapi/user/v1/public/copy-trade/elite-leader-list-v2?sortType=INCOME_RATE&days=${d}&page=${page}&pageSize=50`
        const resp = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
        if (!resp.ok) break
        const json = await resp.json() as any
        const resultArr = json?.result || []
        let newCount = 0
        for (const r of resultArr) {
          for (const t of (r.items || [])) {
            const id = String(t.accountId)
            if (id && t.nickName && !traders.has(id)) {
              traders.set(id, { nickname: t.nickName, avatar: t.avatar || null })
              newCount++
            }
          }
        }
        if (newCount === 0) noNew++; else noNew = 0
        page++
      } catch { break }
      await sleep(300)
    }
    console.log(`  XT d=${d}: ${traders.size} unique traders`)
  }
  return traders
}

// =================== MEXC ===================
async function fetchMEXC(): Promise<Map<string, { nickname: string; avatar: string | null }>> {
  const traders = new Map<string, { nickname: string; avatar: string | null }>()
  
  // Try multiple MEXC API endpoints
  const endpoints = [
    'https://www.mexc.com/api/platform/copy-trade/trader/list',
    'https://www.mexc.com/api/platform/copy/v1/recommend/traders',
    'https://futures.mexc.com/api/v1/private/copy/user/recommend-traders',
  ]
  
  for (const sortType of ['ROI', 'PNL', 'FOLLOWERS', 'COPIER_NUM']) {
    for (const days of ['7', '30', '90']) {
      for (let page = 1; page <= 50; page++) {
        try {
          const params = new URLSearchParams({
            page: String(page), pageNum: String(page), pageSize: '20',
            sortBy: 'roi', sortType, days, periodDays: days, order: 'DESC',
          })
          
          let list: any[] = []
          for (const base of endpoints) {
            try {
              const resp = await fetch(`${base}?${params}`, {
                headers: { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://www.mexc.com', Referer: 'https://www.mexc.com/copy-trading' },
              })
              if (!resp.ok) continue
              const data = await resp.json() as any
              list = data?.data?.list || data?.data || []
              if (Array.isArray(list) && list.length > 0) break
            } catch { continue }
          }
          
          if (!Array.isArray(list) || list.length === 0) break
          
          let newCount = 0
          for (const t of list) {
            const id = String(t.traderId || t.uid || t.id || t.userId || '')
            const nick = t.nickName || t.nickname || t.name || t.displayName || ''
            if (id && nick && !/^\d+$/.test(nick)) {
              if (!traders.has(id)) newCount++
              traders.set(id, { nickname: nick, avatar: t.avatar || t.avatarUrl || null })
            }
          }
          
          if (newCount === 0 && page > 5) break
          if (page % 10 === 0) console.log(`  MEXC sort=${sortType} d=${days} p=${page}: ${traders.size} unique`)
          await sleep(1000)
        } catch { break }
      }
    }
  }
  return traders
}

// =================== CoinEx ===================
async function fetchCoinEx(): Promise<Map<string, { nickname: string; avatar: string | null }>> {
  const traders = new Map<string, { nickname: string; avatar: string | null }>()
  
  for (const sortBy of ['roi', 'pnl', 'follower']) {
    for (const period of ['7d', '30d', '90d']) {
      for (let page = 1; page <= 20; page++) {
        try {
          const url = `https://www.coinex.com/res/copy-trading/leaders?sort_by=${sortBy}&period=${period}&page=${page}&limit=50`
          const resp = await fetch(url, {
            headers: { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://www.coinex.com' },
          })
          if (!resp.ok) break
          const data = await resp.json() as any
          const list = data?.data?.list || data?.data || []
          if (!Array.isArray(list) || list.length === 0) break
          
          for (const t of list) {
            const id = String(t.trader_id || t.id || '')
            const nick = t.nick_name || t.nickname || ''
            if (id && nick) {
              traders.set(id, { nickname: nick, avatar: t.avatar || null })
            }
          }
          await sleep(500)
        } catch { break }
      }
    }
  }
  return traders
}

// =================== KuCoin ===================
async function fetchKuCoin(): Promise<Map<string, { nickname: string; avatar: string | null }>> {
  const traders = new Map<string, { nickname: string; avatar: string | null }>()
  
  for (const period of ['WEEK', 'MONTH', 'QUARTER']) {
    for (let page = 1; page <= 20; page++) {
      try {
        const url = `https://www.kucoin.com/_api/copy-trade/leader/ranking?period=${period}&page=${page}&pageSize=50&sortBy=ROI`
        const resp = await fetch(url, {
          headers: { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://www.kucoin.com' },
        })
        if (!resp.ok) break
        const data = await resp.json() as any
        const list = data?.data?.list || data?.data || []
        if (!Array.isArray(list) || list.length === 0) break
        
        for (const t of list) {
          const id = String(t.leaderId || t.id || '')
          const nick = t.nickName || t.nickname || ''
          if (id && nick) {
            traders.set(id, { nickname: nick, avatar: t.avatar || null })
          }
        }
        await sleep(500)
      } catch { break }
    }
  }
  return traders
}

// =================== Bitget ===================
async function fetchBitget(): Promise<Map<string, { nickname: string; avatar: string | null }>> {
  const traders = new Map<string, { nickname: string; avatar: string | null }>()
  
  for (const range of ['7D', '30D', '90D']) {
    for (let page = 1; page <= 20; page++) {
      try {
        const url = 'https://www.bitget.com/v1/trigger/trace/queryTraderList'
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Origin: 'https://www.bitget.com' },
          body: JSON.stringify({ pageNo: page, pageSize: 20, sortType: 'ROI', dateRange: range }),
        })
        if (!resp.ok) break
        const data = await resp.json() as any
        const list = data?.data?.list || data?.data || []
        if (!Array.isArray(list) || list.length === 0) break
        
        for (const t of list) {
          const id = String(t.traderId || t.id || '')
          const nick = t.nickName || t.traderName || ''
          if (id && nick && !nick.startsWith('@BGUSER-')) {
            traders.set(id, { nickname: nick, avatar: t.headUrl || null })
          }
        }
        await sleep(1000)
      } catch { break }
    }
  }
  return traders
}

// =================== Main ===================
async function main() {
  console.log(`🚀 Fix All Handles - ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)
  
  const db = new PgClient({ connectionString: DB_URL })
  await db.connect()
  
  const fetchers: Record<string, () => Promise<Map<string, { nickname: string; avatar: string | null }>>> = {
    xt: fetchXT,
    mexc: fetchMEXC,
    coinex: fetchCoinEx,
    kucoin: fetchKuCoin,
    bitget_futures: fetchBitget,
  }
  
  const sources = SOURCE_FILTER ? [SOURCE_FILTER] : Object.keys(fetchers)
  
  for (const source of sources) {
    const fetcher = fetchers[source]
    if (!fetcher) { console.log(`⚠️  No fetcher for ${source}`); continue }
    
    // Get bad handles from DB
    const { rows: badRows } = await db.query(
      `SELECT id, source_trader_id, handle FROM trader_sources WHERE source = $1`,
      [source]
    )
    
    const isBad = (h: string, sid: string) => {
      if (!h) return true
      if (h === sid) return true
      if (/^(XT|MEXC|CoinEx|Binance|KuCoin|BingX) Trader /i.test(h)) return true
      if (/^Mexctrader-/.test(h)) return true
      if (/^中台未注册/.test(h)) return true
      if (/^@BGUSER-/.test(h)) return true
      return false
    }
    
    const badTraders = badRows.filter(r => isBad(r.handle, r.source_trader_id))
    console.log(`\n📊 ${source}: ${badTraders.length}/${badRows.length} bad handles`)
    
    if (badTraders.length === 0) continue
    
    console.log(`🔄 Fetching from ${source} API...`)
    const apiData = await fetcher()
    console.log(`   Got ${apiData.size} traders from API`)
    
    let updated = 0, matched = 0
    for (const trader of badTraders) {
      const info = apiData.get(trader.source_trader_id)
      if (info) {
        matched++
        if (DRY_RUN) {
          if (matched <= 5) console.log(`   [DRY] ${trader.handle} → ${info.nickname}`)
          updated++
        } else {
          try {
            await db.query(
              `UPDATE trader_sources SET handle = $1, avatar_url = COALESCE($2, avatar_url) WHERE id = $3`,
              [info.nickname, info.avatar, trader.id]
            )
            updated++
            if (updated <= 5 || updated % 50 === 0) {
              console.log(`   ✅ [${updated}] ${trader.handle} → ${info.nickname}`)
            }
          } catch (e: any) {
            console.error(`   ❌ Update failed: ${e.message}`)
          }
        }
      }
    }
    
    console.log(`   Result: ${updated} updated, ${badTraders.length - matched} no API match`)
  }
  
  await db.end()
  console.log('\n✅ Done!')
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
