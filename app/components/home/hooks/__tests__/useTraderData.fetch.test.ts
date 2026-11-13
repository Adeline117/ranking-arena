/**
 * useTraderData — fetchPage 数据面行为（与 useTraderData.test.tsx 的时间档切换互补）。
 *
 * 保护的契约：
 * - 无 SSR 数据时挂载即拉取，成功后填充 traders / explicit count authority / lastUpdated
 * - API payload → Trader 的字段转换（字符串数字归一、缺失归 null、is_bot 默认 false）
 * - 失败降级：有旧数据时静默保留（error 不设置，避免错误框替换内容造成 CLS），
 *   无旧数据时才暴露 error
 * - sticky filters：exchange/category/sort 一经设置跨调用保留，显式 undefined 才清除
 * - 指纹去重：数据未变时跳过 dispatch（60s 自动刷新不触发 50 行重渲染）
 */

import { renderHook, act, waitFor } from '@testing-library/react'
import type { Trader } from '../../../ranking/RankingTable'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))

// 稳定身份 — fetchPage 依赖 broadcast；每次渲染换新函数会让 fetch effect 无限循环
const mockBroadcast = jest.fn()
const mockOn = jest.fn((_event: unknown, _handler: (payload: unknown) => void) => () => {})
jest.mock('@/lib/hooks/useBroadcastSync', () => ({
  useTraderDataSync: () => ({ broadcast: mockBroadcast, on: mockOn }),
}))

import { useTraderData, clearTraderCohortCache } from '../useTraderData'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function apiTrader(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    handle: id,
    roi: 10,
    pnl: 100,
    source: 'bybit',
    rank: 1,
    arena_score: 50,
    ...overrides,
  }
}

const ssrTrader = {
  id: 'ssr-1',
  handle: 'ssr',
  roi: 1,
  pnl: 1,
  followers: 0,
  source: 'bybit',
  arena_score: 10,
  rank: 1,
} as unknown as Trader

const mockFetch = jest.fn()
let broadcastHandler: ((payload: unknown) => void) | undefined

function mockPayloadOnce(payload: Record<string, unknown>, ok = true, status = 200) {
  mockFetch.mockResolvedValueOnce({ ok, status, json: async () => payload })
}

function fetchUrls(): string[] {
  return mockFetch.mock.calls.map((c) => String(c[0]))
}

function setup(options: Parameters<typeof useTraderData>[0] = {}) {
  // autoRefreshInterval: 0 — 关闭 60s 轮询，避免测试里出现不受控的后台 fetch
  return renderHook(() => useTraderData({ autoRefreshInterval: 0, ...options }))
}

beforeEach(() => {
  jest.clearAllMocks()
  clearTraderCohortCache()
  broadcastHandler = undefined
  mockOn.mockImplementation((_event: unknown, handler: (payload: unknown) => void) => {
    broadcastHandler = handler
    return () => {}
  })
  global.fetch = mockFetch as never
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ traders: [] }) })
  window.localStorage.clear()
})

// ---------------------------------------------------------------------------
describe('挂载与加载态', () => {
  it('无 SSR 数据：挂载即 loading 并拉取 90D 第 0 页，成功后填充全部字段', async () => {
    mockPayloadOnce({
      traders: [apiTrader('t-1')],
      lastUpdated: '2026-07-03T00:00:00Z',
      availableSources: ['bybit'],
      totalCount: 42,
      totalCountIsExact: true,
      hasMore: true,
    })
    const { result } = setup()

    // 首屏没有可展示的行 → 必须亮 loading 骨架
    expect(result.current.loading).toBe(true)
    expect(result.current.traders).toHaveLength(0)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(fetchUrls()[0]).toContain('timeRange=90D')
    expect(fetchUrls()[0]).toContain('page=0')
    expect(result.current.traders.map((t) => t.id)).toEqual(['t-1'])
    expect(result.current.totalCount).toBe(42)
    expect(result.current.totalCountIsExact).toBe(true)
    expect(result.current.hasMore).toBe(true)
    expect(result.current.lastUpdated).toBe('2026-07-03T00:00:00Z')
    expect(result.current.availableSources).toEqual(['bybit'])
    // 多标签页同步：成功加载必须广播给其他 tab
    expect(mockBroadcast).toHaveBeenCalledWith(
      'TRADER_DATA_UPDATED',
      expect.objectContaining({
        timeRange: '90D',
        cohort: {
          timeRange: '90D',
          pageIndex: 0,
          category: null,
          sortBy: 'arena_score',
          sortDir: 'desc',
          exchange: null,
        },
      })
    )
  })

  it('有 SSR 数据：挂载不发请求、不闪 loading，并保留服务端 freshness', () => {
    const { result } = setup({
      initialTraders: [ssrTrader],
      initialTotalCount: 1,
      initialIsStale: true,
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.traders[0].id).toBe('ssr-1')
    expect(result.current.isStale).toBe(true)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('clears legacy numeric totals unless the payload explicitly proves they are exact', async () => {
    const { result } = setup({
      initialTraders: [ssrTrader],
      initialTotalCount: 999,
      initialIsStale: false,
    })
    expect(result.current.totalCount).toBeNull()
    expect(result.current.totalCountIsExact).toBe(false)

    mockPayloadOnce({
      traders: [apiTrader('unknown-total')],
      totalCount: 999,
      totalCountIsExact: false,
      hasMore: true,
    })
    await act(async () => {
      await result.current.fetchPage(0)
    })

    expect(result.current.totalCount).toBeNull()
    expect(result.current.totalCountIsExact).toBe(false)
    expect(result.current.hasMore).toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe('payload 字段转换', () => {
  it('字符串数字归一为 number，缺失或非有限指标归 null，is_bot 默认 false', async () => {
    mockPayloadOnce({
      traders: [
        apiTrader('t-str', {
          roi: '12.5', // API 偶发返回字符串数字 — UI 计算前必须归一
          pnl: '1000',
          win_rate: undefined, // 缺失指标必须是 null 而非 NaN/undefined
          sharpe_ratio: null,
          max_drawdown: Number.NaN,
          arena_score: Number.POSITIVE_INFINITY,
          is_bot: undefined,
        }),
      ],
    })
    const { result } = setup()
    await waitFor(() => expect(result.current.loading).toBe(false))

    const t = result.current.traders[0]
    expect(t.roi).toBe(12.5)
    expect(t.pnl).toBe(1000)
    expect(t.win_rate).toBeNull()
    expect(t.max_drawdown).toBeNull()
    expect(t.arena_score).toBeNull()
    expect(t.sharpe_ratio).toBeNull()
    expect(t.is_bot).toBe(false)
  })
})

// ---------------------------------------------------------------------------
describe('错误降级', () => {
  it('无旧数据 + HTTP 500 → 暴露带状态码的 error', async () => {
    mockPayloadOnce({}, false, 500)
    const { result } = setup()
    await waitFor(() => expect(result.current.loading).toBe(false))
    // t 是 identity mock → 消息为 "loadFailed (500)"
    expect(result.current.error).toContain('500')
    expect(result.current.traders).toHaveLength(0)
  })

  it('有旧数据 + 网络失败 → 静默保留旧行，error 不设置，只标 lastRefreshFailed', async () => {
    const { result } = setup({ initialTraders: [ssrTrader], initialTotalCount: 1 })
    mockFetch.mockRejectedValueOnce(new Error('network down'))
    await act(async () => {
      await result.current.fetchPage(0)
    })
    // 错误框替换已有内容会造成 CLS + 吓退用户 — 旧数据在手就静默降级
    expect(result.current.error).toBeNull()
    expect(result.current.traders[0].id).toBe('ssr-1')
    expect(result.current.lastRefreshFailed).toBe(true)
  })

  it('8s 超时按失败处理：无旧数据时暴露 errorTimeout（可重试），不落成“暂无数据”', async () => {
    jest.useFakeTimers()
    try {
      // fetch 只在 signal abort 时以 AbortError 结束，模拟一直挂起的慢接口
      mockFetch.mockImplementationOnce(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              const err = new Error('aborted')
              err.name = 'AbortError'
              reject(err)
            })
          })
      )
      const { result } = setup()
      await act(async () => {
        jest.advanceTimersByTime(8_000)
        await Promise.resolve()
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(result.current.loading).toBe(false)
      expect(result.current.error).toBe('errorTimeout')
      expect(result.current.traders).toHaveLength(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it('API 的 source freshness 标记进入独立 isStale 状态', async () => {
    const { result } = setup({ initialTraders: [ssrTrader], initialTotalCount: 1 })
    mockPayloadOnce({ traders: [apiTrader('t-stale')], isStale: true })
    await act(async () => {
      await result.current.fetchPage(0)
    })
    expect(result.current.isStale).toBe(true)
    expect(result.current.staleDataWarning).toBe(false)
  })
})

// ---------------------------------------------------------------------------
describe('sticky filters（交易所页 bug 的根因防回归）', () => {
  it('exchange 设置一次后跨调用保留，且 slug 被解析为规范 key', async () => {
    const { result } = setup({ initialTraders: [ssrTrader], initialTotalCount: 1 })

    mockPayloadOnce({ traders: [apiTrader('a')] })
    await act(async () => {
      await result.current.fetchPage(0, { exchange: 'binance-futures' })
    })
    // hyphen URL slug → 下划线 DB key
    expect(fetchUrls()[0]).toContain('exchange=binance_futures')

    // 翻页时 caller 不重复传 exchange — sticky 必须自动带上
    mockPayloadOnce({ traders: [apiTrader('b')] })
    await act(async () => {
      await result.current.fetchPage(1)
    })
    expect(fetchUrls()[1]).toContain('page=1')
    expect(fetchUrls()[1]).toContain('exchange=binance_futures')

    // 显式 undefined 才清除
    mockPayloadOnce({ traders: [apiTrader('c')] })
    await act(async () => {
      await result.current.fetchPage(0, { exchange: undefined })
    })
    expect(fetchUrls()[2]).not.toContain('exchange=')
  })

  it('category=all 与默认排序 arena_score 不进 URL（保持 API 缓存 key 干净）', async () => {
    const { result } = setup({ initialTraders: [ssrTrader], initialTotalCount: 1 })

    mockPayloadOnce({ traders: [apiTrader('a')] })
    await act(async () => {
      await result.current.fetchPage(0, { category: 'all', sortBy: 'arena_score', sortDir: 'desc' })
    })
    expect(fetchUrls()[0]).not.toContain('category=')
    expect(fetchUrls()[0]).not.toContain('sortBy=')

    // 非默认排序才携带 sortBy + order，且随后调用 sticky 保留
    mockPayloadOnce({ traders: [apiTrader('b')] })
    await act(async () => {
      await result.current.fetchPage(0, { category: 'futures', sortBy: 'roi', sortDir: 'asc' })
    })
    expect(fetchUrls()[1]).toContain('category=futures')
    expect(fetchUrls()[1]).toContain('sortBy=roi&order=asc')

    mockPayloadOnce({ traders: [apiTrader('c')] })
    await act(async () => {
      await result.current.fetchPage(2)
    })
    expect(fetchUrls()[2]).toContain('category=futures')
    expect(fetchUrls()[2]).toContain('sortBy=roi&order=asc')
  })
})

// ---------------------------------------------------------------------------
describe('指纹去重', () => {
  it('指标相同但 lastUpdated/isStale 变化时仍传播 freshness', async () => {
    const { result } = setup({ initialTraders: [ssrTrader], initialTotalCount: 1 })

    const sameTraders = [apiTrader('t-1', { arena_score: 50, roi: 10 })]
    mockPayloadOnce({
      traders: sameTraders,
      lastUpdated: '2026-07-03T00:00:00Z',
      isStale: false,
    })
    await act(async () => {
      await result.current.fetchPage(0)
    })
    expect(result.current.lastUpdated).toBe('2026-07-03T00:00:00Z')
    expect(result.current.isStale).toBe(false)

    // 排名指标完全相同，但来源水位与陈旧状态变化：必须越过指标去重。
    mockPayloadOnce({
      traders: sameTraders,
      lastUpdated: '2026-07-03T01:00:00Z',
      isStale: true,
    })
    await act(async () => {
      await result.current.fetchPage(0)
    })
    expect(result.current.lastUpdated).toBe('2026-07-03T01:00:00Z')
    expect(result.current.isStale).toBe(true)
    expect(result.current.loading).toBe(false)

    // 数据真变了（roi 变化）→ 正常更新
    mockPayloadOnce({
      traders: [apiTrader('t-1', { arena_score: 50, roi: 99 })],
      lastUpdated: '2026-07-03T02:00:00Z',
      isStale: false,
    })
    await act(async () => {
      await result.current.fetchPage(0)
    })
    expect(result.current.lastUpdated).toBe('2026-07-03T02:00:00Z')
    expect(result.current.isStale).toBe(false)
    expect(result.current.traders[0].roi).toBe(99)
  })
})

// ---------------------------------------------------------------------------
describe('pagination cohort integrity', () => {
  it('manual refresh keeps the loaded page and complete sticky cohort', async () => {
    const { result } = setup({ initialTraders: [ssrTrader], initialTotalCount: 1 })

    mockPayloadOnce({ traders: [apiTrader('page-3')], hasMore: true })
    await act(async () => {
      await result.current.fetchPage(2, {
        category: 'futures',
        sortBy: 'roi',
        sortDir: 'asc',
        exchange: 'binance-futures',
      })
    })

    mockPayloadOnce({ traders: [apiTrader('page-3-refresh')], hasMore: true })
    await act(async () => {
      await result.current.refresh()
    })

    const url = new URL(fetchUrls().at(-1)!, 'https://arena.example')
    expect(url.searchParams.get('page')).toBe('2')
    expect(url.searchParams.get('category')).toBe('futures')
    expect(url.searchParams.get('sortBy')).toBe('roi')
    expect(url.searchParams.get('order')).toBe('asc')
    expect(url.searchParams.get('exchange')).toBe('binance_futures')
  })

  it('ignores cross-tab rows for the same range but a different page/filter cohort', async () => {
    const { result } = setup({ initialTraders: [ssrTrader], initialTotalCount: 1 })

    mockPayloadOnce({ traders: [apiTrader('local-page-3')], hasMore: true })
    await act(async () => {
      await result.current.fetchPage(2, {
        category: 'all',
        sortBy: 'roi',
        sortDir: 'asc',
        exchange: undefined,
      })
    })
    expect(result.current.traders[0].id).toBe('local-page-3')
    expect(broadcastHandler).toBeDefined()

    await act(async () => {
      broadcastHandler?.({
        timeRange: '90D',
        traders: [apiTrader('wrong-page')],
        lastUpdated: '2026-07-03T00:00:00Z',
        cohort: {
          timeRange: '90D',
          pageIndex: 0,
          category: null,
          sortBy: 'roi',
          sortDir: 'asc',
          exchange: null,
        },
        availableSources: ['bybit'],
        totalCount: null,
        totalCountIsExact: false,
        hasMore: true,
        categoryCounts: null,
        categoryCountsAreExact: false,
      })
    })
    expect(result.current.traders[0].id).toBe('local-page-3')

    await act(async () => {
      broadcastHandler?.({
        timeRange: '90D',
        traders: [apiTrader('wrong-null-vs-all')],
        lastUpdated: '2026-07-03T00:00:00Z',
        cohort: {
          timeRange: '90D',
          pageIndex: 2,
          category: 'all',
          sortBy: 'roi',
          sortDir: 'asc',
          exchange: null,
        },
        availableSources: ['bybit'],
        totalCount: null,
        totalCountIsExact: false,
        hasMore: true,
        categoryCounts: null,
        categoryCountsAreExact: false,
      })
    })
    expect(result.current.traders[0].id).toBe('local-page-3')
  })

  it('does not let a pending local interaction accept its target cohort from broadcast', async () => {
    const { result } = setup({ initialTraders: [ssrTrader], initialTotalCount: 1 })
    let rejectTarget!: (reason?: unknown) => void
    const pendingTarget = new Promise<Response>((_resolve, reject) => {
      rejectTarget = reject
    })
    mockFetch.mockReset()
    mockFetch.mockImplementationOnce(() => pendingTarget)

    let localRequest!: Promise<boolean>
    act(() => {
      localRequest = result.current.fetchPage(1, { sortBy: 'roi', sortDir: 'asc' })
    })

    await act(async () => {
      broadcastHandler?.({
        timeRange: '90D',
        traders: [apiTrader('broadcast-pending-target')],
        lastUpdated: '2026-07-03T00:00:00Z',
        cohort: {
          timeRange: '90D',
          pageIndex: 1,
          category: null,
          sortBy: 'roi',
          sortDir: 'asc',
          exchange: null,
        },
        availableSources: ['bybit'],
        totalCount: null,
        totalCountIsExact: false,
        hasMore: true,
        categoryCounts: null,
        categoryCountsAreExact: false,
      })
    })
    // The UI still labels the SSR score/page-1 cohort, so the new rows must
    // wait for this tab's own successful commit.
    expect(result.current.traders[0].id).toBe('ssr-1')

    rejectTarget(new Error('target request failed'))
    await act(async () => {
      await expect(localRequest).resolves.toBe(false)
    })
    expect(result.current.traders[0].id).toBe('ssr-1')
  })

  it('builds B=category from the loaded cohort, never a pending A=ROI/exchange target', async () => {
    const { result } = setup({ initialTraders: [ssrTrader], initialTotalCount: 1 })
    let resolveA!: (response: { ok: boolean; json: () => Promise<Record<string, unknown>> }) => void
    const pendingA = new Promise<{
      ok: boolean
      json: () => Promise<Record<string, unknown>>
    }>((resolve) => {
      resolveA = resolve
    })
    mockFetch.mockReset()
    mockFetch.mockImplementationOnce(() => pendingA)
    mockPayloadOnce({ traders: [apiTrader('category-score')], hasMore: true })

    let requestA!: Promise<boolean>
    act(() => {
      requestA = result.current.fetchPage(0, {
        sortBy: 'roi',
        sortDir: 'asc',
        exchange: 'binance-futures',
      })
    })

    await act(async () => {
      await expect(result.current.fetchPage(0, { category: 'futures' })).resolves.toBe(true)
    })

    const categoryUrl = new URL(fetchUrls()[1], 'https://arena.example')
    expect(categoryUrl.searchParams.get('category')).toBe('futures')
    expect(categoryUrl.searchParams.get('sortBy')).toBeNull()
    expect(categoryUrl.searchParams.get('exchange')).toBeNull()
    expect(result.current.traders[0].id).toBe('category-score')

    // An ignored late A must not alter B or become a future refresh baseline.
    resolveA({ ok: true, json: async () => ({ traders: [apiTrader('late-roi-exchange')] }) })
    await act(async () => {
      await expect(requestA).resolves.toBe(false)
    })

    mockPayloadOnce({ traders: [apiTrader('category-refresh')], hasMore: true })
    await act(async () => {
      await result.current.refresh()
    })
    const refreshUrl = new URL(fetchUrls().at(-1)!, 'https://arena.example')
    expect(refreshUrl.searchParams.get('category')).toBe('futures')
    expect(refreshUrl.searchParams.get('sortBy')).toBeNull()
    expect(refreshUrl.searchParams.get('exchange')).toBeNull()
    expect(result.current.traders[0].id).toBe('category-refresh')
  })

  it('rolls failed concurrent requests back to the loaded cohort, not the prior in-flight filter', async () => {
    const { result } = setup({ initialTraders: [ssrTrader], initialTotalCount: 1 })
    let resolveFirst!: (response: {
      ok: boolean
      json: () => Promise<Record<string, unknown>>
    }) => void
    const firstResponse = new Promise<{
      ok: boolean
      json: () => Promise<Record<string, unknown>>
    }>((resolve) => {
      resolveFirst = resolve
    })
    mockFetch.mockReset()
    mockFetch.mockImplementationOnce(() => firstResponse)
    mockFetch.mockRejectedValueOnce(new Error('second cohort failed'))

    let firstRequest!: Promise<boolean>
    act(() => {
      firstRequest = result.current.fetchPage(0, { sortBy: 'roi', sortDir: 'asc' })
    })
    await act(async () => {
      await result.current.fetchPage(1, { sortBy: 'pnl', sortDir: 'desc' })
    })

    // The aborted first request resolving late has no authority to change rows
    // or sticky filters after B has failed.
    resolveFirst({ ok: true, json: async () => ({ traders: [apiTrader('late-a')] }) })
    await act(async () => {
      await firstRequest
    })

    mockPayloadOnce({ traders: [apiTrader('loaded-cohort-refresh')] })
    await act(async () => {
      await result.current.refresh()
    })
    const refreshUrl = new URL(fetchUrls().at(-1)!, 'https://arena.example')
    expect(refreshUrl.searchParams.get('page')).toBe('0')
    expect(refreshUrl.searchParams.get('sortBy')).toBeNull()
    expect(refreshUrl.searchParams.get('order')).toBeNull()
    expect(result.current.traders[0].id).toBe('loaded-cohort-refresh')
  })
})
