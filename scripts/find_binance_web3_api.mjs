/**
 * Binance Web3 Leaderboard API 端点发现工具
 * 
 * 这个脚本会尝试多个可能的 API 端点，帮助你找到正确的 URL
 */

const POSSIBLE_ENDPOINTS = [
  // 格式1: 基础路径 + 查询参数
  {
    url: 'https://www.binance.com/bapi/web3/v1/public/leaderboard',
    params: { chain: 'bsc', page: 1, size: 25 },
  },
  {
    url: 'https://www.binance.com/bapi/web3/v1/leaderboard',
    params: { chain: 'bsc', page: 1, size: 25 },
  },
  {
    url: 'https://web3.binance.com/api/v1/leaderboard',
    params: { chain: 'bsc', page: 1, size: 25 },
  },
  {
    url: 'https://web3.binance.com/bapi/web3/v1/public/leaderboard',
    params: { chain: 'bsc', page: 1, size: 25 },
  },
  // 格式2: 路径参数
  {
    url: 'https://www.binance.com/bapi/web3/v1/public/leaderboard/bsc',
    params: { page: 1, size: 25 },
  },
  // 格式3: 不同的参数名
  {
    url: 'https://www.binance.com/bapi/web3/v1/public/leaderboard',
    params: { chain: 'bsc', current: 1, size: 25 },
  },
  {
    url: 'https://www.binance.com/bapi/web3/v1/public/leaderboard',
    params: { chain: 'bsc', pageNum: 1, pageSize: 25 },
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
        'Referer': 'https://web3.binance.com/',
        'Origin': 'https://web3.binance.com',
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
    if (data.code === '000000' && data.data && data.data.data && Array.isArray(data.data.data)) {
      return {
        success: true,
        url,
        format: 'binance_web3',
        pages: data.data.pages,
        current: data.data.current,
        size: data.data.size,
        dataCount: data.data.data.length,
        sample: data.data.data[0] ? {
          address: data.data.data[0].address,
          realizedPnlPercent: data.data.data[0].realizedPnlPercent,
        } : null,
      }
    } else if (data.data && Array.isArray(data.data)) {
      return {
        success: true,
        url,
        format: 'array_in_data',
        dataCount: data.data.length,
      }
    } else if (Array.isArray(data)) {
      return {
        success: true,
        url,
        format: 'direct_array',
        dataCount: data.length,
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
  console.log('=== Binance Web3 Leaderboard API 端点发现工具 ===')
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
      if (result.format === 'binance_web3') {
        console.log(`   格式: Binance Web3 (code: "000000")`)
        console.log(`   总页数: ${result.pages}`)
        console.log(`   每页大小: ${result.size}`)
        console.log(`   当前页数据: ${result.dataCount} 条`)
        if (result.sample) {
          console.log(`   示例数据:`, result.sample)
        }
      } else {
        console.log(`   格式: ${result.format}`)
        console.log(`   数据条数: ${result.dataCount}`)
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
      if (result.format === 'binance_web3') {
        console.log(`      格式: Binance Web3 API`)
        console.log(`      总页数: ${result.pages}, 每页: ${result.size}`)
      }
    })
    console.log('')
    console.log('💡 使用方法：')
    console.log('   1. 复制上面的 URL')
    console.log('   2. 设置环境变量：')
    console.log(`      export BINANCE_WEB3_API_URL="${successful[0].url.replace(/page=\d+/, 'page={page}').replace(/size=\d+/, 'size={size}')}"`)
    console.log('   3. 或者直接修改 fetch_binance_web3_all_pages.mjs 中的 apiUrl')
  } else {
    console.log('❌ 未找到可用的端点')
    console.log('')
    console.log('💡 建议：')
    console.log('   1. 手动从浏览器开发者工具中找到 API 端点')
    console.log('   2. 打开 https://web3.binance.com/en/leaderboard?chain=bsc')
    console.log('   3. 按 F12，切换到 Network 标签')
    console.log('   4. 刷新页面，查找包含 leaderboard 的请求')
    console.log('   5. 复制完整的 URL')
  }
}

// 运行
main().catch((error) => {
  console.error('执行失败:', error)
  process.exit(1)
})


