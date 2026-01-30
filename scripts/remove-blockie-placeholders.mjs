#!/usr/bin/env node
/**
 * remove-blockie-placeholders.mjs
 * 清除所有 blockie 占位符，只保留真实的外部图片URL
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')

async function main() {
  console.log(`\n🧹 Removing Blockie Placeholders ${DRY_RUN ? '(DRY RUN)' : ''}`)

  // 查找所有使用 blockie 的记录
  const { data: blockieAvatars, error } = await supabase
    .from('trader_sources')
    .select('id, source_trader_id, handle, source, avatar_url')
    .like('avatar_url', '/api/blockie/%')

  if (error) {
    console.error('Error fetching blockie avatars:', error)
    return
  }

  console.log(`\n📊 Found ${blockieAvatars.length} traders with blockie placeholders`)

  if (blockieAvatars.length === 0) {
    console.log('✅ No blockie placeholders to remove')
    return
  }

  let removed = 0
  for (const trader of blockieAvatars) {
    if (!DRY_RUN) {
      const { error: updateError } = await supabase
        .from('trader_sources')
        .update({ avatar_url: null })
        .eq('id', trader.id)

      if (!updateError) {
        removed++
        if (removed % 100 === 0) {
          console.log(`  ✓ Removed ${removed} blockie placeholders...`)
        }
      } else {
        console.error(`  ✗ Error removing blockie for ${trader.handle}:`, updateError)
      }
    } else {
      removed++
    }
  }

  console.log(`\n✅ ${removed} blockie placeholders removed ${DRY_RUN ? '(DRY RUN)' : ''}`)

  // 统计真实头像
  const { count: realAvatars } = await supabase
    .from('trader_sources')
    .select('id', { count: 'exact', head: true })
    .not('avatar_url', 'is', null)

  const { count: nullAvatars } = await supabase
    .from('trader_sources')
    .select('id', { count: 'exact', head: true })
    .is('avatar_url', null)

  console.log(`\n📊 Final Status:`)
  console.log(`  Real avatars: ${realAvatars}`)
  console.log(`  No avatar (will show initials): ${nullAvatars}`)
}

main().catch(console.error)
