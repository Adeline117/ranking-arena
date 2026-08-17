/**
 * @jest-environment node
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/cron/compute-leaderboard/route.ts'), 'utf8')

describe('compute leaderboard V1 execution containment', () => {
  it('uses the shared authentication-first execution gate as its only command path', () => {
    expect(route).toContain("from '@/lib/cron/v1-execution-publication'")
    expect(route).toContain('v1CronExecutionGate(request) ?? v1CronExecutionUnavailableResponse()')
    expect(route).toContain('export const maxDuration = 10')
  })

  it('cannot acquire a lease or reach a publication side effect from the route', () => {
    expect(route).not.toMatch(
      /\b(?:getSupabaseAdmin|getReadReplica|acquireLeaderboardRunLease|PipelineLogger|tieredGetRequired|tieredSetRequired|upsertLeaderboard|zeroOutExcluded|revalidateRankingPages)\b/
    )
    expect(route).not.toContain('request.nextUrl')
    expect(route).not.toContain("from './")
  })
})
