#!/usr/bin/env node
/**
 * 诊断 LBank ID 匹配问题
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  // 1. 获取数据库中的 LBank traders
  const { data: dbTraders } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle, avatar_url')
    .eq('source', 'lbank')
    .limit(20)

  console.log('\n📊 Database LBank traders (sample 20):')
  dbTraders?.forEach((t, i) => {
    console.log(`${(i + 1).toString().padStart(2)}. ID: ${t.source_trader_id.padEnd(30)} Handle: ${(t.handle || '').padEnd(25)} Avatar: ${t.avatar_url ? '✓' : '✗'}`)
  })

  // 2. 从 API 获取数据
  console.log('\n📊 Fetching from LBank API...')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  })
  const page = await context.newPage()

  const apiTraders = []
  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('copy') && !url.includes('leader') && !url.includes('trader')) return
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return

      const lists = [json?.data?.list, json?.data?.items, json?.result?.list, json?.result?.items, json?.data]
      for (const list of lists) {
        if (!Array.isArray(list)) continue
        for (const t of list) {
          if (apiTraders.length < 20) {
            apiTraders.push(t)
          }
        }
      }
    } catch {}
  })

  for (const url of [
    'https://www.lbank.com/copy-trading',
    'https://www.lbank.com/en/copy-trading',
  ]) {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
      await sleep(5000)
      if (apiTraders.length > 0) break
    } catch {}
  }

  await browser.close()

  console.log('\n📊 API traders (sample):')
  apiTraders.slice(0, 20).forEach((t, i) => {
    const uid = String(t.uid || t.userId || t.traderId || t.id || t.memberId || t.uuid || '')
    const nickname = t.nickname || t.nickName || t.name || ''
    const headPhoto = t.headPhoto || t.avatar || t.avatarUrl || null

    console.log(`${(i + 1).toString().padStart(2)}. uid: ${uid.padEnd(15)} uuid: ${(t.uuid || '').padEnd(15)} nickname: ${nickname.padEnd(20)} avatar: ${headPhoto ? '✓' : '✗'}`)
  })

  // 3. 尝试匹配
  console.log('\n📊 Matching analysis:')
  const dbIds = new Set(dbTraders?.map(t => t.source_trader_id) || [])
  const dbHandles = new Set(dbTraders?.map(t => t.handle?.toLowerCase()) || [])

  let uidMatch = 0
  let uuidMatch = 0
  let nicknameMatch = 0

  for (const api of apiTraders) {
    const uid = String(api.uid || api.userId || api.traderId || api.id || api.memberId || '')
    const uuid = String(api.uuid || '')
    const nickname = (api.nickname || api.nickName || '').toLowerCase()

    if (uid && dbIds.has(uid)) uidMatch++
    if (uuid && dbIds.has(uuid)) uuidMatch++
    if (nickname && dbHandles.has(nickname)) nicknameMatch++
  }

  console.log(`  uid matches: ${uidMatch}/${apiTraders.length}`)
  console.log(`  uuid matches: ${uuidMatch}/${apiTraders.length}`)
  console.log(`  nickname matches: ${nicknameMatch}/${apiTraders.length}`)
}

main().catch(console.error)
