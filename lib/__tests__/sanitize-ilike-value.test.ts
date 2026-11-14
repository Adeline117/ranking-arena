import { escapeIlikeValue, escapeLikePattern } from '../sanitize'

describe('escapeIlikeValue', () => {
  it('keeps the characters that are only special inside an .or() string', () => {
    expect(escapeIlikeValue('john.doe')).toBe('john.doe')
    expect(escapeIlikeValue('first.last@example.com')).toBe('first.last@example.com')
    // The .or()-safe variant strips them, which is why it must not be used here.
    expect(escapeLikePattern('john.doe')).toBe('johndoe')
  })

  it('neutralizes every wildcard a direct ilike filter understands', () => {
    expect(escapeIlikeValue('100%_real')).toBe('100\\%\\_real')
    expect(escapeIlikeValue('a\\b')).toBe('a\\\\b')
    // PostgREST rewrites * to % and offers no escape for it.
    expect(escapeIlikeValue('*@example.com')).toBe('@example.com')
  })

  it('caps the length', () => {
    expect(escapeIlikeValue('x'.repeat(500))).toHaveLength(200)
    expect(escapeIlikeValue('x'.repeat(500), 10)).toHaveLength(10)
  })
})
