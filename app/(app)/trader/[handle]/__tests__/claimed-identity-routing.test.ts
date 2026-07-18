import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

describe('claimed trader routing contract', () => {
  const page = source('app/(app)/trader/[handle]/page.tsx')
  const client = source('app/(app)/trader/[handle]/TraderProfileClient.tsx')

  it('never resolves claim ownership from a source-blind URL handle', () => {
    expect(page).not.toContain('cachedFindUserHandleByTrader(decodedHandle)')
    expect(page).toContain(
      'cachedFindUserHandleByTrader(servingResolved.source, servingResolved.exchangeTraderId)'
    )
    expect(page).toContain('cachedFindUserHandleByTrader(resolved.platform, resolved.traderKey)')
  })

  it('does not issue an ISR server redirect that can discard an explicit platform variant', () => {
    expect(page).not.toMatch(/\bredirect\s*\(/)
    expect(client).toContain('claimedTraderCanonicalHref({')
    expect(client).toContain('requestedPlatformValidated: Boolean(override)')
  })

  it('uses the trader detail platform parameter after a claim and from a bot owner link', () => {
    const claimPage = source('app/(app)/claim/page.tsx')
    const botHeader = source('app/components/trader/serving/BotHeaderCard.tsx')

    expect(claimPage).toMatch(
      /\/trader\/\$\{encodeURIComponent\(selectedTrader\.source_trader_id\)\}\?platform=\$\{encodeURIComponent\(selectedTrader\.source\)\}/
    )
    expect(claimPage).not.toMatch(
      /\/trader\/\$\{encodeURIComponent\(selectedTrader\.(?:handle|source_trader_id)\)\}\?source=/
    )

    expect(botHeader).toMatch(/\?platform=\$\{encodeURIComponent\(bot\.ownerPlatform\)\}/)
    expect(botHeader).not.toMatch(/\?source=\$\{encodeURIComponent\(bot\.ownerPlatform\)\}/)
  })
})
