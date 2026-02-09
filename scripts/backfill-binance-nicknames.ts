/**
 * Backfill Binance Futures trader nicknames for traders with numeric-only handles.
 * Uses undici ProxyAgent to bypass geo-blocking.
 */
import { createClient } from '@supabase/supabase-js'
import { ProxyAgent } from 'undici'
import * as fs from 'fs'
import * as path from 'path'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const PROXY = 'http://127.0.0.1:7890'
const API_URL = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list'

const HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Origin: 'https://www.binance.com',
  Referer: 'https://www.binance.com/en/copy-trading',
}

function getServiceKey(): string {
  for (const f of ['.env.local', '.env']) {
    const p = path.join(process.cwd(), f)
    if (fs.existsSync(p)) {
      const match = fs.readFileSync(p, 'utf8').match(/SUPABASE_SERVICE_ROLE_KEY="?([^"\s]+)"?/)
      if (match) return match[1].trim()
    }
  }
  throw new Error('No SUPABASE_SERVICE_ROLE_KEY found')
}

async function main() {
  const serviceKey = getServiceKey()
  const supabase = createClient(SUPABASE_URL, serviceKey)
  const agent = new ProxyAgent(PROXY)

  // Fetch all binance_futures traders with numeric handles
  const { data: allTraders, error } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', 'binance_futures')

  if (error) { console.error('DB error:', error); process.exit(1) }

  const numericSet = new Set<string>()
  for (const t of allTraders || []) {
    if (t.handle && /^\d+$/.test(t.handle)) {
      numericSet.add(t.source_trader_id)
    }
  }
  console.log(`Found ${numericSet.size} traders with numeric handles`)

  const updates = new Map<string, { nickname: string; avatar?: string }>()
  const periods = ['7D', '30D', '90D']

  for (const period of periods) {
    console.log(`\nFetching period ${period}...`)
    for (let page = 1; page <= 15; page++) {
      try {
        const resp = await fetch(API_URL, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({
            pageNumber: page,
            pageSize: 20,
            timeRange: period,
            dataType: 'ROI',
            order: 'DESC',
            favoriteOnly: false,
          }),
          // @ts-ignore
          dispatcher: agent,
        })

        if (!resp.ok) { console.log(`  Page ${page}: HTTP ${resp.status}`); break }

        const data = await resp.json() as any
        const list = data?.data?.list || []
        if (list.length === 0) break

        for (const t of list) {
          const id = t.leadPortfolioId || t.portfolioId || ''
          if (!id) continue
          const nick = t.nickname || t.nickName || ''
          if (nick && !/^\d+$/.test(nick)) {
            updates.set(id, { nickname: nick, avatar: t.avatarUrl || t.userPhotoUrl })
          }
        }

        console.log(`  Page ${page}: ${list.length} traders (total unique: ${updates.size})`)
        await new Promise(r => setTimeout(r, 500))
      } catch (e) {
        console.error(`  Page ${page} error:`, e)
        break
      }
    }
  }

  console.log(`\nTotal traders from API: ${updates.size}`)
  console.log(`Matching numeric handles: ${[...updates.keys()].filter(k => numericSet.has(k)).length}`)

  let updated = 0
  for (const [id, info] of updates) {
    if (!numericSet.has(id)) continue

    const updateData: Record<string, string | null> = { handle: info.nickname }
    if (info.avatar) updateData.avatar_url = info.avatar

    const { error } = await supabase
      .from('trader_sources')
      .update(updateData)
      .eq('source', 'binance_futures')
      .eq('source_trader_id', id)

    if (!error) updated++
    else console.error(`  Update error for ${id}:`, error)
  }

  console.log(`\nUpdated ${updated} Binance Futures traders`)
}

main().catch(console.error)
