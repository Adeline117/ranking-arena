#!/usr/bin/env node

/**
 * 数据健康检查脚本
 * 
 * 功能：
 * - 检查所有交易所数据新鲜度
 * - 检查数据完整性
 * - 检测异常数据
 * - 发送Telegram告警
 * 
 * 运行方式：
 * - 手动: `node scripts/health-check.mjs`
 * - Cron: `0 * * * * node scripts/health-check.mjs` (每小时)
 * 
 * @see ~/ranking-arena/ARENA_DATA_INFRASTRUCTURE_UPGRADE.md#解决方案4-实时监控仪表板
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ''
)

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_ALERT_CHANNEL_ID || process.env.TELEGRAM_CHAT_ID

/**
 * 发送Telegram告警
 */
async function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[WARNING] Telegram credentials not configured, skipping alert')
    console.log('[ALERT]', message)
    return
  }
  
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'Markdown',
        }),
      }
    )
    
    if (!response.ok) {
      console.error('[ERROR] Failed to send Telegram alert:', await response.text())
    }
  } catch (error) {
    console.error('[ERROR] Telegram API error:', error)
  }
}

/**
 * 检查1: 数据新鲜度
 * 如果某个交易所超过6小时未更新，发送告警
 */
async function checkDataFreshness() {
  console.log('\n[CHECK 1] 数据新鲜度...')
  
  const { data, error } = await supabase.rpc('check_data_freshness', {
    max_hours: 6,
  })
  
  if (error) {
    console.error('[ERROR]', error)
    // 如果function不存在，使用备用查询
    const { data: fallbackData, error: fallbackError } = await supabase
      .from('trader_snapshots')
      .select('source')
      .select('MAX(captured_at) as last_capture', { count: 'exact' })
      .groupBy('source')
    
    if (fallbackError) {
      console.error('[ERROR] Fallback query failed:', fallbackError)
      return []
    }
    
    return fallbackData || []
  }
  
  return data || []
}

/**
 * 检查2: 数据完整性
 * 计算每个交易所的平均数据完整性评分
 */
async function checkDataCompleteness() {
  console.log('\n[CHECK 2] 数据完整性...')
  
  // 简化查询：统计每个source有多少字段不为NULL
  const { data, error } = await supabase
    .from('trader_snapshots')
    .select('source, roi, pnl, win_rate, max_drawdown, roi_7d, roi_30d, roi_90d')
    .gte('captured_at', new Date(Date.now() - 24 * 3600000).toISOString())
  
  if (error) {
    console.error('[ERROR]', error)
    return []
  }
  
  // 按source分组统计
  const bySource = {}
  
  for (const row of data || []) {
    if (!bySource[row.source]) {
      bySource[row.source] = { total: 0, nonNullCount: 0 }
    }
    
    bySource[row.source].total++
    
    // 统计非NULL字段数
    let nonNull = 0
    if (row.roi != null) nonNull++
    if (row.pnl != null) nonNull++
    if (row.win_rate != null) nonNull++
    if (row.max_drawdown != null) nonNull++
    if (row.roi_7d != null) nonNull++
    if (row.roi_30d != null) nonNull++
    if (row.roi_90d != null) nonNull++
    
    bySource[row.source].nonNullCount += nonNull
  }
  
  return Object.entries(bySource).map(([source, stats]) => ({
    source,
    avg_completeness: ((stats.nonNullCount / (stats.total * 7)) * 100).toFixed(1),
  }))
}

/**
 * 检查3: 异常数据
 * 检测异常高ROI、负交易次数等
 */
async function checkAnomalies() {
  console.log('\n[CHECK 3] 异常数据...')
  
  const anomalies = []
  
  // 异常高ROI
  const { data: highROI } = await supabase
    .from('trader_snapshots')
    .select('source, source_trader_id, roi')
    .gt('roi', 5000)
    .gte('captured_at', new Date(Date.now() - 24 * 3600000).toISOString())
  
  if (highROI && highROI.length > 0) {
    anomalies.push({
      type: 'high_roi',
      count: highROI.length,
      examples: highROI.slice(0, 3),
    })
  }
  
  // 负交易次数
  const { data: negativeTrades } = await supabase
    .from('trader_snapshots')
    .select('source, source_trader_id, trades_count')
    .lt('trades_count', 0)
    .gte('captured_at', new Date(Date.now() - 24 * 3600000).toISOString())
  
  if (negativeTrades && negativeTrades.length > 0) {
    anomalies.push({
      type: 'negative_trades_count',
      count: negativeTrades.length,
      examples: negativeTrades.slice(0, 3),
    })
  }
  
  // 正的最大回撤
  const { data: positiveMDD } = await supabase
    .from('trader_snapshots')
    .select('source, source_trader_id, max_drawdown')
    .gt('max_drawdown', 0)
    .gte('captured_at', new Date(Date.now() - 24 * 3600000).toISOString())
  
  if (positiveMDD && positiveMDD.length > 0) {
    anomalies.push({
      type: 'positive_max_drawdown',
      count: positiveMDD.length,
      examples: positiveMDD.slice(0, 3),
    })
  }
  
  return anomalies
}

/**
 * 主函数
 */
async function main() {
  console.log('='.repeat(60))
  console.log('🔍 Arena数据健康检查')
  console.log('时间:', new Date().toISOString())
  console.log('='.repeat(60))
  
  const issues = []
  
  // 检查1: 数据新鲜度
  const staleData = await checkDataFreshness()
  if (staleData.length > 0) {
    issues.push({
      severity: 'warning',
      category: '数据新鲜度',
      details: staleData.map(s => `${s.source}: 最后更新 ${s.last_capture}`),
    })
  }
  console.log(`✅ 检查1完成: ${staleData.length}个交易所数据过时`)
  
  // 检查2: 数据完整性
  const completeness = await checkDataCompleteness()
  const lowCompleteness = completeness.filter(c => parseFloat(c.avg_completeness) < 60)
  if (lowCompleteness.length > 0) {
    issues.push({
      severity: 'warning',
      category: '数据完整性',
      details: lowCompleteness.map(c => `${c.source}: ${c.avg_completeness}%`),
    })
  }
  console.log(`✅ 检查2完成: ${lowCompleteness.length}个交易所完整性<60%`)
  
  // 检查3: 异常数据
  const anomalies = await checkAnomalies()
  if (anomalies.length > 0) {
    issues.push({
      severity: anomalies.some(a => a.type === 'negative_trades_count' || a.type === 'positive_max_drawdown') 
        ? 'critical' 
        : 'warning',
      category: '异常数据',
      details: anomalies.map(a => `${a.type}: ${a.count}条记录`),
    })
  }
  console.log(`✅ 检查3完成: ${anomalies.length}种异常类型`)
  
  // 生成报告
  if (issues.length > 0) {
    const report = generateReport(issues)
    console.log('\n' + report)
    
    // 发送Telegram告警
    await sendTelegramAlert(report)
  } else {
    console.log('\n✅ 所有检查通过，数据健康！')
  }
  
  console.log('\n' + '='.repeat(60))
}

/**
 * 生成告警报告
 */
function generateReport(issues) {
  const criticalCount = issues.filter(i => i.severity === 'critical').length
  const warningCount = issues.filter(i => i.severity === 'warning').length
  
  let report = `
🔍 **Arena数据健康检查报告**
时间: ${new Date().toISOString()}

发现 ${issues.length} 个问题 (🔴 ${criticalCount} Critical | ⚠️  ${warningCount} Warning)

`
  
  issues.forEach((issue, index) => {
    const emoji = issue.severity === 'critical' ? '🔴' : '⚠️'
    report += `
${index + 1}. ${emoji} **${issue.category}** (${issue.severity})
${issue.details.map(d => `   - ${d}`).join('\n')}
`
  })
  
  report += `
---
_下次检查: 1小时后_
`
  
  return report
}

// 运行
main().catch(console.error)

/**
 * 需要在Supabase创建的辅助函数：
 * 
 * CREATE OR REPLACE FUNCTION check_data_freshness(max_hours INT DEFAULT 6)
 * RETURNS TABLE(source TEXT, last_capture TIMESTAMPTZ, hours_ago FLOAT)
 * LANGUAGE sql
 * AS $$
 *   SELECT 
 *     source,
 *     MAX(captured_at) as last_capture,
 *     EXTRACT(EPOCH FROM (NOW() - MAX(captured_at))) / 3600 as hours_ago
 *   FROM trader_snapshots
 *   GROUP BY source
 *   HAVING MAX(captured_at) < NOW() - INTERVAL '1 hour' * max_hours
 *   ORDER BY hours_ago DESC
 * $$;
 */
