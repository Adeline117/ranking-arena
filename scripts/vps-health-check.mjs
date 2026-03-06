#!/usr/bin/env node
/**
 * VPS 数据新鲜度检查 + 自动恢复
 *
 * 检查各平台数据是否过期 (>4h)，过期则重新导入。
 * 通过 cron 每 2 小时在 VPS 上运行。
 *
 * 用法: node scripts/vps-health-check.mjs
 *
 * 环境变量:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY - 数据库访问
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID - 告警（可选）
 */
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const STALE_THRESHOLD_HOURS = 4

const VPS_PLATFORMS = {
  binance_futures: 'import_binance_futures_v2.mjs',
  binance_spot: 'import_binance_spot_v2.mjs',
  binance_web3: 'import_binance_web3_v2.mjs',
  bybit: 'import_bybit_v2.mjs',
  bybit_spot: 'import_bybit_spot.mjs',
  bitget_futures: 'import_bitget_futures_v2.mjs',
  bitget_spot: 'import_bitget_spot_v2.mjs',
  htx_futures: 'import_htx_futures.mjs',
}

async function checkFreshness() {
  const stale = []
  
  for (const [source, script] of Object.entries(VPS_PLATFORMS)) {
    const { data } = await supabase
      .from('trader_snapshots')
      .select('captured_at')
      .eq('source', source)
      .order('captured_at', { ascending: false })
      .limit(1)
    
    if (!data?.[0]) {
      console.log(`  ${source}: 无数据 — 需要恢复`)
      stale.push({ source, script, age: Infinity })
      continue
    }
    
    const ageHours = (Date.now() - new Date(data[0].captured_at).getTime()) / 3600000
    if (ageHours > STALE_THRESHOLD_HOURS) {
      console.log(`  ${source}: ${ageHours.toFixed(1)}h 过期 — 需要恢复`)
      stale.push({ source, script, age: ageHours })
    } else {
      console.log(`  ${source}: ${ageHours.toFixed(1)}h — 正常`)
    }
  }
  
  return stale
}

async function recover(stale) {
  if (!stale.length) {
    console.log('\n\u{2705} 所有平台数据新鲜，无需恢复')
    return
  }
  
  console.log(`\n\u{1F504} 恢复 ${stale.length} 个过期平台...`)
  
  for (const item of stale) {
    const scriptPath = `/opt/ranking-arena/scripts/import/${item.script}`
    console.log(`  运行 ${item.script}...`)
    try {
      execSync(`timeout 600 node ${scriptPath} ALL`, {
        cwd: '/opt/ranking-arena',
        stdio: 'pipe',
        timeout: 620000,
      })
      console.log(`  \u{2705} ${item.source} 已恢复`)
    } catch (e) {
      const errMsg = e.message?.slice(0, 100) || '未知'
      console.log(`  \u{274C} ${item.source} 恢复失败: ${errMsg}`)
      item.recoveryFailed = true
      item.error = errMsg
    }
  }
  
  console.log('\n  重新计算排行榜...')
  try {
    execSync('timeout 300 node /opt/ranking-arena/scripts/compute-leaderboard-local.mjs', {
      cwd: '/opt/ranking-arena',
      stdio: 'pipe',
      timeout: 310000,
    })
    console.log('  \u{2705} 排行榜已重新计算')
  } catch (e) {
    console.log(`  \u{274C} 排行榜重算失败: ${e.message?.slice(0, 100)}`)
  }
}

async function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID
  if (!token || !chatId) return

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
    })
  } catch (e) {
    console.log(`  告警发送失败: ${e.message}`)
  }
}

async function main() {
  console.log(`=== VPS 健康检查 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} ===\n`)
  const stale = await checkFreshness()
  await recover(stale)

  // 只在恢复失败时发 Telegram
  const failed = stale.filter(s => s.recoveryFailed)
  if (failed.length > 0) {
    const msg = `<b>\u{1F534} VPS 恢复失败</b>\n${failed.map(f => `${f.source}: ${f.error || '未知'}`).join('\n')}`
    await sendTelegramAlert(msg)
  }

  console.log('\n=== 完成 ===')
}

main().catch(e => { console.error(e); process.exit(1) })
