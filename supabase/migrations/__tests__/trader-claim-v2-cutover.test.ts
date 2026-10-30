import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

const phaseA = read('supabase/migrations/20260803213000_trader_claim_v2_rpcs.sql')
const phaseB = read('supabase/migrations/20260803214000_trader_claim_v2_cutover.sql')
const claimData = read('lib/data/trader-claims.ts')
const claimRoute = read('app/api/traders/claim/route.ts')
const walletPlatforms = read('lib/constants/wallet-platforms.ts')
const packageJson = read('package.json')
const ci = read('.github/workflows/ci.yml')
const runbook = read('docs/RUNBOOK.md')

const submitV2 = phaseA.slice(
  phaseA.indexOf('CREATE OR REPLACE FUNCTION public.submit_trader_claim_v2'),
  phaseA.indexOf('CREATE OR REPLACE FUNCTION public.guard_trader_claim_activation_expiry')
)
const phaseAGuard = phaseA.slice(
  phaseA.indexOf('CREATE OR REPLACE FUNCTION public.guard_trader_claim_activation_expiry'),
  phaseA.indexOf('CREATE OR REPLACE FUNCTION public.reject_trader_claim_v2')
)

describe('two-phase trader-claim V2 cutover', () => {
  it('creates a typed pre-deploy capability without accepting arbitrary proof JSON', () => {
    expect(phaseA).toContain('Phase A (pre-deploy)')
    expect(submitV2).toMatch(
      /public\.submit_trader_claim_v2\(\s*p_user_id uuid,\s*p_trader_id text,\s*p_source text,\s*p_challenge_id text,\s*p_challenge_issued_at timestamptz,\s*p_verified_at timestamptz,\s*p_message_digest text,\s*p_signature_digest text\s*\)/
    )
    expect(submitV2).not.toContain('p_verification_data')
    expect(submitV2).not.toContain('p_verification_method')
    expect(submitV2).toContain("v_source NOT IN ('hyperliquid', 'gmx')")
    expect(submitV2).toContain("v_trader_id !~ '^0x[0-9a-f]{40}$'")
    expect(submitV2).toContain("v_challenge_id !~ '^[0-9a-f]{64}$'")
    expect(submitV2).toContain('extensions.digest(v_expected_message')
    expect(submitV2).toContain("'signature'")
    expect(submitV2).toMatch(/v_verification_data,\s*2,\s*'reviewing'/)
  })

  it('uses a real version column and a strictly postflighted durable replay key', () => {
    expect(phaseA).toMatch(
      /ADD COLUMN IF NOT EXISTS submission_version smallint NOT NULL DEFAULT 1/
    )
    expect(phaseA).toContain('CHECK (submission_version IN (1, 2)) NOT VALID')
    expect(phaseA).toContain('VALIDATE CONSTRAINT trader_claims_submission_version_check')
    expect(phaseA).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS trader_claims_v2_challenge_id_uidx[\s\S]*\(\(verification_data->>'challenge_id'\)\)[\s\S]*WHERE submission_version = 2/
    )
    expect(phaseA).toContain("attribute.atttypid = 'smallint'::regtype")
    expect(phaseA).toContain('pg_get_expr(index_row.indexprs, index_row.indrelid)')
    expect(phaseA).toContain("'(verification_data ->> ''challenge_id''::text)'")
    expect(phaseA).toContain("v_index_predicate IS DISTINCT FROM '(submission_version = 2)'")
    expect(phaseA).toContain('index_row.indnkeyatts = 2')
    expect(phaseA).toContain('index_row.indnatts = 2')
    expect(phaseA).toContain('index_row.indimmediate')
    expect(phaseA).toContain('NOT index_row.indnullsnotdistinct')
    expect(phaseA).toContain('index_row.indexprs IS NULL')
    expect(phaseA).toContain("ARRAY['trader_id', 'source']::text[]")
    expect(phaseA).toContain("v_active_index_access_method IS DISTINCT FROM 'btree'::name")
  })

  it('guards direct verified inserts, transitions, and idempotent legacy activation replay', () => {
    expect(phaseAGuard).toContain("IF TG_OP = 'INSERT' THEN")
    expect(phaseAGuard).toContain("IF NEW.status = 'verified' THEN")
    expect(phaseAGuard).not.toContain("NEW.status = 'verified'\n     AND OLD.status")
    expect(phaseAGuard).toContain('NEW.submission_version IS DISTINCT FROM 2')
    expect(phaseAGuard).toContain('CURRENT_USER IS DISTINCT FROM v_claim_owner')
    expect(phaseAGuard).toContain('V2 trader claims may be written only through canonical RPCs')
    expect(phaseAGuard).toContain("NEW.verification_method IS DISTINCT FROM 'signature'")
    expect(phaseAGuard).toContain('NEW.verification_data ?& ARRAY[')
    expect(phaseAGuard).toContain('NEW.verification_data - ARRAY[')
    expect(phaseAGuard).toContain('NOT COALESCE(')
    expect(phaseAGuard).toContain("TG_OP = 'DELETE' AND OLD.submission_version = 2")
    expect(phaseAGuard).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON public\.trader_claims/)
    expect(phaseA).toContain('trigger_row.tgtype = 31')
    expect(phaseA).toMatch(
      /REVOKE ALL ON FUNCTION public\.activate_trader_claim\(uuid, uuid\)\s+FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(phaseA).toMatch(
      /REVOKE ALL ON FUNCTION public\.arena_set_trader_claimed\([\s\S]*?\) FROM PUBLIC, anon, authenticated, service_role/
    )
  })

  it('cuts over under a fixed lifecycle lock order and quarantines the complete legacy review queue', () => {
    const lifecycleLock = phaseB.indexOf('LOCK TABLE public.trader_claims, public.verified_traders')
    const quarantine = phaseB.indexOf('UPDATE public.trader_claims AS claim')
    const revoke = phaseB.indexOf(
      'REVOKE ALL PRIVILEGES ON TABLE public.trader_claims, public.verified_traders'
    )

    expect(lifecycleLock).toBeGreaterThan(-1)
    expect(phaseB).toMatch(
      /LOCK TABLE public\.trader_claims, public\.verified_traders,\s*public\.user_linked_traders, public\.user_profiles,\s*public\.user_exchange_connections, public\.trader_authorizations,\s*arena\.traders\s*IN ACCESS EXCLUSIVE MODE/
    )
    expect(quarantine).toBeGreaterThan(lifecycleLock)
    expect(revoke).toBeGreaterThan(quarantine)
    expect(phaseB).toContain("claim.status IN ('pending', 'reviewing')")
    expect(phaseB).toContain('claim.submission_version IS DISTINCT FROM 2')
    expect(phaseB).not.toMatch(
      /UPDATE public\.trader_claims AS claim[\s\S]*WHERE claim\.status = 'verified'/
    )
    expect(phaseB).toContain('legacy reviewable trader claims survived the cutoff sweep')
  })

  it('removes legacy RPC and direct claim DML while retaining only scoped profile edits', () => {
    expect(phaseB).toMatch(
      /REVOKE ALL ON FUNCTION public\.submit_trader_claim\([\s\S]*?\) FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(phaseB).toContain('legacy submit_trader_claim remains executable')
    expect(phaseB).toContain('DO $revoke_column_privileges$')
    expect(phaseB).toMatch(
      /GRANT SELECT ON TABLE public\.trader_claims\s+TO authenticated, service_role/
    )
    expect(phaseB).not.toMatch(
      /GRANT\s+(?:INSERT|UPDATE|DELETE)(?:\s*\([^;]*?\))?\s+ON TABLE public\.trader_claims/
    )
    expect(phaseB).toMatch(
      /GRANT UPDATE \([\s\S]*display_name[\s\S]*can_receive_messages[\s\S]*\) ON TABLE public\.verified_traders TO service_role/
    )
    for (const protectedColumn of [
      'user_id',
      'trader_id',
      'source',
      'verification_method',
      'can_pin_posts',
      'can_reply_reviews',
    ]) {
      const updateGrant = phaseB.slice(
        phaseB.indexOf('GRANT UPDATE (\n  display_name'),
        phaseB.indexOf(') ON TABLE public.verified_traders TO service_role')
      )
      expect(updateGrant).not.toContain(protectedColumn)
    }
  })

  it('quarantines retired wallet projections and guards every authorization write', () => {
    expect(phaseB).toContain(
      'public.user_exchange_connections, public.trader_authorizations,\n  arena.traders\n  IN ACCESS EXCLUSIVE MODE'
    )
    expect(phaseB).toContain("auth_row.encrypted_api_key LIKE 'wallet:%'")
    expect(phaseB).toContain("auth_row.encrypted_api_secret LIKE 'signature_verified:%'")
    expect(phaseB).toContain("pg_catalog.lower(permission.value) = 'wallet_owner'")
    expect(phaseB).toContain(
      'active trader authorization requires current read-only credential attestation'
    )
    expect(phaseB).toMatch(
      /CREATE TRIGGER trader_authorization_v1_contract_guard\s+BEFORE INSERT OR UPDATE ON public\.trader_authorizations/
    )
    expect(phaseB).toContain('pg_try_advisory_xact_lock')
    expect(phaseB).toContain(
      'active trader authorization requires one exact active canonical account connection'
    )
    expect(phaseB).toMatch(
      /CREATE TRIGGER exchange_connection_v1_mutation_serializer\s+BEFORE INSERT OR UPDATE OR DELETE ON public\.user_exchange_connections/
    )
    expect(phaseB).toMatch(
      /CREATE CONSTRAINT TRIGGER exchange_connection_authorization_v1_contract_guard[\s\S]*DEFERRABLE INITIALLY DEFERRED/
    )
    expect(phaseB.match(/trigger_row\.tgtype = 23/g)).toHaveLength(1)
  })

  it('re-converges linked identity to read-only service tables and narrow mutation RPCs', () => {
    expect(phaseB).toContain('DO $drop_linked_trader_policy_drift$')
    expect(phaseB).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.user_linked_traders\s+FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(phaseB).toMatch(/GRANT SELECT ON TABLE public\.user_linked_traders TO authenticated/)
    expect(phaseB).toMatch(/GRANT SELECT ON TABLE public\.user_linked_traders TO service_role/)
    expect(phaseB).not.toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE\n  ON TABLE public.user_linked_traders'
    )
    expect(phaseB).toMatch(
      /CREATE POLICY "Authenticated users can view own linked traders"[\s\S]*FOR SELECT[\s\S]*TO authenticated[\s\S]*auth\.uid\(\)/
    )
    expect(phaseB).toMatch(
      /CREATE POLICY "Service role reads linked traders"[\s\S]*FOR SELECT[\s\S]*TO service_role/
    )

    const metadataStart = phaseB.indexOf(
      'CREATE OR REPLACE FUNCTION public.update_linked_trader_metadata_v1('
    )
    const metadataEnd = phaseB.indexOf('$function$;', metadataStart)
    const metadataRpc = phaseB.slice(metadataStart, metadataEnd)
    expect(metadataRpc).toMatch(
      /p_user_id uuid,\s*p_link_id uuid,\s*p_update_label boolean,\s*p_label text,\s*p_update_display_order boolean,\s*p_display_order integer/
    )
    expect(metadataRpc).toContain('SECURITY DEFINER')
    expect(metadataRpc).toContain('SET search_path = pg_catalog, pg_temp')
    expect(metadataRpc).toContain("'linked-trader:' || p_user_id::text")
    expect(metadataRpc).toContain('FOR UPDATE')
    expect(metadataRpc).toContain('at least one linked-trader metadata field must be selected')
    expect(metadataRpc).toContain('unselected linked-trader metadata parameters must be null')
    expect(metadataRpc).toContain('pg_catalog.char_length(pg_catalog.btrim(p_label)) > 50')
    expect(metadataRpc).toContain('p_display_order > 10000')
    expect(phaseB).toContain('linked-trader metadata RPC boundary is incorrect')

    for (const identityColumn of [
      'is_verified_trader',
      'verified_trader_id',
      'verified_trader_source',
      'linked_trader_count',
    ]) {
      expect(phaseB).toContain(`'${identityColumn}'`)
    }
    expect(phaseB).toContain('browser role retains profile trader-identity UPDATE')
    expect(phaseB).toContain('linked-trader table or column ACL boundary drifted')
    expect(phaseB).toContain('CREATE TRIGGER user_profile_trader_identity_v1_guard')
    expect(phaseB).toContain('trader identity profile fields are RPC-owned')
    expect(phaseB).toContain('profile or Arena claimed identity DML guard is incorrect')
  })

  it('replaces unlink with one service-only revocation of every proven authority projection', () => {
    const functionStart = phaseB.indexOf(
      'CREATE OR REPLACE FUNCTION public.unlink_linked_trader_v2('
    )
    const functionEnd = phaseB.indexOf('$function$;', functionStart)
    const unlinkFunction = phaseB.slice(functionStart, functionEnd)

    expect(functionStart).toBeGreaterThan(-1)
    expect(unlinkFunction).toContain('RETURNS TABLE (')
    expect(unlinkFunction).toContain('SECURITY DEFINER')
    expect(unlinkFunction).toContain('SET search_path = pg_catalog, pg_temp')
    expect(unlinkFunction).toContain("'linked-trader:' || p_user_id::text")
    expect(unlinkFunction).toContain(
      "'trader-claim:' || v_target_source || ':' || v_target_trader_id"
    )
    const claimLock = unlinkFunction.indexOf('FROM public.trader_claims AS claim')
    const linkedAdvisory = unlinkFunction.indexOf("'linked-trader:' || p_user_id::text")
    expect(claimLock).toBeGreaterThan(-1)
    expect(claimLock).toBeLessThan(linkedAdvisory)
    expect(unlinkFunction).toContain("claim.status IN ('pending', 'reviewing', 'verified')")
    expect(unlinkFunction).toContain('linked trader identity changed during revocation')
    expect(unlinkFunction).toContain('linked trader projection drift requires manual audit')

    const profileLock = unlinkFunction.indexOf('FROM public.user_profiles AS profile')

    const connectionLock = unlinkFunction.indexOf(
      'FROM public.user_exchange_connections AS connection'
    )
    const authorizationLock = unlinkFunction.indexOf(
      'FROM public.trader_authorizations AS auth_row'
    )
    const connectionUpdate = unlinkFunction.indexOf(
      'UPDATE public.user_exchange_connections AS connection'
    )
    const authorizationUpdate = unlinkFunction.indexOf(
      'UPDATE public.trader_authorizations AS auth_row'
    )
    expect(connectionLock).toBeGreaterThan(-1)
    expect(profileLock).toBeGreaterThan(-1)
    expect(profileLock).toBeLessThan(connectionLock)
    expect(connectionLock).toBeLessThan(authorizationLock)
    expect(authorizationLock).toBeLessThan(connectionUpdate)
    expect(connectionUpdate).toBeLessThan(authorizationUpdate)
    expect(unlinkFunction).toContain('connection.verified_uid = v_existing.trader_id')
    expect(unlinkFunction).toContain('ORDER BY connection.id')
    expect(unlinkFunction).toContain("WHEN 'bitget_spot' THEN 'bitget'")
    expect(unlinkFunction).toContain('ELSE NULL')

    expect(unlinkFunction).toContain("SET status = 'rejected'")
    expect(unlinkFunction).toContain("reject_reason = 'Unlinked by claimant'")
    expect(unlinkFunction).toContain("AND claim.status IN ('pending', 'reviewing', 'verified')")
    expect(unlinkFunction).toContain('DELETE FROM public.verified_traders AS verified')
    expect(unlinkFunction).toContain('DELETE FROM public.user_linked_traders AS linked')
    expect(unlinkFunction).toContain('SET is_verified_trader = false')
    expect(unlinkFunction).toContain('verified_trader_id = NULL')
    expect(unlinkFunction).toContain('linked_trader_count = 0')
    expect(unlinkFunction).toContain('SET is_primary = true')
    expect(unlinkFunction).toContain('v_existing.source,')
    expect(unlinkFunction).toContain('false\n  );')
    expect(unlinkFunction).not.toMatch(/\nEXCEPTION\s/)

    expect(phaseB).toMatch(
      /REVOKE ALL ON FUNCTION public\.unlink_linked_trader\(uuid, uuid\)\s+FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(phaseB).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.unlink_linked_trader_v2\(uuid, uuid\)\s+TO service_role/
    )
    expect(phaseB).toContain('atomic linked-trader revocation boundary is incorrect')
  })

  it('hardens Arena claimed state with an exact owner lock and no revocation upsert', () => {
    const functionStart = phaseB.indexOf(
      'CREATE OR REPLACE FUNCTION public.arena_set_trader_claimed('
    )
    const functionEnd = phaseB.indexOf('$function$;', functionStart)
    const arenaFunction = phaseB.slice(functionStart, functionEnd)
    const falseBranch = arenaFunction.slice(arenaFunction.indexOf('IF p_claimed THEN'))

    expect(functionStart).toBeGreaterThan(-1)
    expect(arenaFunction).toContain('SET search_path = pg_catalog, pg_temp')
    expect(arenaFunction).toContain('FOR UPDATE')
    expect(arenaFunction).toContain("v_meta->>'claimed_by_user_id'")
    expect(arenaFunction).toContain('Arena trader claim projection is not owned by this user')
    expect(falseBranch.indexOf('SELECT trader.id, trader.meta')).toBeLessThan(
      falseBranch.indexOf("pg_catalog.jsonb_build_object('claimed', false)")
    )
    expect(falseBranch.slice(falseBranch.indexOf('END IF;') + 7)).not.toContain(
      'INSERT INTO arena.traders'
    )
    expect(phaseB).toContain('Arena claimed-owner projection boundary is incorrect')
    expect(phaseB).toMatch(
      /REVOKE ALL ON FUNCTION public\.arena_set_trader_claimed\([\s\S]*?\) FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(phaseB).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.arena_set_trader_claimed\([\s\S]*?\) TO service_role/
    )
    expect(phaseB).toContain('CREATE TRIGGER arena_trader_claimed_meta_v1_guard')
    expect(phaseB).toContain('Arena claimed-owner metadata is RPC-owned')
  })

  it('keeps primary selection atomic across linked, verified, and profile projections', () => {
    const functionStart = phaseB.indexOf(
      'CREATE OR REPLACE FUNCTION public.set_primary_linked_trader_v2('
    )
    const functionEnd = phaseB.indexOf('$function$;', functionStart)
    const setPrimaryFunction = phaseB.slice(functionStart, functionEnd)

    expect(functionStart).toBeGreaterThan(-1)
    expect(setPrimaryFunction).toContain("'linked-trader:' || p_user_id::text")
    expect(setPrimaryFunction).toContain('ORDER BY linked.id')
    expect(setPrimaryFunction).toContain('ORDER BY verified.id')
    expect(setPrimaryFunction).toContain('linked trader projection drift requires manual audit')
    expect(setPrimaryFunction).toContain('UPDATE public.user_linked_traders AS linked')
    expect(setPrimaryFunction).toContain('UPDATE public.verified_traders AS verified')
    expect(setPrimaryFunction).toContain('UPDATE public.user_profiles AS profile')
    expect(setPrimaryFunction.indexOf('FROM public.user_profiles AS profile')).toBeLessThan(
      setPrimaryFunction.indexOf('UPDATE public.user_linked_traders AS linked')
    )
    expect(phaseB).toContain('atomic primary linked-trader boundary is incorrect')
  })

  it('versions every Phase-B identity mutation and retires legacy service capabilities', () => {
    const activationStart = phaseB.indexOf(
      'CREATE OR REPLACE FUNCTION public.activate_trader_claim_v2('
    )
    const activationEnd = phaseB.indexOf('$function$;', activationStart)
    const activation = phaseB.slice(activationStart, activationEnd)

    expect(activationStart).toBeGreaterThan(-1)
    expect(activation).toContain('SECURITY DEFINER')
    expect(activation).toContain('SET search_path = pg_catalog, pg_temp')
    expect(activation).toContain('v_claim.submission_version IS DISTINCT FROM 2')
    expect(activation).toContain("v_claim.verification_method IS DISTINCT FROM 'signature'")
    expect(activation).toContain("v_claim.source NOT IN ('hyperliquid', 'gmx')")
    expect(activation).toContain("v_claim.trader_id !~ '^0x[0-9a-f]{40}$'")
    expect(activation).toContain('extensions.digest(v_expected_message')
    expect(activation).toContain('INSERT INTO public.verified_traders')
    expect(activation).toContain('INSERT INTO public.user_linked_traders')
    expect(activation).toContain('UPDATE public.user_profiles AS profile')
    expect(activation).toContain('public.arena_set_trader_claimed(')
    expect(activation).toContain("'authorization_id', NULL")
    expect(activation).not.toContain('RETURN public.activate_trader_claim(')

    for (const legacyRpc of [
      'activate_trader_claim',
      'set_primary_linked_trader',
      'unlink_linked_trader',
    ]) {
      expect(phaseB).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${legacyRpc}\\(uuid, uuid\\)\\s+FROM PUBLIC, anon, authenticated, service_role`
        )
      )
      expect(phaseB).toContain(
        `'service_role',\n       'public.${legacyRpc}(uuid,uuid)',\n       'EXECUTE'`
      )
    }

    for (const v2Rpc of [
      'activate_trader_claim_v2',
      'set_primary_linked_trader_v2',
      'unlink_linked_trader_v2',
    ]) {
      expect(phaseB).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${v2Rpc}\\(uuid, uuid\\)\\s+TO service_role`)
      )
    }
    expect(phaseB).toContain('V2 claim activation boundary is incorrect')
  })

  it('keeps the app source matrix and write path on signature-only V2', () => {
    expect(walletPlatforms).toMatch(/EVM_WALLET_PLATFORMS = \['hyperliquid', 'gmx'\] as const/)
    expect(claimData).toContain("supabase.rpc('submit_trader_claim_v2'")
    expect(claimData).toContain("supabase.rpc('reject_trader_claim_v2'")
    expect(claimData).toContain("supabase.rpc('cancel_trader_claim_v2'")
    expect(claimData).toContain("supabase.rpc('activate_trader_claim_v2'")
    expect(claimData).not.toContain("supabase.rpc('submit_trader_claim',")
    expect(claimRoute).toContain("validateEnum(body.verification_method, ['signature'] as const)")
    expect(claimRoute).not.toContain('hasVerifiedClaimConnection')
    expect(claimRoute).not.toContain("verification_method === 'api_key'")
  })

  it('wires the isolated PG17 proof and documents that phase B is the security gate', () => {
    expect(packageJson).toContain('"qa:trader-claim-v2-pg17"')
    expect(packageJson).toContain('trader-claim-v2-cutover.pg17.sh')
    expect(ci).toContain('run: npm run qa:trader-claim-v2-pg17')
    expect(runbook).toContain('Trader claim V2 two-phase cutover')
    expect(runbook).toContain('Phase B')
    expect(runbook).toMatch(/Phase B is the only design stage that closes legacy claim writers/)
    expect(runbook).toContain('not a valid claim-path rollback target')
  })
})
