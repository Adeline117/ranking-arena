/**
 * 测试新交易所API连通性
 * 
 * 快速验证各交易所API是否可用
 * 不写入数据库，仅测试连接和数据格式
 */

import { sleep } from '../lib/shared.mjs'

const TEST_APIS = [
  {
    name: 'OKX Futures',
    url: 'https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&page=1',
    method: 'GET',
    expectedFields: ['uniqueCode', 'nickName', 'pnlRatio'],
  },
  {
    name: 'Bitfinex',
    url: 'https://api-pub.bitfinex.com/v2/competitions',
    method: 'GET',
    expectedFields: [], // 返回数组格式不同
  },
  {
    name: 'Crypto.com',
    url: 'https://crypto.com/api/copy-trading/lead-traders?page=1&limit=10&sort=roi_desc&period=30d&asset=ALL&type=PERPETUAL',
    method: 'GET',
    expectedFields: ['userId', 'nickname', 'roi'],
  },
  {
    name: 'Pionex',
    url: 'https://api.pionex.com/api/copy-trading/lead-traders',
    method: 'POST',
    body: {
      market: 'futures',
      period: '30d',
      sort: 'roi',
      order: 'desc',
      page: 1,
      limit: 10
    },
    expectedFields: ['uid', 'nickname', 'roi'],
  }
]

const HEADERS = {
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}

/**
 * 测试单个API
 */
async function testAPI(api) {
  console.log(`\n🔍 测试 ${api.name}...`)
  console.log(`   URL: ${api.url}`)
  console.log(`   方法: ${api.method}`)
  
  try {
    const options = {
      method: api.method,
      headers: HEADERS,
    }
    
    if (api.method === 'POST' && api.body) {
      options.headers['Content-Type'] = 'application/json'
      options.body = JSON.stringify(api.body)
      console.log(`   请求体: ${JSON.stringify(api.body)}`)
    }
    
    const response = await fetch(api.url, options)
    
    console.log(`   状态码: ${response.status} ${response.statusText}`)
    
    if (!response.ok) {
      console.log(`   ❌ API请求失败`)
      return { name: api.name, success: false, error: `HTTP ${response.status}` }
    }
    
    const contentType = response.headers.get('content-type')
    console.log(`   内容类型: ${contentType}`)
    
    if (!contentType?.includes('application/json')) {
      console.log(`   ⚠️  非JSON响应`)
      const text = await response.text()
      console.log(`   响应预览: ${text.slice(0, 200)}...`)
      return { name: api.name, success: false, error: '非JSON响应' }
    }
    
    const data = await response.json()
    console.log(`   ✅ JSON解析成功`)
    
    // 检查数据结构
    if (Array.isArray(data)) {
      console.log(`   📊 返回数组，长度: ${data.length}`)
      if (data.length > 0) {
        console.log(`   🔑 第一项键: ${Object.keys(data[0]).slice(0, 5).join(', ')}`)
      }
    } else if (typeof data === 'object' && data !== null) {
      console.log(`   📊 返回对象`)
      console.log(`   🔑 顶层键: ${Object.keys(data).join(', ')}`)
      
      // 尝试找到交易员数据
      const possibleDataPaths = ['data', 'result', 'traders', 'ranks']
      let traderData = null
      
      for (const path of possibleDataPaths) {
        if (data[path]) {
          traderData = data[path]
          console.log(`   📂 找到数据路径: ${path}`)
          break
        }
      }
      
      if (Array.isArray(traderData) && traderData.length > 0) {
        console.log(`   👥 交易员数量: ${traderData.length}`)
        const firstTrader = traderData[0]
        if (typeof firstTrader === 'object') {
          console.log(`   🏷️  交易员字段: ${Object.keys(firstTrader).slice(0, 8).join(', ')}`)
          
          // 检查期望字段
          if (api.expectedFields.length > 0) {
            const hasFields = api.expectedFields.filter(field => field in firstTrader)
            console.log(`   ✅ 期望字段匹配: ${hasFields.length}/${api.expectedFields.length}`)
            if (hasFields.length < api.expectedFields.length) {
              const missing = api.expectedFields.filter(field => !(field in firstTrader))
              console.log(`   ❓ 缺失字段: ${missing.join(', ')}`)
            }
          }
        }
      } else if (traderData) {
        console.log(`   📂 数据路径存在但格式异常: ${typeof traderData}`)
      } else {
        console.log(`   ❓ 未找到交易员数据路径`)
      }
    }
    
    return { name: api.name, success: true, data: data }
    
  } catch (error) {
    console.log(`   ❌ 请求异常: ${error.message}`)
    return { name: api.name, success: false, error: error.message }
  }
}

async function main() {
  console.log(`\n${'='.repeat(70)}`)
  console.log(`🧪 新交易所API连通性测试`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`目的: 验证API可用性和数据格式`)
  console.log(`${'='.repeat(70)}`)
  
  const results = []
  
  for (let i = 0; i < TEST_APIS.length; i++) {
    const api = TEST_APIS[i]
    const result = await testAPI(api)
    results.push(result)
    
    // API间延迟
    if (i < TEST_APIS.length - 1) {
      console.log(`\n⏳ 等待2秒后测试下一个API...`)
      await sleep(2000)
    }
  }
  
  // 总结
  console.log(`\n${'='.repeat(70)}`)
  console.log(`📊 测试结果总结`)
  console.log(`${'='.repeat(70)}`)
  
  const successful = results.filter(r => r.success)
  const failed = results.filter(r => !r.success)
  
  console.log(`✅ 成功: ${successful.length}/${results.length}`)
  console.log(`❌ 失败: ${failed.length}/${results.length}`)
  
  if (successful.length > 0) {
    console.log(`\n🎉 可用的API:`)
    successful.forEach(r => console.log(`   ✅ ${r.name}`))
  }
  
  if (failed.length > 0) {
    console.log(`\n🚨 有问题的API:`)
    failed.forEach(r => console.log(`   ❌ ${r.name}: ${r.error}`))
  }
  
  console.log(`\n💡 建议:`)
  if (successful.length === results.length) {
    console.log(`   🚀 所有API都可用，可以开始批量数据抓取`)
    console.log(`   📝 运行: node scripts/import/batch_new_exchanges.mjs`)
  } else {
    console.log(`   🔧 修复失败的API后再进行数据抓取`)
    console.log(`   📝 单独测试: node scripts/import/test_exchanges_api.mjs`)
  }
  
  console.log(`${'='.repeat(70)}`)
}

main().catch(console.error)