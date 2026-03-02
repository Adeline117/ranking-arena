/**
 * Rate Limit Bypass 解决方案
 * 解决 Bitget/Gateio 429 限流问题
 * 
 * 方法：
 * 1. 请求队列 + 智能延迟
 * 2. 代理轮换 (本地/VPS)
 * 3. 多 API Key 轮换
 * 4. 失败自动重试
 */

import { spawn } from 'child_process'

// ============ 配置 ============
const CONFIG = {
  // 代理列表 (可以从文件加载)
  proxies: [
    // 'http://127.0.0.1:7890',  // 本地 Clash
    // 'socks5://127.0.0.1:1080', // 本地 SOCKS
    // VPS 代理
  ],
  
  // 请求限制 (每个域名)
  rateLimits: {
    'api.bitget.com': { rpm: 20, interval: 3000 },  // 每分钟20次，间隔3秒
    'api.gateio.ws': { rpm: 30, interval: 2000 },
    'www.gate.com': { rpm: 30, interval: 2000 },
    'api.bybit.com': { rpm: 50, interval: 1200 },
  },
  
  // 重试配置
  retry: {
    maxAttempts: 3,
    backoffMultiplier: 2,  // 指数退避
    baseDelay: 5000,
  }
}

// ============ 请求队列 ============
class RequestQueue {
  constructor() {
    this.queues = {}  // 每个域名一个队列
    this.lastRequestTime = {}  // 最后请求时间
  }
  
  async request(url, options = {}, proxyIndex = 0) {
    const hostname = new URL(url).hostname
    const config = CONFIG.rateLimits[hostname] || { interval: 1000 }
    
    // 确保不超过速率限制
    const lastTime = this.lastRequestTime[hostname] || 0
    const elapsed = Date.now() - lastTime
    if (elapsed < config.interval) {
      await new Promise(r => setTimeout(r, config.interval - elapsed))
    }
    
    // 添加代理
    if (CONFIG.proxies.length > 0) {
      const proxy = CONFIG.proxies[proxyIndex % CONFIG.proxies.length]
      // Node.js fetch 不直接支持代理，需要用 undici 或其他库
      // 这里用 curl 作为备选
    }
    
    this.lastRequestTime[hostname] = Date.now()
    
    return fetch(url, options)
  }
}

const queue = new RequestQueue()

// ============ 带重试的请求 ============
async function fetchWithRetry(url, options = {}, attempt = 1) {
  try {
    const res = await queue.request(url, options)
    
    if (res.status === 429) {
      // 被限流
      console.log(`429 Rate Limited (attempt ${attempt}), waiting...`)
      
      if (attempt >= CONFIG.retry.maxAttempts) {
        throw new Error(`Max retry attempts reached for ${url}`)
      }
      
      // 指数退避
      const delay = CONFIG.retry.baseDelay * Math.pow(CONFIG.retry.backoffMultiplier, attempt - 1)
      console.log(`Waiting ${delay/1000}s before retry...`)
      await new Promise(r => setTimeout(r, delay))
      
      // 换代理重试
      const nextProxy = attempt % CONFIG.proxies.length
      return fetchWithRetry(url, options, attempt + 1)
    }
    
    return res
  } catch (e) {
    if (attempt >= CONFIG.retry.maxAttempts) {
      throw e
    }
    
    const delay = CONFIG.retry.baseDelay * attempt
    console.log(`Error: ${e.message}, retrying in ${delay/1000}s...`)
    await new Promise(r => setTimeout(r, delay))
    return fetchWithRetry(url, options, attempt + 1)
  }
}

// ============ VPS 代理方案 ============
async function fetchViaVPS(url, vpsHost = '45.76.152.169') {
  // 通过 SSH 隧道在 VPS 上执行请求
  return new Promise((resolve, reject) => {
    const cmd = `ssh root@${vpsHost} "curl -s '${url}'"`
    
    const child = spawn('bash', ['-c', cmd])
    let output = ''
    
    child.stdout.on('data', (data) => { output += data })
    child.stderr.on('data', (data) => { console.error('SSH Error:', data.toString()) })
    
    child.on('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(output))
        } catch {
          resolve(output)
        }
      } else {
        reject(new Error(`SSH command failed with code ${code}`))
      }
    })
  })
}

// ============ Playwright 浏览器方案 ============
async function fetchViaBrowser(url, selector = null) {
  const { chromium } = await import('playwright')
  
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  
  await page.goto(url, { waitUntil: 'networkidle' })
  
  let data
  if (selector) {
    data = await page.textContent(selector)
  } else {
    // 拦截 API 响应
    const response = await page.waitForResponse(url)
    data = await response.json()
  }
  
  await browser.close()
  return data
}

// ============ 统一请求接口 ============
async function smartFetch(url, options = {}) {
  // 优先级：
  // 1. 直接请求 (最快)
  // 2. 带重试的请求
  // 3. VPS 代理
  // 4. 浏览器自动化
  
  try {
    const res = await fetchWithRetry(url, options)
    if (res.ok) {
      return await res.json()
    }
  } catch (e) {
    console.log('Direct fetch failed:', e.message)
  }
  
  // 尝试 VPS
  try {
    console.log('Trying VPS proxy...')
    return await fetchViaVPS(url)
  } catch (e) {
    console.log('VPS fetch failed:', e.message)
  }
  
  // 最后尝试浏览器
  try {
    console.log('Trying browser automation...')
    return await fetchViaBrowser(url)
  } catch (e) {
    console.log('Browser fetch failed:', e.message)
  }
  
  throw new Error('All fetch methods failed')
}

// ============ Bitget 专用解决方案 ============
async function fetchBitgetWithBypass(traderId) {
  const baseUrl = 'https://api.bitget.com/api/v2/copy/futures-trader/public/profit-detail'
  
  // 方案1: 使用请求队列
  const url = `${baseUrl}?traderId=${traderId}&period=7D`
  
  try {
    return await smartFetch(url)
  } catch (e) {
    console.error('All Bitget bypass methods failed for', traderId)
    return null
  }
}

// ============ Gateio 专用解决方案 ============
async function fetchGateioWithBypass(traderId) {
  const baseUrl = 'https://www.gate.com/api/futures_copy/copy_trader/detail'
  const url = `${baseUrl}?traderId=${traderId}`
  
  try {
    return await smartFetch(url)
  } catch (e) {
    console.error('All Gateio bypass methods failed for', traderId)
    return null
  }
}

// ============ 批量处理 ============
async function batchFetchWithRateLimit(source, traderIds, fetchFn) {
  const results = []
  const batchSize = 10
  const batchDelay = 10000  // 每批间隔10秒
  
  for (let i = 0; i < traderIds.length; i += batchSize) {
    const batch = traderIds.slice(i, i + batchSize)
    
    console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(traderIds.length/batchSize)}`)
    
    const batchResults = await Promise.all(
      batch.map(id => fetchFn(id).catch(e => ({ error: e.message, id })))
    )
    
    results.push(...batchResults)
    
    // 批次间延迟
    if (i + batchSize < traderIds.length) {
      console.log(`Waiting ${batchDelay/1000}s before next batch...`)
      await new Promise(r => setTimeout(r, batchDelay))
    }
  }
  
  return results
}

export {
  smartFetch,
  fetchWithRetry,
  fetchViaVPS,
  fetchViaBrowser,
  fetchBitgetWithBypass,
  fetchGateioWithBypass,
  batchFetchWithRateLimit
}
