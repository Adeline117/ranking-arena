import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import en from '../en'
import zh from '../zh'
import ja from '../ja'
import ko from '../ko'

const dictionaries = { en, zh, ja, ko }

describe('ranking coverage trust copy', () => {
  it.each(Object.entries(dictionaries))(
    '%s does not market batch rankings as real-time or use a stale exchange count',
    (_locale, dictionary) => {
      const copy = [
        dictionary.stepViewRankingDesc,
        dictionary.viewLiveLeaderboard,
        dictionary.snapshotWantLive,
        dictionary.snapshotViewLive,
        dictionary.exchangeRankingsSubtitle,
        dictionary.helpWhatIsArenaA,
        dictionary.aboutIntroP1,
        dictionary.aboutFeature1Title,
        dictionary.aboutFeature1Desc,
        dictionary.aboutFeature2Desc,
        dictionary.aboutDataDesc,
        dictionary.aboutDataCEX,
        dictionary.aboutDataDEX,
        dictionary.aboutDataOnChain,
        dictionary.methodologySubtitle,
        dictionary.methodologyKeyPoint2,
        dictionary.methodologySec1Intro,
        dictionary.methodologySec1List,
        dictionary.methodologySec2List,
        dictionary.methodologyFaqA2,
        dictionary.methodologyFaqA4,
        dictionary.termsSec1Body,
      ].join('\n')

      expect(copy).not.toMatch(/real[- ]?time|实时|リアルタイム|실시간/i)
      expect(copy).not.toMatch(/(?:18|22|25|26|27|30|44|45)\s*\+/)
      expect(copy).not.toMatch(/30\s*(?:minutes?|mins?|分钟|分|분)/i)
      expect(dictionary.methodologyFaqA2).toContain('2')
      expect(dictionary.methodologySec1List).not.toMatch(/dYdX|Drift|Vertex|Aevo|Kwenta/)
    }
  )

  it('keeps static metadata, email, OG, and social copy free of stale coverage claims', () => {
    const files = [
      'app/layout.tsx',
      'app/(app)/(legal)/about/layout.tsx',
      'app/(app)/search/layout.tsx',
      'app/(app)/rankings/layout.tsx',
      'app/(app)/rankings/tokens/page.tsx',
      'app/(app)/rankings/tokens/[token]/page.tsx',
      'app/(app)/rankings/exchanges/page.tsx',
      'app/(app)/methodology/page.tsx',
      'app/api/email/welcome/route.ts',
      'app/api/og/exchange/route.tsx',
      'lib/services/twitter-bot.ts',
      'lib/seo/structured-data.ts',
    ]
    const copy = files.map((file) => readFileSync(join(process.cwd(), file), 'utf8')).join('\n')

    expect(copy).not.toMatch(/(?:18|22|25|26|27|30|44|45)\s*\+\s*(?:exchange|source)/i)
    expect(copy).not.toMatch(/real[- ]?time crypto trader leaderboard|live leaderboard data/i)
    expect(copy).toContain('source boards')
  })
})
