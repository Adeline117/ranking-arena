/**
 * Backfill MEXC trader nicknames for traders with numeric-only handles.
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

  const { data: traders } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', 'mexc')

  const numericSet = new Map<string, string>()
  for (const t of traders || []) {
    if (t.handle && /^\d+$/.test(t.handle)) {
      numericSet.set(t.source_trader_id, t.handle)
    }
  }
  console.log(`Found ${numericSet.size} MEXC traders with numeric handles`)

  const updates = new Map<string, { nickname: string; avatar?: string }>()
  const apiUrl = 'https://www.mexc.com/api/platform/copy/v1/recommend/traders'

  for (const sortType of ['ROI', 'PNL', 'FOLLOWERS']) {
    for (const days of ['7', '30', '90']) {
      console.log(`\nFetching sortType=${sortType} days=${days}...`)
      for (let page = 1; page <= 10; page++) {
        try {
          const params = new URLSearchParams({ pageNum: String(page), pageSize: '20', sortType, days })
          const resp = await fetch(`${apiUrl}?${params}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
              Accept: 'application/json',
            },
          })

          if (!resp.ok) break

          const data = await resp.json()
          const list = data?.data?.list || data?.data || []
          if (!Array.isArray(list) || list.length === 0) break

          for (const t of list) {
            const id = String(t.traderId || t.uid || t.id || t.userId || '')
            if (!id) continue
            const nick = t.nickName || t.nickname || t.name || t.displayName || ''
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

  console.log(`\nTotal MEXC traders from API: ${updates.size}`)

  let updated = 0
  for (const [id, info] of updates) {
    if (!numericSet.has(id)) continue
    const updateData: Record<string, string | null> = { handle: info.nickname }
    if (info.avatar) updateData.avatar_url = info.avatar

    const { error } = await supabase
      .from('trader_sources')
      .update(updateData)
      .eq('source', 'mexc')
      .eq('source_trader_id', id)

    if (!error) updated++
  }

  console.log(`\nUpdated ${updated} MEXC traders`)
}

main().catch(console.error)
