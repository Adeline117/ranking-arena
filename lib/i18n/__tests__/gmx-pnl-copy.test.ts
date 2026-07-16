import enCore from '../en-core'
import zhCore from '../zh-core'
import en from '../en'
import zh from '../zh'
import ja from '../ja'
import ko from '../ko'

const KEYS = [
  'gmxRealizedNetPnlLabel',
  'gmxRealizedNetPnlSummary',
  'gmxRealizedNetPnlTooltip',
  'gmxCompletedWindowEnded',
] as const

describe('GMX PnL contract copy', () => {
  it.each([
    ['English', en],
    ['Chinese', zh],
    ['Japanese', ja],
    ['Korean', ko],
  ])('has complete non-empty %s copy', (_language, dictionary) => {
    for (const key of KEYS) {
      expect(dictionary[key].trim()).not.toBe('')
    }
  })

  it('keeps hydration-safe core copy identical to the full dictionaries', () => {
    for (const key of KEYS) {
      expect(enCore[key]).toBe(en[key])
      expect(zhCore[key]).toBe(zh[key])
    }
  })
})
