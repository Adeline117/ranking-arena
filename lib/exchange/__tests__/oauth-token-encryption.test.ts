import crypto from 'crypto'
import { decryptOAuthToken, encryptOAuthToken } from '../oauth-token-encryption'

const KEY = '01'.repeat(32)
const CONTEXT = {
  viewerId: '10000000-0000-4000-8000-000000000001',
  exchange: 'binance',
  purpose: 'refresh' as const,
}

function legacyEncrypt(plaintext: string): string {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(KEY, 'hex'), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `${iv.toString('hex')}:${ciphertext.toString('hex')}`
}

describe('OAuth token encryption', () => {
  it('round-trips authenticated v2 ciphertext with randomized IVs', () => {
    const first = encryptOAuthToken('refresh-token-secret', KEY, CONTEXT)
    const second = encryptOAuthToken('refresh-token-secret', KEY, CONTEXT)

    expect(first).toMatch(/^v2:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/)
    expect(second).not.toBe(first)
    expect(decryptOAuthToken(first, KEY, CONTEXT)).toBe('refresh-token-secret')
  })

  it('reads the legacy CBC shape without ever writing it', () => {
    const legacy = legacyEncrypt('legacy-refresh-token')

    expect(decryptOAuthToken(legacy, KEY, CONTEXT)).toBe('legacy-refresh-token')
    expect(encryptOAuthToken(decryptOAuthToken(legacy, KEY, CONTEXT), KEY, CONTEXT)).toMatch(/^v2:/)
  })

  it.each(['tag', 'ciphertext'] as const)('rejects v2 %s tampering', (part) => {
    const encrypted = encryptOAuthToken('refresh-token-secret', KEY, CONTEXT).split(':')
    const index = part === 'tag' ? 2 : 3
    encrypted[index] =
      `${encrypted[index].slice(0, -1)}${encrypted[index].endsWith('0') ? '1' : '0'}`

    expect(() => decryptOAuthToken(encrypted.join(':'), KEY, CONTEXT)).toThrow(
      /authentication failed/
    )
  })

  it.each([
    '',
    'not-a-ciphertext',
    'v2:00:00:00',
    '00:00',
    'v3:00112233445566778899aabb:00112233445566778899aabbccddeeff:00',
  ])('rejects malformed ciphertext %#', (ciphertext) => {
    expect(() => decryptOAuthToken(ciphertext, KEY, CONTEXT)).toThrow()
  })

  it('binds v2 ciphertext to viewer, exchange, and token purpose', () => {
    const encrypted = encryptOAuthToken('refresh-token-secret', KEY, CONTEXT)

    expect(() => decryptOAuthToken(encrypted, KEY, { ...CONTEXT, viewerId: 'viewer-b' })).toThrow(
      /authentication failed/
    )
    expect(() => decryptOAuthToken(encrypted, KEY, { ...CONTEXT, exchange: 'bybit' })).toThrow(
      /authentication failed/
    )
    expect(() => decryptOAuthToken(encrypted, KEY, { ...CONTEXT, purpose: 'access' })).toThrow(
      /authentication failed/
    )
  })

  it('rejects invalid or wrong encryption keys', () => {
    const encrypted = encryptOAuthToken('refresh-token-secret', KEY, CONTEXT)

    expect(() => encryptOAuthToken('secret', 'short', CONTEXT)).toThrow(/key is invalid/)
    expect(() => decryptOAuthToken(encrypted, '02'.repeat(32), CONTEXT)).toThrow(
      /authentication failed/
    )
  })
})
