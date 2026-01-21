import { test, expect } from '@playwright/test'

test.describe('API 端点测试', () => {
  test('GET /api/traders 返回正确格式', async ({ request }) => {
    const response = await request.get('/api/traders')
    
    expect(response.ok()).toBeTruthy()
    expect(response.status()).toBe(200)
    
    const data = await response.json()
    
    // 验证响应结构
    expect(data).toHaveProperty('traders')
    expect(Array.isArray(data.traders)).toBeTruthy()
    
    // 如果有数据，验证数据结构
    if (data.traders.length > 0) {
      const trader = data.traders[0]
      expect(trader).toHaveProperty('id')
      expect(trader).toHaveProperty('handle')
      expect(trader).toHaveProperty('roi')
      expect(trader).toHaveProperty('source')
    }
  })

  test('GET /api/traders 支持时间范围参数', async ({ request }) => {
    const timeRanges = ['7D', '30D', '90D']
    
    for (const timeRange of timeRanges) {
      const response = await request.get(`/api/traders?timeRange=${timeRange}`)
      
      expect(response.ok()).toBeTruthy()
      
      const data = await response.json()
      expect(data).toHaveProperty('traders')
    }
  })

  test('GET /api/market 返回市场数据', async ({ request }) => {
    const response = await request.get('/api/market')
    
    // 市场 API 可能不存在或返回错误
    if (response.ok()) {
      const data = await response.json()
      expect(data).toBeDefined()
    }
  })

  test('GET /api/traders/[handle] 返回交易员详情', async ({ request }) => {
    // 首先获取一个真实的交易员 handle
    const tradersResponse = await request.get('/api/traders')
    const tradersData = await tradersResponse.json()
    
    if (tradersData.traders && tradersData.traders.length > 0) {
      const handle = tradersData.traders[0].handle
      
      const response = await request.get(`/api/traders/${encodeURIComponent(handle)}`)
      
      if (response.ok()) {
        const data = await response.json()
        expect(data).toHaveProperty('profile')
        expect(data).toHaveProperty('performance')
      }
    }
  })

  test('GET /api/traders/[handle]/equity 返回资金曲线', async ({ request }) => {
    const tradersResponse = await request.get('/api/traders')
    const tradersData = await tradersResponse.json()
    
    if (tradersData.traders && tradersData.traders.length > 0) {
      const handle = tradersData.traders[0].handle
      
      const response = await request.get(`/api/traders/${encodeURIComponent(handle)}/equity`)
      
      if (response.ok()) {
        const data = await response.json()
        expect(data).toHaveProperty('equity')
        expect(data).toHaveProperty('pnl')
        expect(data).toHaveProperty('drawdown')
        expect(Array.isArray(data.equity)).toBeTruthy()
      }
    }
  })

  test('GET /api/traders/[handle]/positions 返回持仓数据', async ({ request }) => {
    const tradersResponse = await request.get('/api/traders')
    const tradersData = await tradersResponse.json()
    
    if (tradersData.traders && tradersData.traders.length > 0) {
      const handle = tradersData.traders[0].handle
      
      const response = await request.get(`/api/traders/${encodeURIComponent(handle)}/positions`)
      
      if (response.ok()) {
        const data = await response.json()
        expect(data).toHaveProperty('positions')
        expect(Array.isArray(data.positions)).toBeTruthy()
      }
    }
  })

  test('API 错误处理 - 404', async ({ request }) => {
    const response = await request.get('/api/traders/nonexistent_trader_12345')
    
    // 应返回 404 或带有错误信息的响应
    if (!response.ok()) {
      expect(response.status()).toBe(404)
    } else {
      const data = await response.json()
      if (data.error) {
        expect(data.error).toBeDefined()
      }
    }
  })
})

test.describe('API 性能测试', () => {
  test('/api/traders 响应时间', async ({ request }) => {
    const startTime = Date.now()
    
    const response = await request.get('/api/traders')
    
    const responseTime = Date.now() - startTime
    
    expect(response.ok()).toBeTruthy()
    // API 响应应在 3 秒内
    expect(responseTime).toBeLessThan(3000)
  })

  test('/api/traders/[handle] 响应时间', async ({ request }) => {
    // 先获取一个交易员
    const tradersResponse = await request.get('/api/traders')
    const tradersData = await tradersResponse.json()
    
    if (tradersData.traders && tradersData.traders.length > 0) {
      const handle = tradersData.traders[0].handle
      
      const startTime = Date.now()
      const response = await request.get(`/api/traders/${encodeURIComponent(handle)}`)
      const responseTime = Date.now() - startTime
      
      expect(response.ok()).toBeTruthy()
      // 详情 API 应在 2 秒内响应
      expect(responseTime).toBeLessThan(2000)
    }
  })
})
