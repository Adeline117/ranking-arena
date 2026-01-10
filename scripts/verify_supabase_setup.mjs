#!/usr/bin/env node
/**
 * 验证 Supabase 配置是否正确
 * 使用方法: node scripts/verify_supabase_setup.mjs
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ 错误: 缺少环境变量')
  console.error('需要设置: NEXT_PUBLIC_SUPABASE_URL 和 NEXT_PUBLIC_SUPABASE_ANON_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
const adminSupabase = SUPABASE_SERVICE_KEY 
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null

console.log('=== 验证 Supabase 配置 ===\n')

async function checkTables() {
  console.log('1️⃣ 检查数据库表...')
  
  const tables = ['profiles', 'user_profiles', 'posts', 'groups']
  const results = {}

  for (const table of tables) {
    try {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .limit(1)

      if (error) {
        results[table] = { exists: false, error: error.message }
      } else {
        results[table] = { exists: true }
      }
    } catch (err) {
      results[table] = { exists: false, error: err.message }
    }
  }

  let allExist = true
  for (const [table, result] of Object.entries(results)) {
    if (result.exists) {
      console.log(`   ✅ ${table} 表存在`)
    } else {
      console.log(`   ❌ ${table} 表不存在或无法访问`)
      if (result.error) {
        console.log(`      错误: ${result.error}`)
      }
      allExist = false
    }
  }

  return allExist
}

async function checkPostsColumns() {
  console.log('\n2️⃣ 检查 posts 表字段...')
  
  try {
    // 尝试查询 author_id 和 author_handle
    const { data, error } = await supabase
      .from('posts')
      .select('id, author_id, author_handle')
      .limit(1)

    if (error) {
      if (error.message.includes('author_id') || error.message.includes('author_handle')) {
        console.log('   ❌ posts 表缺少 author_id 或 author_handle 字段')
        console.log('   💡 请运行 scripts/setup_supabase_tables.sql')
        return false
      }
      console.log('   ⚠️ 无法检查 posts 表字段:', error.message)
      return false
    }

    console.log('   ✅ posts 表包含 author_id 和 author_handle 字段')
    return true
  } catch (err) {
    console.log('   ⚠️ 检查失败:', err.message)
    return false
  }
}

async function checkRLS() {
  console.log('\n3️⃣ 检查 RLS 策略...')
  
  if (!adminSupabase) {
    console.log('   ⚠️ 无法检查 RLS（需要 SUPABASE_SERVICE_ROLE_KEY）')
    return false
  }

  try {
    // 尝试创建一个测试查询来检查 RLS
    const { error: profilesError } = await supabase
      .from('profiles')
      .select('id')
      .limit(1)

    if (profilesError && profilesError.message.includes('policy')) {
      console.log('   ⚠️ profiles 表可能有 RLS 策略问题')
      console.log('   💡 请检查 RLS 策略是否正确配置')
      return false
    }

    console.log('   ✅ profiles 表 RLS 策略正常')

    const { error: postsError } = await supabase
      .from('posts')
      .select('id')
      .limit(1)

    if (postsError && postsError.message.includes('policy')) {
      console.log('   ⚠️ posts 表可能有 RLS 策略问题')
      console.log('   💡 请检查 RLS 策略是否正确配置')
      return false
    }

    console.log('   ✅ posts 表 RLS 策略正常')
    return true
  } catch (err) {
    console.log('   ⚠️ 检查失败:', err.message)
    return false
  }
}

async function checkStorage() {
  console.log('\n4️⃣ 检查 Storage...')
  
  try {
    const { data: buckets, error } = await supabase.storage.listBuckets()

    if (error) {
      console.log('   ⚠️ 无法检查 Storage:', error.message)
      return false
    }

    const avatarsBucket = buckets?.find(b => b.name === 'avatars')
    if (avatarsBucket) {
      console.log('   ✅ avatars bucket 存在')
      console.log(`      公开访问: ${avatarsBucket.public ? '是' : '否'}`)
      return true
    } else {
      console.log('   ⚠️ avatars bucket 不存在')
      console.log('   💡 请在 Supabase Dashboard 中创建 avatars bucket')
      return false
    }
  } catch (err) {
    console.log('   ⚠️ 检查失败:', err.message)
    return false
  }
}

async function checkAuth() {
  console.log('\n5️⃣ 检查 Authentication 配置...')
  
  try {
    // 尝试发送 OTP（使用无效邮箱，应该返回特定错误）
    const { error } = await supabase.auth.signInWithOtp({
      email: 'test@example.com',
      options: {
        shouldCreateUser: false,
      },
    })

    // 如果错误是邮箱无效，说明 OTP 功能已启用
    if (error) {
      if (error.message.includes('invalid') || error.message.includes('email')) {
        console.log('   ✅ OTP 功能已启用（邮箱验证正常）')
        return true
      } else {
        console.log('   ⚠️ OTP 功能可能未正确配置')
        console.log(`      错误: ${error.message}`)
        return false
      }
    }

    console.log('   ✅ OTP 功能已启用')
    return true
  } catch (err) {
    console.log('   ⚠️ 检查失败:', err.message)
    return false
  }
}

async function main() {
  const results = {
    tables: await checkTables(),
    postsColumns: await checkPostsColumns(),
    rls: await checkRLS(),
    storage: await checkStorage(),
    auth: await checkAuth(),
  }

  console.log('\n=== 验证结果 ===')
  console.log(`表结构: ${results.tables ? '✅' : '❌'}`)
  console.log(`Posts 字段: ${results.postsColumns ? '✅' : '❌'}`)
  console.log(`RLS 策略: ${results.rls ? '✅' : '⚠️'}`)
  console.log(`Storage: ${results.storage ? '✅' : '⚠️'}`)
  console.log(`Auth: ${results.auth ? '✅' : '⚠️'}`)

  const allCritical = results.tables && results.postsColumns
  if (allCritical) {
    console.log('\n✅ 关键配置已完成！可以开始测试注册和发帖功能了。')
  } else {
    console.log('\n❌ 请先完成关键配置：')
    if (!results.tables) {
      console.log('   - 运行 scripts/setup_supabase_tables.sql 创建表结构')
    }
    if (!results.postsColumns) {
      console.log('   - 运行 scripts/setup_supabase_tables.sql 添加字段')
    }
  }

  console.log('\n📝 下一步:')
  console.log('   1. 在 Supabase Dashboard 中配置邮箱设置')
  console.log('   2. 运行 scripts/setup_supabase_tables.sql')
  console.log('   3. 在浏览器中测试注册和发帖功能')
}

main().catch(console.error)




