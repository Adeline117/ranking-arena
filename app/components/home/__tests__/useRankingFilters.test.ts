/**
 * useRankingFilters — 首页排行榜筛选/排序/分页的核心状态机。
 *
 * 保护的契约：
 * - URL / localStorage 状态恢复（刷新页面不丢筛选条件）
 * - 客户端过滤管线（category → exchange → preset → advanced）真实执行
 *   （filterByCategory / PRESETS / getScoreGradeLetter / resolveExchangeSlug 均用真实实现）
 * - 有 fetchPage（服务端分页）时跳过客户端 category/exchange 过滤，避免双重过滤
 * - 免费用户 1000 条上限、Pro 门控埋点、保存筛选器 API 的成功/失败路径
 */

import { renderHook, act } from '@testing-library/react'
import type { Trader } from '../../ranking/RankingTable'
import type { TimeRange } from '../hooks/useTraderData'
import type { FilterConfig } from '../../premium/AdvancedFilter'

// ---------------------------------------------------------------------------
// Mocks — 只 mock 外部依赖（toast/订阅/i18n/auth/埋点），过滤逻辑保持真实
// ---------------------------------------------------------------------------
const mockShowToast = jest.fn()
jest.mock('@/app/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => ({ showToast: mockShowToast, hideToast: jest.fn() }),
  default: () => null,
}))

// let 变量：单个用例内可切换 Pro 态（免费上限测试需要）
let mockIsPro = true
jest.mock('@/app/components/home/hooks/useSubscription', () => ({
  useSubscription: () => ({
    isPro: mockIsPro,
    isFeaturesUnlocked: mockIsPro,
    isLoading: false,
    tier: mockIsPro ? 'pro' : 'free',
    refresh: jest.fn(),
  }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', setLanguage: jest.fn(), t: (key: string) => key }),
  LanguageProvider: ({ children }: { children: unknown }) => children,
}))

// 默认已登录；未登录用例内置为 null
let mockAuthHeaders: Record<string, string> | null = { Authorization: 'Bearer test' }
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ getAuthHeaders: () => mockAuthHeaders }),
}))

jest.mock('@/lib/api/client', () => ({ getCsrfHeaders: () => ({}) }))
jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))

import { useRankingFilters, FREE_LEADERBOARD_LIMIT } from '../useRankingFilters'
import { trackEvent } from '@/lib/analytics/track'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function trader(id: string, overrides: Partial<Trader> = {}): Trader {
  return {
    id,
    handle: id,
    roi: 10,
    pnl: 500,
    win_rate: 50,
    max_drawdown: 10,
    followers: 0,
    source: 'binance_futures',
    arena_score: 60,
    ...overrides,
  }
}

// 覆盖三个分类：futures / spot / web3（PLATFORM_CATEGORY 真实映射）
const FIXTURES: Trader[] = [
  trader('fut-1', { source: 'binance_futures', roi: 200, pnl: 20000, arena_score: 95 }),
  trader('fut-2', { source: 'bybit', roi: 50, pnl: 100, arena_score: 60 }),
  trader('spot-1', { source: 'binance_spot', roi: 5, pnl: 300, arena_score: 40 }),
  trader('web3-1', { source: 'hyperliquid', roi: 80, pnl: 8000, arena_score: 70 }),
]

const mockFetch = jest.fn()
const mockFetchPage = jest.fn().mockResolvedValue(undefined)

type HookOptions = {
  traders: Trader[]
  activeTimeRange: TimeRange
  fetchPage?: typeof mockFetchPage
}

function setup(traders: Trader[] = FIXTURES, extra: Partial<HookOptions> = {}) {
  return renderHook((props: HookOptions) => useRankingFilters(props), {
    initialProps: { traders, activeTimeRange: '90D' as TimeRange, ...extra },
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  mockFetchPage.mockResolvedValue(undefined)
  mockIsPro = true
  mockAuthHeaders = { Authorization: 'Bearer test' }
  global.fetch = mockFetch as never
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) })
  // jsdom 的真实 localStorage（jest.setup 的 global mock 覆盖不了 window 上的 accessor）
  window.localStorage.clear()
  // 每个用例从干净 URL 出发 — mount effect 会读 window.location.search
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  act(() => {
    jest.runOnlyPendingTimers()
  })
  jest.useRealTimers()
})

// ---------------------------------------------------------------------------
describe('初始状态与默认值', () => {
  it('默认：all 分类 / score desc / 第 1 页 / 无激活筛选，全量透传', () => {
    const { result } = setup()
    expect(result.current.category).toBe('all')
    expect(result.current.sortColumn).toBe('score')
    expect(result.current.sortDir).toBe('desc')
    expect(result.current.currentPage).toBe(1)
    expect(result.current.searchQuery).toBe('')
    expect(result.current.hasActiveFilters).toBe(false)
    expect(result.current.filteredTraders).toHaveLength(FIXTURES.length)
  })

  it('source 取第一个 trader 的来源，空列表回退 all（表头展示依赖它）', () => {
    const { result } = setup()
    expect(result.current.source).toBe('binance_futures')
    const empty = setup([])
    expect(empty.result.current.source).toBe('all')
  })
})

// ---------------------------------------------------------------------------
describe('URL / localStorage 状态恢复', () => {
  it('?roi_min/min_score 恢复 filterConfig 并展开面板（分享链接可复现筛选）', () => {
    window.history.replaceState(null, '', '/?roi_min=60&min_score=65')
    const { result } = setup()
    expect(result.current.filterConfig).toEqual({ roi_min: 60, min_score: 65 })
    expect(result.current.showAdvancedFilter).toBe(true)
    expect(result.current.hasActiveFilters).toBe(true)
    // roi>=60 且 score>=65：只剩 fut-1(200/95) 和 web3-1(80/70)
    expect(result.current.filteredTraders.map((t) => t.id)).toEqual(['fut-1', 'web3-1'])
  })

  it('?sort/order/page/q 恢复排序/分页/搜索状态', () => {
    window.history.replaceState(null, '', '/?sort=roi&order=asc&page=3&q=alice')
    const { result } = setup()
    expect(result.current.sortColumn).toBe('roi')
    expect(result.current.sortDir).toBe('asc')
    expect(result.current.currentPage).toBe(3)
    expect(result.current.searchQuery).toBe('alice')
  })

  it('非法 sort 值被忽略（防 URL 注入未知列导致 API 400）', () => {
    window.history.replaceState(null, '', '/?sort=__proto__&order=sideways')
    const { result } = setup()
    expect(result.current.sortColumn).toBe('score')
    expect(result.current.sortDir).toBe('desc')
  })

  it('合法 ?preset=cex_spot 生效：只留 spot 来源的 trader', () => {
    window.history.replaceState(null, '', '/?preset=cex_spot')
    const { result } = setup()
    expect(result.current.filteredTraders.map((t) => t.id)).toEqual(['spot-1'])
  })

  it('指标类 preset（high_pnl）生效：pnl>=10000 才保留（回归锁：曾只传 {source} 致 4/8 预设失效）', () => {
    // 2026-07-03 修复:此前 presetConfig.filter({ source }) 让 pnl/win_rate/arena_score
    // 全 undefined → metric 预设 0 匹配 → 空结果 fallback 全量透传 + auto-clear 清掉预设。
    // 修复后传完整 trader,high_pnl 只留 fut-1(pnl 20000),预设保留在 localStorage。
    window.history.replaceState(null, '', '/?preset=high_pnl')
    const { result } = setup()
    expect(result.current.filteredTraders.map((t) => t.id)).toEqual(['fut-1'])
    // 注:URL 恢复的 preset 不自动写 localStorage(只有用户主动选择才持久化)
  })

  it('非法 preset 被 isValidPresetId 拒绝，全量透传', () => {
    window.history.replaceState(null, '', '/?preset=bogus_preset')
    const { result } = setup()
    expect(result.current.filteredTraders).toHaveLength(FIXTURES.length)
  })

  it('preset 无任何匹配时自动清除（防陈旧 preset 让榜单看似空）', () => {
    // 只有 futures trader，却带 onchain_dex preset → effect 清除并删 localStorage
    window.history.replaceState(null, '', '/?preset=onchain_dex')
    window.localStorage.setItem('ranking-preset', 'onchain_dex')
    const { result } = setup([trader('fut-only', { source: 'binance_futures' })])
    expect(result.current.filteredTraders).toHaveLength(1)
    expect(window.localStorage.getItem('ranking-preset')).toBeNull()
  })

  it('?ex=binance-futures 解析为规范 slug 并做客户端过滤（无 fetchPage 时）', () => {
    window.history.replaceState(null, '', '/?ex=binance-futures')
    const { result } = setup()
    expect(result.current.selectedExchange).toBe('binance_futures')
    expect(result.current.filteredTraders.map((t) => t.id)).toEqual(['fut-1'])
  })

  it('legacy ?exchange=binance 走服务端通道：设置 selectedExchange 并触发 fetchPage', () => {
    // 旧分享链接 /?exchange=binance 仍要能用 — alias binance → binance_futures
    window.history.replaceState(null, '', '/?exchange=binance')
    const { result } = setup(FIXTURES, { fetchPage: mockFetchPage })
    expect(result.current.selectedExchange).toBe('binance_futures')
    expect(mockFetchPage).toHaveBeenCalledWith(0, { exchange: 'binance_futures' })
  })

  it('URL 为空时从 localStorage 恢复 filterConfig（用户偏好跨会话保留）', () => {
    window.localStorage.setItem('ranking-filter-config', JSON.stringify({ min_pnl: 5000 }))
    const { result } = setup()
    expect(result.current.filterConfig).toEqual({ min_pnl: 5000 })
    // min_pnl>=5000：fut-1(20000) 和 web3-1(8000)
    expect(result.current.filteredTraders.map((t) => t.id)).toEqual(['fut-1', 'web3-1'])
  })
})

// ---------------------------------------------------------------------------
describe('分类过滤（filterByCategory 真实实现）', () => {
  it('客户端模式：futures/spot/web3 各自过滤正确', () => {
    const { result } = setup()
    act(() => result.current.setCategory('futures'))
    expect(result.current.filteredTraders.map((t) => t.id)).toEqual(['fut-1', 'fut-2'])
    act(() => result.current.setCategory('spot'))
    expect(result.current.filteredTraders.map((t) => t.id)).toEqual(['spot-1'])
    act(() => result.current.setCategory('web3'))
    expect(result.current.filteredTraders.map((t) => t.id)).toEqual(['web3-1'])
  })

  it('服务端模式：setCategory 把 web3 映射为 onchain 传给 fetchPage，客户端不再二次过滤', () => {
    const { result } = setup(FIXTURES, { fetchPage: mockFetchPage })
    act(() => result.current.setCategory('web3'))
    expect(mockFetchPage).toHaveBeenCalledWith(0, { category: 'onchain' })
    expect(result.current.currentPage).toBe(1)
    // API 已按分类过滤，客户端跳过 — 否则双重过滤会把返回页过滤成空
    expect(result.current.filteredTraders).toHaveLength(FIXTURES.length)
  })
})

// ---------------------------------------------------------------------------
describe('高级筛选 handleFilterChange', () => {
  it('roi_min 过滤生效并持久化到 localStorage', () => {
    const { result } = setup()
    act(() => result.current.handleFilterChange({ roi_min: 60 }))
    expect(result.current.filteredTraders.map((t) => t.id)).toEqual(['fut-1', 'web3-1'])
    expect(window.localStorage.getItem('ranking-filter-config')).toBe(
      JSON.stringify({ roi_min: 60 })
    )
    // 清空 config → 移除持久化，避免下次会话恢复出幽灵筛选
    act(() => result.current.handleFilterChange({}))
    expect(result.current.hasActiveFilters).toBe(false)
    expect(window.localStorage.getItem('ranking-filter-config')).toBeNull()
  })

  it('grade 过滤按真实评分等级（S >= 90）；score 为 null 的 trader 不被 grade 排除', () => {
    const withNullScore = [...FIXTURES, trader('no-score', { arena_score: undefined })]
    const { result } = setup(withNullScore)
    act(() => result.current.handleFilterChange({ grade: 'S' }))
    // fut-1(95)=S 保留；null score 者按当前实现直接放行（grade 只约束有分者）
    expect(result.current.filteredTraders.map((t) => t.id)).toEqual(['fut-1', 'no-score'])
  })

  it('exchange 数组过滤走 resolveExchangeSlug（hyphen slug 也能命中下划线 source）', () => {
    const { result } = setup()
    act(() => result.current.handleFilterChange({ exchange: ['binance-futures'] }))
    expect(result.current.filteredTraders.map((t) => t.id)).toEqual(['fut-1'])
  })
})

// ---------------------------------------------------------------------------
describe('排序 / 分页 / 搜索', () => {
  it('handleSortChange 更新状态、重置页码，并把列名映射为 API 字段', () => {
    const { result } = setup(FIXTURES, { fetchPage: mockFetchPage })
    act(() => result.current.handleSortChange('winrate', 'asc'))
    expect(result.current.sortColumn).toBe('winrate')
    expect(result.current.sortDir).toBe('asc')
    expect(result.current.currentPage).toBe(1)
    // winrate → win_rate：API 的排序字段是 snake_case
    expect(mockFetchPage).toHaveBeenCalledWith(0, {
      category: undefined,
      sortBy: 'win_rate',
      sortDir: 'asc',
    })
  })

  it('排序状态经 300ms 防抖同步到 URL（分享链接携带排序）', () => {
    const { result } = setup()
    act(() => result.current.handleSortChange('roi', 'asc'))
    act(() => {
      jest.advanceTimersByTime(300)
    })
    const params = new URLSearchParams(window.location.search)
    expect(params.get('sort')).toBe('roi')
    expect(params.get('order')).toBe('asc')
  })

  it('handlePageChange 把 1-based UI 页码转成 0-based API 页码，且带上当前排序', () => {
    const { result } = setup(FIXTURES, { fetchPage: mockFetchPage })
    act(() => result.current.handleSortChange('roi', 'desc'))
    mockFetchPage.mockClear()
    act(() => result.current.handlePageChange(3))
    expect(result.current.currentPage).toBe(3)
    expect(mockFetchPage).toHaveBeenCalledWith(2, {
      category: undefined,
      sortBy: 'roi',
      sortDir: 'desc',
    })
  })

  it('handleSearchChange 设置 query 并重置页码（新搜索不该停留在旧页）', () => {
    const { result } = setup()
    act(() => result.current.handlePageChange(5))
    act(() => result.current.handleSearchChange('fut-1'))
    expect(result.current.searchQuery).toBe('fut-1')
    expect(result.current.currentPage).toBe(1)
  })
})

// ---------------------------------------------------------------------------
describe('Pro 门控与免费上限', () => {
  it('免费用户客户端榜单截断到 FREE_LEADERBOARD_LIMIT；Pro 不截断', () => {
    const many = Array.from({ length: FREE_LEADERBOARD_LIMIT + 1 }, (_, i) =>
      trader(`t-${i}`, { source: 'bybit' })
    )
    mockIsPro = false
    const free = setup(many)
    expect(free.result.current.filteredTraders).toHaveLength(FREE_LEADERBOARD_LIMIT)

    mockIsPro = true
    const pro = setup(many)
    expect(pro.result.current.filteredTraders).toHaveLength(FREE_LEADERBOARD_LIMIT + 1)
  })

  it('handleProRequired 只埋点不弹 toast（漏斗从 paywall_blocked 开始）', () => {
    const { result } = setup()
    act(() => result.current.handleProRequired())
    expect(trackEvent).toHaveBeenCalledWith('paywall_blocked', {
      source: 'home_ranking_filters',
    })
    expect(mockShowToast).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
describe('保存筛选器 API', () => {
  it('未登录保存 → pleaseLogin toast，且不发请求（避免必 401 的无效调用）', async () => {
    mockAuthHeaders = null
    const { result } = setup()
    await act(async () => {
      await result.current.handleSaveFilter('my filter')
    })
    expect(mockShowToast).toHaveBeenCalledWith('pleaseLogin', 'error')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('保存成功 → POST /api/saved-filters + 本地列表追加 + 成功 toast', async () => {
    const saved = { id: 'f1', name: 'my filter', filter_config: { roi_min: 60 } }
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ filter: saved }) })
    const { result } = setup()
    act(() => result.current.handleFilterChange({ roi_min: 60 }))
    await act(async () => {
      await result.current.handleSaveFilter('my filter')
    })
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/saved-filters',
      expect.objectContaining({ method: 'POST' })
    )
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toEqual({
      name: 'my filter',
      description: undefined,
      filter_config: { roi_min: 60 },
    })
    expect(result.current.savedFilters).toEqual([saved])
    expect(mockShowToast).toHaveBeenCalledWith('filterSaved', 'success')
  })

  it('保存失败（服务端返回 error 字段）→ 用服务端消息弹错误 toast', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'limit reached' }),
    })
    const { result } = setup()
    await act(async () => {
      await result.current.handleSaveFilter('my filter')
    })
    expect(result.current.savedFilters).toEqual([])
    expect(mockShowToast).toHaveBeenCalledWith('limit reached', 'error')
  })

  it('删除成功 → DELETE 带 id 查询参数 + 本地列表移除', async () => {
    const saved = { id: 'f1', name: 'n', filter_config: {} }
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ filter: saved }) })
    const { result } = setup()
    await act(async () => {
      await result.current.handleSaveFilter('n')
    })
    expect(result.current.savedFilters).toHaveLength(1)

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    await act(async () => {
      await result.current.handleDeleteFilter('f1')
    })
    expect(mockFetch).toHaveBeenLastCalledWith(
      '/api/saved-filters?id=f1',
      expect.objectContaining({ method: 'DELETE' })
    )
    expect(result.current.savedFilters).toEqual([])
  })
})

// ---------------------------------------------------------------------------
describe('重置与外部事件', () => {
  it('handleResetFilters 清空全部筛选并显式清除服务端 sticky exchange/category', () => {
    window.history.replaceState(null, '', '/?ex=binance-futures&roi_min=60')
    const { result } = setup(FIXTURES, { fetchPage: mockFetchPage })
    mockFetchPage.mockClear()
    act(() => result.current.handleResetFilters())
    expect(result.current.hasActiveFilters).toBe(false)
    expect(result.current.selectedExchange).toBeNull()
    expect(result.current.category).toBe('all')
    // exchange: undefined 必须显式传 — fetchPage 的 sticky filter 只认显式覆盖
    expect(mockFetchPage).toHaveBeenCalledWith(0, { exchange: undefined, category: undefined })
  })

  it('arena:filter-exchange 事件（交易所合作栏点击）设置筛选并触发服务端拉取', () => {
    const { result } = setup(FIXTURES, { fetchPage: mockFetchPage })
    act(() => {
      window.dispatchEvent(
        new CustomEvent('arena:filter-exchange', { detail: { exchange: 'bybit' } })
      )
    })
    expect(result.current.selectedExchange).toBe('bybit')
    expect(mockFetchPage).toHaveBeenCalledWith(0, { exchange: 'bybit' })
  })

  it('formatLastUpdated 按时间差返回对应文案 key（表尾新鲜度提示）', () => {
    const { result } = setup()
    const fmt = result.current.formatLastUpdated
    const now = Date.now()
    expect(fmt(null)).toBeNull()
    expect(fmt(new Date(now - 30_000).toISOString())).toBe('justUpdated')
    expect(fmt(new Date(now - 5 * 60_000).toISOString())).toBe('minutesAgoShort')
    expect(fmt(new Date(now - 3 * 3_600_000).toISOString())).toBe('hoursAgoShort')
    expect(fmt(new Date(now - 2 * 86_400_000).toISOString())).toBe('daysAgoShort')
  })
})
