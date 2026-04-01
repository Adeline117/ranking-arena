import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(url, key)

// Check health_check_runs for last 24h
const { data, error } = await supabase
  .from('health_check_runs')
  .select('task_name, status, created_at, error_message')
  .gte('created_at', new Date(Date.now() - 24*60*60*1000).toISOString())
  .order('created_at', { ascending: false })

if (error) {
  console.error('Error:', error)
  process.exit(1)
}

// Calculate stats
const stats = {}
let totalTasks = 0
let successCount = 0
let errorCount = 0
let staleCount = 0

data.forEach(row => {
  totalTasks++
  if (!stats[row.task_name]) {
    stats[row.task_name] = { success: 0, error: 0, stale: 0, recent_errors: [] }
  }
  stats[row.task_name][row.status]++
  
  if (row.status === 'success') successCount++
  else if (row.status === 'error') errorCount++
  else if (row.status === 'stale') staleCount++
  
  if (row.status === 'error' && stats[row.task_name].recent_errors.length < 3) {
    stats[row.task_name].recent_errors.push({
      time: row.created_at,
      error: row.error_message
    })
  }
})

console.log('=== Arena Pipeline Health Report ===\n')
console.log(`Total health checks (24h): ${totalTasks}`)
console.log(`Success: ${successCount} (${((successCount/totalTasks)*100).toFixed(1)}%)`)
console.log(`Error: ${errorCount} (${((errorCount/totalTasks)*100).toFixed(1)}%)`)
console.log(`Stale: ${staleCount} (${((staleCount/totalTasks)*100).toFixed(1)}%)`)
console.log(`\nHealth Rate: ${((successCount/totalTasks)*100).toFixed(1)}%\n`)

console.log('=== Problem Tasks (with errors) ===\n')
Object.entries(stats)
  .filter(([_, s]) => s.error > 0)
  .sort((a, b) => b[1].error - a[1].error)
  .forEach(([task, s]) => {
    console.log(`${task}:`)
    console.log(`  Success: ${s.success}, Error: ${s.error}, Stale: ${s.stale}`)
    if (s.recent_errors.length > 0) {
      console.log(`  Recent errors:`)
      s.recent_errors.forEach(e => {
        console.log(`    [${e.time}] ${e.error?.substring(0, 100) || 'unknown'}`)
      })
    }
    console.log()
  })

console.log('=== Enrichment Tasks ===\n')
Object.entries(stats)
  .filter(([name, _]) => name.includes('enrich'))
  .forEach(([task, s]) => {
    console.log(`${task}: Success=${s.success}, Error=${s.error}, Stale=${s.stale}`)
  })

console.log('\n=== Trader Fetch Tasks ===\n')
Object.entries(stats)
  .filter(([name, _]) => name.includes('trader'))
  .forEach(([task, s]) => {
    console.log(`${task}: Success=${s.success}, Error=${s.error}, Stale=${s.stale}`)
  })
