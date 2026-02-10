#!/usr/bin/env node
/**
 * MEXC - 浏览器fetch全部交易员，保存到JSON
 */
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import fs from 'fs'
puppeteer.use(StealthPlugin())

async function main() {
  console.log('=== MEXC 全量抓取 ===')
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise(r => setTimeout(r, 5000))
  
  // 用浏览器内fetch批量获取
  const allTraders = []
  for (let batch = 0; batch < 12; batch++) {
    const startPage = batch * 20 + 1
    const endPage = startPage + 19
    
    const traders = await page.evaluate(async (sp, ep) => {
      const results = []
      for (let p = sp; p <= ep; p++) {
        try {
          const res = await fetch('/api/platform/futures/copyFutures/api/v1/traders/v2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pageNum: p, pageSize: 100, sortField: 'TOTAL_PNL', sortType: 'DESC' })
          })
          const d = await res.json()
          const list = d.data?.resultList || []
          if (!list.length) return results // no more data
          for (const t of list) {
            results.push({
              uid: String(t.uid || ''),
              nickname: t.nickname || '',
              avatar: t.avatar || '',
              traderId: t.traderId || ''
            })
          }
          await new Promise(r => setTimeout(r, 200))
        } catch { break }
      }
      return results
    }, startPage, endPage)
    
    allTraders.push(...traders)
    console.log('批次 ' + (batch+1) + ': +' + traders.length + ', 累计: ' + allTraders.length)
    if (traders.length < 2000) break // no more pages
  }
  
  await browser.close()
  
  // 保存
  fs.writeFileSync('/tmp/mexc-traders-full.json', JSON.stringify(allTraders))
  console.log('总计: ' + allTraders.length)
  console.log('有头像: ' + allTraders.filter(t => t.avatar).length)
  console.log('有nickname: ' + allTraders.filter(t => t.nickname).length)
  console.log('样本: ' + JSON.stringify(allTraders.slice(0,3)))
}

main().catch(e => { console.error(e); process.exit(1) })
