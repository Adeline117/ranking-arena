import { prepareBoardSeriesRows } from '../publish'
import type { BoardSeriesBlock } from '../../core/types'

describe('prepareBoardSeriesRows', () => {
  it('maps traders, rejects invalid points, and deduplicates with last value winning', () => {
    const blocks = new Map<string, BoardSeriesBlock[]>([
      [
        'wallet-a',
        [
          {
            timeframe: 90,
            metric: 'pnl_daily',
            points: [
              { ts: '2026-07-01T00:00:00.000Z', value: 1 },
              { ts: '2026-06-30T17:00:00-07:00', value: 2 },
              { ts: 'not-a-date', value: 3 },
              { ts: '2026-07-02T00:00:00.000Z', value: Number.NaN },
            ],
          },
        ],
      ],
      [
        'unknown-wallet',
        [{ timeframe: 90, metric: 'pnl_daily', points: [{ ts: '2026-07-01', value: 9 }] }],
      ],
    ])

    expect(prepareBoardSeriesRows(blocks, new Map([['wallet-a', 42]]))).toEqual({
      traders: 1,
      replacements: [],
      rows: [
        {
          trader_id: 42,
          timeframe: 90,
          metric: 'pnl_daily',
          ts: '2026-07-01T00:00:00.000Z',
          value: 2,
        },
      ],
    })
  })

  it('does not count a mapped trader whose blocks have no publishable points', () => {
    const blocks = new Map<string, BoardSeriesBlock[]>([
      ['wallet-a', [{ timeframe: 0, metric: ' ', points: [{ ts: 'bad', value: 1 }] }]],
    ])
    expect(prepareBoardSeriesRows(blocks, new Map([['wallet-a', 42]]))).toEqual({
      rows: [],
      replacements: [],
      traders: 0,
    })
  })

  it('prepares only non-empty valid replacement keys and deduplicates them', () => {
    const blocks = new Map<string, BoardSeriesBlock[]>([
      [
        'wallet-a',
        [
          {
            timeframe: 30,
            metric: ' pnl ',
            replaceSeries: true,
            points: [
              { ts: 'bad', value: 1 },
              { ts: '2026-07-15T00:00:00.000Z', value: 2 },
            ],
          },
          {
            timeframe: 30,
            metric: 'pnl',
            replaceSeries: true,
            points: [{ ts: '2026-07-16T00:00:00.000Z', value: 3 }],
          },
          {
            timeframe: 7,
            metric: 'roi',
            replaceSeries: true,
            points: [{ ts: 'bad', value: 4 }],
          },
          {
            timeframe: 7,
            metric: 'roi',
            points: [{ ts: '2026-07-16T00:00:00.000Z', value: 5 }],
          },
        ],
      ],
      [
        'unknown-wallet',
        [
          {
            timeframe: 30,
            metric: 'pnl',
            replaceSeries: true,
            points: [{ ts: '2026-07-16T00:00:00.000Z', value: 9 }],
          },
        ],
      ],
    ])

    expect(prepareBoardSeriesRows(blocks, new Map([['wallet-a', 42]]))).toEqual({
      rows: [
        {
          trader_id: 42,
          timeframe: 30,
          metric: 'pnl',
          ts: '2026-07-15T00:00:00.000Z',
          value: 2,
        },
        {
          trader_id: 42,
          timeframe: 30,
          metric: 'pnl',
          ts: '2026-07-16T00:00:00.000Z',
          value: 3,
        },
        {
          trader_id: 42,
          timeframe: 7,
          metric: 'roi',
          ts: '2026-07-16T00:00:00.000Z',
          value: 5,
        },
      ],
      replacements: [{ trader_id: 42, timeframe: 30, metric: 'pnl' }],
      traders: 1,
    })
  })
})
