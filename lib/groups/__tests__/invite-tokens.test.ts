import { createHmac } from 'node:crypto'
import { generateInviteToken, hashInviteToken, verifyInviteToken } from '../invite-tokens'

const GROUP_ID = '10000000-0000-4000-8000-000000000001'
const SECRET = 'test-invite-secret-with-at-least-thirty-two-characters'

describe('group invite tokens', () => {
  beforeAll(() => {
    process.env.INVITE_SECRET = SECRET
  })

  it('generates nonce-bearing tokens that are unique in the same millisecond', () => {
    const expiresAt = Date.now() + 60_000
    const first = generateInviteToken(GROUP_ID, expiresAt)
    const second = generateInviteToken(GROUP_ID, expiresAt)

    expect(first).not.toBe(second)
    expect(Buffer.from(first, 'base64url').toString('utf8').split(':')).toHaveLength(4)
    expect(verifyInviteToken(first, expiresAt - 1)).toEqual({
      valid: true,
      groupId: GROUP_ID,
      expiresAt,
    })
  })

  it('verifies unexpired legacy tokens during the compatibility window', () => {
    const expiresAt = Date.now() + 60_000
    const payload = `${GROUP_ID}:${expiresAt}`
    const signature = createHmac('sha256', SECRET).update(payload).digest('hex')
    const legacyToken = Buffer.from(`${payload}:${signature}`).toString('base64url')

    expect(verifyInviteToken(legacyToken, expiresAt - 1)).toEqual({
      valid: true,
      groupId: GROUP_ID,
      expiresAt,
    })
  })

  it('rejects expired, tampered and malformed tokens without throwing', () => {
    const expiresAt = Date.now() + 60_000
    const token = generateInviteToken(GROUP_ID, expiresAt)
    const decoded = Buffer.from(token, 'base64url').toString('utf8')
    const replacement = decoded.endsWith('0') ? '1' : '0'
    const tampered = Buffer.from(`${decoded.slice(0, -1)}${replacement}`).toString('base64url')

    expect(verifyInviteToken(token, expiresAt)).toEqual({ valid: false, groupId: GROUP_ID })
    expect(verifyInviteToken(tampered, expiresAt - 1).valid).toBe(false)
    expect(verifyInviteToken('***')).toEqual({ valid: false, groupId: '' })
    expect(verifyInviteToken('a'.repeat(513))).toEqual({ valid: false, groupId: '' })
  })

  it('validates generation inputs and hashes only the opaque token', () => {
    expect(() => generateInviteToken('not-a-uuid', Date.now() + 60_000)).toThrow('valid group ID')
    expect(() => generateInviteToken(GROUP_ID, Date.now() - 1)).toThrow('future millisecond')

    const token = generateInviteToken(GROUP_ID, Date.now() + 60_000)
    expect(hashInviteToken(token)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashInviteToken(token)).not.toContain(token)
  })
})
