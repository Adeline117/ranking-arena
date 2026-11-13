/** @jest-environment node */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mockAlert = jest.fn()
const mockRpc = jest.fn()

jest.mock('@/lib/api/with-cron', () => ({
  withCron: (_name: string, handler: Function) => async (request: unknown) => {
    try {
      return Response.json({
        ok: true,
        ...(await handler(request, { supabase: { rpc: mockRpc } })),
      })
    } catch (err) {
      return Response.json({ ok: false, error: String(err) }, { status: 500 })
    }
  },
}))
jest.mock('@/lib/alerts/send-alert', () => ({
  sendRateLimitedAlert: (...args: unknown[]) => mockAlert(...args),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const source = readFileSync(
  join(process.cwd(), 'app/api/cron/data-reconciliation/route.ts'),
  'utf8'
)
const run = () => GET(new NextRequest('http://localhost/api/cron/data-reconciliation'))

describe('data-reconciliation', () => {
  beforeEach(() => jest.clearAllMocks())

  it('alerts on gaps without handing them to a consumer-less retry queue', async () => {
    mockAlert.mockResolvedValue(undefined)
    mockRpc.mockResolvedValueOnce({
      data: [{ source: 'bybit', gap_count: 12, avg_gap_hours: 60, max_gap_hours: 90 }],
      error: null,
    })
    const body = await (await run()).json()
    expect(body.count).toBe(12)
    expect(mockAlert).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(source).not.toContain('PipelineState.set')
    expect(source).not.toContain('@/lib/services/pipeline-state')
  })

  it('fails the run when the gap summary RPC errors', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
    expect((await run()).status).toBe(500)
  })
})
