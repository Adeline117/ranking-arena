/**
 * 新交易所批量数据抓取脚本
 * 
 * 按序执行：
 * 1. OKX增强版 (Futures + Spot，目标1000+)
 * 2. Bitfinex排行榜
 * 3. Crypto.com跟单
 * 4. Pionex跟单
 * 
 * 用法: node scripts/import/batch_new_exchanges.mjs [7D|30D|90D|ALL]
 */

import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 脚本配置
const SCRIPTS = [
  {
    name: 'OKX 增强版',
    file: 'import_okx_enhanced.mjs',
    description: '扩充OKX数据到1000+交易员',
    estimatedTime: '5-8分钟'
  },
  {
    name: 'Bitfinex',
    file: 'import_bitfinex.mjs', 
    description: '抓取Bitfinex排行榜数据',
    estimatedTime: '3-5分钟'
  },
  {
    name: 'Crypto.com',
    file: 'import_crypto_com.mjs',
    description: '抓取Crypto.com跟单数据', 
    estimatedTime: '8-12分钟'
  },
  {
    name: 'Pionex',
    file: 'import_pionex.mjs',
    description: '抓取Pionex跟单数据',
    estimatedTime: '10-15分钟'
  }
]

/**
 * 执行单个脚本
 */
function runScript(script, period) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, script.file)
    const args = period ? [period] : []
    
    console.log(`\n${'='.repeat(60)}`)
    console.log(`🚀 开始执行: ${script.name}`)
    console.log(`📁 脚本: ${script.file}`)
    console.log(`📝 描述: ${script.description}`)
    console.log(`⏱️  预估时间: ${script.estimatedTime}`)
    console.log(`🔄 参数: ${args.join(' ') || '默认'}`)
    console.log(`${'='.repeat(60)}`)
    
    const startTime = Date.now()
    
    const child = spawn('node', [scriptPath, ...args], {
      stdio: 'inherit',
      cwd: process.cwd()
    })
    
    child.on('close', (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1)
      
      if (code === 0) {
        console.log(`\n✅ ${script.name} 完成! 耗时: ${duration}s`)
        resolve({ script: script.name, success: true, duration })
      } else {
        console.log(`\n❌ ${script.name} 失败! 退出码: ${code}, 耗时: ${duration}s`)
        reject(new Error(`${script.name} 执行失败，退出码: ${code}`))
      }
    })
    
    child.on('error', (error) => {
      console.log(`\n❌ ${script.name} 启动失败: ${error.message}`)
      reject(error)
    })
  })
}

/**
 * 延迟函数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  const period = process.argv[2]?.toUpperCase()
  const validPeriods = ['7D', '30D', '90D', 'ALL']
  
  if (period && !validPeriods.includes(period)) {
    console.log(`❌ 无效的时间段: ${period}`)
    console.log(`✅ 有效选项: ${validPeriods.join(', ')}`)
    process.exit(1)
  }
  
  const globalStartTime = Date.now()
  const results = []
  
  console.log(`\n${'='.repeat(80)}`)
  console.log(`🏗️  新交易所数据抓取批量执行`)
  console.log(`📅 时间: ${new Date().toISOString()}`)
  console.log(`⏰ 时间段: ${period || '默认 (各脚本自定义)'}`)
  console.log(`📊 目标: 为ranking-arena添加4个新交易所数据`)
  console.log(`${'='.repeat(80)}`)
  
  // 显示执行计划
  console.log(`\n📋 执行计划:`)
  SCRIPTS.forEach((script, idx) => {
    console.log(`  ${idx + 1}. ${script.name} - ${script.description} (${script.estimatedTime})`)
  })
  
  console.log(`\n⚠️  注意事项:`)
  console.log(`   • 每个脚本间有30秒延迟，避免API限流`)
  console.log(`   • 总预估时间: 30-45分钟`)
  console.log(`   • 频率控制: 每秒最多2-3个请求`)
  console.log(`   • 如果某个脚本失败，会继续执行下一个`)
  
  // 开始执行
  for (let i = 0; i < SCRIPTS.length; i++) {
    const script = SCRIPTS[i]
    
    try {
      const result = await runScript(script, period)
      results.push(result)
      
      // 脚本间延迟
      if (i < SCRIPTS.length - 1) {
        console.log(`\n⏳ 等待30秒后执行下一个脚本...`)
        await sleep(30000)
      }
      
    } catch (error) {
      console.log(`\n⚠️  ${script.name} 失败: ${error.message}`)
      console.log(`📋 继续执行下一个脚本...`)
      results.push({ script: script.name, success: false, error: error.message })
      
      // 失败后也延迟，避免连锁问题
      if (i < SCRIPTS.length - 1) {
        await sleep(15000)
      }
    }
  }
  
  // 执行总结
  const totalDuration = ((Date.now() - globalStartTime) / 1000).toFixed(1)
  const successful = results.filter(r => r.success).length
  const failed = results.length - successful
  
  console.log(`\n${'='.repeat(80)}`)
  console.log(`📊 批量执行完成总结`)
  console.log(`${'='.repeat(80)}`)
  console.log(`⏱️  总耗时: ${totalDuration}s`)
  console.log(`✅ 成功: ${successful}/${results.length} 个脚本`)
  console.log(`❌ 失败: ${failed}/${results.length} 个脚本`)
  
  console.log(`\n📋 详细结果:`)
  results.forEach((result, idx) => {
    const status = result.success ? '✅' : '❌'
    const info = result.success 
      ? `${result.duration}s`
      : `失败: ${result.error || '未知错误'}`
    console.log(`  ${idx + 1}. ${status} ${result.script}: ${info}`)
  })
  
  if (successful > 0) {
    console.log(`\n🎉 恭喜！已成功为ranking-arena添加了${successful}个新交易所的数据`)
    console.log(`📈 建议检查数据库确认数据质量和数量`)
  }
  
  if (failed > 0) {
    console.log(`\n🔧 建议单独重跑失败的脚本进行调试`)
  }
  
  console.log(`\n💡 查看数据库状态:`)
  console.log(`   psql "$DB_URL" -c "SELECT source, COUNT(*) FROM trader_sources GROUP BY source ORDER BY count DESC;"`)
  
  console.log(`${'='.repeat(80)}`)
  
  process.exit(failed > 0 ? 1 : 0)
}

// 处理Ctrl+C
process.on('SIGINT', () => {
  console.log(`\n\n⚠️  收到中断信号，正在退出...`)
  process.exit(1)
})

main().catch(error => {
  console.error(`❌ 批量执行出错: ${error.message}`)
  process.exit(1)
})