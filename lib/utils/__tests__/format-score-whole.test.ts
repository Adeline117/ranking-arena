import { formatScoreWhole, NULL_DISPLAY } from '../format'

describe('formatScoreWhole', () => {
  it('rounds ordinary scores to a whole number', () => {
    expect(formatScoreWhole(87.4)).toBe('87')
    expect(formatScoreWhole(0.5)).toBe('1')
    expect(formatScoreWhole(99.5)).toBe('100')
  })

  it('shows a small positive score as "<1", not as an unscored-looking 0', () => {
    expect(formatScoreWhole(0.02)).toBe('<1')
    expect(formatScoreWhole(0.49)).toBe('<1')
  })

  it('keeps a real zero and an unknown apart', () => {
    expect(formatScoreWhole(0)).toBe('0')
    expect(formatScoreWhole(null)).toBe(NULL_DISPLAY)
    expect(formatScoreWhole(undefined)).toBe(NULL_DISPLAY)
    expect(formatScoreWhole(Number.NaN)).toBe(NULL_DISPLAY)
    expect(formatScoreWhole(null, '--')).toBe('--')
  })
})
