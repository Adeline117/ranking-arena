import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const service = readFileSync(join(process.cwd(), 'lib/services/telegram-bot.ts'), 'utf8')

describe('Telegram ranking authority', () => {
  it('restricts every command to active, non-quarantined ranking sources', () => {
    expect(service).toContain('filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)')
    expect(service).toContain('isPublicRankingSourceAllowed(exchangeArg)')
    expect(service.match(/isPublicRankingSourceAllowed\(trader\.platform\)/g)).toHaveLength(3)
  })

  it('binds /top rows to one sealed publication generation', () => {
    expect(service).toContain("{ season: '90D', sources: proofSources }")
    expect(service).toContain('scoreCohortId: publication.scoreCohortId')
    expect(service).toContain('allowedSources: proofSources')
    expect(service).toContain('Telegram leaderboard crossed the public source boundary')
  })

  it('derives /stats only from sealed publication proofs', () => {
    expect(service).not.toContain(".from('leaderboard_ranks')")
    expect(service).toContain("{ season: '90D', sources: TELEGRAM_RANKING_SOURCES }")
    expect(service).toContain('proof.published_rank_count')
    expect(service).toContain('.map((proof) => proof.source)')
  })

  it('links Telegram results to canonical public routes', () => {
    expect(service).toContain(
      '/trader/${encodeURIComponent(t.handle || t.traderKey)}?platform=${encodeURIComponent(t.platform)}'
    )
    expect(service).toContain('?ex=${encodeURIComponent(platform)}')
    expect(service).not.toContain('/rankings${platform')
  })
})
