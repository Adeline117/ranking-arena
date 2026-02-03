#!/usr/bin/env node
/**
 * 统一导入脚本 - 替代多个平台单独的导入脚本
 *
 * 用法:
 *   node scripts/import/unified-import.mjs binance_futures [7D|30D|90D]
 *   node scripts/import/unified-import.mjs bybit 30D
 *   node scripts/import/unified-import.mjs all        # 导入所有平台
 *   node scripts/import/unified-import.mjs cex        # 导入所有 CEX
 *   node scripts/import/unified-import.mjs dex        # 导入所有 DEX
 *
 * 支持的平台:
 *   CEX 合约: binance_futures, bybit, bitget_futures, okx_futures, mexc, kucoin
 *   CEX 现货: binance_spot, bitget_spot
 *   DEX: gmx, hyperliquid
 */

import { BaseImporter, runImporter } from '../lib/base-importer.mjs'
import { getAllPlatforms, getPlatformsByMarketType, getPlatformConfig } from '../lib/platform-config.mjs'
import { getTargetPeriods, log, sleep } from '../lib/shared.mjs'

const PLATFORM_GROUPS = {
  all: getAllPlatforms(),
  cex: [...getPlatformsByMarketType('futures'), ...getPlatformsByMarketType('spot')],
  dex: getPlatformsByMarketType('dex'),
  futures: getPlatformsByMarketType('futures'),
  spot: getPlatformsByMarketType('spot'),
}

async function main() {
  const arg = process.argv[2]?.toLowerCase()

  if (!arg || arg === '--help' || arg === '-h') {
    console.log(`
统一导入脚本

用法:
  node scripts/import/unified-import.mjs <platform|group> [period]

平台:
  ${getAllPlatforms().join(', ')}

平台组:
  all      - 所有平台
  cex      - 所有 CEX (合约 + 现货)
  dex      - 所有 DEX
  futures  - 所有合约平台
  spot     - 所有现货平台

时间段:
  7D, 30D, 90D (默认: 全部)

示例:
  node scripts/import/unified-import.mjs binance_futures 30D
  node scripts/import/unified-import.mjs all
  node scripts/import/unified-import.mjs cex 7D
`)
    process.exit(0)
  }

  const periods = getTargetPeriods()

  // 检查是否是平台组
  if (PLATFORM_GROUPS[arg]) {
    const platforms = PLATFORM_GROUPS[arg]
    log.info(`\n${'='.repeat(60)}`)
    log.info(`批量导入: ${arg} (${platforms.length} 个平台)`)
    log.info(`平台: ${platforms.join(', ')}`)
    log.info(`时间段: ${periods.join(', ')}`)
    log.info(`${'='.repeat(60)}\n`)

    const results = {}

    for (const platform of platforms) {
      try {
        log.info(`\n>>> 开始 ${platform} <<<`)
        const importer = new BaseImporter(platform)
        results[platform] = await importer.run(periods)
      } catch (error) {
        log.error(`${platform}: ${error.message}`)
        results[platform] = { error: error.message }
      }

      // 平台之间休息
      if (platforms.indexOf(platform) < platforms.length - 1) {
        await sleep(5000)
      }
    }

    // 打印汇总
    console.log('\n' + '='.repeat(60))
    console.log('导入汇总')
    console.log('='.repeat(60))
    for (const [platform, result] of Object.entries(results)) {
      if (result.error) {
        console.log(`❌ ${platform}: ${result.error}`)
      } else {
        const counts = Object.entries(result)
          .filter(([, v]) => v.success)
          .map(([k, v]) => `${k}:${v.count}`)
          .join(', ')
        console.log(`✅ ${platform}: ${counts || 'no data'}`)
      }
    }

    return
  }

  // 单个平台
  const config = getPlatformConfig(arg)
  if (!config) {
    log.error(`未知平台: ${arg}`)
    log.info(`可用平台: ${getAllPlatforms().join(', ')}`)
    process.exit(1)
  }

  await runImporter(arg)
}

main().catch(error => {
  log.error(error.message)
  process.exit(1)
})
