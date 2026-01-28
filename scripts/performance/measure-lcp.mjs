#!/usr/bin/env node
/**
 * LCP (Largest Contentful Paint) 测量脚本
 * 使用 Lighthouse 测试页面性能
 *
 * Usage:
 *   node scripts/performance/measure-lcp.mjs <url>
 *   node scripts/performance/measure-lcp.mjs https://your-staging-url.vercel.app
 */

import { execSync } from 'child_process'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'

const TARGET_URL = process.argv[2] || 'http://localhost:3000'

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
}

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`)
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(2)}s`
}

function formatScore(score) {
  if (score >= 90) return `${colors.green}${score}${colors.reset}`
  if (score >= 50) return `${colors.yellow}${score}${colors.reset}`
  return `${colors.red}${score}${colors.reset}`
}

function getLCPRating(lcp) {
  if (lcp <= 1500) return { rating: 'Good', color: 'green' }
  if (lcp <= 2500) return { rating: 'Needs Improvement', color: 'yellow' }
  return { rating: 'Poor', color: 'red' }
}

async function measurePerformance() {
  log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'blue')
  log('  📊 Ranking Arena - LCP Performance Measurement', 'bright')
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n', 'blue')

  log(`Target URL: ${TARGET_URL}`, 'cyan')
  log(`Running Lighthouse audit...\n`)

  try {
    // 检查是否安装了 lighthouse
    try {
      execSync('npx lighthouse --version', { stdio: 'pipe' })
    } catch {
      log('⚠️  Lighthouse not found. Installing...', 'yellow')
      execSync('npm install -g lighthouse', { stdio: 'inherit' })
    }

    // 运行 Lighthouse
    const outputPath = join(process.cwd(), '.lighthouse-report.json')
    const command = `npx lighthouse ${TARGET_URL} \
      --only-categories=performance \
      --output=json \
      --output-path="${outputPath}" \
      --chrome-flags="--headless --no-sandbox" \
      --quiet`

    log('Running audit (this may take 30-60 seconds)...', 'cyan')
    execSync(command, { stdio: 'pipe' })

    // 读取结果
    if (!existsSync(outputPath)) {
      throw new Error('Lighthouse report not found')
    }

    const report = JSON.parse(require('fs').readFileSync(outputPath, 'utf8'))
    const { audits, categories } = report

    // 提取关键指标
    const performanceScore = Math.round(categories.performance.score * 100)
    const lcp = audits['largest-contentful-paint'].numericValue
    const fcp = audits['first-contentful-paint'].numericValue
    const tti = audits['interactive'].numericValue
    const tbt = audits['total-blocking-time'].numericValue
    const cls = audits['cumulative-layout-shift'].numericValue
    const si = audits['speed-index'].numericValue

    // LCP 评级
    const lcpRating = getLCPRating(lcp)

    // 显示结果
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'blue')
    log('  📈 Performance Metrics', 'bright')
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n', 'blue')

    log(`Overall Performance Score: ${formatScore(performanceScore)}/100\n`)

    log('Core Web Vitals:', 'bright')
    log(`  LCP (Largest Contentful Paint): ${colors[lcpRating.color]}${formatDuration(lcp)}${colors.reset} - ${lcpRating.rating}`)
    log(`    Target: < 1.5s (Good) | < 2.5s (Needs Improvement)`)
    log(`    Status: ${lcp <= 1500 ? '✅ Meets target!' : lcp <= 2500 ? '⚠️  Close to target' : '❌ Needs optimization'}`)

    log(`\n  CLS (Cumulative Layout Shift): ${cls < 0.1 ? colors.green : cls < 0.25 ? colors.yellow : colors.red}${cls.toFixed(3)}${colors.reset}`)
    log(`    Target: < 0.1 (Good)`)
    log(`    Status: ${cls < 0.1 ? '✅ Good' : cls < 0.25 ? '⚠️  Needs Improvement' : '❌ Poor'}`)

    log(`\nOther Metrics:`, 'bright')
    log(`  FCP (First Contentful Paint): ${formatDuration(fcp)}`)
    log(`  SI (Speed Index): ${formatDuration(si)}`)
    log(`  TTI (Time to Interactive): ${formatDuration(tti)}`)
    log(`  TBT (Total Blocking Time): ${Math.round(tbt)}ms`)

    // 性能建议
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'blue')
    log('  💡 Optimization Opportunities', 'bright')
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n', 'blue')

    // 获取优化建议
    const opportunities = Object.values(audits).filter(
      audit => audit.details?.type === 'opportunity' && audit.score !== null && audit.score < 1
    )

    if (opportunities.length > 0) {
      opportunities
        .sort((a, b) => (b.details.overallSavingsMs || 0) - (a.details.overallSavingsMs || 0))
        .slice(0, 5)
        .forEach((opp, index) => {
          const savings = opp.details.overallSavingsMs
          if (savings > 0) {
            log(`${index + 1}. ${opp.title}`)
            log(`   Potential savings: ${formatDuration(savings)}`, 'cyan')
          }
        })
    } else {
      log('✅ No major optimization opportunities found!', 'green')
    }

    // 保存结果摘要
    const summary = {
      url: TARGET_URL,
      timestamp: new Date().toISOString(),
      performanceScore,
      metrics: {
        lcp: { value: lcp, rating: lcpRating.rating, target: 1500 },
        fcp: { value: fcp },
        cls: { value: cls, target: 0.1 },
        tti: { value: tti },
        tbt: { value: tbt },
        si: { value: si },
      },
    }

    const summaryPath = join(process.cwd(), '.lighthouse-summary.json')
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2))

    log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'blue')
    log(`\n📝 Full report saved to: ${outputPath}`, 'cyan')
    log(`📊 Summary saved to: ${summaryPath}\n`, 'cyan')

    // 返回状态码
    if (lcp <= 1500) {
      log('✅ LCP target achieved! (< 1.5s)\n', 'green')
      process.exit(0)
    } else if (lcp <= 2500) {
      log('⚠️  LCP close to target (< 2.5s). Further optimization recommended.\n', 'yellow')
      process.exit(0)
    } else {
      log('❌ LCP needs optimization (> 2.5s)\n', 'red')
      process.exit(1)
    }
  } catch (error) {
    log(`\n❌ Error running Lighthouse: ${error.message}`, 'red')
    process.exit(1)
  }
}

// 运行测试
measurePerformance()
