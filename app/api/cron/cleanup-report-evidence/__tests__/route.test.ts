jest.mock('@/lib/api/with-cron', () => ({
  withCron: jest.fn(
    (_name: string, handler: Function) => (request: unknown) =>
      handler(request, { supabase: mockSupabase, plog: {} })
  ),
}))

const mockRpc = jest.fn()
const mockRemove = jest.fn()
const mockSupabase = {
  rpc: mockRpc,
  storage: { from: jest.fn(() => ({ remove: mockRemove })) },
}

import { GET } from '../route'
import { withCron } from '@/lib/api/with-cron'

const mockWithCron = withCron as jest.Mock

const ITEM = {
  evidence_ref: 'reports/11111111-1111-4111-8111-111111111111/0123456789abcdef.png',
  reporter_id: '11111111-1111-4111-8111-111111111111',
  object_name: '11111111-1111-4111-8111-111111111111/0123456789abcdef.png',
  lease_token: '22222222-2222-4222-8222-222222222222',
  lease_expires_at: '2026-07-16T12:02:00.000Z',
}

describe('cleanup report evidence cron worker', () => {
  beforeEach(() => {
    mockRpc.mockReset()
    mockRemove.mockReset()
    mockSupabase.storage.from.mockClear()
    mockRemove.mockResolvedValue({ error: null })
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'lease_stale_report_evidence_cleanup') {
        return { data: [ITEM], error: null }
      }
      return { data: true, error: null }
    })
  })

  it('uses the standard cron wrapper and leases a bounded batch', () => {
    expect(mockWithCron).toHaveBeenCalledWith('cleanup-report-evidence', expect.any(Function), {
      safetyTimeoutMs: 55_000,
    })
  })

  it('is scheduled and keeps every report-evidence response out of shared caches', () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
      crons: Array<{ path: string; schedule: string }>
      headers: Array<{
        source: string
        headers: Array<{ key: string; value: string }>
      }>
    }
    expect(config.crons).toContainEqual({
      path: '/api/cron/cleanup-report-evidence',
      schedule: '*/15 * * * *',
    })
    for (const source of ['/api/report', '/api/reports', '/api/upload']) {
      expect(config.headers).toContainEqual({
        source,
        headers: [{ key: 'Cache-Control', value: 'private, no-store' }],
      })
    }
  })

  it('removes through Storage API and acknowledges the exact lease', async () => {
    const result = await GET({} as never)
    expect(result).toEqual({ count: 1, leased: 1, failed: 0 })
    expect(mockRemove).toHaveBeenCalledWith([ITEM.object_name])
    expect(mockRpc).toHaveBeenCalledWith('ack_report_evidence_cleanup', {
      p_reporter_id: ITEM.reporter_id,
      p_evidence_ref: ITEM.evidence_ref,
      p_lease_token: ITEM.lease_token,
    })
  })

  it('releases a lease after transient Storage failure for retry', async () => {
    mockRemove.mockResolvedValue({ error: { message: 'temporary outage' } })
    const result = await GET({} as never)
    expect(result).toEqual({ count: 0, leased: 1, failed: 1 })
    expect(mockRpc).toHaveBeenCalledWith('release_report_evidence_cleanup', {
      p_reporter_id: ITEM.reporter_id,
      p_evidence_ref: ITEM.evidence_ref,
      p_lease_token: ITEM.lease_token,
    })
    expect(mockRpc).not.toHaveBeenCalledWith('ack_report_evidence_cleanup', expect.anything())
  })

  it('leaves a failed acknowledgement leased for bounded retry', async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'lease_stale_report_evidence_cleanup') {
        return { data: [ITEM], error: null }
      }
      if (name === 'ack_report_evidence_cleanup') {
        return { data: false, error: { code: 'XX000' } }
      }
      return { data: true, error: null }
    })
    const result = await GET({} as never)
    expect(result).toEqual({ count: 0, leased: 1, failed: 1 })
    expect(mockRpc).not.toHaveBeenCalledWith('release_report_evidence_cleanup', expect.anything())
  })

  it('fails closed on malformed leased identities before Storage access', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ ...ITEM, object_name: '../foreign.png' }],
      error: null,
    })
    const result = await GET({} as never)
    expect(result).toEqual({ count: 0, leased: 1, failed: 1 })
    expect(mockRemove).not.toHaveBeenCalled()
  })
})
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
