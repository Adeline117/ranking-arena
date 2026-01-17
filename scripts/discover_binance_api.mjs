/**
 * 发现 Binance Copy Trading API
 * 通过监控网络请求来找到实际使用的 API
 */

import puppeteer from 'puppeteer'

async function main() {
  console.log('=== 发现 Binance API ===\n')

  const browser = await puppeteer.launch({
    headless: false, // 使用可见浏览器
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1920,1080',
    ],
  })

  try {
    const page = await browser.newPage()
    
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
    await page.setViewport({ width: 1920, height: 1080 })

    // 收集所有 API 请求
    const apiCalls = []

    // 监听所有请求
    page.on('request', (request) => {
      const url = request.url()
      if (url.includes('bapi') || url.includes('api') && url.includes('copy')) {
        console.log(`📤 请求: ${request.method()} ${url}`)
        const postData = request.postData()
        if (postData) {
          console.log(`   Body: ${postData.substring(0, 200)}`)
        }
      }
    })

    // 监听所有响应
    page.on('response', async (response) => {
      const url = response.url()
      if ((url.includes('bapi') || url.includes('api')) && 
          (url.includes('copy') || url.includes('lead') || url.includes('portfolio'))) {
        try {
          const status = response.status()
          console.log(`📥 响应: ${status} ${url}`)
          
          if (status === 200) {
            const json = await response.json().catch(() => null)
            if (json && (json.data || json.list)) {
              apiCalls.push({
                url,
                method: response.request().method(),
                postData: response.request().postData(),
                dataCount: Array.isArray(json.data?.list) ? json.data.list.length : 
                          Array.isArray(json.data) ? json.data.length : 0,
              })
              console.log(`   ✓ 有效数据: ${apiCalls[apiCalls.length - 1].dataCount} 条`)
            }
          }
        } catch (e) {
          // 忽略非 JSON 响应
        }
      }
    })

    console.log('访问 Binance Copy Trading...')
    await page.goto('https://www.binance.com/en/copy-trading/leaderboard', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    })

    console.log('\n等待页面加载...')
    await sleep(10000)

    // 尝试滚动
    console.log('\n滚动页面...')
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 500))
      await sleep(1000)
    }

    // 尝试点击时间选择器
    console.log('\n尝试点击时间选择器...')
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"]'))
      buttons.forEach(btn => {
        const text = btn.innerText || ''
        if (text.includes('30') || text.includes('7') || text.includes('90')) {
          console.log('Found button:', text)
        }
      })
    })

    await sleep(5000)

    console.log('\n\n=== 发现的 API ===')
    apiCalls.forEach((call, idx) => {
      console.log(`\n${idx + 1}. ${call.method} ${call.url}`)
      if (call.postData) {
        console.log(`   Body: ${call.postData}`)
      }
      console.log(`   数据量: ${call.dataCount}`)
    })

    // 截图
    await page.screenshot({ path: '/tmp/binance_screenshot.png', fullPage: true })
    console.log('\n截图已保存到: /tmp/binance_screenshot.png')

    console.log('\n按 Ctrl+C 关闭浏览器...')
    
    // 保持浏览器打开以便观察
    await sleep(60000)

  } finally {
    await browser.close()
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

main().catch(console.error)
