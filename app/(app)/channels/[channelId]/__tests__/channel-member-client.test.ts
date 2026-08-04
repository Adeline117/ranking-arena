import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  readChannelMemberDeleteAcknowledgement,
  readChannelMemberRoleAcknowledgement,
} from '../channel-member-client'

describe('channel member client acknowledgements', () => {
  it.each([
    [{ ok: true, action: 'removed' }, 'removed'],
    [{ action: 'left', ok: true }, 'left'],
  ] as const)('accepts an exact delete acknowledgement %#', (value, action) => {
    expect(readChannelMemberDeleteAcknowledgement(value, action)).toBe(true)
  })

  it.each([
    [null, 'removed'],
    [{}, 'removed'],
    [{ ok: false, action: 'removed' }, 'removed'],
    [{ ok: true, action: 'left' }, 'removed'],
    [{ ok: true, action: 'removed', extra: true }, 'removed'],
    [{ ok: true }, 'removed'],
  ] as const)('rejects malformed or mismatched delete evidence %#', (value, action) => {
    expect(readChannelMemberDeleteAcknowledgement(value, action)).toBe(false)
  })

  it('accepts only an exact role acknowledgement', () => {
    expect(readChannelMemberRoleAcknowledgement({ ok: true })).toBe(true)
    expect(readChannelMemberRoleAcknowledgement({ ok: true, role: 'admin' })).toBe(false)
    expect(readChannelMemberRoleAcknowledgement({ success: true })).toBe(false)
    expect(readChannelMemberRoleAcknowledgement({ ok: false })).toBe(false)
  })

  it('binds every member mutation to one current viewer/channel operation', () => {
    const page = readFileSync(join(__dirname, '../page.tsx'), 'utf8')

    expect(page).toContain('memberMutationInFlightRef.current.has(requestKey)')
    expect(page).toContain('sessionGenerationRef.current === operation.sessionGeneration')
    expect(page).toContain("readChannelMemberDeleteAcknowledgement(data, 'removed')")
    expect(page).toContain("readChannelMemberDeleteAcknowledgement(data, 'left')")
    expect(page).toContain('!readChannelMemberRoleAcknowledgement(data)')
    expect(page).toMatch(
      /const requestKey = beginMemberMutation\(operation, targetId\)[\s\S]{0,300}confirm\(t\('confirmRemoveMember'\)\)/
    )
    expect(page).toMatch(/disabled=\{memberMutationPending\}/)
  })
})
