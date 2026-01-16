/**
 * 缓存模块单元测试
 */

import { CacheKey, CACHE_TTL, CachePattern } from '../keys'

describe('CacheKey', () => {
  describe('traders', () => {
    test('生成排行榜缓存键', () => {
      const key = CacheKey.traders.list({ timeRange: '90D' })
      expect(key).toBe('traders:list:all:90D:20:0')
    })

    test('生成排行榜缓存键（带参数）', () => {
      const key = CacheKey.traders.list({
        timeRange: '7D',
        exchange: 'binance',
        limit: 50,
        page: 2,
      })
      expect(key).toBe('traders:list:binance:7D:50:2')
    })

    test('生成交易员详情缓存键', () => {
      const key = CacheKey.traders.detail('trader123')
      expect(key).toBe('trader:detail:trader123')
    })

    test('生成交易员性能缓存键', () => {
      const key = CacheKey.traders.performance('trader123', '90D')
      expect(key).toBe('trader:performance:trader123:90D')
    })

    test('生成交易员资金曲线缓存键', () => {
      const key = CacheKey.traders.equity('trader123')
      expect(key).toBe('trader:equity:trader123')
    })
  })

  describe('posts', () => {
    test('生成帖子列表缓存键', () => {
      const key = CacheKey.posts.list({})
      expect(key).toBe('posts:list:all:created_at:0')
    })

    test('生成帖子列表缓存键（带参数）', () => {
      const key = CacheKey.posts.list({
        groupId: 'group123',
        sortBy: 'hot_score',
        page: 1,
      })
      expect(key).toBe('posts:list:group123:hot_score:1')
    })

    test('生成热门帖子缓存键', () => {
      const key = CacheKey.posts.hot(2)
      expect(key).toBe('posts:hot:2')
    })

    test('生成帖子详情缓存键', () => {
      const key = CacheKey.posts.detail('post123')
      expect(key).toBe('post:detail:post123')
    })
  })

  describe('user', () => {
    test('生成用户资料缓存键', () => {
      const key = CacheKey.user.profile('user123')
      expect(key).toBe('user:profile:user123')
    })

    test('生成用户收藏夹缓存键', () => {
      const key = CacheKey.user.bookmarks('user123')
      expect(key).toBe('user:bookmarks:user123')
    })
  })

  describe('market', () => {
    test('生成市场价格缓存键', () => {
      const key = CacheKey.market.prices()
      expect(key).toBe('market:prices')
    })

    test('生成市场趋势缓存键', () => {
      const key = CacheKey.market.trends()
      expect(key).toBe('market:trends')
    })
  })

  describe('search', () => {
    test('生成搜索结果缓存键', () => {
      const key = CacheKey.search.results('bitcoin', 'traders')
      expect(key).toBe('search:results:traders:bitcoin')
    })

    test('处理特殊字符', () => {
      const key = CacheKey.search.results('hello world', 'posts')
      expect(key).toBe('search:results:posts:hello%20world')
    })
  })
})

describe('CACHE_TTL', () => {
  test('排行榜缓存 TTL 为 5 分钟', () => {
    expect(CACHE_TTL.TRADERS_LIST).toBe(300)
  })

  test('交易员详情 TTL 为 1 分钟', () => {
    expect(CACHE_TTL.TRADER_DETAIL).toBe(60)
  })

  test('市场数据 TTL 为 10 秒', () => {
    expect(CACHE_TTL.MARKET_DATA).toBe(10)
  })

  test('用户资料 TTL 为 5 分钟', () => {
    expect(CACHE_TTL.USER_PROFILE).toBe(300)
  })
})

describe('CachePattern', () => {
  test('生成所有交易员缓存模式', () => {
    const pattern = CachePattern.allTraders()
    expect(pattern).toBe('traders:*')
  })

  test('生成特定交易员缓存模式', () => {
    const pattern = CachePattern.trader('trader123')
    expect(pattern).toBe('trader:*:trader123*')
  })

  test('生成所有帖子缓存模式', () => {
    const pattern = CachePattern.allPosts()
    expect(pattern).toBe('posts:*')
  })

  test('生成用户缓存模式', () => {
    const pattern = CachePattern.user('user123')
    expect(pattern).toBe('user:*:user123*')
  })
})
