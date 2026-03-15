#!/usr/bin/env node
/**
 * Quick test script to verify enrichment timeout fix
 * Tests a small platform (drift, 7D period, limit 10 traders)
 */

const { runEnrichment } = require('./lib/cron/enrichment-runner.ts')

async function test() {
  console.log('Testing enrichment fix with drift platform (7D, 10 traders)...')
  const start = Date.now()
  
  try {
    const result = await runEnrichment({
      platform: 'drift',
      period: '7D',
      limit: 10,
      offset: 0
    })
    
    const duration = Date.now() - start
    console.log(`\n✓ SUCCESS - Completed in ${Math.round(duration / 1000)}s`)
    console.log(`  Enriched: ${result.summary.enriched}`)
    console.log(`  Failed: ${result.summary.failed}`)
    console.log(`  Total: ${result.summary.total}`)
    
    if (duration > 120000) {
      console.log(`\n⚠ WARNING: Took longer than 2 minutes (${Math.round(duration / 1000)}s)`)
    }
    
    process.exit(0)
  } catch (error) {
    const duration = Date.now() - start
    console.error(`\n✗ FAILED after ${Math.round(duration / 1000)}s:`, error.message)
    process.exit(1)
  }
}

test()
