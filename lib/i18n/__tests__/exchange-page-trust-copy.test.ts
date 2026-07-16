import { PRODUCT_FACTS } from '@/lib/config/product-facts'

import en from '../en'
import ja from '../ja'
import ko from '../ko'
import zh from '../zh'

describe('exchange page trust copy', () => {
  const dictionaries = { en, zh, ja, ko }
  const leaderboardHours = String(PRODUCT_FACTS.leaderboardRefreshHours)
  const sourceMinHours = String(PRODUCT_FACTS.sourceRefreshHours.min)
  const sourceMaxHours = String(PRODUCT_FACTS.sourceRefreshHours.max)

  it.each(Object.entries(dictionaries))(
    '%s preserves the dynamic context and the real leaderboard cadence',
    (_locale, dictionary) => {
      expect(dictionary.exchangePageSubtitle).toContain('{name}')
      expect(dictionary.exchangePageSubtitle).toContain('{type}')
      expect(dictionary.exchangePageSubtitle).toContain('{count}')
      expect(dictionary.exchangePageSubtitle).toContain(leaderboardHours)
    }
  )

  it.each(Object.entries(dictionaries))(
    '%s distinguishes source refreshes from leaderboard recomputes',
    (_locale, dictionary) => {
      expect(dictionary.exchangePageAboutBody).toContain('{name}')
      expect(dictionary.exchangePageAboutBody).toContain('{type}')
      expect(dictionary.exchangePageAboutBody).toContain('{count}')
      expect(dictionary.exchangePageAboutBody).toContain(sourceMinHours)
      expect(dictionary.exchangePageAboutBody).toContain(sourceMaxHours)
      expect(dictionary.exchangePageAboutBody).toContain(leaderboardHours)
    }
  )

  it.each(Object.entries(dictionaries))(
    '%s does not claim a 30-minute or live feed',
    (_locale, dictionary) => {
      const copy = `${dictionary.exchangePageSubtitle} ${dictionary.exchangePageAboutBody}`

      expect(copy).not.toMatch(/30\s*(?:minutes?|mins?|分钟|分|분)/i)
      expect(copy).not.toMatch(/real[- ]?time|实时|ライブ\s*API|실시간/i)
    }
  )
})
