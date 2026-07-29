jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers: Headers

    constructor(
      private readonly body: unknown,
      init: { status?: number; headers?: Record<string, string> } = {}
    ) {
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this.body
    }

    static json(
      body: unknown,
      init?: { status?: number; headers?: Record<string, string> }
    ) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

import { GET } from '../route'

describe('GET /api/platforms', () => {
  it('labels configured data sources as boards and exposes publication eligibility', async () => {
    const response = await GET()
    const body = (await response.json()) as {
      platforms: Array<{ id: string; publicRankingInputAllowed: boolean }>
      total: number
      countUnit: string
      scope: string
    }

    expect(body.countUnit).toBe('source_board')
    expect(body.scope).toBe('configured_source_boards_with_historical_data')
    expect(body.total).toBe(body.platforms.length)
    expect(new Set(body.platforms.map(({ id }) => id)).size).toBe(body.total)
    expect(body.platforms).toContainEqual(
      expect.objectContaining({ id: 'binance_futures', publicRankingInputAllowed: true })
    )
    expect(body.platforms).toContainEqual(
      expect.objectContaining({
        id: 'bitget_bots_futures',
        publicRankingInputAllowed: false,
      })
    )
  })
})
