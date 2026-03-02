#!/usr/bin/env node
/**
 * 并行API Discovery - 同时发现4个交易所的API endpoints
 * 不消耗Claude token，只用本地Puppeteer
 */

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import fs from 'fs/promises'
import path from 'path'

puppeteer.use(StealthPlugin())

const EXCHANGES = {
  bingx_spot: {
    url: 'https://bingx.com/en-us/copy-trading/spotCopyTrade/',
    name: 'BingX Spot',
    gap: 78.9,
  },
  bitget_futures: {
    url: 'https://www.bitget.com/copytrading/futures/USDT',
    name: 'Bitget Futures',
    gap: 67.6,
  },
  htx_futures: {
    url: 'https://www.htx.com/futures-activity/copy-trading',
    name: 'HTX Futures',
    gap: 59.2,
  },
  binance_web3: {
    url: 'https://www.binance.com/en/copy-trading/lead-details',
    name: 'Binance Web3',
    gap: 54.4,
  },
}

/**
 * 发现单个交易所的API
 */
async function discoverExchangeAPI(exchangeKey, config) {
  console.log(`\n🔍 [${config.name}] Starting discovery...`)
  
  const browser = await puppeteer.launch({
    headless: false, // 可视化，方便调试
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  
  // 收集所有API请求
  const apiRequests = []
  const apiResponses = new Map()
  
  page.on('request', request => {
    if (request.resourceType() === 'xhr' || request.resourceType() === 'fetch') {
      apiRequests.push({
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        postData: request.postData(),
        timestamp: Date.now(),
      })
    }
  })
  
  page.on('response', async response => {
    const request = response.request()
    if (request.resourceType() === 'xhr' || request.resourceType() === 'fetch') {
      try {
        const body = await response.json()
        apiResponses.set(request.url(), {
          status: response.status(),
          headers: response.headers(),
          body,
        })
      } catch (e) {
        // Not JSON
      }
    }
  })
  
  try {
    // Step 1: 访问排行榜
    console.log(`[${config.name}] Loading leaderboard...`)
    await page.goto(config.url, { waitUntil: 'networkidle2', timeout: 30000 })
    await new Promise(r => setTimeout(r, 3000))
    
    // Step 2: 尝试点击第一个trader
    console.log(`[${config.name}] Looking for trader profiles...`)
    
    // 通用选择器（根据交易所调整）
    const selectors = [
      'a[href*="trader"]',
      'a[href*="detail"]',
      '.trader-item',
      '.leaderboard-item',
      '[data-trader-id]',
      'tr[role="row"]',
    ]
    
    let clicked = false
    for (const selector of selectors) {
      try {
        const element = await page.$(selector)
        if (element) {
          console.log(`[${config.name}] Found trader with selector: ${selector}`)
          await element.click()
          clicked = true
          break
        }
      } catch (e) {
        // Try next selector
      }
    }
    
    if (!clicked) {
      console.warn(`[${config.name}] ⚠️  Could not find trader profile to click`)
    }
    
    // Step 3: 等待详情API加载
    await new Promise(r => setTimeout(r, 5000))
    
    // Step 4: 分析API请求
    console.log(`[${config.name}] Captured ${apiRequests.length} API requests`)
    
    const detailAPIs = apiRequests.filter(req => {
      const url = req.url.toLowerCase()
      return (
        url.includes('detail') ||
        url.includes('performance') ||
        url.includes('stats') ||
        url.includes('trader') ||
        url.includes('profile') ||
        url.includes('leaderboard')
      )
    })
    
    console.log(`[${config.name}] Found ${detailAPIs.length} potential detail APIs`)
    
    // Step 5: 生成文档
    const doc = generateAPIDoc(exchangeKey, config, detailAPIs, apiResponses)
    
    const docPath = path.join(process.cwd(), 'docs', 'exchange-apis', `${exchangeKey}.md`)
    await fs.mkdir(path.dirname(docPath), { recursive: true })
    await fs.writeFile(docPath, doc)
    
    console.log(`✅ [${config.name}] Documentation saved: ${docPath}`)
    
    await browser.close()
    
    return {
      exchange: exchangeKey,
      success: true,
      apiCount: detailAPIs.length,
      docPath,
    }
    
  } catch (error) {
    console.error(`❌ [${config.name}] Error:`, error.message)
    await browser.close()
    return {
      exchange: exchangeKey,
      success: false,
      error: error.message,
    }
  }
}

/**
 * 生成API文档
 */
function generateAPIDoc(exchangeKey, config, apis, responses) {
  let doc = `# ${config.name} API

**Status**: 🔍 Auto-discovered  
**Priority**: P0  
**Data Gap**: ${config.gap}%  
**Last Updated**: ${new Date().toISOString().split('T')[0]}

---

## 🔍 Auto-Discovery Results

Found ${apis.length} potential API endpoints.

`

  for (const [index, api] of apis.entries()) {
    const response = responses.get(api.url)
    
    doc += `
### API ${index + 1}: ${api.method} ${api.url}

**Request Headers**:
\`\`\`json
${JSON.stringify(api.headers, null, 2)}
\`\`\`

${api.postData ? `
**Request Body**:
\`\`\`json
${api.postData}
\`\`\`
` : ''}

${response ? `
**Response** (${response.status}):
\`\`\`json
${JSON.stringify(response.body, null, 2).slice(0, 2000)}
${JSON.stringify(response.body).length > 2000 ? '\n... (truncated)' : ''}
\`\`\`
` : ''}

---
`
  }
  
  doc += `
## 📝 Next Steps

1. Review the APIs above
2. Identify which one contains trader detail data (roi, pnl, win_rate, max_drawdown)
3. Map fields to our DB schema
4. Implement connector in \`lib/exchanges/${exchangeKey}.ts\`
5. Test with real trader IDs

## 🔗 Related Files

- Import script: \`scripts/import/import_${exchangeKey}.mjs\`
- Enrich script: \`scripts/enrich-${exchangeKey.replace('_', '-')}-detail.mjs\`
`

  return doc
}

/**
 * 主函数 - 并行运行所有交易所
 */
async function main() {
  console.log('🚀 Starting parallel API discovery for 4 exchanges...\n')
  
  const startTime = Date.now()
  
  // 并行执行（真正的并行，不是顺序）
  const results = await Promise.all(
    Object.entries(EXCHANGES).map(([key, config]) =>
      discoverExchangeAPI(key, config)
    )
  )
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  
  console.log('\n' + '='.repeat(60))
  console.log('📊 Discovery Summary')
  console.log('='.repeat(60))
  
  for (const result of results) {
    const status = result.success ? '✅' : '❌'
    console.log(`${status} ${result.exchange}: ${result.apiCount || 0} APIs found`)
    if (result.error) {
      console.log(`   Error: ${result.error}`)
    }
  }
  
  console.log(`\n⏱️  Total time: ${elapsed}s`)
  console.log(`\n📂 Documentation: ~/ranking-arena/docs/exchange-apis/`)
  
  const successCount = results.filter(r => r.success).length
  console.log(`\n🎯 Success rate: ${successCount}/4 exchanges`)
}

main().catch(console.error)
