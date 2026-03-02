#!/usr/bin/env node
/**
 * Test Exchange APIs
 * 验证4个交易所的API是否可以正常访问并返回数据
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

async function testHTXFutures() {
  console.log('\n🧪 Testing HTX Futures...')
  const url = 'https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=1&pageNo=1&pageSize=5'
  
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000)
    })
    const data = await res.json()
    
    if (data?.data?.itemList?.length > 0) {
      console.log('✅ HTX Futures: OK')
      console.log(`   Total: ${data.data.total}`)
      console.log(`   First trader: ${data.data.itemList[0].nickname || 'N/A'}`)
      console.log(`   Fields: userSign=${data.data.itemList[0].userSign}, roi=${data.data.itemList[0].roi}, winRate=${data.data.itemList[0].winRate}`)
      return true
    } else {
      console.log('❌ HTX Futures: Empty response')
      console.log(JSON.stringify(data, null, 2).slice(0, 500))
      return false
    }
  } catch (error) {
    console.log(`❌ HTX Futures: Error - ${error.message}`)
    return false
  }
}

async function testBinanceWeb3() {
  console.log('\n🧪 Testing Binance Web3...')
  const url = 'https://www.binance.com/bapi/composite/v1/public/marketing/copyTrade/lead-board/query'
  
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.binance.com',
        'Referer': 'https://www.binance.com/en/web3-wallet',
        'User-Agent': UA
      },
      body: JSON.stringify({
        pageNumber: 1,
        pageSize: 5,
        timeRange: 'WEEKLY',
        tradeType: 'SPOT',
        walletType: 'WEB3'
      }),
      signal: AbortSignal.timeout(10000)
    })
    const data = await res.json()
    
    if (data?.data?.list?.length > 0) {
      console.log('✅ Binance Web3: OK')
      console.log(`   Total: ${data.data.total}`)
      console.log(`   First trader: ${data.data.list[0].nickname || 'N/A'}`)
      console.log(`   Fields: encryptedUid=${data.data.list[0].encryptedUid}, roi=${data.data.list[0].roi}, winRate=${data.data.list[0].winRate}`)
      return true
    } else {
      console.log('❌ Binance Web3: Empty response')
      console.log(JSON.stringify(data, null, 2).slice(0, 500))
      return false
    }
  } catch (error) {
    console.log(`❌ Binance Web3: Error - ${error.message}`)
    return false
  }
}

async function testBingXSpot() {
  console.log('\n🧪 Testing BingX Spot...')
  console.log('⚠️  BingX requires signed headers — cannot test via simple HTTP')
  console.log('   Must use Playwright/Puppeteer (see scripts/import/import_bingx_mac.mjs)')
  return null
}

async function testBitgetFutures() {
  console.log('\n🧪 Testing Bitget Futures...')
  console.log('⚠️  Bitget requires Puppeteer API interception — cannot test via simple HTTP')
  console.log('   Must use Puppeteer (see scripts/import/import_bitget_spot_fast.mjs)')
  return null
}

async function main() {
  console.log('🚀 Testing Exchange APIs...\n')
  console.log('=' .repeat(60))
  
  const results = {
    htx: await testHTXFutures(),
    binance_web3: await testBinanceWeb3(),
    bingx: await testBingXSpot(),
    bitget: await testBitgetFutures(),
  }
  
  console.log('\n' + '='.repeat(60))
  console.log('\n📊 Test Results:')
  console.log(`  HTX Futures:    ${results.htx === true ? '✅ PASS' : results.htx === false ? '❌ FAIL' : '⚠️  SKIP'}`)
  console.log(`  Binance Web3:   ${results.binance_web3 === true ? '✅ PASS' : results.binance_web3 === false ? '❌ FAIL' : '⚠️  SKIP'}`)
  console.log(`  BingX Spot:     ${results.bingx === null ? '⚠️  SKIP (需要Playwright)' : '?'}`)
  console.log(`  Bitget Futures: ${results.bitget === null ? '⚠️  SKIP (需要Puppeteer)' : '?'}`)
  
  const passCount = Object.values(results).filter(r => r === true).length
  const failCount = Object.values(results).filter(r => r === false).length
  
  console.log(`\n  Passed: ${passCount}/2 (HTTP-testable APIs)`)
  
  if (failCount > 0) {
    console.log('\n❌ Some tests failed!')
    process.exit(1)
  } else {
    console.log('\n✅ All testable APIs working!')
  }
}

main().catch(console.error)
