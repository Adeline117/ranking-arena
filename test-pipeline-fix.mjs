/**
 * Test Pipeline Fix - Quick verification
 * 
 * Tests the deployed fixes without waiting for full cron cycle
 */

import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(url, key)

console.log('🧪 Testing Pipeline Fixes...\n')

// Test 1: Check if disabled platforms are no longer in metrics
console.log('Test 1: Verifying disabled platforms (dydx, phemex)...')
const { data: recentMetrics, error } = await supabase
  .from('pipeline_metrics')
  .select('source, metric_type, created_at')
  .gte('created_at', new Date(Date.now() - 60*60*1000).toISOString()) // Last hour
  .in('source', ['dydx', 'phemex'])
  .order('created_at', { ascending: false })
  .limit(10)

if (error) {
  console.error('  ❌ Error:', error.message)
} else if (recentMetrics.length === 0) {
  console.log('  ✅ No recent metrics for dydx/phemex (correctly disabled)')
} else {
  console.log(`  ⚠️  Found ${recentMetrics.length} recent metrics (may be from before deployment):`)
  recentMetrics.forEach(m => {
    console.log(`    - ${m.source}: ${m.metric_type} at ${new Date(m.created_at).toLocaleString()}`)
  })
}

// Test 2: Check recent error rates
console.log('\nTest 2: Checking error rates (last 3 hours)...')
const { data: recentErrors } = await supabase
  .from('pipeline_metrics')
  .select('source, metric_type, created_at')
  .eq('metric_type', 'fetch_error')
  .gte('created_at', new Date(Date.now() - 3*60*60*1000).toISOString())
  .order('created_at', { ascending: false })

const errorCount = {}
recentErrors?.forEach(e => {
  errorCount[e.source] = (errorCount[e.source] || 0) + 1
})

if (Object.keys(errorCount).length === 0) {
  console.log('  ✅ No errors in last 3 hours!')
} else {
  console.log('  Recent errors by platform:')
  Object.entries(errorCount)
    .sort((a, b) => b[1] - a[1])
    .forEach(([source, count]) => {
      console.log(`    - ${source}: ${count} errors`)
    })
}

// Test 3: Check success metrics for previously failing platforms
console.log('\nTest 3: Checking recovery for previously failing platforms...')
const targetPlatforms = ['okx_futures', 'mexc', 'etoro', 'gmx', 'bybit_spot']
for (const platform of targetPlatforms) {
  const { data: platformMetrics } = await supabase
    .from('pipeline_metrics')
    .select('metric_type, created_at')
    .eq('source', platform)
    .gte('created_at', new Date(Date.now() - 2*60*60*1000).toISOString())
    .order('created_at', { ascending: false })
  
  const success = platformMetrics?.filter(m => m.metric_type === 'fetch_success').length || 0
  const errors = platformMetrics?.filter(m => m.metric_type === 'fetch_error').length || 0
  const total = success + errors
  
  if (total === 0) {
    console.log(`  ${platform}: ⏳ No runs yet (waiting for next cron)`)
  } else {
    const rate = ((success / total) * 100).toFixed(1)
    const emoji = rate > 80 ? '✅' : rate > 50 ? '⚠️' : '❌'
    console.log(`  ${platform}: ${emoji} ${success}/${total} success (${rate}%)`)
  }
}

// Test 4: Calculate overall health
console.log('\nTest 4: Overall health calculation...')
const { data: allMetrics } = await supabase
  .from('pipeline_metrics')
  .select('metric_type')
  .gte('created_at', new Date(Date.now() - 24*60*60*1000).toISOString())

const totalSuccess = allMetrics?.filter(m => m.metric_type === 'fetch_success').length || 0
const totalErrors = allMetrics?.filter(m => m.metric_type === 'fetch_error').length || 0
const overallTotal = totalSuccess + totalErrors

if (overallTotal > 0) {
  const healthRate = ((totalSuccess / overallTotal) * 100).toFixed(1)
  const emoji = healthRate > 90 ? '🎉' : healthRate > 75 ? '✅' : healthRate > 60 ? '⚠️' : '❌'
  console.log(`  ${emoji} Overall Health Rate: ${healthRate}% (${totalSuccess}/${overallTotal})`)
  console.log(`     Target: >90%`)
  
  if (healthRate > 90) {
    console.log('\n🎊 SUCCESS! Health rate target achieved!')
  } else if (healthRate > parseFloat('57.7')) {
    console.log(`\n📈 IMPROVING! Health increased from 57.7% to ${healthRate}%`)
  } else {
    console.log(`\n⚠️  Still below target. May need more time or additional fixes.`)
  }
} else {
  console.log('  ⏳ No metrics yet - too early to assess')
}

console.log('\n✅ Test complete')
console.log('\nNext steps:')
console.log('1. Wait for next cron runs (Group A: every 3h, Group B/C: every 4-6h)')
console.log('2. Re-run this test in 3-6 hours')
console.log('3. Monitor: node check-pipeline-health.mjs')
