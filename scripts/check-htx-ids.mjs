#!/usr/bin/env node
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function main() {
  // Get sample HTX traders
  const { data: withAvatar } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle, avatar_url')
    .eq('source', 'htx_futures')
    .not('avatar_url', 'is', null)
    .limit(5)

  const { data: withoutAvatar } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle, avatar_url')
    .eq('source', 'htx_futures')
    .is('avatar_url', null)
    .limit(5)

  console.log('\n📊 HTX Traders WITH avatars:')
  withAvatar?.forEach(t => console.log(`  ID: ${t.source_trader_id.padEnd(15)} Handle: ${(t.handle || '').padEnd(20)} Avatar: ${t.avatar_url?.slice(0, 50)}...`))

  console.log('\n📊 HTX Traders WITHOUT avatars:')
  withoutAvatar?.forEach(t => console.log(`  ID: ${t.source_trader_id.padEnd(15)} Handle: ${(t.handle || '').padEnd(20)}`))

  // Fetch API sample
  console.log('\n📊 Sample from HTX API:')
  const response = await fetch('https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=1&pageNo=1&pageSize=5', {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0',
    }
  })
  const data = await response.json()
  data.data?.itemList?.forEach(t => console.log(`  userSign: ${(t.userSign || '').padEnd(15)} uid: ${(t.uid || '').toString().padEnd(15)} nickName: ${(t.nickName || '').padEnd(20)} imgUrl: ${t.imgUrl?.slice(0, 50)}...`))
}

main().catch(console.error)
