import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const pageSource = readFileSync(join(process.cwd(), 'app/(app)/groups/[id]/page.tsx'), 'utf8')

describe('group page membership acknowledgement contract', () => {
  it('redeems invites in one membership POST with the exact token', () => {
    expect(pageSource).not.toContain('/invite?verify=')
    expect(pageSource).toContain('void handleJoin(inviteToken)')
    expect(pageSource).toContain('JSON.stringify(buildJoinMembershipBody(inviteToken))')
  })

  it('parses a success acknowledgement before applying member state', () => {
    const parseIndex = pageSource.indexOf('const ack = parseMembershipAck(data)')
    const memberIndex = pageSource.indexOf('setIsMember(true)', parseIndex)
    expect(parseIndex).toBeGreaterThan(-1)
    expect(memberIndex).toBeGreaterThan(parseIndex)
  })

  it('returns from requested without changing member state or count', () => {
    const requestedBranch = pageSource.match(
      /if \(ack\.action === 'requested'\) \{[\s\S]*?\n\s*\}/
    )?.[0]
    expect(requestedBranch).toBeDefined()
    expect(requestedBranch).toContain("showToast(t('joinRequestSubmitted'), 'success')")
    expect(requestedBranch).toContain('return')
    expect(requestedBranch).not.toContain('setGroup')
    expect(requestedBranch).not.toContain('setIsMember')
    expect(requestedBranch).not.toContain("trackEvent('group_join'")
  })

  it('does not reconnect the unused useGroupData hook', () => {
    expect(pageSource).not.toContain("from './hooks/useGroupData'")
    expect(pageSource).not.toContain('useGroupData(')
  })

  it('defines the submitted acknowledgement in every shipped locale', () => {
    for (const locale of ['en', 'zh', 'ja', 'ko']) {
      const source = readFileSync(join(process.cwd(), `lib/i18n/${locale}.ts`), 'utf8')
      expect(source).toContain('joinRequestSubmitted:')
    }
  })
})
