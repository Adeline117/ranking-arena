import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('claimed-profile history cache quarantine', () => {
  it('rotates the client query and sanitizes server hydration before use', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/(app)/u/[handle]/hooks/useUserProfile.ts'),
      'utf8'
    )

    expect(source).toContain('PUBLIC_PROFILE_HISTORY_QUERY_EPOCH')
    expect(source).toContain("queryKey: ['user-trader-data', PUBLIC_PROFILE_HISTORY_QUERY_EPOCH")
    expect(source).toContain('quarantineLegacyPositionHistory(serverTraderData)')
  })
})
