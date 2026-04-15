/**
 * Achievements Service Tests
 *
 * Tests badge unlock logic, localStorage persistence, and
 * the trackTraderView explorer_5 milestone.
 */

import {
  ACHIEVEMENTS,
  getUnlockedAchievements,
  checkAndUnlock,
  trackTraderView,
  type AchievementKey,
} from '../achievements'

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: jest.fn((key: string) => store[key] ?? null),
    setItem: jest.fn((key: string, value: string) => { store[key] = value }),
    removeItem: jest.fn((key: string) => { delete store[key] }),
    clear: jest.fn(() => { store = {} }),
    get length() { return Object.keys(store).length },
    key: jest.fn((i: number) => Object.keys(store)[i] ?? null),
  }
})()

Object.defineProperty(global, 'localStorage', { value: localStorageMock })
// Ensure `window` is defined (jsdom does this, but be safe)
if (typeof window === 'undefined') {
  (global as Record<string, unknown>).window = global
}

describe('ACHIEVEMENTS registry', () => {
  it('has all 6 defined achievement keys', () => {
    const keys: AchievementKey[] = [
      'first_watchlist',
      'first_comparison',
      'first_post',
      'explorer_5',
      'pro_subscriber',
      'social_butterfly',
    ]
    for (const key of keys) {
      expect(ACHIEVEMENTS[key]).toBeDefined()
      expect(ACHIEVEMENTS[key].key).toBe(key)
      expect(ACHIEVEMENTS[key].title).toBeTruthy()
      expect(ACHIEVEMENTS[key].titleZh).toBeTruthy()
      expect(ACHIEVEMENTS[key].icon).toBeTruthy()
    }
  })
})

describe('getUnlockedAchievements', () => {
  beforeEach(() => {
    localStorageMock.clear()
    jest.clearAllMocks()
  })

  it('returns empty object when no achievements unlocked', () => {
    const result = getUnlockedAchievements('user-1')
    expect(result).toEqual({})
  })

  it('returns persisted achievements', () => {
    const data = { first_watchlist: { unlockedAt: '2026-01-01T00:00:00Z' } }
    localStorageMock.setItem('arena_achievements_user-1', JSON.stringify(data))

    const result = getUnlockedAchievements('user-1')
    expect(result.first_watchlist).toBeDefined()
    expect(result.first_watchlist.unlockedAt).toBe('2026-01-01T00:00:00Z')
  })

  it('returns empty object on corrupt JSON', () => {
    localStorageMock.getItem.mockReturnValueOnce('not valid json {{{')
    const result = getUnlockedAchievements('user-corrupt')
    expect(result).toEqual({})
  })
})

describe('checkAndUnlock', () => {
  beforeEach(() => {
    localStorageMock.clear()
    jest.clearAllMocks()
  })

  it('newly unlocked → returns achievement info', () => {
    const result = checkAndUnlock('user-1', 'first_watchlist')
    expect(result).not.toBeNull()
    expect(result!.key).toBe('first_watchlist')
    expect(result!.title).toBe('Watchlist Pioneer')
  })

  it('already unlocked → returns null', () => {
    // Unlock first time
    checkAndUnlock('user-1', 'first_watchlist')
    // Second unlock attempt
    const result = checkAndUnlock('user-1', 'first_watchlist')
    expect(result).toBeNull()
  })

  it('empty userId → returns null', () => {
    const result = checkAndUnlock('', 'first_watchlist')
    expect(result).toBeNull()
  })

  it('persists to localStorage', () => {
    checkAndUnlock('user-2', 'first_post')

    const stored = JSON.parse(
      localStorageMock.getItem('arena_achievements_user-2')!
    )
    expect(stored.first_post).toBeDefined()
    expect(stored.first_post.unlockedAt).toBeTruthy()
  })
})

describe('trackTraderView', () => {
  beforeEach(() => {
    localStorageMock.clear()
    jest.clearAllMocks()
  })

  it('returns null for fewer than 5 unique views', () => {
    expect(trackTraderView('user-1', 'trader-A')).toBeNull()
    expect(trackTraderView('user-1', 'trader-B')).toBeNull()
    expect(trackTraderView('user-1', 'trader-C')).toBeNull()
    expect(trackTraderView('user-1', 'trader-D')).toBeNull()
  })

  it('unlocks explorer_5 on 5th unique view', () => {
    trackTraderView('user-1', 'trader-A')
    trackTraderView('user-1', 'trader-B')
    trackTraderView('user-1', 'trader-C')
    trackTraderView('user-1', 'trader-D')
    const result = trackTraderView('user-1', 'trader-E')

    expect(result).not.toBeNull()
    expect(result!.key).toBe('explorer_5')
  })

  it('duplicate views do not count toward the 5', () => {
    trackTraderView('user-1', 'trader-A')
    trackTraderView('user-1', 'trader-A') // duplicate
    trackTraderView('user-1', 'trader-B')
    trackTraderView('user-1', 'trader-B') // duplicate
    trackTraderView('user-1', 'trader-C')
    trackTraderView('user-1', 'trader-D')
    // Still only 4 unique, should return null
    expect(trackTraderView('user-1', 'trader-A')).toBeNull()
  })

  it('returns null for empty userId', () => {
    expect(trackTraderView('', 'trader-A')).toBeNull()
  })

  it('already unlocked explorer_5 → returns null on subsequent views', () => {
    // Unlock explorer_5
    trackTraderView('user-1', 't1')
    trackTraderView('user-1', 't2')
    trackTraderView('user-1', 't3')
    trackTraderView('user-1', 't4')
    trackTraderView('user-1', 't5')

    // 6th view should not re-trigger
    const result = trackTraderView('user-1', 't6')
    expect(result).toBeNull()
  })
})
