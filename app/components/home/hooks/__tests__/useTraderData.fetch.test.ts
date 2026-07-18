/**
 * useTraderData — fetchPage 数据面行为（与 useTraderData.test.tsx 的时间档切换互补）。
 *
 * 保护的契约：
 * - 无 SSR 数据时挂载即拉取，成功后填充 traders / totalCount / lastUpdated
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
const mockOn = jest.fn(() => () => {})
jest.mock('@/lib/hooks/useBroadcastSync', () => ({
  useTraderDataSync: () => ({ broadcast: mockBroadcast, on: mockOn }),
}))

import { useTraderData } from '../useTraderData'

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
    expect(result.current.lastUpdated).toBe('2026-07-03T00:00:00Z')
    expect(result.current.availableSources).toEqual(['bybit'])
    // 多标签页同步：成功加载必须广播给其他 tab
    expect(mockBroadcast).toHaveBeenCalledWith(
      'TRADER_DATA_UPDATED',
      expect.objectContaining({ timeRange: '90D' })
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
})

// ---------------------------------------------------------------------------
describe('payload 字段转换', () => {
  it('字符串数字归一为 number，缺失指标归 null，is_bot 默认 false', async () => {
    mockPayloadOnce({
      traders: [
        apiTrader('t-str', {
          roi: '12.5', // API 偶发返回字符串数字 — UI 计算前必须归一
          pnl: '1000',
          win_rate: undefined, // 缺失指标必须是 null 而非 NaN/undefined
          sharpe_ratio: null,
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
