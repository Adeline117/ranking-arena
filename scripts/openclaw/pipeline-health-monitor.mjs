#!/usr/bin/env node
/**
 * Arena Pipeline Health Monitor (OpenClaw)
 * 
 * Checks current pipeline health and alerts only on REAL issues.
 * 
 * Key difference from broken monitoring:
 * - ✅ Checks jobs[].health_status (current state)
 * - ❌ Does NOT check recentFailures (historical records)
 * 
 * Usage:
 *   node scripts/openclaw/pipeline-health-monitor.mjs
 *   node scripts/openclaw/pipeline-health-monitor.mjs --verbose
 */

const CRON_SECRET = process.env.CRON_SECRET || 'arena-cron-secret-2025'
const API_URL = 'https://www.arenafi.org/api/health/pipeline'

const VERBOSE = process.argv.includes('--verbose')
const AUTO_CLEANUP = !process.argv.includes('--no-auto-cleanup')

/**
 * Auto-cleanup stuck logs via direct DB connection
 * Marks running logs >30min as timeout
 */
async function cleanupStuckLogs() {
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )
    
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    
    const { data: stuckLogs } = await supabase
      .from('pipeline_logs')
      .select('id, job_name')
      .eq('status', 'running')
      .lt('started_at', thirtyMinutesAgo)
    
    if (!stuckLogs || stuckLogs.length === 0) {
      return { cleaned: 0 }
    }
    
    const ids = stuckLogs.map(l => l.id)
    
    const { error } = await supabase
      .from('pipeline_logs')
      .update({
        status: 'timeout',
        ended_at: new Date().toISOString(),
        error_message: 'Auto-cleanup: running >30min without completion'
      })
      .in('id', ids)
    
    if (error) throw error
    
    if (VERBOSE) {
      console.log(`✅ Auto-cleaned ${stuckLogs.length} stuck logs`)
    }
    
    return { cleaned: stuckLogs.length, jobs: stuckLogs.map(l => l.job_name) }
  } catch (err) {
    console.error('⚠️  Auto-cleanup failed:', err.message)
    return { cleaned: 0, error: err.message }
  }
}

async function checkPipelineHealth() {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000) // 15s timeout
    
    const response = await fetch(API_URL, {
      headers: {
        'Authorization': `Bearer ${CRON_SECRET}`
      },
      signal: controller.signal
    })
    
    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = await response.json()
    
    // Extract current failed/stuck jobs (NOT from recentFailures!)
    const currentFailed = data.jobs.filter(j => j.health_status === 'failed')
    const currentStuck = data.jobs.filter(j => j.health_status === 'stuck')
    const currentStale = data.jobs.filter(j => j.health_status === 'stale')

    // Determine alert level
    const shouldAlert = currentFailed.length > 0 || currentStuck.length > 0 || currentStale.length > 0
    
    if (VERBOSE || shouldAlert) {
      console.log('🏟 Arena Pipeline Health Check')
      console.log(`\nStatus: ${getStatusEmoji(data.status)} ${data.status}`)
      console.log(`Timestamp: ${new Date(data.timestamp).toLocaleString()}`)
      console.log(`\nSummary:`)
      console.log(`  Healthy: ${data.summary.healthyJobs}/${data.summary.totalJobs}`)
      console.log(`  Failed: ${data.summary.failedJobs}`)
      console.log(`  Stuck: ${data.summary.stuckJobs}`)
      console.log(`  Stale: ${data.summary.staleJobs}`)
      console.log(`  Success Rate (7d): ${data.summary.avgSuccessRate7d}%`)
    }

    // Alert logic - CRITICAL (only stuck jobs or >5 failed)
    // Note: 3-4 historical failed jobs during recovery is normal
    if (currentStuck.length > 0 || currentFailed.length > 5) {
      // Auto-cleanup stuck logs before alerting
      if (AUTO_CLEANUP && currentStuck.length > 0) {
        const cleanupResult = await cleanupStuckLogs()
        if (cleanupResult.cleaned > 0) {
          console.log(`✅ Auto-cleaned ${cleanupResult.cleaned} stuck logs`)
          // Re-check after cleanup
          const recheckController = new AbortController()
          const recheckTimeoutId = setTimeout(() => recheckController.abort(), 15000)
          const recheckResponse = await fetch(API_URL, {
            headers: { 'Authorization': `Bearer ${CRON_SECRET}` },
            signal: recheckController.signal
          })
          clearTimeout(recheckTimeoutId)
          if (recheckResponse.ok) {
            const recheckData = await recheckResponse.json()
            const recheckStuck = recheckData.jobs.filter(j => j.health_status === 'stuck')
            if (recheckStuck.length === 0) {
              // All stuck jobs were false alarms - return healthy
              return {
                alert: false,
                level: 'HEALTHY',
                message: `✅ Auto-cleaned ${cleanupResult.cleaned} stuck logs. Pipeline now healthy.`,
                data: recheckData.summary
              }
            }
          }
        }
      }
      
      console.log('\n🚨 CRITICAL Issues:')
      
      if (currentStuck.length > 0) {
        console.log(`\n  Stuck Jobs (${currentStuck.length}):`)
        currentStuck.forEach(job => {
          const startedAt = new Date(job.started_at)
          const runningTime = Math.floor((Date.now() - startedAt.getTime()) / 60000)
          console.log(`    - ${job.job_name}: running ${runningTime}min`)
        })
      }

      if (currentFailed.length > 0) {
        console.log(`\n  Failed Jobs (${currentFailed.length}):`)
        currentFailed.slice(0, 5).forEach(job => {
          console.log(`    - ${job.job_name}: ${job.error_message || 'Unknown error'}`)
        })
      }

      return {
        alert: true,
        level: 'CRITICAL',
        message: buildAlertMessage(currentFailed, currentStuck, currentStale),
        data: { failed: currentFailed.length, stuck: currentStuck.length, stale: currentStale.length }
      }
    }

    // Alert logic - DEGRADED
    if (currentFailed.length > 0 || currentStale.length > 0) {
      console.log('\n⚠️  DEGRADED:')
      
      if (currentFailed.length > 0) {
        console.log(`\n  Failed Jobs (${currentFailed.length}):`)
        currentFailed.forEach(job => {
          console.log(`    - ${job.job_name}: ${job.error_message || 'Unknown error'}`)
        })
      }

      if (currentStale.length > 0) {
        console.log(`\n  Stale Jobs (${currentStale.length}):`)
        currentStale.forEach(job => {
          console.log(`    - ${job.job_name}`)
        })
      }

      return {
        alert: true,
        level: 'DEGRADED',
        message: buildAlertMessage(currentFailed, currentStuck, currentStale),
        data: { failed: currentFailed.length, stuck: currentStuck.length, stale: currentStale.length }
      }
    }

    // All good
    if (VERBOSE) {
      console.log('\n✅ All systems healthy')
    }

    return {
      alert: false,
      level: 'HEALTHY',
      message: `✅ Pipeline healthy: ${data.summary.healthyJobs}/${data.summary.totalJobs} jobs`,
      data: data.summary
    }

  } catch (error) {
    const isTimeout = error.name === 'AbortError'
    const errorMsg = isTimeout ? 'Request timeout (>15s)' : error.message
    console.error('❌ Error checking pipeline health:', errorMsg)
    return {
      alert: true,
      level: 'ERROR',
      message: `❌ Pipeline health check failed: ${errorMsg}`,
      data: null
    }
  }
}

function getStatusEmoji(status) {
  switch (status) {
    case 'healthy': return '✅'
    case 'degraded': return '⚠️'
    case 'critical': return '🚨'
    default: return '❓'
  }
}

function buildAlertMessage(failed, stuck, stale) {
  const parts = []
  
  if (stuck.length > 0) {
    parts.push(`${stuck.length} stuck`)
  }
  if (failed.length > 0) {
    parts.push(`${failed.length} failed`)
  }
  if (stale.length > 0) {
    parts.push(`${stale.length} stale`)
  }

  const statusEmoji = stuck.length > 0 || failed.length > 3 ? '🚨' : '⚠️'
  const statusText = stuck.length > 0 || failed.length > 3 ? 'CRITICAL' : 'DEGRADED'
  
  let message = `${statusEmoji} Arena Pipeline ${statusText}: ${parts.join(', ')}\n`

  // Add details for failed jobs (top 5)
  if (failed.length > 0) {
    message += '\nFailed:\n'
    failed.slice(0, 5).forEach(job => {
      const errorShort = (job.error_message || 'Unknown').slice(0, 80)
      message += `  ❌ ${job.job_name}: ${errorShort}\n`
    })
  }

  // Add details for stuck jobs
  if (stuck.length > 0) {
    message += '\nStuck:\n'
    stuck.forEach(job => {
      const startedAt = new Date(job.started_at)
      const runningTime = Math.floor((Date.now() - startedAt.getTime()) / 60000)
      message += `  ⏱️  ${job.job_name}: ${runningTime}min\n`
    })
  }

  return message.trim()
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await checkPipelineHealth()
  
  // Exit code: 0 = healthy, 1 = degraded, 2 = critical
  if (result.level === 'CRITICAL' || result.level === 'ERROR') {
    process.exit(2)
  } else if (result.level === 'DEGRADED') {
    process.exit(1)
  } else {
    process.exit(0)
  }
}

export { checkPipelineHealth }
