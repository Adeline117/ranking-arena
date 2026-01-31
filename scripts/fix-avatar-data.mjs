#!/usr/bin/env node
/**
 * fix-avatar-data.mjs
 * Fix bad avatar URLs in database:
 * 1. LBank relative URLs → prefix with domain
 * 2. Binance/other "default" placeholder URLs → set null
 * 3. Base64 data URLs → set null
 * 4. Blockie placeholder URLs → set null
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function main() {
  console.log('Fixing avatar data...\n')

  // 1. Fix LBank relative URLs
  const { data: lbank } = await supabase
    .from('trader_sources')
    .select('id, avatar_url')
    .eq('source', 'lbank')
    .not('avatar_url', 'is', null)

  let fixedLBank = 0
  for (const t of (lbank || [])) {
    if (t.avatar_url && t.avatar_url.startsWith('/')) {
      const fullUrl = 'https://www.lbkrs.com' + t.avatar_url
      const { error } = await supabase.from('trader_sources').update({ avatar_url: fullUrl }).eq('id', t.id)
      if (!error) fixedLBank++
    }
  }
  console.log(`1. LBank relative URLs fixed: ${fixedLBank}`)

  // 2. Clear "default" placeholder URLs
  const { data: defaults } = await supabase
    .from('trader_sources')
    .select('id, source, avatar_url')
    .like('avatar_url', '%default%')

  let clearedDefaults = 0
  for (const t of (defaults || [])) {
    const { error } = await supabase.from('trader_sources').update({ avatar_url: null }).eq('id', t.id)
    if (!error) clearedDefaults++
  }
  console.log(`2. Default avatar placeholders cleared: ${clearedDefaults}`)

  // 3. Clear base64 data URLs (too large for DB, rejected by frontend)
  const { data: base64 } = await supabase
    .from('trader_sources')
    .select('id')
    .like('avatar_url', 'data:image%')

  let clearedBase64 = 0
  for (const t of (base64 || [])) {
    const { error } = await supabase.from('trader_sources').update({ avatar_url: null }).eq('id', t.id)
    if (!error) clearedBase64++
  }
  console.log(`3. Base64 data URLs cleared: ${clearedBase64}`)

  // 4. Clear blockie placeholder URLs
  const { data: blockies } = await supabase
    .from('trader_sources')
    .select('id')
    .like('avatar_url', '%/api/blockie%')

  let clearedBlockies = 0
  for (const t of (blockies || [])) {
    const { error } = await supabase.from('trader_sources').update({ avatar_url: null }).eq('id', t.id)
    if (!error) clearedBlockies++
  }
  console.log(`4. Blockie placeholders cleared: ${clearedBlockies}`)

  // 5. Clear DiceBear generated URLs
  const { data: dicebear } = await supabase
    .from('trader_sources')
    .select('id')
    .like('avatar_url', '%dicebear%')

  let clearedDicebear = 0
  for (const t of (dicebear || [])) {
    const { error } = await supabase.from('trader_sources').update({ avatar_url: null }).eq('id', t.id)
    if (!error) clearedDicebear++
  }
  console.log(`5. DiceBear avatars cleared: ${clearedDicebear}`)

  console.log(`\nTotal cleaned: ${clearedDefaults + clearedBase64 + clearedBlockies + clearedDicebear}, Fixed: ${fixedLBank}`)
}

main().catch(console.error)
