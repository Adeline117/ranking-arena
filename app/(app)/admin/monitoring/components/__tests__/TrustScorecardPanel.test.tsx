/**
 * TrustScorecardPanel 渲染冒烟(2026-07-11):面板上线时只做了 tsc/API 级
 * 验证,渲染从未真点——mock 真实 RPC 形状,断言四类块出数、日增号位正确。
 */
import { render, screen, waitFor } from '@testing-library/react'
import TrustScorecardPanel from '../TrustScorecardPanel'

const SCORECARD = {
  series: [
    {
      taken_on: '2026-07-11',
      payload: {
        serving_total: 19239,
        with_series: 14422,
        top500_total: 500,
        top500_with_series: 475,
      },
    },
    {
      taken_on: '2026-07-10',
      payload: {
        serving_total: 19353,
        with_series: 13193,
        top500_total: 313,
        top500_with_series: 292,
      },
    },
  ],
  onchain: [
    { slug: 'binance_web3_bsc', serving: 891, enriched: 668, fresh7d: 668 },
    { slug: 'okx_web3_solana', serving: 3333, enriched: 2334, fresh7d: 1810 },
  ],
  claims: { total: 0, verified: 0, reviewing: 0, active_authorizations: 0 },
  community: { last_bot_post_at: null, bot_posts_7d: 0 },
}

describe('TrustScorecardPanel', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, scorecard: SCORECARD }),
    }) as jest.Mock
  })

  it('renders coverage, onchain and claims tiles from the real RPC shape', async () => {
    render(<TrustScorecardPanel accessToken="tok" />)
    await waitFor(() => expect(screen.getByText('可信度记分卡')).toBeInTheDocument())
    // 序列覆盖 14422/19239 = 75.0%(BSC 668/891 也恰为 75.0%——允许多处)
    expect(screen.getAllByText('75.0%').length).toBeGreaterThanOrEqual(1)
    // top500 475/500 = 95.0%
    expect(screen.getByText('95.0%')).toBeInTheDocument()
    // 日增 = 14422-13193 = +1229
    expect(screen.getByText(/日增 \+1229/)).toBeInTheDocument()
    // 链上两源块
    expect(screen.getByText(/binance web3 bsc/)).toBeInTheDocument()
    expect(screen.getByText(/okx web3 solana/)).toBeInTheDocument()
    // 认领块(0 也要渲染,不许 NULL-collapse——这是进度指标不是装饰)
    expect(screen.getByText('交易员认领')).toBeInTheDocument()
    // bot 帖块已随 owner 决策移除
    expect(screen.queryByText(/bot 帖/)).not.toBeInTheDocument()
  })

  it('renders nothing when the API fails (silent panel, no crash)', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue({ ok: false })
    const { container } = render(<TrustScorecardPanel accessToken="tok" />)
    await waitFor(() => expect(container.querySelector('section')).not.toBeInTheDocument())
  })
})
