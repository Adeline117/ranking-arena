import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260803211500_trader_authorizations_server_only.sql'),
  'utf8'
)
const packageJson = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
const ci = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')

describe('trader authorizations server-only migration', () => {
  it('is transactional, bounded, and documents the schema-ahead cutover', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('pg_advisory_xact_lock')
    expect(migration).toContain('schema-ahead compatible')
    expect(migration).toContain('bind_trader_account_connection_v1')
    expect(migration).toContain('revoke_trader_account_connection_v1')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('fails closed on missing credential/trust fields or either atomic upsert key', () => {
    for (const securityColumn of [
      'encrypted_api_key',
      'encrypted_api_secret',
      'permissions',
      'last_verified_at',
      'read_only_verified_at',
      'last_sync_at',
      'last_sync_status',
      'consecutive_failures',
      'verification_error',
    ]) {
      expect(migration).toContain(`'${securityColumn}'`)
    }

    expect(migration).toContain('index_metadata.indisunique')
    expect(migration).toContain('index_metadata.indisvalid')
    expect(migration).toContain('index_metadata.indisready')
    expect(migration).toContain("ARRAY['user_id', 'platform', 'trader_id']::name[]")
    for (const connectionColumn of [
      'api_key_encrypted',
      'api_secret_encrypted',
      'passphrase_encrypted',
      'is_active',
      'verified_uid',
      'scope_permissions',
    ]) {
      expect(migration).toContain(`'${connectionColumn}'`)
    }
    expect(migration).toContain("ARRAY['user_id', 'exchange']::name[]")
    expect(migration).toContain(
      'must satisfy 20260716112000_exchange_connections_server_only before atomic account binding'
    )
    expect(migration).toContain("policy.polname = 'Service role manages exchange connections'")
    expect(migration.indexOf('DO $preflight$')).toBeLessThan(
      migration.indexOf('REVOKE ALL PRIVILEGES ON TABLE public.trader_authorizations')
    )
  })

  it('installs one service-only bind boundary and supersedes old canonical credentials', () => {
    const functionStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.bind_trader_account_connection_v1('
    )
    const functionEnd = migration.indexOf('$function$;', functionStart)
    const bindingFunction = migration.slice(functionStart, functionEnd)

    expect(functionStart).toBeGreaterThan(-1)
    expect(bindingFunction).toContain('RETURNS uuid')
    expect(bindingFunction).toContain('SECURITY DEFINER')
    expect(bindingFunction).toContain('SET search_path = pg_catalog, pg_temp')
    expect(bindingFunction).toContain(
      "WHEN v_platform IN ('binance', 'binance_futures', 'binance_spot')"
    )
    expect(bindingFunction).toContain("WHEN v_platform IN ('bybit', 'bybit_spot')")
    expect(bindingFunction).toContain("WHEN v_platform IN ('okx', 'okx_futures', 'okx_spot')")
    expect(bindingFunction).toContain(
      "WHEN v_platform IN ('bitget', 'bitget_futures', 'bitget_spot')"
    )
    const connectionLock = bindingFunction.indexOf(
      'FROM public.user_exchange_connections AS connection'
    )
    const authorizationLock = bindingFunction.indexOf(
      'FROM public.trader_authorizations AS auth_row'
    )
    const supersede = bindingFunction.indexOf('UPDATE public.trader_authorizations AS auth_row')
    const connectionUpsert = bindingFunction.indexOf('INSERT INTO public.user_exchange_connections')
    const authorizationUpsert = bindingFunction.indexOf('INSERT INTO public.trader_authorizations')
    expect(connectionLock).toBeGreaterThan(-1)
    expect(connectionLock).toBeLessThan(authorizationLock)
    expect(authorizationLock).toBeLessThan(supersede)
    expect(supersede).toBeLessThan(connectionUpsert)
    expect(connectionUpsert).toBeLessThan(authorizationUpsert)
    expect(bindingFunction).toContain('FOR UPDATE')
    expect(bindingFunction).toContain('ORDER BY connection.id')
    expect(bindingFunction).toContain('connection.exchange <> v_connection_exchange')
    expect(bindingFunction).toContain("SET status = 'revoked'")
    expect(bindingFunction).toContain('Superseded by a newer account binding for this exchange')
    expect(bindingFunction).toContain('AND NOT (')
    expect(bindingFunction.indexOf('INSERT INTO public.user_exchange_connections')).toBeLessThan(
      bindingFunction.indexOf('INSERT INTO public.trader_authorizations')
    )
    expect(bindingFunction).toContain('ON CONFLICT (user_id, exchange) DO UPDATE')
    expect(bindingFunction).toContain('ON CONFLICT (user_id, platform, trader_id) DO UPDATE')
    expect(bindingFunction).not.toMatch(/\nEXCEPTION\s/)

    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.bind_trader_account_connection_v1\([\s\S]*?\) FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.bind_trader_account_connection_v1\([\s\S]*?\) TO service_role/
    )
    expect(migration).toContain('atomic account-binding function security contract is incorrect')
    expect(migration).toContain('has_function_privilege')
  })

  it('installs a service-only atomic revoke boundary for both selectors and projections', () => {
    const functionStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.revoke_trader_account_connection_v1('
    )
    const functionEnd = migration.indexOf('$function$;', functionStart)
    const revokeFunction = migration.slice(functionStart, functionEnd)

    expect(functionStart).toBeGreaterThan(-1)
    expect(revokeFunction).toContain('RETURNS boolean')
    expect(revokeFunction).toContain('SECURITY DEFINER')
    expect(revokeFunction).toContain('SET search_path = pg_catalog, pg_temp')
    expect(revokeFunction).toContain('exactly one account revocation selector is required')
    expect(revokeFunction).toContain('auth_row.id = p_authorization_id')
    expect(revokeFunction).toContain('auth_row.user_id = p_user_id')
    expect(revokeFunction).toContain('RETURN false')
    expect(revokeFunction).toContain("v_platform IN ('mexc', 'htx', 'weex', 'coinex')")
    expect(revokeFunction).not.toMatch(/'gmx'|'gate'|'gateio'|'kucoin'/)

    const connectionLock = revokeFunction.indexOf(
      'FROM public.user_exchange_connections AS connection'
    )
    const authorizationLock = revokeFunction.indexOf(
      'FROM public.trader_authorizations AS auth_row',
      connectionLock
    )
    const connectionUpdate = revokeFunction.indexOf(
      'UPDATE public.user_exchange_connections AS connection'
    )
    const authorizationUpdate = revokeFunction.indexOf(
      'UPDATE public.trader_authorizations AS auth_row'
    )
    expect(connectionLock).toBeGreaterThan(-1)
    expect(connectionLock).toBeLessThan(authorizationLock)
    expect(authorizationLock).toBeLessThan(connectionUpdate)
    expect(connectionUpdate).toBeLessThan(authorizationUpdate)
    expect(revokeFunction).toContain('SET is_active = false')
    expect(revokeFunction).toContain('ORDER BY connection.id')
    expect(revokeFunction).toContain("SET status = 'revoked'")
    expect(revokeFunction).not.toMatch(/\nEXCEPTION\s/)

    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.revoke_trader_account_connection_v1\([\s\S]*?\) FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.revoke_trader_account_connection_v1\([\s\S]*?\) TO service_role/
    )
    expect(migration).toContain('atomic account-revocation function security contract is incorrect')
    expect(migration).toContain(
      'atomic account-revocation function execute privileges are incorrect'
    )
  })

  it('removes every table and column privilege from browser roles', () => {
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.trader_authorizations\s+FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toContain('DO $revoke_column_privileges$')
    expect(migration).toContain('DO $revoke_non_owner_table_acl$')
    expect(migration).toContain(
      "'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '"
    )
    expect(migration).toContain("|| 'FROM PUBLIC, anon, authenticated, service_role'")
    expect(migration).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*?TO\s+(?:PUBLIC|anon|authenticated)\s*;/
    )
  })

  it('dynamically replaces policy drift with one service-role policy', () => {
    expect(migration).toContain('DO $drop_trader_authorization_policies$')
    expect(migration).toContain("WHERE policy.polrelid = 'public.trader_authorizations'::regclass")
    expect(migration).toContain("'DROP POLICY %I ON public.trader_authorizations'")
    expect(migration.match(/CREATE POLICY /g)).toHaveLength(1)
    expect(migration).toMatch(
      /CREATE POLICY "Service role manages trader authorizations"[\s\S]*FOR ALL[\s\S]*TO service_role[\s\S]*USING \(true\)[\s\S]*WITH CHECK \(true\)/
    )
  })

  it('quarantines noncanonical, OAuth, unattested, and split credential projections', () => {
    const quarantineStart = migration.indexOf(
      'UPDATE public.user_exchange_connections AS connection'
    )
    expect(
      migration.indexOf('DROP TRIGGER IF EXISTS exchange_connection_v1_mutation_serializer')
    ).toBeLessThan(quarantineStart)
    expect(
      migration.indexOf(
        'DROP TRIGGER IF EXISTS exchange_connection_authorization_v1_contract_guard'
      )
    ).toBeLessThan(quarantineStart)
    expect(
      migration.indexOf('DROP TRIGGER IF EXISTS trader_authorization_v1_contract_guard')
    ).toBeLessThan(quarantineStart)
    expect(migration).toContain("connection.exchange NOT IN ('binance', 'bybit', 'okx', 'bitget')")
    expect(migration).toContain(
      "pg_catalog.lower(pg_catalog.btrim(connection.api_key_encrypted)) = 'oauth'"
    )
    expect(migration).toContain('connection.last_verified_at IS NULL')
    expect(migration).toContain("connection.exchange IN ('okx', 'bitget')")
    expect(migration).toContain('connection.passphrase_encrypted IS NULL')
    expect(migration).toContain('auth_row.encrypted_passphrase IS NULL')
    expect(migration).toContain('Quarantined: no unique attested canonical account connection')
    expect(migration).toContain(
      'active authorization survived without one exact canonical connection'
    )
    expect(migration).toContain('connection.api_key_encrypted = auth_row.encrypted_api_key')
    expect(migration).toContain('connection.api_secret_encrypted = auth_row.encrypted_api_secret')
    expect(migration).toContain('IS NOT DISTINCT FROM auth_row.encrypted_passphrase')
    expect(migration).toContain('IS NOT DISTINCT FROM auth_row.permissions')
    expect(migration).toContain('IS NOT DISTINCT FROM auth_row.read_only_verified_at')
    expect(migration).not.toContain("('bybit', 'bybit_futures', 'bybit_spot')")
  })

  it('enforces the exact account projection continuously without lock inversion', () => {
    const authGuardStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.guard_trader_authorization_v1_contract()'
    )
    const authGuardEnd = migration.indexOf('$function$;', authGuardStart)
    const authGuard = migration.slice(authGuardStart, authGuardEnd)
    const connectionGuardStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.guard_exchange_connection_authorization_v1_contract()'
    )
    const connectionGuardEnd = migration.indexOf('$function$;', connectionGuardStart)
    const connectionGuard = migration.slice(connectionGuardStart, connectionGuardEnd)

    expect(authGuard).toContain('pg_try_advisory_xact_lock')
    expect(authGuard).toContain("'trader-account:' || NEW.user_id::text")
    expect(authGuard).not.toContain('FOR KEY SHARE')
    expect(authGuard).toContain(
      'active trader authorization requires one exact active canonical account connection'
    )
    expect(authGuard).toContain('NEW.last_verified_at IS NOT DISTINCT FROM OLD.last_verified_at')
    expect(migration).toMatch(
      /CREATE TRIGGER exchange_connection_v1_mutation_serializer\s+BEFORE INSERT OR UPDATE OR DELETE ON public\.user_exchange_connections/
    )
    expect(migration).toContain('account connection identity is immutable')
    expect(connectionGuard).toContain(
      'account connection mutation would orphan an active trader authorization'
    )
    expect(migration).toMatch(
      /CREATE CONSTRAINT TRIGGER exchange_connection_authorization_v1_contract_guard[\s\S]*AFTER INSERT OR UPDATE OR DELETE[\s\S]*DEFERRABLE INITIALLY DEFERRED/
    )
    expect(migration).toContain('continuous account-authorization guard boundary is incorrect')
  })

  it('quarantines and permanently rejects retired bind-wallet markers', () => {
    expect(migration).toContain(
      "COALESCE(auth_row.permissions, '[]'::jsonb)::text ~* '\"wallet_owner\"'"
    )
    expect(migration).toContain("auth_row.encrypted_api_key LIKE 'wallet:%'")
    expect(migration).toContain("auth_row.encrypted_api_secret LIKE 'signature_verified:%'")
    expect(migration).toContain("SET status = 'revoked'")
    expect(migration).toContain('read_only_verified_at = NULL')
    expect(migration).toContain("last_sync_status = 'failed'")
    expect(migration).toContain('ADD CONSTRAINT trader_authorizations_no_legacy_wallet_marker')
    expect(migration).toContain('VALIDATE CONSTRAINT trader_authorizations_no_legacy_wallet_marker')
    expect(migration).toContain('legacy bind-wallet authorization marker boundary is incorrect')
  })

  it('grants only service CRUD and performs strict ACL and policy postflight', () => {
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON TABLE public\.trader_authorizations\s+TO service_role/
    )
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain('has_table_privilege')
    expect(migration).toContain('has_column_privilege')
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain('DO $converge_function_acl$')
    expect(migration).toContain('migration role must own both account authorization relations')
    expect(migration).toContain('OWNER TO CURRENT_USER')
    expect(migration).toContain('account authorization function ownership contract is incorrect')
    expect(migration).toContain('unexpected trader-authorization function overloads')
    expect(migration).toContain(
      'trader-authorization overload or direct function ACL inventory is not exact'
    )
    expect(migration).toContain('acl_entry.grantee = 0::oid')
    expect(migration).toContain('policy.polroles = ARRAY[v_service_role_oid]::oid[]')
    expect(migration).toContain(') <> 1 OR NOT EXISTS (')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('does not force RLS and break owner-executed security-definer claim code', () => {
    expect(migration).toContain(
      'ALTER TABLE public.trader_authorizations ENABLE ROW LEVEL SECURITY'
    )
    expect(migration).not.toContain(
      'ALTER TABLE public.trader_authorizations FORCE ROW LEVEL SECURITY'
    )
  })

  it('wires the isolated PostgreSQL 17 proof into the required QA path', () => {
    expect(packageJson).toContain('"qa:trader-authorization-acl-pg17"')
    expect(packageJson).toContain('trader-authorizations-server-only.pg17.sh')
    expect(ci).toContain('run: npm run qa:trader-authorization-acl-pg17')
    expect(ci).toContain('PG17_BIN: /usr/lib/postgresql/17/bin')
  })
})
