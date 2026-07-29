import { parseProfileUpdateAcknowledgement } from '../update-acknowledgement'

describe('generated profile update acknowledgement', () => {
  it('accepts a matching update and a concurrency-protected no-op', () => {
    expect(parseProfileUpdateAcknowledgement([{ trader_key: 'alice' }], 'alice')).toBe(1)
    expect(parseProfileUpdateAcknowledgement([], 'alice')).toBe(0)
  })

  it.each([
    null,
    {},
    [null],
    [{ trader_key: null }],
    [{ trader_key: 'bob' }],
    [{ trader_key: 'alice', extra: true }],
    [{ trader_key: 'alice' }, { trader_key: 'alice' }],
  ])('rejects malformed or mismatched acknowledgement %#', (value) => {
    expect(() => parseProfileUpdateAcknowledgement(value, 'alice')).toThrow(
      'Profile conditional update returned an invalid acknowledgement'
    )
  })
})
