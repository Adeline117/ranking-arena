/**
 * @jest-environment node
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) => ({
      status: init.status ?? 200,
      headers: init.headers ?? {},
      json: async () => body,
    }),
  },
}))

import { dynamic, GET, revalidate } from '../route'

// Shared envelope contract: lib/rankings/daily-publication-contract.ts.
describe('trader indicators publication quarantine', () => {
  it('returns the fixed unavailable daily-publication envelope', async () => {
    const response = GET()

    expect(dynamic).toBe('force-dynamic')
    expect(revalidate).toBe(0)
    expect(response.status).toBe(200)
    expect(response.headers).toMatchObject({
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
    })
    await expect(response.json()).resolves.toMatchObject({
      contract: 'arena.daily-history-publication@1',
      available: false,
      code: 'DAILY_INDICATORS_NOT_PUBLISHED',
      publication: null,
      timestamps: [],
      rsi: [],
    })
  })

  it('does not retain a raw daily-snapshot reader, calculation, or cache replay path', () => {
    const route = readFileSync(
      join(process.cwd(), 'app/api/traders/[handle]/indicators/route.ts'),
      'utf8'
    )

    expect(route).not.toContain(".from('trader_daily_snapshots')")
    expect(route).not.toContain('computeIndicators')
    expect(route).not.toContain('getServerCache')
    expect(route).not.toContain('setServerCache')
    expect(route).not.toContain('getSupabaseAdmin')
  })
})
