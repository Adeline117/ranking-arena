/**
 * Stealth Browser 工具模块
 * 使用 puppeteer-extra + stealth 插件绕过 Cloudflare
 */

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

// 启用 stealth 插件
puppeteer.use(StealthPlugin())

export async function createStealthBrowser() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--disable-blink-features=AutomationControlled',
    ],
  })
  return browser
}

export async function createStealthPage(browser, locale = 'zh-CN') {
  const page = await browser.newPage()
  
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  
  await page.setExtraHTTPHeaders({
    'Accept-Language': locale === 'zh-CN' ? 'zh-CN,zh;q=0.9,en;q=0.8' : 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  })
  
  return page
}

export async function waitAndClosePopups(page, waitTime = 5000) {
  await sleep(waitTime)
  
  // 关闭常见弹窗
  await page.evaluate(() => {
    document.querySelectorAll('button').forEach(btn => {
      const text = btn.textContent || ''
      if (
        text.includes('not a UK') || 
        text.includes('继续') || 
        text.includes('关闭') || 
        text.includes('I am not') ||
        text.includes('Accept') ||
        text.includes('确定') ||
        text.includes('Got it')
      ) {
        try { btn.click() } catch (e) {}
      }
    })
    
    // 关闭带 close 类名的按钮
    document.querySelectorAll('[class*="close"], [class*="Close"], [aria-label*="close"]').forEach(el => {
      try { el.click() } catch (e) {}
    })
  })
  
  await sleep(1000)
}

export async function scrollPage(page, times = 5, scrollAmount = 400) {
  for (let i = 0; i < times; i++) {
    await page.evaluate((amount) => window.scrollBy(0, amount), scrollAmount)
    await sleep(500)
  }
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function checkCloudflareChallenge(page) {
  const hasChallenge = await page.evaluate(() => {
    const text = document.body.innerText || ''
    return text.includes('Verify you are human') ||
           text.includes('checking your browser') ||
           text.includes('Please wait') ||
           text.includes('Just a moment')
  })
  
  if (hasChallenge) {
    console.log('  ⚠ 检测到 Cloudflare 验证，等待通过...')
    await sleep(15000)
    return true
  }
  return false
}
