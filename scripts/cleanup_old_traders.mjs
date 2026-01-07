import { createClient } from '@supabase/supabase-js'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 加载 .env 文件
try {
  const envPath = join(__dirname, '..', '.env')
  const envContent = readFileSync(envPath, 'utf-8')
  envContent.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=')
    if (key && valueParts.length > 0) {
      const value = valueParts.join('=').trim().replace(/^["']|["']$/g, '')
      if (!process.env[key.trim()]) {
        process.env[key.trim()] = value
      }
    }
  })
} catch (e) {
  // .env 文件不存在
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

/**
 * 主函数
 */
async function main() {
  const keepSource = process.argv[2] || 'binance_web3' // 默认保留 binance_web3
  
  console.log('=== 清理旧交易员数据 ===')
  console.log('')
  console.log(`保留数据源: ${keepSource}`)
  console.log('')
  
  // 先查看有哪些数据源
  console.log('查看现有数据源...')
  const { data: sources, error: sourcesError } = await supabase
    .from('trader_sources')
    .select('source')
    .order('source')
  
  if (sourcesError) {
    console.error('查询 trader_sources 失败:', sourcesError.message)
    process.exit(1)
  }
  
  const sourceCounts = {}
  sources.forEach(s => {
    sourceCounts[s.source] = (sourceCounts[s.source] || 0) + 1
  })
  
  console.log('现有数据源统计:')
  Object.entries(sourceCounts).forEach(([source, count]) => {
    console.log(`  ${source}: ${count} 条`)
  })
  console.log('')
  
  // 查找需要删除的数据源
  const sourcesToDelete = Object.keys(sourceCounts).filter(s => s !== keepSource)
  
  if (sourcesToDelete.length === 0) {
    console.log('✅ 没有需要删除的数据源')
    return
  }
  
  console.log(`将删除以下数据源: ${sourcesToDelete.join(', ')}`)
  console.log('')
  
  // 删除 trader_snapshots
  console.log('删除 trader_snapshots...')
  for (const source of sourcesToDelete) {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .delete()
      .eq('source', source)
    
    if (error) {
      console.error(`✗ 删除 trader_snapshots (${source}) 失败:`, error.message)
    } else {
      console.log(`✓ 已删除 trader_snapshots (${source})`)
    }
  }
  console.log('')
  
  // 删除 trader_sources
  console.log('删除 trader_sources...')
  for (const source of sourcesToDelete) {
    const { data, error } = await supabase
      .from('trader_sources')
      .delete()
      .eq('source', source)
    
    if (error) {
      console.error(`✗ 删除 trader_sources (${source}) 失败:`, error.message)
    } else {
      console.log(`✓ 已删除 trader_sources (${source})`)
    }
  }
  console.log('')
  
  // 验证结果
  console.log('验证结果...')
  const { data: remainingSources } = await supabase
    .from('trader_sources')
    .select('source')
  
  const remainingCounts = {}
  remainingSources.forEach(s => {
    remainingCounts[s.source] = (remainingCounts[s.source] || 0) + 1
  })
  
  console.log('剩余数据源:')
  Object.entries(remainingCounts).forEach(([source, count]) => {
    console.log(`  ${source}: ${count} 条`)
  })
  console.log('')
  
  console.log('✅ 清理完成！')
}

main().catch((error) => {
  console.error('执行失败:', error)
  process.exit(1)
})



