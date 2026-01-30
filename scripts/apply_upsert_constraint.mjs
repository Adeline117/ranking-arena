/**
 * 应用 upsert 唯一约束迁移
 * 通过 Supabase RPC 执行 SQL，将 trader_snapshots 的唯一约束
 * 从 (source, source_trader_id, season_id, captured_at)
 * 改为 (source, source_trader_id, season_id)
 */

import 'dotenv/config'
import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: '.env.local' })
dotenv.config()

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing env: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function executeSql(sql) {
  // Use the Supabase Management API or pg REST to execute raw SQL
  // Since we're using the JS client, we'll use rpc if available
  // Otherwise, use the REST API directly
  
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({})
  })
  
  // The JS client can't run arbitrary SQL, so we use the pg endpoint
  // Let's try the Supabase SQL endpoint instead
  const pgResponse = await fetch(`${SUPABASE_URL}/pg`, {
    method: 'POST', 
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ query: sql })
  })
  
  return pgResponse
}

async function main() {
  console.log('🔧 应用 upsert 唯一约束迁移')
  console.log('时间:', new Date().toISOString())
  
  // Step 1: Check current constraints
  console.log('\n📋 检查当前约束...')
  
  // Try to test if the new constraint already exists by attempting a query
  // We'll try to do an upsert and see if it works
  const testData = {
    source: '__test__',
    source_trader_id: '__test__',
    season_id: '__test__',
    rank: 0,
    roi: 0,
    pnl: 0,
    captured_at: new Date().toISOString()
  }
  
  // Try upsert with new conflict key
  const { error: upsertError } = await supabase
    .from('trader_snapshots')
    .upsert(testData, {
      onConflict: 'source,source_trader_id,season_id',
      ignoreDuplicates: false
    })
  
  if (!upsertError) {
    console.log('✅ Upsert 约束已存在且工作正常!')
    // Clean up test row
    await supabase
      .from('trader_snapshots')
      .delete()
      .eq('source', '__test__')
    console.log('  已清理测试数据')
    return
  }
  
  console.log(`⚠ Upsert 测试失败: ${upsertError.message}`)
  console.log('\n需要手动在 Supabase Dashboard 执行以下 SQL:')
  console.log('='.repeat(60))
  
  const sql = `
-- 先清理重复数据（保留每组最新一条）
DELETE FROM trader_snapshots
WHERE id NOT IN (
  SELECT DISTINCT ON (source, source_trader_id, season_id) id
  FROM trader_snapshots
  ORDER BY source, source_trader_id, season_id, captured_at DESC
);

-- 删除旧约束
ALTER TABLE trader_snapshots
  DROP CONSTRAINT IF EXISTS trader_snapshots_unique_per_season;

-- 添加新约束
ALTER TABLE trader_snapshots
  ADD CONSTRAINT uq_trader_snapshots_source_trader_season
  UNIQUE (source, source_trader_id, season_id);
`.trim()
  
  console.log(sql)
  console.log('='.repeat(60))
  console.log('\n请在 Supabase Dashboard > SQL Editor 中执行上述 SQL')
  console.log('URL: https://supabase.com/dashboard/project/iknktzifjdyujdccyhsv/sql/new')
  
  // Clean up any test data that may have been inserted
  await supabase
    .from('trader_snapshots')
    .delete()
    .eq('source', '__test__')
}

main().catch(err => {
  console.error('💥 脚本失败:', err)
  process.exit(1)
})
