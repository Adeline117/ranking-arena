/**
 * 币安跟单交易 API 端点发现工具
 */

const POSSIBLE_ENDPOINTS = [
  // 跟单交易排行榜相关
  {
    url: 'https://www.binance.com/bapi/futures/v1/public/future/leaderboard/getLeaderboardRank',
    params: { period: '90d', limit: 100 },
  },
  {
    url: 'https://www.binance.com/bapi/futures/v1/public/future/leaderboard/getLeaderboardRank',
    params: { period: '90D', limit: 100 },
  },
  {
    url: 'https://www.binance.com/bapi/futures/v1/public/future/leaderboard/getLeaderboardRank',
    params: { period: '90', limit: 100 },
  },
  {
    url: 'https://www.binance.com/bapi/futures/v1/public/future/leaderboard/getLeaderboardRank',
    params: { periodType: '90d', size: 100 },
  },
  {
    url: 'https://www.binance.com/bapi/futures/v1/public/future/leaderboard/getLeaderboardRank',
    params: { periodType: '90D', size: 100 },
  },
  // 跟单交易列表
  {
    url: 'https://www.binance.com/bapi/futures/v1/public/future/copy-trading/leaderboard/query',
    params: { period: '90d', limit: 100 },
  },
  {
    url: 'https://www.binance.com/bapi/futures/v1/public/future/copy-trading/leaderboard/query',
    params: { period: '90D', limit: 100 },
  },
  {
    url: 'https://www.binance.com/bapi/futures/v1/public/future/copy-trading/leaderboard/query',
    params: { periodType: '90d', size: 100 },
  },
  // 其他可能的端点
  {
    url: 'https://www.binance.com/bapi/futures/v1/public/future/copy-trading/trader/list',
    params: { period: '90d', limit: 100 },
  },
  {
    url: 'https://www.binance.com/bapi/futures/v1/public/future/copy-trading/trader/list',
    params: { periodType: '90d', size: 100 },
  },
  {
    url: 'https://www.binance.com/bapi/futures/v1/public/future/copy-trading/trader/rank',
    params: { period: '90d', limit: 100 },
  },
]

/**
 * 构建完整的 URL
 */
function buildUrl(endpoint) {
  const url = new URL(endpoint.url)
  Object.entries(endpoint.params).forEach(([key, value]) => {
    url.searchParams.append(key, value)
  })
  return url.toString()
}

/**
 * 测试单个端点
 */
async function testEndpoint(endpoint) {
  const url = buildUrl(endpoint)
  
  try {
    console.log(`测试: ${url}`)
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.binance.com/',
        'Origin': 'https://www.binance.com',
      },
    })

    if (!response.ok) {
      return {
        success: false,
        url,
        status: response.status,
        statusText: response.statusText,
      }
    }

    const data = await response.json()
    
    // 检查是否是预期的格式
    if (data.code === '000000' && data.data) {
      const dataArray = Array.isArray(data.data) ? data.data : (data.data.data || data.data.list || [])
      if (dataArray.length > 0) {
        const sample = dataArray[0]
        return {
          success: true,
          url,
          format: 'binance_api',
          dataCount: dataArray.length,
          sample: {
            fields: Object.keys(sample).slice(0, 10),
            roi: sample.roi || sample.roi90d || sample.return90d || sample.returnRate90d || sample.performance90d,
            traderId: sample.uid || sample.userId || sample.traderId || sample.encryptedUid,
            nickname: sample.nickName || sample.nickname || sample.name || sample.username,
          },
        }
      }
    } else if (Array.isArray(data) && data.length > 0) {
      const sample = data[0]
      return {
        success: true,
        url,
        format: 'direct_array',
        dataCount: data.length,
        sample: {
          fields: Object.keys(sample).slice(0, 10),
          roi: sample.roi || sample.roi90d || sample.return90d || sample.returnRate90d || sample.performance90d,
          traderId: sample.uid || sample.userId || sample.traderId || sample.encryptedUid,
          nickname: sample.nickName || sample.nickname || sample.name || sample.username,
        },
      }
    } else if (data.data && Array.isArray(data.data)) {
      return {
        success: true,
        url,
        format: 'data_array',
        dataCount: data.data.length,
        sample: data.data[0] ? {
          fields: Object.keys(data.data[0]).slice(0, 10),
        } : null,
      }
    } else {
      return {
        success: false,
        url,
        error: 'Unexpected format',
        sample: JSON.stringify(data).slice(0, 200),
      }
    }
  } catch (error) {
    return {
      success: false,
      url,
      error: error.message,
    }
  }
}

/**
 * 主函数
 */
async function main() {
  console.log('=== 币安跟单交易 API 端点发现工具 ===')
  console.log('')
  console.log('正在测试可能的 API 端点...')
  console.log('')

  const results = []
  
  for (const endpoint of POSSIBLE_ENDPOINTS) {
    const result = await testEndpoint(endpoint)
    results.push(result)
    
    if (result.success) {
      console.log(`✅ 成功找到端点！`)
      console.log(`   URL: ${result.url}`)
      console.log(`   格式: ${result.format}`)
      console.log(`   数据条数: ${result.dataCount}`)
      if (result.sample) {
        console.log(`   示例字段: ${result.sample.fields.join(', ')}`)
        if (result.sample.roi !== undefined) {
          console.log(`   ROI 字段: ${result.sample.roi}`)
        }
        if (result.sample.traderId) {
          console.log(`   交易员ID: ${result.sample.traderId}`)
        }
        if (result.sample.nickname) {
          console.log(`   昵称: ${result.sample.nickname}`)
        }
      }
      console.log('')
    } else {
      console.log(`❌ 失败: ${result.error || result.statusText || 'Unknown error'}`)
      if (result.status) {
        console.log(`   HTTP ${result.status}`)
      }
      console.log('')
    }
    
    // 添加延迟避免限流
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  // 总结
  console.log('=== 测试结果总结 ===')
  console.log('')
  
  const successful = results.filter(r => r.success)
  const failed = results.filter(r => !r.success)
  
  console.log(`成功: ${successful.length}/${results.length}`)
  console.log(`失败: ${failed.length}/${results.length}`)
  console.log('')
  
  if (successful.length > 0) {
    console.log('✅ 找到可用的端点：')
    successful.forEach((result, index) => {
      console.log(`   ${index + 1}. ${result.url}`)
      console.log(`      格式: ${result.format}, 数据条数: ${result.dataCount}`)
    })
    console.log('')
    console.log('💡 使用方法：')
    console.log('   1. 复制上面的 URL')
    console.log('   2. 设置环境变量：')
    console.log(`      export BINANCE_COPY_TRADING_API_URL="${successful[0].url}"`)
    console.log('   3. 运行导入脚本')
  } else {
    console.log('❌ 未找到可用的端点')
    console.log('')
    console.log('💡 建议：')
    console.log('   1. 手动从浏览器开发者工具中找到 API 端点')
    console.log('   2. 打开 https://www.binance.com/zh-CN/copy-trading')
    console.log('   3. 按 F12，切换到 Network 标签')
    console.log('   4. 刷新页面，查找包含 leaderboard 或 trader 的请求')
    console.log('   5. 复制完整的 URL')
  }
}

// 运行
main().catch((error) => {
  console.error('执行失败:', error)
  process.exit(1)
})



