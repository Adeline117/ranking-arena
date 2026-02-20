#!/usr/bin/env node
/**
 * Debug: check what fields the Bybit listing API returns
 * and whether there's a memberId/userId field we can use
 */
import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteer.use(StealthPlugin())

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  })
  const page = await browser.newPage()
  await page.setUserAgent(UA)

  console.log('Visiting bybit.com to get cookies...')
  try {
    await page.goto('https://www.bybit.com/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(3000)
  } catch (e) {
    console.log('Warning:', e.message?.substring(0, 80))
  }

  // Fetch one page of listing to see full item structure
  const LIST_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list'
  const url = `${LIST_URL}?pageNo=1&pageSize=3&dataDuration=DATA_DURATION_SEVEN_DAY&sortField=LEADER_SORT_FIELD_SORT_ROI`
  
  const result = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
  const text = await page.evaluate(() => document.body?.innerText || '')
  
  if (text && !text.startsWith('<')) {
    const json = JSON.parse(text)
    if (json.result?.leaderDetails?.length) {
      const item = json.result.leaderDetails[0]
      console.log('All item keys:', Object.keys(item))
      console.log('\nSample item:')
      for (const [k, v] of Object.entries(item)) {
        // Skip large/irrelevant fields
        if (typeof v !== 'object') {
          console.log(`  ${k}: ${v}`)
        }
      }
      
      // Check for memberId/userId type fields
      const idFields = Object.keys(item).filter(k => 
        k.toLowerCase().includes('member') || 
        k.toLowerCase().includes('user') || 
        k.toLowerCase().includes('uid') ||
        k.toLowerCase().includes('id')
      )
      console.log('\nID-related fields:', idFields)
      for (const f of idFields) {
        console.log(`  ${f}: ${JSON.stringify(item[f])}`)
      }

      // Look for any numeric-valued fields that might be IDs
      console.log('\nAll items nickName + leaderMark + any ID fields:')
      for (const it of json.result.leaderDetails) {
        console.log(`  nick=${it.nickName} mark=${it.leaderMark?.substring(0,10)}... uid/member:`, 
          idFields.map(f => `${f}=${it[f]}`).join(', '))
      }
    }
  } else {
    console.log('Failed to get listing. Body:', text.substring(0, 200))
  }

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
