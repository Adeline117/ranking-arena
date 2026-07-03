import { calculateBadges, getPrimaryBadge, hasBadge } from '../calculate'

describe('calculateBadges — 仅 Top 10', () => {
  it('rank ≤ 10 → 获得 top10 徽章 + metadata.rank', () => {
    const badges = calculateBadges({ handle: 'whale', rank: 3 })
    expect(badges).toHaveLength(1)
    expect(badges[0].id).toBe('top10')
    expect(badges[0].metadata).toEqual({ rank: 3 })
    expect(badges[0].earnedAt).toBeTruthy()
  })

  it('rank = 10 边界 → 获得', () => {
    expect(calculateBadges({ handle: 'x', rank: 10 })).toHaveLength(1)
  })

  it('rank = 11 → 无徽章', () => {
    expect(calculateBadges({ handle: 'x', rank: 11 })).toEqual([])
  })

  it('rank null/缺失 → 无徽章', () => {
    expect(calculateBadges({ handle: 'x', rank: null })).toEqual([])
    expect(calculateBadges({ handle: 'x' })).toEqual([])
  })
})

describe('getPrimaryBadge', () => {
  it('取第一个徽章', () => {
    const badges = calculateBadges({ handle: 'x', rank: 1 })
    expect(getPrimaryBadge(badges)?.id).toBe('top10')
  })

  it('空 → null', () => {
    expect(getPrimaryBadge([])).toBeNull()
  })
})

describe('hasBadge', () => {
  it('rank≤10 → hasBadge top10 true', () => {
    expect(hasBadge({ handle: 'x', rank: 5 }, 'top10')).toBe(true)
  })

  it('rank>10 → false', () => {
    expect(hasBadge({ handle: 'x', rank: 50 }, 'top10')).toBe(false)
  })
})
