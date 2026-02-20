#!/usr/bin/env node
/**
 * enrich-logos.mjs
 * Populate logo_url for tools and institutions using icon.horse favicon service.
 * icon.horse/{domain} returns the site's logo/favicon.
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const sleep = ms => new Promise(r => setTimeout(r, ms))

function extractDomain(url) {
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url)
    return u.hostname.replace(/^www\./, '')
  } catch { return null }
}

async function logoExists(url, timeout = 8000) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeout) })
    return res.ok && res.status === 200
  } catch { return false }
}

async function enrichTable(tableName, nameCol = 'name') {
  console.log(`\n=== ${tableName} ===`)
  const { data, error } = await sb
    .from(tableName)
    .select('id, name, website')
    .not('website', 'is', null)
    .is('logo_url', null)

  if (error) { console.error(error.message); return }
  console.log(`Found ${data.length} entries without logo`)

  let updated = 0, failed = 0

  for (let i = 0; i < data.length; i++) {
    const item = data[i]
    if (i % 50 === 0) console.log(`[${i}/${data.length}] updated=${updated}`)

    const domain = extractDomain(item.website)
    if (!domain) { failed++; continue }

    // Try icon.horse first, fall back to Google favicon
    const iconHorseUrl = `https://icon.horse/icon/${domain}`
    const googleFaviconUrl = `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${domain}&size=128`

    let logoUrl = iconHorseUrl
    const exists = await logoExists(iconHorseUrl)
    if (!exists) logoUrl = googleFaviconUrl

    const { error: upErr } = await sb
      .from(tableName)
      .update({ logo_url: logoUrl })
      .eq('id', item.id)

    if (upErr) { failed++; console.error(`Failed ${item.name}:`, upErr.message) }
    else updated++

    await sleep(50) // light rate limit
  }

  console.log(`${tableName} done: updated=${updated} failed=${failed}`)
}

async function main() {
  console.log('=== Logo Enrichment ===')
  await enrichTable('tools')
  await enrichTable('institutions')

  // Verify
  const { count: toolsLeft } = await sb.from('tools').select('*', { count: 'exact', head: true }).is('logo_url', null)
  const { count: instLeft } = await sb.from('institutions').select('*', { count: 'exact', head: true }).is('logo_url', null)
  console.log(`\nRemaining: tools=${toolsLeft} institutions=${instLeft}`)
}

main().catch(e => { console.error(e); process.exit(1) })
