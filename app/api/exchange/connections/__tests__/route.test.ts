import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(process.cwd(), 'app/api/exchange/connections/route.ts'), 'utf8')

describe('GET /api/exchange/connections contract', () => {
  it('is authenticated, owner-scoped, and projects display-safe fields only', () => {
    const projectionStart = source.indexOf('.select(')
    const ownerFilter = source.indexOf(".eq('user_id', user.id)", projectionStart)
    expect(projectionStart).toBeGreaterThan(-1)
    expect(ownerFilter).toBeGreaterThan(projectionStart)

    const projection = source.slice(projectionStart, ownerFilter)
    for (const safeField of [
      'id',
      'user_id',
      'exchange',
      'is_active',
      'last_sync_at',
      'last_sync_status',
      'last_sync_error',
      'created_at',
      'updated_at',
    ]) {
      expect(projection).toContain(safeField)
    }
    for (const secretField of [
      'api_key',
      'api_secret',
      'access_token',
      'refresh_token',
      'credentials',
      'passphrase',
    ]) {
      expect(projection).not.toContain(secretField)
    }

    expect(source).toContain('export const GET = withAuth(')
    expect(source).not.toContain('withPublic(')
  })
})
