import { createHash } from 'node:crypto'

import { scoreInputSetSha256, SCORE_INPUT_SET_CONTRACT } from '../score-input-digest'
import type { SourcePublicationScoreRow } from '../source-publication-evidence'

function row(overrides: Partial<SourcePublicationScoreRow> = {}): SourcePublicationScoreRow {
  return {
    platform: 'alpha',
    market_type: 'futures',
    trader_key: 'trader-1',
    board_rank: 1,
    roi_pct: 12.5,
    pnl_usd: 250,
    win_rate: 60,
    max_drawdown: 8,
    copiers: null,
    trades_count: null,
    sharpe_ratio: 1.2,
    sortino_ratio: null,
    calmar_ratio: null,
    volatility_pct: null,
    unevidenced_metrics: ['trades_count'],
    trader_kind: null,
    handle: 'Alpha',
    avatar_url: null,
    currency: 'USDT',
    as_of: '2026-11-16T00:00:00.000000Z',
    board_as_of: '2026-11-16T00:00:00.000000Z',
    ...overrides,
  }
}

describe('scoreInputSetSha256 (arena-score-input-set@1)', () => {
  it('hashes the canonical scored tuple of exactly one source', () => {
    const expected = createHash('sha256')
      .update(
        JSON.stringify({
          contract: SCORE_INPUT_SET_CONTRACT,
          season: '90D',
          source: 'alpha',
          rows: [
            [
              'trader-1',
              1,
              12.5,
              250,
              60,
              8,
              null,
              null,
              1.2,
              null,
              null,
              null,
              '2026-11-16T00:00:00.000000Z',
              '2026-11-16T00:00:00.000000Z',
            ],
          ],
        })
      )
      .digest('hex')
    expect(
      scoreInputSetSha256('90D', 'alpha', [row(), row({ platform: 'beta', trader_key: 'x' })])
    ).toBe(expected)
  })

  it('is independent of row order and of display-only fields', () => {
    const a = row({ trader_key: 'a', board_rank: 1 })
    const b = row({ trader_key: 'b', board_rank: 2 })
    expect(scoreInputSetSha256('90D', 'alpha', [a, b])).toBe(
      scoreInputSetSha256('90D', 'alpha', [b, { ...a, handle: 'renamed', avatar_url: '/x.png' }])
    )
  })

  it('changes with any scored value, the season, or the row set', () => {
    const base = scoreInputSetSha256('90D', 'alpha', [row()])
    expect(scoreInputSetSha256('90D', 'alpha', [row({ max_drawdown: 9 })])).not.toBe(base)
    expect(scoreInputSetSha256('90D', 'alpha', [row({ sharpe_ratio: null })])).not.toBe(base)
    expect(scoreInputSetSha256('30D', 'alpha', [row()])).not.toBe(base)
    expect(scoreInputSetSha256('90D', 'alpha', [])).not.toBe(base)
  })
})
