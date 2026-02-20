#!/usr/bin/env node
import puppeteer from 'puppeteer'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const browser = await puppeteer.launch({ 
    headless: 'new', 
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  })
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  
  await page.setRequestInterception(true)
  page.on('request', req => {
    const type = req.resourceType()
    if (['image', 'stylesheet', 'font', 'media'].includes(type)) req.abort()
    else req.continue()
  })
  
  console.log('🌐 Loading MEXC...')
  await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(5000)
  
  // Test the API
  console.log('📡 Testing API...')
  const result = await page.evaluate(async () => {
    const resp = await fetch('https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=5&orderBy=COMPREHENSIVE&page=1')
    const data = await resp.json()
    const content = data?.data?.content || []
    return {
      total: data?.data?.total,
      pageCount: data?.data?.totalPage,
      count: content.length,
      keys: content.length > 0 ? Object.keys(content[0]) : [],
      samples: content.slice(0, 3).map(t => ({
        uid: t.uid,
        nickname: t.nickname,
        nickName: t.nickName,
        avatar: t.avatar,
        avatarUrl: t.avatarUrl,
        headImg: t.headImg,
        headUrl: t.headUrl,
        photoUrl: t.photoUrl,
        userPhoto: t.userPhoto,
        img: t.img,
        photo: t.photo,
        icon: t.icon,
      }))
    }
  })
  
  console.log('Result:', JSON.stringify(result, null, 2))
  
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
