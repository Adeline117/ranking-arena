import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EVM_WALLET_PLATFORMS, SOLANA_WALLET_PLATFORMS } from '@/lib/constants/wallet-platforms'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716113000_expirable_trader_claim_submissions.sql'),
  'utf8'
)

const submitFunction = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.submit_trader_claim'),
  migration.indexOf('CREATE OR REPLACE FUNCTION public.guard_trader_claim_activation_expiry')
)

const activationGuard = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.guard_trader_claim_activation_expiry'),
  migration.indexOf('DROP TRIGGER IF EXISTS trader_claim_activation_expiry_guard')
)

describe('expirable trader-claim submission migration', () => {
  it('is bounded and fails closed on missing or corrupt foundations', () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain("to_regclass('public.trader_claims')")
    expect(migration).toContain("'public.activate_trader_claim(uuid,uuid)'")
    expect(migration).toContain("pg_catalog.to_regrole('service_role')")
    expect(migration).toContain('unsupported trader_claims statuses must be reconciled first')
    expect(migration).toContain('duplicate active trader claims must be reconciled first')
    expect(migration).toContain('noncanonical active trader claims must be reconciled first')
    expect(migration).toContain('expected full or partial trader-claim identity key is missing')
  })

  it('adds an explicit terminal status and preserves stale attempts as history', () => {
    expect(migration).toMatch(
      /CHECK \([\s\S]*status IN \('pending', 'reviewing', 'verified', 'rejected', 'expired'\)[\s\S]*\) NOT VALID/
    )
    expect(migration).toContain('VALIDATE CONSTRAINT trader_claims_status_check')
    expect(migration).toMatch(
      /UPDATE public\.trader_claims AS claim[\s\S]*SET status = 'expired',[\s\S]*claim\.status IN \('pending', 'reviewing'\)[\s\S]*make_interval\(days => 30\)/
    )
    expect(migration).toContain('ALTER COLUMN created_at SET NOT NULL')
    expect(migration).not.toMatch(/DELETE FROM public\.trader_claims/)
  })

  it('replaces full-table uniqueness with the exact active lifecycle key', () => {
    const createIndex = migration.indexOf(
      'CREATE UNIQUE INDEX IF NOT EXISTS trader_claims_one_active_identity_uidx'
    )
    const dropConstraint = migration.indexOf(
      'DROP CONSTRAINT IF EXISTS trader_claims_trader_id_source_key'
    )

    expect(createIndex).toBeGreaterThan(-1)
    expect(dropConstraint).toBeGreaterThan(createIndex)
    expect(migration.slice(createIndex, dropConstraint)).toContain(
      "WHERE status IN ('pending', 'reviewing', 'verified')"
    )
    expect(migration.slice(createIndex, dropConstraint)).not.toContain('statement_timestamp')
    expect(migration).toContain('full-table trader-claim identity uniqueness still exists')
  })

  it('expires and inserts in one service-owned database transaction without reusing a row', () => {
    expect(submitFunction).toMatch(
      /RETURNS public\.trader_claims[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp/
    )
    expect(submitFunction).toContain('v_now timestamptz := pg_catalog.statement_timestamp()')
    expect(submitFunction).toContain(
      'v_source text := pg_catalog.lower(pg_catalog.btrim(p_source))'
    )

    const expiry = submitFunction.indexOf('UPDATE public.trader_claims AS claim')
    const insert = submitFunction.indexOf('INSERT INTO public.trader_claims')

    expect(expiry).toBeGreaterThan(-1)
    expect(insert).toBeGreaterThan(expiry)
    expect(submitFunction.slice(expiry, insert)).toContain("SET status = 'expired'")
    expect(submitFunction.slice(expiry, insert)).toContain(
      "claim.status IN ('pending', 'reviewing')"
    )
    expect(submitFunction.slice(insert)).toContain("'reviewing'")
    expect(submitFunction).not.toMatch(/SET\s+user_id\s*=/)
    expect(submitFunction).not.toMatch(/SET\s+verification_data\s*=/)
    expect(submitFunction).not.toContain('ON CONFLICT')
    expect(submitFunction).not.toContain('pg_advisory_xact_lock')
  })

  it('allows only API-key or signature proofs with bounded canonical identity input', () => {
    expect(submitFunction).toContain("p_verification_method NOT IN ('api_key', 'signature')")
    expect(submitFunction).toContain('pg_catalog.length(v_trader_id) > 512')
    expect(submitFunction).toContain('pg_catalog.length(v_source) > 100')
    expect(submitFunction).toContain("pg_catalog.jsonb_typeof(v_verification_data) <> 'object'")
    expect(submitFunction).toContain("v_source IN ('jupiter_perps', 'drift')")
    expect(submitFunction).toContain("v_source IN ('hyperliquid', 'gmx', 'gains', 'aevo', 'dydx')")
    expect(submitFunction).toContain('v_trader_id := pg_catalog.lower(v_trader_id)')
    expect(submitFunction).toContain('unsupported wallet trader claim source')
  })

  it('keeps the database wallet-source boundary aligned with the application', () => {
    const solanaList = /IF v_source IN \(([^)]+)\) THEN/.exec(submitFunction)?.[1]
    const evmList = /ELSIF v_source IN \(([^)]+)\) THEN/.exec(submitFunction)?.[1]
    const parseSqlList = (value: string | undefined) =>
      Array.from(value?.matchAll(/'([^']+)'/g) ?? [], (match) => match[1])

    expect(parseSqlList(solanaList)).toEqual([...SOLANA_WALLET_PLATFORMS])
    expect(parseSqlList(evmList)).toEqual([...EVM_WALLET_PLATFORMS])
  })

  it('fails stale or terminal approval closed at the final status boundary', () => {
    expect(activationGuard).toMatch(
      /RETURNS trigger[\s\S]*SECURITY INVOKER[\s\S]*SET search_path = pg_catalog, pg_temp/
    )
    expect(activationGuard).toContain("NEW.status = 'verified'")
    expect(activationGuard).toContain("OLD.status IN ('rejected', 'expired')")
    expect(activationGuard).toContain("OLD.status IN ('pending', 'reviewing')")
    expect(activationGuard).toContain('OLD.created_at')
    expect(activationGuard).toContain('pg_catalog.make_interval(days => 30)')
    expect(activationGuard).toContain("ERRCODE = 'P0002'")
    expect(migration).toMatch(
      /CREATE TRIGGER trader_claim_activation_expiry_guard[\s\S]*BEFORE UPDATE OF status ON public\.trader_claims[\s\S]*EXECUTE FUNCTION public\.guard_trader_claim_activation_expiry\(\)/
    )
  })

  it('exposes submission only to service_role and hides the trigger function', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.submit_trader_claim\([\s\S]*\) FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.submit_trader_claim\([\s\S]*\) TO service_role/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.guard_trader_claim_activation_expiry\(\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toContain('submit_trader_claim execute boundary is incorrect')
    expect(migration).toContain('claim-expiry trigger function is directly executable')
  })

  it('postflights the constraint, exact index, functions, and enabled trigger', () => {
    expect(migration).toContain('expanded trader-claim status check is missing')
    expect(migration).toContain(
      'active trader-claim identity index has the wrong columns or predicate'
    )
    expect(migration).toContain('submit_trader_claim security-definer boundary is incorrect')
    expect(migration).toContain('claim activation expiry guard is missing or disabled')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
