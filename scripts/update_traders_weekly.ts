import 'dotenv/config'

import { createClient } from '@supabase/supabase-js'
import fetch from 'node-fetch'
import * as cheerio from 'cheerio'

// Supabase
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

type PublicTrader = {
  handle: string
  roi: number
  win_rate: number
  followers: number
}

/**
 * DeBank Top Traders（DEX 公榜）
 * 抓前 100
 */
async function fetchDebankTop100(): Promise<PublicTrader[]> {
  const url = 'https://debank.com/ranking/traders'
  const html = await fetch(url).then((res) => res.text())
  const $ = cheerio.load(html)

  const traders: PublicTrader[] = []

  $('.ranking-table-row').each((i: number, el: any) => {
    if (i >= 100) return false

    const handle = $(el).find('.ranking-name').text().trim()
    const roiText = $(el).find('.ranking-roi').text().replace('%', '')
    const followersText = $(el).find('.ranking-followers').text()

    const roi = Number(roiText) || 0
    const followers = Number(followersText.replace(/,/g, '')) || 0

    if (!handle) return

    traders.push({
      handle,
      roi,
      win_rate: 0,
      followers,
    })
  })

  return traders
}

async function run() {
  console.log('⏳ fetching DeBank public traders...')

  const traders = await fetchDebankTop100()

  for (const t of traders) {
    await supabase
      .from('traders')
      .upsert(
        {
          handle: t.handle,
          roi: t.roi,
          win_rate: t.win_rate,
          followers: t.followers,
        },
        { onConflict: 'handle' }
      )
  }

  console.log(`✅ updated ${traders.length} traders`)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
