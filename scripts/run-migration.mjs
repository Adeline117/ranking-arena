#!/usr/bin/env node
/**
 * 数据库迁移辅助工具
 *
 * 用法:
 *   node scripts/run-migration.mjs                              # 列出所有待执行迁移
 *   node scripts/run-migration.mjs 00015                        # 输出指定迁移的 SQL
 *   node scripts/run-migration.mjs --verify                     # 验证最新迁移是否已应用
 *
 * 注意: DDL 操作（ALTER TABLE 等）需要在 Supabase SQL Editor 中手动执行
 *       或通过 supabase db push 命令
 */

import { readFileSync, readdirSync } from 'fs'
import { resolve, basename } from 'path'

const migrationsDir = resolve(process.cwd(), 'supabase/migrations')
const arg = process.argv[2]

function listMigrations() {
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort()

  console.log('📋 迁移文件列表:\n')
  files.forEach((f, i) => {
    const content = readFileSync(resolve(migrationsDir, f), 'utf-8')
    const firstLine = content.split('\n').find(l => l.startsWith('--')) || ''
    console.log(`  ${i + 1}. ${f}`)
    if (firstLine) console.log(`     ${firstLine}`)
  })
  console.log('\n执行方式:')
  console.log('  1. 打开 Supabase Dashboard → SQL Editor')
  console.log('  2. 粘贴迁移 SQL 并执行')
  console.log('  3. 或使用: supabase db push (需安装 Supabase CLI)')
  console.log(`\n查看特定迁移: node scripts/run-migration.mjs <编号>`)
  console.log(`  例: node scripts/run-migration.mjs 00015`)
}

function showMigration(id) {
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql') && f.includes(id))
    .sort()

  if (files.length === 0) {
    console.error(`❌ 未找到包含 "${id}" 的迁移文件`)
    process.exit(1)
  }

  files.forEach(f => {
    const content = readFileSync(resolve(migrationsDir, f), 'utf-8')
    console.log(`\n${'═'.repeat(60)}`)
    console.log(`📄 ${f}`)
    console.log(`${'═'.repeat(60)}\n`)
    console.log(content)
    console.log(`\n${'─'.repeat(60)}`)
    console.log('⬆️  复制以上 SQL 到 Supabase SQL Editor 执行')
    console.log(`${'─'.repeat(60)}`)
  })
}

async function verifyLatest() {
  const dotenv = await import('dotenv').catch(() => null)
  if (dotenv) dotenv.config()

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    console.error('❌ 需要环境变量: SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY')
    console.error('   设置 .env 文件或直接传入环境变量')
    process.exit(1)
  }

  const { createClient } = await import('@supabase/supabase-js')
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  })

  console.log('🔍 验证迁移 00015: notifications_muted 列...')

  // 尝试查询 notifications_muted 列来验证迁移是否已应用
  const { data, error } = await supabase
    .from('group_members')
    .select('notifications_muted')
    .limit(1)

  if (error) {
    if (error.message.includes('notifications_muted') || error.code === '42703') {
      console.log('❌ 迁移未执行: notifications_muted 列不存在')
      console.log('\n请执行以下 SQL:')
      const sql = readFileSync(resolve(migrationsDir, '00015_group_notifications_muted.sql'), 'utf-8')
      console.log(sql)
      process.exit(1)
    } else if (error.message.includes('group_members') || error.code === '42P01') {
      console.log('⚠️  group_members 表不存在（可能需要先执行前置迁移）')
      process.exit(1)
    } else {
      console.log(`⚠️  查询错误: ${error.message}`)
      process.exit(1)
    }
  } else {
    console.log('✅ 迁移已应用: notifications_muted 列存在')
  }
}

// Main
if (!arg) {
  listMigrations()
} else if (arg === '--verify') {
  verifyLatest()
} else {
  showMigration(arg)
}
