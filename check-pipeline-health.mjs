import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(url, key)

console.log('=== Arena Pipeline Health Check ===\n')

// Check pipeline_metrics
console.log('1. Checking pipeline_metrics (last 24h)...\n')
const { data: metrics, error: metricsError } = await supabase
  .from('pipeline_metrics')
  .select('*')
  .gte('created_at', new Date(Date.now() - 24*60*60*1000).toISOString())
  .order('created_at', { ascending: false })

if (metricsError) {
  console.error('Error fetching metrics:', metricsError)
} else {
  console.log(`Total metrics recorded: ${metrics.length}`)
  
  // Group by source and metric_type
  const stats = {}
  metrics.forEach(m => {
    if (!stats[m.source]) {
      stats[m.source] = { success: 0, error: 0, duration_avg: [], records: 0 }
    }
    if (m.metric_type === 'fetch_success') stats[m.source].success++
    else if (m.metric_type === 'fetch_error') stats[m.source].error++
    else if (m.metric_type === 'fetch_duration') stats[m.source].duration_avg.push(m.value)
    else if (m.metric_type === 'record_count') stats[m.source].records += m.value
  })
  
  // Calculate health scores
  const sources = Object.entries(stats).map(([source, s]) => {
    const total = s.success + s.error
    const successRate = total > 0 ? (s.success / total * 100) : 0
    const avgDuration = s.duration_avg.length > 0 
      ? s.duration_avg.reduce((a,b) => a+b, 0) / s.duration_avg.length 
      : 0
    return {
      source,
      success: s.success,
      error: s.error,
      successRate: successRate.toFixed(1) + '%',
      avgDuration: avgDuration.toFixed(0) + 'ms',
      records: s.records
    }
  }).sort((a, b) => b.error - a.error)
  
  console.log('\n=== Sources with Errors ===')
  sources.filter(s => s.error > 0).forEach(s => {
    console.log(`${s.source}: ${s.success} success, ${s.error} errors (${s.successRate} success rate)`)
  })
  
  console.log('\n=== Top Sources by Activity ===')
  sources.slice(0, 10).forEach(s => {
    console.log(`${s.source}: ${s.success + s.error} runs, ${s.records} records, ${s.avgDuration} avg`)
  })
}

// Check cron_logs
console.log('\n\n2. Checking cron_logs (last 24h)...\n')
const { data: logs, error: logsError } = await supabase
  .from('cron_logs')
  .select('*')
  .gte('created_at', new Date(Date.now() - 24*60*60*1000).toISOString())
  .order('created_at', { ascending: false })

if (logsError) {
  console.error('Error fetching logs:', logsError)
} else {
  console.log(`Total cron runs: ${logs.length}`)
  
  // Group by endpoint
  const cronStats = {}
  logs.forEach(log => {
    const endpoint = log.endpoint || 'unknown'
    if (!cronStats[endpoint]) {
      cronStats[endpoint] = { success: 0, error: 0, recent_errors: [] }
    }
    if (log.status === 'success') {
      cronStats[endpoint].success++
    } else {
      cronStats[endpoint].error++
      if (cronStats[endpoint].recent_errors.length < 3) {
        cronStats[endpoint].recent_errors.push({
          time: log.created_at,
          error: log.error_message
        })
      }
    }
  })
  
  console.log('\n=== Cron Tasks with Errors ===')
  Object.entries(cronStats)
    .filter(([_, s]) => s.error > 0)
    .sort((a, b) => b[1].error - a[1].error)
    .forEach(([endpoint, s]) => {
      const total = s.success + s.error
      const rate = (s.success / total * 100).toFixed(1)
      console.log(`\n${endpoint}:`)
      console.log(`  Runs: ${total}, Success: ${s.success}, Error: ${s.error} (${rate}% success rate)`)
      if (s.recent_errors.length > 0) {
        console.log(`  Recent errors:`)
        s.recent_errors.forEach(e => {
          const msg = e.error?.substring(0, 150) || 'unknown error'
          console.log(`    [${new Date(e.time).toLocaleString()}] ${msg}`)
        })
      }
    })
    
  // Focus on enrichment and trader tasks
  console.log('\n\n=== ENRICHMENT Tasks ===')
  Object.entries(cronStats)
    .filter(([name, _]) => name.includes('enrich'))
    .forEach(([endpoint, s]) => {
      const total = s.success + s.error
      const rate = (s.success / total * 100).toFixed(1)
      console.log(`${endpoint}: ${s.success}/${total} (${rate}%)`)
    })
    
  console.log('\n=== TRADER FETCH Tasks ===')
  Object.entries(cronStats)
    .filter(([name, _]) => name.includes('trader'))
    .forEach(([endpoint, s]) => {
      const total = s.success + s.error
      const rate = (s.success / total * 100).toFixed(1)
      console.log(`${endpoint}: ${s.success}/${total} (${rate}%)`)
    })
}

// Overall health
const totalMetrics = metrics?.length || 0
const totalLogs = logs?.length || 0
console.log(`\n\n=== OVERALL HEALTH ===`)
console.log(`Pipeline metrics recorded: ${totalMetrics}`)
console.log(`Cron logs recorded: ${totalLogs}`)
console.log(`\n✅ Check complete`)
