/**
 * /api/traders 路由参数验证测试
 * 
 * 测试 URL 参数解析和验证逻辑
 */

describe('/api/traders parameter validation', () => {
  describe('timeRange parameter', () => {
    it('should default to 90D when not provided', () => {
      const params = new URLSearchParams('')
      const timeRange = params.get('timeRange') || '90D'
      expect(timeRange).toBe('90D')
    })

    it('should accept valid time ranges', () => {
      const validRanges = ['7D', '30D', '90D']
      for (const range of validRanges) {
        const params = new URLSearchParams(`timeRange=${range}`)
        expect(params.get('timeRange')).toBe(range)
      }
    })
  })

  describe('sortBy parameter', () => {
    const SORT_COLUMN: Record<string, string> = {
      arena_score: 'arena_score',
      roi: 'roi',
      win_rate: 'win_rate',
      max_drawdown: 'max_drawdown',
    }

    it('should accept valid sort columns', () => {
      for (const col of Object.keys(SORT_COLUMN)) {
        expect(SORT_COLUMN[col]).toBeDefined()
      }
    })

    it('should fallback to arena_score for invalid sort', () => {
      const sortBy = 'invalid_column'
      const sortColumn = SORT_COLUMN[sortBy] || 'arena_score'
      expect(sortColumn).toBe('arena_score')
    })

    it('should fallback to arena_score when null', () => {
      const sortBy = null
      const effectiveSortBy = sortBy || 'arena_score'
      expect(effectiveSortBy).toBe('arena_score')
    })
  })

  describe('order parameter', () => {
    it('should default to desc', () => {
      const params = new URLSearchParams('')
      const order = (params.get('order') || 'desc') as 'asc' | 'desc'
      expect(order).toBe('desc')
    })

    it('should accept asc', () => {
      const params = new URLSearchParams('order=asc')
      const order = (params.get('order') || 'desc') as 'asc' | 'desc'
      expect(order).toBe('asc')
    })
  })

  describe('limit parameter', () => {
    it('should default to 50', () => {
      const params = new URLSearchParams('')
      const limit = Math.min(1000, Math.max(1, parseInt(params.get('limit') || '50', 10) || 50))
      expect(limit).toBe(50)
    })

    it('should clamp to max 1000', () => {
      const params = new URLSearchParams('limit=5000')
      const limit = Math.min(1000, Math.max(1, parseInt(params.get('limit') || '50', 10) || 50))
      expect(limit).toBe(1000)
    })

    it('should treat 0 as falsy and use default 50', () => {
      // parseInt('0') is 0, which is falsy, so || 50 kicks in
      const params = new URLSearchParams('limit=0')
      const limit = Math.min(1000, Math.max(1, parseInt(params.get('limit') || '50', 10) || 50))
      expect(limit).toBe(50)
    })

    it('should handle negative values by clamping to 1', () => {
      const params = new URLSearchParams('limit=-10')
      const limit = Math.min(1000, Math.max(1, parseInt(params.get('limit') || '50', 10) || 50))
      expect(limit).toBe(1)
    })

    it('should fallback for non-numeric input', () => {
      const params = new URLSearchParams('limit=abc')
      const limit = Math.min(1000, Math.max(1, parseInt(params.get('limit') || '50', 10) || 50))
      expect(limit).toBe(50)
    })
  })

  describe('pagination mode', () => {
    it('should use cursor-based when cursor is provided', () => {
      const params = new URLSearchParams('cursor=100')
      const cursor = params.get('cursor')
      const page = parseInt(params.get('page') || '', 10)
      const useLegacyPaging = !isNaN(page) && !cursor
      expect(useLegacyPaging).toBe(false)
    })

    it('should use legacy paging when page is provided without cursor', () => {
      const params = new URLSearchParams('page=2')
      const cursor = params.get('cursor')
      const page = parseInt(params.get('page') || '', 10)
      const useLegacyPaging = !isNaN(page) && !cursor
      expect(useLegacyPaging).toBe(true)
    })

    it('should prefer cursor over page when both provided', () => {
      const params = new URLSearchParams('cursor=50&page=2')
      const cursor = params.get('cursor')
      const page = parseInt(params.get('page') || '', 10)
      const useLegacyPaging = !isNaN(page) && !cursor
      expect(useLegacyPaging).toBe(false)
    })
  })

  describe('cache key generation', () => {
    it('should generate unique cache keys for different params', () => {
      const buildKey = (timeRange: string, exchange: string | null, sortBy: string, order: string, cursor: string | null, limit: number) =>
        `leaderboard:${timeRange}:${exchange || 'all'}:${sortBy}:${order}:${cursor || 'start'}:${limit}`

      const key1 = buildKey('90D', null, 'arena_score', 'desc', null, 50)
      const key2 = buildKey('30D', null, 'arena_score', 'desc', null, 50)
      const key3 = buildKey('90D', 'binance_futures', 'arena_score', 'desc', null, 50)

      expect(key1).not.toBe(key2)
      expect(key1).not.toBe(key3)
      expect(key1).toBe('leaderboard:90D:all:arena_score:desc:start:50')
    })
  })
})
