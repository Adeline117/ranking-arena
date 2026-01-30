#!/usr/bin/env node
/**
 * quick-avatar-placeholder.mjs
 * 为没有头像的交易员生成占位符，使用他们的 handle 生成 blockie 头像
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')

async function main() {
  console.log(`\n🎨 Avatar Placeholder Generator ${DRY_RUN ? '(DRY RUN)' : ''}`)

  // 获取所有没有头像的交易员
  const { data: traders, error } = await supabase
    .from('trader_sources')
    .select('id, source_trader_id, handle, source')
    .is('avatar_url', null)
    .not('handle', 'is', null)
    .limit(1000)

  if (error) {
    console.error('Error fetching traders:', error)
    return
  }

  console.log(`\n📊 Found ${traders.length} traders without avatars`)

  let updated = 0
  for (const trader of traders) {
    // 使用 blockie API 生成头像
    const handle = trader.handle || trader.source_trader_id
    const blockieUrl = `/api/blockie/${encodeURIComponent(handle)}`

    if (!DRY_RUN) {
      const { error: updateError } = await supabase
        .from('trader_sources')
        .update({ avatar_url: blockieUrl })
        .eq('id', trader.id)

      if (!updateError) {
        updated++
        if (updated % 100 === 0) {
          console.log(`  ✓ Updated ${updated} traders...`)
        }
      }
    } else {
      updated++
    }
  }

  console.log(`\n✅ ${updated} avatars set to blockie placeholders ${DRY_RUN ? '(DRY RUN)' : ''}`)

  // 最终统计
  const { count: remaining } = await supabase
    .from('trader_sources')
    .select('id', { count: 'exact', head: true })
    .is('avatar_url', null)
  console.log(`📊 Remaining null avatars: ${remaining}`)
}

main().catch(console.error)
