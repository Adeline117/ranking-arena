import type { ReactElement } from 'react'

const mockGetWeeklyLeaders = jest.fn()

jest.mock('@/lib/supabase/read-replica', () => ({
  getReadReplica: () => ({ rpc: jest.fn() }),
}))

jest.mock('@/lib/data/serving/weekly-leaders', () => ({
  getWeeklyLeaders: (...args: unknown[]) => mockGetWeeklyLeaders(...args),
}))

jest.mock('../WeeklyArenaClient', () => ({
  __esModule: true,
  default: () => null,
}))

import WeeklyArenaPage from '../page'

type WeeklyPageProps = {
  data: {
    nonLegacyCount: number
    rows: unknown[]
    bitmart: unknown
  }
}

describe('weekly rankings SSR failure state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('propagates an upstream failure to the retryable route error boundary', async () => {
    mockGetWeeklyLeaders.mockRejectedValue(new Error('database unavailable'))

    await expect(WeeklyArenaPage()).rejects.toThrow('database unavailable')
  })

  it('renders a genuine successful empty board as empty data', async () => {
    mockGetWeeklyLeaders.mockResolvedValue({
      nonLegacyCount: 5,
      rows: [],
      bitmart: null,
    })

    const element = (await WeeklyArenaPage()) as ReactElement<WeeklyPageProps>
    expect(element.props.data).toEqual({
      nonLegacyCount: 5,
      rows: [],
      bitmart: null,
    })
  })
})
