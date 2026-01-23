#!/usr/bin/env node
/**
 * RLS 迁移验证脚本 (Node.js 版本)
 * 使用 Supabase JS 客户端验证 00011_fix_rls_security.sql
 *
 * 运行: node scripts/verify-rls-migration.mjs
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ 错误: 请设置以下环境变量:')
  console.error('   - NEXT_PUBLIC_SUPABASE_URL')
  console.error('   - SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

console.log('==========================================')
console.log('RLS 迁移验证脚本 (Node.js)')
console.log('==========================================\n')

async function verifyHelperFunctions() {
  console.log('=== 1. 验证辅助函数 ===')

  const functions = ['is_group_admin', 'is_site_admin', 'is_premium_user']

  for (const fn of functions) {
    try {
      // 尝试调用函数
      if (fn === 'is_group_admin') {
        const { error } = await supabase.rpc(fn, {
          p_group_id: '00000000-0000-0000-0000-000000000000',
        })
        if (!error) {
          console.log(`  ✅ ${fn}() 存在且可调用`)
        } else {
          console.log(`  ❌ ${fn}() 调用失败: ${error.message}`)
        }
      } else {
        const { error } = await supabase.rpc(fn)
        if (!error) {
          console.log(`  ✅ ${fn}() 存在且可调用`)
        } else {
          console.log(`  ❌ ${fn}() 调用失败: ${error.message}`)
        }
      }
    } catch (e) {
      console.log(`  ❌ ${fn}() 异常: ${e.message}`)
    }
  }
}

async function verifyRLSPolicies() {
  console.log('\n=== 2. 验证 RLS 策略 ===')

  // 测试 notifications INSERT (应该失败 - 无 service_role)
  console.log('\n  【notifications INSERT 测试】')
  const anonClient = createClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '')

  const { error: notifError } = await anonClient.from('notifications').insert({
    user_id: '00000000-0000-0000-0000-000000000000',
    type: 'system',
    title: 'Test',
    message: 'Test',
  })

  if (notifError && notifError.code === '42501') {
    console.log('    ✅ 匿名用户无法插入通知 (权限被拒绝)')
  } else if (notifError) {
    console.log(`    ⚠️ 插入失败但原因不同: ${notifError.message}`)
  } else {
    console.log('    ❌ 警告: 匿名用户可以插入通知!')
  }

  // 测试 pro_official_groups (免费用户应该看不到)
  console.log('\n  【pro_official_groups 测试】')
  const { data: proGroups, error: proError } = await anonClient
    .from('pro_official_groups')
    .select('*')
    .limit(1)

  if (proError) {
    console.log(`    ⚠️ 查询失败: ${proError.message}`)
  } else if (!proGroups || proGroups.length === 0) {
    console.log('    ✅ 匿名用户无法查看 Pro 官方群 (返回空)')
  } else {
    console.log('    ❌ 警告: 匿名用户可以看到 Pro 官方群!')
  }
}

async function verifyIndexes() {
  console.log('\n=== 3. 验证索引 ===')

  const expectedIndexes = [
    'idx_group_members_user_role',
    'idx_user_profiles_role_admin',
    'idx_subscriptions_active_premium',
  ]

  // 使用 service role 查询索引
  const { data, error } = await supabase.rpc('get_indexes', {}).catch(() => ({
    data: null,
    error: { message: 'Function not available' },
  }))

  if (error) {
    console.log('  ⚠️ 无法通过 RPC 验证索引 (需要手动检查)')
    console.log('  📝 请在 Supabase SQL Editor 运行:')
    console.log("     SELECT indexname FROM pg_indexes WHERE indexname LIKE 'idx_%';")
  }

  console.log('\n  预期存在的索引:')
  expectedIndexes.forEach((idx) => console.log(`    - ${idx}`))
}

async function main() {
  try {
    await verifyHelperFunctions()
    await verifyRLSPolicies()
    await verifyIndexes()

    console.log('\n==========================================')
    console.log('验证完成')
    console.log('==========================================')
  } catch (e) {
    console.error('验证过程出错:', e)
    process.exit(1)
  }
}

main()
