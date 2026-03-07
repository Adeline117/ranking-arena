/**
 * Test script for exchange scrapers
 * 
 * Usage:
 *   npx tsx scripts/test-scrapers.ts bybit
 *   npx tsx scripts/test-scrapers.ts mexc
 *   npx tsx scripts/test-scrapers.ts htx
 *   npx tsx scripts/test-scrapers.ts all
 */

import { scrapeBybitBatch } from '../lib/cron/scrapers/bybit-scraper'
import { scrapeMexcBatch } from '../lib/cron/scrapers/mexc-scraper'
import { scrapeHtxBatch } from '../lib/cron/scrapers/htx-scraper'

async function testBybit() {
  console.log('\n🔄 Testing Bybit scraper...')
  const start = Date.now()
  
  try {
    const results = await scrapeBybitBatch(['30D'], 50)
    const duration = ((Date.now() - start) / 1000).toFixed(1)
    
    console.log(`✅ Bybit completed in ${duration}s`)
    
    for (const [period, data] of Object.entries(results)) {
      const count = data?.result?.leaderDetails?.length || 0
      console.log(`   ${period}: ${count} traders`)
      
      if (count > 0) {
        const sample = data.result!.leaderDetails![0]
        console.log(`   Sample: ${sample.nickName} - ROI: ${sample.metricValues?.[0]}`)
      }
    }
    
    return results
  } catch (err) {
    console.error(`❌ Bybit failed: ${err instanceof Error ? err.message : err}`)
    throw err
  }
}

async function testMexc() {
  console.log('\n🔄 Testing MEXC scraper...')
  const start = Date.now()
  
  try {
    const results = await scrapeMexcBatch(['30D'])
    const duration = ((Date.now() - start) / 1000).toFixed(1)
    
    console.log(`✅ MEXC completed in ${duration}s`)
    
    for (const [period, data] of Object.entries(results)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = data?.data as any
      const list: unknown[] =
        d?.resultList || d?.list || d?.comprehensives || (Array.isArray(d) ? d : [])
      
      console.log(`   ${period}: ${list.length} traders`)
      
      if (list.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sample = list[0] as any
        const name = sample.nickName || sample.nickname || sample.name
        console.log(`   Sample: ${name} - ROI: ${sample.roi}`)
      }
    }
    
    return results
  } catch (err) {
    console.error(`❌ MEXC failed: ${err instanceof Error ? err.message : err}`)
    throw err
  }
}

async function testHtx() {
  console.log('\n🔄 Testing HTX scraper...')
  const start = Date.now()
  
  try {
    const result = await scrapeHtxBatch()
    const duration = ((Date.now() - start) / 1000).toFixed(1)
    
    console.log(`✅ HTX completed in ${duration}s`)
    
    const list = result?.data?.itemList || []
    console.log(`   Got ${list.length} traders`)
    
    if (list.length > 0) {
      const sample = list[0]
      console.log(`   Sample: ${sample.nickName} - ROI: ${sample.profitRate90}`)
    }
    
    return result
  } catch (err) {
    console.error(`❌ HTX failed: ${err instanceof Error ? err.message : err}`)
    throw err
  }
}

async function main() {
  const target = process.argv[2] || 'all'
  
  console.log('🚀 Exchange Scraper Test Suite')
  console.log(`Target: ${target}`)
  
  const totalStart = Date.now()
  
  try {
    if (target === 'bybit' || target === 'all') {
      await testBybit()
    }
    
    if (target === 'mexc' || target === 'all') {
      await testMexc()
    }
    
    if (target === 'htx' || target === 'all') {
      await testHtx()
    }
    
    const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(1)
    console.log(`\n✅ All tests completed in ${totalDuration}s`)
    
  } catch (err) {
    console.error('\n❌ Test suite failed:', err)
    process.exit(1)
  }
}

main()
