import { getAvatarColor, getAvatarGradient, getAvatarInitial } from '../avatar'

describe('getAvatarColor', () => {
  it('returns HSL color string', () => {
    const color = getAvatarColor('user-123')
    expect(color).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/)
  })

  it('is deterministic', () => {
    expect(getAvatarColor('abc')).toBe(getAvatarColor('abc'))
  })

  it('different IDs give different colors', () => {
    expect(getAvatarColor('user-a')).not.toBe(getAvatarColor('user-b'))
  })
})

describe('getAvatarGradient', () => {
  it('returns gradient string', () => {
    const gradient = getAvatarGradient('user-123')
    expect(gradient).toContain('gradient')
  })

  it('is deterministic', () => {
    expect(getAvatarGradient('xyz')).toBe(getAvatarGradient('xyz'))
  })
})

describe('getAvatarInitial', () => {
  it('returns first character uppercased', () => {
    expect(getAvatarInitial('alice')).toBe('A')
  })

  it('handles null/undefined', () => {
    expect(getAvatarInitial(null)).toBeTruthy()
    expect(getAvatarInitial(undefined)).toBeTruthy()
  })

  it('handles empty string', () => {
    const result = getAvatarInitial('')
    expect(typeof result).toBe('string')
  })
})
