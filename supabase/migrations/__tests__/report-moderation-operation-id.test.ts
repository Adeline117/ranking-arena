import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716160000_report_moderation_operation_id.sql'),
  'utf8'
)
const pg17Proof = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/report-moderation-operation-id.pg17.sh'),
  'utf8'
)

function extractWrapperSource(): string {
  const match = migration.match(
    /CREATE OR REPLACE FUNCTION public\.moderate_report_queue_atomic\(\n  p_actor_id uuid,\n  p_content_type text,\n  p_content_id uuid,\n  p_action text,\n  p_operation_id uuid\n\)[\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/
  )
  if (!match) throw new Error('operation-ID wrapper source not found')
  return match[1]
}

describe('report moderation operation-ID migration contract', () => {
  it('retires the four-argument boundary and exposes only the sealed five-argument RPC', () => {
    expect(migration).toContain('RENAME TO moderate_report_queue_atomic_v1_internal')
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.moderate_report_queue_atomic_v1_internal('
    )
    expect(migration).toContain(
      "'public.moderate_report_queue_atomic(uuid,text,uuid,text,uuid)'::pg_catalog.regprocedure"
    )
    expect(migration).toContain("'report-moderation-operation-id:v1:'")
    expect(migration).toContain(
      "pg_catalog.to_regprocedure(\n    'public.moderate_report_queue_atomic(uuid,text,uuid,text)'\n  ) IS NOT NULL"
    )
  })

  it('seals the exact wrapper source and keeps the target/auth/profile/content lock order', () => {
    const source = extractWrapperSource()
    const digest = createHash('md5').update(source).digest('hex')
    const operationLock = source.indexOf("'report-moderation-operation:'")
    const targetLock = source.indexOf("'report-moderation:'")
    const authLock = source.indexOf('FROM auth.users AS auth_user')
    const sanctionLock = source.indexOf("'report-moderation-sanction:'")
    const profileLock = source.indexOf('FROM public.user_profiles AS profile_row')
    const contentLock = source.indexOf(
      '-- Only after every required profile lock is held may content children be'
    )

    expect(digest).toBe('4796e70c1a1d65b6ce16ff9359f6fcf6')
    expect(migration).toContain(`pg_catalog.md5(v_source) <> '${digest}'`)
    expect(operationLock).toBeGreaterThan(-1)
    expect(targetLock).toBeGreaterThan(operationLock)
    expect(authLock).toBeGreaterThan(targetLock)
    expect(sanctionLock).toBeGreaterThan(authLock)
    expect(profileLock).toBeGreaterThan(sanctionLock)
    expect(contentLock).toBeGreaterThan(profileLock)
    expect(source).toContain('ORDER BY profile_row.id\n    FOR UPDATE')
  })

  it('persists first-time no-ops and requires exact audit evidence before ledger adoption', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.report_moderation_operations')
    expect(migration).toContain('initial_applied boolean NOT NULL')
    expect(migration).toContain('exact atomic moderation audit evidence is missing')
    expect(migration).toContain('legacy destructive evidence conflicts with active content')
    expect(migration).toContain("audit_row.details -> 'report_ids'")
    expect(migration).toContain('INSERT INTO public.report_moderation_operations')
  })

  it('executes real PG17 replay, collision, forgery, and opposing A/B barrier proofs', () => {
    expect(pg17Proof).toContain('same operation observed or consumed later pending work')
    expect(pg17Proof).toContain('operation/action collision was accepted')
    expect(pg17Proof).toContain('forged report rows without audit were accepted')
    expect(pg17Proof).toContain('opposing-a-to-b-gate')
    expect(pg17Proof).toContain('opposing-b-to-a-gate')
    expect(pg17Proof).toContain("wait_for_backend_state 'moderate_report_queue_atomic' 'Lock'")
  })
})
