/**
 * Gate board capture warms the session on the API origin.
 *
 * Replay is in-page same-origin fetch against www.gate.com. Live probe
 * 2026-11-15: the gate_cfd seed board URL (w.gate.com) no longer resolves,
 * so warming there failed before any board request; warming on
 * www.gate.com/zh/copytrading/tradfi captured the TradFi board (total 425,
 * last page 36 held the expected 5 rows).
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { gateAdapter } from '..'
import type { SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { isPartitionedNumericLeaderboardCapture } from '../../../fetch/capture'

function cfdBoard(): Record<string, unknown> {
  const payload = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'leaderboard-cfd-p1.json'), 'utf8')
  ) as { data: Record<string, unknown> & { lists: unknown[] } }
  payload.data.totalcount = payload.data.lists.length
  payload.data.pagecount = 1
  return payload
}

function session(visited: string[]): FetchSession {
  let origin: string | null = null
  const page = {
    goto: async (url: string) => {
      visited.push(url)
      if (new URL(url).hostname !== 'www.gate.com') {
        throw new Error(`page.goto: net::ERR_NAME_NOT_RESOLVED at ${url}`)
      }
      origin = new URL(url).origin
    },
    waitForLoadState: async () => undefined,
  }
  return {
    sourceSlug: 'gate_cfd',
    page: async () => page,
    pageFetch: async (request: ReplayRequestTemplate) => {
      if (origin !== new URL(request.url).origin) throw new TypeError('Failed to fetch')
      return { status: 200, json: cfdBoard() }
    },
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as FetchSession
}

function source(leaderboardUrl: string | null): SourceRow {
  return {
    id: 41,
    slug: 'gate_cfd',
    adapter_slug: 'gate',
    leaderboard_url: leaderboardUrl,
    currency: 'USDx',
    page_size: 12,
    pagination_kind: 'numeric',
    meta: { boardKey: 'cfd' },
  } as unknown as SourceRow
}

describe('gate captureLeaderboard warm origin', () => {
  it('captures the CFD board when the configured board host is off the API origin', async () => {
    const visited: string[] = []
    const capture = await gateAdapter.captureLeaderboard!(
      session(visited),
      source('https://w.gate.com/zh/copytrading/tradfi'),
      30
    )
    if (isPartitionedNumericLeaderboardCapture(capture)) throw new Error('identity capture')
    expect(visited).toEqual(['https://www.gate.com/zh/copytrading/tradfi'])
    expect(capture.terminationReason).toBe('reported_population_reached')
    expect(capture.parsePages).toHaveLength(1)
  })

  it('keeps a configured board URL that is already on the API origin', async () => {
    const visited: string[] = []
    await gateAdapter.captureLeaderboard!(
      session(visited),
      source('https://www.gate.com/en/copytrading/tradfi'),
      30
    )
    expect(visited).toEqual(['https://www.gate.com/en/copytrading/tradfi'])
  })
})
