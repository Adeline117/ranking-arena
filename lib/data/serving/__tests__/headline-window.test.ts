import { headlineWindowFor } from '../headline-window'

describe('headlineWindowFor', () => {
  it('maps public board timeframes to share windows', () => {
    expect(headlineWindowFor(7)).toBe('7d')
    expect(headlineWindowFor(30)).toBe('30d')
    expect(headlineWindowFor(90)).toBe('90d')
  })

  it('returns undefined for missing or unknown timeframes', () => {
    expect(headlineWindowFor(undefined)).toBeUndefined()
    expect(headlineWindowFor(null)).toBeUndefined()
    expect(headlineWindowFor(14)).toBeUndefined()
  })
})
