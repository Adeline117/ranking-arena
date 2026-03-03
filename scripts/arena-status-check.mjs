#!/usr/bin/env node
/**
 * Arena基础设施部署状态检查
 */

import fs from 'fs'
import { execSync } from 'child_process'

console.log('📊 Arena基础设施部署状态\n')

// 检查1: Zod依赖
try {
  execSync('npm list zod', { stdio: 'ignore' })
  console.log('✅ Zod已安装')
} catch {
  console.log('❌ Zod未安装')
}

// 检查2: 验证文件
const validationFiles = [
  'lib/validation/trader-schema.ts',
  'lib/monitoring/anomaly-rules.ts',
  'scripts/health-check.mjs'
]
validationFiles.forEach(f => {
  console.log(fs.existsSync(f) ? `✅ ${f}` : `❌ ${f}`)
})

// 检查3: Uniswap v3 connector
console.log(fs.existsSync('lib/dex/connectors/uniswap-v3.ts') ? 
  '✅ Uniswap v3 connector' : 
  '❌ Uniswap v3 connector')

// 检查4: Cron
try {
  const cron = execSync('crontab -l').toString()
  console.log(cron.includes('health-check.mjs') ? 
    '✅ Health check cron' : 
    '❌ Health check cron')
} catch {
  console.log('❌ Health check cron')
}

console.log('\n完成检查')
