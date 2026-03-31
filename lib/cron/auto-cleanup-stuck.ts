/**
 * 自动清理stuck pipeline任务
 * 每小时运行，kill超过2小时的running任务
 * 防止任务累积影响pipeline健康度
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import { captureMessage } from '@sentry/nextjs'
import { logger } from '@/lib/logger'

const STUCK_THRESHOLD_HOURS = 2
const MAX_STUCK_WARNING = 50 // 超过50个stuck任务发送告警

export async function autoCleanupStuckJobs() {
  const startTime = Date.now()
  logger.info('[auto-cleanup-stuck] Starting cleanup...')
  
  try {
    const supabase = getSupabaseAdmin()
    const thresholdTime = new Date(Date.now() - STUCK_THRESHOLD_HOURS * 60 * 60 * 1000).toISOString()
    
    // 1. 查询stuck任务数量
    const { count: stuckCount, error: countError } = await supabase
      .from('pipeline_logs')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'running')
      .lt('started_at', thresholdTime)
      .is('ended_at', null)
    
    if (countError) {
      throw new Error(`Count query failed: ${countError.message}`)
    }
    
    if (!stuckCount || stuckCount === 0) {
      logger.info('[auto-cleanup-stuck] ✅ No stuck jobs')
      return { cleaned: 0, duration: Date.now() - startTime }
    }
    
    logger.warn(`[auto-cleanup-stuck] Found ${stuckCount} stuck jobs`)
    
    // 2. 如果超过阈值，发送告警
    if (stuckCount > MAX_STUCK_WARNING) {
      captureMessage(`🚨 High stuck job count: ${stuckCount} jobs stuck >${STUCK_THRESHOLD_HOURS}h`, {
        level: 'warning',
        tags: {
          component: 'auto-cleanup',
          stuck_count: stuckCount.toString(),
        },
      })
      
      // 发送Telegram告警（如果配置了）
      if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ALERT_CHAT_ID) {
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: process.env.TELEGRAM_ALERT_CHAT_ID,
            text: `🚨 Arena Pipeline Alert\n\n${stuckCount} jobs stuck >${STUCK_THRESHOLD_HOURS}h\n\nAuto-cleanup started.`,
          }),
        }).catch((err: unknown) => logger.error('Telegram alert failed', { error: err instanceof Error ? err.message : String(err) }))
      }
    }
    
    // 3. 批量kill stuck任务
    const { data, error: updateError } = await supabase
      .from('pipeline_logs')
      .update({
        ended_at: new Date().toISOString(),
        status: 'auto_timeout',
        error_message: `Auto-killed: stuck >${STUCK_THRESHOLD_HOURS}h`,
      })
      .eq('status', 'running')
      .lt('started_at', thresholdTime)
      .is('ended_at', null)
      .select()
    
    if (updateError) {
      throw new Error(`Update failed: ${updateError.message}`)
    }
    
    const cleaned = data?.length || 0
    const duration = Date.now() - startTime
    
    logger.info(`[auto-cleanup-stuck] ✅ Cleaned ${cleaned} jobs in ${duration}ms`)
    
    // 4. 如果清理数量与预期不符，发送警告
    if (stuckCount && cleaned < stuckCount) {
      captureMessage(`⚠️  Cleanup mismatch: found ${stuckCount}, cleaned ${cleaned}`, {
        level: 'warning',
        tags: { component: 'auto-cleanup' },
      })
    }
    
    return { cleaned, duration, stuckCount: stuckCount || 0 }
    
  } catch (error) {
    logger.error('[auto-cleanup-stuck] ❌ Error:', {}, error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    captureMessage(`Auto-cleanup failed: ${errorMessage}`, {
      level: 'error',
      tags: { component: 'auto-cleanup' },
    })
    throw error
  }
}
