import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const route = readFileSync(join(process.cwd(), 'app/api/export/rankings/route.ts'), 'utf8')

describe('ranking export generation contract', () => {
  it('validates the requested season and delegates every row read to the sealed helper', () => {
    expect(route).toContain("url.searchParams.get('timeRange')")
    expect(route).toContain("['7D', '30D', '90D'].includes(timeRange)")
    expect(route).toContain('readRankingExportRows(getSupabaseAdmin(), {')
    expect(route).toContain('season: timeRange as LeaderboardPublicationSeason')
    expect(route).not.toContain(".from('leaderboard_ranks')")
  })

  it('rejects non-canonical exchanges before building the export', () => {
    expect(route).toContain('parsePublicActiveRankingSource(requestedExchange)')
    expect(route).toContain(
      "return NextResponse.json({ error: 'Invalid exchange' }, { status: 400 })"
    )
  })
})
