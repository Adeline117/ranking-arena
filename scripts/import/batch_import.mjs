/**
 * 批量导入所有平台数据
 * 运行所有缺失或过期的平台导入脚本
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 需要导入的平台和对应的脚本
const IMPORT_SCRIPTS = [
  // 优先级高：有数据但过期的平台
  { name: 'binance_futures', script: 'import_binance_futures_api.mjs', args: ['90D'] },
  { name: 'bybit', script: 'import_bybit.mjs', args: ['90D'] },
  { name: 'bitget_futures', script: 'import_bitget_futures_v2.mjs', args: ['90D'] },
  { name: 'bitget_spot', script: 'import_bitget_spot_v2.mjs', args: ['90D'] },
  { name: 'mexc', script: 'import_mexc.mjs', args: ['90D'] },
  { name: 'coinex', script: 'import_coinex.mjs', args: ['90D'] },
  { name: 'kucoin', script: 'import_kucoin.mjs', args: ['90D'] },
  { name: 'okx_futures', script: 'import_okx_futures.mjs', args: ['90D'] },
  { name: 'htx_futures', script: 'import_htx_enhanced.mjs', args: ['90D'] },
  { name: 'weex', script: 'import_weex.mjs', args: ['90D'] },

  // 优先级高：链上/DEX平台
  { name: 'gmx', script: 'import_gmx_enhanced.mjs', args: ['90D'] },
  { name: 'hyperliquid', script: 'import_hyperliquid_enhanced.mjs', args: ['90D'] },
  { name: 'dydx', script: 'import_dydx_enhanced.mjs', args: ['90D'] },

  // 缺失的平台
  { name: 'bingx', script: 'import_bingx.mjs', args: ['90D'] },
  { name: 'gateio', script: 'import_gateio.mjs', args: ['90D'] },
  { name: 'bitmart', script: 'import_bitmart.mjs', args: ['90D'] },
  { name: 'phemex', script: 'import_phemex.mjs', args: ['90D'] },
  { name: 'xt', script: 'import_xt.mjs', args: ['90D'] },
  { name: 'pionex', script: 'import_pionex.mjs', args: ['90D'] },
  { name: 'lbank', script: 'import_lbank.mjs', args: ['90D'] },
  { name: 'blofin', script: 'import_blofin.mjs', args: ['90D'] },

  // 链上平台
  { name: 'kwenta', script: 'import_kwenta.mjs', args: ['90D'] },
  { name: 'gains', script: 'import_gains.mjs', args: ['90D'] },
  { name: 'mux', script: 'import_mux.mjs', args: ['90D'] },
]

function runScript(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Script exited with code ${code}`))
      }
    })

    proc.on('error', reject)
  })
}

async function main() {
  console.log('🚀 开始批量导入数据')
  console.log('=' .repeat(60))

  const results = {
    success: [],
    failed: [],
    skipped: [],
  }

  for (const { name, script, args } of IMPORT_SCRIPTS) {
    const scriptPath = join(__dirname, script)
    console.log(`\n📦 [${name}] 运行 ${script}...`)

    try {
      await runScript(scriptPath, args)
      results.success.push(name)
      console.log(`✅ [${name}] 导入成功`)
    } catch (error) {
      results.failed.push({ name, error: error.message })
      console.log(`❌ [${name}] 导入失败: ${error.message}`)
    }

    // 延迟防止 API 限制
    await new Promise(r => setTimeout(r, 2000))
  }

  console.log('\n' + '='.repeat(60))
  console.log('📊 导入结果汇总:')
  console.log(`  ✅ 成功: ${results.success.length} 个平台`)
  console.log(`  ❌ 失败: ${results.failed.length} 个平台`)

  if (results.failed.length > 0) {
    console.log('\n失败的平台:')
    results.failed.forEach(({ name, error }) => {
      console.log(`  - ${name}: ${error}`)
    })
  }
}

main().catch(console.error)
