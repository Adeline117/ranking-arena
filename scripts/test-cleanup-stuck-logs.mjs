#!/usr/bin/env node
/**
 * Test script for cleanup-stuck-logs cron
 * 
 * Tests:
 * 1. Creates a fake stuck log (started 40 min ago, still running)
 * 2. Calls the cleanup API
 * 3. Verifies the log was marked as timeout
 * 
 * Usage:
 *   node scripts/test-cleanup-stuck-logs.mjs
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const CRON_SECRET = process.env.CRON_SECRET || 'arena-cron-secret-2025'
const API_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing Supabase env vars')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

async function testCleanupStuckLogs() {
  console.log('🧪 Testing cleanup-stuck-logs cron...\n')

  // Step 1: Create a fake stuck log (40 minutes ago)
  console.log('1️⃣  Creating fake stuck log (40 min ago)...')
  const fortyMinAgo = new Date(Date.now() - 40 * 60 * 1000).toISOString()
  
  const { data: insertedLog, error: insertError } = await supabase
    .from('pipeline_logs')
    .insert({
      job_name: 'test-stuck-job-cleanup',
      status: 'running',
      started_at: fortyMinAgo,
      metadata: { test: true },
    })
    .select('id')
    .single()

  if (insertError) {
    console.error('❌ Failed to create test log:', insertError.message)
    process.exit(1)
  }

  const testLogId = insertedLog.id
  console.log(`✅ Created test log ID: ${testLogId}\n`)

  // Step 2: Call cleanup API
  console.log('2️⃣  Calling cleanup API...')
  const response = await fetch(`${API_URL}/api/cron/cleanup-stuck-logs`, {
    headers: {
      'Authorization': `Bearer ${CRON_SECRET}`,
    },
  })

  if (!response.ok) {
    console.error(`❌ Cleanup API failed: HTTP ${response.status}`)
    const text = await response.text()
    console.error(text)
    process.exit(1)
  }

  const result = await response.json()
  console.log('✅ Cleanup API response:', JSON.stringify(result, null, 2))
  console.log()

  // Step 3: Verify the log was updated
  console.log('3️⃣  Verifying log was marked as timeout...')
  const { data: updatedLog, error: fetchError } = await supabase
    .from('pipeline_logs')
    .select('id, status, ended_at, error_message')
    .eq('id', testLogId)
    .single()

  if (fetchError) {
    console.error('❌ Failed to fetch updated log:', fetchError.message)
    process.exit(1)
  }

  if (updatedLog.status !== 'timeout') {
    console.error(`❌ Log status is ${updatedLog.status}, expected timeout`)
    console.error('Log:', updatedLog)
    process.exit(1)
  }

  if (!updatedLog.ended_at) {
    console.error('❌ Log ended_at is null, expected a timestamp')
    process.exit(1)
  }

  console.log('✅ Log was correctly marked as timeout')
  console.log(`   Status: ${updatedLog.status}`)
  console.log(`   Ended at: ${updatedLog.ended_at}`)
  console.log(`   Error: ${updatedLog.error_message}\n`)

  // Step 4: Cleanup test log
  console.log('4️⃣  Cleaning up test log...')
  await supabase.from('pipeline_logs').delete().eq('id', testLogId)
  console.log('✅ Test log deleted\n')

  console.log('🎉 All tests passed!')
}

testCleanupStuckLogs().catch(err => {
  console.error('❌ Test failed:', err)
  process.exit(1)
})
