import type { ReactElement } from 'react'

const mockGetWeeklyLeaders = jest.fn()

jest.mock('next/cache', () => ({
  unstable_cache: (loader: () => unknown) => loader,
}))

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

import WeeklyArenaPage, { dynamic, WEEKLY_SSR_TIMEOUT_MS } from '../page'

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

  afterEach(() => {
    jest.useRealTimers()
  })

  it('propagates an upstream failure to the retryable route error boundary', async () => {
    mockGetWeeklyLeaders.mockRejectedValue(new Error('database unavailable'))

    await expect(WeeklyArenaPage()).rejects.toThrow('database unavailable')
  })

  it('bounds a never-settling upstream read so the route skeleton cannot remain forever', async () => {
    jest.useFakeTimers()
    mockGetWeeklyLeaders.mockReturnValue(new Promise(() => undefined))

    const rejection = expect(WeeklyArenaPage()).rejects.toThrow('Weekly rankings SSR timed out')
    await jest.advanceTimersByTimeAsync(WEEKLY_SSR_TIMEOUT_MS)

    await rejection
  })

  it('is request-rendered so a transient RPC failure cannot fail the production build', () => {
    expect(dynamic).toBe('force-dynamic')
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
