/**
 * Backfill XT trader nicknames for traders with numeric-only handles.
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL

async function getServiceKey(): Promise<string> {
  const fs = await import('fs')
  const path = await import('path')
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
  const serviceKey = await getServiceKey()
  const supabase = createClient(SUPABASE_URL!, serviceKey)

  // Get numeric-handle XT traders (paginate since Supabase limits to 1000)
  const numericSet = new Map<string, string>()
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data: traders, error } = await supabase
      .from('trader_sources')
      .select('source_trader_id, handle')
      .eq('source', 'xt')
      .range(from, from + PAGE - 1)
    if (error) { console.error('DB error:', error); break }
    if (!traders || traders.length === 0) break
    for (const t of traders) {
      if (t.handle && /^\d+$/.test(t.handle)) {
        numericSet.set(t.source_trader_id, t.handle)
      }
    }
    if (traders.length < PAGE) break
    from += PAGE
  }
  console.log(`Found ${numericSet.size} XT traders with numeric handles`)

  const updates = new Map<string, { nickname: string; avatar?: string }>()
  const sortTypes = ['INCOME_RATE', 'FOLLOWER_COUNT', 'INCOME', 'FOLLOWER_PROFIT']
  const days = [7, 30, 90]

  for (const sortType of sortTypes) {
    for (const d of days) {
      console.log(`\nFetching sortType=${sortType} days=${d}...`)
      for (let page = 1; page <= 20; page++) {
        try {
          const url = `https://www.xt.com/fapi/user/v1/public/copy-trade/elite-leader-list-v2?sortType=${sortType}&days=${d}&page=${page}&pageSize=50`
          const resp = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
              Accept: 'application/json',
              Referer: 'https://www.xt.com/en/copy-trading/futures',
            },
          })

          if (!resp.ok) break

          const data = await resp.json()
          // Response: {result: [{sotType:"RECOMMEND",items:[]}, {sotType:"INCOME_RATE",items:[...]}]}
          const resultArr = data?.result || data?.data?.result || []
          let list: any[] = []
          if (Array.isArray(resultArr)) {
            for (const r of resultArr) {
              if (Array.isArray(r?.items) && r.items.length > 0) {
                list = r.items
                break
              }
            }
          }
          if (!list || list.length === 0) {
            // Try flat formats
            list = data?.data?.list || data?.data || []
          }
          if (!Array.isArray(list) || list.length === 0) break

          for (const t of list) {
            const id = String(t.accountId || t.id || '')
            if (!id) continue
            const nick = t.nickName || t.nickname || ''
            if (nick && !/^\d+$/.test(nick)) {
              updates.set(id, { nickname: nick, avatar: t.avatar || t.avatarUrl })
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
  }

  console.log(`\nTotal XT traders from API: ${updates.size}`)

  let updated = 0
  for (const [id, info] of updates) {
    if (!numericSet.has(id)) continue
    const updateData: Record<string, string | null> = { handle: info.nickname }
    if (info.avatar) updateData.avatar_url = info.avatar

    const { error } = await supabase
      .from('trader_sources')
      .update(updateData)
      .eq('source', 'xt')
      .eq('source_trader_id', id)

    if (!error) updated++
  }

  console.log(`\nUpdated ${updated} XT traders`)
}

main().catch(console.error)
