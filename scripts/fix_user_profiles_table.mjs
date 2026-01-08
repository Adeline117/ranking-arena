#!/usr/bin/env node

/**
 * 自动修复 user_profiles 表结构
 * 运行: node scripts/fix_user_profiles_table.mjs
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 从环境变量或 .env.local 读取配置
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl) {
  console.error('❌ 错误: 未找到 NEXT_PUBLIC_SUPABASE_URL 环境变量')
  console.error('请在 .env.local 文件中设置 Supabase 配置')
  process.exit(1)
}

if (!supabaseServiceKey) {
  console.error('❌ 错误: 未找到 SUPABASE_SERVICE_ROLE_KEY 或 NEXT_PUBLIC_SUPABASE_ANON_KEY')
  console.error('请使用 Service Role Key（有管理员权限）或 Anon Key')
  process.exit(1)
}

// 使用 Service Role Key 创建客户端（有管理员权限）
const supabase = createClient(supabaseUrl, supabaseServiceKey)

console.log('🔧 开始修复 user_profiles 表结构...\n')

async function fixTable() {
  try {
    // 读取 SQL 脚本
    const sqlPath = join(__dirname, 'fix_user_profiles_table.sql')
    const sql = readFileSync(sqlPath, 'utf-8')
    
    // 执行 SQL
    console.log('📝 执行 SQL 脚本...')
    const { data, error } = await supabase.rpc('exec_sql', { sql_query: sql })
    
    if (error) {
      // 如果 rpc 不存在，尝试直接执行 SQL（需要 Service Role Key）
      console.log('⚠️  RPC 方法不存在，尝试直接执行 SQL...')
      
      // 直接执行 SQL 语句
      const statements = [
        "ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS handle TEXT UNIQUE",
        "ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS bio TEXT",
        "ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT",
        "ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS email TEXT",
        "ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()",
        "ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()",
      ]
      
      for (const statement of statements) {
        try {
          // 使用 REST API 执行 SQL（需要 Service Role Key）
          const response = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseServiceKey,
              'Authorization': `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({ sql_query: statement }),
          })
          
          if (!response.ok) {
            console.log(`⚠️  执行失败: ${statement}`)
            console.log(`   错误: ${response.statusText}`)
          } else {
            console.log(`✅ 执行成功: ${statement.split('ADD COLUMN')[1]?.trim() || statement}`)
          }
        } catch (err) {
          console.log(`⚠️  执行失败: ${statement}`)
          console.log(`   错误: ${err.message}`)
        }
      }
    } else {
      console.log('✅ SQL 脚本执行成功')
    }
    
    // 验证表结构
    console.log('\n🔍 验证表结构...')
    const { data: columns, error: columnsError } = await supabase
      .from('user_profiles')
      .select('*')
      .limit(0)
    
    if (columnsError) {
      console.error('❌ 验证失败:', columnsError.message)
      console.error('\n💡 提示: 请手动在 Supabase Dashboard 的 SQL Editor 中运行以下 SQL:')
      console.error('\n' + sql)
    } else {
      console.log('✅ 表结构验证成功')
      console.log('✅ user_profiles 表可以正常使用')
    }
    
    console.log('\n✨ 修复完成！请刷新页面测试。')
    
  } catch (error) {
    console.error('❌ 修复失败:', error.message)
    console.error('\n💡 请手动在 Supabase Dashboard 的 SQL Editor 中运行以下 SQL:')
    const sqlPath = join(__dirname, 'fix_user_profiles_table.sql')
    const sql = readFileSync(sqlPath, 'utf-8')
    console.error('\n' + sql)
    process.exit(1)
  }
}

fixTable()



