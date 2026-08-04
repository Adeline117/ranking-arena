import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('V1 legacy portfolio surface', () => {
  const pageSource = readFileSync(join(process.cwd(), 'app/(app)/portfolio/page.tsx'), 'utf8')
  const menuSource = readFileSync(
    join(process.cwd(), 'app/components/layout/UserMenuDropdown.tsx'),
    'utf8'
  )
  const routeSource = readFileSync(join(process.cwd(), 'app/api/portfolio/route.ts'), 'utf8')
  const syncSource = readFileSync(join(process.cwd(), 'app/api/portfolio/sync/route.ts'), 'utf8')

  it('keeps the direct page as removal-only legacy cleanup', () => {
    expect(pageSource).toContain("fetch('/api/portfolio'")
    expect(pageSource).toContain("method: 'DELETE'")
    expect(pageSource).toContain("t('portfolioLegacyDescription')")
    expect(pageSource).not.toContain('AddExchangeModal')
    expect(pageSource).not.toContain('/api/portfolio/sync')
    expect(pageSource).not.toContain("method: 'POST'")
  })

  it('removes the legacy credential plane from V1 navigation', () => {
    expect(menuSource).not.toContain('href="/portfolio"')
  })

  it('retires connection creation and sync before credential access', () => {
    expect(routeSource).toContain("return retiredPortfolioWrite('connect')")
    expect(routeSource).toContain(".rpc('delete_legacy_portfolio_v1'")
    expect(routeSource).not.toContain('encryptApiKey')
    expect(routeSource).not.toContain('.insert({')
    expect(routeSource).not.toContain(".from('user_portfolios')\n      .delete()")
    expect(syncSource).toContain("return retiredPortfolioWrite('sync')")
    expect(syncSource).not.toContain('syncExchangePortfolio')
    expect(syncSource).not.toContain('api_key_encrypted')
    expect(syncSource).not.toContain('getSupabaseAdmin')
  })
})
