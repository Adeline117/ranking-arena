import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

describe('claim review UX contract', () => {
  it('never promises auto-approval after a claim enters manual review', () => {
    const liveClaimUi = [
      source('app/(app)/claim/components/CexVerifyForm.tsx'),
      source('app/(app)/claim/components/DexVerifyForm.tsx'),
      source('app/(app)/claim/page.tsx'),
    ].join('\n')

    expect(liveClaimUi).not.toContain('claimVerifiedAutoApproved')
    expect(liveClaimUi).not.toMatch(/auto[- ]approved/i)
    expect(liveClaimUi.match(/t\('claimSubmitted'\)/g)).toHaveLength(3)
  })

  it('removes the obsolete auto-approval promise from every shipped language', () => {
    for (const language of ['en', 'zh', 'ja', 'ko']) {
      expect(source(`lib/i18n/${language}.ts`)).not.toContain('claimVerifiedAutoApproved')
    }
  })
})
