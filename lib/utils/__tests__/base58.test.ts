import { base58DecodedByteLength, hasBase58DecodedByteLength, isBase58String } from '../base58'

describe('Base58 byte-length validation', () => {
  it('counts significant and leading-zero bytes exactly', () => {
    expect(base58DecodedByteLength('')).toBe(0)
    expect(base58DecodedByteLength('1')).toBe(1)
    expect(base58DecodedByteLength('1112')).toBe(4)
    expect(base58DecodedByteLength('A'.repeat(32))).toBe(24)
    expect(base58DecodedByteLength('A'.repeat(43))).toBe(32)
    expect(base58DecodedByteLength('A'.repeat(44))).toBe(32)
    expect(base58DecodedByteLength('A'.repeat(88))).toBe(65)
  })

  it('rejects invalid alphabet characters and unbounded identity input', () => {
    expect(isBase58String('123ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz')).toBe(true)
    expect(isBase58String('')).toBe(false)
    expect(isBase58String('0OIl!')).toBe(false)
    expect(base58DecodedByteLength('0OIl!')).toBeNull()
    expect(hasBase58DecodedByteLength('A'.repeat(1_000), 32)).toBe(false)
  })

  it('distinguishes public keys from malformed lookalikes by decoded bytes', () => {
    expect(hasBase58DecodedByteLength('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 32)).toBe(true)
    expect(hasBase58DecodedByteLength('A'.repeat(44), 32)).toBe(true)
    expect(hasBase58DecodedByteLength('A'.repeat(32), 32)).toBe(false)
    expect(hasBase58DecodedByteLength('A'.repeat(88), 64)).toBe(false)
  })
})
