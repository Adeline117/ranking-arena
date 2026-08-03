import type { SourceRow } from '../../core/types'
import type { PositionSnapshotEvidence } from '../../core/position-snapshot'

const query = jest.fn()
const release = jest.fn()
const connect = jest.fn(async () => ({ query, release }))

jest.mock('../../db', () => ({
  ingestClientConnect: (...args: unknown[]) => connect(...args),
}))

import { assertPositionSnapshotEvidence } from '../../core/position-snapshot'
import { publishPositions } from '../publish'

const source = {
  id: 1,
  slug: 'test_futures',
  adapter_slug: 'test',
  currency: 'USDT',
  meta: {},
} as SourceRow

describe('position replacement publication authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    query.mockResolvedValue({ rowCount: 0, rows: [] })
  })

  it('rejects a forged evidence object before opening a database connection', async () => {
    await expect(
      publishPositions(source, 42, [], '2026-08-03T12:00:00.000Z', {
        context: 'test_futures/trader-42',
        pageCount: 1,
      } as PositionSnapshotEvidence)
    ).rejects.toThrow('lacks validated source evidence')

    expect(connect).not.toHaveBeenCalled()
  })

  it('clears a confirmed empty snapshot only inside the evidenced transaction', async () => {
    const fetchedAt = '2026-08-03T12:00:00.000Z'
    const evidence = assertPositionSnapshotEvidence(
      {
        fetchedAt,
        pages: [
          {
            pageIndex: 1,
            payload: { code: 200, data: [] },
            url: 'https://exchange.test/positions',
            fetchedAt,
          },
        ],
      },
      'test_futures/trader-42'
    )

    await publishPositions(source, 42, [], fetchedAt, evidence)

    expect(query.mock.calls.map(([sql]) => String(sql).trim())).toEqual([
      'BEGIN',
      'DELETE FROM arena.positions_current WHERE trader_id = $1',
      'COMMIT',
    ])
    expect(query).toHaveBeenNthCalledWith(
      2,
      'DELETE FROM arena.positions_current WHERE trader_id = $1',
      [42]
    )
    expect(release).toHaveBeenCalledTimes(1)
  })
})
