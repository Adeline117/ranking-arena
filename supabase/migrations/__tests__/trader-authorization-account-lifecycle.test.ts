import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260729164500_trader_authorization_account_lifecycle.sql'),
  'utf8'
)
const worker = readFileSync(
  resolve(root, 'worker/src/ingest/processors/first-party-sync.ts'),
  'utf8'
)
const scheduler = readFileSync(resolve(root, 'worker/src/ingest/scheduler.ts'), 'utf8')
const publisher = readFileSync(resolve(root, 'lib/ingest/serving/publish.ts'), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/trader-authorization-account-lifecycle.pg17.sh'),
  'utf8'
)

function functionBody(name: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  const next = migration.indexOf('CREATE OR REPLACE FUNCTION public.', start + 1)
  const end = next >= 0 ? next : migration.indexOf('ALTER FUNCTION public.', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end)
}

describe('first-party authorization account lifecycle authority', () => {
  it('quiesces active authorizations for every inactive or absent profile', () => {
    const trigger = functionBody('quiesce_inactive_trader_authorizations')
    expect(trigger).toContain("SET status = 'suspended'")
    expect(trigger).toContain("authorization_row.status = 'active'")
    expect(migration).toContain('AFTER DELETE ON public.user_profiles')
    expect(migration).toMatch(
      /UPDATE public\.trader_authorizations[\s\S]*?NOT EXISTS \([\s\S]*?FROM public\.user_profiles/
    )
  })

  it('bumps a sealed generation for every credential or active-authority change', () => {
    const trigger = functionBody('bump_trader_authorization_generation')
    for (const field of [
      'encrypted_api_key',
      'encrypted_api_secret',
      'encrypted_passphrase',
      'permissions',
      'status',
      'read_only_verified_at',
      'expires_at',
    ]) {
      expect(trigger).toContain(`NEW.${field} IS DISTINCT FROM OLD.${field}`)
    }
    expect(trigger).toContain('NEW.authorization_generation := OLD.authorization_generation + 1')
    expect(trigger).toContain('NEW.authorization_generation := OLD.authorization_generation')
  })

  it('takes lifecycle, Auth, and profile locks before the authorization row', () => {
    for (const name of [
      'claim_first_party_authorization_sync_atomic',
      'lock_first_party_authorization_publication_atomic',
      'finish_first_party_authorization_sync_atomic',
    ]) {
      const body = functionBody(name)
      const lifecycle = body.indexOf('lock_trader_claim_principals_internal')
      const rowLock = body.indexOf('FOR UPDATE', lifecycle)
      expect(lifecycle).toBeGreaterThanOrEqual(0)
      expect(rowLock).toBeGreaterThan(lifecycle)
    }
  })

  it('returns credentials only from the active atomic worker claim', () => {
    const claim = functionBody('claim_first_party_authorization_sync_atomic')
    expect(claim).toContain("'status', 'claimed'")
    expect(claim).toContain("'generation', v_authorization.authorization_generation")
    expect(claim).toContain("'encrypted_api_key', v_authorization.encrypted_api_key")
    expect(claim).toContain('v_authorization.read_only_verified_at IS NULL')
  })

  it('atomically fences the financial snapshot and authorization outcome', () => {
    const finish = functionBody('finish_first_party_authorization_sync_atomic')
    const lock = finish.indexOf('FOR UPDATE')
    const snapshot = finish.indexOf('INSERT INTO arena.first_party_snapshots')
    const outcome = finish.indexOf('UPDATE public.trader_authorizations')
    expect(snapshot).toBeGreaterThan(lock)
    expect(outcome).toBeGreaterThan(snapshot)
    expect(finish).toContain('authorization_row.authorization_generation = p_generation')
    expect(finish).toContain('authorization_row.consecutive_failures = p_expected_failures')
  })

  it('cuts browser mutation access to encrypted worker credentials', () => {
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER[\s\S]*?ON TABLE public\.trader_authorizations[\s\S]*?FROM PUBLIC, anon, authenticated, authenticator/
    )
  })

  it('wires scheduler admission and every worker publication boundary', () => {
    expect(scheduler).toContain('JOIN public.user_profiles AS profile')
    expect(worker).toContain('claim_first_party_authorization_sync_atomic')
    expect(worker).toContain('finish_first_party_authorization_sync_atomic')
    expect(publisher).toContain('lock_first_party_authorization_publication_atomic')
  })

  it('proves both lifecycle race orders, generation rotation, and CAS on PostgreSQL 17', () => {
    for (const marker of [
      'ban-first claim released credentials',
      'claim-first lifecycle transition did not quiesce authorization',
      'stale generation crossed publication fence',
      'ban-first outcome published a financial snapshot',
      'successful outcome did not atomically publish snapshot and watermark',
      'browser caller can execute worker credential claim',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
