/**
 * SWR Hooks 测试
 * 测试超时控制和错误处理
 */

import { fetcher, fetcherWithAuth } from '../useSWR'

// Mock fetch
global.fetch = jest.fn()

describe('fetcher', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('应该成功获取数据', async () => {
    const mockData = { success: true, data: 'test' }
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    })

    const result = await fetcher('/api/test')
    expect(result).toEqual(mockData)
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/test',
      expect.objectContaining({
        credentials: 'include',
      })
    )
  })

  it('应该处理超时错误', async () => {
    // 模拟 AbortError（超时错误）
    const timeoutError = new Error('请求超时，请检查网络连接')
    timeoutError.name = 'TimeoutError'
    
    ;(global.fetch as jest.Mock).mockRejectedValueOnce(timeoutError)

    await expect(fetcher('/api/test')).rejects.toThrow('请求超时，请稍后重试')
  })

  it('应该处理 HTTP 错误状态', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not Found' }),
    })

    await expect(fetcher('/api/test')).rejects.toThrow('请求失败')
  })

  it('应该处理网络错误', async () => {
    ;(global.fetch as jest.Mock).mockRejectedValueOnce(
      new Error('Failed to fetch')
    )

    await expect(fetcher('/api/test')).rejects.toThrow('网络连接失败，请检查网络')
  })
})

describe('fetcherWithAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('应该在请求头中包含 Authorization token', async () => {
    const mockData = { success: true }
    const token = 'test-token'
    
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    })

    await fetcherWithAuth('/api/test', token)

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/test',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({
          Authorization: `Bearer ${token}`,
        }),
      })
    )
  })

  it('应该在没有 token 时不添加 Authorization 头', async () => {
    const mockData = { success: true }
    
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    })

    await fetcherWithAuth('/api/test')

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/test',
      expect.objectContaining({
        credentials: 'include',
        headers: {},
      })
    )
  })
})
