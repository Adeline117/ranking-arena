import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

const route = read('app/api/cron/aggregate-portfolio-snapshots/route.ts')
const vercel = read('vercel.json')
const syncRoute = read('app/api/portfolio/sync/route.ts')
const snapshotsRoute = read('app/api/portfolio/snapshots/route.ts')

describe('retired position-notional portfolio snapshot writer', () => {
  it('cannot publish position notional as account equity', () => {
    expect(route).not.toContain("from('user_positions')")
    expect(route).not.toContain("from('user_portfolio_snapshots')")
    expect(route).not.toContain('size) * (Number')
    expect(route).toContain('{ status: 410 }')
    expect(route).toContain('/api/portfolio/sync atomic exchange-equity publication')
  })

  it('is no longer scheduled', () => {
    expect(vercel).not.toContain('/api/cron/aggregate-portfolio-snapshots')
  })

  it('keeps atomic exchange equity as the documented snapshot authority', () => {
    expect(syncRoute).toContain("'publish_portfolio_sync_atomic'")
    expect(syncRoute).toContain('p_total_equity: result.equity')
    expect(snapshotsRoute).toContain('exchange-reported account equity')
    expect(snapshotsRoute).not.toContain('from `user_positions`')
  })
})
