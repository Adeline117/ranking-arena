#!/usr/bin/env node

/**
 * API Discovery Script
 * 自动发现交易所的trader detail API endpoints
 */

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

puppeteer.use(StealthPlugin())

const EXCHANGES = {
  bingx_spot: {
    name: 'BingX Spot',
    url: 'https://bingx.com/en-us/copy-trading/spotCopyTrade/',
    selectors: {
      traderList: '.trader-list, [class*="trader"], [class*="leaderboard"]',
      traderItem: '.trader-item, [class*="trader-row"], a[href*="trader"]'
    }
  },
  bitget_futures: {
    name: 'Bitget Futures',
    url: 'https://www.bitget.com/copytrading/futures/USDT',
    selectors: {
      traderList: '.trader-list, [class*="trader"], [class*="copy"]',
      traderItem: '.trader-item, [class*="trader-card"], a[href*="trader"]'
    }
  },
  htx_futures: {
    name: 'HTX Futures',
    url: 'https://www.htx.com/futures-activity/copy-trading',
    selectors: {
      traderList: '.trader-list, [class*="trader"], [class*="copy"]',
      traderItem: '.trader-item, [class*="trader-row"], a[href*="trader"]'
    }
  },
  binance_web3: {
    name: 'Binance Web3',
    url: 'https://www.binance.com/en/copy-trading/lead-details',
    selectors: {
      traderList: '.trader-list, [class*="trader"], [class*="leader"]',
      traderItem: '.trader-item, [class*="trader-card"], a[href*="lead"]'
    }
  }
}

class APIDiscovery {
  constructor(exchangeKey, config) {
    this.exchangeKey = exchangeKey
    this.config = config
    this.apiRequests = []
    this.apiResponses = []
  }

  async discover() {
    console.log(`\n🔍 Discovering APIs for ${this.config.name}...`)
    console.log(`URL: ${this.config.url}\n`)

    const browser = await puppeteer.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    })

    try {
      const page = await browser.newPage()
      
      // 设置viewport
      await page.setViewport({ width: 1920, height: 1080 })

      // 监听网络请求
      page.on('request', request => {
        if (request.resourceType() === 'xhr' || request.resourceType() === 'fetch') {
          this.apiRequests.push({
            url: request.url(),
            method: request.method(),
            headers: request.headers(),
            postData: request.postData(),
            timestamp: Date.now()
          })
        }
      })

      // 监听响应
      page.on('response', async response => {
        const request = response.request()
        if (request.resourceType() === 'xhr' || request.resourceType() === 'fetch') {
          try {
            const contentType = response.headers()['content-type'] || ''
            if (contentType.includes('json')) {
              const body = await response.json()
              this.apiResponses.push({
                url: request.url(),
                method: request.method(),
                status: response.status(),
                body: body,
                timestamp: Date.now()
              })
              
              console.log(`[API] ${request.method()} ${request.url()}`)
              console.log(`Status: ${response.status()}`)
              console.log('Response preview:', JSON.stringify(body, null, 2).slice(0, 300))
              console.log('---')
            }
          } catch (e) {
            // 非JSON响应，忽略
          }
        }
      })

      // 打开排行榜页面
      console.log('📄 Loading leaderboard page...')
      await page.goto(this.config.url, { 
        waitUntil: 'networkidle2',
        timeout: 60000 
      })

      // 等待页面加载
      await new Promise(resolve => setTimeout(resolve, 5000))

      // 尝试找到第一个trader并点击
      console.log('🎯 Looking for first trader...')
      
      // 尝试多个选择器
      let clicked = false
      for (const selector of [
        'a[href*="trader"]',
        'a[href*="lead"]',
        '[class*="trader"]:not([class*="list"])',
        '[onclick*="trader"]',
        '.trader-card',
        '.trader-row'
      ]) {
        try {
          await page.waitForSelector(selector, { timeout: 3000 })
          const elements = await page.$$(selector)
          
          if (elements.length > 0) {
            console.log(`Found ${elements.length} elements with selector: ${selector}`)
            
            // 点击第一个
            await elements[0].click()
            console.log('✅ Clicked first trader!')
            clicked = true
            break
          }
        } catch (e) {
          continue
        }
      }

      if (!clicked) {
        console.log('⚠️  Could not find clickable trader element')
        console.log('Taking screenshot for manual inspection...')
        await page.screenshot({ path: `screenshots/api-discovery-${this.exchangeKey}.png`, fullPage: true })
      }

      // 等待详情页API请求
      console.log('⏳ Waiting for detail API requests...')
      await new Promise(resolve => setTimeout(resolve, 5000))

      // 分析捕获的API
      console.log('\n📊 Analyzing captured APIs...')
      const detailAPIs = this.findDetailAPIs()

      if (detailAPIs.length === 0) {
        console.log('❌ No detail APIs found!')
        console.log('All captured URLs:')
        this.apiRequests.forEach(req => console.log(`  - ${req.url}`))
      } else {
        console.log(`✅ Found ${detailAPIs.length} potential detail API(s)`)
        detailAPIs.forEach((api, idx) => {
          console.log(`\n📍 API ${idx + 1}:`)
          console.log(`URL: ${api.url}`)
          console.log(`Method: ${api.method}`)
          console.log(`Headers:`, JSON.stringify(api.headers, null, 2).slice(0, 200))
          if (api.postData) {
            console.log(`Body:`, api.postData)
          }
          if (api.response) {
            console.log(`Response:`, JSON.stringify(api.response, null, 2).slice(0, 500))
          }
        })
      }

      return detailAPIs

    } finally {
      await browser.close()
    }
  }

  findDetailAPIs() {
    const keywords = ['detail', 'trader', 'performance', 'stats', 'profile', 'info', 'user']
    
    return this.apiResponses.filter(resp => {
      const url = resp.url.toLowerCase()
      return keywords.some(kw => url.includes(kw)) && 
             resp.status === 200 &&
             resp.body && 
             typeof resp.body === 'object'
    }).map(resp => {
      const request = this.apiRequests.find(req => req.url === resp.url)
      return {
        url: resp.url,
        method: resp.method,
        headers: request?.headers || {},
        postData: request?.postData,
        response: resp.body
      }
    })
  }

  async generateDoc(apis) {
    if (apis.length === 0) {
      console.log('⚠️  No APIs to document')
      return
    }

    const api = apis[0] // 使用第一个发现的API
    
    const templatePath = path.join(__dirname, '../docs/exchange-apis/_TEMPLATE.md')
    let template = await fs.readFile(templatePath, 'utf-8')

    // 替换模板内容
    template = template.replace('{Exchange Name}', this.config.name)
    template = template.replace(/POST\/GET https:\/\/api\.example\.com\/v1\/trader\/detail/g, 
      `${api.method} ${api.url}`)
    
    // 构建cURL示例
    const curlHeaders = Object.entries(api.headers)
      .filter(([k, v]) => !k.startsWith(':') && k !== 'cookie')
      .map(([k, v]) => `  -H '${k}: ${v}'`)
      .join(' \\\n')
    
    const curlExample = api.method === 'POST' 
      ? `curl -X POST '${api.url}' \\\n${curlHeaders}${api.postData ? ` \\\n  -d '${api.postData}'` : ''}`
      : `curl '${api.url}' \\\n${curlHeaders}`

    template = template.replace(/curl -X POST 'https:\/\/api\.example\.com\/v1\/trader\/detail'[^`]+/s, curlExample)

    // 插入真实响应示例
    if (api.response) {
      const responseJson = JSON.stringify(api.response, null, 2)
      template = template.replace(/```json\n\{\n  "code": 0,[^`]+```/s, 
        `\`\`\`json\n${responseJson}\n\`\`\``)
    }

    // 写入文件
    const outputPath = path.join(__dirname, `../docs/exchange-apis/${this.exchangeKey}.md`)
    await fs.writeFile(outputPath, template, 'utf-8')
    console.log(`\n📝 Documentation saved to: ${outputPath}`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const exchangeKey = args[0] || 'all'

  const exchangesToRun = exchangeKey === 'all' 
    ? Object.keys(EXCHANGES)
    : [exchangeKey]

  console.log('🚀 API Discovery Starting...')
  console.log(`Exchanges: ${exchangesToRun.join(', ')}`)

  for (const key of exchangesToRun) {
    const config = EXCHANGES[key]
    if (!config) {
      console.error(`❌ Unknown exchange: ${key}`)
      continue
    }

    const discovery = new APIDiscovery(key, config)
    
    try {
      const apis = await discovery.discover()
      await discovery.generateDoc(apis)
      
      console.log(`\n✅ ${config.name} complete!\n`)
      
      // 避免被rate limit，延迟下一个交易所
      if (exchangesToRun.length > 1) {
        console.log('⏳ Waiting 10s before next exchange...')
        await new Promise(resolve => setTimeout(resolve, 10000))
      }
      
    } catch (error) {
      console.error(`\n❌ Error discovering ${config.name}:`, error.message)
      console.error(error.stack)
    }
  }

  console.log('\n🎉 API Discovery Complete!')
}

main().catch(console.error)
