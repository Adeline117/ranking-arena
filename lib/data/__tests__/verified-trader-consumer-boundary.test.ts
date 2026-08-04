import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

describe('public verified-trader consumer boundary', () => {
  it('does not let legacy account authorization rows mint an embeddable V1 badge', () => {
    const route = source('app/api/badge/trader/[handle]/route.ts')

    expect(route).toContain('const verified = false')
    expect(route).not.toContain("'verified_data_authorizations'")
    expect(route).not.toContain("'trader_authorizations'")
  })

  it('derives a public claimed identity only from owner-reviewed verified traders', () => {
    const page = source('app/(app)/u/[handle]/page.tsx')

    expect(page).toContain(".from('verified_traders')")
    expect(page).not.toContain(".from('trader_authorizations')")
    expect(page).not.toContain(".from('user_exchange_connections')")
  })
})
